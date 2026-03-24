import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { SqlService } from '../sql/sql.service.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import { RepoAnalyzerService } from '../agents/repo-analyzer/repo-analyzer.service.js';
import { PhpParserService } from '../agents/php-parser/php-parser.service.js';
import { BlockParserService } from '../agents/block-parser/block-parser.service.js';
import { DbContentService } from '../agents/db-content/db-content.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { DeployAgentService } from '../agents/deploy-agent/deploy-agent.service.js';
import { RunPipelineDto } from './orchestrator.controller.js';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped';

export interface PipelineStep {
  name: string;
  status: PipelineStepStatus;
  error?: string;
}

export interface PipelineStatus {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: PipelineStep[];
  result?: any;
  error?: string;
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly jobs = new Map<string, PipelineStatus>();

  constructor(
    private readonly sqlService: SqlService,
    private readonly themeDetector: ThemeDetectorService,
    private readonly repoAnalyzer: RepoAnalyzerService,
    private readonly phpParser: PhpParserService,
    private readonly blockParser: BlockParserService,
    private readonly dbContent: DbContentService,
    private readonly reactGenerator: ReactGeneratorService,
    private readonly apiBuilder: ApiBuilderService,
    private readonly previewBuilder: PreviewBuilderService,
    private readonly deployAgent: DeployAgentService,
  ) {}

  async run(dto: RunPipelineDto): Promise<{ jobId: string }> {
    this.validateDto(dto);

    const jobId = uuidv4();
    const state: PipelineStatus = {
      jobId,
      status: 'running',
      steps: [
        { name: '1_repo_analyzer', status: 'pending' },
        { name: '2_theme_parser', status: 'pending' },
        { name: '3_db_content', status: 'pending' },
        { name: '4_react_generator', status: 'pending' },
        { name: '5_api_builder', status: 'pending' },
        { name: '6_preview_builder', status: 'pending' },
        { name: '7_deploy', status: 'pending' },
      ],
    };
    this.jobs.set(jobId, state);

    this.executePipeline(jobId, dto, state).catch((err) => {
      state.status = 'error';
      state.error = err.message;
      this.logger.error(`Pipeline ${jobId} failed:`, err);
    });

    return { jobId };
  }

  getStatus(jobId: string): PipelineStatus {
    return (
      this.jobs.get(jobId) ?? {
        jobId,
        status: 'error',
        steps: [],
        error: 'Job not found',
      }
    );
  }

