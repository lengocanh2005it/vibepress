import type { AgentResult } from '@/common/types/pipeline.type.js';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { lastValueFrom, ReplaySubject } from 'rxjs';
import simpleGit from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { GeneratedApiReviewService } from '../agents/api-builder/generated-api-review.service.js';
import { BlockParserService } from '../agents/block-parser/block-parser.service.js';
import { CleanupService } from '../agents/cleanup/cleanup.service.js';
import { DbContentService } from '../agents/db-content/db-content.service.js';
import { NormalizerService } from '../agents/normalizer/normalizer.service.js';
import { PhpParserService } from '../agents/php-parser/php-parser.service.js';
import type { PhpParseResult } from '../agents/php-parser/php-parser.service.js';
import { PlanReviewerService } from '../agents/plan-reviewer/plan-reviewer.service.js';
import { PlannerService } from '../agents/planner/planner.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { GeneratedCodeReviewService } from '../agents/react-generator/generated-code-review.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { RepoAnalyzerService } from '../agents/repo-analyzer/repo-analyzer.service.js';
import type { RepoAnalyzeResult } from '../agents/repo-analyzer/repo-analyzer.service.js';
import type {
  RepoResolvedPluginSource,
  RepoResolvedSourceSummary,
  RepoThemeManifest,
} from '../agents/repo-analyzer/repo-analyzer.service.js';
import type { BlockParseResult } from '../agents/block-parser/block-parser.service.js';
import { ValidatorService } from '../agents/validator/validator.service.js';
import { SourceResolverService } from '../agents/source-resolver/source-resolver.service.js';
import { SqlService } from '../sql/sql.service.js';
import { WpQueryService } from '../sql/wp-query.service.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import { TokenTracker } from '../../common/utils/token-tracker.js';
import { RunPipelineDto } from './orchestrator.controller.js';
import { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { parseDbConnectionString } from '../../common/utils/db-connection-parser.js';

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
    label: 'Analyze Theme Source',
    weight: 8,
    activeMessage:
      'Resolving the theme source, cloning the repository when needed, and inspecting the theme file structure.',
    doneMessage:
      'Theme source has been resolved and the repository structure is understood.',
  },
  '2_theme_parser': {
    label: 'Parse Theme Templates',
    weight: 10,
    activeMessage:
      'Detecting the theme type and converting templates, parts, and block markup into a machine-readable template graph.',
    doneMessage:
      'Theme templates and reusable parts have been parsed into structured source.',
  },
  '3_normalizer': {
    label: 'Normalize Template Source',
    weight: 5,
    activeMessage:
      'Cleaning and normalizing parsed template source so downstream planning works on consistent markup.',
    doneMessage:
      'Template source has been normalized for planning and generation.',
  },
  // Stage 2: WordPress Content Graph
  '4_content_graph': {
    label: 'Extract WordPress Content Model',
    weight: 10,
    activeMessage:
      'Querying WordPress for posts, pages, menus, taxonomies, plugins, and runtime capabilities.',
    doneMessage:
      'WordPress content model and runtime capability graph are ready.',
  },
  // Stage 3: Planner — Phase A→B→C→D with retry
  '5_planner': {
    label: 'Plan Routes, Data, And Visual Sections',
    weight: 40,
    activeMessage:
      'Building the component graph, route map, data contracts, and approved visual sections for each template.',
    doneMessage: 'Component architecture, routes, and visual plans are ready.',
  },
  // Stage 4+5: React Generator + Code Review Loop (includes D4 AST Validator)
  '6_generator': {
    label: 'Generate And Repair React Components',
    weight: 30,
    activeMessage:
      'Generating React components, validating contracts, reviewing output, and repairing invalid code when needed.',
    doneMessage:
      'React components have been generated, reviewed, and validated.',
  },
  // Stage 6: Build & Preview
  '7_api_builder': {
    label: 'Build Preview API Layer',
    weight: 5,
    activeMessage:
      'Preparing the Express preview API, injecting extra routes, and reviewing backend coverage against the frontend contract.',
    doneMessage: 'Preview API layer has been built and reviewed.',
  },
  '8_preview_builder': {
    label: 'Assemble Preview And Run Checks',
    weight: 8,
    activeMessage:
      'Assembling the preview app, wiring environment files, verifying the build, and smoke-testing runtime behavior.',
    doneMessage:
      'Preview app assembly, build checks, and runtime smoke tests have passed.',
  },
  '9_visual_compare': {
    label: 'Evaluate Visual Metrics',
    weight: 2,
    activeMessage:
      'Comparing the WordPress site and the React preview to compute visual diff metrics and artifacts.',
    doneMessage:
      'Visual comparison metrics and diff artifacts have been collected.',
  },
  '10_cleanup': {
    label: 'Clean Temporary Workspace',
    weight: 1,
    activeMessage:
      'Cleaning temporary repositories, uploads, and generated artifacts from this migration run.',
    doneMessage: 'Temporary workspace cleanup has finished.',
  },
  '11_done': {
    label: 'Preview Ready',
    weight: 0,
    activeMessage: 'Finalizing preview metadata and completion state.',
    doneMessage: 'Migration workflow is complete and the preview is ready.',
  },
};

const TOTAL_WEIGHT = Object.values(STEP_META).reduce((s, m) => s + m.weight, 0);

interface PluginTemplateSpec {
  templateName: string;
  aliasNames: string[];
  mainTemplate: string;
  relatedTemplates: string[];
  relatedDirectories: string[];
}

const WOO_SUPPORT_DIR_FILE_LIMIT = 12;

