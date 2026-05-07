import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { AgentResult } from '@/common/types/pipeline.type.js';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  BeforeApplicationShutdown,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
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
import { SectionManifestService } from '../agents/preview-builder/section-manifest.service.js';
import {
  buildSurfacePlanRegressionSnapshot,
  resolvePlannerSectionBlueprint,
} from '../agents/planner/planner-surface-plan.util.js';
import { GeneratedCodeReviewService } from '../agents/react-generator/generated-code-review.service.js';
import type {
  GeneratedComponent,
  ReactGenerateResult,
} from '../agents/react-generator/react-generator.service.js';
import { ReactGeneratorService } from '../agents/react-generator/react-generator.service.js';
import { SectionEditService } from '../agents/react-generator/section-edit.service.js';
import { ReactVisualEditContractService } from '../agents/react-generator/react-visual-edit-contract.service.js';
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
import { buildUiMutationCandidatesForGeneratedComponents } from '../edit-request/ui-source-map.util.js';
import { getComponentStrategy } from '../agents/component-strategy.registry.js';
import { SqlService } from '../sql/sql.service.js';
import { WpQueryService } from '../sql/wp-query.service.js';
import { SiteCompareService } from '../site-compare/site-compare.service.js';
import type {
  SiteCompareMetrics,
  SiteCompareTarget,
} from '../site-compare/site-compare.types.js';
import { SiteCompareVisualDiagnosisService } from '../site-compare/visual-diagnosis.service.js';
import type {
  PostEditVisualValidationResult,
  VisualMismatchDiagnosis,
} from '../site-compare/visual-diagnosis.types.js';
import { ThemeDetectorService } from '../theme/theme-detector.service.js';
import type {
  ApplyPendingEditRequestDto,
  PipelineCaptureAttachmentDto,
  RunPipelineDto,
  SkipPendingEditRequestDto,
  SkipVisualCompareDto,
  SubmitReactVisualEditDto,
} from './orchestrator.dto.js';
import { OrchestratorRuntimeSupportService } from './orchestrator-runtime-support.service.js';
import type {
  AutomationComparePageResult,
  DegradedComponentRecord,
  JobRuntimeControl,
  OrchestratorRuntimeStores,
  PipelineAccuracySummary,
  PipelineRetryCounters,
  PipelineRunSummaryFile,
  PipelineRuntimeSummaryDraft,
  PipelineUiAssessment,
  FullComponentRegenerationSummaryEntry,
} from './orchestrator.service.types.js';
import {
  PendingEditApprovalGate,
  PipelineControlError,
  PipelineStatus,
  PipelineStepSkipError,
  type ProgressEvent,
  type ProgressEventData,
} from './orchestrator.runtime.types.js';

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
    'redundant_home_alias_removed',
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
              !(
                'runtimeRenderer' in component &&
                component.runtimeRenderer === 'runtime-page'
              ) &&
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

