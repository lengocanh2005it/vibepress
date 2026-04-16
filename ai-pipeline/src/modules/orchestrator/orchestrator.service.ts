import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { AgentResult } from '@/common/types/pipeline.type.js';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { lastValueFrom, ReplaySubject } from 'rxjs';
import simpleGit from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import { parseDbConnectionString } from '../../common/utils/db-connection-parser.js';
import {
  TokenTracker,
  type TokenUsagePhaseSummary,
} from '../../common/utils/token-tracker.js';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { GeneratedApiReviewService } from '../agents/api-builder/generated-api-review.service.js';
import type { BlockParseResult } from '../agents/block-parser/block-parser.service.js';
import { BlockParserService } from '../agents/block-parser/block-parser.service.js';
import { CleanupService } from '../agents/cleanup/cleanup.service.js';
import {
  DbContentService,
  type DbContentResult,
} from '../agents/db-content/db-content.service.js';
import { DbTemplateOverlayService } from '../agents/db-template-overlay.service.js';
import { NormalizerService } from '../agents/normalizer/normalizer.service.js';
import type { PhpParseResult } from '../agents/php-parser/php-parser.service.js';
import { PhpParserService } from '../agents/php-parser/php-parser.service.js';
import { PlanReviewerService } from '../agents/plan-reviewer/plan-reviewer.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import { PlannerService } from '../agents/planner/planner.service.js';
import type { PreviewBuilderResult } from '../agents/preview-builder/preview-builder.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { GeneratedCodeReviewService } from '../agents/react-generator/generated-code-review.service.js';
import type { ReactGenerateResult } from '../agents/react-generator/react-generator.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { SectionEditService } from '../agents/react-generator/section-edit.service.js';
import type {
  RepoAnalyzeResult,
  RepoResolvedSourceSummary,
  RepoThemeManifest,
} from '../agents/repo-analyzer/repo-analyzer.service.js';
import { RepoAnalyzerService } from '../agents/repo-analyzer/repo-analyzer.service.js';
import { SourceResolverService } from '../agents/source-resolver/source-resolver.service.js';
import { GenerationContractAuditService } from '../agents/validator/generation-contract-audit.service.js';
import { ValidatorService } from '../agents/validator/validator.service.js';
import { AiLoggerService } from '../ai-logger/ai-logger.service.js';
import { CaptureReviewService } from '../edit-request/capture-review.service.js';
import { EditRequestPhaseService } from '../edit-request/edit-request-phase.service.js';
import type { ResolvedEditRequestContext } from '../edit-request/edit-request.types.js';
import type { ResolvedCaptureTargetRecord } from '../edit-request/ui-source-map.types.js';
import {
  buildUiMutationCandidatesForGeneratedComponents,
  buildUiSourceMapForGeneratedComponents,
  readUiSourceMapEntries,
  resolveCaptureTargetsFromUiSourceMap,
} from '../edit-request/ui-source-map.util.js';
import { PipelineSignalRegistry } from '../../common/llm/pipeline-signal.registry.js';
import { SqlService } from '../sql/sql.service.js';
import {
  type WpTemplateDebugEntity,
  WpQueryService,
} from '../sql/wp-query.service.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import type {
  PipelineCaptureAttachmentDto,
  RunPipelineDto,
  SubmitReactVisualEditDto,
} from './orchestrator.dto.js';

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
  apiBaseUrl?: string;
  previewStage?: 'baseline' | 'edited' | 'final';
  hasEditRequest?: boolean;
  stepDetails?: ProgressStepDetails;
  metrics?: {
    urlA?: string;
    urlB?: string;
    diffPercentage?: number;
    differentPixels?: number;
    totalPixels?: number;
    summary?: {
      overall?: {
        visualAvgAccuracy?: number;
        visualPassRate?: number;
        contentAvgOverall?: number;
        diffPercentage?: number;
        differentPixels?: number;
        totalPixels?: number;
      };
    };
    artifacts?: {
      imageA?: string;
      imageB?: string;
      diff?: string;
    };
    [key: string]: unknown;
  };
}

interface ProgressStepCapturePreview {
  id: string;
  note?: string;
  imageUrl?: string;
  sourcePageUrl?: string;
  pageRoute?: string | null;
  pageTitle?: string;
  capturedAt?: string;
  selector?: string;
  nearestHeading?: string;
  tagName?: string;
}

