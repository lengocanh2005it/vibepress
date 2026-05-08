import type { SiteCompareMetrics } from '../site-compare/site-compare.types.js';

export interface ProgressEvent {
  step: string;
  label: string;
  status: PipelineStepStatus;
  percent: number;
  message?: string;
  data?: ProgressEventData;
}

export interface ProgressEventData {
  previewUrl?: string;
  apiBaseUrl?: string;
  previewStage?: 'baseline' | 'edited' | 'final';
  hasEditRequest?: boolean;
  editApprovalRequired?: boolean;
  editApplied?: boolean;
  runtimeEditMode?: 'runtime-override';
  runtimeEditRoute?: string;
  runtimeEditPatchCount?: number;
  stepDetails?: ProgressStepDetails;
  metrics?: SiteCompareMetrics;
}

export interface ProgressStepCapturePreview {
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

export interface ProgressStepDetails {
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

export interface PendingEditDecision {
  action: 'apply' | 'skip';
}

export interface PendingEditApprovalGate {
  promise: Promise<PendingEditDecision>;
  resolve: (decision: PendingEditDecision) => void;
  reject: (reason?: unknown) => void;
}

export class PipelineControlError extends Error {
  constructor(
    public readonly kind: 'stopped' | 'deleted',
    message: string,
  ) {
    super(message);
  }
}

export class PipelineStepSkipError<T = unknown> extends Error {
  constructor(
    message: string,
    public readonly data?: T,
  ) {
    super(message);
  }
}
