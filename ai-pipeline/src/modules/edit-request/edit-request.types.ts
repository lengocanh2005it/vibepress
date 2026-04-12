import type {
  PipelineEditRequestDto,
  PipelineIncomingEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';

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
  | 'invalid';

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
}

export interface EditIntentDecision {
  accepted: boolean;
  mode: EditRequestMode;
  category: EditIntentCategory;
  request?: PipelineEditRequestDto;
  globalIntent: string;
  focusHint?: string;
  confidence?: number;
  source?: 'llm' | 'heuristic';
  rejectionCode?: EditRequestRejectionCode;
  userMessage?: string;
}

export interface ResolvedEditRequestContext {
  accepted: boolean;
  mode: EditRequestMode;
  category: EditIntentCategory;
  request?: PipelineEditRequestDto;
  summary: EditRequestPreparationSummary;
  globalIntent: string;
  focusHint?: string;
  confidence?: number;
  source?: 'llm' | 'heuristic';
}
