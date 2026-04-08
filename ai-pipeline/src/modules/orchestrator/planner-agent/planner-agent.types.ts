import type { DbContentResult } from '../../agents/db-content/db-content.service.js';
import type { PlanReviewResult } from '../../agents/plan-reviewer/plan-reviewer.service.js';
import type {
  ComponentPlan,
  PlanResult,
} from '../../agents/planner/planner.service.js';
import type { RepoThemeManifest } from '../../agents/repo-analyzer/repo-analyzer.service.js';
import type { ThemeNormalizeResult } from '../stages/pipeline-stage.types.js';

export type PlannerToolName =
  | 'generate_plan'
  | 'review_plan'
  | 'attach_visual_plans'
  | 'review_visual_plan';

export interface PlannerAgentInput {
  normalizedTheme: ThemeNormalizeResult;
  content: DbContentResult;
  repoManifest: RepoThemeManifest;
  expectedTemplateNames: string[];
  modelName: string;
  jobId: string;
  logPath?: string;
  maxRounds?: number;
}

export interface PlannerAgentState {
  plan?: PlanResult;
  review?: PlanReviewResult;
  history: PlannerAgentHistoryItem[];
  visualsAttached: boolean;
}

export interface PlannerAgentHistoryItem {
  round: number;
  tool: PlannerToolName;
  input: Record<string, unknown>;
  summary: string;
}

export interface PlannerToolExecutionResult {
  summary: string;
}

export interface PlannerToolDefinition {
  name: PlannerToolName;
  description: string;
  inputHint: string;
  execute(
    state: PlannerAgentState,
    input: Record<string, unknown>,
  ): Promise<PlannerToolExecutionResult>;
}

export interface PlannerAgentDecision {
  thought?: string;
  action: 'tool' | 'finish';
  tool?: PlannerToolName;
  input?: Record<string, unknown>;
  finalReason?: string;
}

export interface PlannerAgentResult {
  reviewResult: PlanReviewResult;
  history: PlannerAgentHistoryItem[];
}

export function summarizePlan(plan?: PlanResult): string {
  if (!plan?.length) return 'no plan yet';
  const pageCount = plan.filter((item) => item.type === 'page').length;
  const partialCount = plan.length - pageCount;
  const visualCount = plan.filter((item) => item.visualPlan).length;
  const previewNames = plan
    .slice(0, 8)
    .map((item: ComponentPlan) => item.componentName)
    .join(', ');
  return `${plan.length} components (${pageCount} pages, ${partialCount} partials), ${visualCount} with visuals. Preview: ${previewNames || 'none'}`;
}
