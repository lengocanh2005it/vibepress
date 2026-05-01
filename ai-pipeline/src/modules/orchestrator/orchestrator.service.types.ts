import type { ReplaySubject } from 'rxjs';
import type {
  TokenTracker,
  TokenUsagePhaseSummary,
} from '../../common/utils/token-tracker.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import type { PreviewBuilderResult } from '../agents/preview-builder/preview-builder.service.js';
import type { ReactGenerateResult } from '../agents/react-generator/react-generator.service.js';
import type { ThemeTokens } from '../agents/block-parser/block-parser.service.js';
import type { ResolvedEditRequestContext } from '../edit-request/edit-request.types.js';
import type { RunPipelineDto } from './orchestrator.dto.js';
import type {
  PendingEditApprovalGate,
  PipelineStatus,
  ProgressEvent,
  ProgressEventData,
} from './orchestrator.runtime.types.js';

export interface JobRuntimeControl {
  stopRequested: boolean;
  deleteRequested: boolean;
  skipVisualCompareRequested?: boolean;
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

export interface PipelineRetryCounters {
  plannerReview: number;
  visualPlanReview: number;
  validatorFix: number;
  generatedCodeFix: number;
  backendFix: number;
  buildFix: number;
}

export interface FullComponentRegenerationSummaryEntry {
  timestamp: string;
  stage: 'stage4-validator-fix' | 'stage5-review-fix';
  componentName: string;
  reasons: string[];
  missingTargets: string[];
  outcome: 'succeeded' | 'failed';
  triggerErrorPreview: string;
  finalError?: string;
}

export interface PipelineRuntimeSummaryDraft {
  startedAt: string;
  repoAnalysisSummary: string[];
  stepDurationsMs: Partial<Record<string, number>>;
  retries: PipelineRetryCounters;
  fullComponentRegenerations: FullComponentRegenerationSummaryEntry[];
}

export interface PipelineAccuracySummary {
  percent: number | null;
  diffPercentage: number | null;
  differentPixels: number | null;
  totalPixels: number | null;
}

export interface PipelineUiAssessment {
  score: number | null;
  verdict: string;
  basis: string[];
}

export interface DegradedComponentRecord {
  componentName: string;
  route?: string | null;
  stage:
    | 'stage4-validator'
    | 'stage5-review'
    | 'stage8-build'
    | 'stage9-visual-repair'
    | 'stage9b-post-edit-repair';
  fallbackType:
    | 'last-known-safe'
    | 'canonical-deterministic'
    | 'degraded-placeholder';
  reason: string;
  critical: boolean;
  timestamp: string;
}

export interface AutomationCompareRegion {
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

export interface AutomationComparePageVisual {
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

export interface AutomationComparePageContent {
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

export interface AutomationComparePageResult {
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

export interface PipelineRunSummaryFile {
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
  degradedComponents?: DegradedComponentRecord[];
}

export interface OrchestratorRuntimeStores {
  jobs: Map<string, PipelineStatus>;
  progress: Map<string, ReplaySubject<ProgressEvent>>;
  controls: Map<string, JobRuntimeControl>;
  stepEventData: Map<string, Map<string, ProgressEventData>>;
}
