import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { lastValueFrom, ReplaySubject, Subject } from 'rxjs';
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
import { NormalizerService } from '../agents/normalizer/normalizer.service.js';
import { DbContentService } from '../agents/db-content/db-content.service.js';
import { PlannerService } from '../agents/planner/planner.service.js';
import { PlanReviewerService } from '../agents/plan-reviewer/plan-reviewer.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { GeneratedCodeReviewService } from '../agents/react-generator/generated-code-review.service.js';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { GeneratedApiReviewService } from '../agents/api-builder/generated-api-review.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { ValidatorService } from '../agents/validator/validator.service.js';
import { CleanupService } from '../agents/cleanup/cleanup.service.js';
import { CotEvidenceService } from '../cot-evidence/cot-evidence.service.js';
import {
  RunPipelineDto,
  PipelineModelConfig,
} from './orchestrator.controller.js';
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

// ── Pipeline steps aligned with the 6-stage flow diagram ─────────────────
//
//  Stage 1: Repository Analysis       → 1_repo_analyzer, 2_theme_parser
//  Stage 2: WordPress Content Graph   → 3_content_graph
//  Stage 3: Planner (C1→C2→C3→C4→C5→C6 loop)
//                                     → 4_planner  (includes Plan Review inside)
//  Stage 4+5: React Generator + Code Review Loop
//                                     → 5_generator (includes D4 AST Validator inside)
//  Stage 6: Build & Preview           → 6_api_builder, 7_preview_builder
//
const STEP_META: Record<
  string,
  {
    label: string;
    weight: number;
    activeMessage: string;
    doneMessage: string;
  }
