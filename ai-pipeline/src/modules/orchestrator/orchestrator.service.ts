import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { AgentResult } from '@/common/types/pipeline.type.js';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { lastValueFrom, ReplaySubject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { cloneRepoWithRetry } from '../../common/utils/git-clone.util.js';
import { parseDbConnectionString } from '../../common/utils/db-connection-parser.js';
import { LlmFactoryService } from '../../common/llm/llm-factory.service.js';
import {
  TokenTracker,
  type TokenUsagePhaseSummary,
} from '../../common/utils/token-tracker.js';
import { ApiBuilderService } from '../agents/api-builder/api-builder.service.js';
import { GeneratedApiReviewService } from '../agents/api-builder/generated-api-review.service.js';
import type {
  BlockParseResult,
  ThemeTokens,
} from '../agents/block-parser/block-parser.service.js';
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
import {
  PlanReviewerService,
  type PlanReviewWarningCode,
} from '../agents/plan-reviewer/plan-reviewer.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import { PlannerService } from '../agents/planner/planner.service.js';
import type { PreviewBuilderResult } from '../agents/preview-builder/preview-builder.service.js';
import { PreviewBuilderService } from '../agents/preview-builder/preview-builder.service.js';
import { GeneratedCodeReviewService } from '../agents/react-generator/generated-code-review.service.js';
import type { ReactGenerateResult } from '../agents/react-generator/react-generator.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { SectionEditService } from '../agents/react-generator/section-edit.service.js';
import { ReactVisualEditService } from '../agents/react-generator/react-visual-edit.service.js';
import type {
  RepoAnalyzeResult,
  RepoResolvedSourceSummary,
  RepoThemeManifest,
  RepoUagbDetectionSummary,
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
import { ThemeRepoLayoutResolverService } from '../theme/theme-repo-layout-resolver.service.js';
import {
  buildUiMutationCandidatesForGeneratedComponents,
  buildUiSourceMapForGeneratedComponents,
  readUiSourceMapEntries,
  resolveCaptureTargetsFromUiSourceMap,
} from '../edit-request/ui-source-map.util.js';
import { getComponentStrategy } from '../agents/component-strategy.registry.js';
import { SqlService } from '../sql/sql.service.js';
import { WpQueryService } from '../sql/wp-query.service.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import type {
  ApplyPendingEditRequestDto,
  PipelineCaptureAttachmentDto,
  RunPipelineDto,
  SkipPendingEditRequestDto,
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
  editApprovalRequired?: boolean;
  editApplied?: boolean;
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
  status:
    | 'running'
    | 'awaiting_confirmation'
    | 'stopping'
    | 'stopped'
    | 'done'
    | 'error'
    | 'deleted';
  steps: PipelineStep[];
  result?: any;
  error?: string;
}

interface PendingEditDecision {
  action: 'apply' | 'skip';
}

interface PendingEditApprovalGate {
  promise: Promise<PendingEditDecision>;
  resolve: (decision: PendingEditDecision) => void;
  reject: (reason?: unknown) => void;
}

function collectPlanReviewBlockingIssues(
  review: {
    errors: string[];
    warnings: string[];
    warningCodes?: PlanReviewWarningCode[];
    plan?: Array<{ componentName: string; visualPlan?: unknown }>;
  },
  strictMode: boolean,
  phase: 'architecture' | 'visual',
): string[] {
  const actionableWarnings: string[] = [];
  const ignoredWarningCodes = new Set<PlanReviewWarningCode>([
    'multiple_home_like_templates_detected',
    'type_normalized',
    'route_normalized',
    'detail_flag_normalized',
    'page_level_chrome_dataneeds_removed',
    'template_dataneeds_normalized',
    'visualplan_sections_synchronized',
    'visualplan_contract_sanitized',
    'visualplan_dataneeds_synchronized',
    'duplicate_route_normalized',
    'home_hierarchy_type_normalized',
    'home_hierarchy_route_normalized',
    'home_hierarchy_is_detail_normalized',
  ]);

  review.warnings.forEach((warning, index) => {
    const warningCode = review.warningCodes?.[index];

    // Phase-D review intentionally runs before visual plans are attached.
    if (
      phase === 'architecture' &&
      warningCode === 'missing_visual_plan_fallback_ai'
    ) {
      return;
    }

    if (
      phase === 'visual' &&
      warningCode === 'missing_visual_plan_fallback_ai'
    ) {
      const missingVisualPlanComponents =
        review.plan
          ?.filter(
            (component) =>
              !component.visualPlan &&
              !getComponentStrategy(component.componentName).skipAiVisualPlan,
          )
          .map((component) => component.componentName) ?? [];

      if (missingVisualPlanComponents.length > 0) {
        actionableWarnings.push(
          `${missingVisualPlanComponents.length} component(s) still require visual plan: ${missingVisualPlanComponents.join(', ')}`,
        );
      }
      return;
    }

    // These are deterministic normalizations performed by the reviewer itself,
    // not something the LLM can meaningfully "fix" on the next retry.
    if (warningCode && ignoredWarningCodes.has(warningCode)) {
      return;
    }

    actionableWarnings.push(warning);
  });

  return strictMode
    ? [...review.errors, ...actionableWarnings]
    : [...review.errors];
}

interface JobRuntimeControl {
  stopRequested: boolean;
  deleteRequested: boolean;
  finalized: boolean;
  hasEditRequest?: boolean;
  pendingEditRequest?: RunPipelineDto['editRequest'];
  pendingEditRequestContext?: ResolvedEditRequestContext;
  pendingEditApproval?: boolean;
  editApplied?: boolean;
  siteId?: string;
  logPath?: string;
  preview?: PreviewBuilderResult;
  buildComponents?: ReactGenerateResult['components'];
  approvedPlan?: PlanResult;
  previewTokens?: ThemeTokens;
  fixAgentModel?: string;
  confirmationGate?: PendingEditApprovalGate;
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

interface FullComponentRegenerationSummaryEntry {
  timestamp: string;
  stage: 'stage4-validator-fix' | 'stage5-review-fix';
  componentName: string;
  reasons: string[];
  missingTargets: string[];
  outcome: 'succeeded' | 'failed';
  triggerErrorPreview: string;
  finalError?: string;
}

interface PipelineRuntimeSummaryDraft {
  startedAt: string;
  repoAnalysisSummary: string[];
  stepDurationsMs: Partial<Record<string, number>>;
  retries: PipelineRetryCounters;
  fullComponentRegenerations: FullComponentRegenerationSummaryEntry[];
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

interface AutomationCompareRegion {
  id?: string;
  kind?: string;
  severity?: 'low' | 'medium' | 'high' | string;
  diffPixels?: number | null;
  diffDensity?: number | null;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  cropArtifacts?: {
    imageA?: string;
    imageB?: string;
    diff?: string;
  };
}

interface AutomationComparePageVisual {
  status?: string | null;
  accuracy?: number | null;
  diffPct?: number | null;
  overlapDiffPct?: number | null;
  extraDiffPct?: number | null;
  overlapDiffPixels?: number | null;
  extraPixels?: number | null;
  artifacts?: {
    imageA?: string;
    imageB?: string;
    diff?: string;
  } | null;
  regions?: AutomationCompareRegion[];
  domComparison?: {
    similarityScore?: number | null;
  } | null;
  wpPath?: string | null;
  reactPath?: string | null;
  error?: string | null;
}

interface AutomationComparePageContent {
  status?: string | null;
  scores?: {
    title?: number | null;
    content?: number | null;
    overall?: number | null;
  } | null;
  issues?: string[];
  wp?: {
    title?: string;
    contentPreview?: string;
  } | null;
  react?: {
    title?: string;
    contentPreview?: string;
  } | null;
}

interface AutomationComparePageResult {
  routeKey?: string | null;
  route?: string | null;
  url?: string | null;
  slug?: string | null;
  type?: string | null;
  componentHint?: string | null;
  repairPriority?: string | null;
  visual?: AutomationComparePageVisual | null;
  content?: AutomationComparePageContent | null;
}

interface VisualMismatchDiagnosis {
  componentName: string;
  routeKey?: string | null;
  route?: string | null;
  shouldRepair: boolean;
  confidence: number;
  rootCause: {
    primary:
      | 'plan-omission'
      | 'missing-section'
      | 'missing-image'
      | 'content-drift'
      | 'layout-drift'
      | 'route-mapping-error'
      | 'data-binding-error'
      | 'shared-layout-mismatch'
      | 'unknown';
    secondary: string[];
    reasoning: string;
  };
  evidence: {
    sourceHints: string[];
    missingLabels: string[];
    sectionLikelyMissingFromPlan: boolean;
  };
  repairPlan: {
    strategy: string;
    instructions: string[];
    targetAreas: Array<{
      type: string;
      sectionHint?: string;
      headingHint?: string;
    }>;
    guardrails: string[];
  };
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
  fullComponentRegenerations: FullComponentRegenerationSummaryEntry[];
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
    private readonly themeRepoLayoutResolver: ThemeRepoLayoutResolverService,
    private readonly repoAnalyzer: RepoAnalyzerService,
    private readonly phpParser: PhpParserService,
    private readonly blockParser: BlockParserService,
    private readonly normalizer: NormalizerService,
    private readonly dbContent: DbContentService,
    private readonly planner: PlannerService,
    private readonly planReviewer: PlanReviewerService,
    private readonly reactGenerator: ReactGeneratorService,
    private readonly sectionEdit: SectionEditService,
    private readonly reactVisualEdit: ReactVisualEditService,
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
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
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
      pendingEditRequest: dto.editRequest,
      pendingEditRequestContext: editRequestContext,
      pendingEditApproval: Boolean(dto.editRequest),
      editApplied: false,
      siteId,
    });

    this.executePipelineLegacy(
      jobId,
      siteId,
      dto,
      state,
      editRequestContext,
    ).catch((err) => {
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
    result?: {
      componentName: string;
      filePath: string;
      isValid: boolean;
      warnings: string[];
    };
    error?: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }

    const jobResult = (state.result ?? {}) as {
      previewDir?: string;
      frontendDir?: string;
      previewUrl?: string;
      apiBaseUrl?: string;
      uiSourceMapPath?: string;
      routeEntries?: Array<{ route: string; componentName: string }>;
      plan?: PlanResult;
    };

    const previewDir =
      body.editRequest.reactSourceTarget.previewDir?.trim() ||
      jobResult.previewDir;
    const frontendDir =
      body.editRequest.reactSourceTarget.frontendDir?.trim() ||
      jobResult.frontendDir ||
      (previewDir ? join(previewDir, 'frontend') : undefined);
    const routeEntries = body.editRequest.reactSourceTarget.routeEntries?.length
      ? body.editRequest.reactSourceTarget.routeEntries
      : jobResult.routeEntries;

    const logDir = previewDir || join('./temp/generated', body.jobId);
    const logPath = join(logDir, 'react-visual-edit-request.json');

    await mkdir(logDir, { recursive: true });
    await writeFile(
      logPath,
      JSON.stringify(
        { ...body, submittedAt: new Date().toISOString() },
        null,
        2,
      ),
      'utf-8',
    );

    this.logger.log(
      `[visual-edit] job=${body.jobId} frontendDir=${frontendDir} component=${body.editRequest.targetHint?.componentName ?? '(unresolved)'}`,
    );

    if (!frontendDir) {
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        error:
          'frontendDir could not be resolved — job may not have a completed preview',
      };
    }

    if (!jobResult.plan?.length) {
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        error:
          'Plan not available for this job — re-run the pipeline to populate plan data',
      };
    }

    try {
      const editResult = await this.reactVisualEdit.applyEdit({
        jobId: body.jobId,
        frontendDir,
        plan: jobResult.plan,
        routeEntries,
        editRequest: body.editRequest,
        logPath,
      });

      return {
        accepted: true,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        result: editResult,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown');
      this.logger.warn(`[visual-edit] job=${body.jobId} failed: ${message}`);
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        error: message,
      };
    }
  }

  async approvePendingEditRequest(body: ApplyPendingEditRequestDto): Promise<{
    accepted: boolean;
    resumed: boolean;
    jobId: string;
    siteId: string;
    action: 'apply';
    error?: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }
    const control = this.controls.get(body.jobId);
    if (!control?.pendingEditRequest || !control.pendingEditApproval) {
      return {
        accepted: false,
        resumed: false,
        jobId: body.jobId,
        siteId: body.siteId,
        action: 'apply',
        error: 'This job is not currently waiting for edit approval.',
      };
    }
    if (!control.confirmationGate || state.status !== 'awaiting_confirmation') {
      return {
        accepted: false,
        resumed: false,
        jobId: body.jobId,
        siteId: body.siteId,
        action: 'apply',
        error: 'The pipeline is not paused at the confirmation gate.',
      };
    }

    control.confirmationGate.resolve({ action: 'apply' });
    control.confirmationGate = undefined;
    return {
      accepted: true,
      resumed: true,
      jobId: body.jobId,
      siteId: body.siteId,
      action: 'apply',
    };
  }

  async skipPendingEditRequest(body: SkipPendingEditRequestDto): Promise<{
    accepted: boolean;
    resumed: boolean;
    jobId: string;
    siteId: string;
    action: 'skip';
    error?: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }
    const control = this.controls.get(body.jobId);
    if (!control?.pendingEditRequest || !control.pendingEditApproval) {
      return {
        accepted: false,
        resumed: false,
        jobId: body.jobId,
        siteId: body.siteId,
        action: 'skip',
        error: 'This job is not currently waiting for edit approval.',
      };
    }
    if (!control.confirmationGate || state.status !== 'awaiting_confirmation') {
      return {
        accepted: false,
        resumed: false,
        jobId: body.jobId,
        siteId: body.siteId,
        action: 'skip',
        error: 'The pipeline is not paused at the confirmation gate.',
      };
    }

    control.confirmationGate.resolve({ action: 'skip' });
    control.confirmationGate = undefined;
    return {
      accepted: true,
      resumed: true,
      jobId: body.jobId,
      siteId: body.siteId,
      action: 'skip',
    };
  }

  async undoLastReactEdit(body: { jobId: string; siteId: string }): Promise<{
    undone: boolean;
    jobId: string;
    siteId: string;
    componentFile?: string;
    error?: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }

    const backup = this.reactVisualEdit.undoLast(body.jobId);
    if (!backup) {
      return {
        undone: false,
        jobId: body.jobId,
        siteId: body.siteId,
        error: 'No edit to undo',
      };
    }

    try {
      await writeFile(backup.filePath, backup.code, 'utf-8');
      this.logger.log(
        `[visual-edit:undo] job=${body.jobId} restored ${backup.filePath}`,
      );
      return {
        undone: true,
        jobId: body.jobId,
        siteId: body.siteId,
        componentFile: backup.filePath,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown');
      return {
        undone: false,
        jobId: body.jobId,
        siteId: body.siteId,
        error: message,
      };
    }
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
      control.confirmationGate?.reject(
        new PipelineControlError('stopped', 'Pipeline was stopped by the user'),
      );
      control.confirmationGate = undefined;
      await this.stopPreviewProcesses(control.preview);
    }
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
      control.confirmationGate?.reject(
        new PipelineControlError('deleted', 'Pipeline was deleted by the user'),
      );
      control.confirmationGate = undefined;
      await this.stopPreviewProcesses(control.preview);
    }

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

  private createPendingEditApprovalGate(): PendingEditApprovalGate {
    let resolve!: (decision: PendingEditDecision) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<PendingEditDecision>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
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
        label: 'Await Or Apply Requested Edits',
        activeMessage:
          'Waiting for user approval or applying the approved edit request to the running preview.',
        doneMessage: 'Requested edit handling is complete for this preview.',
      };
    }

    if (name === '9_visual_compare') {
      const editApplied = jobId
        ? Boolean(this.controls.get(jobId)?.editApplied)
        : false;
      return {
        ...baseMeta,
        label: editApplied
          ? 'Evaluate Edited Preview Metrics'
          : 'Evaluate Baseline Preview Metrics',
        activeMessage: editApplied
          ? 'Calling backend automation to compare the edited preview against WordPress.'
          : 'Calling backend automation to compare the baseline React preview against WordPress before any pending edit is approved.',
        doneMessage: editApplied
          ? 'Final compare metrics for the edited preview have been collected.'
          : 'Final compare metrics for the baseline React preview have been collected.',
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
    editRequestContext?: ResolvedEditRequestContext,
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
      fullComponentRegenerations: [],
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
          if (detection.type !== 'fse') {
            throw new Error(
              `Unsupported theme type "${detection.type}" for slug "${repoResult.themeManifest.themeTypeHints.themeSlug}". This pipeline currently supports only FSE themes.`,
            );
          }
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
      repoResult.themeManifest.uagbSummary = this.buildMergedUagbSummary({
        manifest: repoResult.themeManifest,
        content,
        resolvedSource,
      });
      await this.recordUagbRuntimeAnalysis(logPath, repoResult.themeManifest);
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
      const overlaidTheme = this.dbTemplateOverlay.apply(
        normalizedTheme,
        content,
      );
      if (overlaidTheme !== normalizedTheme) {
        normalizedTheme = await this.normalizer.normalize(overlaidTheme);
        await this.logToFile(
          logPath,
          `[Stage 2] Applied DB template overlay from wp_template/wp_template_part before planner.`,
        );
      }

      // ── Stage 3: Planner (C1 → C2 → C3 → C4 → C5 → C6 retry) ────────────
      // All 4 phases + plan review + retry loop are ONE atomic step.
      // Per diagram: C4 (Plan Review) and C5 (Plan Valid?) live INSIDE the Planner subgraph.
      const MAX_PLAN_RETRIES = 3;
      const strictPlanReview =
        this.configService.get<boolean>('planner.strictReview') ?? true;
      const expectedTemplateNames = this.planner.getExpectedTemplateNames(
        normalizedTheme,
        content,
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
          let planAttempt = 1;
          let planBlockingIssues = collectPlanReviewBlockingIssues(
            review,
            strictPlanReview,
            'architecture',
          );
          await this.planner.writeArtifact(
            logPath,
            `plan.attempt-${planAttempt}.json`,
            {
              stage: 'planner-attempt-reviewed',
              generatedAt: new Date().toISOString(),
              attempt: planAttempt,
              isValid: planBlockingIssues.length === 0,
              errors: review.errors,
              warnings: review.warnings,
              blockingIssues: planBlockingIssues,
              strictReview: strictPlanReview,
              plan: review.plan,
            },
          );

          // C5 → C6 retry loop: if plan invalid, loop back to C1
          for (
            let attempt = 2;
            attempt <= MAX_PLAN_RETRIES && planBlockingIssues.length > 0;
            attempt++
          ) {
            await this.planner.writeArtifact(
              logPath,
              `plan.attempt-${planAttempt}.invalid.json`,
              {
                stage: 'planner-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: planAttempt,
                errors: review.errors,
                warnings: review.warnings,
                blockingIssues: planBlockingIssues,
                strictReview: strictPlanReview,
                plan: review.plan,
              },
            );
            summaryDraft.retries.plannerReview += 1;
            this.logger.warn(
              `[${jobId}] [Stage 3: Phase D] Plan blocked (attempt ${attempt - 1}/${MAX_PLAN_RETRIES}): ${planBlockingIssues.join('; ')} — retrying Phases A→C`,
            );
            await this.logToFile(
              logPath,
              `[Stage 3: C6 Retry] attempt ${attempt}: ${planBlockingIssues.join('; ')}`,
            );
            this.emitStepProgress(
              state,
              '5_planner',
              0.35,
              `Planner retry ${attempt}/${MAX_PLAN_RETRIES}: rebuilding routes, data needs, and visual sections after review feedback.`,
            );
            this.logger.log(
              `[${jobId}] [Stage 3: Phase D] Starting planner attempt ${attempt}/${MAX_PLAN_RETRIES}`,
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
                planReviewErrors: planBlockingIssues,
              },
            );
            review = this.planReviewer.review(
              plan,
              expectedTemplateNames,
              repoResult.themeManifest,
            );
            planAttempt = attempt;
            planBlockingIssues = collectPlanReviewBlockingIssues(
              review,
              strictPlanReview,
              'architecture',
            );
            await this.planner.writeArtifact(
              logPath,
              `plan.attempt-${planAttempt}.json`,
              {
                stage: 'planner-attempt-reviewed',
                generatedAt: new Date().toISOString(),
                attempt: planAttempt,
                isValid: planBlockingIssues.length === 0,
                errors: review.errors,
                warnings: review.warnings,
                blockingIssues: planBlockingIssues,
                strictReview: strictPlanReview,
                plan: review.plan,
              },
            );
            this.emitStepProgress(
              state,
              '5_planner',
              0.55,
              `Planner retry ${attempt}/${MAX_PLAN_RETRIES}: re-running consistency review on the regenerated architecture plan.`,
            );
          }

          if (planBlockingIssues.length > 0) {
            await this.planner.writeArtifact(
              logPath,
              `plan.attempt-${planAttempt}.invalid.json`,
              {
                stage: 'planner-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: planAttempt,
                errors: review.errors,
                warnings: review.warnings,
                blockingIssues: planBlockingIssues,
                strictReview: strictPlanReview,
                plan: review.plan,
              },
            );
            throw new Error(
              `[Stage 3] Plan still blocked after ${MAX_PLAN_RETRIES} attempts: ${planBlockingIssues.join('; ')}`,
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
          let visualAttempt = 1;
          let visualBlockingIssues = collectPlanReviewBlockingIssues(
            visualReview,
            strictPlanReview,
            'visual',
          );
          await this.planner.writeArtifact(
            logPath,
            `plan.visual-attempt-${visualAttempt}.json`,
            {
              stage: 'visual-plan-attempt-reviewed',
              generatedAt: new Date().toISOString(),
              attempt: visualAttempt,
              isValid: visualBlockingIssues.length === 0,
              errors: visualReview.errors,
              warnings: visualReview.warnings,
              blockingIssues: visualBlockingIssues,
              strictReview: strictPlanReview,
              plan: visualReview.plan,
            },
          );
          await this.planner.writeSplitComponentPlanArtifacts(
            logPath,
            `plan.visual-attempt-${visualAttempt}`,
            {
              stage: 'visual-plan-attempt-reviewed',
              generatedAt: new Date().toISOString(),
              attempt: visualAttempt,
              isValid: visualBlockingIssues.length === 0,
              errors: visualReview.errors,
              warnings: visualReview.warnings,
              blockingIssues: visualBlockingIssues,
              strictReview: strictPlanReview,
              plan: visualReview.plan,
            },
          );
          for (
            let vAttempt = 2;
            vAttempt <= MAX_VISUAL_RETRIES && visualBlockingIssues.length > 0;
            vAttempt++
          ) {
            await this.planner.writeArtifact(
              logPath,
              `plan.visual-attempt-${visualAttempt}.invalid.json`,
              {
                stage: 'visual-plan-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
            await this.planner.writeSplitComponentPlanArtifacts(
              logPath,
              `plan.visual-attempt-${visualAttempt}.invalid`,
              {
                stage: 'visual-plan-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
            summaryDraft.retries.visualPlanReview += 1;
            this.logger.warn(
              `[${jobId}] [Stage 3: Visual Plan] Review blocked (attempt ${vAttempt - 1}/${MAX_VISUAL_RETRIES}): ${visualBlockingIssues.join('; ')} — retrying attachVisualPlans`,
            );
            await this.logToFile(
              logPath,
              `[Stage 3: Visual Plan Retry] attempt ${vAttempt}: ${visualBlockingIssues.join('; ')}`,
            );
            this.emitStepProgress(
              state,
              '5_planner',
              0.82,
              `Visual plan retry ${vAttempt}/${MAX_VISUAL_RETRIES}: regenerating visual sections after consistency check failed.`,
            );
            this.logger.log(
              `[${jobId}] [Stage 3: Visual Plan] Starting visual-plan attempt ${vAttempt}/${MAX_VISUAL_RETRIES}`,
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
            visualAttempt = vAttempt;
            visualBlockingIssues = collectPlanReviewBlockingIssues(
              visualReview,
              strictPlanReview,
              'visual',
            );
            await this.planner.writeArtifact(
              logPath,
              `plan.visual-attempt-${visualAttempt}.json`,
              {
                stage: 'visual-plan-attempt-reviewed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                isValid: visualBlockingIssues.length === 0,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
            await this.planner.writeSplitComponentPlanArtifacts(
              logPath,
              `plan.visual-attempt-${visualAttempt}`,
              {
                stage: 'visual-plan-attempt-reviewed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                isValid: visualBlockingIssues.length === 0,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
          }
          if (visualBlockingIssues.length > 0) {
            await this.planner.writeArtifact(
              logPath,
              `plan.visual-attempt-${visualAttempt}.invalid.json`,
              {
                stage: 'visual-plan-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
            await this.planner.writeSplitComponentPlanArtifacts(
              logPath,
              `plan.visual-attempt-${visualAttempt}.invalid`,
              {
                stage: 'visual-plan-review-failed',
                generatedAt: new Date().toISOString(),
                attempt: visualAttempt,
                errors: visualReview.errors,
                warnings: visualReview.warnings,
                blockingIssues: visualBlockingIssues,
                strictReview: strictPlanReview,
                plan: visualReview.plan,
              },
            );
            throw new Error(
              `[Stage 3] Visual-plan synchronization failed after ${MAX_VISUAL_RETRIES} attempts: ${visualBlockingIssues.join('; ')}`,
            );
          }
          review = visualReview;
          await this.planner.writeArtifact(logPath, 'plan.final.json', {
            stage: 'planner-final',
            generatedAt: new Date().toISOString(),
            plan: review.plan,
            warnings: review.warnings,
          });
          await this.planner.writeSplitComponentPlanArtifacts(logPath, 'plan', {
            stage: 'planner-final',
            generatedAt: new Date().toISOString(),
            plan: review.plan,
            warnings: review.warnings,
          });

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
                let targetComponent = components[compIndex];
                if (
                  this.isProtectedDeterministicSharedPartial(targetComponent)
                ) {
                  const sanitized =
                    this.sanitizeProtectedDeterministicSharedPartial(
                      targetComponent,
                    );
                  if (sanitized.code !== targetComponent.code) {
                    const sanitizedValidation =
                      this.validator.collectValidationIssues([sanitized]);
                    if (sanitizedValidation.failures.length === 0) {
                      this.logger.log(
                        `[Stage 4: D4 Validator] Deterministically sanitized "${failure.component.name}" before AI fix.`,
                      );
                      await this.logToFile(
                        logPath,
                        `[Stage 4: D4 Validator] Deterministically sanitized "${failure.component.name}" before AI fix.`,
                      );
                      return {
                        compIndex,
                        component: sanitizedValidation.components[0],
                      };
                    }
                    targetComponent = sanitizedValidation.components[0];
                  }
                }
                const isProtectedDeterministicSyntaxRepair =
                  this.isProtectedDeterministicSharedPartial(targetComponent) &&
                  this.isSyntaxOnlyValidationError(failure.error);

                const fixed = await this.reactGenerator.fixComponent({
                  component: targetComponent,
                  plan: reviewResult.plan,
                  feedback: isProtectedDeterministicSyntaxRepair
                    ? `Validator syntax error for deterministic shared partial "${failure.component.name}":\n${failure.error}\n\nReturn a complete corrected TSX component. Preserve the existing structure and content exactly where possible; only repair syntax / TSX structure issues required by the validator.`
                    : `Validator contract error for component "${failure.component.name}":\n${failure.error}\n\nReturn a complete corrected TSX component that satisfies the validator rules.`,
                  modelConfig: { fixAgent: resolvedModels.fixAgent },
                  logPath,
                  fixMode: isProtectedDeterministicSyntaxRepair
                    ? 'syntax-only'
                    : 'full',
                });
                const revalidated = this.validator.collectValidationIssues([
                  fixed,
                ]);
                if (revalidated.failures.length > 0) {
                  const retryError = revalidated.failures[0]?.error;
                  if (
                    retryError &&
                    this.shouldRetryWithFullComponentRegeneration(retryError)
                  ) {
                    const regenerationDiagnostics =
                      this.extractFullComponentRegenerationDiagnostics(
                        retryError,
                      );
                    this.logger.warn(
                      `[Stage 4: D4 Validator] "${failure.component.name}" still failed after fix with section/content fidelity errors. Attempting full component regeneration. ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )}`,
                    );
                    await this.logToFile(
                      logPath,
                      `[Stage 4: D4 Validator] "${failure.component.name}" still failed after fix with section/content fidelity errors. Attempting full component regeneration. ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )}\n${retryError}`,
                    );
                    const regenerated = await this.reactGenerator.fixComponent({
                      component: targetComponent,
                      plan: reviewResult.plan,
                      feedback:
                        this.buildFullComponentRegenerationFeedback(
                          failure.component.name,
                          retryError,
                          regenerationDiagnostics,
                        ),
                      modelConfig: { fixAgent: resolvedModels.fixAgent },
                      logPath,
                      fixMode: 'full',
                    });
                    const regeneratedValidation =
                      this.validator.collectValidationIssues([regenerated]);
                    if (regeneratedValidation.failures.length === 0) {
                      this.recordFullComponentRegenerationSummary(
                        summaryDraft,
                        {
                          stage: 'stage4-validator-fix',
                          componentName: failure.component.name,
                          diagnostics: regenerationDiagnostics,
                          outcome: 'succeeded',
                          triggerError: retryError,
                        },
                      );
                      return {
                        compIndex,
                        component: regeneratedValidation.components[0],
                      };
                    }
                    const regeneratedError =
                      regeneratedValidation.failures[0]?.error;
                    this.recordFullComponentRegenerationSummary(summaryDraft, {
                      stage: 'stage4-validator-fix',
                      componentName: failure.component.name,
                      diagnostics: regenerationDiagnostics,
                      outcome: 'failed',
                      triggerError: retryError,
                      finalError: regeneratedError,
                    });
                    this.logger.warn(
                      `[Stage 4: D4 Validator] Full regeneration still failed for "${failure.component.name}". ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )} Error: ${regeneratedError}`,
                    );
                    await this.logToFile(
                      logPath,
                      `[Stage 4: D4 Validator] Full regeneration still failed for "${failure.component.name}". ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )} Error: ${regeneratedError}`,
                    );
                  }
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

          const toleratedValidationFailures = validation.failures.filter(
            (failure) =>
              this.shouldTolerateProtectedDeterministicSharedPartialFailure(
                failure.component,
                failure.error,
              ),
          );
          if (toleratedValidationFailures.length > 0) {
            const toleratedSummary = toleratedValidationFailures
              .map(
                (failure) =>
                  `"${failure.component.name}": ${failure.error.split('\n')[0]}`,
              )
              .join('; ');
            this.logger.warn(
              `[Stage 4: D4 Validator] Tolerating ${toleratedValidationFailures.length} protected deterministic shared partial validation warning(s): ${toleratedSummary}`,
            );
            await this.logToFile(
              logPath,
              `[Stage 4: D4 Validator] Tolerating ${toleratedValidationFailures.length} protected deterministic shared partial validation warning(s): ${toleratedSummary}`,
            );
          }
          const fatalValidationFailures = validation.failures.filter(
            (failure) =>
              !this.shouldTolerateProtectedDeterministicSharedPartialFailure(
                failure.component,
                failure.error,
              ),
          );
          if (fatalValidationFailures.length > 0) {
            throw new Error(
              `[validator] Generated component validation failed after auto-fix:\n${fatalValidationFailures
                .map(
                  (failure) =>
                    `Component "${failure.component.name}": ${failure.error}`,
                )
                .join('\n')}`,
            );
          }

          // Deterministic components (Header, Footer, Sidebar, Page404, etc.) were
          // generated entirely by CodeGeneratorService — no LLM TSX gen involved.
          // Protected shared partials are syntax-checked and syntax-fixed in Stage 4.
          // Focused edit-request refinements run later, after the baseline preview is live.
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
                });
                const revalidated = this.validator.collectValidationIssues([
                  fixed,
                ]);
                if (revalidated.failures.length > 0) {
                  const validationErr = revalidated.failures[0]?.error;
                  if (
                    validationErr &&
                    this.shouldRetryWithFullComponentRegeneration(validationErr)
                  ) {
                    const regenerationDiagnostics =
                      this.extractFullComponentRegenerationDiagnostics(
                        validationErr,
                      );
                    this.logger.warn(
                      `[Stage 5: Fix Loop] "${failure.componentName}" still failed after fix with section/content fidelity errors. Attempting full component regeneration. ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )}`,
                    );
                    await this.logToFile(
                      logPath,
                      `[Stage 5: Fix Loop] "${failure.componentName}" still failed after fix with section/content fidelity errors. Attempting full component regeneration. ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )}\n${validationErr}`,
                    );
                    const regenerated = await this.reactGenerator.fixComponent({
                      component: aiComponents[compIndex],
                      plan: reviewResult.plan,
                      feedback:
                        this.buildFullComponentRegenerationFeedback(
                          failure.componentName,
                          validationErr,
                          regenerationDiagnostics,
                        ),
                      modelConfig: { fixAgent: resolvedModels.fixAgent },
                      logPath,
                      fixMode: 'full',
                    });
                    const regeneratedValidation =
                      this.validator.collectValidationIssues([regenerated]);
                    if (regeneratedValidation.failures.length === 0) {
                      this.recordFullComponentRegenerationSummary(
                        summaryDraft,
                        {
                          stage: 'stage5-review-fix',
                          componentName: failure.componentName,
                          diagnostics: regenerationDiagnostics,
                          outcome: 'succeeded',
                          triggerError: validationErr,
                        },
                      );
                      return {
                        compIndex,
                        component: regeneratedValidation.components[0],
                      };
                    }
                    const regeneratedErr =
                      regeneratedValidation.failures[0]?.error;
                    this.recordFullComponentRegenerationSummary(summaryDraft, {
                      stage: 'stage5-review-fix',
                      componentName: failure.componentName,
                      diagnostics: regenerationDiagnostics,
                      outcome: 'failed',
                      triggerError: validationErr,
                      finalError: regeneratedErr,
                    });
                    this.logger.warn(
                      `[Stage 5: Fix Loop] Full regeneration still failed for "${failure.componentName}" — keeping original. ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )} Error: ${regeneratedErr}`,
                    );
                    await this.logToFile(
                      logPath,
                      `[Stage 5: Fix Loop] Full regeneration still failed for "${failure.componentName}". ${this.formatFullComponentRegenerationDiagnostics(
                        regenerationDiagnostics,
                      )} Error: ${regeneratedErr}`,
                    );
                  }
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

          const postReviewValidation =
            this.validator.collectValidationIssues(components);
          const fatalPostReviewFailures = postReviewValidation.failures.filter(
            (failure) =>
              !this.shouldTolerateProtectedDeterministicSharedPartialFailure(
                failure.component,
                failure.error,
              ),
          );
          if (fatalPostReviewFailures.length > 0) {
            throw new Error(
              `[validator] Generated component validation failed after AI review/fix:\n${fatalPostReviewFailures
                .map(
                  (failure) =>
                    `Component "${failure.component.name}": ${failure.error}`,
                )
                .join('\n')}`,
            );
          }
          components = postReviewValidation.components;

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
                repoManifest: repoResult.themeManifest,
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
                  const targetComponent = buildComponents[idx];
                  const fixed = await this.reactGenerator.fixComponent({
                    component: targetComponent,
                    plan: reviewResult.plan,
                    feedback: this.isProtectedDeterministicSharedPartial(
                      targetComponent,
                    )
                      ? `TypeScript build error in deterministic shared partial "${componentName}":\n${error}\n\nPreserve the current structure and content. Repair only the TypeScript / TSX / import issue that prevents the preview build from succeeding.`
                      : `TypeScript build error:\n${error}`,
                    modelConfig: { fixAgent: resolvedModels.fixAgent },
                    logPath,
                    fixMode: this.isProtectedDeterministicSharedPartial(
                      targetComponent,
                    )
                      ? 'syntax-only'
                      : 'full',
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
        runtimeControl.buildComponents = buildComponents;
        runtimeControl.approvedPlan = reviewResult.plan;
        runtimeControl.previewTokens =
          'tokens' in normalizedTheme
            ? ((normalizedTheme as { tokens?: ThemeTokens }).tokens ??
              undefined)
            : undefined;
        runtimeControl.fixAgentModel = resolvedModels.fixAgent;
      }
      state.result = {
        ...(state.result ?? {}),
        previewDir: preview.previewDir,
        frontendDir: preview.frontendDir,
        previewUrl: preview.previewUrl,
        apiBaseUrl: preview.apiBaseUrl,
        previewStage: 'baseline',
        hasEditRequest,
        editApprovalRequired: hasEditRequest,
        editApplied: false,
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
            ? 'Baseline preview is live. The requested edit has been stored and is now waiting for explicit user approval.'
            : 'Preview is live and ready for inspection.',
          data: this.buildPreviewEventData({
            preview,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: hasEditRequest,
            editApplied: false,
          }),
        });
      }
      if (hasEditRequest) {
        const runtimeControl = this.controls.get(jobId);
        const approvalGate = this.createPendingEditApprovalGate();
        if (runtimeControl) {
          runtimeControl.confirmationGate = approvalGate;
        }
        state.status = 'awaiting_confirmation';
        const editApprovalData = {
          ...this.buildPreviewEventData({
            preview,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: true,
            editApplied: false,
          }),
          ...(this.buildEditRequestProgressData({
            request: dto.editRequest,
            title: 'Baseline preview is waiting for edit approval',
            summary:
              'The baseline React preview is ready. The requested edit has been stored, but it will only be applied after the user explicitly approves it from the frontend.',
          }) ?? {}),
        };
        this.rememberStepEventData(jobId, '8b_edit_request', editApprovalData);
        this.progress.get(jobId)?.next({
          step: '8b_edit_request',
          label: this.getStepMeta('8b_edit_request', jobId).label,
          status: 'pending',
          percent: this.calcPercentThrough('8b_edit_request', jobId),
          message:
            'Requested edit is pending user approval. The pipeline is paused until the user chooses Apply or Skip.',
          data: editApprovalData,
        });

        const decision = await approvalGate.promise;
        if (runtimeControl) {
          runtimeControl.confirmationGate = undefined;
        }
        state.status = 'running';

        if (decision.action === 'apply') {
          await this.runStep(state, '8b_edit_request', logPath, async () => {
            this.emitStepProgress(
              state,
              '8b_edit_request',
              0.12,
              'Reviewing the approved edit request against the generated React baseline.',
              this.buildEditRequestProgressData({
                request: dto.editRequest,
                title: 'Applying the approved user edit request',
                summary:
                  'The user approved the pending edit request. The pipeline is now applying those visual changes to the React preview.',
              }),
            );
            const editPassResult = await this.applyPostMigrationEditPass({
              jobId,
              state,
              stepName: '8b_edit_request',
              request: dto.editRequest,
              editRequestContext,
              plan: reviewResult.plan,
              components: buildComponents,
              fixAgentModel: resolvedModels.fixAgent,
              logPath,
              applyProgress: 0.38,
              reviewProgress: 0.58,
              refixProgress: 0.72,
            });
            // After edit-request the original visual plan is no longer
            // authoritative — user may have added/removed/changed sections.
            // Strip it so downstream validation doesn't reject intentional changes.
            buildComponents = editPassResult.components.map((comp) => ({
              ...comp,
              visualPlan: undefined,
            }));

            if (!editPassResult.applied) {
              const approvalControl = this.controls.get(jobId);
              if (approvalControl) {
                approvalControl.pendingEditApproval = false;
                approvalControl.editApplied = false;
              }
              this.emitStepProgress(
                state,
                '8b_edit_request',
                0.92,
                'No targeted edit mutations were required after reviewing the approved edit request.',
              );
              return { applied: false, taskCount: 0 };
            }

            this.emitStepProgress(
              state,
              '8b_edit_request',
              0.82,
              `Syncing ${editPassResult.taskCount} approved edit update(s) into the running preview.`,
            );
            await this.previewBuilder.syncGeneratedComponents(
              preview.previewDir,
              buildComponents,
              'tokens' in normalizedTheme
                ? (normalizedTheme as any).tokens
                : undefined,
            );
            await this.validator.assertPreviewBuild(preview.frontendDir);
            await this.validator.assertPreviewRuntime(
              preview.previewUrl,
              preview.routeEntries.map((entry) => entry.route),
            );
            const approvalControl = this.controls.get(jobId);
            if (approvalControl) {
              approvalControl.pendingEditApproval = false;
              approvalControl.editApplied = true;
            }
            this.emitStepProgress(
              state,
              '8b_edit_request',
              0.94,
              'Approved edits are now visible in the running preview.',
              {
                ...this.buildPreviewEventData({
                  preview,
                  previewStage: 'edited',
                  hasEditRequest,
                  editApprovalRequired: false,
                  editApplied: true,
                }),
                ...(this.buildEditRequestProgressData({
                  request: dto.editRequest,
                  title: 'Approved edits are now visible in preview',
                  summary:
                    'The approved edit request has been applied and synced into the live React preview.',
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
              editApprovalRequired: false,
              editApplied: true,
              uiSourceMapPath: preview.uiSourceMapPath,
              routeEntries: preview.routeEntries,
            };
            return { applied: true, taskCount: editPassResult.taskCount };
          });
        } else {
          const editStep = state.steps.find(
            (step) => step.name === '8b_edit_request',
          );
          if (editStep) {
            editStep.status = 'skipped';
          }
          const approvalControl = this.controls.get(jobId);
          if (approvalControl) {
            approvalControl.pendingEditApproval = false;
            approvalControl.editApplied = false;
          }
          this.progress.get(jobId)?.next({
            step: '8b_edit_request',
            label: this.getStepMeta('8b_edit_request', jobId).label,
            status: 'skipped',
            percent: this.calcPercentThrough('8b_edit_request', jobId),
            message:
              'The user skipped the pending edit request. The pipeline will continue with baseline metrics and completion.',
            data: {
              ...editApprovalData,
              editApprovalRequired: false,
              editApplied: false,
            },
          });
          state.result = {
            ...(state.result ?? {}),
            previewDir: preview.previewDir,
            frontendDir: preview.frontendDir,
            previewUrl: preview.previewUrl,
            apiBaseUrl: preview.apiBaseUrl,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: false,
            editApplied: false,
            uiSourceMapPath: preview.uiSourceMapPath,
            routeEntries: preview.routeEntries,
          };
        }
      }
      await stepDelay();

      await this.runStep(state, '9_visual_compare', logPath, async () => {
        const wpBaseUrl = content.siteInfo.siteUrl || 'http://localhost:8000/';
        const reactBeUrl = preview.apiBaseUrl.replace(/\/api\/?$/, '');
        const previewTokens =
          'tokens' in normalizedTheme
            ? ((normalizedTheme as { tokens?: ThemeTokens }).tokens ??
              undefined)
            : undefined;

        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.2,
          'Calling backend automation for final site compare metrics.',
        );

        try {
          metrics = await this.compareSiteWithAutomation({
            siteId,
            wpBaseUrl,
            reactFeUrl: preview.previewUrl,
            reactBeUrl,
          });
          if (metrics) {
            await this.logAutomationCompareMetrics(logPath, 'initial', metrics);
          }
        } catch (err: any) {
          this.logger.error(
            `[site-compare] failed — ${err?.message ?? err}`,
            err?.response?.data ?? err?.stack,
          );
        }

        if (metrics) {
          const visualRepairResult = await this.applyVisualMetricsRepairPass({
            state,
            stepName: '9_visual_compare',
            metrics,
            preview,
            components: buildComponents,
            plan: reviewResult.plan,
            content,
            tokens: previewTokens,
            fixAgentModel: resolvedModels.fixAgent,
            logPath,
          });
          buildComponents = visualRepairResult.components;

          if (visualRepairResult.applied) {
            try {
              metrics = await this.compareSiteWithAutomation({
                siteId,
                wpBaseUrl,
                reactFeUrl: preview.previewUrl,
                reactBeUrl,
              });
              if (metrics) {
                await this.logAutomationCompareMetrics(
                  logPath,
                  'after-repair',
                  metrics,
                );
              }
            } catch (err: any) {
              this.logger.error(
                `[site-compare] re-run after visual repair failed — ${err?.message ?? err}`,
                err?.response?.data ?? err?.stack,
              );
            }
          }
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
                previewStage:
                  hasEditRequest && this.controls.get(jobId)?.editApplied
                    ? 'edited'
                    : 'baseline',
                hasEditRequest,
                editApprovalRequired: Boolean(
                  this.controls.get(jobId)?.pendingEditApproval,
                ),
                editApplied: Boolean(this.controls.get(jobId)?.editApplied),
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
          previewStage:
            hasEditRequest && this.controls.get(jobId)?.editApplied
              ? 'edited'
              : 'baseline',
          hasEditRequest,
          editApprovalRequired: Boolean(
            this.controls.get(jobId)?.pendingEditApproval,
          ),
          editApplied: Boolean(this.controls.get(jobId)?.editApplied),
          uiSourceMapPath: preview.uiSourceMapPath,
          routeEntries: preview.routeEntries,
          metrics,
        };
        const compareControl = this.controls.get(jobId);
        if (compareControl) {
          compareControl.buildComponents = buildComponents;
        }

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
        const completedControl = this.controls.get(jobId);
        if (completedControl) {
          completedControl.buildComponents = buildComponents;
          completedControl.approvedPlan = reviewResult.plan;
        }
        state.result = {
          runSummaryPath: logPath,
          previewDir: preview.previewDir,
          frontendDir: preview.frontendDir,
          previewUrl: preview.previewUrl,
          apiBaseUrl: preview.apiBaseUrl,
          previewStage: 'final',
          hasEditRequest,
          editApprovalRequired: Boolean(
            this.controls.get(jobId)?.pendingEditApproval,
          ),
          editApplied: Boolean(this.controls.get(jobId)?.editApplied),
          uiSourceMapPath: preview.uiSourceMapPath,
          routeEntries: preview.routeEntries,
          ownerCaptureTargets,
          exactCaptureTargets,
          dbCreds,
          metrics,
          plan: reviewResult.plan,
        };
        const migrationNotification =
          await this.notifyAutomationMigrationCompleted({
            siteId,
            jobId,
            logPath,
          });
        if (migrationNotification) {
          state.result = {
            ...(state.result ?? {}),
            migrationNotification,
          };
        }
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
            editApprovalRequired: Boolean(
              this.controls.get(jobId)?.pendingEditApproval,
            ),
            editApplied: Boolean(this.controls.get(jobId)?.editApplied),
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
    let activeSlug: string | undefined;
    try {
      activeSlug = await this.wpQuery.getActiveTheme(dbConnectionString);
    } catch (err: any) {
      this.logger.warn(`Could not query active theme from DB: ${err.message}`);
    }

    return this.themeRepoLayoutResolver.resolve({
      repoRoot,
      activeSlug,
    });
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

    this.logger.log(`Cloning theme repo: ${repoUrl} → ${destDir}`);
    await cloneRepoWithRetry({
      repoUrl,
      token,
      destDir,
      logger: this.logger,
      label: `theme clone:${jobId}`,
    });
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
    const uagbSummaryLines = this.buildUagbSummaryLines(manifest);

    return [
      `kind=${manifest.themeTypeHints.detectedThemeKind}, themeFiles=${repoResult.totalFiles}, themeInventoryFiles=${repoResult.themeInventoryFiles}, themes=${repoResult.themeCount}, pluginFiles=${repoResult.pluginFiles}, plugins=${repoResult.pluginCount}, templates=${manifest.filesByRole.templates.length}, parts=${manifest.filesByRole.templateParts.length}, patterns=${manifest.filesByRole.patterns.length}, phpTemplates=${manifest.filesByRole.phpTemplates.length}, css=${manifest.filesByRole.styles.length}, assets=${assetCount}`,
      `theme.json: palette=${manifest.themeJsonSummary.paletteCount}, fontFamilies=${manifest.themeJsonSummary.fontFamilyCount}, fontSizes=${manifest.themeJsonSummary.fontSizeCount}, spacing=${manifest.themeJsonSummary.spacingSizeCount}, customTemplates=${manifest.themeJsonSummary.customTemplateCount}`,
      `runtime: menus=${manifest.runtimeHints.registeredMenus.length}, sidebars=${manifest.runtimeHints.registeredSidebars.length}, supports=${manifest.runtimeHints.themeSupports.join(', ') || 'none'}`,
      `structure: partRefs=${manifest.structureHints.templatePartRefs.length}, patternRefs=${manifest.structureHints.patternRefs.length}, notableBlocks=${notableBlocks.join(', ') || 'none'}, priorityDirs=${manifest.sourceOfTruth.priorityDirectories.join(', ') || 'root-only'}, themeDirs=${manifest.sourceOfTruth.themeDirectories.join(', ') || 'none'}, pluginDirs=${manifest.sourceOfTruth.pluginDirectories.join(', ') || 'none'}`,
      ...uagbSummaryLines,
      ...(manifest.resolvedSource
        ? [
            `resolved: activeTheme=${manifest.resolvedSource.activeTheme.slug}${manifest.resolvedSource.parentTheme ? `, parentTheme=${manifest.resolvedSource.parentTheme.slug}` : ''}, activePlugins=${manifest.resolvedSource.activePlugins.length}, runtimeOnlyPlugins=${manifest.resolvedSource.runtimeOnlyPlugins.length}, repoOnlyPlugins=${manifest.resolvedSource.repoOnlyPlugins.length}`,
          ]
        : []),
    ];
  }

  private buildUagbSummaryLines(manifest: RepoThemeManifest): string[] {
    const summary = manifest.uagbSummary;
    if (!summary?.detected) {
      return [];
    }

    const usages = summary.source.files;
    const lines = [
      `uagb: files=${usages.length}, blocks=${summary.mergedBlockTypes.join(', ') || 'none'}, plugins=${summary.mergedPluginSlugs.join(', ') || 'none'}`,
    ];

    const homeBases = new Set(['frontend-page', 'home', 'index']);
    const homeUsages = usages.filter((usage) =>
      homeBases.has(this.toTemplateBaseName(usage.file)),
    );
    if (homeUsages.length > 0) {
      lines.push(`uagb-home: ${this.formatUagbUsageEntries(homeUsages, 4)}`);
    }

    const dbHomeUsage =
      summary.db.pages.find((entry) => entry.isHome) ??
      summary.db.templates.find((entry) => entry.isHome);
    if (dbHomeUsage) {
      lines.push(
        `uagb-db-home: ${dbHomeUsage.entityType}:${dbHomeUsage.slug}=[${dbHomeUsage.blockTypes.join(', ')}]`,
      );
    }

    const otherPageUsages = usages.filter(
      (usage) =>
        !homeBases.has(this.toTemplateBaseName(usage.file)) &&
        !/^(parts|template-parts|patterns)\//i.test(usage.file),
    );
    if (otherPageUsages.length > 0) {
      lines.push(
        `uagb-other: ${this.formatUagbUsageEntries(otherPageUsages, 6)}`,
      );
    }
    const otherDbTemplates = summary.db.templates.filter(
      (entry) => !entry.isHome,
    );
    if (otherDbTemplates.length > 0) {
      lines.push(
        `uagb-db-templates: ${otherDbTemplates
          .slice(0, 6)
          .map(
            (entry) =>
              `${entry.slug}=[${entry.blockTypes.join(', ') || 'none'}]`,
          )
          .join(
            '; ',
          )}${otherDbTemplates.length > 6 ? ` (+${otherDbTemplates.length - 6} more)` : ''}`,
      );
    }

    return lines;
  }

  private buildMergedUagbSummary(input: {
    manifest: RepoThemeManifest;
    content: {
      pages: Array<{
        id: number;
        title: string;
        slug: string;
        content: string;
      }>;
      dbTemplates: Array<{
        id: number;
        slug: string;
        title: string;
        content: string;
        postType: 'wp_template' | 'wp_template_part';
      }>;
      readingSettings: {
        showOnFront: 'posts' | 'page';
        pageOnFrontId: number | null;
      };
      detectedPlugins: Array<{ slug: string }>;
      discovery: {
        topBlockTypes: string[];
      };
    };
    resolvedSource: RepoResolvedSourceSummary;
  }): RepoUagbDetectionSummary {
    const { manifest, content, resolvedSource } = input;
    const sourceFiles = manifest.structureHints.uagbUsages ?? [];
    const sourceBlockTypes = [
      ...new Set(sourceFiles.flatMap((usage) => usage.blockTypes)),
    ].sort();

    const dbPages = content.pages
      .map((page) => ({
        id: page.id,
        slug: page.slug || String(page.id),
        title: page.title,
        blockTypes: this.extractUagbBlockTypes(page.content),
        source: 'db' as const,
        entityType: 'page' as const,
        isHome:
          content.readingSettings.showOnFront === 'page' &&
          content.readingSettings.pageOnFrontId === page.id,
      }))
      .filter((page) => page.blockTypes.length > 0);

    const dbTemplates = content.dbTemplates
      .filter((row) => row.postType === 'wp_template')
      .map((row) => ({
        id: row.id,
        slug: row.slug || String(row.id),
        title: row.title,
        blockTypes: this.extractUagbBlockTypes(row.content),
        source: 'db' as const,
        entityType: 'template' as const,
        isHome: false,
      }))
      .filter((row) => row.blockTypes.length > 0);
    const homeTemplate = this.resolveDbHomeTemplateUsage(dbTemplates);
    if (homeTemplate) {
      homeTemplate.isHome = true;
    }

    const dbParts = content.dbTemplates
      .filter((row) => row.postType === 'wp_template_part')
      .map((row) => ({
        id: row.id,
        slug: row.slug || String(row.id),
        title: row.title,
        blockTypes: this.extractUagbBlockTypes(row.content),
        source: 'db' as const,
        entityType: 'part' as const,
        isHome: false,
      }))
      .filter((row) => row.blockTypes.length > 0);

    const dbBlockTypes = [
      ...new Set([
        ...content.discovery.topBlockTypes.filter((block) =>
          block.startsWith('uagb/'),
        ),
        ...dbPages.flatMap((page) => page.blockTypes),
        ...dbTemplates.flatMap((template) => template.blockTypes),
        ...dbParts.flatMap((part) => part.blockTypes),
      ]),
    ].sort();

    const dbDetectedPluginSlugs = [
      ...new Set(
        content.detectedPlugins
          .map((plugin) => this.normalizeUagbPluginSlug(plugin.slug))
          .filter((slug) => slug === 'ultimate-addons-for-gutenberg'),
      ),
    ].sort();

    const effectiveActivePluginSlugs = [
      ...new Set(
        resolvedSource.activePlugins
          .map((plugin) => this.normalizeUagbPluginSlug(plugin.slug))
          .filter((slug) => slug === 'ultimate-addons-for-gutenberg'),
      ),
    ].sort();

    const mergedBlockTypes = [
      ...new Set([...sourceBlockTypes, ...dbBlockTypes]),
    ].sort();
    const mergedPluginSlugs = [
      ...new Set([...dbDetectedPluginSlugs, ...effectiveActivePluginSlugs]),
    ].sort();

    return {
      detected:
        sourceFiles.length > 0 ||
        dbPages.length > 0 ||
        dbTemplates.length > 0 ||
        dbParts.length > 0 ||
        dbBlockTypes.length > 0 ||
        mergedPluginSlugs.length > 0,
      mergedBlockTypes,
      mergedPluginSlugs,
      source: {
        files: sourceFiles,
        blockTypes: sourceBlockTypes,
      },
      db: {
        detectedPluginSlugs: dbDetectedPluginSlugs,
        blockTypes: dbBlockTypes,
        pages: dbPages,
        templates: dbTemplates,
        parts: dbParts,
      },
      effective: {
        activePluginSlugs: effectiveActivePluginSlugs,
      },
    };
  }

  private async recordUagbRuntimeAnalysis(
    logPath: string,
    manifest: RepoThemeManifest,
  ): Promise<void> {
    const summary = manifest.uagbSummary;
    if (!summary?.detected) return;

    const lines: string[] = [
      `[UAGB] merged: plugins=${summary.mergedPluginSlugs.join(', ') || 'none'}, blocks=${summary.mergedBlockTypes.join(', ') || 'none'}`,
      `[UAGB] source: files=${summary.source.files.length}, blocks=${summary.source.blockTypes.join(', ') || 'none'}`,
      `[UAGB] db: detectedPlugins=${summary.db.detectedPluginSlugs.join(', ') || 'none'}, blocks=${summary.db.blockTypes.join(', ') || 'none'}, pages=${summary.db.pages.length}, templates=${summary.db.templates.length}, parts=${summary.db.parts.length}`,
      `[UAGB] effective: activePlugins=${summary.effective.activePluginSlugs.join(', ') || 'none'}`,
    ];

    const homeUsage =
      summary.db.pages.find((page) => page.isHome) ??
      summary.db.templates.find((template) => template.isHome);
    if (homeUsage) {
      lines.push(
        `[UAGB] db-home: ${homeUsage.entityType}:${homeUsage.slug || homeUsage.title || homeUsage.id}=[${homeUsage.blockTypes.join(', ')}]`,
      );
    }
    const otherPages = summary.db.pages.filter((page) => !page.isHome);
    if (otherPages.length > 0) {
      lines.push(
        `[UAGB] db-pages: ${otherPages
          .slice(0, 8)
          .map(
            (page) =>
              `${page.slug || page.title || page.id}=[${page.blockTypes.join(', ')}]`,
          )
          .join(
            '; ',
          )}${otherPages.length > 8 ? ` (+${otherPages.length - 8} more)` : ''}`,
      );
    }
    const otherTemplates = summary.db.templates.filter(
      (template) => !template.isHome,
    );
    if (otherTemplates.length > 0) {
      lines.push(
        `[UAGB] db-templates: ${otherTemplates
          .slice(0, 8)
          .map(
            (template) =>
              `${template.slug || template.title || template.id}=[${template.blockTypes.join(', ')}]`,
          )
          .join(
            '; ',
          )}${otherTemplates.length > 8 ? ` (+${otherTemplates.length - 8} more)` : ''}`,
      );
    }
    if (summary.db.parts.length > 0) {
      lines.push(
        `[UAGB] db-parts: ${summary.db.parts
          .slice(0, 8)
          .map(
            (part) =>
              `${part.slug || part.title || part.id}=[${part.blockTypes.join(', ')}]`,
          )
          .join(
            '; ',
          )}${summary.db.parts.length > 8 ? ` (+${summary.db.parts.length - 8} more)` : ''}`,
      );
    }

    for (const line of lines) {
      this.logger.log(line);
      await this.logToFile(logPath, line);
    }
  }

  private extractUagbBlockTypes(content: string): string[] {
    const blockTypes = new Set<string>();
    for (const match of String(content ?? '').matchAll(
      /<!--\s*wp:(uagb\/[a-z0-9/-]+)/gi,
    )) {
      const blockType = String(match[1] ?? '')
        .trim()
        .toLowerCase();
      if (blockType) blockTypes.add(blockType);
    }
    return [...blockTypes].sort();
  }

  private formatUagbUsageEntries(
    usages: Array<{ file: string; blockTypes: string[] }>,
    limit: number,
  ): string {
    const preview = usages
      .slice(0, limit)
      .map(
        (usage) => `${usage.file}=[${usage.blockTypes.join(', ') || 'none'}]`,
      )
      .join('; ');
    const overflow = usages.length - limit;
    return overflow > 0 ? `${preview} (+${overflow} more)` : preview;
  }

  private toTemplateBaseName(file: string): string {
    const normalized = file.replace(/\\/g, '/');
    const lastSegment = normalized.split('/').pop() ?? normalized;
    return lastSegment.replace(/\.(php|html)$/i, '').toLowerCase();
  }

  private resolveDbHomeTemplateUsage(
    templates: Array<{ slug: string; isHome?: boolean }>,
  ): { slug: string; isHome?: boolean } | null {
    const byBase = new Map<string, { slug: string; isHome?: boolean }>();
    for (const template of templates) {
      const base = this.toTemplateBaseName(template.slug);
      if (!byBase.has(base)) {
        byBase.set(base, template);
      }
    }
    for (const base of ['frontend-page', 'home', 'index']) {
      const match = byBase.get(base);
      if (match) {
        return match;
      }
    }
    return null;
  }

  private normalizeUagbPluginSlug(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'spectra') {
      return 'ultimate-addons-for-gutenberg';
    }
    return normalized;
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
      fullComponentRegenerations: summaryDraft.fullComponentRegenerations,
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
    editApprovalRequired?: boolean;
    editApplied?: boolean;
    metrics?: ProgressEventData['metrics'];
  }): ProgressEventData {
    const {
      preview,
      previewStage,
      hasEditRequest,
      editApprovalRequired,
      editApplied,
      metrics,
    } = input;
    return {
      previewUrl: preview.previewUrl,
      apiBaseUrl: preview.apiBaseUrl,
      previewStage,
      hasEditRequest,
      editApprovalRequired,
      editApplied,
      metrics,
    };
  }

  private async compareSiteWithAutomation(input: {
    siteId: string;
    wpBaseUrl: string;
    reactFeUrl: string;
    reactBeUrl: string;
  }): Promise<ProgressEventData['metrics'] | undefined> {
    const { siteId, wpBaseUrl, reactFeUrl, reactBeUrl } = input;
    const response = await lastValueFrom(
      this.httpService.post(
        `${this.configService.get<string>('automation.url', '')}/site/compare`,
        {
          siteId,
          wpSiteId: siteId,
          wpBaseUrl,
          reactFeUrl,
          reactBeUrl,
        },
      ),
    );
    return (response.data?.result ??
      response.data) as ProgressEventData['metrics'];
  }

  private async notifyAutomationMigrationCompleted(input: {
    siteId: string;
    jobId: string;
    logPath?: string;
  }): Promise<{
    requested: boolean;
    endpoint: string;
    payload: { site_id: string; job_id: string };
    responsePreview?: string;
    error?: string;
  } | null> {
    const automationUrl = this.configService
      .get<string>('automation.url', '')
      .trim()
      .replace(/\/$/, '');
    if (!automationUrl) {
      if (input.logPath) {
        await this.logToFile(
          input.logPath,
          '[Automation Migration Notify] Skipped because automation.url is empty.',
        );
      }
      return null;
    }

    const endpoint = `${automationUrl}/api/migrations`;
    const payload = {
      site_id: input.siteId,
      job_id: input.jobId,
    };

    try {
      const response = await lastValueFrom(
        this.httpService.post(endpoint, payload),
      );
      const responsePreview = truncateForLog(
        JSON.stringify(response.data ?? {}),
        500,
      );
      this.logger.log(
        `[Automation Migration Notify] POST ${endpoint} succeeded for job=${input.jobId} site=${input.siteId}`,
      );
      if (input.logPath) {
        await this.logToFile(
          input.logPath,
          `[Automation Migration Notify] POST ${endpoint} payload=${JSON.stringify(
            payload,
          )} response=${responsePreview}`,
        );
      }
      return {
        requested: true,
        endpoint,
        payload,
        responsePreview,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[Automation Migration Notify] POST ${endpoint} failed for job=${input.jobId} site=${input.siteId}: ${message}`,
      );
      if (input.logPath) {
        await this.logToFile(
          input.logPath,
          `[Automation Migration Notify] POST ${endpoint} payload=${JSON.stringify(
            payload,
          )} failed: ${message}`,
        );
      }
      return {
        requested: true,
        endpoint,
        payload,
        error: message,
      };
    }
  }

  private collectAutomationComparePages(
    metrics: unknown,
  ): AutomationComparePageResult[] {
    if (!metrics || typeof metrics !== 'object') return [];
    const pages = (metrics as { pages?: unknown }).pages;
    return Array.isArray(pages) ? (pages as AutomationComparePageResult[]) : [];
  }

  private selectVisualRepairTargets(input: {
    metrics: unknown;
    preview: PreviewBuilderResult;
    components: ReactGenerateResult['components'];
  }): Array<{
    componentName: string;
    page: AutomationComparePageResult;
    score: number;
  }> {
    const { metrics, preview, components } = input;
    const pages = this.collectAutomationComparePages(metrics);
    const componentNames = new Set(
      components.map((component) => component.name),
    );
    const bestByComponent = new Map<
      string,
      {
        componentName: string;
        page: AutomationComparePageResult;
        score: number;
      }
    >();

    for (const page of pages) {
      const visualStatus = page.visual?.status;
      const contentStatus = page.content?.status;
      const diffPct = this.coerceFiniteNumber(page.visual?.diffPct) ?? 0;
      const accuracy = this.coerceFiniteNumber(page.visual?.accuracy);
      const isActionable =
        visualStatus === '⚠️  FAIL' ||
        contentStatus === 'FAIL' ||
        contentStatus === 'MISSING' ||
        diffPct >= 8;
      if (!isActionable) continue;

      const componentName = this.resolveVisualRepairComponentName({
        page,
        preview,
        componentNames,
      });
      if (!componentName) continue;

      const priorityBoost =
        page.repairPriority === 'high'
          ? 80
          : page.repairPriority === 'medium'
            ? 40
            : 10;
      const contentPenalty =
        contentStatus === 'MISSING' ? 45 : contentStatus === 'FAIL' ? 25 : 0;
      const regionPenalty = (page.visual?.regions ?? []).reduce(
        (sum, region) =>
          sum +
          (region.severity === 'high'
            ? 20
            : region.severity === 'medium'
              ? 10
              : 3),
        0,
      );
      const score =
        priorityBoost +
        (accuracy === null ? diffPct : Math.max(0, 100 - accuracy)) +
        contentPenalty +
        regionPenalty;

      const existing = bestByComponent.get(componentName);
      if (!existing || score > existing.score) {
        bestByComponent.set(componentName, { componentName, page, score });
      }
    }

    return [...bestByComponent.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  private async logAutomationCompareMetrics(
    logPath: string,
    stage: 'initial' | 'after-repair',
    metrics: unknown,
  ): Promise<void> {
    const pages = this.collectAutomationComparePages(metrics);
    const overall =
      metrics && typeof metrics === 'object'
        ? ((metrics as { overall?: Record<string, unknown> }).overall ?? {})
        : {};
    const failingRoutes = Array.isArray(
      (overall as { failingRoutes?: unknown }).failingRoutes,
    )
      ? ((overall as { failingRoutes?: string[] }).failingRoutes ?? [])
      : [];
    const repairNeeded = this.coerceFiniteNumber(
      (overall as { repairNeeded?: unknown }).repairNeeded,
    );
    const lines: string[] = [
      `[Automation Compare] stage=${stage} pages=${pages.length} failingRoutes=${failingRoutes.length} repairNeeded=${repairNeeded ?? 'unknown'}`,
    ];

    if (failingRoutes.length > 0) {
      lines.push(
        `[Automation Compare] failing routes: ${failingRoutes.join(', ')}`,
      );
    }

    for (const page of pages.slice(0, 12)) {
      lines.push(
        `[Automation Compare] ${this.formatAutomationComparePageSummary(page)}`,
      );
    }

    if (pages.length > 12) {
      lines.push(
        `[Automation Compare] ... ${pages.length - 12} additional route(s) omitted from log summary`,
      );
    }

    await this.logToFile(logPath, lines.join('\n'));
  }

  private formatAutomationComparePageSummary(
    page: AutomationComparePageResult,
  ): string {
    const parts = [
      `route=${page.route ?? page.visual?.reactPath ?? 'unknown'}`,
      `routeKey=${page.routeKey ?? 'unknown'}`,
      `componentHint=${page.componentHint ?? 'unknown'}`,
      `visualStatus=${page.visual?.status ?? 'unknown'}`,
      `contentStatus=${page.content?.status ?? 'unknown'}`,
    ];
    if (page.visual?.accuracy !== null && page.visual?.accuracy !== undefined) {
      parts.push(`accuracy=${page.visual.accuracy}%`);
    }
    if (page.visual?.diffPct !== null && page.visual?.diffPct !== undefined) {
      parts.push(`diffPct=${page.visual.diffPct}%`);
    }
    if (
      page.visual?.overlapDiffPct !== null &&
      page.visual?.overlapDiffPct !== undefined
    ) {
      parts.push(`overlapDiffPct=${page.visual.overlapDiffPct}%`);
    }
    if (
      page.visual?.extraDiffPct !== null &&
      page.visual?.extraDiffPct !== undefined
    ) {
      parts.push(`extraDiffPct=${page.visual.extraDiffPct}%`);
    }
    if ((page.visual?.regions?.length ?? 0) > 0) {
      parts.push(`regions=${page.visual?.regions?.length ?? 0}`);
    }
    return parts.join(' | ');
  }

  private summarizeLogLines(
    lines: string[],
    limit: number,
    label: string,
  ): string {
    if (lines.length === 0) return `${label}: none`;
    if (lines.length <= limit) {
      return `${label}: ${lines.join(' || ')}`;
    }
    return `${label}: ${lines
      .slice(0, limit)
      .join(' || ')} || ... (+${lines.length - limit} more)`;
  }

  private summarizeMultilineForLog(
    value: string,
    maxLines = 12,
    maxChars = 2400,
  ): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    const normalized = trimmed
      .split('\n')
      .map((line) => line.trimEnd())
      .slice(0, maxLines)
      .join('\n');
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}\n...`;
  }

  private resolveVisualRepairComponentName(input: {
    page: AutomationComparePageResult;
    preview: PreviewBuilderResult;
    componentNames: Set<string>;
  }): string | null {
    const { page, preview, componentNames } = input;
    const route =
      this.normalizeComparableRoute(page.route) ??
      this.normalizeComparableRoute(page.visual?.reactPath) ??
      null;
    if (route) {
      const exactMatch = preview.routeEntries.find(
        (entry) => this.normalizeComparableRoute(entry.route) === route,
      );
      if (exactMatch) return exactMatch.componentName;

      const patternMatch = preview.routeEntries.find((entry) =>
        this.previewRouteMatches(entry.route, route),
      );
      if (patternMatch) return patternMatch.componentName;
    }

    const hinted = page.componentHint?.trim();
    if (hinted && componentNames.has(hinted)) return hinted;
    return null;
  }

  private normalizeComparableRoute(route?: string | null): string | null {
    if (!route) return null;
    const value = route.trim();
    if (!value) return null;
    return value.replace(/\/+$/, '') || '/';
  }

  private previewRouteMatches(pattern: string, actual: string): boolean {
    const normalizedPattern = this.normalizeComparableRoute(pattern);
    const normalizedActual = this.normalizeComparableRoute(actual);
    if (!normalizedPattern || !normalizedActual) return false;
    if (normalizedPattern === normalizedActual) return true;

    const regexSource = normalizedPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '[^/]+')
      .replace(/\\\*/g, '.*');
    return new RegExp(`^${regexSource}$`).test(normalizedActual);
  }

  private async applyVisualMetricsRepairPass(input: {
    state: PipelineStatus;
    stepName: string;
    metrics: unknown;
    preview: PreviewBuilderResult;
    components: ReactGenerateResult['components'];
    plan: PlanResult;
    content: DbContentResult;
    tokens?: ThemeTokens;
    fixAgentModel?: string;
    logPath: string;
  }): Promise<{
    components: ReactGenerateResult['components'];
    applied: boolean;
    repairedCount: number;
  }> {
    const {
      state,
      stepName,
      metrics,
      preview,
      components,
      plan,
      content,
      tokens,
      fixAgentModel,
      logPath,
    } = input;
    const repairTargets = this.selectVisualRepairTargets({
      metrics,
      preview,
      components,
    });
    if (repairTargets.length === 0) {
      await this.logToFile(
        logPath,
        '[Visual Metrics Repair] No actionable compare mismatches were selected for AI diagnosis/fix.',
      );
      return { components, applied: false, repairedCount: 0 };
    }

    const snapshot = components.map((component) => ({ ...component }));
    let repairedCount = 0;

    this.logger.warn(
      `[Visual Metrics Repair] ${repairTargets.length} route/component mismatch(es) selected for targeted repair.`,
    );
    await this.logToFile(
      logPath,
      `[Visual Metrics Repair] Selected targets: ${repairTargets
        .map(
          (target) =>
            `${target.componentName}:${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'}`,
        )
        .join(', ')}`,
    );
    await this.logToFile(
      logPath,
      repairTargets
        .map(
          (target) =>
            `[Visual Metrics Repair] target=${target.componentName} score=${target.score.toFixed(1)} ${this.formatAutomationComparePageSummary(target.page)}`,
        )
        .join('\n'),
    );

    this.emitStepProgress(
      state,
      stepName,
      0.45,
      `Automation compare found ${repairTargets.length} high-signal mismatch(es). Applying targeted visual repair with the fix agent.`,
    );

    for (const target of repairTargets) {
      const componentIndex = components.findIndex(
        (component) => component.name === target.componentName,
      );
      if (componentIndex === -1) continue;

      const diagnosis = await this.diagnoseVisualMismatch({
        componentName: target.componentName,
        page: target.page,
        plan,
        content,
        modelName: fixAgentModel,
        logPath,
      });
      if (!diagnosis.shouldRepair || diagnosis.confidence < 0.55) {
        this.logger.warn(
          `[Visual Metrics Repair] Diagnosis confidence too low for "${target.componentName}". Skipping targeted fix. rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)}`,
        );
        await this.logToFile(
          logPath,
          `[Visual Metrics Repair] Skipped "${target.componentName}" because diagnosis confidence was too low (${diagnosis.confidence.toFixed(2)}). rootCause=${diagnosis.rootCause.primary}`,
        );
        continue;
      }

      const visionImageUrls = await this.buildComparePageVisionInputs(
        target.page,
      );
      const visionContextNote = this.buildComparePageVisionContext(target.page);
      const feedback = this.buildVisualRepairFeedback({
        componentName: target.componentName,
        page: target.page,
        diagnosis,
        plan,
        content,
      });

      this.logger.warn(
        `[Visual Metrics Repair] Fixing component "${target.componentName}" from route "${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'}" after diagnosis rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)}`,
      );
      await this.logToFile(
        logPath,
        [
          `[Visual Metrics Repair] Fixing "${target.componentName}" with diagnosis rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)}.`,
          `[Visual Metrics Repair] visionArtifacts=${visionImageUrls.length} visionContext=${JSON.stringify(visionContextNote || '')}`,
          `[Visual Metrics Repair] fix feedback:\n${this.summarizeMultilineForLog(
            feedback,
          )}`,
        ].join('\n'),
      );

      const fixed = await this.reactGenerator.fixComponent({
        component: components[componentIndex],
        plan,
        feedback,
        modelConfig: { fixAgent: fixAgentModel },
        logPath,
        visionImageUrls,
        visionContextNote,
      });
      const revalidated = this.validator.collectValidationIssues([fixed]);
      if (revalidated.failures.length > 0) {
        const error =
          revalidated.failures[0]?.error ?? 'Unknown validation error';
        this.logger.warn(
          `[Visual Metrics Repair] Re-validation failed for "${target.componentName}". Keeping the previous version. Error: ${error}`,
        );
        await this.logToFile(
          logPath,
          `[Visual Metrics Repair] Re-validation failed for "${target.componentName}": ${error}`,
        );
        continue;
      }

      components[componentIndex] = revalidated.components[0];
      repairedCount += 1;
      await this.logToFile(
        logPath,
        `[Visual Metrics Repair] Accepted updated component "${target.componentName}" after validator re-check.`,
      );
    }

    if (repairedCount === 0) {
      return { components: snapshot, applied: false, repairedCount: 0 };
    }

    try {
      await this.previewBuilder.syncGeneratedComponents(
        preview.previewDir,
        components,
        tokens,
      );
      await this.validator.assertPreviewBuild(preview.frontendDir);
      await this.validator.assertPreviewRuntime(
        preview.previewUrl,
        preview.routeEntries.map((entry) => entry.route),
      );
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[Visual Metrics Repair] Preview sync/build/runtime failed after targeted repair. Reverting to the last valid snapshot. ${message}`,
      );
      await this.logToFile(
        logPath,
        `[Visual Metrics Repair] Sync/build/runtime failed after targeted repair. Reverting.\n${message}`,
      );
      await this.previewBuilder.syncGeneratedComponents(
        preview.previewDir,
        snapshot,
        tokens,
      );
      return { components: snapshot, applied: false, repairedCount: 0 };
    }

    this.emitStepProgress(
      state,
      stepName,
      0.7,
      `Targeted visual repair updated ${repairedCount} component(s). Re-running compare metrics now.`,
    );

    return { components, applied: true, repairedCount };
  }

  private async diagnoseVisualMismatch(input: {
    componentName: string;
    page: AutomationComparePageResult;
    plan: PlanResult;
    content: DbContentResult;
    modelName?: string;
    logPath: string;
  }): Promise<VisualMismatchDiagnosis> {
    const { componentName, page, plan, content, modelName, logPath } = input;
    const componentPlan = plan.find(
      (entry) => entry.componentName === componentName,
    );
    const sourceEvidence = this.buildSourceEvidenceForComparePage(
      page,
      content,
    );
    const planEvidence = this.buildPlanEvidenceForComponent(componentPlan);
    const heuristic = this.buildHeuristicVisualDiagnosis({
      componentName,
      page,
      sourceEvidence,
      planEvidence,
    });
    const prompt = this.buildVisualDiagnosisPrompt({
      componentName,
      page,
      sourceEvidence,
      planEvidence,
      heuristic,
    });
    const resolvedModel = modelName ?? this.llmFactory.getModel();

    await this.logToFile(
      logPath,
      [
        `[Visual Diagnose] component=${componentName} route=${page.route ?? page.visual?.reactPath ?? 'unknown'} model=${resolvedModel}`,
        `[Visual Diagnose] incoming metrics: ${this.formatAutomationComparePageSummary(
          page,
        )}`,
        this.summarizeLogLines(
          sourceEvidence,
          6,
          '[Visual Diagnose] source evidence',
        ),
        this.summarizeLogLines(
          planEvidence,
          4,
          '[Visual Diagnose] plan evidence',
        ),
        `[Visual Diagnose] heuristic rootCause=${heuristic.rootCause.primary} confidence=${heuristic.confidence.toFixed(2)} strategy=${heuristic.repairPlan.strategy}`,
      ].join('\n'),
    );

    try {
      const response = await this.llmFactory.chat({
        model: resolvedModel,
        systemPrompt:
          'You diagnose WordPress-to-React visual mismatches. Return ONLY valid JSON. Do not include markdown fences or commentary.',
        userPrompt: prompt,
        maxTokens: 1200,
        temperature: 0,
      });
      const parsed = this.parseVisualDiagnosisResponse(
        response.text,
        componentName,
        page,
      );
      if (parsed) {
        await this.logToFile(
          logPath,
          [
            `[Visual Diagnose] ${componentName} route=${page.route ?? page.visual?.reactPath ?? 'unknown'} rootCause=${parsed.rootCause.primary} confidence=${parsed.confidence.toFixed(2)}`,
            `[Visual Diagnose] AI diagnosis strategy=${parsed.repairPlan.strategy} shouldRepair=${parsed.shouldRepair}`,
            this.summarizeLogLines(
              parsed.repairPlan.instructions,
              5,
              '[Visual Diagnose] AI instructions',
            ),
            this.summarizeLogLines(
              parsed.repairPlan.guardrails,
              5,
              '[Visual Diagnose] AI guardrails',
            ),
          ].join('\n'),
        );
        return this.mergeDiagnosisWithHeuristic(parsed, heuristic);
      }
    } catch (error) {
      await this.logToFile(
        logPath,
        `[Visual Diagnose] LLM diagnosis failed for "${componentName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await this.logToFile(
      logPath,
      `[Visual Diagnose] Falling back to heuristic diagnosis for "${componentName}" rootCause=${heuristic.rootCause.primary} confidence=${heuristic.confidence.toFixed(2)}`,
    );
    return heuristic;
  }

  private buildVisualDiagnosisPrompt(input: {
    componentName: string;
    page: AutomationComparePageResult;
    sourceEvidence: string[];
    planEvidence: string[];
    heuristic: VisualMismatchDiagnosis;
  }): string {
    const { componentName, page, sourceEvidence, planEvidence, heuristic } =
      input;
    const lines: string[] = [
      `Component: ${componentName}`,
      `Route key: ${page.routeKey ?? 'unknown'}`,
      `Route: ${page.route ?? page.visual?.reactPath ?? 'unknown'}`,
      `Suggested component hint from automation: ${page.componentHint ?? 'unknown'}`,
      '',
      'Automation metrics:',
      `- visual status: ${page.visual?.status ?? 'unknown'}`,
      `- content status: ${page.content?.status ?? 'unknown'}`,
      `- visual accuracy: ${page.visual?.accuracy ?? 'unknown'}`,
      `- diffPct: ${page.visual?.diffPct ?? 'unknown'}`,
      `- overlapDiffPct: ${page.visual?.overlapDiffPct ?? 'unknown'}`,
      `- extraDiffPct: ${page.visual?.extraDiffPct ?? 'unknown'}`,
      `- domSimilarity: ${page.visual?.domComparison?.similarityScore ?? 'unknown'}`,
      `- region count: ${(page.visual?.regions ?? []).length}`,
    ];

    if ((page.visual?.regions?.length ?? 0) > 0) {
      lines.push('Top diff regions:');
      for (const region of page.visual?.regions ?? []) {
        const bbox = region.bbox;
        lines.push(
          `- ${region.id ?? 'region'} | severity=${region.severity ?? 'unknown'} | kind=${region.kind ?? 'diff'} | diffPixels=${region.diffPixels ?? 'unknown'} | bbox=${bbox ? `(${bbox.x},${bbox.y},${bbox.width},${bbox.height})` : 'unknown'}`,
        );
      }
    }

    if ((page.content?.issues?.length ?? 0) > 0) {
      lines.push('Content issues:');
      for (const issue of page.content?.issues ?? []) {
        lines.push(`- ${issue}`);
      }
    }

    if (sourceEvidence.length > 0) {
      lines.push('WordPress / DB source evidence:');
      for (const evidence of sourceEvidence) {
        lines.push(`- ${evidence}`);
      }
    }

    if (planEvidence.length > 0) {
      lines.push('Current plan evidence:');
      for (const evidence of planEvidence) {
        lines.push(`- ${evidence}`);
      }
    }

    lines.push(
      `Heuristic baseline diagnosis: rootCause=${heuristic.rootCause.primary}, confidence=${heuristic.confidence.toFixed(2)}, missingLabels=${heuristic.evidence.missingLabels.join(' | ') || 'none'}`,
    );
    lines.push('');
    lines.push(
      'Decide the most likely root cause and return JSON with this exact shape:',
    );
    lines.push(
      '{"componentName":"string","routeKey":"string|null","route":"string|null","shouldRepair":true,"confidence":0.0,"rootCause":{"primary":"plan-omission|missing-section|missing-image|content-drift|layout-drift|route-mapping-error|data-binding-error|shared-layout-mismatch|unknown","secondary":["string"],"reasoning":"string"},"evidence":{"sourceHints":["string"],"missingLabels":["string"],"sectionLikelyMissingFromPlan":true},"repairPlan":{"strategy":"string","instructions":["string"],"targetAreas":[{"type":"section","sectionHint":"string","headingHint":"string"}],"guardrails":["string"]}}',
    );
    lines.push(
      'Rules: prefer "plan-omission" when WordPress/DB source clearly shows a prominent section or heading that is absent from the current plan evidence. Keep confidence between 0 and 1. Return only JSON.',
    );

    return lines.join('\n');
  }

  private parseVisualDiagnosisResponse(
    raw: string,
    componentName: string,
    page: AutomationComparePageResult,
  ): VisualMismatchDiagnosis | null {
    const candidate = this.extractJsonObject(raw);
    if (!candidate) return null;

    try {
      const parsed = JSON.parse(candidate) as Partial<VisualMismatchDiagnosis>;
      const confidence = Math.max(
        0,
        Math.min(1, this.coerceFiniteNumber(parsed.confidence) ?? 0),
      );
      const rootPrimary = parsed.rootCause?.primary ?? 'unknown';
      const allowedRootCauses = new Set([
        'plan-omission',
        'missing-section',
        'missing-image',
        'content-drift',
        'layout-drift',
        'route-mapping-error',
        'data-binding-error',
        'shared-layout-mismatch',
        'unknown',
      ]);
      return {
        componentName:
          typeof parsed.componentName === 'string' &&
          parsed.componentName.trim().length > 0
            ? parsed.componentName.trim()
            : componentName,
        routeKey:
          typeof parsed.routeKey === 'string'
            ? parsed.routeKey
            : (page.routeKey ?? null),
        route:
          typeof parsed.route === 'string'
            ? parsed.route
            : (page.route ?? page.visual?.reactPath ?? null),
        shouldRepair:
          typeof parsed.shouldRepair === 'boolean' ? parsed.shouldRepair : true,
        confidence,
        rootCause: {
          primary: allowedRootCauses.has(rootPrimary)
            ? (rootPrimary as VisualMismatchDiagnosis['rootCause']['primary'])
            : 'unknown',
          secondary: Array.isArray(parsed.rootCause?.secondary)
            ? parsed.rootCause.secondary
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 5)
            : [],
          reasoning:
            typeof parsed.rootCause?.reasoning === 'string'
              ? parsed.rootCause.reasoning.trim()
              : '',
        },
        evidence: {
          sourceHints: Array.isArray(parsed.evidence?.sourceHints)
            ? parsed.evidence.sourceHints
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          missingLabels: Array.isArray(parsed.evidence?.missingLabels)
            ? parsed.evidence.missingLabels
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 6)
            : [],
          sectionLikelyMissingFromPlan:
            parsed.evidence?.sectionLikelyMissingFromPlan === true,
        },
        repairPlan: {
          strategy:
            typeof parsed.repairPlan?.strategy === 'string'
              ? parsed.repairPlan.strategy.trim()
              : 'targeted-visual-repair',
          instructions: Array.isArray(parsed.repairPlan?.instructions)
            ? parsed.repairPlan.instructions
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          targetAreas: Array.isArray(parsed.repairPlan?.targetAreas)
            ? parsed.repairPlan.targetAreas
                .map((target) => ({
                  type: String(target?.type ?? 'section').trim() || 'section',
                  sectionHint:
                    typeof target?.sectionHint === 'string'
                      ? target.sectionHint.trim()
                      : undefined,
                  headingHint:
                    typeof target?.headingHint === 'string'
                      ? target.headingHint.trim()
                      : undefined,
                }))
                .slice(0, 5)
            : [],
          guardrails: Array.isArray(parsed.repairPlan?.guardrails)
            ? parsed.repairPlan.guardrails
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
        },
      };
    } catch {
      return null;
    }
  }

  private extractJsonObject(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return trimmed.slice(start, end + 1);
  }

  private mergeDiagnosisWithHeuristic(
    diagnosis: VisualMismatchDiagnosis,
    heuristic: VisualMismatchDiagnosis,
  ): VisualMismatchDiagnosis {
    return {
      ...diagnosis,
      shouldRepair: diagnosis.shouldRepair ?? heuristic.shouldRepair,
      confidence:
        diagnosis.confidence > 0 ? diagnosis.confidence : heuristic.confidence,
      rootCause: {
        primary: diagnosis.rootCause.primary ?? heuristic.rootCause.primary,
        secondary:
          diagnosis.rootCause.secondary.length > 0
            ? diagnosis.rootCause.secondary
            : heuristic.rootCause.secondary,
        reasoning:
          diagnosis.rootCause.reasoning || heuristic.rootCause.reasoning,
      },
      evidence: {
        sourceHints:
          diagnosis.evidence.sourceHints.length > 0
            ? diagnosis.evidence.sourceHints
            : heuristic.evidence.sourceHints,
        missingLabels:
          diagnosis.evidence.missingLabels.length > 0
            ? diagnosis.evidence.missingLabels
            : heuristic.evidence.missingLabels,
        sectionLikelyMissingFromPlan:
          diagnosis.evidence.sectionLikelyMissingFromPlan ||
          heuristic.evidence.sectionLikelyMissingFromPlan,
      },
      repairPlan: {
        strategy:
          diagnosis.repairPlan.strategy || heuristic.repairPlan.strategy,
        instructions:
          diagnosis.repairPlan.instructions.length > 0
            ? diagnosis.repairPlan.instructions
            : heuristic.repairPlan.instructions,
        targetAreas:
          diagnosis.repairPlan.targetAreas.length > 0
            ? diagnosis.repairPlan.targetAreas
            : heuristic.repairPlan.targetAreas,
        guardrails:
          diagnosis.repairPlan.guardrails.length > 0
            ? diagnosis.repairPlan.guardrails
            : heuristic.repairPlan.guardrails,
      },
    };
  }

  private buildHeuristicVisualDiagnosis(input: {
    componentName: string;
    page: AutomationComparePageResult;
    sourceEvidence: string[];
    planEvidence: string[];
  }): VisualMismatchDiagnosis {
    const { componentName, page, sourceEvidence, planEvidence } = input;
    const missingLabels = sourceEvidence
      .filter((entry) => entry.startsWith('Heading/text hint: "'))
      .map((entry) =>
        entry.replace(/^Heading\/text hint: "/, '').replace(/"$/, ''),
      )
      .filter(
        (entry) => !planEvidence.some((planLine) => planLine.includes(entry)),
      )
      .slice(0, 4);
    const overlapDiffPct =
      this.coerceFiniteNumber(page.visual?.overlapDiffPct) ?? 0;
    const extraDiffPct =
      this.coerceFiniteNumber(page.visual?.extraDiffPct) ?? 0;
    const diffPct = this.coerceFiniteNumber(page.visual?.diffPct) ?? 0;
    const domSimilarity =
      this.coerceFiniteNumber(page.visual?.domComparison?.similarityScore) ??
      100;
    const hasHighRegion = (page.visual?.regions ?? []).some(
      (region) => region.severity === 'high',
    );
    const contentStatus = page.content?.status ?? 'PASS';
    const sectionLikelyMissingFromPlan =
      missingLabels.length > 0 && contentStatus !== 'PASS';

    let primary: VisualMismatchDiagnosis['rootCause']['primary'] =
      'layout-drift';
    let confidence = 0.68;
    let strategy = 'targeted-visual-repair';
    const secondary: string[] = [];

    if (sectionLikelyMissingFromPlan) {
      primary = 'plan-omission';
      confidence = 0.9;
      strategy = 'restore-missing-section-from-source';
      secondary.push('missing-section', 'content-drift');
    } else if (contentStatus === 'MISSING') {
      primary = 'data-binding-error';
      confidence = 0.88;
      strategy = 'restore-missing-content-binding';
      secondary.push('content-drift');
    } else if (extraDiffPct >= 8 && overlapDiffPct < extraDiffPct + 4) {
      primary = 'missing-section';
      confidence = 0.8;
      strategy = 'restore-vertical-missing-block';
      secondary.push('layout-drift');
    } else if (domSimilarity < 75) {
      primary = 'layout-drift';
      confidence = 0.76;
      strategy = 'repair-structure-to-match-source';
      secondary.push('content-drift');
    } else if (hasHighRegion && contentStatus === 'FAIL') {
      primary = 'content-drift';
      confidence = 0.74;
      strategy = 'restore-source-backed-content';
      secondary.push('layout-drift');
    } else if (diffPct < 8) {
      primary = 'unknown';
      confidence = 0.45;
      strategy = 'review-before-repair';
    }

    return {
      componentName,
      routeKey: page.routeKey ?? null,
      route: page.route ?? page.visual?.reactPath ?? null,
      shouldRepair: confidence >= 0.5,
      confidence,
      rootCause: {
        primary,
        secondary,
        reasoning:
          primary === 'plan-omission'
            ? 'WordPress/DB source hints show headings or sections that are not represented in the current plan evidence while compare metrics also report strong content/visual drift.'
            : primary === 'data-binding-error'
              ? 'Content compare reports missing data while the route/component still exists, which suggests the React output is not binding or rendering source data correctly.'
              : primary === 'missing-section'
                ? 'Visual diff indicates a large missing vertical band or extra-height mismatch, suggesting an omitted section rather than only cosmetic drift.'
                : primary === 'layout-drift'
                  ? 'The overall DOM structure and visual diff suggest the component layout diverged from WordPress even if content is partially present.'
                  : 'Signal quality is weak, so the root cause is uncertain.',
      },
      evidence: {
        sourceHints: sourceEvidence.slice(0, 8),
        missingLabels,
        sectionLikelyMissingFromPlan,
      },
      repairPlan: {
        strategy,
        instructions:
          primary === 'plan-omission'
            ? [
                'Restore the source-backed missing section even if it is absent from the current plan.',
                'Preserve neighboring sections and current correct layout.',
              ]
            : primary === 'data-binding-error'
              ? [
                  'Repair the component so it renders the expected source-backed content again.',
                  'Do not remove existing sections to hide the mismatch.',
                ]
              : [
                  'Repair the mismatched layout in the highest-diff region first.',
                  'Preserve already-correct sections and avoid unnecessary rewrites.',
                ],
        targetAreas: missingLabels.slice(0, 3).map((label) => ({
          type: 'section',
          headingHint: label,
        })),
        guardrails: [
          'Do not simplify the component to reduce diff.',
          'Preserve validated sections, CTAs, and images unless source evidence says they are wrong.',
        ],
      },
    };
  }

  private buildPlanEvidenceForComponent(
    componentPlan: PlanResult[number] | undefined,
  ): string[] {
    if (!componentPlan) return [];
    const lines: string[] = [];
    if (componentPlan.planningSourceSummary) {
      lines.push(
        `Planning source summary: ${componentPlan.planningSourceSummary}`,
      );
    }
    if (componentPlan.planningSourceLabel) {
      lines.push(`Planning source label: ${componentPlan.planningSourceLabel}`);
    }
    if (componentPlan.visualPlan?.sections?.length) {
      lines.push(
        `Visual plan sections: ${componentPlan.visualPlan.sections
          .map((section) => this.summarizePlanSection(section))
          .filter(Boolean)
          .join(' || ')}`,
      );
    }
    if (componentPlan.draftSections?.length) {
      lines.push(
        `Draft sections: ${componentPlan.draftSections
          .map((section) => this.summarizePlanSection(section))
          .filter(Boolean)
          .join(' || ')}`,
      );
    }
    return lines;
  }

  private buildVisualRepairFeedback(input: {
    componentName: string;
    page: AutomationComparePageResult;
    diagnosis: VisualMismatchDiagnosis;
    plan: PlanResult;
    content: DbContentResult;
  }): string {
    const { componentName, page, diagnosis, plan, content } = input;
    const componentPlan = plan.find(
      (entry) => entry.componentName === componentName,
    );
    const lines: string[] = [
      `Automation visual-compare reported a fidelity mismatch for component "${componentName}".`,
      `Repair the component so the rendered React preview matches the WordPress source more closely for route "${page.route ?? page.visual?.reactPath ?? 'unknown'}".`,
      `Diagnosis: rootCause=${diagnosis.rootCause.primary} | confidence=${diagnosis.confidence.toFixed(2)} | strategy=${diagnosis.repairPlan.strategy}`,
      diagnosis.rootCause.reasoning
        ? `Diagnosis reasoning: ${diagnosis.rootCause.reasoning}`
        : '',
    ];

    if (page.visual) {
      const metricParts = [
        page.visual.accuracy !== null && page.visual.accuracy !== undefined
          ? `visualAccuracy=${page.visual.accuracy}%`
          : null,
        page.visual.diffPct !== null && page.visual.diffPct !== undefined
          ? `diffPct=${page.visual.diffPct}%`
          : null,
        page.visual.overlapDiffPct !== null &&
        page.visual.overlapDiffPct !== undefined
          ? `overlapDiffPct=${page.visual.overlapDiffPct}%`
          : null,
        page.visual.extraDiffPct !== null &&
        page.visual.extraDiffPct !== undefined
          ? `extraDiffPct=${page.visual.extraDiffPct}%`
          : null,
        page.visual.domComparison?.similarityScore !== null &&
        page.visual.domComparison?.similarityScore !== undefined
          ? `domSimilarity=${page.visual.domComparison.similarityScore}%`
          : null,
      ].filter(Boolean);
      if (metricParts.length > 0) {
        lines.push(`Automation metrics: ${metricParts.join(' | ')}`);
      }
      if ((page.visual.regions?.length ?? 0) > 0) {
        lines.push('Top mismatch regions from automation diff:');
        for (const region of page.visual?.regions ?? []) {
          const bbox = region.bbox;
          lines.push(
            `- ${region.id ?? 'region'} | severity=${region.severity ?? 'unknown'} | kind=${region.kind ?? 'diff'} | diffPixels=${region.diffPixels ?? 'unknown'} | bbox=${bbox ? `(${bbox.x},${bbox.y},${bbox.width},${bbox.height})` : 'unknown'}`,
          );
        }
      }
    }

    if (page.content?.status && page.content.status !== 'PASS') {
      lines.push(
        `Content compare status: ${page.content.status}.${
          page.content.scores?.overall !== undefined &&
          page.content.scores?.overall !== null
            ? ` overall=${page.content.scores.overall}%`
            : ''
        }`,
      );
      for (const issue of page.content.issues ?? []) {
        lines.push(`- content issue: ${issue}`);
      }
    }

    const sourceEvidence = this.buildSourceEvidenceForComparePage(
      page,
      content,
    );
    if (sourceEvidence.length > 0) {
      lines.push('Source-backed evidence from WordPress/DB:');
      lines.push(...sourceEvidence.map((line) => `- ${line}`));
    }

    const planEvidence = this.buildPlanEvidenceForComponent(componentPlan);
    if (planEvidence.length > 0) {
      lines.push('Current planner evidence:');
      lines.push(...planEvidence.map((line) => `- ${line}`));
    }

    if (diagnosis.evidence.missingLabels.length > 0) {
      lines.push(
        `Diagnosis missing labels: ${diagnosis.evidence.missingLabels
          .map((label) => `"${label}"`)
          .join(', ')}`,
      );
    }
    if (diagnosis.repairPlan.instructions.length > 0) {
      lines.push('Diagnosis repair instructions:');
      lines.push(
        ...diagnosis.repairPlan.instructions.map(
          (instruction) => `- ${instruction}`,
        ),
      );
    }
    if (diagnosis.repairPlan.targetAreas.length > 0) {
      lines.push('Diagnosis target areas:');
      lines.push(
        ...diagnosis.repairPlan.targetAreas.map(
          (target) =>
            `- type=${target.type} sectionHint=${target.sectionHint ?? 'unknown'} headingHint=${target.headingHint ?? 'unknown'}`,
        ),
      );
    }
    if (diagnosis.repairPlan.guardrails.length > 0) {
      lines.push('Diagnosis guardrails:');
      lines.push(
        ...diagnosis.repairPlan.guardrails.map((guardrail) => `- ${guardrail}`),
      );
    }

    lines.push(
      'Source-backed repair override: if the WordPress/DB evidence clearly shows a prominent section, heading, CTA, or image block that is missing from the current React component, you MUST restore it even if the current plan under-specifies it.',
    );
    lines.push(
      'Preserve all already-correct sections. Do not simplify the page. Prefer a faithful structural repair over cosmetic tweaks.',
    );

    return lines.join('\n');
  }

  private buildSourceEvidenceForComparePage(
    page: AutomationComparePageResult,
    content: DbContentResult,
  ): string[] {
    const route =
      this.normalizeComparableRoute(page.route) ??
      this.normalizeComparableRoute(page.visual?.reactPath) ??
      null;
    const evidence: string[] = [];
    const headingCandidates = new Set<string>();

    const addHeadingCandidates = (raw: string | undefined) => {
      for (const heading of this.extractHeadingCandidates(raw)) {
        headingCandidates.add(heading);
        if (headingCandidates.size >= 6) break;
      }
    };

    if (route === '/') {
      const homeTemplates = content.dbTemplates.filter(
        (template) =>
          /^(home|front-page)$/i.test(template.slug) ||
          /^(home|front page)$/i.test(template.title),
      );
      for (const template of homeTemplates) {
        addHeadingCandidates(template.content);
      }
      const frontPage = content.pages.find(
        (pageItem) =>
          content.readingSettings.pageOnFrontId !== null &&
          Number(pageItem.id) === Number(content.readingSettings.pageOnFrontId),
      );
      if (frontPage) {
        addHeadingCandidates(frontPage.content);
      }
    } else if (route) {
      const pageSlugMatch = route.match(/^\/page\/([^/]+)$/i);
      const postSlugMatch = route.match(/^\/post\/([^/]+)$/i);
      if (pageSlugMatch) {
        const pageItem = content.pages.find(
          (entry) => entry.slug === pageSlugMatch[1],
        );
        if (pageItem) {
          evidence.push(`WP page title: "${pageItem.title}"`);
          addHeadingCandidates(pageItem.content);
        }
      }
      if (postSlugMatch) {
        const postItem = content.posts.find(
          (entry) => entry.slug === postSlugMatch[1],
        );
        if (postItem) {
          evidence.push(`WP post title: "${postItem.title}"`);
          addHeadingCandidates(postItem.content);
        }
      }
    }

    if (page.content?.wp?.title) {
      evidence.push(`Content compare WP title: "${page.content.wp.title}"`);
    }
    if (page.content?.wp?.contentPreview) {
      addHeadingCandidates(page.content.wp.contentPreview);
    }

    for (const heading of [...headingCandidates].slice(0, 6)) {
      evidence.push(`Heading/text hint: "${heading}"`);
    }
    return evidence;
  }

  private extractHeadingCandidates(raw: string | undefined): string[] {
    if (!raw) return [];
    const results: string[] = [];
    const seen = new Set<string>();
    const htmlHeadingPattern = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
    let match: RegExpExecArray | null;
    while ((match = htmlHeadingPattern.exec(raw)) !== null) {
      const text = this.normalizeEvidenceText(match[1]);
      if (text && !seen.has(text)) {
        seen.add(text);
        results.push(text);
      }
      if (results.length >= 6) return results;
    }

    const plainTextLines = raw
      .replace(/<[^>]+>/g, '\n')
      .split(/\r?\n+/)
      .map((line) => this.normalizeEvidenceText(line))
      .filter(
        (line) => line.length >= 8 && line.length <= 120 && !seen.has(line),
      );
    for (const line of plainTextLines) {
      seen.add(line);
      results.push(line);
      if (results.length >= 6) break;
    }
    return results;
  }

  private normalizeEvidenceText(value: string): string {
    return value
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private summarizePlanSection(
    section: Record<string, any> | undefined,
  ): string {
    if (!section || typeof section !== 'object') return '';
    const parts = [typeof section.type === 'string' ? section.type : 'section'];
    if (typeof section.heading === 'string' && section.heading.trim()) {
      parts.push(`heading="${section.heading.trim()}"`);
    }
    if (typeof section.subheading === 'string' && section.subheading.trim()) {
      parts.push(`subheading="${section.subheading.trim()}"`);
    }
    if (
      section.cta &&
      typeof section.cta === 'object' &&
      typeof section.cta.text === 'string' &&
      section.cta.text.trim()
    ) {
      parts.push(`cta="${section.cta.text.trim()}"`);
    }
    if (
      Array.isArray(section.cards) &&
      section.cards.length > 0 &&
      typeof section.cards[0] === 'object'
    ) {
      const cardLabel =
        section.cards
          .map((card: Record<string, any>) =>
            typeof card.heading === 'string'
              ? card.heading.trim()
              : typeof card.body === 'string'
                ? card.body.trim()
                : '',
          )
          .filter(Boolean)
          .slice(0, 3)
          .join(' | ') || '';
      if (cardLabel) parts.push(`cards=${cardLabel}`);
    }
    return parts.join(' | ');
  }

  private buildComparePageVisionContext(
    page: AutomationComparePageResult,
  ): string {
    const lines = ['Automation screenshot evidence:'];
    const topRegion = page.visual?.regions?.[0];
    if (topRegion?.cropArtifacts) {
      lines.push(
        `- Region crop images highlight the most severe mismatch area (${topRegion.kind ?? 'diff'} / ${topRegion.severity ?? 'unknown'}).`,
      );
    } else {
      lines.push(
        '- Full-page screenshots show WordPress vs React plus a diff overlay.',
      );
    }
    return lines.join('\n');
  }

  private async buildComparePageVisionInputs(
    page: AutomationComparePageResult,
  ): Promise<string[]> {
    const urls = this.collectCompareArtifactUrls(page).slice(0, 3);
    const resolved: string[] = [];
    for (const url of urls) {
      const dataUrl = await this.fetchImageAsDataUrl(url);
      if (dataUrl) resolved.push(dataUrl);
    }
    return resolved;
  }

  private collectCompareArtifactUrls(
    page: AutomationComparePageResult,
  ): string[] {
    const urls: string[] = [];
    const topRegion = page.visual?.regions?.[0];
    if (topRegion?.cropArtifacts) {
      urls.push(
        topRegion.cropArtifacts.imageA ?? '',
        topRegion.cropArtifacts.imageB ?? '',
        topRegion.cropArtifacts.diff ?? '',
      );
    }
    if (urls.filter(Boolean).length === 0) {
      urls.push(
        page.visual?.artifacts?.imageA ?? '',
        page.visual?.artifacts?.imageB ?? '',
        page.visual?.artifacts?.diff ?? '',
      );
    }
    return [...new Set(urls.map((value) => value.trim()).filter(Boolean))];
  }

  private async fetchImageAsDataUrl(url: string): Promise<string | null> {
    try {
      const response = await lastValueFrom(
        this.httpService.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
        }),
      );
      const buffer = Buffer.from(response.data as ArrayBuffer);
      const contentTypeHeader = response.headers['content-type'];
      const contentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0]
        : contentTypeHeader || this.guessImageMimeType(url);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `[Visual Metrics Repair] Failed to fetch automation artifact "${url}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private guessImageMimeType(url: string): string {
    const normalized = url.toLowerCase();
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (normalized.endsWith('.webp')) return 'image/webp';
    return 'image/png';
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
    editRequestContext?: ResolvedEditRequestContext;
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
      editRequestContext,
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
        context: editRequestContext,
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
        if (!feedbackOverride && validationErr) {
          this.logger.warn(
            `[Focused Edit Pass] Initial focused edit for "${fixedResult.editedComponentName}" failed validation. Retrying once with preservation feedback. Error: ${validationErr}`,
          );
          await this.logToFile(
            logPath,
            `[Focused Edit Pass] Initial focused edit for "${fixedResult.editedComponentName}" failed validation. Retrying once with preservation feedback.\n${validationErr}`,
          );
          return applyFocusedTask(
            task,
            `${task.feedback}\n\nThe previous focused edit attempt failed validation:\n${validationErr}\n\nRetry by changing only the requested target region. Preserve every other section, section order, hero/title text, CTA labels, tracked wrappers, and approved visual-plan content exactly as they already exist.`,
          );
        }
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
      context.editOperation ? `operation=${context.editOperation}` : null,
      context.targetScope ? `scope=${context.targetScope}` : null,
      context.recommendedStrategy
        ? `strategy=${context.recommendedStrategy}`
        : null,
      context.needsInference ? 'needsInference=true' : null,
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

    if (context.targetCandidates.length > 0) {
      lines.push(
        `candidates | ${context.targetCandidates
          .slice(0, 3)
          .map((candidate) =>
            [
              candidate.componentName
                ? `component=${candidate.componentName}`
                : null,
              candidate.route ? `route=${candidate.route}` : null,
              candidate.templateName
                ? `template=${candidate.templateName}`
                : null,
              candidate.sectionType
                ? `sectionType=${candidate.sectionType}`
                : null,
              candidate.targetNodeRole
                ? `targetRole=${candidate.targetNodeRole}`
                : null,
              `confidence=${candidate.confidence.toFixed(2)}`,
            ]
              .filter(Boolean)
              .join(' | '),
          )
          .join(' || ')}`,
      );
    }

    if (context.ambiguities.length > 0) {
      lines.push(
        `ambiguities | ${context.ambiguities
          .slice(0, 3)
          .map((entry) => truncateForLog(entry, 120))
          .join(' || ')}`,
      );
    }

    if (context.warnings.length > 0) {
      lines.push(
        `warnings | ${context.warnings
          .slice(0, 3)
          .map((entry) => truncateForLog(entry, 120))
          .join(' || ')}`,
      );
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

  private isProtectedDeterministicSharedPartial(component: {
    name: string;
    generationMode?: 'deterministic' | 'ai';
  }): boolean {
    return (
      component.generationMode === 'deterministic' &&
      /^(Header|Footer|Navigation|Nav)$/i.test(component.name)
    );
  }

  private sanitizeProtectedDeterministicSharedPartial<
    T extends { code: string },
  >(component: T): T {
    let code = component.code;

    code = code.replace(
      /<a\b([^>]*?)\bhref=(["'])#\2([^>]*)>([\s\S]*?)<\/a>/g,
      '<span$1$3>$4</span>',
    );
    code = code.replace(/No menus available/g, '');

    return { ...component, code };
  }

  private shouldTolerateProtectedDeterministicSharedPartialFailure(
    component: { name: string; generationMode?: 'deterministic' | 'ai' },
    error: string,
  ): boolean {
    return (
      this.isProtectedDeterministicSharedPartial(component) &&
      /^Shared chrome contract violated:/i.test(error)
    );
  }

  private isSyntaxOnlyValidationError(error: string): boolean {
    return [
      /^Missing `export default`/i,
      /^No JSX return found/i,
      /^Duplicate className attributes found\./i,
      /^JSX tag error:/i,
      /^Unbalanced braces \(depth:/i,
      /^Unbalanced parentheses \(depth:/i,
      /^Unbalanced square brackets \(depth:/i,
      /^HTML attribute `.+=` found in JSX/i,
      /^`<label for=>` found/i,
    ].some((pattern) => pattern.test(error));
  }

  private shouldRetryWithFullComponentRegeneration(error: string): boolean {
    const normalized = error.toLowerCase();
    return (
      normalized.includes('visual plan fidelity violated') ||
      normalized.includes('section coverage mismatch:') ||
      normalized.includes('sectionaudit:') ||
      normalized.includes('missing rendered sectionkey') ||
      normalized.includes('missing sourcenodeid') ||
      /\blost\s+[a-z0-9-]+\s+(?:heading|subheading|title|subtitle|body|image src|cta text|button text|list item|author|quote|avatar)\b/i.test(
        error,
      )
    );
  }

  private buildFullComponentRegenerationFeedback(
    componentName: string,
    error: string,
    diagnostics?: {
      reasons: string[];
      missingTargets: string[];
    },
  ): string {
    const lines = [
      `Full component regeneration required for "${componentName}".`,
      'The previous repair still failed because approved section content or section structure is missing.',
      'Regenerate the entire component from the approved plan instead of patching a local fragment.',
      'Every approved section must remain present, in order, with complete required content inside that section.',
      'If any heading, body, image, CTA, card content, or interactive section payload is missing, restore it from the approved contract.',
    ];
    if (diagnostics?.reasons.length) {
      lines.push(`Regeneration reason(s): ${diagnostics.reasons.join(', ')}`);
    }
    if (diagnostics?.missingTargets.length) {
      lines.push(
        `Missing contract targets: ${diagnostics.missingTargets.join(', ')}`,
      );
    }
    lines.push(error);
    return lines.join('\n\n');
  }

  private extractFullComponentRegenerationDiagnostics(error: string): {
    reasons: string[];
    missingTargets: string[];
  } {
    const reasons = new Set<string>();
    const missingTargets = new Set<string>();
    const normalized = error.toLowerCase();

    if (normalized.includes('section coverage mismatch:')) {
      reasons.add('section-coverage');
      const missingKeysMatch = error.match(/missingKeys=([^\n|]+)/i);
      const extraKeysMatch = error.match(/extraKeys=([^\n|]+)/i);
      missingKeysMatch?.[1]
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((key) => missingTargets.add(`${key}.wrapper`));
      extraKeysMatch?.[1]
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((key) => missingTargets.add(`${key}.extra`));
    }

    const sectionAuditPattern =
      /sectionAudit:\s+[^\n|]+\|\s+key=([^|]+)\|\s+type=([^|]+)\|\s+missing=([^|]+)\|/g;
    for (const match of error.matchAll(sectionAuditPattern)) {
      const rawKey = match[1]?.trim() || '(untracked)';
      const sectionType = match[2]?.trim() || 'section';
      const missingKinds = (match[3] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (missingKinds.length > 0) {
        reasons.add('missing-section-content');
      }
      for (const kind of missingKinds) {
        const normalizedKind = kind.replace(/\s+/g, '-').toLowerCase();
        const key =
          rawKey !== '(untracked)' ? rawKey : `${sectionType}-untracked`;
        missingTargets.add(`${key}.${normalizedKind}`);
      }
    }

    if (normalized.includes('missing rendered sectionkey')) {
      reasons.add('missing-section-wrapper');
    }
    if (normalized.includes('missing sourcenodeid')) {
      reasons.add('missing-source-node');
    }
    if (/\blost\s+/i.test(error)) {
      reasons.add('missing-section-content');
    }

    return {
      reasons: [...reasons],
      missingTargets: [...missingTargets].slice(0, 24),
    };
  }

  private formatFullComponentRegenerationDiagnostics(input: {
    reasons: string[];
    missingTargets: string[];
  }): string {
    const parts = [
      input.reasons.length > 0
        ? `regenerationReason=${input.reasons.join(',')}`
        : null,
      input.missingTargets.length > 0
        ? `missing=${input.missingTargets.join(',')}`
        : null,
    ].filter(Boolean);
    return parts.join(' | ');
  }

  private recordFullComponentRegenerationSummary(
    summaryDraft: PipelineRuntimeSummaryDraft,
    input: {
      stage: FullComponentRegenerationSummaryEntry['stage'];
      componentName: string;
      diagnostics: {
        reasons: string[];
        missingTargets: string[];
      };
      outcome: FullComponentRegenerationSummaryEntry['outcome'];
      triggerError: string;
      finalError?: string;
    },
  ): void {
    summaryDraft.fullComponentRegenerations.push({
      timestamp: new Date().toISOString(),
      stage: input.stage,
      componentName: input.componentName,
      reasons: input.diagnostics.reasons,
      missingTargets: input.diagnostics.missingTargets,
      outcome: input.outcome,
      triggerErrorPreview: truncateForLog(input.triggerError, 400),
      ...(input.finalError
        ? { finalError: truncateForLog(input.finalError, 400) }
        : {}),
    });
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
