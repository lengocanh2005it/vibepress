import type {
  PipelineEditRequestDto,
  PipelineIncomingEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';
import type { EditOperation } from './edit-operation.util.js';

export interface EditRequestPreparationSummary {
  source: 'empty' | 'current' | 'legacy';
  attachmentCount: number;
  hasPrompt: boolean;
  hasVisualContext: boolean;
}

export interface EditRequestPreparationResult {
  raw?: PipelineIncomingEditRequestDto;
  request?: PipelineEditRequestDto;
  summary: EditRequestPreparationSummary;
}

export type EditRequestMode = 'none' | 'no_capture' | 'capture';

export type EditIntentCategory =
  | 'full_site_migration'
  | 'full_site_migration_with_focus'
  | 'targeted_component_edit' // layout / color / content / add / replace on a specific component
  | 'invalid';

export type { EditOperation };

export type EditTargetScope =
  | 'site'
  | 'route'
  | 'component'
  | 'section'
  | 'element'
  | 'unknown';

export type EditExecutionStrategy =
  | 'full-site-migration'
  | 'focused-migration'
  | 'component-edit'
  | 'section-edit'
  | 'element-edit'
  | 'best-effort-inference';

export interface EditIntentTargetCandidate {
  componentName?: string;
  route?: string | null;
  templateName?: string;
  sectionKey?: string;
  sectionType?: string;
  targetNodeRole?: string;
  confidence: number;
  evidence: string[];
}

export type EditRequestRejectionCode =
  | 'MAIN_PROMPT_REQUIRED'
  | 'MAIN_PROMPT_NOT_ALLOWED_WITH_CAPTURES'
  | 'MAIN_PROMPT_WITH_CAPTURES_MUST_BE_FEATURE_REQUEST'
  | 'SUPPLEMENTAL_PROMPT_TOO_VAGUE'
  | 'SUPPLEMENTAL_PROMPT_TARGET_REQUIRED'
  | 'CAPTURE_NOTE_REQUIRED'
  | 'CAPTURE_NOTE_TOO_VAGUE'
  | 'FOCUS_TARGET_ACTION_REQUIRED'
  | 'UNCLEAR_INTENT'
  | 'OUT_OF_SCOPE';

export interface ValidatedEditRequest {
  mode: EditRequestMode;
  request?: PipelineEditRequestDto;
  summary: EditRequestPreparationSummary;
  warnings: string[];
  needsInference: boolean;
}

export interface EditIntentDecision {
  accepted: boolean;
  mode: EditRequestMode;
  category: EditIntentCategory;
  editOperation?: EditOperation;
  request?: PipelineEditRequestDto;
  globalIntent: string;
  focusHint?: string;
  confidence?: number;
  source?: 'llm' | 'heuristic';
  warnings: string[];
  needsInference: boolean;
  targetScope: EditTargetScope;
  targetCandidates: EditIntentTargetCandidate[];
  inferredAssumptions: string[];
  ambiguities: string[];
  recommendedStrategy: EditExecutionStrategy;
  rejectionCode?: EditRequestRejectionCode;
  userMessage?: string;
}

export interface ResolvedEditRequestContext {
  accepted: boolean;
  mode: EditRequestMode;
  category: EditIntentCategory;
  editOperation?: EditOperation;
  request?: PipelineEditRequestDto;
  summary: EditRequestPreparationSummary;
  globalIntent: string;
  focusHint?: string;
  confidence?: number;
  source?: 'llm' | 'heuristic';
  warnings: string[];
  needsInference: boolean;
  targetScope: EditTargetScope;
  targetCandidates: EditIntentTargetCandidate[];
  inferredAssumptions: string[];
  ambiguities: string[];
  recommendedStrategy: EditExecutionStrategy;
}