const WOO_STOREFRONT_TEMPLATE_SPECS: PluginTemplateSpec[] = [
  {
    templateName: 'archive-product',
    aliasNames: ['archive-product', 'shop'],
    mainTemplate: 'archive-product.php',
    relatedTemplates: ['content-product.php', 'content-product-cat.php'],
    relatedDirectories: ['loop', 'global', 'notices', 'parts', 'brands'],
  },
  {
    templateName: 'single-product',
    aliasNames: ['single-product'],
    mainTemplate: 'single-product.php',
    relatedTemplates: [
      'content-single-product.php',
      'single-product-reviews.php',
    ],
    relatedDirectories: [
      'single-product',
      'global',
      'notices',
      'product-form',
      'parts',
      'brands',
    ],
  },
  {
    templateName: 'taxonomy-product-cat',
    aliasNames: ['taxonomy-product-cat', 'product-category'],
    mainTemplate: 'taxonomy-product-cat.php',
    relatedTemplates: ['content-product.php', 'content-product-cat.php'],
    relatedDirectories: ['loop', 'global', 'notices', 'parts', 'brands'],
  },
  {
    templateName: 'taxonomy-product-tag',
    aliasNames: ['taxonomy-product-tag', 'product-tag'],
    mainTemplate: 'taxonomy-product-tag.php',
    relatedTemplates: ['content-product.php'],
    relatedDirectories: ['loop', 'global', 'notices', 'parts', 'brands'],
  },
  {
    templateName: 'cart',
    aliasNames: ['cart'],
    mainTemplate: 'cart/cart.php',
    relatedTemplates: [],
    relatedDirectories: ['cart', 'global', 'notices', 'block-notices', 'parts'],
  },
  {
    templateName: 'my-account',
    aliasNames: ['my-account', 'myaccount'],
    mainTemplate: 'myaccount/my-account.php',
    relatedTemplates: [],
    relatedDirectories: ['myaccount', 'auth', 'global', 'notices', 'parts'],
  },
];

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
  private readonly tokenTracker = new TokenTracker();
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
    private readonly sourceResolver: SourceResolverService,
    private readonly cleanup: CleanupService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async run(siteId: string): Promise<{ jobId: string }> {
    const response = await lastValueFrom(
      this.httpService.get(
        `${this.configService.get<string>('automation.url', '')}/wp/db-info-by-site?siteId=${siteId}`,
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
        // Stage 6: Build & Preview (E1 API → E2 Vite → E3 Runtime Instrumentation)
        { name: '7_api_builder', status: 'pending' },
        { name: '8_preview_builder', status: 'pending' },
        // Stage 7: Visual Compare (E4)
        { name: '9_visual_compare', status: 'pending' },
        // Stage 8: Cleanup + completion
        { name: '10_cleanup', status: 'pending' },
        { name: '11_done', status: 'pending' },
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

  private getStepMeta(name: string) {
    return (
      STEP_META[name] ?? {
        label: name,
        weight: 1,
        activeMessage: `AI agent is working on ${name}.`,
        doneMessage: `${name} has completed.`,
      }
    );
  }

  private calcPercentBefore(name: string): number {
    const stepOrder = Object.keys(STEP_META);
    let done = 0;
    for (const stepName of stepOrder) {
      if (stepName === name) break;
      done += STEP_META[stepName]?.weight ?? 0;
    }
    return Math.round((done / TOTAL_WEIGHT) * 100);
  }

  private calcPercentThrough(name: string): number {
    const stepOrder = Object.keys(STEP_META);
    let done = 0;
    for (const stepName of stepOrder) {
      done += STEP_META[stepName]?.weight ?? 0;
      if (stepName === name) break;
    }
    return Math.round((done / TOTAL_WEIGHT) * 100);
  }

  private emitStepProgress(
    state: PipelineStatus,
    name: string,
    progressWithinStep: number,
    message: string,
    data?: ProgressEventData,
  ): void {
    const meta = this.getStepMeta(name);
    const subject = this.progress.get(state.jobId);
    const bounded = Math.min(Math.max(progressWithinStep, 0), 0.99);
    const beforeWeight = Object.keys(STEP_META)
      .slice(0, Math.max(Object.keys(STEP_META).indexOf(name), 0))
      .reduce((sum, stepName) => sum + (STEP_META[stepName]?.weight ?? 0), 0);
    const percent = Math.round(
      ((beforeWeight + meta.weight * bounded) / TOTAL_WEIGHT) * 100,
    );

    subject?.next({
      step: name,
      label: meta.label,
      status: 'running',
      percent,
      message,
      data,
    });
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
    const jobLogDir = join('./temp/logs', jobId);
    await mkdir(join(jobLogDir, 'tokens'), { recursive: true });
    const logPath = join(jobLogDir, 'pipeline.log');
    const tokenLogPath = join(jobLogDir, 'tokens', 'total.tokens.log');
    const pipelineStart = Date.now();
    await this.tokenTracker.init(tokenLogPath);
    await this.logToFile(logPath, `Pipeline ${jobId} started`);
    try {
      const cfgPlanning = this.configService.get<string>(
        'pipeline.planningModel',
      );
      const cfgGenCode = this.configService.get<string>(
        'pipeline.genCodeModel',
      );
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
        planning: cfgPlanning ?? 'mistral/mistral-large-latest',
        genCode: cfgGenCode ?? 'mistral/codestral-latest',
        reviewCode: cfgReviewCode,
        backendReview: cfgBackendReview,
        aiReviewMode: (cfgAiReviewMode === 'blocking' ? 'blocking' : 'warn') as
          | 'warn'
          | 'blocking',
        backendAiReviewMode: (cfgBackendAiReviewMode === 'blocking'
          ? 'blocking'
          : 'warn') as 'warn' | 'blocking',
        fixAgent: cfgFixAgent ?? cfgReviewCode,
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

      const { dbConnectionString, themeGithubUrl } = dto;
      const dbCreds = this.toWpDbCredentials(dbConnectionString);

      await this.sqlService.verifyDirectCredentials(dbConnectionString);

      const themeGithubToken = this.configService.get<string>(
        'github.wpRepoToken',
        '',
      );

      // Helper to add delay between steps for better log visibility
      const stepDelay = () =>
        new Promise((resolve) => setTimeout(resolve, 500));

      // ── Pipeline steps ────────────────────────────────────────────────────

      // Bước 1: Clone repo (nếu có GitHub URL) và phân tích cấu trúc theme
      const repoResult = await this.runStep(
        state,
        '1_repo_analyzer',
        logPath,
        async () => {
          this.emitStepProgress(
            state,
            '1_repo_analyzer',
            0.1,
            'Resolving the theme source input and preparing repository analysis.',
          );

          this.emitStepProgress(
            state,
            '1_repo_analyzer',
            0.35,
            'Cloning the WordPress theme repository from GitHub.',
          );
          const repoRoot = await this.cloneThemeRepo(
            themeGithubUrl,
            themeGithubToken,
            jobId,
          );
          this.emitStepProgress(
            state,
            '1_repo_analyzer',
            0.7,
            'Repository cloned. Resolving the active theme directory from WordPress data.',
          );
          const resolvedDir = await this.resolveThemeDir(
            repoRoot,
            dbConnectionString,
          );

          this.emitStepProgress(
            state,
            '1_repo_analyzer',
            0.9,
            'Scanning theme folders, templates, and structural entry points.',
          );
          const repoAnalysis = await this.repoAnalyzer.analyze(resolvedDir);
          await this.recordRepoAnalysis(jobLogDir, logPath, repoAnalysis);
          return repoAnalysis;
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
          this.emitStepProgress(
            state,
            '2_theme_parser',
            0.15,
            'Detecting whether the source theme is classic PHP or block-based FSE.',
          );
          const detection = await this.themeDetector.detect(themeDir!);
          this.emitStepProgress(
            state,
            '2_theme_parser',
            0.55,
            detection.type === 'fse'
              ? 'Parsing block templates and template parts from the FSE theme.'
              : 'Parsing PHP templates, partials, and WordPress template hints from the classic theme.',
          );
          return detection.type === 'fse'
            ? this.blockParser.parse(themeDir!)
            : this.phpParser.parse(themeDir!);
        },
      );
      await stepDelay();

      // Record evidence AC1, AC2, AC3, AC7
      // Removed cotEvidence logging

      // Bước 3: Normalize & Clean HTML
      let normalizedTheme = await this.runStep(
        state,
        '3_normalizer',
        logPath,
        async () => {
          this.emitStepProgress(
            state,
            '3_normalizer',
            0.25,
            'Cleaning parsed template source and removing noisy markup before planning.',
          );
          const result = await this.normalizer.normalize(parsedTheme);
          this.emitStepProgress(
            state,
            '3_normalizer',
            0.8,
            'Normalized source is ready for route and component planning.',
          );
          return result;
        },
      );
      await stepDelay();

      // ── Stage 2: WordPress Content Graph (B1) ─────────────────────────────
      // B1: Content Graph Builder — posts, pages, menus, categories, tags, custom taxonomies
      const content = await this.runStep(
        state,
        '4_content_graph',
        logPath,
        async () => {
          this.emitStepProgress(
            state,
            '4_content_graph',
            0.15,
            'Querying WordPress tables for site info, pages, posts, menus, and taxonomies.',
          );
          const result = await this.dbContent.extract(dbConnectionString);
          this.emitStepProgress(
            state,
            '4_content_graph',
            0.75,
            'Combining runtime capabilities, plugin discovery, and extracted content into one content graph.',
          );
          return result;
        },
      );
      await stepDelay();

      const resolvedSource = await this.sourceResolver.resolve({
        manifest: repoResult.themeManifest,
        dbConnectionString,
        content,
      });
      repoResult.themeManifest.resolvedSource = resolvedSource;
      await this.recordRepoAnalysis(jobLogDir, logPath, repoResult);
      const enrichResult = await this.enrichThemeWithPluginTemplates({
        theme: normalizedTheme,
        themeDir,
        manifest: repoResult.themeManifest,
        resolvedSource,
        logPath,
      });
      normalizedTheme = enrichResult.theme;
      const wooPluginDir = enrichResult.wooPluginDir;

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
          this.emitStepProgress(
            state,
            '5_planner',
            0.08,
            'Building the first component architecture pass from normalized theme source and WordPress content.',
          );
          // Phase A (C1): AI Architecture Plan
          // Phase B (C2): Component Graph Builder — enrichPlan() deterministic
          let plan = await this.planner.plan(
            normalizedTheme,
            content,
            resolvedModels.planning,
            jobId,
            {
              includeVisualPlans: false,
              logPath,
              repoManifest: repoResult.themeManifest,
            },
          );
          this.emitStepProgress(
            state,
            '5_planner',
            0.4,
            `Initial architecture plan created for ${plan.length} component contract(s). Running consistency review before visual sections are generated.`,
          );

          // Phase D (C4): Plan Review / Consistency Check
          let review = this.planReviewer.review(
            plan,
            expectedTemplateNames,
            repoResult.themeManifest,
          );

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
            this.emitStepProgress(
              state,
              '5_planner',
              0.35,
              `Planner retry ${attempt}/${MAX_PLAN_RETRIES}: rebuilding routes, data needs, and visual sections after review feedback.`,
            );

            // C6 → C1: reset and re-run Phases A, B, C
            plan = await this.planner.plan(
              normalizedTheme,
              content,
              resolvedModels.planning,
              jobId,
              {
                includeVisualPlans: false,
                logPath,
                repoManifest: repoResult.themeManifest,
                planReviewErrors: review.errors,
              },
            );
            review = this.planReviewer.review(
              plan,
              expectedTemplateNames,
              repoResult.themeManifest,
            );
            this.emitStepProgress(
              state,
              '5_planner',
              0.55,
              `Planner retry ${attempt}/${MAX_PLAN_RETRIES}: re-running consistency review on the regenerated architecture plan.`,
            );
          }

          if (!review.isValid) {
            throw new Error(
              `[Stage 3] Plan still invalid after ${MAX_PLAN_RETRIES} attempts: ${review.errors.join('; ')}`,
            );
          }

          this.emitStepProgress(
            state,
            '5_planner',
            0.72,
            'Architecture review passed. Generating visual sections from the reviewed route map and data contracts.',
          );
          const MAX_VISUAL_RETRIES = 2;
          let planWithVisuals = await this.planner.attachVisualPlans(
            normalizedTheme,
            content,
            review.plan,
            resolvedModels.planning,
            repoResult.themeManifest,
          );
          let visualReview = this.planReviewer.review(
            planWithVisuals,
            expectedTemplateNames,
            repoResult.themeManifest,
          );
          for (
            let vAttempt = 2;
            vAttempt <= MAX_VISUAL_RETRIES && !visualReview.isValid;
            vAttempt++
          ) {
            this.logger.warn(
              `[${jobId}] [Stage 3: Visual Plan] Review failed (attempt ${vAttempt - 1}/${MAX_VISUAL_RETRIES}): ${visualReview.errors.join('; ')} — retrying attachVisualPlans`,
            );
            await this.logToFile(
              logPath,
              `[Stage 3: Visual Plan Retry] attempt ${vAttempt}: ${visualReview.errors.join('; ')}`,
            );
            this.emitStepProgress(
              state,
              '5_planner',
              0.82,
              `Visual plan retry ${vAttempt}/${MAX_VISUAL_RETRIES}: regenerating visual sections after consistency check failed.`,
            );
            planWithVisuals = await this.planner.attachVisualPlans(
              normalizedTheme,
              content,
              review.plan,
              resolvedModels.planning,
              repoResult.themeManifest,
            );
            visualReview = this.planReviewer.review(
              planWithVisuals,
              expectedTemplateNames,
              repoResult.themeManifest,
            );
          }
          if (!visualReview.isValid) {
            throw new Error(
              `[Stage 3] Visual-plan synchronization failed after ${MAX_VISUAL_RETRIES} attempts: ${visualReview.errors.join('; ')}`,
            );
          }
          review = visualReview;

          this.emitStepProgress(
            state,
            '5_planner',
            0.92,
            'Planner review passed. Route map, data contracts, and visual sections are locked in.',
          );
          return review;
        },
      );
      await stepDelay();

      // Removed cotEvidence logging for planning

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
          this.emitStepProgress(
            state,
            '6_generator',
            0.08,
            'Generating React components from the approved visual plans.',
          );
          // Stage 4+5 core: generate + code review per component
          const result = await this.reactGenerator.generate({
            theme: normalizedTheme,
            content,
            plan: reviewResult.plan,
            repoManifest: repoResult.themeManifest,
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
          this.emitStepProgress(
            state,
            '6_generator',
            0.45,
            `Generated ${result.components.length} component file(s). Running validator cleanup and contract checks.`,
          );
          let components = this.validator.validate(result.components);

          // Deterministic components (Header, Footer, Sidebar, Page404, etc.) were
          // generated entirely by CodeGeneratorService — no LLM TSX gen involved.
          // Skipping Stage 5 AI review for them avoids false positives and unnecessary
          // AI calls on code that follows the contract by construction.
          const aiComponents = components.filter(
            (c) => c.generationMode !== 'deterministic',
          );
          const deterministicNames = components
            .filter((c) => c.generationMode === 'deterministic')
            .map((c) => c.name);
          if (deterministicNames.length > 0) {
            this.logger.log(
              `[Stage 5: AI Generated Code Review] Skipping ${deterministicNames.length} deterministic component(s): ${deterministicNames.join(', ')}`,
            );
          }

          const MAX_FIX_ATTEMPTS = 2;
          for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
            this.emitStepProgress(
              state,
              '6_generator',
              0.65,
              `AI review pass ${attempt}/${MAX_FIX_ATTEMPTS}: checking generated components against the approved contract.`,
            );
            this.logger.log(
              `[Stage 5: AI Generated Code Review] Reviewing ${aiComponents.length} components (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
            );
            const review = await this.generatedCodeReview.review({
              components: aiComponents,
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
            this.emitStepProgress(
              state,
              '6_generator',
              0.82,
              `Auto-fixing ${review.failures.length} component(s) that failed AI review.`,
            );
            await this.logToFile(
              logPath,
              `[Stage 5] ${review.failures.length} components failed review. Attempting auto-fix loop (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
            );

            // Fixes are independent — run all in parallel, then apply results.
            const fixResults = await Promise.all(
              review.failures.map(async (failure) => {
                const compIndex = aiComponents.findIndex(
                  (c) => c.name === failure.componentName,
                );
                if (compIndex === -1) return null;
                const fixed = await this.reactGenerator.fixComponent({
                  component: aiComponents[compIndex],
                  plan: reviewResult.plan,
                  feedback: failure.message,
                  modelConfig: { fixAgent: resolvedModels.fixAgent },
                  logPath,
                });
                try {
                  const revalidated = this.validator.validate([fixed]);
                  return { compIndex, component: revalidated[0] };
                } catch (validationErr: any) {
                  this.logger.warn(
                    `[Stage 5: Fix Loop] Re-validation failed for "${failure.componentName}" after fix — keeping original. Error: ${validationErr?.message}`,
                  );
                  await this.logToFile(
                    logPath,
                    `[Stage 5] Re-validation failed for "${failure.componentName}": ${validationErr?.message}`,
                  );
                  return null;
                }
              }),
            );
            for (const r of fixResults) {
              if (r) aiComponents[r.compIndex] = r.component;
            }
          }

          // Merge fixed AI components back into the full list (preserve original order).
          for (const fixed of aiComponents) {
            const idx = components.findIndex((c) => c.name === fixed.name);
            if (idx !== -1) components[idx] = fixed;
          }

          this.emitStepProgress(
            state,
            '6_generator',
            0.94,
            'React generation, validation, and repair loops have finished successfully.',
          );
          return { ...result, components };
        },
      );
      await stepDelay();

      // ── Stage 6: Build & Preview (E1 → E2 → E3 → E4) ──────────────────────
      await this.runStep(state, '7_api_builder', logPath, async () => {
        this.emitStepProgress(
          state,
          '7_api_builder',
          0.15,
          'Building the Express preview API template and injecting required routes.',
        );
        let api = await this.apiBuilder.build({
          jobId,
          dbName: dbCreds.dbName,
          logPath,
          content,
        });
        this.emitStepProgress(
          state,
          '7_api_builder',
          0.55,
          'Running backend review to verify API coverage matches the generated frontend contracts.',
        );

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
          this.emitStepProgress(
            state,
            '7_api_builder',
            0.78,
            `Backend auto-fix ${attempt}/${MAX_FIX_ATTEMPTS}: repairing generated API code from review feedback.`,
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

        this.emitStepProgress(
          state,
          '7_api_builder',
          0.93,
          'Preview API layer is ready for the runtime preview environment.',
        );
        return api;
      });
      await stepDelay();
      // Removed cotEvidence logging
      // Removed cotEvidence logging

      // E2+E3: Preview Builder — Vite + React Router (E2) + Runtime Instrumentation (E3)
      // Mutable component list — allows the build fix-loop below to patch TS errors
      let buildComponents = generationResult.components;
      const MAX_BUILD_FIX_ATTEMPTS = 2;

      const preview = await this.runStep(
        state,
        '8_preview_builder',
        logPath,
        async () => {
          this.emitStepProgress(
            state,
            '8_preview_builder',
            0.08,
            'Copying the React preview template, writing generated pages, and preparing environment files.',
          );
          for (
            let attempt = 1;
            attempt <= MAX_BUILD_FIX_ATTEMPTS + 1;
            attempt++
          ) {
            try {
              this.emitStepProgress(
                state,
                '8_preview_builder',
                0.38,
                `Preview build attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS + 1}: installing dependencies, building, and starting dev servers.`,
              );
              return await this.previewBuilder.build({
                jobId,
                components: {
                  ...generationResult,
                  components: buildComponents,
                },
                dbCreds,
                themeDir,
                wooPluginDir,
                tokens:
                  'tokens' in normalizedTheme
                    ? (normalizedTheme as any).tokens
                    : undefined,
                plan: reviewResult.plan,
              });
            } catch (err: any) {
              const errMsg: string = err?.message ?? String(err);
              const isBuildFail = errMsg.includes(
                '[validator] Preview build failed:',
              );
              if (!isBuildFail || attempt > MAX_BUILD_FIX_ATTEMPTS) throw err;

              const tsErrors = this.parseTsBuildErrors(errMsg);
              if (tsErrors.length === 0) throw err;

              this.logger.warn(
                `[Stage 8: Build Fix] ${tsErrors.length} TS error(s). Attempting auto-fix (attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS}).`,
              );
              this.emitStepProgress(
                state,
                '8_preview_builder',
                0.7,
                `Preview build fix ${attempt}/${MAX_BUILD_FIX_ATTEMPTS}: repairing ${tsErrors.length} TypeScript build issue(s).`,
              );
              await this.logToFile(
                logPath,
                `[Stage 8] Build failed with ${tsErrors.length} TS error(s). Attempting auto-fix (attempt ${attempt}/${MAX_BUILD_FIX_ATTEMPTS})`,
              );

              // All TS errors are independent — fix in parallel, then apply.
              const buildFixes = await Promise.all(
                tsErrors.map(async ({ componentName, error }) => {
                  const idx = buildComponents.findIndex(
                    (c) => c.name === componentName,
                  );
                  if (idx === -1) return null;
                  const fixed = await this.reactGenerator.fixComponent({
                    component: buildComponents[idx],
                    plan: reviewResult.plan,
                    feedback: `TypeScript build error:\n${error}`,
                    modelConfig: { fixAgent: resolvedModels.fixAgent },
                    logPath,
                  });
                  return { idx, fixed };
                }),
              );
              for (const r of buildFixes) {
                if (r) buildComponents[r.idx] = r.fixed;
              }
            }
          }
          throw new Error('[Stage 8] Build fix-loop exhausted all attempts');
        },
      );
      await stepDelay();

      // ── Stage 7: Visual Compare (E4) ──────────────────────────────────────
      let metrics: any = null;
      await this.runStep(state, '9_visual_compare', logPath, async () => {
        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.2,
          'Submitting the WordPress and React preview URLs to the compare service.',
        );
        try {
          const response = await axios.post(
            `${this.configService.get<string>('automation.url', '')}/site/compare`,
            {
              wpBaseUrl: 'http://localhost:8000/',
              reactFeUrl: 'http://localhost:5353',
              reactBeUrl: 'http://localhost:3775',
            },
          );
          metrics = response.data?.result ?? response.data;
        } catch (err: any) {
          this.logger.error(
            `[visual/compare] failed — ${err?.message ?? err}`,
            err?.response?.data ?? err?.stack,
          );
        }
        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.85,
          metrics
            ? 'Visual diff metrics are ready and attached to the final preview payload.'
            : 'Visual compare finished without metrics; pipeline will continue with cleanup.',
        );
        return metrics;
      });
      await stepDelay();

      // Bước 8: Xoá temp/repos và temp/uploads của job này
      await this.runStep(state, '10_cleanup', logPath, () =>
        this.cleanup.cleanup(jobId),
      );
      await stepDelay();

      const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);

      // Step 9: Migration completion
      await this.runStep(state, '11_done', logPath, async () => {
        state.status = 'done';
        state.result = {
          previewDir: preview.previewDir,
          previewUrl: preview.previewUrl,
          dbCreds,
        };
        // Emit final event with previewUrl from within runStep
        const subject = this.progress.get(jobId);
        subject?.next({
          step: '11_done',
          label: STEP_META['11_done'].label,
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
    } finally {
      await this.tokenTracker.writeSummary();
    }
  }

  private async resolveThemeDir(
    repoRoot: string,
    dbConnectionString: string,
  ): Promise<string> {
    // Thử theo thứ tự: <root>/themes/ rồi <root>/wp-content/themes/
    const themesdirCandidates = [
      join(repoRoot, 'themes'),
      join(repoRoot, 'wp-content', 'themes'),
    ];

    let themesDir: string | undefined;
    for (const candidate of themesdirCandidates) {
      try {
        await stat(candidate);
        themesDir = candidate;
        break;
      } catch {
        // try next
      }
    }

    if (!themesDir) return repoRoot;

    // Query active theme slug từ WP DB (wp_options.stylesheet)
    let activeSlug: string | undefined;
    try {
      activeSlug = await this.wpQuery.getActiveTheme(dbConnectionString);
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

  private async enrichThemeWithPluginTemplates(input: {
    theme: PhpParseResult | BlockParseResult;
    themeDir: string;
    manifest: RepoThemeManifest;
    resolvedSource: RepoResolvedSourceSummary;
    logPath?: string;
  }): Promise<{
    theme: PhpParseResult | BlockParseResult;
    wooPluginDir?: string;
  }> {
    const { theme, themeDir, manifest, resolvedSource, logPath } = input;
    const wooPlugin = this.findActivePluginSource(
      resolvedSource,
      'woocommerce',
    );
    if (!wooPlugin?.presentInRepo) return { theme };

    const themeSourceDirs = await this.resolveThemeSourceDirs(
      themeDir,
      resolvedSource,
    );
    const pluginDir = await this.resolveRepoRelativeDir(
      themeDir,
      wooPlugin.relativeDir,
    );
    if (!pluginDir) {
      this.logger.warn(
        `[source-enrichment] WooCommerce is active but plugin source dir could not be resolved from repo path "${wooPlugin.relativeDir ?? 'unknown'}"`,
      );
      return { theme };
    }

    let enrichedTheme: PhpParseResult | BlockParseResult = theme;
    const injectedTemplates: string[] = [];

    for (const spec of WOO_STOREFRONT_TEMPLATE_SPECS) {
      if (this.themeHasTemplate(enrichedTheme, spec.aliasNames)) continue;

      const source = await this.resolveWooCommerceTemplateBundle(
        spec,
        themeSourceDirs,
        pluginDir,
      );
      if (!source) continue;

      enrichedTheme =
        enrichedTheme.type === 'classic'
          ? {
              ...enrichedTheme,
              templates: [
                ...enrichedTheme.templates,
                { name: spec.templateName, html: source.markup },
              ],
            }
          : {
              ...enrichedTheme,
              templates: [
                ...enrichedTheme.templates,
                { name: spec.templateName, markup: source.markup },
              ],
            };

      injectedTemplates.push(
        `${spec.templateName} <= ${source.originDescription}`,
      );
    }

    if (injectedTemplates.length === 0) return { theme };

    const normalized = await this.normalizer.normalize(enrichedTheme);
    const note = `Injected WooCommerce storefront template source: ${injectedTemplates.join('; ')}`;

    this.logger.log(`[source-enrichment] ${note}`);
    if (logPath) {
      await this.logToFile(logPath, `[source-enrichment] ${note}`);
    }

    if (normalized.diagnostics) {
      normalized.diagnostics.warnings.push(note);
    }

    manifest.sourceOfTruth.notes.push(
      'WooCommerce storefront templates were injected from theme overrides/plugin source before planning when the active theme did not expose them directly.',
    );

    return { theme: normalized, wooPluginDir: pluginDir };
  }

  private findActivePluginSource(
    resolvedSource: RepoResolvedSourceSummary,
    slug: string,
  ): RepoResolvedPluginSource | undefined {
    return resolvedSource.activePlugins.find(
      (plugin) =>
        this.normalizeSourceSlug(plugin.slug) ===
          this.normalizeSourceSlug(slug) &&
        (plugin.active || plugin.runtimeDetected),
    );
  }

  private async resolveThemeSourceDirs(
    themeDir: string,
    resolvedSource: RepoResolvedSourceSummary,
  ): Promise<string[]> {
    const dirs = new Set<string>([resolve(themeDir)]);

    for (const theme of resolvedSource.themeChain) {
      const resolvedDir = await this.resolveRepoRelativeDir(
        themeDir,
        theme.relativeDir,
      );
      if (resolvedDir) dirs.add(resolve(resolvedDir));
    }

    return [...dirs];
  }

  private async resolveWooCommerceTemplateBundle(
    spec: PluginTemplateSpec,
    themeSourceDirs: string[],
    pluginDir: string,
  ): Promise<{ markup: string; originDescription: string } | null> {
    const mainSource = await this.resolveWooCommerceTemplateFile(
      themeSourceDirs,
      pluginDir,
      spec.mainTemplate,
    );
    if (!mainSource) return null;

    const segments = [
      `<!-- vibepress:source woocommerce template ${spec.templateName} (${mainSource.sourceType}: ${mainSource.sourcePath}) -->`,
      this.phpParser.toTemplateMarkup(mainSource.rawSource),
    ];

    for (const relatedTemplate of spec.relatedTemplates) {
      const relatedSource = await this.resolveWooCommerceTemplateFile(
        themeSourceDirs,
        pluginDir,
        relatedTemplate,
      );
      if (!relatedSource) continue;

      segments.push(
        `<!-- vibepress:source woocommerce related ${relatedTemplate} (${relatedSource.sourceType}: ${relatedSource.sourcePath}) -->`,
        this.phpParser.toTemplateMarkup(relatedSource.rawSource),
      );
    }

    for (const relatedDirectory of spec.relatedDirectories) {
      const directoryEntries = await this.resolveWooCommerceTemplateDirectory(
        themeSourceDirs,
        pluginDir,
        relatedDirectory,
      );
      for (const entry of directoryEntries) {
        if (entry.sourcePath === mainSource.sourcePath) continue;
        segments.push(
          `<!-- vibepress:source woocommerce directory ${relatedDirectory}/${entry.relativePath} (${entry.sourceType}: ${entry.sourcePath}) -->`,
          this.phpParser.toTemplateMarkup(entry.rawSource),
        );
      }
    }

    return {
      markup: segments.join('\n\n').trim(),
      originDescription: `${mainSource.sourceType}:${mainSource.sourcePath}`,
    };
  }

  private async resolveWooCommerceTemplateFile(
    themeSourceDirs: string[],
    pluginDir: string,
    relativeTemplatePath: string,
  ): Promise<{
    rawSource: string;
    sourcePath: string;
    sourceType: 'theme-override' | 'plugin-template';
  } | null> {
    for (const themeSourceDir of themeSourceDirs) {
      const candidate = join(
        themeSourceDir,
        'woocommerce',
        relativeTemplatePath,
      );
      if (!(await this.pathExists(candidate))) continue;

      return {
        rawSource: await readFile(candidate, 'utf-8'),
        sourcePath: candidate,
        sourceType: 'theme-override',
      };
    }

    const pluginTemplatePath = join(
      pluginDir,
      'templates',
      relativeTemplatePath,
    );
    if (!(await this.pathExists(pluginTemplatePath))) return null;

    return {
      rawSource: await readFile(pluginTemplatePath, 'utf-8'),
      sourcePath: pluginTemplatePath,
      sourceType: 'plugin-template',
    };
  }

  private async resolveWooCommerceTemplateDirectory(
    themeSourceDirs: string[],
    pluginDir: string,
    relativeDirectory: string,
  ): Promise<
    Array<{
      relativePath: string;
      rawSource: string;
      sourcePath: string;
      sourceType: 'theme-override' | 'plugin-template';
    }>
  > {
    const selected = new Map<
      string,
      {
        relativePath: string;
        rawSource: string;
        sourcePath: string;
        sourceType: 'theme-override' | 'plugin-template';
      }
    >();

    for (const themeSourceDir of themeSourceDirs) {
      const overrideDir = join(
        themeSourceDir,
        'woocommerce',
        relativeDirectory,
      );
      for (const file of await this.walkPhpFiles(overrideDir)) {
        if (selected.has(file.relativePath)) continue;
        selected.set(file.relativePath, {
          relativePath: file.relativePath,
          rawSource: file.rawSource,
          sourcePath: file.sourcePath,
          sourceType: 'theme-override',
        });
      }
    }

    const pluginTemplatesDir = join(pluginDir, 'templates', relativeDirectory);
    for (const file of await this.walkPhpFiles(pluginTemplatesDir)) {
      if (selected.has(file.relativePath)) continue;
      selected.set(file.relativePath, {
        relativePath: file.relativePath,
        rawSource: file.rawSource,
        sourcePath: file.sourcePath,
        sourceType: 'plugin-template',
      });
      if (selected.size >= WOO_SUPPORT_DIR_FILE_LIMIT) break;
    }

    return [...selected.values()]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .slice(0, WOO_SUPPORT_DIR_FILE_LIMIT);
  }

  private async walkPhpFiles(
    dir: string,
    baseDir: string = dir,
  ): Promise<
    Array<{ relativePath: string; sourcePath: string; rawSource: string }>
  > {
    if (!(await this.pathExists(dir))) return [];

    const entries = await readdir(dir, { withFileTypes: true });
    const results: Array<{
      relativePath: string;
      sourcePath: string;
      rawSource: string;
    }> = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkPhpFiles(fullPath, baseDir)));
        continue;
      }
      if (!entry.name.toLowerCase().endsWith('.php')) continue;

      const relativePath = fullPath
        .slice(baseDir.length)
        .replace(/^[/\\]/, '')
        .replace(/\\/g, '/');

      results.push({
        relativePath,
        sourcePath: fullPath,
        rawSource: await readFile(fullPath, 'utf-8'),
      });
    }

    return results;
  }

  private themeHasTemplate(
    theme: PhpParseResult | BlockParseResult,
    candidateNames: string[],
  ): boolean {
    const normalizedCandidates = new Set(
      candidateNames.map((name) => this.normalizeTemplateName(name)),
    );
    const themeTemplates =
      theme.type === 'classic'
        ? theme.templates
        : [...theme.templates, ...theme.parts];

    return themeTemplates.some((template) =>
      normalizedCandidates.has(this.normalizeTemplateName(template.name)),
    );
  }

  private normalizeTemplateName(value: string): string {
    return value
      .trim()
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
  }

  private normalizeSourceSlug(value: string): string {
    return value.trim().toLowerCase();
  }

  private async resolveRepoRelativeDir(
    themeDir: string,
    relativeDir: string | undefined,
  ): Promise<string | undefined> {
    if (!relativeDir) return undefined;

    let current = resolve(themeDir);
    for (let depth = 0; depth < 7; depth++) {
      const candidate = join(current, relativeDir);
      if (await this.pathExists(candidate)) {
        return candidate;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return undefined;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async cloneThemeRepo(
    repoUrl: string,
    token: string | undefined,
    jobId: string,
  ): Promise<string> {
    const destDir = join('./temp/repos', jobId);
    await mkdir(destDir, { recursive: true });

    const cloneUrl = token
      ? repoUrl.replace('https://', `https://${token}@`)
      : repoUrl;

    this.logger.log(`Cloning theme repo: ${repoUrl} → ${destDir}`);
    await simpleGit().clone(cloneUrl, destDir, ['--depth', '1']);
    return destDir;
  }

  private toWpDbCredentials(connectionString: string): WpDbCredentials {
    const creds = parseDbConnectionString(connectionString);
    return {
      host: creds.host,
      port: creds.port,
      dbName: creds.database,
      user: creds.user,
      password: creds.password,
    };
  }

  private async runStep<T>(
    state: PipelineStatus,
    name: string,
    logPath: string,
    fn: () => Promise<T | AgentResult<T>>,
  ): Promise<T> {
    const step = state.steps.find((s) => s.name === name)!;
    if (step.status === 'skipped') return undefined as T;

    const meta = this.getStepMeta(name);
    const subject = this.progress.get(state.jobId);

    step.status = 'running';
    subject?.next({
      step: name,
      label: meta.label,
      status: 'running',
      percent: this.calcPercentBefore(name),
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
      subject?.next({
        step: name,
        label: meta.label,
        status: 'done',
        percent: this.calcPercentThrough(name),
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
        percent: this.calcPercentBefore(name),
        message: `${meta.label} failed: ${err.message}`,
      });
      await this.logToFile(
        logPath,
        `Step ${name} ERROR (${elapsed}s): ${err.message}`,
      );
      throw err;
    }
  }

  private async recordRepoAnalysis(
    jobLogDir: string,
    logPath: string,
    repoResult: RepoAnalyzeResult,
  ): Promise<void> {
    await writeFile(
      join(jobLogDir, 'repo-manifest.json'),
      JSON.stringify(repoResult.themeManifest, null, 2),
      'utf-8',
    );

    for (const line of this.buildRepoAnalysisSummaryLines(repoResult)) {
      this.logger.log(`[RepoAnalyzer] ${line}`);
      await this.logToFile(logPath, `[RepoAnalyzer] ${line}`);
    }
  }

  private buildRepoAnalysisSummaryLines(
    repoResult: RepoAnalyzeResult,
  ): string[] {
    const manifest = repoResult.themeManifest;
    const notableBlocks = [
      ...(manifest.structureHints.containsNavigation ? ['navigation'] : []),
      ...(manifest.structureHints.containsSearch ? ['search'] : []),
      ...(manifest.structureHints.containsComments ? ['comments'] : []),
      ...(manifest.structureHints.containsQueryLoop ? ['query-loop'] : []),
      ...(manifest.structureHints.containsWooCommerceBlocks
        ? ['woocommerce']
        : []),
    ];
    const assetCount =
      manifest.assetManifest.images.length +
      manifest.assetManifest.fonts.length +
      manifest.assetManifest.svg.length +
      manifest.assetManifest.video.length;

    return [
      `kind=${manifest.themeTypeHints.detectedThemeKind}, themeFiles=${repoResult.totalFiles}, themeInventoryFiles=${repoResult.themeInventoryFiles}, themes=${repoResult.themeCount}, pluginFiles=${repoResult.pluginFiles}, plugins=${repoResult.pluginCount}, templates=${manifest.filesByRole.templates.length}, parts=${manifest.filesByRole.templateParts.length}, patterns=${manifest.filesByRole.patterns.length}, phpTemplates=${manifest.filesByRole.phpTemplates.length}, css=${manifest.filesByRole.styles.length}, assets=${assetCount}`,
      `theme.json: palette=${manifest.themeJsonSummary.paletteCount}, fontFamilies=${manifest.themeJsonSummary.fontFamilyCount}, fontSizes=${manifest.themeJsonSummary.fontSizeCount}, spacing=${manifest.themeJsonSummary.spacingSizeCount}, customTemplates=${manifest.themeJsonSummary.customTemplateCount}`,
      `runtime: menus=${manifest.runtimeHints.registeredMenus.length}, sidebars=${manifest.runtimeHints.registeredSidebars.length}, supports=${manifest.runtimeHints.themeSupports.join(', ') || 'none'}, woo=${manifest.runtimeHints.hasWooCommerceSupport || manifest.themeTypeHints.hasWooCommerceTemplates ? 'yes' : 'no'}`,
      `structure: partRefs=${manifest.structureHints.templatePartRefs.length}, patternRefs=${manifest.structureHints.patternRefs.length}, notableBlocks=${notableBlocks.join(', ') || 'none'}, priorityDirs=${manifest.sourceOfTruth.priorityDirectories.join(', ') || 'root-only'}, themeDirs=${manifest.sourceOfTruth.themeDirectories.join(', ') || 'none'}, pluginDirs=${manifest.sourceOfTruth.pluginDirectories.join(', ') || 'none'}`,
      ...(manifest.resolvedSource
        ? [
            `resolved: activeTheme=${manifest.resolvedSource.activeTheme.slug}${manifest.resolvedSource.parentTheme ? `, parentTheme=${manifest.resolvedSource.parentTheme.slug}` : ''}, activePlugins=${manifest.resolvedSource.activePlugins.length}, runtimeOnlyPlugins=${manifest.resolvedSource.runtimeOnlyPlugins.length}, repoOnlyPlugins=${manifest.resolvedSource.repoOnlyPlugins.length}`,
          ]
        : []),
    ];
  }

  private validateDto(dto: RunPipelineDto): void {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new BadRequestException(
        'RunPipelineDto must be an object with themeGithubUrl and dbConnectionString',
      );
    }

    const allowedKeys = new Set(['themeGithubUrl', 'dbConnectionString']);
    const extraKeys = Object.keys(dto).filter((key) => !allowedKeys.has(key));
    if (extraKeys.length > 0) {
      throw new BadRequestException(
        `Only themeGithubUrl and dbConnectionString are allowed. Extra fields: ${extraKeys.join(', ')}`,
      );
    }

    if (
      typeof dto.themeGithubUrl !== 'string' ||
      dto.themeGithubUrl.trim().length === 0
    ) {
      throw new BadRequestException('themeGithubUrl is required');
    }

    if (
      typeof dto.dbConnectionString !== 'string' ||
      dto.dbConnectionString.trim().length === 0
    ) {
      throw new BadRequestException('dbConnectionString is required');
    }
  }

  /**
   * Parse TypeScript build error output and extract per-component errors.
   * Matches lines like:
   *   src/pages/Page.tsx(132,99): error TS2552: Cannot find name 'post'. Did you mean 'posts'?
   *   src/components/Sidebar.tsx(68,125): error TS1003: Identifier expected.
   */
  private parseTsBuildErrors(
    errorOutput: string,
  ): Array<{ componentName: string; error: string }> {
    const pattern =
      /src\/(?:pages|components|layouts|partials)\/(\w+)\.tsx\(\d+,\d+\): error (TS\d+:[^\n]+)/g;
    const errMap = new Map<string, string[]>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(errorOutput)) !== null) {
      const [, componentName, error] = match;
      if (!errMap.has(componentName)) errMap.set(componentName, []);
      errMap.get(componentName)!.push(error.trim());
    }
    return Array.from(errMap.entries()).map(([componentName, errors]) => ({
      componentName,
      error: errors.join('\n'),
    }));
  }
}