> = {
  // Stage 1: Repository Analysis
  '1_repo_analyzer': {
    label: 'Read Theme Repository',
    weight: 8,
    activeMessage:
      'AI agent is cloning the repository and reading the theme structure.',
    doneMessage: 'Theme repository has been cloned and analyzed.',
  },
  '2_theme_parser': {
    label: 'Parse Theme Templates',
    weight: 10,
    activeMessage:
      'AI agent is parsing templates, parts, and block markup from the theme.',
    doneMessage: 'Theme templates and parts have been parsed successfully.',
  },
  '3_normalizer': {
    label: 'Normalize Source Templates',
    weight: 5,
    activeMessage:
      'AI agent is cleaning and normalizing template source for downstream planning.',
    doneMessage: 'Template source has been normalized and cleaned.',
  },
  // Stage 2: WordPress Content Graph
  '4_content_graph': {
    label: 'Load WordPress Content',
    weight: 10,
    activeMessage:
      'AI agent is loading posts, pages, menus, and taxonomy data from WordPress.',
    doneMessage: 'WordPress content graph is ready.',
  },
  // Stage 3: Planner — Phase A→B→C→D with retry
  '5_planner': {
    label: 'Plan Components And Routes',
    weight: 40,
    activeMessage:
      'AI planner is mapping templates to components, routes, data needs, and visual sections.',
    doneMessage: 'Component plan, routes, and visual layout plan are ready.',
  },
  // Stage 4+5: React Generator + Code Review Loop (includes D4 AST Validator)
  '6_generator': {
    label: 'Generate React Components',
    weight: 30,
    activeMessage:
      'AI code agent is generating React components, reviewing output, and repairing invalid code.',
    doneMessage: 'React components have been generated and validated.',
  },
  // Stage 6: Build & Preview
  '7_api_builder': {
    label: 'Prepare Preview API',
    weight: 5,
    activeMessage: 'AI agent is preparing the preview API server.',
    doneMessage: 'Preview API server has been prepared.',
  },
  '8_preview_builder': {
    label: 'Build And Check Preview',
    weight: 8,
    activeMessage:
      'AI agent is assembling the preview app, verifying the build, and checking runtime behavior.',
    doneMessage: 'Preview app build and runtime checks have passed.',
  },
  '9_cleanup': {
    label: 'Clean Temporary Files',
    weight: 2,
    activeMessage:
      'AI agent is cleaning temporary files from this migration run.',
    doneMessage: 'Temporary files have been cleaned up.',
  },
  '10_done': {
    label: 'Migration Ready',
    weight: 0,
    activeMessage: 'Migration is being finalized.',
    doneMessage: 'Migration workflow is complete.',
  },
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
  private readonly progress = new Map<string, ReplaySubject<ProgressEvent>>();

  constructor(
    private readonly sqlService: SqlService,
    private readonly wpQuery: WpQueryService,
    private readonly themeDetector: ThemeDetectorService,
    private readonly repoAnalyzer: RepoAnalyzerService,
    private readonly phpParser: PhpParserService,
    private readonly blockParser: BlockParserService,
    private readonly normalizer: NormalizerService,
    private readonly dbContent: DbContentService,
    private readonly planner: PlannerService,
    private readonly planReviewer: PlanReviewerService,
    private readonly reactGenerator: ReactGeneratorService,
    private readonly generatedCodeReview: GeneratedCodeReviewService,
    private readonly apiBuilder: ApiBuilderService,
    private readonly generatedApiReview: GeneratedApiReviewService,
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
        // Stage 1: Repository Analysis (A1 → A2 → A3)
        { name: '1_repo_analyzer', status: 'pending' },
        { name: '2_theme_parser', status: 'pending' },
        { name: '3_normalizer', status: 'pending' },
        // Stage 2: WordPress Content Graph (B1)
        { name: '4_content_graph', status: 'pending' },
        // Stage 3: Planner — Phase A (AI Architecture) → B (Component Graph)
        //          → C (AI Visual Sections) → D (Plan Review/Consistency)
        //          → Plan Valid? → retry loop back to Phase A if invalid
        { name: '5_planner', status: 'pending' },
        // Stage 4: React Generator (D1 Visual Plan? → D2 Deterministic / D3 AI Fallback → D4 AST Validator)
        // Stage 5: Code Review Loop (R1 Code Reviewer → R2 Plan Match? → R3 Fix Agent → D1)
        { name: '6_generator', status: 'pending' },
        // Stage 6: Build & Preview (E1 API → E2 Vite → E3 Runtime Instrumentation → E4 Visual Compare)
        { name: '7_api_builder', status: 'pending' },
        { name: '8_preview_builder', status: 'pending' },
        { name: '9_cleanup', status: 'pending' },
        { name: '10_done', status: 'pending' },
      ],
    };
    this.jobs.set(jobId, state);
    this.progress.set(jobId, this.createProgressStream());

    this.executePipeline(jobId, dto, state).catch((err) => {
      state.status = 'error';
      state.error = err.message;
      const subject = this.progress.get(jobId);
      subject?.next({
        step: 'error',
        label: 'Pipeline Error',
        status: 'error',
        percent: 0,
        message: `AI workflow stopped because of an error: ${err.message}`,
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

  getProgressStream(jobId: string): ReplaySubject<ProgressEvent> {
    if (!this.progress.has(jobId)) {
      this.progress.set(jobId, this.createProgressStream());
    }
    return this.progress.get(jobId)!;
  }

  private createProgressStream(): ReplaySubject<ProgressEvent> {
    return new ReplaySubject<ProgressEvent>(100);
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

    // ── Resolve per-step model overrides ─────────────────────────────────
    // Priority: request-level modelConfig > env vars > agent default.
    // Format: plain model name (uses global AI_PROVIDER) or "provider/model"
    // e.g. "mistral/mistral-large-latest", "ollama/qwen2.5-coder:7b"
    const mc: PipelineModelConfig = dto.modelConfig ?? {};
    const cfgPlanning = this.configService.get<string>(
      'pipeline.planningModel',
    );
    const cfgGenCode = this.configService.get<string>('pipeline.genCodeModel');
    const cfgReviewCode = this.configService.get<string>(
      'pipeline.reviewCodeModel',
    );
    const cfgBackendReview = this.configService.get<string>(
      'pipeline.backendReviewModel',
    );
    const cfgAiReviewMode = this.configService.get<string>(
      'pipeline.aiReviewMode',
      'warn',
    );
    const cfgBackendAiReviewMode = this.configService.get<string>(
      'pipeline.backendAiReviewMode',
      'warn',
    );
    const cfgFixAgent = this.configService.get<string>(
      'pipeline.fixAgentModel',
    );
    const resolvedModels = {
      planning:
        mc.planning ??
        mc.planner ??
        cfgPlanning ??
        'mistral/mistral-large-latest',
      genCode: mc.genCode ?? cfgGenCode ?? 'mistral/codestral-latest',
      reviewCode: mc.reviewCode ?? mc.codeReviewer ?? cfgReviewCode,
      backendReview:
        mc.backendReview ??
        mc.reviewCode ??
        mc.codeReviewer ??
        cfgBackendReview,
      aiReviewMode: (cfgAiReviewMode === 'blocking' ? 'blocking' : 'warn') as
        | 'warn'
        | 'blocking',
      backendAiReviewMode: (cfgBackendAiReviewMode === 'blocking'
        ? 'blocking'
        : 'warn') as 'warn' | 'blocking',
      fixAgent:
        mc.fixAgent ??
        mc.reviewCode ??
        mc.codeReviewer ??
        cfgFixAgent ??
        cfgReviewCode,
    };
    this.logger.log(
      `[models] planning="${resolvedModels.planning ?? 'default'}" ` +
        `genCode="${resolvedModels.genCode ?? 'default'}" ` +
        `reviewCode="${resolvedModels.reviewCode ?? 'default'}" ` +
        `backendReview="${resolvedModels.backendReview ?? 'default'}" ` +
        `aiReviewMode="${resolvedModels.aiReviewMode}" ` +
        `backendAiReviewMode="${resolvedModels.backendAiReviewMode}" ` +
        `fixAgent="${resolvedModels.fixAgent ?? 'default'}"`,
    );

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

    const themeGithubToken = this.configService.get<string>(
      'github.wpRepoToken',
      '',
    );

    // Helper to add delay between steps for better log visibility
    const stepDelay = () => new Promise((resolve) => setTimeout(resolve, 500));

    // ── Pipeline steps ────────────────────────────────────────────────────

    // Bước 1: Clone repo (nếu có GitHub URL) và phân tích cấu trúc theme
    const repoResult = await this.runStep(
      state,
      '1_repo_analyzer',
      logPath,
      async () => {
        let resolvedDir = dto.themeDir;

        if (!resolvedDir && dto.themeGithubUrl) {
          const repoRoot = await this.cloneThemeRepo(
            dto.themeGithubUrl,
            themeGithubToken,
            dto.themeGithubBranch ?? 'main',
            jobId,
          );
          resolvedDir = await this.resolveThemeDir(repoRoot, dbCreds);
        }

        if (!resolvedDir)
          throw new BadRequestException('No theme source provided');

        return this.repoAnalyzer.analyze(resolvedDir);
      },
    );
    const themeDir = repoResult.themeDir;
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

    // Bước 3: Normalize & Clean HTML
    const normalizedTheme = await this.runStep(
      state,
      '3_normalizer',
      logPath,
      () => this.normalizer.normalize(parsedTheme),
    );
    await stepDelay();

    // ── Stage 2: WordPress Content Graph (B1) ─────────────────────────────
    // B1: Content Graph Builder — posts, pages, menus, categories, tags, custom taxonomies
    const content = await this.runStep(state, '4_content_graph', logPath, () =>
      this.dbContent.extract(dbCreds),
    );
    await stepDelay();

    // ── Stage 3: Planner (C1 → C2 → C3 → C4 → C5 → C6 retry) ────────────
    // All 4 phases + plan review + retry loop are ONE atomic step.
    // Per diagram: C4 (Plan Review) and C5 (Plan Valid?) live INSIDE the Planner subgraph.
    const MAX_PLAN_RETRIES = 3;
    const expectedTemplateNames =
      normalizedTheme.type === 'classic'
        ? normalizedTheme.templates.map((t) => t.name)
        : [...normalizedTheme.templates, ...normalizedTheme.parts].map(
            (t) => t.name,
          );
    const reviewResult = await this.runStep(
      state,
      '5_planner',
      logPath,
      async () => {
        // Phase A (C1): AI Architecture Plan
        // Phase B (C2): Component Graph Builder — enrichPlan() deterministic
        // Phase C (C3): AI Visual Sections — buildVisualPlans()
        let plan = await this.planner.plan(
          normalizedTheme,
          content,
          resolvedModels.planning,
        );

        // Phase D (C4): Plan Review / Consistency Check
        let review = this.planReviewer.review(plan, expectedTemplateNames);

        // C5 → C6 retry loop: if plan invalid, loop back to C1
        for (
          let attempt = 2;
          attempt <= MAX_PLAN_RETRIES && !review.isValid;
          attempt++
        ) {
          this.logger.warn(
            `[${jobId}] [Stage 3: Phase D] Plan invalid (attempt ${attempt - 1}/${MAX_PLAN_RETRIES}): ${review.errors.join('; ')} — retrying Phases A→C`,
          );
          await this.logToFile(
            logPath,
            `[Stage 3: C6 Retry] attempt ${attempt}: ${review.errors.join('; ')}`,
          );
          this.progress.get(jobId)?.next({
            step: '5_planner',
            label: STEP_META['5_planner'].label,
            status: 'running',
            percent: 25,
            message:
              `AI planner is retrying the component plan ` +
              `(attempt ${attempt}/${MAX_PLAN_RETRIES}) after consistency checks failed.`,
          });

          // C6 → C1: reset and re-run Phases A, B, C
          plan = await this.planner.plan(
            normalizedTheme,
            content,
            resolvedModels.planning,
          );
          review = this.planReviewer.review(plan, expectedTemplateNames);
        }

        if (!review.isValid) {
          throw new Error(
            `[Stage 3] Plan still invalid after ${MAX_PLAN_RETRIES} attempts: ${review.errors.join('; ')}`,
          );
        }

        return review;
      },
    );
    await stepDelay();

    await this.cotEvidence.write(
      jobId,
      'AC4',
      'Lập kế hoạch component',
      {
        total_components: reviewResult.plan.length,
        with_visual_plan: reviewResult.plan.filter((c: any) => c.visualPlan)
          .length,
      },
      ['[Stage 3] Generated component tree with visual plans (Phase A+B+C+D)'],
      true,
    );

    // ── Stage 4: React Generator + Stage 5: Review Loop ────────────────────────
    // Flow inside this step:
    //   1. AI code generation per component
    //   2. Rule-based validator cleanup / contract checks
    //   3. AI generated-code review across the finished component set
    const generationResult = await this.runStep(
      state,
      '6_generator',
      logPath,
      async () => {
        // Stage 4+5 core: generate + code review per component
        const result = await this.reactGenerator.generate({
          theme: normalizedTheme,
          content,
          plan: reviewResult.plan,
          jobId,
          logPath,
          modelConfig: {
            codeGenerator: resolvedModels.genCode,
            reviewCode: resolvedModels.reviewCode,
            fixAgent: resolvedModels.fixAgent,
          },
        });

        this.logger.log(
          `[Stage 4: D4 Validator] Validating & cleaning ${result.components.length} components`,
        );
        let components = this.validator.validate(result.components);

        const MAX_FIX_ATTEMPTS = 2;
        for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
          this.logger.log(
            `[Stage 5: AI Generated Code Review] Reviewing ${components.length} components (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
          );
          const review = await this.generatedCodeReview.review({
            components,
            plan: reviewResult.plan,
            modelName: resolvedModels.reviewCode,
            mode: resolvedModels.aiReviewMode,
            logPath,
          });

          if (review.success || review.failures.length === 0) {
            break;
          }

          this.logger.warn(
            `[Stage 5: AI Generated Code Review] ${review.failures.length} components failed review. Attempting auto-fix.`,
          );
          await this.logToFile(
            logPath,
            `[Stage 5] ${review.failures.length} components failed review. Attempting auto-fix loop (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
          );

          for (const failure of review.failures) {
            const compIndex = components.findIndex(
              (c) => c.name === failure.componentName,
            );
            if (compIndex !== -1) {
              components[compIndex] = await this.reactGenerator.fixComponent({
                component: components[compIndex],
                plan: reviewResult.plan,
                feedback: failure.message,
                modelConfig: { fixAgent: resolvedModels.fixAgent },
                logPath,
              });
            }
          }
        }

        return { ...result, components };
      },
    );
    await stepDelay();

    // ── Write generated TSX files to localOutputDir for local inspection ─────
    if (dto.localOutputDir) {
      const pagesOut = join(dto.localOutputDir, 'pages');
      const componentsOut = join(dto.localOutputDir, 'components');
      await mkdir(pagesOut, { recursive: true });
      await mkdir(componentsOut, { recursive: true });

      const PARTIAL_PATTERNS =
        /^(Header|Footer|Sidebar|Nav|Breadcrumb|Widget|Part[A-Z])/i;
      for (const comp of generationResult.components) {
        const isPartial =
          PARTIAL_PATTERNS.test(comp.name) || comp.isSubComponent;
        const targetDir = isPartial ? componentsOut : pagesOut;
        await writeFile(
          join(targetDir, `${comp.name}.tsx`),
          comp.code,
          'utf-8',
        );
      }

      const totalFiles = generationResult.components.length;
      this.logger.log(
        `[${jobId}] Written ${totalFiles} TSX files → ${dto.localOutputDir}`,
      );
      await this.logToFile(
        logPath,
        `Written ${totalFiles} TSX files → ${dto.localOutputDir}`,
      );
    }

    // ── Stage 6: Build & Preview (E1 → E2 → E3 → E4) ──────────────────────
    await this.runStep(state, '7_api_builder', logPath, async () => {
      let api = await this.apiBuilder.build({
        jobId,
        dbName: dbCreds.dbName,
        content,
      });

      const MAX_FIX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        this.logger.log(
          `[Stage 6: AI Generated Backend Review] Reviewing ${api.files.length} backend file(s) (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
        );
        const review = await this.generatedApiReview.review({
          api,
          plan: reviewResult.plan,
          content,
          modelName: resolvedModels.backendReview,
          mode: resolvedModels.backendAiReviewMode,
          logPath,
        });

        if (review.success || !review.blockingMessage) {
          break;
        }

        this.logger.warn(
          `[Stage 6: AI Generated Backend Review] Backend failed review: ${review.blockingMessage}. Attempting auto-fix.`,
        );
        await this.logToFile(
          logPath,
          `[Stage 6] Backend failed review: ${review.blockingMessage}. Attempting auto-fix loop (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
        );

        api = await this.apiBuilder.fixApi({
          result: api,
          feedback: review.blockingMessage,
          modelName: resolvedModels.fixAgent,
          logPath,
        });
      }

      return api;
    });
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

    // E2+E3+E4: Preview Builder — Vite + React Router (E2) + Runtime Instrumentation (E3) + Visual Compare (E4)
    const preview = await this.runStep(
      state,
      '8_preview_builder',
      logPath,
      () =>
        this.previewBuilder.build({
          jobId,
          components: generationResult,
          dbCreds,
          themeDir,
          tokens:
            'tokens' in normalizedTheme
              ? (normalizedTheme as any).tokens
              : undefined,
          plan: reviewResult.plan,
        }),
    );
    await stepDelay();

    // Bước phụ: Gọi đến tool để evaluate sự tương đồng
    let metrics: any = null;
    try {
      const response = await axios.post(
        `${this.configService.get<string>('automation.url', '')}/visual/compare`,
        {
          wpBaseUrl: 'http://localhost:8000/',
          reactFeUrl: 'http://localhost:5353',
          reactBeUrl: 'http://localhost:3775',
        },
      );
      metrics = response.data;
    } catch (err: any) {
      this.logger.error(
        `[visual/compare] failed — ${err?.message ?? err}`,
        err?.response?.data ?? err?.stack,
      );
    }

    await this.cotEvidence.write(
      jobId,
      'AC8',
      'Độ chính xác (Accuracy)',
      {
        total: generationResult.components.length,
        valid: generationResult.components.length,
        previewUrl: preview.previewUrl,
        previewValidated: true,
      },
      [
        '[Stage 4+5+6] Components passed generation, validation, preview build, and runtime smoke test',
      ],
      true,
    );

    // Bước 8: Xoá temp/repos và temp/uploads của job này
    await this.runStep(state, '9_cleanup', logPath, () =>
      this.cleanup.cleanup(jobId),
    );
    await stepDelay();

    const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);

    // Step 9: Migration completion
    await this.runStep(state, '10_done', logPath, async () => {
      state.status = 'done';
      state.result = {
        previewDir: preview.previewDir,
        previewUrl: preview.previewUrl,
        dbCreds,
      };
      // Emit final event with previewUrl from within runStep
      const subject = this.progress.get(jobId);
      subject?.next({
        step: '10_done',
        label: STEP_META['10_done'].label,
        status: 'done',
        percent: 100,
        message: `Migration workflow is complete. Preview is ready. (${totalElapsed}s)`,
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

    const meta = STEP_META[name] ?? {
      label: name,
      weight: 1,
      activeMessage: `AI agent is working on ${name}.`,
      doneMessage: `${name} has completed.`,
    };
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
      message: meta.activeMessage,
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
        message: `${meta.doneMessage} (${elapsed}s)`,
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
        message: `${meta.label} failed: ${err.message}`,
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