interface ProgressStepDetails {
  kind: 'edit-request';
  title: string;
  summary?: string;
  prompt?: string;
  language?: string;
  targetRoute?: string | null;
  targetPageTitle?: string;
  captureCount: number;
  captures: ProgressStepCapturePreview[];
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
  '8b_edit_request': {
    label: 'Apply User Edit Request',
    weight: 6,
    activeMessage:
      'Applying the submitted edit request to the generated React output and syncing the changes into the running preview.',
    doneMessage:
      'The requested user edits have been applied to the generated React preview.',
  },
  '9_visual_compare': {
    label: 'Evaluate Final Compare Metrics',
    weight: 2,
    activeMessage:
      'Calling backend automation to compare the WordPress site and the React preview.',
    doneMessage:
      'Final site-compare metrics have been collected from backend automation.',
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

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped'
  | 'stopped';

export interface PipelineStep {
  name: string;
  status: PipelineStepStatus;
  error?: string;
}

export interface PipelineStatus {
  jobId: string;
  status: 'running' | 'stopping' | 'stopped' | 'done' | 'error' | 'deleted';
  steps: PipelineStep[];
  result?: any;
  error?: string;
}

interface JobRuntimeControl {
  stopRequested: boolean;
  deleteRequested: boolean;
  finalized: boolean;
  hasEditRequest?: boolean;
  logPath?: string;
  preview?: PreviewBuilderResult;
  runtimeSummary?: PipelineRuntimeSummaryDraft;
}

interface PipelineRetryCounters {
  plannerReview: number;
  visualPlanReview: number;
  validatorFix: number;
  generatedCodeFix: number;
  backendFix: number;
  buildFix: number;
}

interface PipelineRuntimeSummaryDraft {
  startedAt: string;
  repoAnalysisSummary: string[];
  stepDurationsMs: Partial<Record<string, number>>;
  retries: PipelineRetryCounters;
}

interface PipelineAccuracySummary {
  percent: number | null;
  diffPercentage: number | null;
  differentPixels: number | null;
  totalPixels: number | null;
}

interface PipelineUiAssessment {
  score: number | null;
  verdict: string;
  basis: string[];
}

interface PipelineRunSummaryFile {
  jobId: string;
  status: 'success' | 'failed' | 'stopped' | 'deleted';
  success: boolean;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  totalDurationSeconds: number;
  failureMessage?: string;
  retries: {
    total: number;
    orchestrator: PipelineRetryCounters;
    aiAgents: {
      total: number;
      planning: number;
      codeGeneration: number;
      sectionGeneration: number;
    };
  };
  timing: {
    planningMs: number | null;
    generationMs: number | null;
    stepDurationsMs: Partial<Record<string, number>>;
  };
  accuracy: PipelineAccuracySummary;
  tokenUsage: ReturnType<TokenTracker['getSummary']>;
  editRequestTokenUsage: TokenUsagePhaseSummary | null;
  uiAssessment: PipelineUiAssessment;
  repoAnalysisSummary: string[];
}

class PipelineControlError extends Error {
  constructor(
    public readonly kind: 'stopped' | 'deleted',
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly tokenTracker = new TokenTracker();
  private readonly jobs = new Map<string, PipelineStatus>();
  private readonly progress = new Map<string, ReplaySubject<ProgressEvent>>();
  private readonly controls = new Map<string, JobRuntimeControl>();
  private readonly stepEventData = new Map<
    string,
    Map<string, ProgressEventData>
  >();

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
    private readonly sectionEdit: SectionEditService,
    private readonly generatedCodeReview: GeneratedCodeReviewService,
    private readonly apiBuilder: ApiBuilderService,
    private readonly generatedApiReview: GeneratedApiReviewService,
    private readonly previewBuilder: PreviewBuilderService,
    private readonly validator: ValidatorService,
    private readonly contractAudit: GenerationContractAuditService,
    private readonly sourceResolver: SourceResolverService,
    private readonly dbTemplateOverlay: DbTemplateOverlayService,
    private readonly cleanup: CleanupService,
    private readonly captureReview: CaptureReviewService,
    private readonly editRequestPhase: EditRequestPhaseService,
    private readonly aiLogger: AiLoggerService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly signalRegistry: PipelineSignalRegistry,
  ) {}

  async run(
    siteId: string,
    editRequestContext?: ResolvedEditRequestContext,
  ): Promise<{ jobId: string }> {
    const response = await lastValueFrom(
      this.httpService.get(
        `${this.configService.get<string>('automation.url', '')}/wp/db-info-by-site?siteId=${siteId}`,
      ),
    );

    const dto: RunPipelineDto = editRequestContext?.request
      ? { ...response.data, editRequest: editRequestContext.request }
      : response.data;

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
        ...(dto.editRequest
          ? [{ name: '8b_edit_request', status: 'pending' as const }]
          : []),
        { name: '9_visual_compare', status: 'pending' },
        // Stage 7: Cleanup + completion
        { name: '10_cleanup', status: 'pending' },
        { name: '11_done', status: 'pending' },
      ],
    };
    this.jobs.set(jobId, state);
    this.progress.set(jobId, this.createProgressStream());
    this.controls.set(jobId, {
      stopRequested: false,
      deleteRequested: false,
      finalized: false,
      hasEditRequest: Boolean(dto.editRequest),
    });
    this.signalRegistry.register(jobId);

    this.executePipelineLegacy(jobId, siteId, dto, state).catch((err) => {
      if (err instanceof PipelineControlError) {
        void this.finalizeControlledTermination(jobId, state, err);
        return;
      }

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

  async submitReactVisualEdit(body: SubmitReactVisualEditDto): Promise<{
    accepted: boolean;
    jobId: string;
    siteId: string;
    logPath: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }

    const result = (state.result ?? {}) as {
      previewDir?: string;
      frontendDir?: string;
      previewUrl?: string;
      apiBaseUrl?: string;
      uiSourceMapPath?: string;
      routeEntries?: Array<{ route: string; componentName: string }>;
    };

    const previewDir =
      body.editRequest.reactSourceTarget.previewDir?.trim() ||
      result.previewDir;
    const frontendDir =
      body.editRequest.reactSourceTarget.frontendDir?.trim() ||
      result.frontendDir ||
      (previewDir ? join(previewDir, 'frontend') : undefined);
    const logDir = previewDir || join('./temp/generated', body.jobId);
    const logPath = join(logDir, 'react-visual-edit-request.json');

    const normalizedDto = {
      ...body,
      editRequest: {
        ...body.editRequest,
        reactSourceTarget: {
          ...body.editRequest.reactSourceTarget,
          previewDir,
          frontendDir,
          previewUrl:
            body.editRequest.reactSourceTarget.previewUrl?.trim() ||
            result.previewUrl,
          apiBaseUrl:
            body.editRequest.reactSourceTarget.apiBaseUrl?.trim() ||
            result.apiBaseUrl,
          uiSourceMapPath:
            body.editRequest.reactSourceTarget.uiSourceMapPath?.trim() ||
            result.uiSourceMapPath,
          routeEntries: body.editRequest.reactSourceTarget.routeEntries?.length
            ? body.editRequest.reactSourceTarget.routeEntries
            : result.routeEntries,
        },
      },
      submittedAt: new Date().toISOString(),
    };

    await mkdir(logDir, { recursive: true });
    await writeFile(logPath, JSON.stringify(normalizedDto, null, 2), 'utf-8');

    this.logger.log(
      `React visual edit request received for job ${body.jobId}: ${logPath}`,
    );
    this.logger.debug(JSON.stringify(normalizedDto));

    return {
      accepted: true,
      jobId: body.jobId,
      siteId: body.siteId,
      logPath,
    };
  }

  async stop(jobId: string): Promise<PipelineStatus> {
    const state = this.jobs.get(jobId);
    if (!state) {
      throw new BadRequestException(`Job "${jobId}" not found`);
    }
    if (
      state.status === 'done' ||
      state.status === 'error' ||
      state.status === 'stopped' ||
      state.status === 'deleted'
    ) {
      return state;
    }

    const control = this.controls.get(jobId);
    if (control) {
      control.stopRequested = true;
      await this.stopPreviewProcesses(control.preview);
    }
    this.signalRegistry.abort(jobId);
    state.status = 'stopping';

    const subject = this.progress.get(jobId);
    subject?.next({
      step: 'system',
      label: 'Pipeline Stop Requested',
      status: 'running',
      percent: 0,
      message:
        'Stop was requested. The pipeline will halt at the next safe checkpoint.',
    });

    return state;
  }

  async delete(jobId: string): Promise<{ jobId: string; deleted: boolean }> {
    const state = this.jobs.get(jobId);
    if (!state) {
      throw new BadRequestException(`Job "${jobId}" not found`);
    }

    const control = this.controls.get(jobId);
    if (control) {
      control.stopRequested = true;
      control.deleteRequested = true;
      await this.stopPreviewProcesses(control.preview);
    }
    this.signalRegistry.abort(jobId);

    if (state.status !== 'running' && state.status !== 'stopping') {
      await this.cleanup.cleanupAll(jobId);
      this.jobs.delete(jobId);
      this.controls.delete(jobId);
      const subject = this.progress.get(jobId);
      subject?.next({
        step: 'system',
        label: 'Pipeline Deleted',
        status: 'done',
        percent: 100,
        message: 'Pipeline state and temporary artifacts were deleted.',
      });
      subject?.complete();
      this.progress.delete(jobId);
      return { jobId, deleted: true };
    }

    state.status = 'stopping';
    const subject = this.progress.get(jobId);
    subject?.next({
      step: 'system',
      label: 'Pipeline Delete Requested',
      status: 'running',
      percent: 0,
      message:
        'Delete was requested. The pipeline will stop, clean up artifacts, and remove its state.',
    });

    return { jobId, deleted: true };
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

  private getStepMeta(name: string, jobId?: string) {
    const baseMeta = STEP_META[name] ?? {
      label: name,
      weight: 1,
      activeMessage: `AI agent is working on ${name}.`,
      doneMessage: `${name} has completed.`,
    };

    const hasEditRequest = jobId
      ? Boolean(this.controls.get(jobId)?.hasEditRequest)
      : false;
    if (!hasEditRequest) return baseMeta;

    if (name === '5_planner') {
      return {
        ...baseMeta,
        label: 'Plan Routes, Data, And Requested Changes',
        activeMessage:
          'Building the component graph, route map, data contracts, and the edit-request-aware visual plan.',
        doneMessage:
          'Planning is complete and the requested change scope has been attached to the migration plan.',
      };
    }

    if (name === '6_generator') {
      return {
        ...baseMeta,
        label: 'Generate React Baseline',
        activeMessage:
          'Generating the baseline React components before the focused edit-request pass is applied in preview.',
        doneMessage:
          'Baseline React components are ready for live preview and focused follow-up edits.',
      };
    }

    if (name === '8_preview_builder') {
      return {
        ...baseMeta,
        label: 'Launch Preview Baseline',
        activeMessage:
          'Starting preview servers so the generated baseline can be inspected before any requested edit pass runs.',
        doneMessage:
          'Preview servers are live and the baseline React app is ready for inspection.',
      };
    }

    if (name === '8b_edit_request') {
      return {
        ...baseMeta,
        label: 'Apply Requested Edits',
        activeMessage:
          'Applying the user edit request to the running preview and validating the updated React output.',
        doneMessage:
          'Requested edits have been applied and synced into the running preview.',
      };
    }

    if (name === '9_visual_compare') {
      return {
        ...baseMeta,
        label: 'Evaluate Edited Preview Metrics',
        activeMessage:
          'Calling backend automation to compare the edited preview against WordPress.',
        doneMessage:
          'Final compare metrics for the edited preview have been collected.',
      };
    }

    if (name === '11_done') {
      return {
        ...baseMeta,
        label: 'Edited Preview Ready',
        activeMessage:
          'Finalizing the edited preview, compare metrics, and completion metadata.',
        doneMessage:
          'Migration workflow is complete and the edited preview is ready.',
      };
    }

    return baseMeta;
  }

  private getStepOrder(jobId?: string): string[] {
    const state = jobId ? this.jobs.get(jobId) : undefined;
    if (state?.steps?.length) {
      return state.steps.map((step) => step.name);
    }
    return Object.keys(STEP_META);
  }

  private getTotalWeight(jobId?: string): number {
    return this.getStepOrder(jobId).reduce(
      (sum, stepName) => sum + (this.getStepMeta(stepName, jobId).weight ?? 0),
      0,
    );
  }

  private calcPercentBefore(name: string, jobId?: string): number {
    const stepOrder = this.getStepOrder(jobId);
    const totalWeight = this.getTotalWeight(jobId);
    let done = 0;
    for (const stepName of stepOrder) {
      if (stepName === name) break;
      done += this.getStepMeta(stepName, jobId).weight ?? 0;
    }
    return totalWeight > 0 ? Math.round((done / totalWeight) * 100) : 0;
  }

  private calcPercentThrough(name: string, jobId?: string): number {
    const stepOrder = this.getStepOrder(jobId);
    const totalWeight = this.getTotalWeight(jobId);
    let done = 0;
    for (const stepName of stepOrder) {
      done += this.getStepMeta(stepName, jobId).weight ?? 0;
      if (stepName === name) break;
    }
    return totalWeight > 0 ? Math.round((done / totalWeight) * 100) : 0;
  }

  private emitStepProgress(
    state: PipelineStatus,
    name: string,
    progressWithinStep: number,
    message: string,
    data?: ProgressEventData,
  ): void {
    this.assertJobActive(state.jobId);
    this.rememberStepEventData(state.jobId, name, data);

    const meta = this.getStepMeta(name, state.jobId);
    const subject = this.progress.get(state.jobId);
    const bounded = Math.min(Math.max(progressWithinStep, 0), 0.99);
    const stepOrder = this.getStepOrder(state.jobId);
    const totalWeight = this.getTotalWeight(state.jobId);
    const beforeWeight = stepOrder
      .slice(0, Math.max(stepOrder.indexOf(name), 0))
      .reduce(
        (sum, stepName) =>
          sum + (this.getStepMeta(stepName, state.jobId).weight ?? 0),
        0,
      );
    const percent = Math.round(
      totalWeight > 0
        ? ((beforeWeight + meta.weight * bounded) / totalWeight) * 100
        : 0,
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

  private assertJobActive(jobId: string): void {
    const control = this.controls.get(jobId);
    if (!control) return;
    if (control.deleteRequested) {
      throw new PipelineControlError(
        'deleted',
        'Pipeline was deleted by the user',
      );
    }
    if (control.stopRequested) {
      throw new PipelineControlError(
        'stopped',
        'Pipeline was stopped by the user',
      );
    }
  }

  private rememberStepEventData(
    jobId: string,
    stepName: string,
    data?: ProgressEventData,
  ): void {
    if (!data) return;
    const existing =
      this.stepEventData.get(jobId) ?? new Map<string, ProgressEventData>();
    const previous = existing.get(stepName);
    existing.set(stepName, previous ? { ...previous, ...data } : data);
    this.stepEventData.set(jobId, existing);
  }

  private getStepEventData(
    jobId: string,
    stepName: string,
  ): ProgressEventData | undefined {
    return this.stepEventData.get(jobId)?.get(stepName);
  }

  private clearStepEventData(jobId: string): void {
    this.stepEventData.delete(jobId);
  }

  private async delayWithControl(jobId: string, ms: number): Promise<void> {
    const intervalMs = 100;
    let remaining = ms;
    while (remaining > 0) {
      this.assertJobActive(jobId);
      const slice = Math.min(intervalMs, remaining);
      await new Promise((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
  }

  private async stopPreviewProcesses(
    preview?: Pick<PreviewBuilderResult, 'frontendPid' | 'serverPid'>,
  ): Promise<void> {
    if (!preview) return;
    await Promise.all([
      this.cleanup.terminateProcessTree(preview.frontendPid),
      this.cleanup.terminateProcessTree(preview.serverPid),
    ]);
  }

  private async finalizeControlledTermination(
    jobId: string,
    state: PipelineStatus,
    err: PipelineControlError,
  ): Promise<void> {
    const control = this.controls.get(jobId);
    if (control?.finalized) return;
    if (control) control.finalized = true;
    this.signalRegistry.unregister(jobId);

    await this.stopPreviewProcesses(control?.preview);

    const subject = this.progress.get(jobId);
    if (err.kind === 'deleted') {
      state.status = 'deleted';
      state.error = err.message;
      subject?.next({
        step: 'system',
        label: 'Pipeline Deleted',
        status: 'done',
        percent: 100,
        message:
          'Pipeline execution was deleted. Temporary artifacts are being removed.',
      });
      await this.cleanup.cleanupAll(jobId);
      subject?.complete();
      this.jobs.delete(jobId);
      this.controls.delete(jobId);
      this.progress.delete(jobId);
      this.clearStepEventData(jobId);
      return;
    }

    state.status = 'stopped';
    state.error = err.message;
    for (const step of state.steps) {
      if (step.status === 'running') {
        step.status = 'stopped';
        step.error = err.message;
      }
    }
    subject?.next({
      step: 'system',
      label: 'Pipeline Stopped',
      status: 'done',
      percent: 100,
      message: 'Pipeline execution was stopped by the user.',
    });
    subject?.complete();
    this.clearStepEventData(jobId);
  }

  private async logToFile(logPath: string, message: string): Promise<void> {
    void message;
    if (!logPath || logPath.endsWith('.json')) return;
  }

  private async executePipelineLegacy(
    jobId: string,
    siteId: string,
    dto: RunPipelineDto,
    state: PipelineStatus,
  ): Promise<void> {
    // ── Init structured run summary ───────────────────────────────────────
    const jobLogDir = join('./temp/logs', jobId);
    await mkdir(jobLogDir, { recursive: true });
    const logPath = join(jobLogDir, 'run-summary.json');
    const pipelineStart = Date.now();
    const summaryDraft: PipelineRuntimeSummaryDraft = {
      startedAt: new Date().toISOString(),
      repoAnalysisSummary: [],
      stepDurationsMs: {},
      retries: {
        plannerReview: 0,
        visualPlanReview: 0,
        validatorFix: 0,
        generatedCodeFix: 0,
        backendFix: 0,
        buildFix: 0,
      },
    };
    const control = this.controls.get(jobId);
    if (control) {
      control.logPath = logPath;
      control.runtimeSummary = summaryDraft;
    }
    await this.tokenTracker.init(logPath);
    let metrics: any = null;
    let visualRouteResults: any[] = [];
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
        planning: cfgPlanning ?? 'openai/gpt-5.4',
        genCode: cfgGenCode ?? 'openai/gpt-5.3-codex',
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
      const planningEditRequest = this.editRequestPhase.buildPlanningRequest(
        dto.editRequest,
      );

      const hasEditRequest = Boolean(dto.editRequest);
      const dbCreds = this.toWpDbCredentials(dbConnectionString);

      await this.sqlService.verifyDirectCredentials(dbConnectionString);

      const themeGithubToken = this.configService.get<string>(
        'github.wpRepoToken',
        '',
      );

      // Helper to add delay between steps for better log visibility
      const stepDelay = () => this.delayWithControl(jobId, 500);

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
          summaryDraft.repoAnalysisSummary = await this.recordRepoAnalysis(
            jobLogDir,
            logPath,
            repoAnalysis,
          );
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
      summaryDraft.repoAnalysisSummary = await this.recordRepoAnalysis(
        jobLogDir,
        logPath,
        repoResult,
      );
      const enrichResult = await this.enrichThemeWithPluginTemplates({
        theme: normalizedTheme,
        themeDir,
        manifest: repoResult.themeManifest,
        resolvedSource,
        logPath,
      });
      normalizedTheme = enrichResult.theme;
      await this.dumpFseTemplateSourceDebug({
        connectionString: dbConnectionString,
        jobLogDir,
        label: 'pre-overlay',
        theme: normalizedTheme,
        content,
      });
      const overlaidTheme = this.dbTemplateOverlay.apply(
        normalizedTheme,
        content,
      );
      if (overlaidTheme !== normalizedTheme) {
        normalizedTheme = await this.normalizer.normalize(overlaidTheme);
        await this.dumpFseTemplateSourceDebug({
          connectionString: dbConnectionString,
          jobLogDir,
          label: 'post-overlay',
          theme: normalizedTheme,
          content,
        });
        await this.logToFile(
          logPath,
          `[Stage 2] Applied DB template overlay from wp_template/wp_template_part before planner.`,
        );
      }

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
              editRequest: planningEditRequest,
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
            summaryDraft.retries.plannerReview += 1;
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
                editRequest: planningEditRequest,
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
            planningEditRequest,
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
            summaryDraft.retries.visualPlanReview += 1;
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
              planningEditRequest,
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
            this.buildEditRequestProgressData({
              request: dto.editRequest,
              title: 'Requested changes attached to the migration plan',
              summary:
                'The planner has locked the route map and also attached the user edit request so downstream generation and preview-edit steps can act on it.',
            }),
          );
          await this.writePlanArtifact(jobId, review.plan);
          return review;
        },
      );
      await stepDelay();

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
          const MAX_VALIDATION_FIX_ATTEMPTS = 2;
          let validation = this.validator.collectValidationIssues(
            result.components,
          );
          let components = validation.components;

          for (
            let attempt = 1;
            validation.failures.length > 0 &&
            attempt <= MAX_VALIDATION_FIX_ATTEMPTS;
            attempt++
          ) {
            summaryDraft.retries.validatorFix += 1;
            this.logger.warn(
              `[Stage 4: D4 Validator] ${validation.failures.length} component(s) failed validation. Attempting auto-fix (attempt ${attempt}/${MAX_VALIDATION_FIX_ATTEMPTS}).`,
            );
            this.emitStepProgress(
              state,
              '6_generator',
              0.55,
              `Validator fix ${attempt}/${MAX_VALIDATION_FIX_ATTEMPTS}: repairing ${validation.failures.length} component contract issue(s).`,
            );
            await this.logToFile(
              logPath,
              `[Stage 4: D4 Validator] ${validation.failures.length} component(s) failed validation. Attempting auto-fix (attempt ${attempt}/${MAX_VALIDATION_FIX_ATTEMPTS})`,
            );

            const fixResults = await Promise.all(
              validation.failures.map(async (failure) => {
                const compIndex = components.findIndex(
                  (c) => c.name === failure.component.name,
                );
                if (compIndex === -1) return null;
                const fixed = await this.reactGenerator.fixComponent({
                  component: components[compIndex],
                  plan: reviewResult.plan,
                  feedback: `Validator contract error for component "${failure.component.name}":\n${failure.error}\n\nReturn a complete corrected TSX component that satisfies the validator rules.`,
                  modelConfig: { fixAgent: resolvedModels.fixAgent },
                  logPath,
                  jobId,
                });
                const revalidated = this.validator.collectValidationIssues([
                  fixed,
                ]);
                if (revalidated.failures.length > 0) {
                  const retryError = revalidated.failures[0]?.error;
                  this.logger.warn(
                    `[Stage 4: D4 Validator] Re-validation failed for "${failure.component.name}" after fix. Error: ${retryError}`,
                  );
                  await this.logToFile(
                    logPath,
                    `[Stage 4: D4 Validator] Re-validation failed for "${failure.component.name}" after fix: ${retryError}`,
                  );
                  return null;
                }

                return {
                  compIndex,
                  component: revalidated.components[0],
                };
              }),
            );

            for (const fixResult of fixResults) {
              if (fixResult)
                components[fixResult.compIndex] = fixResult.component;
            }

            validation = this.validator.collectValidationIssues(components);
            components = validation.components;
          }

          if (validation.failures.length > 0) {
            throw new Error(
              `[validator] Generated component validation failed after auto-fix:\n${validation.failures
                .map(
                  (failure) =>
                    `Component "${failure.component.name}": ${failure.error}`,
                )
                .join('\n')}`,
            );
          }

          const aiComponents = [...components];

          const MAX_FIX_ATTEMPTS = 2;
          for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
            this.emitStepProgress(
              state,
              '6_generator',
              0.82,
              `AI review pass ${attempt}/${MAX_FIX_ATTEMPTS}: checking the generated baseline components against the approved contract.`,
            );
            this.logger.log(
              `[Stage 5: AI Generated Code Review] Reviewing ${aiComponents.length} baseline generated component(s) (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
            );
            const review = await this.generatedCodeReview.review({
              components: aiComponents,
              plan: reviewResult.plan,
              modelName: resolvedModels.reviewCode,
              mode: resolvedModels.aiReviewMode,
              logPath,
              jobId,
            });

            if (review.success || review.failures.length === 0) {
              break;
            }

            this.logger.warn(
              `[Stage 5: AI Generated Code Review] ${review.failures.length} components failed review. Attempting auto-fix.`,
            );
            summaryDraft.retries.generatedCodeFix += 1;
            this.emitStepProgress(
              state,
              '6_generator',
              0.9,
              `Auto-fixing ${review.failures.length} component(s) that failed AI review.`,
            );
            await this.logToFile(
              logPath,
              `[Stage 5] ${review.failures.length} components failed review. Attempting auto-fix loop (attempt ${attempt}/${MAX_FIX_ATTEMPTS})`,
            );

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
                  jobId,
                });
                const revalidated = this.validator.collectValidationIssues([
                  fixed,
                ]);
                if (revalidated.failures.length > 0) {
                  const validationErr = revalidated.failures[0]?.error;
                  this.logger.warn(
                    `[Stage 5: Fix Loop] Re-validation failed for "${failure.componentName}" after fix — keeping original. Error: ${validationErr}`,
                  );
                  await this.logToFile(
                    logPath,
                    `[Stage 5] Re-validation failed for "${failure.componentName}": ${validationErr}`,
                  );
                  return null;
                }
                return { compIndex, component: revalidated.components[0] };
              }),
            );
            for (const r of fixResults) {
              if (r) aiComponents[r.compIndex] = r.component;
            }
          }

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
            jobId,
          });

          if (review.success || !review.blockingMessage) {
            break;
          }

          this.logger.warn(
            `[Stage 6: AI Generated Backend Review] Backend failed review: ${review.blockingMessage}. Attempting auto-fix.`,
          );
          summaryDraft.retries.backendFix += 1;
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
            jobId,
          });
        }

        this.emitStepProgress(
          state,
          '7_api_builder',
          0.93,
          'Preview API layer is ready for the runtime preview environment.',
        );

        const auditWarnings = this.contractAudit.audit({
          components: generationResult.components,
          plan: reviewResult.plan,
          api,
        });
        this.contractAudit.logWarnings(
          auditWarnings,
          'Stage 7: Deterministic Contract Audit',
        );
        if (auditWarnings.length > 0) {
          await this.logToFile(
            logPath,
            `[Stage 7: Deterministic Contract Audit] ${auditWarnings.length} warning(s)\n${auditWarnings
              .map((warning) => {
                const target = warning.componentName
                  ? `"${warning.componentName}" `
                  : '';
                return `- [${warning.scope}] ${target}${warning.message}`;
              })
              .join('\n')}`,
          );
        }
        return api;
      });
      await stepDelay();

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
                content: {
                  posts: content.posts,
                  pages: content.pages,
                  dbGlobalStyles: content.dbGlobalStyles,
                  customCssEntries: content.customCssEntries,
                },
                themeDir,
                siteInfo: content.siteInfo,
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
              summaryDraft.retries.buildFix += 1;

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
                    jobId,
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
      const runtimeControl = this.controls.get(jobId);
      if (runtimeControl) {
        runtimeControl.preview = preview;
      }
      state.result = {
        ...(state.result ?? {}),
        previewDir: preview.previewDir,
        frontendDir: preview.frontendDir,
        previewUrl: preview.previewUrl,
        apiBaseUrl: preview.apiBaseUrl,
        previewStage: 'baseline',
        hasEditRequest,
        uiSourceMapPath: preview.uiSourceMapPath,
        routeEntries: preview.routeEntries,
      };
      {
        const subject = this.progress.get(jobId);
        const meta = this.getStepMeta('8_preview_builder', jobId);
        subject?.next({
          step: '8_preview_builder',
          label: meta.label,
          status: 'done',
          percent: this.calcPercentThrough('8_preview_builder', jobId),
          message: hasEditRequest
            ? 'Baseline preview is live. The pipeline will now run a dedicated requested-edit pass.'
            : 'Preview is live and ready for inspection.',
          data: this.buildPreviewEventData({
            preview,
            previewStage: 'baseline',
            hasEditRequest,
          }),
        });
      }
      if (hasEditRequest) {
        await this.runStep(state, '8b_edit_request', logPath, async () => {
          this.emitStepProgress(
            state,
            '8b_edit_request',
            0.12,
            'Reviewing the submitted edit request against the generated React baseline.',
            this.buildEditRequestProgressData({
              request: dto.editRequest,
              title: 'Reviewing the submitted user edit request',
              summary:
                'The baseline preview is live. This step is now applying the requested visual changes using the submitted prompt and captures.',
            }),
          );
          const editPassResult = await this.applyPostMigrationEditPass({
            jobId,
            state,
            stepName: '8b_edit_request',
            request: dto.editRequest,
            plan: reviewResult.plan,
            components: buildComponents,
            fixAgentModel: resolvedModels.fixAgent,
            logPath,
            applyProgress: 0.38,
            reviewProgress: 0.58,
            refixProgress: 0.72,
          });
          buildComponents = editPassResult.components;

          if (!editPassResult.applied) {
            this.emitStepProgress(
              state,
              '8b_edit_request',
              0.92,
              'No targeted edit mutations were required after reviewing the submitted edit request.',
            );
            return { applied: false, taskCount: 0 };
          }

          this.emitStepProgress(
            state,
            '8b_edit_request',
            0.82,
            `Syncing ${editPassResult.taskCount} requested edit update(s) into the running preview.`,
          );
          await this.previewBuilder.syncGeneratedComponents(
            preview.previewDir,
            {
              components: buildComponents,
              requiredFrontendPackages:
                generationResult.requiredFrontendPackages,
            },
            'tokens' in normalizedTheme
              ? (normalizedTheme as any).tokens
              : undefined,
          );
          await this.validator.assertPreviewBuild(preview.frontendDir);
          await this.validator.assertPreviewRuntime(
            preview.previewUrl,
            preview.routeEntries.map((entry) => entry.route),
          );
          this.emitStepProgress(
            state,
            '8b_edit_request',
            0.94,
            'Requested edits are now visible in the running preview.',
            {
              ...this.buildPreviewEventData({
                preview,
                previewStage: 'edited',
                hasEditRequest,
              }),
              ...(this.buildEditRequestProgressData({
                request: dto.editRequest,
                title: 'Requested edits are now visible in preview',
                summary:
                  'The submitted edit request has been applied and synced into the live React preview.',
              }) ?? {}),
            },
          );
          state.result = {
            ...(state.result ?? {}),
            previewDir: preview.previewDir,
            frontendDir: preview.frontendDir,
            previewUrl: preview.previewUrl,
            apiBaseUrl: preview.apiBaseUrl,
            previewStage: 'edited',
            hasEditRequest,
            uiSourceMapPath: preview.uiSourceMapPath,
            routeEntries: preview.routeEntries,
          };
          return { applied: true, taskCount: editPassResult.taskCount };
        });
      }
      await stepDelay();

      await this.runStep(state, '9_visual_compare', logPath, async () => {
        const wpBaseUrl = content.siteInfo.siteUrl || 'http://localhost:8000/';
        const reactBeUrl = preview.apiBaseUrl.replace(/\/api\/?$/, '');

        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.2,
          'Calling backend automation for final site compare metrics.',
        );

        try {
          const response = await lastValueFrom(
            this.httpService.post(
              `${this.configService.get<string>('automation.url', '')}/site/compare`,
              {
                siteId,
                wpSiteId: siteId,
                wpBaseUrl,
                reactFeUrl: preview.previewUrl,
                reactBeUrl,
              },
            ),
          );
          metrics = response.data?.result ?? response.data;
        } catch (err: any) {
          this.logger.error(
            `[site-compare] failed — ${err?.message ?? err}`,
            err?.response?.data ?? err?.stack,
          );
        }

        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.9,
          metrics
            ? 'Final site-compare metrics are attached.'
            : 'Backend site compare did not return metrics; pipeline will continue.',
          metrics
            ? this.buildPreviewEventData({
                preview,
                previewStage: hasEditRequest ? 'edited' : 'baseline',
                hasEditRequest,
                metrics,
              })
            : undefined,
        );

        state.result = {
          ...(state.result ?? {}),
          previewDir: preview.previewDir,
          frontendDir: preview.frontendDir,
          previewUrl: preview.previewUrl,
          apiBaseUrl: preview.apiBaseUrl,
          previewStage: hasEditRequest ? 'edited' : 'baseline',
          hasEditRequest,
          uiSourceMapPath: preview.uiSourceMapPath,
          routeEntries: preview.routeEntries,
          metrics,
        };

        return { metrics };
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
        const uiSourceMapEntries = await readUiSourceMapEntries(
          preview.uiSourceMapPath,
        );
        const ownerCaptureTargets = resolveCaptureTargetsFromUiSourceMap({
          attachments: dto.editRequest?.attachments,
          uiSourceMap: uiSourceMapEntries,
        });
        const finalMutationCandidates =
          await buildUiMutationCandidatesForGeneratedComponents({
            components: buildComponents,
          });
        const exactCaptureTargets =
          this.editRequestPhase.resolveIntentAwareCaptureTargets({
            request: dto.editRequest,
            exactCaptureTargets: ownerCaptureTargets,
            mutationCandidates: finalMutationCandidates,
          });
        await this.logExactCaptureResolution({
          jobId,
          logPath,
          attachments: dto.editRequest?.attachments,
          uiSourceMapPath: preview.uiSourceMapPath,
          uiSourceMapEntryCount: uiSourceMapEntries.length,
          exactCaptureTargets: ownerCaptureTargets,
        });
        await this.logExactCaptureResolution({
          jobId,
          logPath,
          attachments: dto.editRequest?.attachments,
          uiSourceMapPath: 'final:intent-aware-mutation-targets',
          uiSourceMapEntryCount: finalMutationCandidates.length,
          exactCaptureTargets,
        });

        state.status = 'done';
        state.result = {
          runSummaryPath: logPath,
          previewDir: preview.previewDir,
          frontendDir: preview.frontendDir,
          previewUrl: preview.previewUrl,
          apiBaseUrl: preview.apiBaseUrl,
          previewStage: 'final',
          hasEditRequest,
          uiSourceMapPath: preview.uiSourceMapPath,
          routeEntries: preview.routeEntries,
          ownerCaptureTargets,
          exactCaptureTargets,
          dbCreds,
          metrics,
        };
        // Emit final event with previewUrl from within runStep
        const subject = this.progress.get(jobId);
        const doneMeta = this.getStepMeta('11_done', jobId);
        subject?.next({
          step: '11_done',
          label: doneMeta.label,
          status: 'done',
          percent: 100,
          message: `${doneMeta.doneMessage} (${totalElapsed}s)`,
          data: this.buildPreviewEventData({
            preview,
            previewStage: 'final',
            hasEditRequest,
            metrics,
          }),
        });
        return {
          success: true,
          previewUrl: preview.previewUrl,
          apiBaseUrl: preview.apiBaseUrl,
          metrics,
        };
      });
      await stepDelay();

      // Complete the SSE stream after runStep finishes
      const subject = this.progress.get(jobId);
      subject?.complete();
      setTimeout(() => this.progress.delete(jobId), 60_000);
      this.clearStepEventData(jobId);
      const finalControl = this.controls.get(jobId);
      if (finalControl) finalControl.finalized = true;
      this.signalRegistry.unregister(jobId);

      this.logger.log(`Pipeline ${jobId} completed in ${totalElapsed}s`);
      await this.logToFile(
        logPath,
        `Pipeline completed — total ${totalElapsed}s`,
      );
    } catch (err: unknown) {
      if (err instanceof PipelineControlError) {
        state.status = err.kind === 'deleted' ? 'deleted' : 'stopped';
        state.error = err.message;
      } else if (err instanceof Error) {
        state.status = 'error';
        state.error = err.message;
      } else {
        state.status = 'error';
        state.error = String(err);
      }
      throw err;
    } finally {
      await this.tokenTracker.writeSummary();
      await this.writeRunSummary(
        logPath,
        state,
        summaryDraft,
        metrics,
        visualRouteResults,
        pipelineStart,
      );
      this.aiLogger.clearJob(jobId);
      this.tokenTracker.clear(logPath);
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
  }> {
    const { theme } = input;
    return { theme };
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
    this.assertJobActive(state.jobId);

    const step = state.steps.find((s) => s.name === name)!;
    if (step.status === 'skipped') return undefined as T;

    const meta = this.getStepMeta(name, state.jobId);
    const subject = this.progress.get(state.jobId);

    step.status = 'running';
    subject?.next({
      step: name,
      label: meta.label,
      status: 'running',
      percent: this.calcPercentBefore(name, state.jobId),
      message: meta.activeMessage,
    });
    this.logger.log(`[${state.jobId}] Step ${name} started`);
    await this.logToFile(logPath, `Step ${name} started`);
    const t0 = Date.now();
    try {
      const result = await fn();
      this.assertJobActive(state.jobId);
      let data: T;

      // Handle AgentResult artifact
      if (
        result &&
        typeof result === 'object' &&
        'reasoning' in result &&
        'data' in result
      ) {
        const artifact = result as AgentResult<T>;
        data = artifact.data;
      } else {
        data = result as T;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      this.recordStepDuration(state.jobId, name, Date.now() - t0);
      step.status = 'done';
      const stepData = this.getStepEventData(state.jobId, name);

      // Calculate percent after this step completes
      subject?.next({
        step: name,
        label: meta.label,
        status: 'done',
        percent: this.calcPercentThrough(name, state.jobId),
        message: `${meta.doneMessage} (${elapsed}s)`,
        data: stepData,
      });

      this.logger.log(`[${state.jobId}] Step ${name} done (${elapsed}s)`);
      await this.logToFile(logPath, `Step ${name} done (${elapsed}s)`);
      return data;
    } catch (err: any) {
      if (err instanceof PipelineControlError) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        this.recordStepDuration(state.jobId, name, Date.now() - t0);
        step.status = 'stopped';
        step.error = err.message;
        await this.logToFile(
          logPath,
          `Step ${name} STOPPED (${elapsed}s): ${err.message}`,
        );
        throw err;
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      this.recordStepDuration(state.jobId, name, Date.now() - t0);
      step.status = 'error';
      step.error = err.message;
      state.status = 'error';
      subject?.next({
        step: name,
        label: meta.label,
        status: 'error',
        percent: this.calcPercentBefore(name, state.jobId),
        message: `${meta.label} failed: ${err.message}`,
        data: this.getStepEventData(state.jobId, name),
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
  ): Promise<string[]> {
    void jobLogDir;
    const lines = this.buildRepoAnalysisSummaryLines(repoResult);
    for (const line of lines) {
      this.logger.log(`[RepoAnalyzer] ${line}`);
      await this.logToFile(logPath, `[RepoAnalyzer] ${line}`);
    }
    return lines;
  }

  private async dumpFseTemplateSourceDebug(input: {
    connectionString: string;
    jobLogDir: string;
    label: string;
    theme: PhpParseResult | BlockParseResult;
    content: DbContentResult;
  }): Promise<void> {
    const { connectionString, jobLogDir, label, theme, content } = input;
    if (theme.type !== 'fse') return;

    const debugDir = join(jobLogDir, 'template-debug');
    await mkdir(debugDir, { recursive: true });

    const homeTemplate = theme.templates.find(
      (template) => template.name.toLowerCase() === 'home',
    );
    if (homeTemplate?.markup) {
      await writeFile(
        join(debugDir, `home.${label}.html`),
        homeTemplate.markup,
        'utf-8',
      );
    }

    const dbEntities = content.dbTemplates.filter((row) =>
      ['home', 'header', 'footer', 'post-meta'].includes(
        String(row.slug).toLowerCase(),
      ),
    );
    if (dbEntities.length > 0) {
      await writeFile(
        join(debugDir, `db-entities.${label}.json`),
        JSON.stringify(
          dbEntities.map((row) => ({
            id: row.id,
            postType: row.postType,
            slug: row.slug,
            status: row.status,
            modified: row.modified,
            contentLength: row.content.length,
            hasSlider: row.content.includes('wp:uagb/slider'),
            hasModal: row.content.includes('wp:uagb/modal'),
            hasAccordion: row.content.includes('wp:accordion'),
            hasFooterPart:
              row.content.includes('"slug":"footer"') ||
              row.content.includes('"slug":"footer","theme"'),
          })),
          null,
          2,
        ),
        'utf-8',
      );

      for (const row of dbEntities) {
        await writeFile(
          join(
            debugDir,
            `${row.postType}.${row.slug}.${row.status}.${label}.html`,
          ),
          row.content,
          'utf-8',
        );
      }
    }

    try {
      const debugCandidates =
        await this.wpQuery.getTemplateDebugEntities(connectionString);
      if (debugCandidates.length > 0) {
        const summarizedCandidates = debugCandidates.map((row) =>
          this.summarizeTemplateDebugEntity(row),
        );
        await writeFile(
          join(debugDir, `db-candidate-entities.${label}.json`),
          JSON.stringify(summarizedCandidates, null, 2),
          'utf-8',
        );

        for (const row of debugCandidates.filter((candidate) =>
          this.shouldDumpTemplateDebugEntityHtml(candidate),
        )) {
          await writeFile(
            join(
              debugDir,
              `${sanitizeDebugFilename(row.postType)}.${sanitizeDebugFilename(row.slug || row.title || `id-${row.id}`)}.${row.id}.${label}.html`,
            ),
            row.content,
            'utf-8',
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `[TemplateDebug] Failed to dump extended DB candidates for ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private summarizeTemplateDebugEntity(row: WpTemplateDebugEntity) {
    return {
      id: row.id,
      parentId: row.parentId,
      postType: row.postType,
      slug: row.slug,
      title: row.title,
      status: row.status,
      modified: row.modified,
      contentLength: row.content.length,
      hasSlider: row.content.includes('wp:uagb/slider'),
      hasModal: row.content.includes('wp:uagb/modal'),
      hasAccordion: row.content.includes('wp:accordion'),
      hasHomeSlug:
        row.slug.toLowerCase().includes('home') ||
        row.title.toLowerCase().includes('home'),
      hasHeaderRef:
        row.content.includes('"slug":"header"') ||
        row.content.includes('"slug":"header","theme"'),
      hasFooterRef:
        row.content.includes('"slug":"footer"') ||
        row.content.includes('"slug":"footer","theme"'),
    };
  }

  private shouldDumpTemplateDebugEntityHtml(
    row: WpTemplateDebugEntity,
  ): boolean {
    return (
      row.content.includes('wp:uagb/slider') ||
      row.content.includes('wp:uagb/modal') ||
      row.content.includes('wp:accordion') ||
      row.slug.toLowerCase().includes('home') ||
      row.title.toLowerCase().includes('home')
    );
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
    ];
    const assetCount =
      manifest.assetManifest.images.length +
      manifest.assetManifest.fonts.length +
      manifest.assetManifest.svg.length +
      manifest.assetManifest.video.length;

    return [
      `kind=${manifest.themeTypeHints.detectedThemeKind}, themeFiles=${repoResult.totalFiles}, themeInventoryFiles=${repoResult.themeInventoryFiles}, themes=${repoResult.themeCount}, pluginFiles=${repoResult.pluginFiles}, plugins=${repoResult.pluginCount}, templates=${manifest.filesByRole.templates.length}, parts=${manifest.filesByRole.templateParts.length}, patterns=${manifest.filesByRole.patterns.length}, phpTemplates=${manifest.filesByRole.phpTemplates.length}, css=${manifest.filesByRole.styles.length}, assets=${assetCount}`,
      `theme.json: palette=${manifest.themeJsonSummary.paletteCount}, fontFamilies=${manifest.themeJsonSummary.fontFamilyCount}, fontSizes=${manifest.themeJsonSummary.fontSizeCount}, spacing=${manifest.themeJsonSummary.spacingSizeCount}, customTemplates=${manifest.themeJsonSummary.customTemplateCount}`,
      `runtime: menus=${manifest.runtimeHints.registeredMenus.length}, sidebars=${manifest.runtimeHints.registeredSidebars.length}, supports=${manifest.runtimeHints.themeSupports.join(', ') || 'none'}`,
      `structure: partRefs=${manifest.structureHints.templatePartRefs.length}, patternRefs=${manifest.structureHints.patternRefs.length}, notableBlocks=${notableBlocks.join(', ') || 'none'}, priorityDirs=${manifest.sourceOfTruth.priorityDirectories.join(', ') || 'root-only'}, themeDirs=${manifest.sourceOfTruth.themeDirectories.join(', ') || 'none'}, pluginDirs=${manifest.sourceOfTruth.pluginDirectories.join(', ') || 'none'}`,
      ...(manifest.resolvedSource
        ? [
            `resolved: activeTheme=${manifest.resolvedSource.activeTheme.slug}${manifest.resolvedSource.parentTheme ? `, parentTheme=${manifest.resolvedSource.parentTheme.slug}` : ''}, activePlugins=${manifest.resolvedSource.activePlugins.length}, runtimeOnlyPlugins=${manifest.resolvedSource.runtimeOnlyPlugins.length}, repoOnlyPlugins=${manifest.resolvedSource.repoOnlyPlugins.length}`,
          ]
        : []),
    ];
  }

  private recordStepDuration(
    jobId: string,
    stepName: string,
    durationMs: number,
  ): void {
    const control = this.controls.get(jobId);
    if (!control?.runtimeSummary) return;
    control.runtimeSummary.stepDurationsMs[stepName] = Math.max(
      0,
      Math.round(durationMs),
    );
  }

  private async writeRunSummary(
    summaryPath: string,
    state: PipelineStatus,
    summaryDraft: PipelineRuntimeSummaryDraft,
    metrics: unknown,
    visualRouteResults: any[],
    pipelineStart: number,
  ): Promise<void> {
    const aiSummary = this.aiLogger.getJobSummary(state.jobId);
    const tokenUsage = this.tokenTracker.getSummary(summaryPath);
    const editRequestTokenUsage = tokenUsage?.scopes?.['edit-request'] ?? null;
    const orchestratorRetryTotal = Object.values(summaryDraft.retries).reduce(
      (sum, value) => sum + value,
      0,
    );
    const accuracy = this.extractAccuracySummary(metrics);
    const finishedAt = new Date().toISOString();

    const summary: PipelineRunSummaryFile = {
      jobId: state.jobId,
      status: this.toRunSummaryStatus(state.status),
      success: state.status === 'done',
      startedAt: summaryDraft.startedAt,
      finishedAt,
      totalDurationMs: Math.max(0, Date.now() - pipelineStart),
      totalDurationSeconds: Number(
        ((Date.now() - pipelineStart) / 1000).toFixed(1),
      ),
      failureMessage: state.error,
      retries: {
        total: orchestratorRetryTotal + aiSummary.retries.total,
        orchestrator: summaryDraft.retries,
        aiAgents: {
          total: aiSummary.retries.total,
          planning: aiSummary.retries.byStep.planning,
          codeGeneration: aiSummary.retries.byStep['code-generation'],
          sectionGeneration: aiSummary.retries.byStep['section-generation'],
        },
      },
      timing: {
        planningMs: summaryDraft.stepDurationsMs['5_planner'] ?? null,
        generationMs: summaryDraft.stepDurationsMs['6_generator'] ?? null,
        stepDurationsMs: summaryDraft.stepDurationsMs,
      },
      accuracy,
      tokenUsage,
      editRequestTokenUsage,
      uiAssessment: this.buildUiAssessment(accuracy, visualRouteResults),
      repoAnalysisSummary: summaryDraft.repoAnalysisSummary,
    };

    await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  }

  private toRunSummaryStatus(
    status: PipelineStatus['status'],
  ): PipelineRunSummaryFile['status'] {
    if (status === 'done') return 'success';
    if (status === 'stopped') return 'stopped';
    if (status === 'deleted') return 'deleted';
    return 'failed';
  }

  private extractAccuracySummary(metrics: unknown): PipelineAccuracySummary {
    const diffFromCompare = this.normalizePercentMetric(
      this.readFirstNumericMetric(metrics, [
        ['diffPercentage'],
        ['metrics', 'diffPercentage'],
        ['data', 'diffPercentage'],
        ['summary', 'overall', 'diffPercentage'],
        ['metrics', 'summary', 'overall', 'diffPercentage'],
        ['data', 'summary', 'overall', 'diffPercentage'],
      ]),
    );
    const accuracyPercent = this.normalizePercentMetric(
      this.readFirstNumericMetric(metrics, [
        ['percent'],
        ['metrics', 'percent'],
        ['accuracy'],
        ['metrics', 'accuracy'],
        ['visualAvgAccuracy'],
        ['metrics', 'visualAvgAccuracy'],
        ['summary', 'overall', 'visualAvgAccuracy'],
        ['metrics', 'summary', 'overall', 'visualAvgAccuracy'],
        ['data', 'summary', 'overall', 'visualAvgAccuracy'],
      ]),
    );
    const diffPercentage =
      diffFromCompare !== null
        ? diffFromCompare
        : accuracyPercent === null
          ? null
          : Number(Math.max(0, 100 - accuracyPercent).toFixed(2));
    const differentPixels = this.readFirstNumericMetric(metrics, [
      ['differentPixels'],
      ['metrics', 'differentPixels'],
      ['data', 'differentPixels'],
      ['summary', 'overall', 'differentPixels'],
      ['metrics', 'summary', 'overall', 'differentPixels'],
      ['data', 'summary', 'overall', 'differentPixels'],
    ]);
    const totalPixels = this.readFirstNumericMetric(metrics, [
      ['totalPixels'],
      ['metrics', 'totalPixels'],
      ['data', 'totalPixels'],
      ['summary', 'overall', 'totalPixels'],
      ['metrics', 'summary', 'overall', 'totalPixels'],
      ['data', 'summary', 'overall', 'totalPixels'],
    ]);
    const percent =
      accuracyPercent !== null
        ? accuracyPercent
        : diffPercentage === null
          ? null
          : Number(Math.max(0, 100 - diffPercentage).toFixed(2));

    return {
      percent,
      diffPercentage,
      differentPixels,
      totalPixels,
    };
  }

  private normalizePercentMetric(value: number | null): number | null {
    if (value === null) return null;
    return Number((value <= 1 ? value * 100 : value).toFixed(2));
  }

  private readFirstNumericMetric(
    value: unknown,
    paths: string[][],
  ): number | null {
    for (const path of paths) {
      const candidate = this.readNumericMetricPath(value, path);
      if (candidate !== null) return candidate;
    }
    return null;
  }

  private readNumericMetricPath(value: unknown, path: string[]): number | null {
    let cursor: unknown = value;
    for (const segment of path) {
      if (!cursor || typeof cursor !== 'object') return null;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return this.coerceFiniteNumber(cursor);
  }

  private coerceFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private buildUiAssessment(
    accuracy: PipelineAccuracySummary,
    visualRouteResults: any[],
  ): PipelineUiAssessment {
    const actionableRoutes = visualRouteResults.filter(
      (result) => Array.isArray(result?.issues) && result.issues.length > 0,
    ).length;
    const totalIssues = visualRouteResults.reduce(
      (sum, result) =>
        sum + (Array.isArray(result?.issues) ? result.issues.length : 0),
      0,
    );
    const basis: string[] = [];

    if (accuracy.percent !== null) {
      basis.push(`độ chính xác=${accuracy.percent}%`);
    }
    basis.push(`số lỗi thị giác=${totalIssues}`);
    basis.push(`số route cần xử lý=${actionableRoutes}`);

    if (accuracy.percent === null) {
      return {
        score: null,
        verdict:
          'Backend site compare chưa trả về đủ số liệu nên chưa thể chấm điểm giao diện tự động.',
        basis,
      };
    }

    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(accuracy.percent - actionableRoutes * 4 - totalIssues * 1.5),
      ),
    );

    if (score >= 92) {
      return {
        score,
        verdict:
          'Giao diện khá sát bản WordPress, độ lệch thị giác thấp và không còn nhiều điểm gây chú ý.',
        basis,
      };
    }

    if (score >= 80) {
      return {
        score,
        verdict:
          'Tổng thể giao diện ổn, nhưng vẫn còn một số chỗ lệch thấy được ở khoảng cách, màu sắc hoặc thành phần cục bộ.',
        basis,
      };
    }

    return {
      score,
      verdict:
        'Giao diện vẫn còn lệch khá rõ so với bản gốc, cần thêm một vòng review hình ảnh và chỉnh UI có mục tiêu.',
      basis,
    };
  }

  private validateDto(dto: RunPipelineDto): void {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new BadRequestException(
        'RunPipelineDto must be an object with themeGithubUrl and dbConnectionString',
      );
    }

    const allowedKeys = new Set([
      'themeGithubUrl',
      'dbConnectionString',
      'editRequest',
    ]);
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

  private buildPreviewEventData(input: {
    preview: PreviewBuilderResult;
    previewStage: 'baseline' | 'edited' | 'final';
    hasEditRequest: boolean;
    metrics?: ProgressEventData['metrics'];
  }): ProgressEventData {
    const { preview, previewStage, hasEditRequest, metrics } = input;
    return {
      previewUrl: preview.previewUrl,
      apiBaseUrl: preview.apiBaseUrl,
      previewStage,
      hasEditRequest,
      metrics,
    };
  }

  private buildEditRequestProgressData(input: {
    request?: RunPipelineDto['editRequest'];
    title: string;
    summary?: string;
  }): ProgressEventData | undefined {
    const { request, title, summary } = input;
    if (!request) return undefined;

    const prompt = request.prompt?.trim() || undefined;
    const captures = (request.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      note: attachment.note?.trim() || undefined,
      imageUrl: attachment.asset?.publicUrl?.trim() || undefined,
      sourcePageUrl: attachment.sourcePageUrl?.trim() || undefined,
      pageRoute: attachment.captureContext?.page?.route,
      pageTitle: attachment.captureContext?.page?.title?.trim() || undefined,
      capturedAt: attachment.captureContext?.capturedAt,
      selector:
        attachment.domTarget?.cssSelector?.trim() ||
        attachment.targetNode?.domPath?.trim() ||
        attachment.domTarget?.xpath?.trim() ||
        undefined,
      nearestHeading:
        attachment.domTarget?.nearestHeading?.trim() ||
        attachment.targetNode?.nearestHeading?.trim() ||
        undefined,
      tagName:
        attachment.domTarget?.tagName?.trim() ||
        attachment.targetNode?.tagName?.trim() ||
        undefined,
    }));

    return {
      stepDetails: {
        kind: 'edit-request',
        title,
        summary,
        prompt,
        language: request.language?.trim() || undefined,
        targetRoute:
          request.pageContext?.reactRoute ??
          request.pageContext?.wordpressRoute ??
          null,
        targetPageTitle: request.pageContext?.pageTitle?.trim() || undefined,
        captureCount: captures.length,
        captures,
      },
    };
  }

  private async applyPostMigrationEditPass(input: {
    jobId: string;
    state: PipelineStatus;
    stepName: string;
    request?: RunPipelineDto['editRequest'];
    plan: PlanResult;
    components: ReactGenerateResult['components'];
    fixAgentModel?: string;
    logPath: string;
    applyProgress: number;
    reviewProgress: number;
    refixProgress: number;
  }): Promise<{
    components: ReactGenerateResult['components'];
    applied: boolean;
    taskCount: number;
  }> {
    const {
      jobId,
      state,
      stepName,
      request,
      plan,
      fixAgentModel,
      logPath,
      applyProgress,
      reviewProgress,
      refixProgress,
    } = input;
    let components = [...input.components];

    if (!request) {
      return { components, applied: false, taskCount: 0 };
    }

    const inMemoryUiSourceMapEntries =
      await buildUiSourceMapForGeneratedComponents({
        components,
        plan,
      });
    const inMemoryMutationCandidates =
      await buildUiMutationCandidatesForGeneratedComponents({
        components,
      });
    const exactCaptureTargetsForEditPass = resolveCaptureTargetsFromUiSourceMap(
      {
        attachments: request.attachments,
        uiSourceMap: inMemoryUiSourceMapEntries,
      },
    );
    await this.logExactCaptureResolution({
      jobId,
      logPath,
      attachments: request.attachments,
      uiSourceMapPath: 'in-memory:baseline-generated-components',
      uiSourceMapEntryCount: inMemoryUiSourceMapEntries.length,
      exactCaptureTargets: exactCaptureTargetsForEditPass,
    });
    const intentAwareCaptureTargetsForEditPass =
      this.editRequestPhase.resolveIntentAwareCaptureTargets({
        request,
        exactCaptureTargets: exactCaptureTargetsForEditPass,
        mutationCandidates: inMemoryMutationCandidates,
      });
    await this.logExactCaptureResolution({
      jobId,
      logPath,
      attachments: request.attachments,
      uiSourceMapPath: 'in-memory:intent-aware-mutation-targets',
      uiSourceMapEntryCount: inMemoryMutationCandidates.length,
      exactCaptureTargets: intentAwareCaptureTargetsForEditPass,
    });

    const postMigrationEditTasks =
      this.editRequestPhase.buildPostMigrationEditTasks({
        request,
        plan,
        components,
        exactCaptureTargets: intentAwareCaptureTargetsForEditPass,
        mutationCandidates: inMemoryMutationCandidates,
      });

    if (postMigrationEditTasks.length === 0) {
      return { components, applied: false, taskCount: 0 };
    }

    const editedComponentNames: Record<string, string> = {};
    const applyFocusedTask = async (
      task: (typeof postMigrationEditTasks)[number],
      feedbackOverride?: string,
    ): Promise<boolean> => {
      const componentIndex = components.findIndex(
        (component) => component.name === task.componentName,
      );
      if (componentIndex === -1) return false;

      const effectiveTask = feedbackOverride
        ? {
            ...task,
            feedback: feedbackOverride,
            debugSummary: `${task.debugSummary} | refix=true`,
          }
        : task;
      const fixedResult = await this.sectionEdit.applyFocusedTask({
        task: effectiveTask,
        request,
        plan,
        components,
        modelConfig: { fixAgent: fixAgentModel },
        logPath,
      });
      if (!fixedResult) return false;

      const revalidated = this.validator.collectValidationIssues([
        fixedResult.component,
      ]);
      if (revalidated.failures.length > 0) {
        const validationErr = revalidated.failures[0]?.error;
        this.logger.warn(
          `[Focused Edit Pass] Re-validation failed for "${fixedResult.editedComponentName}" after focused edit. Keeping the previous version. Error: ${validationErr}`,
        );
        await this.logToFile(
          logPath,
          `[Focused Edit Pass] Re-validation failed for "${fixedResult.editedComponentName}": ${validationErr}`,
        );
        return false;
      }

      const replacementIndex = components.findIndex(
        (component) => component.name === fixedResult.editedComponentName,
      );
      if (replacementIndex !== -1) {
        components[replacementIndex] = revalidated.components[0];
      }
      editedComponentNames[task.componentName] =
        fixedResult.editedComponentName;
      return true;
    };

    this.logger.log(
      `[Focused Edit Pass] Applying ${postMigrationEditTasks.length} focused edit task(s) after the baseline preview is available.`,
    );
    this.emitStepProgress(
      state,
      stepName,
      applyProgress,
      `Applying ${postMigrationEditTasks.length} focused edit task(s) from the user's request while the baseline preview stays visible.`,
    );
    await this.logToFile(
      logPath,
      `[Focused Edit Pass] Applying ${postMigrationEditTasks.length} focused task(s).`,
    );

    for (const task of postMigrationEditTasks) {
      this.logger.log(`[Focused Edit Pass] ${task.debugSummary}`);
      await this.logToFile(logPath, `[Focused Edit Pass] ${task.debugSummary}`);
      await applyFocusedTask(task);
    }

    const finalValidation = this.validator.collectValidationIssues(components);
    if (finalValidation.failures.length > 0) {
      throw new Error(
        `[focused-edit] Focused edit tasks introduced validation failures:\n${finalValidation.failures
          .map(
            (failure) =>
              `Component "${failure.component.name}": ${failure.error}`,
          )
          .join('\n')}`,
      );
    }

    components = finalValidation.components;

    this.emitStepProgress(
      state,
      stepName,
      reviewProgress,
      `Reviewing ${postMigrationEditTasks.length} focused capture edit task(s) against the submitted evidence.`,
    );
    let captureReviewResult = this.captureReview.reviewFocusedTasks({
      tasks: postMigrationEditTasks,
      request,
      plan,
      components,
      editedComponentNames,
    });

    this.logger.log(`[Capture Review] ${captureReviewResult.summary}`);
    await this.logToFile(
      logPath,
      `[Capture Review] ${captureReviewResult.summary}`,
    );

    const advisoryResults = captureReviewResult.results.filter(
      (result) => result.status !== 'matched',
    );
    for (const result of advisoryResults) {
      const issueText =
        result.issues.map((issue) => issue.message).join(' | ') ||
        result.summary;
      this.logger.warn(
        `[Capture Review] ${result.debugSummary} :: ${issueText}`,
      );
      await this.logToFile(
        logPath,
        `[Capture Review] ${result.debugSummary} :: ${issueText}`,
      );
    }

    const MAX_CAPTURE_REVIEW_FIX_ROUNDS = 2;
    for (let round = 1; round <= MAX_CAPTURE_REVIEW_FIX_ROUNDS; round++) {
      const componentsSnapshot = [...components];
      const editedComponentNamesSnapshot = {
        ...editedComponentNames,
      };
      const reviewFailures = captureReviewResult.results.filter(
        (result) =>
          result.status !== 'matched' && Boolean(result.suggestedFixFeedback),
      );
      if (reviewFailures.length === 0) break;

      this.logger.warn(
        `[Capture Review] ${reviewFailures.length} capture review issue(s) need focused re-fix (round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS}).`,
      );
      await this.logToFile(
        logPath,
        `[Capture Review] ${reviewFailures.length} issue(s) need focused re-fix (round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS}).`,
      );
      this.emitStepProgress(
        state,
        stepName,
        refixProgress,
        `Capture review re-fix ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS}: repairing ${reviewFailures.length} attachment-targeted issue(s).`,
      );

      for (const reviewFailure of reviewFailures) {
        const relatedTask = postMigrationEditTasks.find(
          (task) =>
            task.componentName === reviewFailure.componentName &&
            task.attachments.some(
              (attachment) => attachment.id === reviewFailure.attachmentId,
            ),
        );
        if (!relatedTask || !reviewFailure.suggestedFixFeedback) continue;

        this.logger.warn(
          `[Capture Review] Re-fixing attachment=${reviewFailure.attachmentId} target=${reviewFailure.componentName} status=${reviewFailure.status} confidence=${reviewFailure.confidence.toFixed(2)}`,
        );
        await this.logToFile(
          logPath,
          `[Capture Review] Re-fixing attachment=${reviewFailure.attachmentId} target=${reviewFailure.componentName} status=${reviewFailure.status} confidence=${reviewFailure.confidence.toFixed(2)}`,
        );

        await applyFocusedTask(
          relatedTask,
          `${relatedTask.feedback}\n\n${reviewFailure.suggestedFixFeedback}`,
        );
      }

      const refixValidation =
        this.validator.collectValidationIssues(components);
      if (refixValidation.failures.length > 0) {
        const validationSummary = refixValidation.failures
          .map(
            (failure) =>
              `Component "${failure.component.name}": ${failure.error}`,
          )
          .join('\n');
        this.logger.warn(
          `[Capture Review] Re-fix round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS} introduced validation failures. Reverting to the last valid component snapshot and continuing. ${validationSummary}`,
        );
        await this.logToFile(
          logPath,
          `[Capture Review] Re-fix round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS} introduced validation failures. Reverting to the last valid snapshot.\n${validationSummary}`,
        );
        components = componentsSnapshot;
        for (const key of Object.keys(editedComponentNames)) {
          delete editedComponentNames[key];
        }
        Object.assign(editedComponentNames, editedComponentNamesSnapshot);
        break;
      }
      components = refixValidation.components;

      captureReviewResult = this.captureReview.reviewFocusedTasks({
        tasks: postMigrationEditTasks,
        request,
        plan,
        components,
        editedComponentNames,
      });

      this.logger.log(
        `[Capture Review] Re-review round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS}: ${captureReviewResult.summary}`,
      );
      await this.logToFile(
        logPath,
        `[Capture Review] Re-review round ${round}/${MAX_CAPTURE_REVIEW_FIX_ROUNDS}: ${captureReviewResult.summary}`,
      );

      const remainingIssues = captureReviewResult.results.filter(
        (result) => result.status !== 'matched',
      );
      for (const result of remainingIssues) {
        const issueText =
          result.issues.map((issue) => issue.message).join(' | ') ||
          result.summary;
        this.logger.warn(
          `[Capture Review] ${result.debugSummary} :: ${issueText}`,
        );
        await this.logToFile(
          logPath,
          `[Capture Review] ${result.debugSummary} :: ${issueText}`,
        );
      }
    }

    const unresolvedCaptureReviewIssues = captureReviewResult.results.filter(
      (result) => result.status !== 'matched',
    );
    if (unresolvedCaptureReviewIssues.length > 0) {
      const unresolvedSummary = unresolvedCaptureReviewIssues
        .map((result) => result.debugSummary)
        .join(' || ');
      this.logger.warn(
        `[Capture Review] ${unresolvedCaptureReviewIssues.length} issue(s) remain after best-effort re-fix. Continuing pipeline without crashing. ${unresolvedSummary}`,
      );
      await this.logToFile(
        logPath,
        `[Capture Review] ${unresolvedCaptureReviewIssues.length} issue(s) remain after best-effort re-fix. Continuing pipeline without crashing. ${unresolvedSummary}`,
      );
    }

    return {
      components,
      applied: true,
      taskCount: postMigrationEditTasks.length,
    };
  }

  private async writePlanArtifact(
    jobId: string,
    plan: PlanResult,
  ): Promise<void> {
    const artifactDir = join('./temp/generated', jobId);
    await mkdir(artifactDir, { recursive: true });
    const payload = {
      jobId,
      generatedAt: new Date().toISOString(),
      componentCount: plan.length,
      plan,
    };
    await writeFile(
      join(artifactDir, 'plan-result.json'),
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
  }

  private async logExactCaptureResolution(input: {
    jobId: string;
    logPath: string;
    attachments?: PipelineCaptureAttachmentDto[];
    uiSourceMapPath?: string | null;
    uiSourceMapEntryCount: number;
    exactCaptureTargets: ResolvedCaptureTargetRecord[];
  }): Promise<void> {
    const {
      jobId,
      logPath,
      attachments,
      uiSourceMapPath,
      uiSourceMapEntryCount,
      exactCaptureTargets,
    } = input;

    const summaryMessage = [
      `[${jobId}] [capture-resolve]`,
      `uiSourceMapPath=${uiSourceMapPath ?? 'none'}`,
      `uiSourceMapEntries=${uiSourceMapEntryCount}`,
      `captures=${attachments?.length ?? 0}`,
      `resolved=${exactCaptureTargets.length}`,
    ].join(' ');
    this.logger.log(summaryMessage);
    await this.logToFile(logPath, summaryMessage);

    const resolvedByCaptureId = new Map(
      exactCaptureTargets.map((target) => [target.captureId, target]),
    );

    for (const attachment of attachments ?? []) {
      const resolved = resolvedByCaptureId.get(attachment.id);
      const detail = resolved
        ? formatResolvedCaptureTargetForLog(resolved)
        : formatUnresolvedCaptureAttachmentForLog(attachment);
      const formatted = `[${jobId}] [capture-resolve] ${detail}`;
      this.logger.log(formatted);
      await this.logToFile(logPath, formatted);
    }
  }

  private buildEditRequestLogLines(
    context?: ResolvedEditRequestContext,
  ): string[] {
    if (!context) {
      return ['none'];
    }

    const request = context.request;
    const summary = context.summary;
    const lines = [
      [
        `accepted=${context.accepted}`,
        `mode=${context.mode}`,
        `category=${context.category}`,
        `source=${summary.source}`,
        `attachments=${summary.attachmentCount}`,
        `hasPrompt=${summary.hasPrompt}`,
        `hasVisualContext=${summary.hasVisualContext}`,
      ].join(' | '),
    ];

    const intentParts = [
      context.globalIntent
        ? `intent="${truncateForLog(context.globalIntent, 180)}"`
        : null,
      context.focusHint
        ? `focus="${truncateForLog(context.focusHint, 140)}"`
        : null,
      typeof context.confidence === 'number'
        ? `confidence=${context.confidence.toFixed(2)}`
        : null,
      context.source ? `resolver=${context.source}` : null,
    ].filter(Boolean);
    if (intentParts.length > 0) {
      lines.push(intentParts.join(' | '));
    }

    if (request?.targetHint) {
      const targetLine = [
        request.targetHint.componentName
          ? `component=${request.targetHint.componentName}`
          : null,
        request.targetHint.route ? `route=${request.targetHint.route}` : null,
        request.targetHint.templateName
          ? `template=${request.targetHint.templateName}`
          : null,
        request.targetHint.sectionType
          ? `sectionType=${request.targetHint.sectionType}`
          : null,
        typeof request.targetHint.sectionIndex === 'number'
          ? `sectionIndex=${request.targetHint.sectionIndex}`
          : null,
      ].filter(Boolean);
      if (targetLine.length > 0) {
        lines.push(`target | ${targetLine.join(' | ')}`);
      }
    }

    if (request?.pageContext) {
      const pageContextLine = [
        request.pageContext.wordpressRoute
          ? `route=${request.pageContext.wordpressRoute}`
          : null,
        request.pageContext.wordpressUrl
          ? `wpUrl=${request.pageContext.wordpressUrl}`
          : null,
        request.pageContext.pageTitle
          ? `pageTitle="${truncateForLog(request.pageContext.pageTitle, 80)}"`
          : null,
        formatViewportForLog(request.pageContext.viewport),
        formatDocumentForLog(request.pageContext.document),
      ].filter(Boolean);
      if (pageContextLine.length > 0) {
        lines.push(`page | ${pageContextLine.join(' | ')}`);
      }
    }

    if (request?.prompt) {
      lines.push(`prompt | "${truncateForLog(request.prompt, 220)}"`);
    }

    const attachments = request?.attachments ?? [];
    attachments.forEach((attachment, index) => {
      lines.push(
        `capture#${index + 1} | ${formatAttachmentForLog(attachment)}`,
      );
    });

    return lines;
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

function formatAttachmentForLog(
  attachment: PipelineCaptureAttachmentDto,
): string {
  const documentRect =
    attachment.geometry?.documentRect ??
    (attachment.selection?.coordinateSpace === 'iframe-document'
      ? attachment.selection
      : undefined);
  const normalizedRect = attachment.geometry?.normalizedRect;
  const pageRoute =
    attachment.targetNode?.route ??
    attachment.captureContext?.page?.route ??
    attachment.sourcePageUrl;
  const sectionType = inferSectionTypeForLog(attachment);
  const sectionIndex = inferSectionIndexForLog(attachment);

  return [
    `id=${attachment.id}`,
    pageRoute ? `route=${pageRoute}` : null,
    attachment.targetNode?.templateName
      ? `template=${attachment.targetNode.templateName}`
      : null,
    attachment.targetNode?.ownerSourceNodeId ||
    attachment.targetNode?.sourceNodeId
      ? `ownerSourceNodeId=${attachment.targetNode?.ownerSourceNodeId ?? attachment.targetNode?.sourceNodeId}`
      : null,
    attachment.targetNode?.editSourceNodeId
      ? `editSourceNodeId=${attachment.targetNode.editSourceNodeId}`
      : null,
    attachment.targetNode?.editNodeRole
      ? `editRole=${attachment.targetNode.editNodeRole}`
      : null,
    attachment.targetNode?.editTagName
      ? `editTag=${attachment.targetNode.editTagName}`
      : null,
    attachment.targetNode?.blockName || attachment.domTarget?.blockName
      ? `block=${attachment.targetNode?.blockName ?? attachment.domTarget?.blockName}`
      : null,
    sectionType ? `sectionType=${sectionType}` : null,
    typeof sectionIndex === 'number' ? `sectionIndex≈${sectionIndex}` : null,
    attachment.targetNode?.nearestHeading ||
    attachment.domTarget?.nearestHeading
      ? `heading="${truncateForLog(attachment.targetNode?.nearestHeading ?? attachment.domTarget?.nearestHeading ?? '', 80)}"`
      : null,
    attachment.targetNode?.nearestLandmark ||
    attachment.domTarget?.nearestLandmark
      ? `landmark=${attachment.targetNode?.nearestLandmark ?? attachment.domTarget?.nearestLandmark}`
      : null,
    documentRect
      ? `documentRect=(${documentRect.x},${documentRect.y},${documentRect.width},${documentRect.height})`
      : null,
    normalizedRect
      ? `normalizedRect=(${normalizedRect.x},${normalizedRect.y},${normalizedRect.width},${normalizedRect.height})`
      : null,
    formatViewportForLog(attachment.captureContext?.viewport),
    formatDocumentForLog(attachment.captureContext?.document),
    attachment.note ? `note="${truncateForLog(attachment.note, 120)}"` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatViewportForLog(
  viewport?:
    | {
        width: number;
        height: number;
        scrollX?: number;
        scrollY?: number;
        dpr?: number;
      }
    | undefined,
): string | null {
  if (!viewport) return null;

  const parts = [
    `${viewport.width}x${viewport.height}`,
    typeof viewport.scrollX === 'number' || typeof viewport.scrollY === 'number'
      ? `scroll=(${viewport.scrollX ?? 0},${viewport.scrollY ?? 0})`
      : null,
    typeof viewport.dpr === 'number' ? `dpr=${viewport.dpr}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? `viewport=${parts.join(' ')}` : null;
}

function formatDocumentForLog(
  document?:
    | {
        width: number;
        height: number;
      }
    | undefined,
): string | null {
  if (!document) return null;
  return `document=${document.width}x${document.height}`;
}

function inferSectionTypeForLog(
  attachment: PipelineCaptureAttachmentDto,
): string | undefined {
  const signal = normalizeLogToken(
    [
      attachment.targetNode?.blockName,
      attachment.targetNode?.tagName,
      attachment.targetNode?.domPath,
      attachment.targetNode?.nearestHeading,
      attachment.targetNode?.nearestLandmark,
      attachment.domTarget?.blockName,
      attachment.domTarget?.tagName,
      attachment.domTarget?.domPath,
      attachment.domTarget?.nearestHeading,
      attachment.domTarget?.nearestLandmark,
      attachment.note,
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (!signal) return undefined;
  if (/\b(hero|banner|cover)\b/.test(signal)) return 'hero';
  if (/\b(header|navigation|navbar|menu)\b/.test(signal)) return 'header';
  if (/\bfooter\b/.test(signal)) return 'footer';
  if (/\bcta|button|call to action\b/.test(signal)) return 'cta';
  if (/\bfaq|accordion\b/.test(signal)) return 'faq';
  if (/\btestimonial|review|quote\b/.test(signal)) return 'testimonial';
  if (/\bpricing|price|plan\b/.test(signal)) return 'pricing';
  if (/\bfeature|benefit|service\b/.test(signal)) return 'features';
  if (/\bcontact|form|signup|newsletter|chat|search|filter\b/.test(signal)) {
    return 'interactive';
  }
  if (/\bgallery|image|media|video\b/.test(signal)) return 'media';
  if (/\bposts|post|query|blog|article\b/.test(signal)) return 'posts';
  if (/\bsidebar|aside\b/.test(signal)) return 'sidebar';
  if (/\bmain\b/.test(signal)) return 'main';
  if (/\bsection|group|columns|column|container\b/.test(signal)) {
    return 'section';
  }

  return undefined;
}

function inferSectionIndexForLog(
  attachment: PipelineCaptureAttachmentDto,
): number | undefined {
  const normalizedY =
    attachment.geometry?.normalizedRect?.y ??
    deriveNormalizedYForLog(
      attachment.geometry?.documentRect?.y ?? attachment.selection?.y,
      attachment.captureContext?.document?.height,
    );

  if (typeof normalizedY !== 'number' || Number.isNaN(normalizedY)) {
    return undefined;
  }

  return Math.max(0, Math.min(9, Math.floor(normalizedY * 10)));
}

function deriveNormalizedYForLog(
  y?: number,
  documentHeight?: number,
): number | undefined {
  if (
    typeof y !== 'number' ||
    Number.isNaN(y) ||
    typeof documentHeight !== 'number' ||
    Number.isNaN(documentHeight) ||
    documentHeight <= 0
  ) {
    return undefined;
  }

  return Math.min(Math.max(y / documentHeight, 0), 0.999);
}

function normalizeLogToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

function truncateForLog(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeDebugFilename(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'untitled';
}

function formatResolvedCaptureTargetForLog(
  target: ResolvedCaptureTargetRecord,
): string {
  return [
    `capture=${target.captureId}`,
    `sourceNodeId=${target.sourceNodeId}`,
    `template=${target.templateName}`,
    `sourceFile=${target.sourceFile}`,
    `component=${target.componentName}`,
    `section=${target.sectionKey}`,
    target.sectionComponentName
      ? `sectionComponent=${target.sectionComponentName}`
      : null,
    `outputFile=${target.outputFilePath}`,
    formatResolvedCaptureLinesForLog(
      'ownerLines',
      target.startLine,
      target.endLine,
    ),
    target.targetComponentName
      ? `targetComponent=${target.targetComponentName}`
      : null,
    target.targetSourceNodeId
      ? `targetSourceNodeId=${target.targetSourceNodeId}`
      : null,
    target.targetNodeRole ? `targetRole=${target.targetNodeRole}` : null,
    target.targetElementTag ? `targetTag=${target.targetElementTag}` : null,
    target.targetTextPreview
      ? `targetText="${truncateForLog(target.targetTextPreview, 80)}"`
      : null,
    formatResolvedCaptureLinesForLog(
      'targetLines',
      target.targetStartLine,
      target.targetEndLine,
    ),
    `resolution=${target.resolution}`,
    `confidence=${target.confidence.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatUnresolvedCaptureAttachmentForLog(
  attachment: PipelineCaptureAttachmentDto,
): string {
  return [
    `capture=${attachment.id}`,
    'status=unresolved',
    attachment.targetNode?.sourceNodeId
      ? `sourceNodeId=${attachment.targetNode.sourceNodeId}`
      : null,
    attachment.targetNode?.ownerSourceNodeId
      ? `ownerSourceNodeId=${attachment.targetNode.ownerSourceNodeId}`
      : null,
    attachment.targetNode?.editSourceNodeId
      ? `editSourceNodeId=${attachment.targetNode.editSourceNodeId}`
      : null,
    attachment.targetNode?.editNodeRole
      ? `editRole=${attachment.targetNode.editNodeRole}`
      : null,
    attachment.targetNode?.editTagName
      ? `editTag=${attachment.targetNode.editTagName}`
      : null,
    attachment.targetNode?.templateName
      ? `template=${attachment.targetNode.templateName}`
      : null,
    attachment.targetNode?.sourceFile
      ? `sourceFile=${attachment.targetNode.sourceFile}`
      : null,
    typeof attachment.targetNode?.topLevelIndex === 'number'
      ? `topLevelIndex=${attachment.targetNode.topLevelIndex}`
      : null,
    attachment.targetNode?.blockName
      ? `block=${attachment.targetNode.blockName}`
      : null,
    attachment.targetNode?.domPath
      ? `domPath=${truncateForLog(attachment.targetNode.domPath, 120)}`
      : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatResolvedCaptureLinesForLog(
  label: string,
  startLine?: number,
  endLine?: number,
): string | null {
  if (typeof startLine !== 'number' || typeof endLine !== 'number') {
    return null;
  }

  return `${label}=${startLine}-${endLine}`;
}