  private async executePipeline(
    jobId: string,
    dto: RunPipelineDto,
    state: PipelineStatus,
  ): Promise<void> {
    // ── Resolve theme directory ───────────────────────────────────────────
    let themeDir = dto.themeDir;

    if (!themeDir && dto.themeGithubUrl) {
      themeDir = await this.cloneThemeRepo(
        dto.themeGithubUrl,
        dto.themeGithubToken,
        dto.themeGithubBranch ?? 'main',
        jobId,
      );
    }

    if (!themeDir) throw new BadRequestException('No theme source provided');

    // ── Resolve DB credentials ────────────────────────────────────────────
    let dbCreds: WpDbCredentials;

    if (dto.dbCredentials) {
      // Mode B: direct credentials
      await this.sqlService.verifyDirectCredentials(dto.dbCredentials);
      dbCreds = dto.dbCredentials;
    } else if (dto.sqlFilePath) {
      // Mode A: import SQL → shared DB
      dbCreds = await this.sqlService.importToTempDb(dto.sqlFilePath, jobId);
    } else {
      throw new BadRequestException(
        'No DB source provided (sqlFilePath or dbCredentials)',
      );
    }

    // ── Pipeline steps ────────────────────────────────────────────────────

    // Bước 1: Analyze repo structure
    await this.runStep(state, '1_repo_analyzer', () =>
      this.repoAnalyzer.analyze(themeDir!),
    );

    // Bước 2: Parse theme (classic PHP vs FSE block)
    const parsedTheme = await this.runStep(
      state,
      '2_theme_parser',
      async () => {
        const detection = await this.themeDetector.detect(themeDir!);
        return detection.type === 'fse'
          ? this.blockParser.parse(themeDir!)
          : this.phpParser.parse(themeDir!);
      },
    );

    // Bước 3: Extract content từ shared WP DB
    const content = await this.runStep(state, '3_db_content', () =>
      this.dbContent.extract(dbCreds),
    );

    // Bước 4: Generate React components + Tailwind
    const components = await this.runStep(state, '4_react_generator', () =>
      this.reactGenerator.generate({ theme: parsedTheme, content, jobId }),
    );

    // Bước 5: Generate Express API server
    await this.runStep(state, '5_api_builder', () =>
      this.apiBuilder.build({ jobId }),
    );

    // Clone repo B trước bước 6 để build preview thẳng vào đó (Option 2)
    let repoBCloneDir: string | undefined;
    if (dto.githubRepoB) {
      repoBCloneDir = await this.deployAgent.cloneRepoB({
        jobId,
        repoUrl: dto.githubRepoB,
        accessToken: dto.githubTokenB,
      });
    }

    // Bước 6: Scaffold Vite + React Router preview
    // Nếu có repo B → build thẳng vào clone dir, không tạo temp/generated
    const previewOutputDir = repoBCloneDir
      ? join(repoBCloneDir, 'src', 'generated', 'preview')
      : undefined;

    const preview = await this.runStep(state, '6_preview_builder', () =>
      this.previewBuilder.build({
        jobId,
        components,
        dbCreds,
        themeDir,
        tokens:
          'tokens' in parsedTheme ? (parsedTheme as any).tokens : undefined,
        outputDir: previewOutputDir,
      }),
    );

    // Bước 7: Commit + push + start dev server
    const deployResult = await this.runStep(state, '7_deploy', async () => {
      if (!repoBCloneDir) {
        state.steps.find((s) => s.name === '7_deploy')!.status = 'skipped';
        return null;
      }
      return this.deployAgent.commitAndPush({
        jobId,
        repoUrl: dto.githubRepoB!,
        cloneDir: repoBCloneDir,
        previewDir: preview.previewDir,
      });
    });

    state.status = 'done';
    state.result = {
      previewDir: preview.previewDir,
      dbCreds,
      ...(deployResult && {
        commitSha: deployResult.commitSha,
        devUrl: deployResult.devUrl,
        repoUrl: deployResult.repoUrl,
      }),
    };
    this.logger.log(`Pipeline ${jobId} completed`);
  }

  private async cloneThemeRepo(
    repoUrl: string,
    token: string | undefined,
    branch: string,
    jobId: string,
  ): Promise<string> {
    const destDir = join('./temp/repos', jobId);
    await mkdir(destDir, { recursive: true });

    const cloneUrl = token
      ? repoUrl.replace('https://', `https://${token}@`)
      : repoUrl;

    this.logger.log(`Cloning theme repo: ${repoUrl} → ${destDir}`);
    await simpleGit().clone(cloneUrl, destDir, [
      '--depth',
      '1',
      '--branch',
      branch,
    ]);
    return destDir;
  }

  private async runStep<T>(
    state: PipelineStatus,
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const step = state.steps.find((s) => s.name === name)!;
    if (step.status === 'skipped') return undefined as T;

    step.status = 'running';
    this.logger.log(`[${state.jobId}] Step ${name} started`);
    try {
      const result = await fn();
      step.status = 'done';
      this.logger.log(`[${state.jobId}] Step ${name} done`);
      return result;
    } catch (err: any) {
      step.status = 'error';
      step.error = err.message;
      state.status = 'error';
      throw err;
    }
  }

  private validateDto(dto: RunPipelineDto): void {
    const hasTheme = dto.themeGithubUrl || dto.themeDir;
    const hasDb = dto.sqlFilePath || dto.dbCredentials;
    if (!hasTheme)
      throw new BadRequestException('Provide themeGithubUrl or themeDir');
    if (!hasDb)
      throw new BadRequestException('Provide sqlFilePath or dbCredentials');
  }
}