@Injectable()
export class OrchestratorService implements BeforeApplicationShutdown {
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
    private readonly reactVisualEditContract: ReactVisualEditContractService,
    private readonly reactVisualEdit: ReactVisualEditService,
    private readonly generatedCodeReview: GeneratedCodeReviewService,
    private readonly apiBuilder: ApiBuilderService,
    private readonly generatedApiReview: GeneratedApiReviewService,
    private readonly previewBuilder: PreviewBuilderService,
    private readonly sectionManifest: SectionManifestService,
    private readonly validator: ValidatorService,
    private readonly contractAudit: GenerationContractAuditService,
    private readonly sourceResolver: SourceResolverService,
    private readonly dbTemplateOverlay: DbTemplateOverlayService,
    private readonly cleanup: CleanupService,
    private readonly captureReview: CaptureReviewService,
    private readonly editRequestPhase: EditRequestPhaseService,
    private readonly runtimeSupport: OrchestratorRuntimeSupportService,
    private readonly aiLogger: AiLoggerService,
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly siteCompareService: SiteCompareService,
    private readonly siteCompareVisualDiagnosis: SiteCompareVisualDiagnosisService,
  ) {}

  private getRuntimeStores(): OrchestratorRuntimeStores {
    return {
      jobs: this.jobs,
      progress: this.progress,
      controls: this.controls,
      stepEventData: this.stepEventData,
    };
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.runtimeSupport.broadcastUnexpectedShutdown(
      signal,
      this.getRuntimeStores(),
    );
  }

  async run(
    siteId: string,
    editRequestContext?: ResolvedEditRequestContext,
    userId?: string,
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
          ? [
              { name: '9_visual_compare', status: 'pending' as const },
              { name: '8b_edit_request', status: 'pending' as const },
              {
                name: '9b_post_edit_visual_validation',
                status: 'pending' as const,
              },
            ]
          : [{ name: '9_visual_compare', status: 'pending' as const }]),
        // Stage 7: Cleanup + completion
        { name: '10_cleanup', status: 'pending' },
        { name: '11_done', status: 'pending' },
      ],
    };
    this.jobs.set(jobId, state);
    this.runtimeSupport.getProgressStream(jobId, this.progress);
    this.controls.set(jobId, {
      stopRequested: false,
      deleteRequested: false,
      skipVisualCompareRequested: false,
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
      userId,
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
      // Clean up the progress stream after a delay, matching the happy-path
      // cleanup so that errored jobs do not leak ReplaySubject entries.
      setTimeout(() => this.progress.delete(jobId), 60_000);
      this.logger.error(`Pipeline ${jobId} failed:`, err);
    });

    return { jobId };
  }

  async getStatus(jobId: string): Promise<PipelineStatus> {
    const state = this.jobs.get(jobId);
    if (state) {
      return state;
    }

    const persistedContext = await this.readPersistedVisualEditContext(jobId);
    if (persistedContext) {
      return {
        jobId,
        status: 'done',
        steps: [],
        result: persistedContext,
      };
    }

    return {
      jobId,
      status: 'error',
      steps: [],
      error: 'Job not found',
    };
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
    const persistedContext = await this.readPersistedVisualEditContext(
      body.jobId,
    );

    const jobResult = (state?.result ?? {}) as {
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
      jobResult.previewDir ||
      persistedContext?.previewDir;
    const frontendDir =
      body.editRequest.reactSourceTarget.frontendDir?.trim() ||
      jobResult.frontendDir ||
      persistedContext?.frontendDir ||
      (previewDir ? join(previewDir, 'frontend') : undefined);
    const routeEntries = body.editRequest.reactSourceTarget.routeEntries?.length
      ? body.editRequest.reactSourceTarget.routeEntries
      : jobResult.routeEntries?.length
        ? jobResult.routeEntries
        : persistedContext?.routeEntries;
    const plan = jobResult.plan ?? [];

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

    if (!frontendDir || !(await this.pathExists(frontendDir))) {
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        error:
          'frontendDir could not be resolved — job may not have a completed preview on disk',
      };
    }

    // Resolve component + section from section-manifest.json when targetHint
    // has no componentName yet (new capture-region flow — no DOM metadata needed).
    let editRequest = body.editRequest;
    if (previewDir && !editRequest.targetHint?.componentName) {
      const manifest = await this.sectionManifest.readManifest(previewDir);
      if (manifest) {
        const route =
          editRequest.pageContext?.reactRoute?.trim() ||
          editRequest.targetHint?.route?.trim() ||
          null;
        const normalizedRect = (editRequest.attachments ?? [])[0]?.geometry
          ?.normalizedRect;
        if (route && normalizedRect) {
          const resolved = this.sectionManifest.resolveSection(
            manifest,
            route,
            normalizedRect,
          );
          if (resolved) {
            this.logger.log(
              `[visual-edit] manifest resolved: component=${resolved.componentName} section[${resolved.sectionIndex}] ${resolved.sectionType} (${resolved.debugKey})`,
            );
            editRequest = {
              ...editRequest,
              targetHint: {
                ...editRequest.targetHint,
                componentName: resolved.componentName,
                sectionIndex: resolved.sectionIndex,
                sectionType: resolved.sectionType,
              },
            };
          }
        }
      }
    }

    try {
      const contract = this.reactVisualEditContract.validate({
        editRequest,
        plan,
        routeEntries,
      });
      if (
        contract.resolvedComponentName &&
        !editRequest.targetHint?.componentName?.trim()
      ) {
        editRequest = {
          ...editRequest,
          targetHint: {
            ...editRequest.targetHint,
            componentName: contract.resolvedComponentName,
          },
        };
      }

      const editResult = await this.reactVisualEdit.applyEdit({
        jobId: body.jobId,
        frontendDir,
        plan,
        routeEntries,
        editRequest,
        logPath,
      });

      return {
        accepted: true,
        jobId: body.jobId,
        siteId: body.siteId,
        logPath,
        result: {
          ...editResult,
          warnings: Array.from(
            new Set([
              ...(contract.warnings ?? []),
              ...(editResult.warnings ?? []),
            ]),
          ),
        },
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

  private async readPersistedVisualEditContext(jobId: string): Promise<{
    previewDir: string;
    frontendDir: string;
    uiSourceMapPath?: string;
    routeEntries?: Array<{ route: string; componentName: string }>;
  } | null> {
    const previewDir = join('./temp/generated', jobId);
    const frontendDir = join(previewDir, 'frontend');

    if (!(await this.pathExists(frontendDir))) {
      return null;
    }

    const uiSourceMapPathCandidate = join(previewDir, 'ui-source-map.json');
    const uiSourceMapPath = (await this.pathExists(uiSourceMapPathCandidate))
      ? uiSourceMapPathCandidate
      : undefined;
    const routeEntries = await this.readPersistedRouteEntries(
      previewDir,
      frontendDir,
    );

    return {
      previewDir,
      frontendDir,
      ...(uiSourceMapPath ? { uiSourceMapPath } : {}),
      ...(routeEntries.length > 0 ? { routeEntries } : {}),
    };
  }

  private async readPersistedRouteEntries(
    previewDir: string,
    frontendDir: string,
  ): Promise<Array<{ route: string; componentName: string }>> {
    const fromManifest = await this.sectionManifest.readManifest(previewDir);
    if (fromManifest?.length) {
      const deduped = new Map<
        string,
        { route: string; componentName: string }
      >();
      for (const entry of fromManifest) {
        const route = entry.route?.trim();
        const componentName = entry.componentName?.trim();
        if (!route || !componentName) continue;
        deduped.set(`${route}::${componentName}`, { route, componentName });
      }
      if (deduped.size > 0) {
        return Array.from(deduped.values());
      }
    }

    const appPath = join(frontendDir, 'src', 'App.tsx');
    if (!(await this.pathExists(appPath))) {
      return [];
    }

    try {
      const appCode = await readFile(appPath, 'utf-8');
      const routeEntries: Array<{ route: string; componentName: string }> = [];
      const routePattern =
        /<Route\s+path="([^"]+)"\s+element={<([A-Za-z0-9_]+)\s*\/>}\s*\/>/g;
      for (const match of appCode.matchAll(routePattern)) {
        const route = match[1]?.trim();
        const componentName = match[2]?.trim();
        if (!route || !componentName) continue;
        routeEntries.push({ route, componentName });
      }
      return routeEntries;
    } catch (error) {
      this.logger.warn(
        `[visual-edit] failed to parse persisted App.tsx route entries: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
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

  async skipVisualCompare(body: SkipVisualCompareDto): Promise<{
    accepted: boolean;
    jobId: string;
    siteId: string;
    step: '9_visual_compare';
    error?: string;
  }> {
    const state = this.jobs.get(body.jobId);
    if (!state) {
      throw new BadRequestException(`Job "${body.jobId}" not found`);
    }

    const control = this.controls.get(body.jobId);
    const visualCompareStep = state.steps.find(
      (step) => step.name === '9_visual_compare',
    );

    if (!visualCompareStep || !control) {
      await this.logVisualCompareControlTrace(control?.logPath, {
        event: 'skip_visual_compare_rejected',
        reason: 'visual_compare_step_missing',
        jobId: body.jobId,
        siteId: body.siteId,
        stateStatus: state.status,
      });
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        step: '9_visual_compare',
        error: 'This job does not expose a visual compare stage.',
      };
    }

    if (
      visualCompareStep.status === 'done' ||
      visualCompareStep.status === 'skipped'
    ) {
      await this.logVisualCompareControlTrace(control.logPath, {
        event: 'skip_visual_compare_rejected',
        reason: 'visual_compare_already_finished',
        jobId: body.jobId,
        siteId: body.siteId,
        stateStatus: state.status,
        stepStatus: visualCompareStep.status,
      });
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        step: '9_visual_compare',
        error: 'Visual compare has already completed for this job.',
      };
    }

    if (state.status !== 'running') {
      await this.logVisualCompareControlTrace(control.logPath, {
        event: 'skip_visual_compare_rejected',
        reason: 'job_not_running',
        jobId: body.jobId,
        siteId: body.siteId,
        stateStatus: state.status,
        stepStatus: visualCompareStep.status,
      });
      return {
        accepted: false,
        jobId: body.jobId,
        siteId: body.siteId,
        step: '9_visual_compare',
        error: `Visual compare cannot be skipped while the job is "${state.status}".`,
      };
    }

    control.skipVisualCompareRequested = true;

    const requestMessage =
      'User requested to stop baseline visual compare and metric-driven repair. The pipeline will continue from the current preview at the next safe checkpoint.';

    if (control.logPath) {
      await this.logToFile(
        control.logPath,
        `[Visual Metrics Control] ${requestMessage}`,
      );
      await this.logVisualCompareControlTrace(control.logPath, {
        event: 'skip_visual_compare_requested',
        jobId: body.jobId,
        siteId: body.siteId,
        stateStatus: state.status,
        stepStatus: visualCompareStep.status,
        hasMetricsSnapshot: Boolean(state.result?.metrics),
      });
    }

    if (visualCompareStep.status === 'running') {
      this.progress.get(body.jobId)?.next({
        step: '9_visual_compare',
        label: this.getStepMeta('9_visual_compare', body.jobId).label,
        status: 'running',
        percent: this.calcPercentBefore('9_visual_compare', body.jobId),
        message: requestMessage,
        data: this.getStepEventData(body.jobId, '9_visual_compare'),
      });
      control.visualCompareSkipResolver?.(requestMessage);
    }

    return {
      accepted: true,
      jobId: body.jobId,
      siteId: body.siteId,
      step: '9_visual_compare',
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

  async startPreview(jobId: string) {
    return this.previewBuilder.startPreviewForJob(jobId);
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
    return this.runtimeSupport.getProgressStream(jobId, this.progress);
  }

  private createPendingEditApprovalGate(): PendingEditApprovalGate {
    return this.runtimeSupport.createPendingEditApprovalGate();
  }

  private getStepMeta(name: string, jobId?: string) {
    return this.runtimeSupport.getStepMeta(name, jobId, this.controls);
  }

  private getStepOrder(jobId?: string): string[] {
    return this.runtimeSupport.getStepOrder(jobId, this.jobs);
  }

  private getTotalWeight(jobId?: string): number {
    return this.runtimeSupport.getTotalWeight(jobId, {
      jobs: this.jobs,
      controls: this.controls,
    });
  }

  private calcPercentBefore(name: string, jobId?: string): number {
    return this.runtimeSupport.calcPercentBefore(name, jobId, {
      jobs: this.jobs,
      controls: this.controls,
    });
  }

  private calcPercentThrough(name: string, jobId?: string): number {
    return this.runtimeSupport.calcPercentThrough(name, jobId, {
      jobs: this.jobs,
      controls: this.controls,
    });
  }

  private emitStepProgress(
    state: PipelineStatus,
    name: string,
    progressWithinStep: number,
    message: string,
    data?: ProgressEventData,
  ): void {
    this.runtimeSupport.emitStepProgress({
      state,
      name,
      progressWithinStep,
      message,
      data,
      stores: this.getRuntimeStores(),
    });
  }

  private assertJobActive(jobId: string): void {
    this.runtimeSupport.assertJobActive(jobId, this.controls);
  }

  private rememberStepEventData(
    jobId: string,
    stepName: string,
    data?: ProgressEventData,
  ): void {
    this.runtimeSupport.rememberStepEventData(
      jobId,
      stepName,
      data,
      this.stepEventData,
    );
  }

  private getStepEventData(
    jobId: string,
    stepName: string,
  ): ProgressEventData | undefined {
    return this.runtimeSupport.getStepEventData(
      jobId,
      stepName,
      this.stepEventData,
    );
  }

  private clearStepEventData(jobId: string): void {
    this.runtimeSupport.clearStepEventData(jobId, this.stepEventData);
  }

  private async delayWithControl(jobId: string, ms: number): Promise<void> {
    await this.runtimeSupport.delayWithControl(jobId, ms, this.controls);
  }

  private async stopPreviewProcesses(
    preview?: Pick<PreviewBuilderResult, 'frontendPid' | 'serverPid'>,
  ): Promise<void> {
    await this.runtimeSupport.stopPreviewProcesses(preview);
  }

  private async broadcastUnexpectedShutdown(signal?: string): Promise<void> {
    await this.runtimeSupport.broadcastUnexpectedShutdown(
      signal,
      this.getRuntimeStores(),
    );
  }

  private async finalizeControlledTermination(
    jobId: string,
    state: PipelineStatus,
    err: PipelineControlError,
  ): Promise<void> {
    await this.runtimeSupport.finalizeControlledTermination(
      jobId,
      state,
      err,
      this.getRuntimeStores(),
    );
  }

  private resolveTextLogPath(logPath: string): string | null {
    return this.runtimeSupport.resolveTextLogPath(logPath);
  }

  private async logToFile(logPath: string, message: string): Promise<void> {
    await this.runtimeSupport.logToFile(logPath, message);
  }

  private async logVisualMetricsTrace(
    logPath: string,
    message: string,
  ): Promise<void> {
    await this.runtimeSupport.logVisualMetricsTrace(logPath, message);
  }

  private async logVisualCompareControlTrace(
    logPath: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.runtimeSupport.logVisualCompareControlTrace(logPath, payload);
  }

  private async writeVisualDiagnosisArtifacts(
    logPath: string,
    componentName: string,
    diagnosis: VisualMismatchDiagnosis,
  ): Promise<void> {
    await this.runtimeSupport.writeVisualDiagnosisArtifacts(
      logPath,
      componentName,
      diagnosis,
    );
  }

  private updateStateResult(
    state: PipelineStatus,
    patch: Record<string, unknown>,
  ): void {
    state.result = {
      ...(state.result ?? {}),
      ...patch,
    };
  }

  private buildRepoSummary(
    repoResult: RepoAnalyzeResult,
  ): Record<string, unknown> {
    return {
      themeDir: repoResult.themeDir,
      totalFiles: repoResult.totalFiles,
      themeCount: repoResult.themeCount,
      pluginCount: repoResult.pluginCount,
      themeInventoryFiles: repoResult.themeInventoryFiles,
      pluginFiles: repoResult.pluginFiles,
      themeSlug: repoResult.themeManifest.themeTypeHints.themeSlug,
      detectedThemeKind:
        repoResult.themeManifest.themeTypeHints.detectedThemeKind,
      sourceOfTruth: repoResult.themeManifest.sourceOfTruth,
    };
  }

  private buildThemeSummary(
    theme: PhpParseResult | BlockParseResult,
  ): Record<string, unknown> {
    return {
      type: theme.type,
      themeName: theme.themeName ?? null,
      templateCount: theme.templates.length,
      partCount: theme.type === 'fse' ? theme.parts.length : 0,
      tokenSummary:
        'tokens' in theme
          ? {
              colors: theme.tokens?.colors?.length ?? 0,
              fonts: theme.tokens?.fonts?.length ?? 0,
              fontSizes: theme.tokens?.fontSizes?.length ?? 0,
              spacing: theme.tokens?.spacing?.length ?? 0,
            }
          : undefined,
    };
  }

  private buildContentSummary(
    content: DbContentResult,
  ): Record<string, unknown> {
    return {
      siteName: content.siteInfo.siteName,
      siteUrl: content.siteInfo.siteUrl,
      postCount: content.posts.length,
      pageCount: content.pages.length,
      menuCount: content.menus.length,
      dbNavigationCount: content.dbNavigations.length,
      dbTemplateCount: content.dbTemplates.length,
      dbGlobalStyleCount: content.dbGlobalStyles.length,
      customCssEntryCount: content.customCssEntries.length,
      taxonomyCount: content.taxonomies.length,
      mediaAttachmentCount: content.mediaAttachments.length,
      pluginCount: content.plugins.length,
      detectedPluginCount: content.detectedPlugins.length,
      customPostTypeCount: content.customPostTypes.length,
      frontPageId: content.readingSettings.pageOnFront?.id ?? null,
      postsPageId: content.readingSettings.pageForPosts?.id ?? null,
    };
  }

  private buildPlanSummary(plan: PlanResult): Record<string, unknown> {
    return {
      componentCount: plan.length,
      pageCount: plan.filter((item) => item.type === 'page').length,
      partialCount: plan.filter((item) => item.type === 'partial').length,
      routeCount: plan.filter((item) => Boolean(item.route)).length,
      detailCount: plan.filter((item) => item.isDetail).length,
      visualPlanCount: plan.filter((item) => Boolean(item.visualPlan)).length,
      componentNames: plan.map((item) => item.componentName),
    };
  }

  private buildGeneratedComponentSummary(
    components: ReactGenerateResult['components'],
  ): Record<string, unknown> {
    return {
      componentCount: components.length,
      pageComponentCount: components.filter((item) => item.type === 'page')
        .length,
      partialComponentCount: components.filter(
        (item) => item.type === 'partial',
      ).length,
      routeComponentCount: components.filter((item) => Boolean(item.route))
        .length,
      deterministicComponentCount: components.filter(
        (item) => item.generationMode === 'deterministic',
      ).length,
      aiComponentCount: components.filter(
        (item) => item.generationMode !== 'deterministic',
      ).length,
      componentNames: components.map((item) => item.name),
    };
  }

  private snapshotComponentsByName(
    components: ReactGenerateResult['components'],
  ): Map<string, ReactGenerateResult['components'][number]> {
    return new Map(
      components.map(
        (component) => [component.name, { ...component }] as const,
      ),
    );
  }

  private isCriticalComponentForFallback(
    componentPlan?: PlanResult[number],
    component?: ReactGenerateResult['components'][number],
  ): boolean {
    const route = componentPlan?.route ?? component?.route ?? null;
    if (route) return true;
    if ((componentPlan?.type ?? component?.type) === 'page') return true;
    const dataNeeds = [
      ...(componentPlan?.dataNeeds ?? []),
      ...(component?.dataNeeds ?? []),
    ];
    if (
      dataNeeds.includes('postDetail') ||
      dataNeeds.includes('pageDetail') ||
      dataNeeds.includes('post-detail') ||
      dataNeeds.includes('page-detail')
    ) {
      return true;
    }
    const sectionTypes = new Set(
      componentPlan?.visualPlan?.sections.map((section) => section.type) ?? [],
    );
    if (
      sectionTypes.has('post-content') ||
      sectionTypes.has('page-content') ||
      sectionTypes.has('prose-block')
    ) {
      return true;
    }
    return false;
  }

  private recordDegradedComponent(
    state: PipelineStatus,
    degradedComponents: DegradedComponentRecord[],
    record: DegradedComponentRecord,
  ): void {
    degradedComponents.push(record);
    this.updateStateResult(state, {
      degradedComponents: degradedComponents.map((item) => ({ ...item })),
    });
  }

  private buildDegradedPlaceholderComponent(
    component: ReactGenerateResult['components'][number],
  ): ReactGenerateResult['components'][number] {
    const code = `import React from 'react';

export default function ${component.name}() {
  return null;
}
`;

    return {
      ...component,
      code,
      generationMode: 'deterministic',
      visualPlan: undefined,
    };
  }

  private async applyComponentFallbacks(input: {
    state: PipelineStatus;
    components: ReactGenerateResult['components'];
    failures: Array<{
      component: ReactGenerateResult['components'][number];
      error: string;
    }>;
    plan: PlanResult;
    logPath: string;
    stage: DegradedComponentRecord['stage'];
    degradedComponents: DegradedComponentRecord[];
    lastKnownSafeComponents: Map<
      string,
      ReactGenerateResult['components'][number]
    >;
    hasSharedHeader?: boolean;
    hasSharedFooter?: boolean;
  }): Promise<{
    components: ReactGenerateResult['components'];
    appliedCount: number;
  }> {
    const {
      state,
      plan,
      logPath,
      stage,
      degradedComponents,
      lastKnownSafeComponents,
      hasSharedHeader = false,
      hasSharedFooter = false,
    } = input;
    const components = [...input.components];
    let appliedCount = 0;

    for (const failure of input.failures) {
      const componentName = failure.component.name;
      const componentPlan = plan.find(
        (entry) => entry.componentName === componentName,
      );
      const critical = this.isCriticalComponentForFallback(
        componentPlan,
        failure.component,
      );
      const componentIndex = components.findIndex(
        (component) => component.name === componentName,
      );
      if (componentIndex === -1) continue;

      const safeSnapshot = lastKnownSafeComponents.get(componentName);
      if (safeSnapshot) {
        components[componentIndex] = { ...safeSnapshot };
        appliedCount += 1;
        this.recordDegradedComponent(state, degradedComponents, {
          componentName,
          route: componentPlan?.route ?? failure.component.route ?? null,
          stage,
          fallbackType: 'last-known-safe',
          reason: failure.error,
          critical,
          timestamp: new Date().toISOString(),
        });
        await this.logToFile(
          logPath,
          `[Fallback] ${stage} restored last-known-safe snapshot for "${componentName}" (critical=${critical ? 'yes' : 'no'}). Reason: ${failure.error}`,
        );
        continue;
      }

      const deterministicFallback =
        this.reactGenerator.generateDeterministicFallbackComponent({
          component: failure.component,
          plan,
          hasSharedHeader,
          hasSharedFooter,
        });
      if (deterministicFallback) {
        const fallbackValidation = this.validator.collectValidationIssues([
          deterministicFallback,
        ]);
        if (fallbackValidation.failures.length === 0) {
          components[componentIndex] = fallbackValidation.components[0];
          appliedCount += 1;
          this.recordDegradedComponent(state, degradedComponents, {
            componentName,
            route: componentPlan?.route ?? failure.component.route ?? null,
            stage,
            fallbackType: 'canonical-deterministic',
            reason: failure.error,
            critical,
            timestamp: new Date().toISOString(),
          });
          await this.logToFile(
            logPath,
            `[Fallback] ${stage} replaced "${componentName}" with canonical deterministic fallback (critical=${critical ? 'yes' : 'no'}). Reason: ${failure.error}`,
          );
          continue;
        }

        await this.logToFile(
          logPath,
          `[Fallback] ${stage} deterministic fallback for "${componentName}" still failed validation: ${fallbackValidation.failures[0]?.error ?? 'unknown'}`,
        );
      }

      if (!critical) {
        const placeholder = this.buildDegradedPlaceholderComponent(
          failure.component,
        );
        const placeholderValidation = this.validator.collectValidationIssues([
          placeholder,
        ]);
        if (placeholderValidation.failures.length === 0) {
          components[componentIndex] = placeholderValidation.components[0];
          appliedCount += 1;
          this.recordDegradedComponent(state, degradedComponents, {
            componentName,
            route: componentPlan?.route ?? failure.component.route ?? null,
            stage,
            fallbackType: 'degraded-placeholder',
            reason: failure.error,
            critical: false,
            timestamp: new Date().toISOString(),
          });
          await this.logToFile(
            logPath,
            `[Fallback] ${stage} downgraded non-critical component "${componentName}" to a safe placeholder after all richer fallbacks failed.`,
          );
          continue;
        }

        await this.logToFile(
          logPath,
          `[Fallback] ${stage} placeholder degrade for non-critical component "${componentName}" still failed validation: ${placeholderValidation.failures[0]?.error ?? 'unknown'}`,
        );
      }
    }

    return { components, appliedCount };
  }

  private async executePipelineLegacy(
    jobId: string,
    siteId: string,
    dto: RunPipelineDto,
    state: PipelineStatus,
    editRequestContext?: ResolvedEditRequestContext,
    userId?: string,
  ): Promise<void> {
    // ── Init structured run summary ───────────────────────────────────────
    const jobLogDir = join('./temp/logs', jobId);
    await mkdir(jobLogDir, { recursive: true });
    const logPath = join(jobLogDir, 'run-summary.json');
    const runLogPath = this.resolveTextLogPath(logPath) ?? undefined;
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
    this.updateStateResult(state, {
      runSummaryPath: logPath,
      runLogPath,
    });
    await this.tokenTracker.init(logPath);
    let metrics: SiteCompareMetrics | null = null;
    let baselineMetrics: SiteCompareMetrics | null = null;
    let visualRouteResults: AutomationComparePageResult[] = [];
    const degradedComponents: DegradedComponentRecord[] = [];
    let lastKnownSafeComponents = new Map<
      string,
      ReactGenerateResult['components'][number]
    >();
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
      this.updateStateResult(state, {
        repoSummary: this.buildRepoSummary(repoResult),
      });
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
      this.updateStateResult(state, {
        themeSummary: this.buildThemeSummary(normalizedTheme),
      });
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
      this.updateStateResult(state, {
        contentSummary: this.buildContentSummary(content),
        themeSummary: this.buildThemeSummary(normalizedTheme),
        repoAnalysisSummary: summaryDraft.repoAnalysisSummary,
      });
      await this.planner.writeArtifact(
        logPath,
        'layout-analysis.json',
        this.planner.buildLayoutAnalysisArtifact(
          normalizedTheme,
          content,
          repoResult.themeManifest,
        ),
      );

      // ── Stage 3: Planner (C1 → C2 → C3 → C4 → C5 → C6 retry) ────────────
      // All 4 phases + plan review + retry loop are ONE atomic step.
      // Per diagram: C4 (Plan Review) and C5 (Plan Valid?) live INSIDE the Planner subgraph.
      const MAX_PLAN_RETRIES = 3;
      const strictPlanReview =
        this.configService.get<boolean>('planner.strictReview') ?? true;
      const expectedTemplateNames = this.planner.getExpectedTemplateNames(
        normalizedTheme,
        content,
        repoResult.themeManifest,
        { logScope: false },
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
          plan = await this.planner.attachSharedChromePartialVisualPlans(
            normalizedTheme,
            content,
            plan,
            resolvedModels.planning,
            repoResult.themeManifest,
            undefined,
            logPath,
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
          let reviewedExpectedTemplateNames = review.expectedTemplateNames;
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
          await this.planner.writeArtifact(
            logPath,
            `routing.attempt-${planAttempt}.json`,
            this.planner.buildRoutingDecisionArtifact({
              plan: review.plan,
              content,
              repoManifest: repoResult.themeManifest,
              expectedTemplateNames: reviewedExpectedTemplateNames,
            }),
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
            plan = await this.planner.attachSharedChromePartialVisualPlans(
              normalizedTheme,
              content,
              plan,
              resolvedModels.planning,
              repoResult.themeManifest,
              undefined,
              logPath,
            );
            review = this.planReviewer.review(
              plan,
              reviewedExpectedTemplateNames,
              repoResult.themeManifest,
            );
            reviewedExpectedTemplateNames = review.expectedTemplateNames;
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
            await this.planner.writeArtifact(
              logPath,
              `routing.attempt-${planAttempt}.json`,
              this.planner.buildRoutingDecisionArtifact({
                plan: review.plan,
                content,
                repoManifest: repoResult.themeManifest,
                expectedTemplateNames: reviewedExpectedTemplateNames,
              }),
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
            undefined,
            logPath,
          );
          let visualReview = this.planReviewer.review(
            planWithVisuals,
            reviewedExpectedTemplateNames,
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
              undefined,
              logPath,
            );
            visualReview = this.planReviewer.review(
              planWithVisuals,
              reviewedExpectedTemplateNames,
              repoResult.themeManifest,
            );
            reviewedExpectedTemplateNames = visualReview.expectedTemplateNames;
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
          await this.planner.writeArtifact(
            logPath,
            'routing.final.json',
            this.planner.buildRoutingDecisionArtifact({
              plan: review.plan,
              content,
              repoManifest: repoResult.themeManifest,
              expectedTemplateNames: reviewedExpectedTemplateNames,
            }),
          );
          await this.planner.writeArtifact(
            logPath,
            'deterministic-render-contract.json',
            this.planner.buildDeterministicRenderContractArtifact(review.plan),
          );
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
      this.updateStateResult(state, {
        plan: reviewResult.plan,
        planSummary: this.buildPlanSummary(reviewResult.plan),
      });
      const hasSharedHeader = reviewResult.plan.some(
        (item) =>
          item.type === 'partial' && /^header/i.test(item.componentName),
      );
      const hasSharedFooter = reviewResult.plan.some(
        (item) =>
          item.type === 'partial' && /^footer/i.test(item.componentName),
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
            '[D1] Generating React components from the approved visual plans.',
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
            `[D4] Generated ${result.components.length} component file(s). Running validator cleanup and contract checks.`,
          );
          const MAX_VALIDATION_FIX_ATTEMPTS = 2;
          let validation = this.validator.collectValidationIssues(
            result.components,
          );
          let components = validation.components;
          await this.reactGenerator.persistDraftComponents(jobId, components);
          const validateCandidateInComponentSet = (
            candidate: GeneratedComponent,
            componentIndex: number,
          ) => {
            const candidateSet = components.map((component, index) =>
              index === componentIndex ? candidate : component,
            );
            const candidateValidation =
              this.validator.collectValidationIssues(candidateSet);
            return {
              validation: candidateValidation,
              component: candidateValidation.components[componentIndex],
              failure: candidateValidation.failures.find(
                (item) => item.component.name === candidate.name,
              ),
            };
          };

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
              `[D4] Validator fix ${attempt}/${MAX_VALIDATION_FIX_ATTEMPTS}: repairing ${validation.failures.length} component contract issue(s).`,
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
                    const sanitizedValidation = validateCandidateInComponentSet(
                      sanitized,
                      compIndex,
                    );
                    if (!sanitizedValidation.failure) {
                      this.logger.log(
                        `[Stage 4: D4 Validator] Deterministically sanitized "${failure.component.name}" before AI fix.`,
                      );
                      await this.logToFile(
                        logPath,
                        `[Stage 4: D4 Validator] Deterministically sanitized "${failure.component.name}" before AI fix.`,
                      );
                      return {
                        compIndex,
                        component: sanitizedValidation.component,
                      };
                    }
                    targetComponent = sanitizedValidation.component;
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
                const revalidated = validateCandidateInComponentSet(
                  fixed,
                  compIndex,
                );
                if (revalidated.failure) {
                  const retryError = revalidated.failure.error;
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
                      feedback: this.buildFullComponentRegenerationFeedback(
                        failure.component.name,
                        retryError,
                        regenerationDiagnostics,
                      ),
                      modelConfig: { fixAgent: resolvedModels.fixAgent },
                      logPath,
                      fixMode: 'full',
                    });
                    const regeneratedValidation =
                      validateCandidateInComponentSet(regenerated, compIndex);
                    if (!regeneratedValidation.failure) {
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
                        component: regeneratedValidation.component,
                      };
                    }
                    const regeneratedError =
                      regeneratedValidation.failure?.error;
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
                  component: revalidated.component,
                };
              }),
            );

            for (const fixResult of fixResults) {
              if (fixResult)
                components[fixResult.compIndex] = fixResult.component;
            }

            validation = this.validator.collectValidationIssues(components);
            components = validation.components;
            await this.reactGenerator.persistDraftComponents(jobId, components);
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
            const fallbackRecovery = await this.applyComponentFallbacks({
              state,
              components,
              failures: fatalValidationFailures,
              plan: reviewResult.plan,
              logPath,
              stage: 'stage4-validator',
              degradedComponents,
              lastKnownSafeComponents,
              hasSharedHeader,
              hasSharedFooter,
            });
            components = fallbackRecovery.components;
            validation = this.validator.collectValidationIssues(components);
            components = validation.components;
            await this.reactGenerator.persistDraftComponents(jobId, components);
            const remainingFatalValidationFailures = validation.failures.filter(
              (failure) =>
                !this.shouldTolerateProtectedDeterministicSharedPartialFailure(
                  failure.component,
                  failure.error,
                ),
            );
            if (remainingFatalValidationFailures.length > 0) {
              throw new Error(
                `[validator] Generated component validation failed after auto-fix/fallback:\n${remainingFatalValidationFailures
                  .map(
                    (failure) =>
                      `Component "${failure.component.name}": ${failure.error}`,
                  )
                  .join('\n')}`,
              );
            }
          }
          lastKnownSafeComponents = this.snapshotComponentsByName(components);

          // Deterministic components (Header, Footer, Sidebar, Page404, etc.) were
          // generated entirely by CodeGeneratorService — no LLM TSX gen involved.
          // Protected shared partials are syntax-checked and syntax-fixed in Stage 4.
          // Focused edit-request refinements run later, after the baseline preview is live.
          const aiComponentNames = new Set(
            components
              .filter((c) => c.generationMode !== 'deterministic')
              .map((c) => c.name),
          );
          const aiComponents = components.filter(
            (c) =>
              c.generationMode !== 'deterministic' ||
              this.componentImportsAny(c, aiComponentNames),
          );
          const aiReviewComponentNames = new Set(
            aiComponents.map((component) => component.name),
          );
          const deterministicNames = components
            .filter(
              (c) =>
                c.generationMode === 'deterministic' &&
                !aiReviewComponentNames.has(c.name),
            )
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
              `[R1] AI review pass ${attempt}/${MAX_FIX_ATTEMPTS}: checking the generated baseline components against the approved contract.`,
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

            if (review.failures.length === 0) {
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
              `[R3] Auto-fixing ${review.failures.length} component(s) that failed AI review.`,
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
                const validateAiCandidateInFullSet = (
                  candidate: GeneratedComponent,
                ) => {
                  const fullIndex = components.findIndex(
                    (component) => component.name === candidate.name,
                  );
                  const baseSet = components.map((component) => {
                    const currentAiVersion = aiComponents.find(
                      (item) => item.name === component.name,
                    );
                    return currentAiVersion ?? component;
                  });
                  const candidateSet =
                    fullIndex >= 0
                      ? baseSet.map((component) =>
                          component.name === candidate.name
                            ? candidate
                            : component,
                        )
                      : [...baseSet, candidate];
                  const candidateValidation =
                    this.validator.collectValidationIssues(candidateSet);
                  return {
                    validation: candidateValidation,
                    component:
                      candidateValidation.components.find(
                        (item) => item.name === candidate.name,
                      ) ?? candidate,
                    failure: candidateValidation.failures.find(
                      (item) => item.component.name === candidate.name,
                    ),
                  };
                };
                const fixed = await this.reactGenerator.fixComponent({
                  component: aiComponents[compIndex],
                  plan: reviewResult.plan,
                  feedback: failure.message,
                  modelConfig: { fixAgent: resolvedModels.fixAgent },
                  logPath,
                });
                const revalidated = validateAiCandidateInFullSet(fixed);
                if (revalidated.failure) {
                  const validationErr = revalidated.failure.error;
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
                      feedback: this.buildFullComponentRegenerationFeedback(
                        failure.componentName,
                        validationErr,
                        regenerationDiagnostics,
                      ),
                      modelConfig: { fixAgent: resolvedModels.fixAgent },
                      logPath,
                      fixMode: 'full',
                    });
                    const regeneratedValidation =
                      validateAiCandidateInFullSet(regenerated);
                    if (!regeneratedValidation.failure) {
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
                        component: regeneratedValidation.component,
                      };
                    }
                    const regeneratedErr = regeneratedValidation.failure?.error;
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
                return { compIndex, component: revalidated.component };
              }),
            );
            for (const r of fixResults) {
              if (r) aiComponents[r.compIndex] = r.component;
            }
            await this.reactGenerator.persistDraftComponents(jobId, [
              ...components.filter(
                (component) =>
                  !aiComponents.some((ai) => ai.name === component.name),
              ),
              ...aiComponents,
            ]);
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
            const fallbackRecovery = await this.applyComponentFallbacks({
              state,
              components: postReviewValidation.components,
              failures: fatalPostReviewFailures,
              plan: reviewResult.plan,
              logPath,
              stage: 'stage5-review',
              degradedComponents,
              lastKnownSafeComponents,
              hasSharedHeader,
              hasSharedFooter,
            });
            const recoveredValidation = this.validator.collectValidationIssues(
              fallbackRecovery.components,
            );
            const remainingFatalPostReviewFailures =
              recoveredValidation.failures.filter(
                (failure) =>
                  !this.shouldTolerateProtectedDeterministicSharedPartialFailure(
                    failure.component,
                    failure.error,
                  ),
              );
            if (remainingFatalPostReviewFailures.length > 0) {
              throw new Error(
                `[validator] Generated component validation failed after AI review/fix/fallback:\n${remainingFatalPostReviewFailures
                  .map(
                    (failure) =>
                      `Component "${failure.component.name}": ${failure.error}`,
                  )
                  .join('\n')}`,
              );
            }
            components = recoveredValidation.components;
          } else {
            components = postReviewValidation.components;
          }
          await this.reactGenerator.persistDraftComponents(jobId, components);
          lastKnownSafeComponents = this.snapshotComponentsByName(components);

          this.emitStepProgress(
            state,
            '6_generator',
            0.94,
            '[D1→R3] React generation, validation, and repair loops have finished successfully.',
          );
          return { ...result, components };
        },
      );
      this.updateStateResult(state, {
        generationSummary: this.buildGeneratedComponentSummary(
          generationResult.components,
        ),
      });
      await stepDelay();

      // ── Stage 6: Build & Preview (E1 → E2 → E3 → E4) ──────────────────────
      const apiResult = await this.runStep(
        state,
        '7_api_builder',
        logPath,
        async () => {
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
        },
      );
      this.updateStateResult(state, {
        apiSummary: {
          fileCount: apiResult.files.length,
        },
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
                    ? (normalizedTheme as { tokens?: ThemeTokens }).tokens
                    : undefined,
                plan: reviewResult.plan,
                repoManifest: repoResult.themeManifest,
              });
            } catch (err: any) {
              const errMsg: string = err?.message ?? String(err);
              const isBuildFail = errMsg.includes(
                '[validator] Preview build failed:',
              );
              const tsErrors = this.parseTsBuildErrors(errMsg);
              if (!isBuildFail) throw err;
              if (tsErrors.length === 0) throw err;
              if (attempt > MAX_BUILD_FIX_ATTEMPTS) throw err;
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

              if (attempt === MAX_BUILD_FIX_ATTEMPTS) {
                const fallbackFailures = tsErrors
                  .map(({ componentName, error }) => {
                    const component = buildComponents.find(
                      (item) => item.name === componentName,
                    );
                    if (!component) return null;
                    return { component, error };
                  })
                  .filter(
                    (
                      entry,
                    ): entry is {
                      component: ReactGenerateResult['components'][number];
                      error: string;
                    } => Boolean(entry),
                  );
                if (fallbackFailures.length > 0) {
                  const fallbackRecovery = await this.applyComponentFallbacks({
                    state,
                    components: buildComponents,
                    failures: fallbackFailures,
                    plan: reviewResult.plan,
                    logPath,
                    stage: 'stage8-build',
                    degradedComponents,
                    lastKnownSafeComponents,
                    hasSharedHeader,
                    hasSharedFooter,
                  });
                  if (fallbackRecovery.appliedCount > 0) {
                    buildComponents = fallbackRecovery.components;
                    await this.logToFile(
                      logPath,
                      `[Stage 8: Build Fix] Applied ${fallbackRecovery.appliedCount} fallback component replacement(s) after exhausting direct build fixes. Retrying preview build one last time.`,
                    );
                  }
                }
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
      this.updateStateResult(state, {
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
      });
      {
        const subject = this.progress.get(jobId);
        const meta = this.getStepMeta('8_preview_builder', jobId);
        subject?.next({
          step: '8_preview_builder',
          label: meta.label,
          status: 'done',
          percent: this.calcPercentThrough('8_preview_builder', jobId),
          message: hasEditRequest
            ? 'Baseline preview is live. Baseline compare metrics will run before any requested edit is presented for approval.'
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
      await stepDelay();

      await this.runStep(state, '9_visual_compare', logPath, async () => {
        const wpBaseUrl = content.siteInfo.siteUrl || 'http://localhost:8000/';
        const reactBeUrl = preview.apiBaseUrl.replace(/\/api\/?$/, '');
        const compareMode = 'baseline';
        const targetAccuracyPercent = 70;
        const maxMetricRepairRounds = 4;
        const previewTokens =
          'tokens' in normalizedTheme
            ? ((normalizedTheme as { tokens?: ThemeTokens }).tokens ??
              undefined)
            : undefined;
        const cloneGeneratedComponents = (
          source: ReactGenerateResult['components'],
        ): ReactGenerateResult['components'] =>
          source.map((component) => ({ ...component }));
        const formatAccuracyLabel = (value: number | null) =>
          value === null ? 'unknown' : `${value.toFixed(2)}%`;
        const skipVisualCompareIfRequested = async (
          reason: string,
        ): Promise<void> => {
          const compareControl = this.controls.get(jobId);
          if (!compareControl?.skipVisualCompareRequested) {
            return;
          }

          compareControl.skipVisualCompareRequested = false;
          compareControl.buildComponents = buildComponents;

          const stepEventData = this.buildPreviewEventData({
            preview,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: Boolean(compareControl.pendingEditApproval),
            editApplied: Boolean(compareControl.editApplied),
            metrics: metrics ?? undefined,
          });

          const skipMessage = `${reason} The pipeline will continue with the current baseline preview snapshot.`;
          this.rememberStepEventData(jobId, '9_visual_compare', stepEventData);
          this.updateStateResult(state, {
            previewDir: preview.previewDir,
            frontendDir: preview.frontendDir,
            previewUrl: preview.previewUrl,
            apiBaseUrl: preview.apiBaseUrl,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: Boolean(compareControl.pendingEditApproval),
            editApplied: Boolean(compareControl.editApplied),
            uiSourceMapPath: preview.uiSourceMapPath,
            routeEntries: preview.routeEntries,
            baselineMetrics: metrics,
            metrics,
          });
          await this.logToFile(
            logPath,
            `[Visual Metrics Control] ${skipMessage}`,
          );
          await this.logVisualCompareControlTrace(logPath, {
            event: 'skip_visual_compare_consumed',
            jobId,
            step: '9_visual_compare',
            checkpointReason: reason,
            hasMetricsSnapshot: Boolean(metrics),
            accuracyPercent: this.extractAccuracySummary(metrics).percent,
            previewStage: 'baseline',
            hasEditRequest,
            editApprovalRequired: Boolean(compareControl.pendingEditApproval),
            editApplied: Boolean(compareControl.editApplied),
          });

          throw new PipelineStepSkipError(skipMessage, stepEventData);
        };
        const runCompareRound = async (label: string) => {
          const compareResult = await this.compareSite({
            siteId,
            wpBaseUrl,
            reactFeUrl: preview.previewUrl,
            reactBeUrl,
            jobId,
            mode: compareMode,
            routeEntries: preview.routeEntries,
            preview,
            plan: reviewResult.plan,
            content,
          });
          if (compareResult.warnings?.length) {
            for (const warning of compareResult.warnings) {
              await this.logToFile(logPath, `[site-compare] ${warning}`);
            }
          }
          const nextMetrics = compareResult.metrics ?? null;
          if (nextMetrics) {
            await this.logAutomationCompareMetrics(logPath, label, nextMetrics);
          }
          return nextMetrics;
        };
        const waitForVisualCompareSkipRequest = (): Promise<void> =>
          new Promise((resolve) => {
            const compareControl = this.controls.get(jobId);
            if (!compareControl) return;
            if (compareControl.skipVisualCompareRequested) {
              resolve();
              return;
            }
            compareControl.visualCompareSkipResolver = () => resolve();
          });
        const runSkippableCompareRound = async (
          label: string,
        ): Promise<SiteCompareMetrics | null> => {
          const comparePromise = runCompareRound(label);
          const skipPromise = waitForVisualCompareSkipRequest().then(
            async () => {
              await skipVisualCompareIfRequested(
                'Visual compare was skipped while metric collection was still running.',
              );
              return null;
            },
          );

          try {
            return await Promise.race([comparePromise, skipPromise]);
          } finally {
            const compareControl = this.controls.get(jobId);
            if (compareControl) {
              compareControl.visualCompareSkipResolver = undefined;
            }
          }
        };

        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.2,
          `Running site compare metrics across WordPress and the React preview (target >= ${targetAccuracyPercent}%, max ${maxMetricRepairRounds} repair rounds).`,
        );
        await skipVisualCompareIfRequested(
          'Visual compare was skipped before baseline comparison started.',
        );

        try {
          metrics = await runSkippableCompareRound('initial');
        } catch (err: any) {
          if (err instanceof PipelineStepSkipError) {
            throw err;
          }
          this.logger.error(
            `[site-compare] failed — ${err?.message ?? err}`,
            err?.response?.data ?? err?.stack,
          );
        }
        await skipVisualCompareIfRequested(
          'Visual compare was skipped after the current baseline compare task finished.',
        );

        if (metrics) {
          let currentAccuracy = this.extractAccuracySummary(metrics).percent;
          let bestAccuracy = currentAccuracy ?? -1;
          let bestMetrics = metrics;
          let bestComponents = cloneGeneratedComponents(buildComponents);

          await this.logToFile(
            logPath,
            `[Visual Metrics Loop] Initial accuracy=${formatAccuracyLabel(currentAccuracy)} target>=${targetAccuracyPercent}% maxRounds=${maxMetricRepairRounds}`,
          );

          for (
            let round = 1;
            round <= maxMetricRepairRounds && metrics;
            round++
          ) {
            if (
              currentAccuracy !== null &&
              currentAccuracy >= targetAccuracyPercent
            ) {
              await this.logToFile(
                logPath,
                `[Visual Metrics Loop] Target reached before round ${round}: accuracy=${formatAccuracyLabel(currentAccuracy)} >= ${targetAccuracyPercent}%. Stopping metric repair loop.`,
              );
              break;
            }
            await skipVisualCompareIfRequested(
              `Visual compare was skipped before metric repair round ${round} started.`,
            );

            this.emitStepProgress(
              state,
              '9_visual_compare',
              Math.min(0.3 + round * 0.12, 0.82),
              `Metric repair round ${round}/${maxMetricRepairRounds}: current accuracy ${formatAccuracyLabel(currentAccuracy)}, target ${targetAccuracyPercent}%`,
            );
            await this.logToFile(
              logPath,
              `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} starting from accuracy=${formatAccuracyLabel(currentAccuracy)} (target>=${targetAccuracyPercent}%).`,
            );

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
            await skipVisualCompareIfRequested(
              `Visual compare was skipped after metric repair round ${round} finished applying changes.`,
            );

            if (!visualRepairResult.applied) {
              await this.logToFile(
                logPath,
                `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} produced no accepted repairs. Stopping metric repair loop.`,
              );
              break;
            }

            try {
              const roundMetrics = await runSkippableCompareRound(
                `round-${round}`,
              );
              await skipVisualCompareIfRequested(
                `Visual compare was skipped after re-checking preview metrics for round ${round}.`,
              );
              if (!roundMetrics) {
                await this.logToFile(
                  logPath,
                  `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} compare returned no metrics after repair. Stopping metric repair loop and keeping the latest valid preview snapshot.`,
                );
                metrics = bestMetrics;
                break;
              }

              const nextAccuracy =
                this.extractAccuracySummary(roundMetrics).percent;
              await this.logToFile(
                logPath,
                `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} result: accuracy=${formatAccuracyLabel(nextAccuracy)} previous=${formatAccuracyLabel(currentAccuracy)} best=${formatAccuracyLabel(bestAccuracy)} target>=${targetAccuracyPercent}%.`,
              );

              if (nextAccuracy !== null && nextAccuracy > bestAccuracy) {
                bestAccuracy = nextAccuracy;
                bestMetrics = roundMetrics;
                bestComponents = cloneGeneratedComponents(buildComponents);
                await this.logToFile(
                  logPath,
                  `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} established a new best snapshot at accuracy=${formatAccuracyLabel(bestAccuracy)}.`,
                );
              } else {
                await this.logToFile(
                  logPath,
                  `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} did not beat the best snapshot. Restoring best-known preview at accuracy=${formatAccuracyLabel(bestAccuracy)} before continuing.`,
                );
                buildComponents = cloneGeneratedComponents(bestComponents);
                await this.previewBuilder.syncGeneratedComponents(
                  preview.previewDir,
                  buildComponents,
                  previewTokens,
                );
              }

              metrics = bestMetrics;
              currentAccuracy = bestAccuracy;

              if (
                currentAccuracy !== null &&
                currentAccuracy >= targetAccuracyPercent
              ) {
                await this.logToFile(
                  logPath,
                  `[Visual Metrics Loop] Target reached after round ${round}: accuracy=${formatAccuracyLabel(currentAccuracy)} >= ${targetAccuracyPercent}%. Stopping metric repair loop.`,
                );
                break;
              }
            } catch (err: any) {
              if (err instanceof PipelineStepSkipError) {
                throw err;
              }
              this.logger.error(
                `[site-compare] re-run after visual repair failed — ${err?.message ?? err}`,
                err?.response?.data ?? err?.stack,
              );
              await this.logToFile(
                logPath,
                `[Visual Metrics Loop] Round ${round}/${maxMetricRepairRounds} compare failed after repair: ${err?.message ?? err}. Restoring best-known snapshot and stopping metric repair loop.`,
              );
              buildComponents = cloneGeneratedComponents(bestComponents);
              metrics = bestMetrics;
              try {
                await this.previewBuilder.syncGeneratedComponents(
                  preview.previewDir,
                  buildComponents,
                  previewTokens,
                );
              } catch (restoreError: any) {
                await this.logToFile(
                  logPath,
                  `[Visual Metrics Loop] Failed to restore best-known snapshot after compare error: ${restoreError?.message ?? restoreError}`,
                );
              }
              break;
            }
          }

          if (
            currentAccuracy !== null &&
            currentAccuracy < targetAccuracyPercent
          ) {
            await this.logToFile(
              logPath,
              `[Visual Metrics Loop] Finished below target after up to ${maxMetricRepairRounds} round(s). bestAccuracy=${formatAccuracyLabel(currentAccuracy)} target>=${targetAccuracyPercent}%.`,
            );
          } else if (currentAccuracy !== null) {
            await this.logToFile(
              logPath,
              `[Visual Metrics Loop] Finished with target met. bestAccuracy=${formatAccuracyLabel(currentAccuracy)} target>=${targetAccuracyPercent}%.`,
            );
          }
        }

        this.emitStepProgress(
          state,
          '9_visual_compare',
          0.9,
          metrics
            ? 'Final site-compare metrics are attached.'
            : 'Site compare did not return metrics; pipeline will continue.',
          metrics
            ? this.buildPreviewEventData({
                preview,
                previewStage: 'baseline',
                hasEditRequest,
                editApprovalRequired: Boolean(
                  this.controls.get(jobId)?.pendingEditApproval,
                ),
                editApplied: Boolean(this.controls.get(jobId)?.editApplied),
                metrics,
              })
            : undefined,
        );

        this.updateStateResult(state, {
          previewDir: preview.previewDir,
          frontendDir: preview.frontendDir,
          previewUrl: preview.previewUrl,
          apiBaseUrl: preview.apiBaseUrl,
          previewStage: 'baseline',
          hasEditRequest,
          editApprovalRequired: Boolean(
            this.controls.get(jobId)?.pendingEditApproval,
          ),
          editApplied: Boolean(this.controls.get(jobId)?.editApplied),
          uiSourceMapPath: preview.uiSourceMapPath,
          routeEntries: preview.routeEntries,
          baselineMetrics: metrics,
          metrics,
        });
        const compareControl = this.controls.get(jobId);
        if (compareControl) {
          compareControl.buildComponents = buildComponents;
        }

        return { metrics };
      });
      baselineMetrics = metrics;
      await stepDelay();

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
            metrics: metrics ?? undefined,
          }),
          ...(this.buildEditRequestProgressData({
            request: dto.editRequest,
            title: 'Baseline compare is done and edit is waiting for approval',
            summary:
              'The baseline React preview has already been compared against WordPress. The requested edit is stored and will only be applied after the user explicitly approves it from the frontend.',
          }) ?? {}),
        };
        this.rememberStepEventData(jobId, '8b_edit_request', editApprovalData);
        this.progress.get(jobId)?.next({
          step: '8b_edit_request',
          label: this.getStepMeta('8b_edit_request', jobId).label,
          status: 'pending',
          percent: this.calcPercentThrough('8b_edit_request', jobId),
          message:
            'Baseline compare is complete. The requested edit is now pending user approval.',
          data: editApprovalData,
        });

        const decision = await approvalGate.promise;
        if (runtimeControl) {
          runtimeControl.confirmationGate = undefined;
        }
        state.status = 'running';
        let approvedEditApplied = false;

        if (decision.action === 'apply') {
          const editOutcome = await this.runStep(
            state,
            '8b_edit_request',
            logPath,
            async () => {
              this.emitStepProgress(
                state,
                '8b_edit_request',
                0.12,
                'Reviewing the approved edit request against the already-compared React baseline.',
                this.buildEditRequestProgressData({
                  request: dto.editRequest,
                  title: 'Applying the approved user edit request',
                  summary:
                    'The baseline visual compare has finished. The pipeline is now applying the approved user edit request to the React preview.',
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
                  ? (normalizedTheme as { tokens?: ThemeTokens }).tokens
                  : undefined,
              );
              await this.validator.assertPreviewBuild(preview.frontendDir);
              await this.validator.assertPreviewRuntime(
                preview.previewUrl,
                this.buildRuntimeSmokeRoutes(preview.routeEntries),
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
                    metrics: metrics ?? undefined,
                  }),
                  ...(this.buildEditRequestProgressData({
                    request: dto.editRequest,
                    title: 'Approved edits are now visible in preview',
                    summary:
                      'The approved edit request has been applied and synced into the live React preview.',
                  }) ?? {}),
                },
              );
              this.updateStateResult(state, {
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
                baselineMetrics,
                metrics,
              });
              this.rememberStepEventData(jobId, '8b_edit_request', {
                ...this.buildPreviewEventData({
                  preview,
                  previewStage: 'edited',
                  hasEditRequest,
                  editApprovalRequired: false,
                  editApplied: true,
                  metrics: metrics ?? undefined,
                }),
                ...(this.buildEditRequestProgressData({
                  request: dto.editRequest,
                  title: 'Approved edits have been applied',
                  summary:
                    'The approved edit request has been applied and synced into the live React preview.',
                }) ?? {}),
              });
              return { applied: true, taskCount: editPassResult.taskCount };
            },
          );
          approvedEditApplied = Boolean(editOutcome?.applied);
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
              'The user skipped the pending edit request. The pipeline will continue from the already-evaluated baseline preview.',
            data: {
              ...editApprovalData,
              editApprovalRequired: false,
              editApplied: false,
            },
          });
          this.updateStateResult(state, {
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
            baselineMetrics,
            metrics,
          });
        }

        if (approvedEditApplied) {
          await this.runStep(
            state,
            '9b_post_edit_visual_validation',
            logPath,
            async () => {
              const wpBaseUrl =
                content.siteInfo.siteUrl || 'http://localhost:8000/';
              const reactBeUrl = preview.apiBaseUrl.replace(/\/api\/?$/, '');
              const baselineAccuracy =
                this.extractAccuracySummary(metrics).percent;
              let editedMetrics: SiteCompareMetrics | null = null;
              let validation: PostEditVisualValidationResult | null = null;

              this.emitStepProgress(
                state,
                '9b_post_edit_visual_validation',
                0.16,
                'Capturing fresh compare artifacts for the edited preview and validating that the approved user request landed cleanly.',
                {
                  ...this.buildPreviewEventData({
                    preview,
                    previewStage: 'edited',
                    hasEditRequest,
                    editApprovalRequired: false,
                    editApplied: true,
                    metrics: metrics ?? undefined,
                  }),
                  ...(this.buildEditRequestProgressData({
                    request: dto.editRequest,
                    title: 'Validating the edited preview',
                    summary:
                      'The approved edit is now live. This pass checks whether the requested change is visible and whether unrelated regressions were introduced.',
                  }) ?? {}),
                },
              );

              try {
                const compareResult = await this.compareSite({
                  siteId,
                  wpBaseUrl,
                  reactFeUrl: preview.previewUrl,
                  reactBeUrl,
                  jobId,
                  mode: 'edited',
                  routeEntries: preview.routeEntries,
                  preview,
                  plan: reviewResult.plan,
                  content,
                });
                if (compareResult.warnings?.length) {
                  for (const warning of compareResult.warnings) {
                    await this.logToFile(
                      logPath,
                      `[post-edit-compare] ${warning}`,
                    );
                  }
                }
                editedMetrics = compareResult.metrics ?? null;
                if (editedMetrics) {
                  await this.logAutomationCompareMetrics(
                    logPath,
                    'post-edit-validation',
                    editedMetrics,
                  );
                }
              } catch (err: any) {
                this.logger.error(
                  `[post-edit-compare] failed — ${err?.message ?? err}`,
                  err?.response?.data ?? err?.stack,
                );
                await this.logToFile(
                  logPath,
                  `[Post Edit Validation] Compare execution failed: ${err?.message ?? err}`,
                );
              }

              const validationTarget = this.selectPostEditValidationTarget({
                metrics: editedMetrics,
                preview,
                components: buildComponents,
                request: dto.editRequest,
                context: editRequestContext,
              });

              if (validationTarget) {
                const componentPlan = reviewResult.plan.find(
                  (entry) =>
                    entry.componentName === validationTarget.componentName,
                );
                const sourceEvidence = this.buildSourceEvidenceForComparePage(
                  validationTarget.page,
                  content,
                );
                const planEvidence =
                  this.buildPlanEvidenceForComponent(componentPlan);
                const requestContextLines =
                  this.buildPostEditValidationRequestContext({
                    request: dto.editRequest,
                    context: editRequestContext,
                    componentName: validationTarget.componentName,
                    page: validationTarget.page,
                    baselineAccuracy,
                  });
                const visionImageUrls = await this.buildComparePageVisionInputs(
                  validationTarget.page,
                );
                const diagnosisModel =
                  this.configService.get<string>('pipeline.reviewCodeModel') ??
                  resolvedModels.fixAgent;

                await this.logToFile(
                  logPath,
                  [
                    `[Post Edit Validation] component=${validationTarget.componentName} route=${validationTarget.page.route ?? validationTarget.page.visual?.reactPath ?? 'unknown'} model=${diagnosisModel || 'default'} images=${visionImageUrls.length}`,
                    `[Post Edit Validation] edited metrics: ${this.formatAutomationComparePageSummary(
                      validationTarget.page,
                    )}`,
                    this.summarizeLogLines(
                      requestContextLines,
                      8,
                      '[Post Edit Validation] request context',
                    ),
                    this.summarizeLogLines(
                      sourceEvidence,
                      6,
                      '[Post Edit Validation] source evidence',
                    ),
                    this.summarizeLogLines(
                      planEvidence,
                      4,
                      '[Post Edit Validation] plan evidence',
                    ),
                  ].join('\n'),
                );

                validation =
                  await this.siteCompareVisualDiagnosis.validatePostEdit({
                    componentName: validationTarget.componentName,
                    page: validationTarget.page,
                    requestContextLines,
                    sourceEvidence,
                    planEvidence,
                    modelName: diagnosisModel,
                    visionImageUrls,
                    baselineAccuracy,
                  });

                await this.logToFile(
                  logPath,
                  [
                    `[Post Edit Validation] ${validation.componentName} route=${validation.route ?? validationTarget.page.route ?? 'unknown'} mode=${validation.analysisMode ?? 'unknown'} passed=${validation.passed} shouldRepair=${validation.shouldRepair} editIntentSatisfied=${validation.editIntentSatisfied} outOfScopeRegression=${validation.outOfScopeRegression} confidence=${validation.confidence.toFixed(2)} score=${validation.score}`,
                    `[Post Edit Validation] summary=${validation.summary}`,
                    this.summarizeLogLines(
                      validation.issues.map(
                        (issue) =>
                          `${issue.type}|${issue.severity}|${issue.target ?? 'general'}|${issue.suggestedAction}`,
                      ),
                      6,
                      '[Post Edit Validation] issues',
                    ),
                    this.summarizeLogLines(
                      validation.repairPlan.instructions,
                      6,
                      '[Post Edit Validation] instructions',
                    ),
                  ].join('\n'),
                );

                let activeTarget = validationTarget;
                let activeSourceEvidence = sourceEvidence;
                let activePlanEvidence = planEvidence;
                let activeRequestContextLines = requestContextLines;
                const postEditTokens =
                  'tokens' in normalizedTheme
                    ? ((normalizedTheme as { tokens?: ThemeTokens }).tokens ??
                      undefined)
                    : undefined;
                const maxPostEditRepairRounds = 2;

                for (
                  let round = 1;
                  round <= maxPostEditRepairRounds &&
                  validation.shouldRepair &&
                  validation.confidence >= 0.55;
                  round++
                ) {
                  this.emitStepProgress(
                    state,
                    '9b_post_edit_visual_validation',
                    Math.min(0.44 + round * 0.18, 0.82),
                    `Post-edit repair round ${round}/${maxPostEditRepairRounds}: fixing "${activeTarget.componentName}" after validation reported remaining issues.`,
                  );
                  await this.logToFile(
                    logPath,
                    `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} starting for component="${activeTarget.componentName}" route="${activeTarget.page.route ?? activeTarget.page.visual?.reactPath ?? 'unknown'}" score=${validation.score} confidence=${validation.confidence.toFixed(2)}.`,
                  );

                  const repairResult =
                    await this.applyPostEditValidationRepairPass({
                      preview,
                      components: buildComponents,
                      plan: reviewResult.plan,
                      target: activeTarget,
                      validation,
                      request: dto.editRequest,
                      requestContextLines: activeRequestContextLines,
                      sourceEvidence: activeSourceEvidence,
                      planEvidence: activePlanEvidence,
                      fixAgentModel: resolvedModels.fixAgent,
                      tokens: postEditTokens,
                      logPath,
                    });
                  buildComponents = repairResult.components;

                  if (!repairResult.applied) {
                    await this.logToFile(
                      logPath,
                      `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} produced no accepted repair. Stopping post-edit repair loop.`,
                    );
                    break;
                  }

                  try {
                    const roundCompareResult = await this.compareSite({
                      siteId,
                      wpBaseUrl,
                      reactFeUrl: preview.previewUrl,
                      reactBeUrl,
                      jobId,
                      mode: 'edited',
                      routeEntries: preview.routeEntries,
                      preview,
                      plan: reviewResult.plan,
                      content,
                    });
                    if (roundCompareResult.warnings?.length) {
                      for (const warning of roundCompareResult.warnings) {
                        await this.logToFile(
                          logPath,
                          `[post-edit-compare] ${warning}`,
                        );
                      }
                    }
                    editedMetrics = roundCompareResult.metrics ?? editedMetrics;
                    if (editedMetrics) {
                      await this.logAutomationCompareMetrics(
                        logPath,
                        `post-edit-validation-round-${round}`,
                        editedMetrics,
                      );
                      metrics = editedMetrics;
                    }

                    const nextTarget = this.selectPostEditValidationTarget({
                      metrics: editedMetrics,
                      preview,
                      components: buildComponents,
                      request: dto.editRequest,
                      context: editRequestContext,
                    });
                    if (!nextTarget) {
                      await this.logToFile(
                        logPath,
                        `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} could not resolve a compare target after repair. Stopping post-edit repair loop.`,
                      );
                      break;
                    }

                    activeTarget = nextTarget;
                    const nextComponentPlan = reviewResult.plan.find(
                      (entry) =>
                        entry.componentName === activeTarget.componentName,
                    );
                    activeSourceEvidence =
                      this.buildSourceEvidenceForComparePage(
                        activeTarget.page,
                        content,
                      );
                    activePlanEvidence =
                      this.buildPlanEvidenceForComponent(nextComponentPlan);
                    activeRequestContextLines =
                      this.buildPostEditValidationRequestContext({
                        request: dto.editRequest,
                        context: editRequestContext,
                        componentName: activeTarget.componentName,
                        page: activeTarget.page,
                        baselineAccuracy,
                      });
                    const nextVisionImageUrls =
                      await this.buildComparePageVisionInputs(
                        activeTarget.page,
                      );

                    validation =
                      await this.siteCompareVisualDiagnosis.validatePostEdit({
                        componentName: activeTarget.componentName,
                        page: activeTarget.page,
                        requestContextLines: activeRequestContextLines,
                        sourceEvidence: activeSourceEvidence,
                        planEvidence: activePlanEvidence,
                        modelName: diagnosisModel,
                        visionImageUrls: nextVisionImageUrls,
                        baselineAccuracy,
                      });
                    await this.logToFile(
                      logPath,
                      [
                        `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} re-validation component=${validation.componentName} route=${validation.route ?? activeTarget.page.route ?? 'unknown'} passed=${validation.passed} shouldRepair=${validation.shouldRepair} editIntentSatisfied=${validation.editIntentSatisfied} outOfScopeRegression=${validation.outOfScopeRegression} confidence=${validation.confidence.toFixed(2)} score=${validation.score}`,
                        `[Post Edit Repair] summary=${validation.summary}`,
                        this.summarizeLogLines(
                          validation.issues.map(
                            (issue) =>
                              `${issue.type}|${issue.severity}|${issue.target ?? 'general'}|${issue.suggestedAction}`,
                          ),
                          6,
                          '[Post Edit Repair] issues',
                        ),
                      ].join('\n'),
                    );

                    if (!validation.shouldRepair || validation.passed) {
                      await this.logToFile(
                        logPath,
                        `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} resolved the remaining post-edit validation issues.`,
                      );
                      break;
                    }
                    if (validation.confidence < 0.55) {
                      await this.logToFile(
                        logPath,
                        `[Post Edit Repair] Round ${round}/${maxPostEditRepairRounds} produced low-confidence follow-up diagnosis (${validation.confidence.toFixed(2)}). Stopping post-edit repair loop.`,
                      );
                      break;
                    }
                  } catch (err: any) {
                    this.logger.error(
                      `[Post Edit Repair] re-compare/re-validate failed — ${err?.message ?? err}`,
                      err?.response?.data ?? err?.stack,
                    );
                    await this.logToFile(
                      logPath,
                      `[Post Edit Repair] Re-compare/re-validate failed after round ${round}/${maxPostEditRepairRounds}: ${err?.message ?? err}`,
                    );
                    break;
                  }
                }

                if (!validation.passed) {
                  this.logger.warn(
                    `[Post Edit Validation] "${validation.componentName}" still needs review after the approved edit. score=${validation.score} confidence=${validation.confidence.toFixed(2)} shouldRepair=${validation.shouldRepair}`,
                  );
                }
              } else {
                await this.logToFile(
                  logPath,
                  '[Post Edit Validation] No matching route/component could be selected from compare metrics for the approved edit request. Skipping AI validation.',
                );
              }

              if (editedMetrics) {
                metrics = editedMetrics;
              }

              this.emitStepProgress(
                state,
                '9b_post_edit_visual_validation',
                0.92,
                validation
                  ? validation.passed
                    ? 'Edited preview validation passed. Updated compare artifacts are attached.'
                    : 'Edited preview validation found remaining issues. Updated compare artifacts are attached for review.'
                  : editedMetrics
                    ? 'Edited preview compare artifacts are attached, but no targeted post-edit diagnosis was produced.'
                    : 'Edited preview validation could not collect compare metrics; the pipeline will continue with the current preview.',
                {
                  ...this.buildPreviewEventData({
                    preview,
                    previewStage: 'edited',
                    hasEditRequest,
                    editApprovalRequired: false,
                    editApplied: true,
                    metrics: editedMetrics ?? metrics ?? undefined,
                  }),
                  ...(this.buildEditRequestProgressData({
                    request: dto.editRequest,
                    title: 'Post-edit visual validation finished',
                    summary: validation?.summary,
                  }) ?? {}),
                },
              );

              this.updateStateResult(state, {
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
                baselineMetrics,
                editedMetrics: editedMetrics ?? metrics,
                postEditVisualValidation: validation,
                metrics,
              });

              return {
                metrics: editedMetrics,
                validation,
              };
            },
          );
        } else {
          const postEditValidationStep = state.steps.find(
            (step) => step.name === '9b_post_edit_visual_validation',
          );
          if (postEditValidationStep) {
            postEditValidationStep.status = 'skipped';
          }
          this.progress.get(jobId)?.next({
            step: '9b_post_edit_visual_validation',
            label: this.getStepMeta('9b_post_edit_visual_validation', jobId)
              .label,
            status: 'skipped',
            percent: this.calcPercentThrough(
              '9b_post_edit_visual_validation',
              jobId,
            ),
            message:
              decision.action === 'skip'
                ? 'Post-edit visual validation was skipped because the user chose not to apply the pending edit request.'
                : 'Post-edit visual validation was skipped because the approved request did not require any preview mutations.',
            data: {
              ...this.buildPreviewEventData({
                preview,
                previewStage:
                  decision.action === 'skip' ? 'baseline' : 'edited',
                hasEditRequest,
                editApprovalRequired: false,
                editApplied: false,
                metrics: metrics ?? undefined,
              }),
              ...(this.buildEditRequestProgressData({
                request: dto.editRequest,
                title: 'Post-edit validation skipped',
                summary:
                  decision.action === 'skip'
                    ? 'The user skipped the pending edit request, so there is no edited preview to validate.'
                    : 'The approved edit request did not produce any targeted mutations, so there was no edited preview delta to validate.',
              }) ?? {}),
            },
          });
        }
        await stepDelay();
      }

      // Bước 8: Xoá temp/repos và temp/uploads của job này
      await this.runStep(state, '10_cleanup', logPath, () =>
        this.cleanup.cleanup(jobId),
      );
      await stepDelay();

      const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);

      // Step 9: Migration completion
      await this.runStep(state, '11_done', logPath, async () => {
        const finalMutationCandidates =
          await buildUiMutationCandidatesForGeneratedComponents({
            components: buildComponents,
          });
        const finalPostEditTasks =
          this.editRequestPhase.buildPostMigrationEditTasks({
            request: dto.editRequest,
            context: editRequestContext,
            plan: reviewResult.plan,
            components: buildComponents,
            mutationCandidates: finalMutationCandidates,
          });
        const exactCaptureTargets = dedupeCaptureTargets(
          finalPostEditTasks.flatMap((task) => task.exactTargets),
        );
        await this.logExactCaptureResolution({
          jobId,
          logPath,
          attachments: dto.editRequest?.attachments,
          resolutionSource: 'final:component-mutation-targets',
          candidateCount: finalMutationCandidates.length,
          exactCaptureTargets,
        });

        state.status = 'done';
        const completedControl = this.controls.get(jobId);
        if (completedControl) {
          completedControl.buildComponents = buildComponents;
          completedControl.approvedPlan = reviewResult.plan;
        }
        this.updateStateResult(state, {
          runSummaryPath: logPath,
          runLogPath,
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
          routeEntries: preview.routeEntries,
          exactCaptureTargets,
          dbCreds,
          baselineMetrics,
          metrics,
          plan: reviewResult.plan,
        });
        const migrationNotification =
          await this.notifyAutomationMigrationCompleted({
            siteId,
            jobId,
            logPath,
            previewUrl: preview.previewUrl,
            userId,
          });
        if (migrationNotification) {
          this.updateStateResult(state, {
            migrationNotification,
          });
        }
        this.rememberStepEventData(
          jobId,
          '11_done',
          this.buildPreviewEventData({
            preview,
            previewStage: 'final',
            hasEditRequest,
            editApprovalRequired: Boolean(
              this.controls.get(jobId)?.pendingEditApproval,
            ),
            editApplied: Boolean(this.controls.get(jobId)?.editApplied),
            metrics: metrics ?? undefined,
          }),
        );
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
      await this.tokenTracker.writeSummary(logPath);
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
      if (err instanceof PipelineStepSkipError) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        this.recordStepDuration(state.jobId, name, Date.now() - t0);
        step.status = 'skipped';
        step.error = undefined;
        if (err.data !== undefined) {
          this.rememberStepEventData(
            state.jobId,
            name,
            err.data as ProgressEventData,
          );
        }
        subject?.next({
          step: name,
          label: meta.label,
          status: 'skipped',
          percent: this.calcPercentThrough(name, state.jobId),
          message: err.message,
          data: this.getStepEventData(state.jobId, name),
        });
        await this.logToFile(
          logPath,
          `Step ${name} SKIPPED (${elapsed}s): ${err.message}`,
        );
        if (name === '9_visual_compare') {
          await this.logVisualCompareControlTrace(logPath, {
            event: 'skip_visual_compare_step_finalized',
            jobId: state.jobId,
            step: name,
            elapsedSeconds: Number(elapsed),
            message: err.message,
          });
        }
        return undefined as T;
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
      ...(manifest.themeDeepAnalysis
        ? [
            `theme-profile: ${manifest.themeDeepAnalysis.themeSlug}, routeChains=${manifest.themeDeepAnalysis.routeSources.length}, behaviors=${manifest.themeDeepAnalysis.behaviorSignals.map((signal) => signal.key).join(', ') || 'none'}`,
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
      degradedComponents: Array.isArray(state.result?.degradedComponents)
        ? state.result.degradedComponents
        : undefined,
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

  private async compareSite(input: {
    siteId?: string;
    wpBaseUrl: string;
    reactFeUrl: string;
    reactBeUrl: string;
    jobId?: string;
    mode?: 'baseline' | 'edited';
    routeEntries?: PreviewBuilderResult['routeEntries'];
    preview?: PreviewBuilderResult;
    plan?: PlanResult;
    content?: DbContentResult;
  }): Promise<{
    metrics?: SiteCompareMetrics;
    warnings?: string[];
    provider: 'automation';
  }> {
    return this.siteCompareService.compare({
      wpBaseUrl: input.wpBaseUrl,
      reactFeUrl: input.reactFeUrl,
      reactBeUrl: input.reactBeUrl,
    });
  }

  private buildSiteCompareTargets(input: {
    wpBaseUrl: string;
    reactFeUrl: string;
    preview: PreviewBuilderResult;
    plan: PlanResult;
    content: DbContentResult;
  }): SiteCompareTarget[] {
    const componentPlans = new Map(
      input.plan.map((component) => [component.componentName, component]),
    );
    const exactRouteTypes = new Set<string>();
    for (const entry of input.preview.routeEntries) {
      if (this.isCatchAllPreviewRoute(entry)) continue;
      const route = this.normalizeComparableRoute(entry.route);
      if (!route || route.includes(':')) continue;
      exactRouteTypes.add(
        this.inferCompareTargetType({
          route,
          componentPlan: componentPlans.get(entry.componentName),
        }),
      );
    }
    const targets: SiteCompareTarget[] = [];
    const seen = new Set<string>();

    for (const entry of input.preview.routeEntries) {
      if (this.isCatchAllPreviewRoute(entry)) continue;
      const route = this.normalizeComparableRoute(entry.route);
      if (!route) continue;
      const componentPlan = componentPlans.get(entry.componentName);
      if (
        this.shouldSkipSiteCompareRouteEntry({
          entry,
          route,
          componentPlan,
          exactRouteTypes,
        })
      ) {
        continue;
      }

      const expanded = this.expandSiteCompareTargetsForRouteEntry({
        entry,
        route,
        componentPlan,
        wpBaseUrl: input.wpBaseUrl,
        reactFeUrl: input.reactFeUrl,
        content: input.content,
      });

      for (const target of expanded) {
        const dedupeKey = `${target.wpUrl}::${target.reactUrl}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        targets.push(target);
      }
    }

    return targets;
  }

  private shouldSkipSiteCompareRouteEntry(input: {
    entry: PreviewBuilderResult['routeEntries'][number];
    route: string;
    componentPlan?: PlanResult[number];
    exactRouteTypes: Set<string>;
  }): boolean {
    const { entry, route, componentPlan, exactRouteTypes } = input;
    if (this.isSyntheticCompareAliasRoute(entry, componentPlan)) {
      return true;
    }

    if (!route.includes(':') || componentPlan?.fixedSlug) {
      return false;
    }

    const type = this.inferCompareTargetType({ route, componentPlan });
    return exactRouteTypes.has(type);
  }

  private isSyntheticCompareAliasRoute(
    entry: PreviewBuilderResult['routeEntries'][number],
    componentPlan?: PlanResult[number],
  ): boolean {
    const normalizedEntryRoute = this.normalizeComparableRoute(entry.route);
    const normalizedPlanRoute = this.normalizeComparableRoute(
      componentPlan?.route,
    );
    if (!normalizedEntryRoute || !normalizedPlanRoute) return false;
    if (normalizedEntryRoute === normalizedPlanRoute) return false;
    if (!normalizedEntryRoute.includes(':')) return false;
    if (componentPlan?.fixedSlug) return false;
    return true;
  }

  private expandSiteCompareTargetsForRouteEntry(input: {
    entry: PreviewBuilderResult['routeEntries'][number];
    route: string;
    componentPlan?: PlanResult[number];
    wpBaseUrl: string;
    reactFeUrl: string;
    content: DbContentResult;
  }): SiteCompareTarget[] {
    const { entry, route, componentPlan, wpBaseUrl, reactFeUrl, content } =
      input;
    const targets: SiteCompareTarget[] = [];
    const type = this.inferCompareTargetType({ route, componentPlan });
    const componentHint = componentPlan?.componentName ?? entry.componentName;
    const repairPriority =
      route === '/' || type === 'post' || type === 'page' ? 'high' : 'medium';

    const pushTarget = (
      concreteRoute: string,
      wpPath: string,
      slug?: string,
    ) => {
      const reactUrl = this.buildAbsoluteCompareUrl(reactFeUrl, concreteRoute);
      const wpUrl = this.buildAbsoluteCompareUrl(wpBaseUrl, wpPath);
      if (!reactUrl || !wpUrl) return;

      targets.push({
        wpUrl,
        reactUrl,
        route: concreteRoute,
        routeKey: this.buildCompareRouteKey({
          route: concreteRoute,
          slug,
          type,
          componentName: entry.componentName,
        }),
        slug,
        type,
        componentName: entry.componentName,
        componentHint,
        repairPriority,
      });
    };

    if (!route.includes(':')) {
      const wpPath = this.resolveWordPressComparePath({
        route,
        componentPlan,
        content,
        slug:
          componentPlan?.fixedSlug ??
          this.extractSlugFromComparableRoute(route),
      });
      if (wpPath) {
        pushTarget(
          route,
          wpPath,
          this.extractSlugFromComparableRoute(route) ?? undefined,
        );
      }
      return targets;
    }

    const expandFromSlugs = (slugs: string[]) => {
      for (const slug of slugs.slice(0, 1)) {
        const concreteRoute = route.replace(/:[^/]+/g, slug);
        const wpPath = this.resolveWordPressComparePath({
          route,
          componentPlan,
          content,
          slug,
        });
        if (wpPath) pushTarget(concreteRoute, wpPath, slug);
      }
    };

    if (componentPlan?.fixedSlug) {
      expandFromSlugs([componentPlan.fixedSlug]);
      return targets;
    }

    if (/^\/post\/:[^/]+$/i.test(route)) {
      expandFromSlugs(content.posts.map((post) => post.slug).filter(Boolean));
      return targets;
    }

    if (/^\/page\/:[^/]+$/i.test(route)) {
      expandFromSlugs(content.pages.map((page) => page.slug).filter(Boolean));
      return targets;
    }

    if (/^\/category\/:[^/]+$/i.test(route)) {
      expandFromSlugs(
        (
          content.taxonomies.find(
            (taxonomy) => taxonomy.taxonomy === 'category',
          )?.terms ?? []
        )
          .map((term) => term.slug)
          .filter(Boolean),
      );
      return targets;
    }

    if (/^\/tag\/:[^/]+$/i.test(route)) {
      expandFromSlugs(
        (
          content.taxonomies.find(
            (taxonomy) => taxonomy.taxonomy === 'post_tag',
          )?.terms ?? []
        )
          .map((term) => term.slug)
          .filter(Boolean),
      );
      return targets;
    }

    if (/^\/author\/:[^/]+$/i.test(route)) {
      expandFromSlugs([
        ...new Set(
          content.posts.map((post) => post.authorSlug).filter(Boolean),
        ),
      ]);
      return targets;
    }

    const fallbackSource = this.hasCompareDataNeed(componentPlan, 'postdetail')
      ? content.posts.map((post) => post.slug)
      : this.hasCompareDataNeed(componentPlan, 'pagedetail')
        ? content.pages.map((page) => page.slug)
        : [];
    expandFromSlugs(fallbackSource.filter(Boolean));

    return targets;
  }

  private resolveWordPressComparePath(input: {
    route: string;
    componentPlan?: PlanResult[number];
    content: DbContentResult;
    slug?: string | null;
  }): string | null {
    const route = this.normalizeComparableRoute(input.route);
    if (!route) return null;
    const slug = input.slug?.trim() || null;

    if (route === '/') return '/';

    if (route === '/blog') {
      const postsPageSlug =
        input.content.readingSettings.pageForPosts?.slug?.trim();
      return postsPageSlug ? `/${postsPageSlug}` : route;
    }

    if (
      /^\/(category|tag|author)\/:[^/]+$/i.test(route) ||
      /^\/(category|tag|author)\/[^/]+$/i.test(route)
    ) {
      const prefix = route.split('/').filter(Boolean)[0];
      const resolvedSlug = slug ?? this.extractSlugFromComparableRoute(route);
      return resolvedSlug ? `/${prefix}/${resolvedSlug}` : null;
    }

    if (/^\/page\/:[^/]+$/i.test(route) || /^\/page\/[^/]+$/i.test(route)) {
      const resolvedSlug = slug ?? this.extractSlugFromComparableRoute(route);
      return resolvedSlug ? `/${resolvedSlug}` : null;
    }

    if (/^\/post\/:[^/]+$/i.test(route) || /^\/post\/[^/]+$/i.test(route)) {
      const resolvedSlug = slug ?? this.extractSlugFromComparableRoute(route);
      return resolvedSlug ? `/${resolvedSlug}` : null;
    }

    if (slug && this.hasCompareDataNeed(input.componentPlan, 'postdetail')) {
      return `/${slug}`;
    }

    if (slug && this.hasCompareDataNeed(input.componentPlan, 'pagedetail')) {
      return `/${slug}`;
    }

    if (
      slug &&
      this.hasCompareDataNeed(input.componentPlan, 'categorydetail')
    ) {
      return `/category/${slug}`;
    }

    if (route.includes(':') && slug) {
      return route.replace(/:[^/]+/g, slug);
    }

    if (input.componentPlan?.fixedSlug && route !== '/') {
      return `/${input.componentPlan.fixedSlug}`;
    }

    return route;
  }

  private buildAbsoluteCompareUrl(
    baseUrl: string,
    route: string,
  ): string | null {
    const normalizedRoute = this.normalizeComparableRoute(route);
    if (!normalizedRoute) return null;
    const normalizedBase = baseUrl.trim();
    if (!normalizedBase) return null;
    try {
      const base = new URL(
        normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`,
      );
      const routeUrl = new URL(normalizedRoute, 'http://compare.local');
      const basePath = base.pathname.endsWith('/')
        ? base.pathname
        : `${base.pathname}/`;
      const routePath = routeUrl.pathname.replace(/^\/+/, '');
      base.pathname = routePath
        ? `${basePath.replace(/\/+$/, '')}/${routePath}`
        : basePath;
      base.search = routeUrl.search;
      base.hash = routeUrl.hash;
      return base.toString();
    } catch {
      return null;
    }
  }

  private extractSlugFromComparableRoute(route?: string | null): string | null {
    const normalizedRoute = this.normalizeComparableRoute(route);
    if (
      !normalizedRoute ||
      normalizedRoute === '/' ||
      normalizedRoute.includes(':')
    ) {
      return null;
    }
    const segments = normalizedRoute.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    if (
      ['page', 'post', 'category', 'tag', 'author'].includes(
        segments[0] ?? '',
      ) &&
      segments.length >= 2
    ) {
      return segments[1] ?? null;
    }
    return segments[segments.length - 1] ?? null;
  }

  private buildCompareRouteKey(input: {
    route: string;
    slug?: string;
    type?: string;
    componentName?: string;
  }): string {
    return [
      input.componentName?.trim() || 'UnknownComponent',
      input.type?.trim() || 'page',
      this.normalizeComparableRoute(input.route) || '/',
      input.slug?.trim() || '',
    ]
      .filter(Boolean)
      .join('::');
  }

  private inferCompareTargetType(input: {
    route: string;
    componentPlan?: PlanResult[number];
  }): string {
    const route = this.normalizeComparableRoute(input.route) ?? '/';

    if (route === '/') return 'home';
    if (route === '/search') return 'search';
    if (route === '/blog') return 'posts-index';
    if (route === '/archive') return 'archive';
    if (
      /^\/category\//i.test(route) ||
      this.hasCompareDataNeed(input.componentPlan, 'categorydetail')
    ) {
      return 'category';
    }
    if (/^\/tag\//i.test(route)) return 'tag';
    if (/^\/author\//i.test(route)) return 'author';
    if (
      /^\/post\//i.test(route) ||
      this.hasCompareDataNeed(input.componentPlan, 'postdetail')
    ) {
      return 'post';
    }
    if (
      /^\/page\//i.test(route) ||
      this.hasCompareDataNeed(input.componentPlan, 'pagedetail')
    ) {
      return 'page';
    }
    return 'page';
  }

  private hasCompareDataNeed(
    componentPlan: PlanResult[number] | undefined,
    target: 'postdetail' | 'pagedetail' | 'categorydetail',
  ): boolean {
    return (componentPlan?.dataNeeds ?? []).some(
      (need) =>
        need
          .trim()
          .toLowerCase()
          .replace(/[^a-z]/g, '') === target,
    );
  }

  private async notifyAutomationMigrationCompleted(input: {
    siteId: string;
    jobId: string;
    logPath?: string;
    previewUrl?: string;
    userId?: string;
  }): Promise<{
    requested: boolean;
    endpoint: string;
    payload: {
      site_id: string;
      job_id: string;
      preview_url?: string;
      user_id?: string;
    };
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

    const endpoint = `${automationUrl}/migrations`;
    const payload = {
      site_id: input.siteId,
      job_id: input.jobId,
      ...(input.previewUrl ? { preview_url: input.previewUrl } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
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
    let forcedHomeTarget: {
      componentName: string;
      page: AutomationComparePageResult;
      score: number;
    } | null = null;

    for (const page of pages) {
      const visualStatus = page.visual?.status;
      const contentStatus = page.content?.status;
      const diffPct = this.coerceFiniteNumber(page.visual?.diffPct) ?? 0;
      const componentName = this.resolveVisualRepairComponentName({
        page,
        preview,
        componentNames,
      });
      if (!componentName) continue;

      const accuracy = this.coerceFiniteNumber(page.visual?.accuracy);
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
      const isActionable =
        visualStatus === '⚠️  FAIL' ||
        contentStatus === 'FAIL' ||
        contentStatus === 'MISSING' ||
        diffPct >= 8;

      if (
        componentName === 'Home' &&
        (!forcedHomeTarget || score > forcedHomeTarget.score)
      ) {
        forcedHomeTarget = { componentName, page, score };
      }
      if (!isActionable) continue;

      const existing = bestByComponent.get(componentName);
      if (!existing || score > existing.score) {
        bestByComponent.set(componentName, { componentName, page, score });
      }
    }

    const rankedTargets = [...bestByComponent.values()].sort(
      (a, b) => b.score - a.score,
    );
    if (
      forcedHomeTarget &&
      !rankedTargets.some((target) => target.componentName === 'Home')
    ) {
      const pinnedTargets = [
        forcedHomeTarget,
        ...rankedTargets
          .filter((target) => target.componentName !== 'Home')
          .slice(0, 2),
      ];
      return pinnedTargets.sort((a, b) => b.score - a.score);
    }
    return rankedTargets.slice(0, 3);
  }

  private selectPostEditValidationTarget(input: {
    metrics: unknown;
    preview: PreviewBuilderResult;
    components: ReactGenerateResult['components'];
    request?: RunPipelineDto['editRequest'];
    context?: ResolvedEditRequestContext;
  }): {
    componentName: string;
    page: AutomationComparePageResult;
  } | null {
    const { metrics, preview, components, request, context } = input;
    const pages = this.collectAutomationComparePages(metrics);
    if (pages.length === 0) return null;

    const componentNames = new Set(
      components.map((component) => component.name),
    );
    const desiredRoutes = new Set<string>();
    const desiredComponents = new Set<string>();

    const addRoute = (value?: string | null) => {
      const normalized = this.normalizeComparableRoute(value);
      if (normalized) desiredRoutes.add(normalized);
    };
    const addComponent = (value?: string | null) => {
      const normalized = String(value ?? '').trim();
      if (normalized) desiredComponents.add(normalized);
    };

    addRoute(request?.pageContext?.reactRoute);
    addRoute(request?.pageContext?.wordpressRoute);
    addRoute(request?.targetHint?.route);
    addComponent(request?.targetHint?.componentName);
    for (const attachment of request?.attachments ?? []) {
      addRoute(attachment.captureContext?.page?.route);
    }
    for (const candidate of context?.targetCandidates ?? []) {
      addRoute(candidate.route);
      addComponent(candidate.componentName);
    }
    const hasExplicitHints =
      desiredRoutes.size > 0 || desiredComponents.size > 0;

    const scored = pages
      .map((page) => {
        const route =
          this.normalizeComparableRoute(page.route) ??
          this.normalizeComparableRoute(page.visual?.reactPath) ??
          null;
        const resolvedComponentName = this.resolveVisualRepairComponentName({
          page,
          preview,
          componentNames,
        });

        let score = 0;
        const routeMatched = Boolean(route && desiredRoutes.has(route));
        const routePatternMatched = Boolean(
          route &&
          [...desiredRoutes].some((desiredRoute) =>
            this.previewRouteMatches(desiredRoute, route),
          ),
        );
        const componentMatched = Boolean(
          resolvedComponentName && desiredComponents.has(resolvedComponentName),
        );
        const componentHintMatched = Boolean(
          page.componentHint && desiredComponents.has(page.componentHint),
        );

        if (routeMatched) score += 100;
        if (routePatternMatched) {
          score += 60;
        }
        if (componentMatched) {
          score += 100;
        }
        if (componentHintMatched) {
          score += 70;
        }
        if (
          hasExplicitHints &&
          !routeMatched &&
          !routePatternMatched &&
          !componentMatched &&
          !componentHintMatched
        ) {
          return {
            page,
            componentName: resolvedComponentName,
            score: -1,
          };
        }
        if (request?.targetHint?.sectionType) score += 5;
        score +=
          this.coerceFiniteNumber(page.visual?.diffPct) ??
          Math.max(
            0,
            100 - (this.coerceFiniteNumber(page.visual?.accuracy) ?? 100),
          );

        return {
          page,
          componentName: resolvedComponentName,
          score,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          page: AutomationComparePageResult;
          componentName: string;
          score: number;
        } => Boolean(entry.componentName) && entry.score >= 0,
      )
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return {
        componentName: scored[0].componentName,
        page: scored[0].page,
      };
    }

    if (hasExplicitHints) {
      return null;
    }

    const fallbackPage = pages[0];
    const fallbackComponent = this.resolveVisualRepairComponentName({
      page: fallbackPage,
      preview,
      componentNames,
    });
    if (!fallbackComponent) return null;
    return {
      componentName: fallbackComponent,
      page: fallbackPage,
    };
  }

  private buildPostEditValidationRequestContext(input: {
    request?: RunPipelineDto['editRequest'];
    context?: ResolvedEditRequestContext;
    componentName: string;
    page: AutomationComparePageResult;
    baselineAccuracy?: number | null;
  }): string[] {
    const { request, context, componentName, page, baselineAccuracy } = input;
    const lines: string[] = [
      `Target component: ${componentName}`,
      `Target route: ${page.route ?? page.visual?.reactPath ?? request?.targetHint?.route ?? 'unknown'}`,
    ];

    if (typeof baselineAccuracy === 'number') {
      lines.push(`Baseline accuracy before edit: ${baselineAccuracy}%`);
    }
    if (request?.prompt?.trim()) {
      lines.push(`Primary request: ${request.prompt.trim()}`);
    }
    if (request?.language?.trim()) {
      lines.push(`Preferred language: ${request.language.trim()}`);
    }
    if (request?.pageContext?.pageTitle?.trim()) {
      lines.push(`Target page title: ${request.pageContext.pageTitle.trim()}`);
    }
    if (request?.targetHint?.componentName?.trim()) {
      lines.push(
        `Requested component hint: ${request.targetHint.componentName.trim()}`,
      );
    }
    if (request?.targetHint?.sectionType?.trim()) {
      lines.push(
        `Requested section type hint: ${request.targetHint.sectionType.trim()}`,
      );
    }
    if (typeof request?.targetHint?.sectionIndex === 'number') {
      lines.push(
        `Requested section index hint: ${request.targetHint.sectionIndex}`,
      );
    }
    if (request?.constraints?.preserveOutsideSelection === true) {
      lines.push(
        'Constraint: preserve content and layout outside the selected edit scope.',
      );
    }
    if (request?.constraints?.preserveDataContract === true) {
      lines.push('Constraint: preserve existing data contracts and bindings.');
    }
    if (context?.recommendedStrategy) {
      lines.push(`Resolved edit strategy: ${context.recommendedStrategy}`);
    }
    if (context?.editOperation) {
      lines.push(`Resolved edit operation: ${context.editOperation}`);
    }
    if (context?.targetScope) {
      lines.push(`Resolved target scope: ${context.targetScope}`);
    }
    if (context?.targetCandidates?.length) {
      lines.push(
        `Resolved candidates: ${context.targetCandidates
          .slice(0, 3)
          .map(
            (candidate) =>
              `${candidate.componentName ?? 'unknown'}@${candidate.route ?? 'unknown'} (${candidate.confidence.toFixed(2)})`,
          )
          .join(' | ')}`,
      );
    }
    if ((request?.attachments?.length ?? 0) > 0) {
      lines.push(
        `Attached captures: ${(request?.attachments ?? [])
          .slice(0, 4)
          .map((attachment) =>
            [
              attachment.id,
              attachment.note?.trim(),
              attachment.captureContext?.page?.route,
            ]
              .filter(Boolean)
              .join(' / '),
          )
          .join(' || ')}`,
      );
    }

    return lines;
  }

  private async applyPostEditValidationRepairPass(input: {
    preview: PreviewBuilderResult;
    components: ReactGenerateResult['components'];
    plan: PlanResult;
    target: {
      componentName: string;
      page: AutomationComparePageResult;
    };
    validation: PostEditVisualValidationResult;
    request?: RunPipelineDto['editRequest'];
    requestContextLines: string[];
    sourceEvidence: string[];
    planEvidence: string[];
    fixAgentModel?: string;
    tokens?: ThemeTokens;
    logPath: string;
  }): Promise<{
    components: ReactGenerateResult['components'];
    applied: boolean;
  }> {
    const {
      preview,
      components,
      plan,
      target,
      validation,
      request,
      requestContextLines,
      sourceEvidence,
      planEvidence,
      fixAgentModel,
      tokens,
      logPath,
    } = input;

    const componentIndex = components.findIndex(
      (component) => component.name === target.componentName,
    );
    if (componentIndex === -1) {
      await this.logToFile(
        logPath,
        `[Post Edit Repair] Could not find component "${target.componentName}" in the current preview snapshot.`,
      );
      return { components, applied: false };
    }

    const snapshot = components.map((component) => ({ ...component }));
    const originalComponent = components[componentIndex];
    const visionImageUrls = await this.buildComparePageVisionInputs(
      target.page,
    );
    const visionContextNote = this.buildComparePageVisionContext(target.page);
    const baseFeedback = this.buildPostEditValidationRepairFeedback({
      componentName: target.componentName,
      page: target.page,
      validation,
      request,
      requestContextLines,
      sourceEvidence,
      planEvidence,
    });
    let candidateComponent = originalComponent;
    let retryFeedback = baseFeedback;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        await this.logToFile(
          logPath,
          `[Post Edit Repair] Retrying "${target.componentName}" attempt ${attempt}/2 with accumulated code/runtime feedback.`,
        );
      }

      const fixed = await this.reactGenerator.fixComponent({
        component: candidateComponent,
        plan,
        feedback: retryFeedback,
        modelConfig: { fixAgent: fixAgentModel },
        logPath,
        fixMode: 'edit-request-safe',
        visionImageUrls,
        visionContextNote,
        tokenScope: 'edit-request',
      });
      const repairedCandidate = {
        ...fixed,
        visualPlan: undefined,
      };
      const revalidated = this.validator.collectValidationIssues([
        repairedCandidate,
      ]);
      if (revalidated.failures.length > 0) {
        const error =
          revalidated.failures[0]?.error ?? 'Unknown validation error';
        await this.logToFile(
          logPath,
          `[Post Edit Repair] Re-validation failed for "${target.componentName}" attempt ${attempt}/2: ${error}`,
        );
        candidateComponent = repairedCandidate;
        retryFeedback = this.buildPostEditValidationRetryFeedback({
          baseFeedback,
          attempt,
          phase: 'code/runtime validation',
          error,
        });
        continue;
      }

      const candidateAfterValidation = revalidated.components[0];
      const trialComponents = components.map((component, index) =>
        index === componentIndex ? candidateAfterValidation : component,
      );

      try {
        await this.previewBuilder.syncGeneratedComponents(
          preview.previewDir,
          trialComponents,
          tokens,
        );
        await this.validator.assertPreviewBuild(preview.frontendDir);
        await this.validator.assertPreviewRuntime(
          preview.previewUrl,
          this.buildRuntimeSmokeRoutes(preview.routeEntries),
        );
        components[componentIndex] = candidateAfterValidation;
        await this.logToFile(
          logPath,
          `[Post Edit Repair] Accepted updated component "${target.componentName}" on attempt ${attempt}/2 after build/runtime re-check.`,
        );
        return { components, applied: true };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logToFile(
          logPath,
          `[Post Edit Repair] Build/runtime failed for "${target.componentName}" attempt ${attempt}/2: ${message}`,
        );
        try {
          await this.previewBuilder.syncGeneratedComponents(
            preview.previewDir,
            components,
            tokens,
          );
        } catch (restoreError: any) {
          const restoreMessage =
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError);
          throw new Error(
            `Failed to restore preview after rejected post-edit repair for "${target.componentName}": ${restoreMessage}`,
          );
        }
        candidateComponent = candidateAfterValidation;
        retryFeedback = this.buildPostEditValidationRetryFeedback({
          baseFeedback,
          attempt,
          phase: 'preview build/runtime',
          error: message,
        });
      }
    }

    await this.previewBuilder.syncGeneratedComponents(
      preview.previewDir,
      snapshot,
      tokens,
    );
    await this.logToFile(
      logPath,
      `[Post Edit Repair] Exhausted repair attempts for "${target.componentName}". Keeping the previous edited version.`,
    );
    return { components: snapshot, applied: false };
  }

  private buildPostEditValidationRepairFeedback(input: {
    componentName: string;
    page: AutomationComparePageResult;
    validation: PostEditVisualValidationResult;
    request?: RunPipelineDto['editRequest'];
    requestContextLines: string[];
    sourceEvidence: string[];
    planEvidence: string[];
  }): string {
    const {
      componentName,
      page,
      validation,
      request,
      requestContextLines,
      sourceEvidence,
      planEvidence,
    } = input;
    const lines: string[] = [
      `An approved user edit request was already applied to component "${componentName}", but post-edit validation says the result still needs follow-up.`,
      `Route: ${page.route ?? page.visual?.reactPath ?? 'unknown'}`,
      `Post-edit validation summary: ${validation.summary}`,
      `Validation status: passed=${validation.passed} shouldRepair=${validation.shouldRepair} editIntentSatisfied=${validation.editIntentSatisfied} outOfScopeRegression=${validation.outOfScopeRegression} wpParityAdvisoryOnly=${validation.wpParityAdvisoryOnly} confidence=${validation.confidence.toFixed(2)} score=${validation.score}`,
      'Repair priority rules:',
      '- The approved user edit intent is PRIMARY.',
      '- WordPress is only a secondary reference after edit approval.',
      '- Do NOT revert the component back toward the original WordPress version unless the user request explicitly asked for that.',
      '- Make the requested change clearly visible if it is still too weak or missing.',
      '- If nearby/unrelated sections regressed, restore those areas while preserving the approved edit.',
    ];

    if (request?.prompt?.trim()) {
      lines.push(`Approved user request: ${request.prompt.trim()}`);
    }
    if (requestContextLines.length > 0) {
      lines.push('Resolved edit request context:');
      lines.push(...requestContextLines.map((line) => `- ${line}`));
    }
    if (validation.issues.length > 0) {
      lines.push('Post-edit validation issues:');
      lines.push(
        ...validation.issues.map(
          (issue) =>
            `- type=${issue.type} severity=${issue.severity} target=${issue.target ?? 'general'} inEditScope=${issue.inEditScope === true ? 'yes' : 'no'} evidence=${issue.evidence} action=${issue.suggestedAction}`,
        ),
      );
    }
    if (validation.repairPlan.instructions.length > 0) {
      lines.push('Validation repair instructions:');
      lines.push(
        ...validation.repairPlan.instructions.map(
          (instruction) => `- ${instruction}`,
        ),
      );
    }
    if (validation.repairPlan.guardrails.length > 0) {
      lines.push('Validation guardrails:');
      lines.push(
        ...validation.repairPlan.guardrails.map(
          (guardrail) => `- ${guardrail}`,
        ),
      );
    }
    if (sourceEvidence.length > 0) {
      lines.push('Secondary WordPress / DB source evidence:');
      lines.push(...sourceEvidence.map((line) => `- ${line}`));
    }
    if (planEvidence.length > 0) {
      lines.push('Current planner evidence:');
      lines.push(...planEvidence.map((line) => `- ${line}`));
    }

    lines.push(
      'Return a complete corrected component. Keep build/runtime safety, keep valid data bindings, and preserve unrelated sections.',
    );
    return lines.join('\n');
  }

  private buildPostEditValidationRetryFeedback(input: {
    baseFeedback: string;
    attempt: number;
    phase: 'code/runtime validation' | 'preview build/runtime';
    error: string;
  }): string {
    const { baseFeedback, attempt, phase, error } = input;
    return [
      baseFeedback,
      '',
      `Additional correction feedback after post-edit repair attempt ${attempt}:`,
      `- The previous post-edit repair failed ${phase} safety checks.`,
      '- Preserve the already-approved user edit direction.',
      '- Do NOT fall back to the pre-edit WordPress version.',
      '- Fix the concrete issue below and return valid, runnable code.',
      `- Failure detail: ${error}`,
    ].join('\n');
  }

  private async logAutomationCompareMetrics(
    logPath: string,
    stage: string,
    metrics: unknown,
  ): Promise<void> {
    const pages = this.collectAutomationComparePages(metrics);
    const overall =
      metrics && typeof metrics === 'object'
        ? ((metrics as { summary?: { overall?: Record<string, unknown> } })
            .summary?.overall ??
          (metrics as { overall?: Record<string, unknown> }).overall ??
          {})
        : {};
    const failingRoutes = [
      ...new Set(
        pages
          .filter(
            (page) =>
              page?.visual?.status === '⚠️  FAIL' ||
              page?.content?.status === 'FAIL' ||
              page?.content?.status === 'MISSING',
          )
          .map(
            (page) =>
              this.normalizeComparableRoute(page.route) ??
              this.normalizeComparableRoute(page.visual?.reactPath) ??
              'unknown',
          ),
      ),
    ];
    const repairNeededRaw = (overall as { repairNeeded?: unknown })
      .repairNeeded;
    const repairNeeded =
      typeof repairNeededRaw === 'boolean'
        ? repairNeededRaw
        : failingRoutes.length > 0;
    const declaredFailingRouteCount = this.coerceFiniteNumber(
      (overall as { failingRoutes?: unknown }).failingRoutes,
    );
    const lines: string[] = [
      `[Automation Compare] stage=${stage} pages=${pages.length} failingRoutes=${failingRoutes.length}${declaredFailingRouteCount !== null ? ` declaredFailingRoutes=${declaredFailingRouteCount}` : ''} repairNeeded=${repairNeeded}`,
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

  private summarizeSingleLine(
    value: string | null | undefined,
    maxChars = 180,
  ): string {
    const normalized = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
  }

  private buildCompactVisualIssueSummary(
    issues: Array<{
      type?: string;
      severity?: string;
      sectionHint?: string;
      location?: string;
      suggestedFix?: string;
    }>,
    limit = 3,
  ): string {
    const compact = issues
      .slice(0, limit)
      .map((issue) => {
        const locus = issue.sectionHint ?? issue.location ?? 'general';
        const action = this.summarizeSingleLine(issue.suggestedFix, 90);
        return `${issue.type ?? 'unknown'}:${issue.severity ?? 'unknown'}:${locus}${action ? ` -> ${action}` : ''}`;
      })
      .filter(Boolean);
    if (compact.length === 0) return '';
    return compact.join(' | ');
  }

  private buildCompactInstructionSummary(
    instructions: string[],
    limit = 2,
  ): string {
    const compact = instructions
      .slice(0, limit)
      .map((instruction) => this.summarizeSingleLine(instruction, 110))
      .filter(Boolean);
    if (compact.length === 0) return '';
    return compact.join(' | ');
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
        (entry) =>
          !this.isCatchAllPreviewRoute(entry) &&
          this.normalizeComparableRoute(entry.route) === route,
      );
      if (exactMatch) return exactMatch.componentName;

      const patternMatch = preview.routeEntries.find(
        (entry) =>
          !this.isCatchAllPreviewRoute(entry) &&
          this.previewRouteMatches(entry.route, route),
      );
      if (patternMatch) return patternMatch.componentName;
    }

    const hinted = page.componentHint?.trim();
    if (hinted && componentNames.has(hinted)) return hinted;
    const notFoundEntry = preview.routeEntries.find((entry) =>
      this.isCatchAllPreviewRoute(entry),
    );
    if (notFoundEntry && hinted === notFoundEntry.componentName) {
      return notFoundEntry.componentName;
    }
    return null;
  }

  private normalizeComparableRoute(route?: string | null): string | null {
    if (!route) return null;
    let value = route.trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        value = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      } catch {
        // Fall through with the raw value if URL parsing fails.
      }
    }
    value = value.replace(/^\/preview\/[^/]+(?=\/|$)/i, '');
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

  private isCatchAllPreviewRoute(
    entry: Pick<
      PreviewBuilderResult['routeEntries'][number],
      'route' | 'componentName'
    >,
  ): boolean {
    return (
      entry.route.trim() === '*' || /^NotFound$/i.test(entry.componentName)
    );
  }

  private buildRuntimeSmokeRoutes(
    routeEntries: PreviewBuilderResult['routeEntries'] | undefined,
  ): string[] {
    const staticRoutes =
      routeEntries
        ?.map((entry) => entry.route)
        .filter((route) => {
          const normalized = this.normalizeComparableRoute(route);
          return Boolean(
            normalized &&
            (normalized === '/' ||
              (!normalized.includes(':') && normalized !== '*')),
          );
        }) ?? [];
    return [...new Set(staticRoutes.length > 0 ? staticRoutes : ['/'])];
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
      await this.logVisualMetricsTrace(
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
    await this.logVisualMetricsTrace(
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
    await this.logVisualMetricsTrace(
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

      const componentPlan = plan.find(
        (entry) => entry.componentName === target.componentName,
      );
      const sourceEvidence = this.buildSourceEvidenceForComparePage(
        target.page,
        content,
      );
      const planEvidence = this.buildPlanEvidenceForComponent(componentPlan);
      const visionImageUrls = await this.buildComparePageVisionInputs(
        target.page,
      );
      const diagnosisModel =
        this.configService.get<string>('pipeline.reviewCodeModel') ??
        fixAgentModel;
      await this.logToFile(
        logPath,
        [
          `[Visual Diagnose] component=${target.componentName} route=${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'} model=${diagnosisModel || 'default'} images=${visionImageUrls.length}`,
          `[Visual Diagnose] incoming metrics: ${this.formatAutomationComparePageSummary(
            target.page,
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
        ].join('\n'),
      );
      await this.logVisualMetricsTrace(
        logPath,
        [
          `[Visual Diagnose] component=${target.componentName} route=${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'} model=${diagnosisModel || 'default'} images=${visionImageUrls.length}`,
          `[Visual Diagnose] incoming metrics: ${this.formatAutomationComparePageSummary(
            target.page,
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
        ].join('\n'),
      );
      const diagnosis = await this.siteCompareVisualDiagnosis.diagnose({
        componentName: target.componentName,
        page: target.page,
        sourceEvidence,
        planEvidence,
        modelName: diagnosisModel,
        visionImageUrls,
      });
      await this.logToFile(
        logPath,
        [
          `[Visual Diagnose] ${target.componentName} route=${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'} mode=${diagnosis.analysisMode ?? 'unknown'} rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)} score=${diagnosis.score}`,
          `[Visual Diagnose] strategy=${diagnosis.repairPlan.strategy} shouldRepair=${diagnosis.shouldRepair}`,
          this.summarizeLogLines(
            diagnosis.issues.map(
              (issue) =>
                `${issue.type}|${issue.severity}|${issue.sectionHint ?? issue.location ?? 'general'}|${issue.suggestedFix}`,
            ),
            6,
            '[Visual Diagnose] issues',
          ),
          this.summarizeLogLines(
            diagnosis.repairPlan.instructions,
            5,
            '[Visual Diagnose] instructions',
          ),
        ].join('\n'),
      );
      await this.logVisualMetricsTrace(
        logPath,
        [
          `[Visual Diagnose] ${target.componentName} route=${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'} mode=${diagnosis.analysisMode ?? 'unknown'} rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)} score=${diagnosis.score}`,
          `[Visual Diagnose] strategy=${diagnosis.repairPlan.strategy} shouldRepair=${diagnosis.shouldRepair}`,
          this.summarizeLogLines(
            diagnosis.issues.map(
              (issue) =>
                `${issue.type}|${issue.severity}|${issue.sectionHint ?? issue.location ?? 'general'}|${issue.suggestedFix}`,
            ),
            6,
            '[Visual Diagnose] issues',
          ),
          this.summarizeLogLines(
            diagnosis.repairPlan.instructions,
            5,
            '[Visual Diagnose] instructions',
          ),
        ].join('\n'),
      );
      if (diagnosis.debugTrace) {
        await this.logVisualMetricsTrace(
          logPath,
          [
            `[Visual Diagnose Debug] source=${diagnosis.debugTrace.source} parseFailed=${diagnosis.debugTrace.parseFailed === true ? 'yes' : 'no'}`,
            diagnosis.debugTrace.rawModelResponse
              ? `[Visual Diagnose Debug] raw response:\n${this.summarizeMultilineForLog(
                  diagnosis.debugTrace.rawModelResponse,
                  40,
                  12000,
                )}`
              : '[Visual Diagnose Debug] raw response: none',
            diagnosis.debugTrace.extractedJson
              ? `[Visual Diagnose Debug] extracted json:\n${this.summarizeMultilineForLog(
                  diagnosis.debugTrace.extractedJson,
                  40,
                  12000,
                )}`
              : '[Visual Diagnose Debug] extracted json: none',
            diagnosis.debugTrace.parsedDiagnosisJson
              ? `[Visual Diagnose Debug] parsed diagnosis:\n${this.summarizeMultilineForLog(
                  diagnosis.debugTrace.parsedDiagnosisJson,
                  60,
                  16000,
                )}`
              : '[Visual Diagnose Debug] parsed diagnosis: none',
            diagnosis.debugTrace.mergedDiagnosisJson
              ? `[Visual Diagnose Debug] merged diagnosis:\n${this.summarizeMultilineForLog(
                  diagnosis.debugTrace.mergedDiagnosisJson,
                  60,
                  16000,
                )}`
              : '[Visual Diagnose Debug] merged diagnosis: none',
          ].join('\n'),
        );
      }
      await this.writeVisualDiagnosisArtifacts(
        logPath,
        target.componentName,
        diagnosis,
      );
      this.logger.log(
        `[Visual Diagnose] "${target.componentName}" mode=${diagnosis.analysisMode ?? 'unknown'} rootCause=${diagnosis.rootCause.primary} shouldRepair=${diagnosis.shouldRepair} confidence=${diagnosis.confidence.toFixed(2)} strategy=${this.summarizeSingleLine(diagnosis.repairPlan.strategy, 180)}`,
      );
      const compactDiagnosisIssues = this.buildCompactVisualIssueSummary(
        diagnosis.issues,
        3,
      );
      if (compactDiagnosisIssues) {
        this.logger.log(
          `[Visual Diagnose] "${target.componentName}" top issues: ${compactDiagnosisIssues}`,
        );
      }
      const compactDiagnosisInstructions = this.buildCompactInstructionSummary(
        diagnosis.repairPlan.instructions,
        2,
      );
      if (compactDiagnosisInstructions) {
        this.logger.log(
          `[Visual Diagnose] "${target.componentName}" key instructions: ${compactDiagnosisInstructions}`,
        );
      }
      if (!diagnosis.shouldRepair || diagnosis.confidence < 0.55) {
        this.logger.warn(
          `[Visual Metrics Repair] Diagnosis confidence too low for "${target.componentName}". Skipping targeted fix. rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)}`,
        );
        await this.logToFile(
          logPath,
          `[Visual Metrics Repair] Skipped "${target.componentName}" because diagnosis confidence was too low (${diagnosis.confidence.toFixed(2)}). rootCause=${diagnosis.rootCause.primary}`,
        );
        await this.logVisualMetricsTrace(
          logPath,
          `[Visual Metrics Repair] Skipped "${target.componentName}" because diagnosis confidence was too low (${diagnosis.confidence.toFixed(2)}). rootCause=${diagnosis.rootCause.primary}`,
        );
        continue;
      }

      const visionContextNote = this.buildComparePageVisionContext(target.page);
      const feedback = this.buildVisualRepairFeedback({
        componentName: target.componentName,
        page: target.page,
        diagnosis,
        plan,
        content,
      });
      const metricsFixMode = this.selectVisualMetricsFixMode({
        componentPlan,
        diagnosis,
      });

      this.logger.warn(
        `[Visual Metrics Repair] Fixing component "${target.componentName}" from route "${target.page.route ?? target.page.visual?.reactPath ?? 'unknown'}" after diagnosis rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)} fixMode=${metricsFixMode}`,
      );
      await this.logToFile(
        logPath,
        [
          `[Visual Metrics Repair] Fixing "${target.componentName}" with diagnosis rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)} fixMode=${metricsFixMode}.`,
          `[Visual Metrics Repair] visionArtifacts=${visionImageUrls.length} visionContext=${JSON.stringify(visionContextNote || '')}`,
          `[Visual Metrics Repair] fix feedback:\n${this.summarizeMultilineForLog(
            feedback,
          )}`,
        ].join('\n'),
      );
      await this.logVisualMetricsTrace(
        logPath,
        [
          `[Visual Metrics Repair] Fixing "${target.componentName}" with diagnosis rootCause=${diagnosis.rootCause.primary} confidence=${diagnosis.confidence.toFixed(2)} fixMode=${metricsFixMode}.`,
          `[Visual Metrics Repair] visionArtifacts=${visionImageUrls.length} visionContext=${JSON.stringify(visionContextNote || '')}`,
          `[Visual Metrics Repair] fix feedback:\n${this.summarizeMultilineForLog(
            feedback,
          )}`,
        ].join('\n'),
      );

      const originalComponent = components[componentIndex];
      let candidateComponent = originalComponent;
      let retryFeedback = feedback;
      let acceptedComponent: ReactGenerateResult['components'][number] | null =
        null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          this.logger.warn(
            `[Visual Metrics Repair] Retrying "${target.componentName}" attempt ${attempt}/3 with accumulated feedback. fixMode=${metricsFixMode}`,
          );
          await this.logToFile(
            logPath,
            `[Visual Metrics Repair] Retrying "${target.componentName}" attempt ${attempt}/3 with accumulated code/runtime feedback.`,
          );
          await this.logVisualMetricsTrace(
            logPath,
            `[Visual Metrics Repair] Retrying "${target.componentName}" attempt ${attempt}/3 with accumulated code/runtime feedback.`,
          );
        }

        const fixed = await this.reactGenerator.fixComponent({
          component: candidateComponent,
          plan,
          feedback: retryFeedback,
          modelConfig: { fixAgent: fixAgentModel },
          logPath,
          fixMode: metricsFixMode,
          visionImageUrls,
          visionContextNote,
        });
        const preserveVisualPlanForMetricsRepair =
          this.shouldPreserveVisualPlanDuringMetricsRepair({
            componentPlan,
            diagnosis,
            fixMode: metricsFixMode,
          });
        this.logger.log(
          `[Visual Metrics Repair] "${target.componentName}" attempt ${attempt}/3 running fix agent. fixMode=${metricsFixMode} preserveVisualPlan=${preserveVisualPlanForMetricsRepair ? 'yes' : 'no'}`,
        );
        await this.logVisualMetricsTrace(
          logPath,
          `[Visual Metrics Repair] "${target.componentName}" attempt ${attempt}/3 running fix agent. fixMode=${metricsFixMode} preserveVisualPlan=${preserveVisualPlanForMetricsRepair ? 'yes' : 'no'}`,
        );
        const metricsRevalidationCandidate = {
          ...fixed,
          // Pure presentation repairs may diverge from the original visual plan
          // once code/runtime safety still holds. Structural or detail-route
          // repairs must keep the approved/source-backed plan attached so the
          // validator can reject section/content drift.
          visualPlan: preserveVisualPlanForMetricsRepair
            ? (fixed.visualPlan ?? componentPlan?.visualPlan)
            : undefined,
        };
        const revalidated = this.validator.collectValidationIssues([
          metricsRevalidationCandidate,
        ]);
        if (revalidated.failures.length > 0) {
          const error =
            revalidated.failures[0]?.error ?? 'Unknown validation error';
          this.logger.warn(
            `[Visual Metrics Repair] Re-validation failed for "${target.componentName}" attempt ${attempt}/3. Error: ${error}`,
          );
          this.logger.warn(
            `[Visual Metrics Repair] "${target.componentName}" attempt ${attempt}/3 will retry after code/runtime validation failure. fixMode=${metricsFixMode}`,
          );
          await this.logToFile(
            logPath,
            `[Visual Metrics Repair] Re-validation failed for "${target.componentName}" attempt ${attempt}/3: ${error}`,
          );
          await this.logVisualMetricsTrace(
            logPath,
            `[Visual Metrics Repair] Re-validation failed for "${target.componentName}" attempt ${attempt}/3: ${error}`,
          );
          candidateComponent = originalComponent;
          retryFeedback = this.buildVisualMetricsRetryFeedback({
            baseFeedback: feedback,
            attempt,
            phase: 'code/runtime validation',
            error,
          });
          continue;
        }

        const candidateAfterValidation = revalidated.components[0];
        const trialComponents = components.map((component, index) =>
          index === componentIndex ? candidateAfterValidation : component,
        );

        try {
          await this.previewBuilder.syncGeneratedComponents(
            preview.previewDir,
            trialComponents,
            tokens,
          );
          await this.validator.assertPreviewBuild(preview.frontendDir);
          await this.validator.assertPreviewRuntime(
            preview.previewUrl,
            this.buildRuntimeSmokeRoutes(preview.routeEntries),
          );
          acceptedComponent = candidateAfterValidation;
          components[componentIndex] = candidateAfterValidation;
          repairedCount += 1;
          this.logger.log(
            `[Visual Metrics Repair] Accepted "${target.componentName}" on attempt ${attempt}/3. fixMode=${metricsFixMode} preserveVisualPlan=${preserveVisualPlanForMetricsRepair ? 'yes' : 'no'}`,
          );
          await this.logToFile(
            logPath,
            `[Visual Metrics Repair] Accepted updated component "${target.componentName}" on attempt ${attempt}/3 after build/runtime re-check (fixMode=${metricsFixMode}, preserveVisualPlan=${preserveVisualPlanForMetricsRepair ? 'yes' : 'no'}).`,
          );
          await this.logVisualMetricsTrace(
            logPath,
            `[Visual Metrics Repair] Accepted updated component "${target.componentName}" on attempt ${attempt}/3 after build/runtime re-check (fixMode=${metricsFixMode}, preserveVisualPlan=${preserveVisualPlanForMetricsRepair ? 'yes' : 'no'}).`,
          );
          break;
        } catch (error: any) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `[Visual Metrics Repair] Build/runtime failed for "${target.componentName}" attempt ${attempt}/3. Error: ${message}`,
          );
          this.logger.warn(
            `[Visual Metrics Repair] "${target.componentName}" attempt ${attempt}/3 failed preview build/runtime after AI fix. fixMode=${metricsFixMode}`,
          );
          await this.logToFile(
            logPath,
            `[Visual Metrics Repair] Build/runtime failed for "${target.componentName}" attempt ${attempt}/3: ${message}`,
          );
          await this.logVisualMetricsTrace(
            logPath,
            `[Visual Metrics Repair] Build/runtime failed for "${target.componentName}" attempt ${attempt}/3: ${message}`,
          );
          try {
            await this.previewBuilder.syncGeneratedComponents(
              preview.previewDir,
              components,
              tokens,
            );
          } catch (restoreError: any) {
            const restoreMessage =
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError);
            throw new Error(
              `Failed to restore preview after rejected metrics repair for "${target.componentName}": ${restoreMessage}`,
            );
          }
          candidateComponent = candidateAfterValidation;
          retryFeedback = this.buildVisualMetricsRetryFeedback({
            baseFeedback: feedback,
            attempt,
            phase: 'preview build/runtime',
            error: message,
          });
        }
      }

      if (!acceptedComponent) {
        this.logger.warn(
          `[Visual Metrics Repair] Exhausted repair attempts for "${target.componentName}". Keeping the previous version.`,
        );
        await this.logToFile(
          logPath,
          `[Visual Metrics Repair] Exhausted repair attempts for "${target.componentName}". Keeping the previous version.`,
        );
        await this.logVisualMetricsTrace(
          logPath,
          `[Visual Metrics Repair] Exhausted repair attempts for "${target.componentName}". Keeping the previous version.`,
        );
        components[componentIndex] = originalComponent;
        continue;
      }
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
        this.buildRuntimeSmokeRoutes(preview.routeEntries),
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
      await this.logVisualMetricsTrace(
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

  private selectVisualMetricsFixMode(input: {
    componentPlan: PlanResult[number] | undefined;
    diagnosis: VisualMismatchDiagnosis;
  }): 'full' | 'visual-metrics-safe' {
    const { componentPlan, diagnosis } = input;
    const normalizedNeeds = new Set(componentPlan?.dataNeeds ?? []);
    const isDetailRoute =
      normalizedNeeds.has('pageDetail') || normalizedNeeds.has('postDetail');
    const primaryRootCause = diagnosis.rootCause.primary;
    const hasStructuralIssue =
      diagnosis.evidence.sectionLikelyMissingFromPlan ||
      diagnosis.issues.some(
        (issue) =>
          issue.type === 'missing_section' ||
          issue.type === 'section_order' ||
          issue.type === 'content_missing',
      );
    const requiresStructuralOrDataRepair =
      hasStructuralIssue ||
      primaryRootCause === 'plan-omission' ||
      primaryRootCause === 'missing-section' ||
      primaryRootCause === 'data-binding-error' ||
      primaryRootCause === 'content-drift' ||
      primaryRootCause === 'missing-image';

    if (requiresStructuralOrDataRepair) {
      return 'full';
    }
    if (
      isDetailRoute &&
      primaryRootCause !== 'layout-drift' &&
      primaryRootCause !== 'shared-layout-mismatch'
    ) {
      return 'full';
    }
    return 'visual-metrics-safe';
  }

  private shouldPreserveVisualPlanDuringMetricsRepair(input: {
    componentPlan: PlanResult[number] | undefined;
    diagnosis: VisualMismatchDiagnosis;
    fixMode: 'full' | 'visual-metrics-safe';
  }): boolean {
    const { componentPlan, diagnosis, fixMode } = input;
    if (fixMode === 'full') return true;
    const normalizedNeeds = new Set(componentPlan?.dataNeeds ?? []);
    if (
      normalizedNeeds.has('pageDetail') ||
      normalizedNeeds.has('postDetail')
    ) {
      return true;
    }
    return diagnosis.evidence.sectionLikelyMissingFromPlan;
  }

  private buildVisualMetricsRetryFeedback(input: {
    baseFeedback: string;
    attempt: number;
    phase: 'code/runtime validation' | 'preview build/runtime';
    error: string;
  }): string {
    const { baseFeedback, attempt, phase, error } = input;
    return [
      baseFeedback,
      '',
      `Additional correction feedback after metrics-repair attempt ${attempt}:`,
      `- The previous metrics-driven edit failed ${phase} safety checks.`,
      '- Keep the intended metrics-driven visual correction.',
      '- Do NOT revert just to match the old visual plan.',
      '- Fix the concrete issue below and return valid, runnable code.',
      `- Failure detail: ${error}`,
    ].join('\n');
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
    const surfaceSnapshot = buildSurfacePlanRegressionSnapshot(
      componentPlan.surfacePlan,
    );
    if (surfaceSnapshot) {
      lines.push(
        `Surface plan: kind=${surfaceSnapshot.kind} | authority=${surfaceSnapshot.authority} | intent=${surfaceSnapshot.pageIntent} | clusters=${surfaceSnapshot.clusterKinds.join(', ') || 'none'} | widgets=${surfaceSnapshot.widgetKinds.join(', ') || 'none'}`,
      );
    }
    if (componentPlan.visualPlan?.sections?.length) {
      lines.push(
        `Visual plan sections: ${componentPlan.visualPlan.sections
          .map((section) => this.summarizePlanSection(section))
          .filter(Boolean)
          .join(' || ')}`,
      );
    }
    const plannerSections = resolvePlannerSectionBlueprint({
      visualPlan: componentPlan.visualPlan,
      surfacePlan: componentPlan.surfacePlan,
    });
    if (!componentPlan.visualPlan?.sections?.length && plannerSections.length) {
      lines.push(
        `Planner section blueprint: ${plannerSections
          .map((section) => this.summarizePlanSection(section))
          .filter(Boolean)
          .join(' || ')}`,
      );
    } else if (componentPlan.draftSections?.length) {
      lines.push(
        `Compatibility draft sections: ${componentPlan.draftSections
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
    const fixedSlug = componentPlan?.fixedSlug?.trim();
    const dataNeeds = new Set(componentPlan?.dataNeeds ?? []);
    const lines: string[] = [
      `Automation visual-compare reported a fidelity mismatch for component "${componentName}".`,
      `Repair the component so the rendered React preview matches the WordPress source more closely for route "${page.route ?? page.visual?.reactPath ?? 'unknown'}".`,
      `Diagnosis: mode=${diagnosis.analysisMode ?? 'unknown'} | rootCause=${diagnosis.rootCause.primary} | confidence=${diagnosis.confidence.toFixed(2)} | score=${diagnosis.score} | strategy=${diagnosis.repairPlan.strategy}`,
      diagnosis.rootCause.reasoning
        ? `Diagnosis reasoning: ${diagnosis.rootCause.reasoning}`
        : '',
    ];

    if (componentPlan) {
      lines.push(
        `Approved route/data contract: type=${componentPlan.type} | route=${componentPlan.route ?? 'unknown'} | isDetail=${componentPlan.isDetail === true ? 'yes' : 'no'} | fixedSlug=${fixedSlug ?? 'none'} | dataNeeds=${componentPlan.dataNeeds?.join(', ') || 'none'}`,
      );
    }
    if (componentPlan?.type === 'page') {
      lines.push(
        'Layout contract: page components must NOT render their own global `<header>`, `<footer>`, or site navigation. Shared Layout wrapper owns that chrome.',
      );
    }
    if (dataNeeds.has('pageDetail')) {
      lines.push(
        fixedSlug
          ? `Main record binding is mandatory: fetch the exact page only from \`/api/pages/${fixedSlug}\`. Do NOT switch to \`/api/pages/\${slug}\`, \`useParams()\` for the main record, or \`/api/pages\` + lookup.`
          : componentPlan?.runtimeRenderer === 'runtime-page'
            ? 'Main record binding is mandatory: fetch the page detail from `/api/runtime/pages/${slug}`. Do NOT replace it with `/api/pages/${slug}` and do NOT replace it with `/api/pages` + lookup.'
            : 'Main record binding is mandatory: fetch the page detail from `/api/pages/${slug}` (or equivalent string concatenation with `slug`). Do NOT replace it with `/api/pages` + lookup.',
      );
    }
    if (dataNeeds.has('postDetail')) {
      lines.push(
        fixedSlug
          ? `Main record binding is mandatory: fetch the exact post only from \`/api/posts/${fixedSlug}\`. Do NOT switch to \`/api/posts/\${slug}\`, \`useParams()\` for the main record, or \`/api/posts\` + lookup.`
          : 'Main record binding is mandatory: fetch the post detail from `/api/posts/${slug}` (or equivalent string concatenation with `slug`). Do NOT replace it with `/api/posts` + lookup.',
      );
    }

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
    if (diagnosis.issues.length > 0) {
      lines.push('Diagnosis issues:');
      lines.push(
        ...diagnosis.issues.map(
          (issue) =>
            `- type=${issue.type} severity=${issue.severity} sectionHint=${issue.sectionHint ?? 'unknown'} location=${issue.location ?? 'unknown'} sourceBacked=${issue.sourceBacked === true ? 'yes' : 'no'} evidence=${issue.evidence} fix=${issue.suggestedFix}`,
        ),
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

    if (componentPlan) {
      lines.push('Approved route/data/layout contract:');
      lines.push(`- componentType=${componentPlan.type}`);
      lines.push(`- route=${componentPlan.route ?? 'unknown'}`);
      lines.push(
        `- isDetail=${componentPlan.isDetail === true ? 'yes' : 'no'}`,
      );
      if (componentPlan.fixedSlug) {
        lines.push(`- fixedSlug=${componentPlan.fixedSlug}`);
      }
      if (componentPlan.dataNeeds?.length) {
        lines.push(`- dataNeeds=${componentPlan.dataNeeds.join(', ')}`);
      }

      const normalizedNeeds = new Set(componentPlan.dataNeeds ?? []);
      const fixedSlug = componentPlan.fixedSlug?.trim();
      if (componentPlan.type === 'page') {
        lines.push(
          '- Do NOT add a page-level `<header>`, `<footer>`, or site navigation block. Shared Layout already renders site chrome.',
        );
      }
      if (normalizedNeeds.has('pageDetail')) {
        lines.push(
          fixedSlug
            ? `- Main page-detail binding is strict: fetch ONLY \`/api/pages/${fixedSlug}\` for the main record. Do NOT use \`useParams()\`, \`/api/pages/\${slug}\`, or \`/api/pages\` + lookup.`
            : componentPlan.runtimeRenderer === 'runtime-page'
              ? '- Main page-detail binding is strict: fetch the main record from `/api/runtime/pages/${slug}`. Do NOT use `/api/pages/${slug}` and do NOT use `/api/pages` + lookup.'
              : '- Main page-detail binding is strict: fetch the main record from `/api/pages/${slug}` (or equivalent string concatenation with `slug`). Do NOT use `/api/pages` + lookup.',
        );
      }
      if (normalizedNeeds.has('postDetail')) {
        lines.push(
          fixedSlug
            ? `- Main post-detail binding is strict: fetch ONLY \`/api/posts/${fixedSlug}\` for the main record. Do NOT use \`useParams()\`, \`/api/posts/\${slug}\`, or \`/api/posts\` + lookup.`
            : '- Main post-detail binding is strict: fetch the main record from `/api/posts/${slug}` (or equivalent string concatenation with `slug`). Do NOT use `/api/posts` + lookup.',
        );
      }
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
      selector: undefined,
      nearestHeading: undefined,
      tagName: undefined,
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

    const inMemoryMutationCandidates =
      await buildUiMutationCandidatesForGeneratedComponents({
        components,
      });
    const postMigrationEditTasks =
      this.editRequestPhase.buildPostMigrationEditTasks({
        request,
        context: editRequestContext,
        plan,
        components,
        mutationCandidates: inMemoryMutationCandidates,
      });
    const exactCaptureTargetsForEditPass = dedupeCaptureTargets(
      postMigrationEditTasks.flatMap((task) => task.exactTargets),
    );
    await this.logExactCaptureResolution({
      jobId,
      logPath,
      attachments: request.attachments,
      resolutionSource: 'in-memory:component-mutation-targets',
      candidateCount: inMemoryMutationCandidates.length,
      exactCaptureTargets: exactCaptureTargetsForEditPass,
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
            `${task.feedback}\n\nThe previous focused edit attempt failed validation:\n${validationErr}\n\nRetry by changing only the requested target region. Preserve every other section, section order, hero/title text, CTA labels, semantic region boundaries, and approved visual-plan content exactly as they already exist.`,
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
    resolutionSource: string;
    candidateCount: number;
    exactCaptureTargets: ResolvedCaptureTargetRecord[];
  }): Promise<void> {
    const {
      jobId,
      logPath,
      attachments,
      resolutionSource,
      candidateCount,
      exactCaptureTargets,
    } = input;

    const summaryMessage = [
      `[${jobId}] [capture-resolve]`,
      `source=${resolutionSource}`,
      `candidates=${candidateCount}`,
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

  private componentImportsAny(
    component: { code: string },
    componentNames: Set<string>,
  ): boolean {
    if (componentNames.size === 0) return false;
    const matches = [
      ...component.code.matchAll(
        /import\s+([A-Z][A-Za-z0-9]*)\s+from\s+['"]([^'"]+)['"]/g,
      ),
    ];
    for (const match of matches) {
      const localName = match[1];
      const importPath = match[2];
      if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
        continue;
      }
      const basename = importPath
        .replace(/^\.\/|^\.\.\//, '')
        .split('/')
        .pop()
        ?.replace(/\.(?:js|jsx|ts|tsx)$/, '');
      if (basename && basename === localName && componentNames.has(localName)) {
        return true;
      }
    }
    return false;
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
      normalized.includes('visual plan obligations violated') ||
      normalized.includes('visual plan fidelity violated') ||
      normalized.includes('surface-plan source evidence violated') ||
      normalized.includes('sectionaudit:') ||
      normalized.includes('required capability') ||
      normalized.includes('obligation "') ||
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

    if (normalized.includes('visual plan obligations violated')) {
      reasons.add('obligation-violation');
    }

    const sectionAuditPattern =
      /sectionAudit:\s+[^\n|]+\|\s+debugKey=([^|]+)\|\s+type=([^|]+)\|\s+missing=([^|]+)\|/g;
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
    attachment.captureContext?.page?.route ?? attachment.sourcePageUrl;
  const sectionType = inferSectionTypeForLog(attachment);
  const sectionIndex = inferSectionIndexForLog(attachment);

  return [
    `id=${attachment.id}`,
    pageRoute ? `route=${pageRoute}` : null,
    sectionType ? `sectionType=${sectionType}` : null,
    typeof sectionIndex === 'number' ? `sectionIndex≈${sectionIndex}` : null,
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
  const signal = normalizeLogToken(attachment.note ?? '');

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
    `template=${target.templateName}`,
    `sourceFile=${target.sourceFile}`,
    `component=${target.componentName}`,
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
    attachment.captureContext?.page?.route
      ? `route=${attachment.captureContext.page.route}`
      : null,
    attachment.note ? `note="${truncateForLog(attachment.note, 120)}"` : null,
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

function dedupeCaptureTargets(
  targets: ResolvedCaptureTargetRecord[],
): ResolvedCaptureTargetRecord[] {
  const deduped = new Map<string, ResolvedCaptureTargetRecord>();
  for (const target of targets) {
    deduped.set(target.captureId, target);
  }
  return Array.from(deduped.values());
}
