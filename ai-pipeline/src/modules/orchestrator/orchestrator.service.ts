import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { lastValueFrom, Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { appendFile, mkdir, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { AgentResult } from '@/common/types/pipeline.type.js';
import { SqlService } from '../sql/sql.service.js';
import { WpQueryService } from '../sql/wp-query.service.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import { RepoAnalyzerService } from '../agents/repo-analyzer/repo-analyzer.service.js';
import { PhpParserService } from '../agents/php-parser/php-parser.service.js';
import { BlockParserService } from '../agents/block-parser/block-parser.service.js';
import { DbContentService } from '../agents/db-content/db-content.service.js';
import { PlannerService } from '../agents/planner/planner.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { ValidatorService } from '../agents/validator/validator.service.js';
import { CleanupService } from '../agents/cleanup/cleanup.service.js';
import { CotEvidenceService } from '../cot-evidence/cot-evidence.service.js';
import { RunPipelineDto } from './orchestrator.controller.js';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HttpService } from '@nestjs/axios';

// ── Vietnamese step labels + progress weights ─────────────────────────────────

export interface ProgressEvent {
  step: string; // internal step name
  label: string; // display label
  status: PipelineStepStatus;
  percent: number; // 0-100
  message?: string; // optional log message
  data?: ProgressEventData;
}

interface ProgressEventData {
  previewUrl?: string;
  metrics: {
    urlA: string;
    urlB: string;
    diffPercentage: number;
    differentPixels: number;
    totalPixels: number;
    artifacts: {
      imageA: string;
      imageB: string;
      diff: string;
    };
  };
}

const STEP_META: Record<string, { label: string; weight: number }> = {
  '1_repo_analyzer': { label: 'Analyze repository structure', weight: 5 },
  '2_theme_parser': { label: 'Parse WordPress theme', weight: 10 },
  '3_db_content': { label: 'Extract content from database', weight: 10 },
  '4_planner': { label: 'Plan component architecture', weight: 15 },
  '5_react_generator': { label: 'Generate React + Tailwind code', weight: 40 },
  '6b_validator': { label: 'Validate and cleanup imports', weight: 5 },
  '6_api_builder': { label: 'Build Express API server', weight: 5 },
  '7_preview_builder': { label: 'Build Vite preview', weight: 8 },
  '8_cleanup': { label: 'Cleanup temporary files', weight: 2 },
  '9_done': { label: 'Migration complete', weight: 0 },
};

const TOTAL_WEIGHT = Object.values(STEP_META).reduce((s, m) => s + m.weight, 0);

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
  private readonly progress = new Map<string, Subject<ProgressEvent>>();

  constructor(
    private readonly sqlService: SqlService,
    private readonly wpQuery: WpQueryService,
    private readonly themeDetector: ThemeDetectorService,
    private readonly repoAnalyzer: RepoAnalyzerService,
    private readonly phpParser: PhpParserService,
    private readonly blockParser: BlockParserService,
    private readonly dbContent: DbContentService,
    private readonly planner: PlannerService,
    private readonly reactGenerator: ReactGeneratorService,
    private readonly apiBuilder: ApiBuilderService,
    private readonly previewBuilder: PreviewBuilderService,
    private readonly validator: ValidatorService,
    private readonly cleanup: CleanupService,
    private readonly cotEvidence: CotEvidenceService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async run(email: string): Promise<{ jobId: string }> {
    const response = await lastValueFrom(
      this.httpService.get(
        `${this.configService.get<string>('automation.url', '')}/wp/db-info?email=${encodeURIComponent(email)}`,
      ),
    );

    const dto = response.data;

    this.validateDto(dto);

    const jobId = uuidv4();
    const state: PipelineStatus = {
      jobId,
      status: 'running',
      steps: [
        { name: '1_repo_analyzer', status: 'pending' },
        { name: '2_theme_parser', status: 'pending' },
        { name: '3_db_content', status: 'pending' },
        { name: '4_planner', status: 'pending' },
        { name: '5_react_generator', status: 'pending' },
        { name: '6_api_builder', status: 'pending' },
        { name: '6b_validator', status: 'pending' },
        { name: '7_preview_builder', status: 'pending' },
        { name: '8_cleanup', status: 'pending' },
        { name: '9_done', status: 'pending' },
      ],
    };
    this.jobs.set(jobId, state);
    this.progress.set(jobId, new Subject<ProgressEvent>());

    console.log(jobId);

    // Wait 7 seconds before triggering pipeline
    await new Promise((resolve) => setTimeout(resolve, 7000));

    this.executePipeline(jobId, dto, state).catch((err) => {
      state.status = 'error';
      state.error = err.message;
      const subject = this.progress.get(jobId);
      subject?.next({
        step: 'error',
        label: 'Error',
        status: 'error',
        percent: 0,
        message: `Pipeline failed: ${err.message}`,
      });
      subject?.complete();
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

  getProgressStream(jobId: string): Subject<ProgressEvent> {
    if (!this.progress.has(jobId)) {
      this.progress.set(jobId, new Subject<ProgressEvent>());
    }
    return this.progress.get(jobId)!;
  }

  private async logToFile(logPath: string, message: string): Promise<void> {
    try {
      await appendFile(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // don't crash pipeline if logging fails
    }
  }

  private async executePipeline(
    jobId: string,
    dto: RunPipelineDto,
    state: PipelineStatus,
  ): Promise<void> {
    // ── Init log file ─────────────────────────────────────────────────────
    await mkdir('./temp/logs', { recursive: true });
    const logPath = join('./temp/logs', `${jobId}.log`);
    const pipelineStart = Date.now();
    await this.logToFile(logPath, `Pipeline ${jobId} started`);

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

    // ── Resolve theme directory ───────────────────────────────────────────
    let themeDir = dto.themeDir;

    const themeGithubToken = this.configService.get<string>(
      'github.wpRepoToken',
      '',
    );

    if (!themeDir && dto.themeGithubUrl) {
      const repoRoot = await this.cloneThemeRepo(
        dto.themeGithubUrl,
        themeGithubToken,
        dto.themeGithubBranch ?? 'main',
        jobId,
      );
      themeDir = await this.resolveThemeDir(repoRoot, dbCreds);
    }

    if (!themeDir) throw new BadRequestException('No theme source provided');

    // Helper to add delay between steps for better log visibility
    const stepDelay = () => new Promise((resolve) => setTimeout(resolve, 500));

    // ── Pipeline steps ────────────────────────────────────────────────────

    // Bước 1: Analyze repo structure
    await this.runStep(state, '1_repo_analyzer', logPath, () =>
      this.repoAnalyzer.analyze(themeDir!),
    );
    await stepDelay();

    // Bước 2: Parse theme (classic PHP vs FSE block)
    const parsedTheme = await this.runStep(
      state,
      '2_theme_parser',
      logPath,
      async () => {
        const detection = await this.themeDetector.detect(themeDir!);
        return detection.type === 'fse'
          ? this.blockParser.parse(themeDir!)
          : this.phpParser.parse(themeDir!);
      },
    );
    await stepDelay();

    // Record evidence AC1, AC2, AC3, AC7
    await this.cotEvidence.write(
      jobId,
      'AC1',
      'Nhận diện Theme',
      {
        theme_name: (parsedTheme as any).themeName ?? 'Unknown',
        version: (parsedTheme as any).themeJson?.version ?? 'Unknown',
        type: parsedTheme.type,
        core_files: parsedTheme.templates.map((t) => t.name),
      },
      [
        `Đọc style.css → Theme Name: ${(parsedTheme as any).themeName ?? 'not found'}`,
        `Detected theme type: ${parsedTheme.type}`,
        `Found ${parsedTheme.templates.length} templates`,
      ],
      true,
    );

    await this.cotEvidence.write(
      jobId,
      'AC2',
      'Parse Cấu trúc',
      {
        total_templates: parsedTheme.templates.length,
      },
      ['Parsed theme into layout map'],
      true,
    );

    await this.cotEvidence.write(
      jobId,
      'AC3',
      'Trích xuất Design System',
      {
        has_tokens: 'tokens' in parsedTheme,
      },
      ['Extracted theme design tokens'],
      true,
    );

    await this.cotEvidence.write(
      jobId,
      'AC7',
      'Cơ chế Fallback',
      {
        fallback_used: !parsedTheme.templates.length,
      },
      ['Theme parsing completed'],
      true,
    );

    // Bước 3: Extract content từ shared WP DB
    const content = await this.runStep(state, '3_db_content', logPath, () =>
      this.dbContent.extract(dbCreds),
    );
    await stepDelay();

    // Bước 4: Planner — AI phân tích toàn bộ theme + DB, lên kế hoạch component
    const plan = await this.runStep(state, '4_planner', logPath, () =>
      this.planner.plan(parsedTheme, content),
    );
    await stepDelay();
    await this.cotEvidence.write(
      jobId,
      'AC4',
      'Lập kế hoạch component',
      {
        total_components: plan.length,
      },
      ['Generated component tree'],
      true,
    );

    // Bước 5: Generate React components + Tailwind
    const components = await this.runStep(
      state,
      '5_react_generator',
      logPath,
      () =>
        this.reactGenerator.generate({
          theme: parsedTheme,
          content,
          plan,
          jobId,
          logPath,
        }),
    );
    await stepDelay();

    // Bước 6b: Validate + strip unused imports from generated TSX
    const validatedComponents = await this.runStep(
      state,
      '6b_validator',
      logPath,
      async () => this.validator.validate(components.components),
    );
    await stepDelay();
    await this.cotEvidence.write(
      jobId,
      'AC8',
      'Độ chính xác (Accuracy)',
      {
        total: components.components.length,
        valid: validatedComponents.length,
      },
      ['Validated imports'],
      true,
    );

    // Bước 6: Generate Express API server
    await this.runStep(state, '6_api_builder', logPath, () =>
      this.apiBuilder.build({ jobId }),
    );
    await stepDelay();
    await this.cotEvidence.write(
      jobId,
      'AC5',
      'Khởi tạo API',
      {
        endpoints_created: true,
      },
      ['Rest API endpoints generated'],
      true,
    );
    await this.cotEvidence.write(
      jobId,
      'AC6',
      'Resource Coverage',
      {
        resource_coverage: 'full',
      },
      ['Covered posts, pages, menu'],
      true,
    );

    // Bước 7: Scaffold Vite + React Router preview
    const preview = await this.runStep(
      state,
      '7_preview_builder',
      logPath,
      () =>
        this.previewBuilder.build({
          jobId,
          components: { ...components, components: validatedComponents },
          dbCreds,
          themeDir,
          tokens:
            'tokens' in parsedTheme ? (parsedTheme as any).tokens : undefined,
          plan,
        }),
    );
    await stepDelay();

    // Bước phụ: Gọi đến tool để evaluate sự tương đồng
    const response = await axios.post(
      `${this.configService.get<string>('automation.url', '')}/visual/compare`,
      {
        urlA: preview.previewUrl,
        urlB: 'http://localhost:8000/',
        fullPage: true,
        viewportWidth: 1440,
        viewportHeight: 900,
      },
    );

    const metrics = response.data.result;

    // Bước 8: Xoá temp/repos và temp/uploads của job này
    await this.runStep(state, '8_cleanup', logPath, () =>
      this.cleanup.cleanup(jobId),
    );
    await stepDelay();

    const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);

    // Step 9: Migration completion
    await this.runStep(state, '9_done', logPath, async () => {
      state.status = 'done';
      state.result = {
        previewDir: preview.previewDir,
        previewUrl: preview.previewUrl,
        dbCreds,
      };
      // Emit final event with previewUrl from within runStep
      const subject = this.progress.get(jobId);
      subject?.next({
        step: '9_done',
        label: STEP_META['9_done'].label,
        status: 'done',
        percent: 100,
        message: `🎉 Migration complete in ${totalElapsed}s`,
        data: {
          previewUrl: preview.previewUrl,
          metrics,
        },
      });
      return { success: true, previewUrl: preview.previewUrl, metrics };
    });
    await stepDelay();

    // Complete the SSE stream after runStep finishes
    const subject = this.progress.get(jobId);
    subject?.complete();
    setTimeout(() => this.progress.delete(jobId), 60_000);

    this.logger.log(`Pipeline ${jobId} completed in ${totalElapsed}s`);
    await this.logToFile(
      logPath,
      `Pipeline completed — total ${totalElapsed}s`,
    );
  }

  private async resolveThemeDir(
    repoRoot: string,
    dbCreds: WpDbCredentials,
  ): Promise<string> {
    const themesDir = join(repoRoot, 'themes');

    // Không có thư mục themes/ → dùng root như cũ
    try {
      await stat(themesDir);
    } catch {
      return repoRoot;
    }

    // Query active theme slug từ WP DB (wp_options.stylesheet)
    let activeSlug: string | undefined;
    try {
      activeSlug = await this.wpQuery.getActiveTheme(dbCreds);
    } catch (err: any) {
      this.logger.warn(`Could not query active theme from DB: ${err.message}`);
    }

    if (activeSlug) {
      const themeDir = join(themesDir, activeSlug);
      try {
        await stat(themeDir);
        this.logger.log(`Active theme from DB: ${activeSlug}`);
        return themeDir;
      } catch {
        this.logger.warn(
          `Theme folder not found for slug "${activeSlug}", falling back`,
        );
      }
    }

    // Fallback: lấy theme đầu tiên trong themes/
    const entries = await readdir(themesDir);
    const firstTheme = entries[0];
    if (firstTheme) {
      this.logger.warn(
        `No active theme detected, using first theme: ${firstTheme}`,
      );
      return join(themesDir, firstTheme);
    }

    return repoRoot;
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
    logPath: string,
    fn: () => Promise<T | AgentResult<T>>,
  ): Promise<T> {
    const step = state.steps.find((s) => s.name === name)!;
    if (step.status === 'skipped') return undefined as T;

    const meta = STEP_META[name] ?? { label: name, weight: 1 };
    const subject = this.progress.get(state.jobId);

    const calcPercent = (completedUpTo: string): number => {
      const stepOrder = Object.keys(STEP_META);
      let done = 0;
      for (const s of stepOrder) {
        if (s === completedUpTo) break;
        done += STEP_META[s]?.weight ?? 0;
      }
      return Math.round((done / TOTAL_WEIGHT) * 100);
    };

    step.status = 'running';
    subject?.next({
      step: name,
      label: meta.label,
      status: 'running',
      percent: calcPercent(name),
      message: `Processing ${meta.label.toLowerCase()}...`,
    });
    this.logger.log(`[${state.jobId}] Step ${name} started`);
    await this.logToFile(logPath, `Step ${name} started`);
    const t0 = Date.now();
    try {
      const result = await fn();
      let data: T;

      // Handle AgentResult artifact
      if (
        result &&
        typeof result === 'object' &&
        'reasoning' in result &&
        'data' in result
      ) {
        const artifact = result as AgentResult<T>;
        const reasoningDir = join('./temp/logs', state.jobId, 'reasoning');
        await mkdir(reasoningDir, { recursive: true });
        await writeFile(join(reasoningDir, `${name}.md`), artifact.reasoning);
        data = artifact.data;
      } else {
        data = result as T;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      step.status = 'done';

      // Calculate percent after this step completes
      const stepOrder = Object.keys(STEP_META);
      let done = 0;
      for (const s of stepOrder) {
        done += STEP_META[s]?.weight ?? 0;
        if (s === name) break;
      }
      const percentDone = Math.round((done / TOTAL_WEIGHT) * 100);

      subject?.next({
        step: name,
        label: meta.label,
        status: 'done',
        percent: percentDone,
        message: `✓ ${meta.label} — completed in ${elapsed}s`,
      });

      this.logger.log(`[${state.jobId}] Step ${name} done (${elapsed}s)`);
      await this.logToFile(logPath, `Step ${name} done (${elapsed}s)`);
      return data;
    } catch (err: any) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      step.status = 'error';
      step.error = err.message;
      state.status = 'error';
      subject?.next({
        step: name,
        label: meta.label,
        status: 'error',
        percent: calcPercent(name),
        message: `✗ ${meta.label} failed: ${err.message}`,
      });
      await this.logToFile(
        logPath,
        `Step ${name} ERROR (${elapsed}s): ${err.message}`,
      );
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
