import { Injectable, Logger } from '@nestjs/common';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { ReplaySubject } from 'rxjs';
import type { PreviewBuilderResult } from '../agents/preview-builder/preview-builder.service.js';
import { CleanupService } from '../agents/cleanup/cleanup.service.js';
import type { VisualMismatchDiagnosis } from '../site-compare/visual-diagnosis.types.js';
import {
  PendingEditApprovalGate,
  type PendingEditDecision,
  type PipelineStatus,
  PipelineControlError,
  type ProgressEvent,
  type ProgressEventData,
} from './orchestrator.runtime.types.js';

const STEP_META: Record<
  string,
  {
    label: string;
    weight: number;
    activeMessage: string;
    doneMessage: string;
  }
> = {
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
  '4_content_graph': {
    label: 'Extract WordPress Content Model',
    weight: 10,
    activeMessage:
      'Querying WordPress for posts, pages, menus, taxonomies, plugins, and runtime capabilities.',
    doneMessage:
      'WordPress content model and runtime capability graph are ready.',
  },
  '5_planner': {
    label: 'Plan Routes, Data, And Visual Sections',
    weight: 40,
    activeMessage:
      'Building the component graph, route map, data contracts, and approved visual sections for each template.',
    doneMessage: 'Component architecture, routes, and visual plans are ready.',
  },
  '6_generator': {
    label: 'Generate And Repair React Components',
    weight: 30,
    activeMessage:
      'Generating React components, validating contracts, reviewing output, and repairing invalid code when needed.',
    doneMessage:
      'React components have been generated, reviewed, and validated.',
  },
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
      'Waiting for approval, then applying the submitted edit request after baseline compare has finished.',
    doneMessage:
      'The requested user edits have been applied to the generated React preview.',
  },
  '9b_post_edit_visual_validation': {
    label: 'Validate Edited Preview',
    weight: 2,
    activeMessage:
      'Re-running compare artifacts for the edited preview and validating that the approved user edit landed without causing unrelated regressions.',
    doneMessage:
      'Edited preview validation has finished and the post-edit diagnostics are ready.',
  },
  '9_visual_compare': {
    label: 'Evaluate Baseline Compare Metrics',
    weight: 2,
    activeMessage:
      'Running site compare across the WordPress site and the baseline React preview before any user edit request is applied.',
    doneMessage: 'Baseline site-compare metrics have been collected.',
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

export interface RuntimeControlLike {
  stopRequested: boolean;
  deleteRequested: boolean;
  finalized: boolean;
  hasEditRequest?: boolean;
  confirmationGate?: PendingEditApprovalGate;
  preview?: Pick<PreviewBuilderResult, 'frontendPid' | 'serverPid'>;
}

interface RuntimeStores {
  jobs: Map<string, PipelineStatus>;
  progress: Map<string, ReplaySubject<ProgressEvent>>;
  controls: Map<string, RuntimeControlLike>;
  stepEventData: Map<string, Map<string, ProgressEventData>>;
}

@Injectable()
export class OrchestratorRuntimeSupportService {
  private readonly logger = new Logger(OrchestratorRuntimeSupportService.name);
  private readonly visualDiagnosisArtifactCounters = new Map<string, number>();
  private shutdownBroadcasted = false;

  constructor(private readonly cleanup: CleanupService) {}

  getProgressStream(
    jobId: string,
    progress: Map<string, ReplaySubject<ProgressEvent>>,
  ): ReplaySubject<ProgressEvent> {
    if (!progress.has(jobId)) {
      progress.set(jobId, new ReplaySubject<ProgressEvent>(100));
    }
    return progress.get(jobId)!;
  }

  createPendingEditApprovalGate(): PendingEditApprovalGate {
    let resolve!: (decision: PendingEditDecision) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<PendingEditDecision>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  getStepMeta(
    name: string,
    jobId: string | undefined,
    controls: Map<string, RuntimeControlLike>,
  ) {
    const baseMeta = STEP_META[name] ?? {
      label: name,
      weight: 1,
      activeMessage: `AI agent is working on ${name}.`,
      doneMessage: `${name} has completed.`,
    };

    const hasEditRequest = jobId
      ? Boolean(controls.get(jobId)?.hasEditRequest)
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
      return {
        ...baseMeta,
        label: 'Evaluate Baseline Preview Metrics',
        activeMessage:
          'Running site compare for the baseline React preview against WordPress before any pending edit request is applied.',
        doneMessage:
          'Baseline compare metrics for the React preview have been collected.',
      };
    }

    if (name === '9b_post_edit_visual_validation') {
      return {
        ...baseMeta,
        label: 'Validate Edited Preview',
        activeMessage:
          'Re-checking the edited preview after the approved user request, with the edit intent treated as primary and WordPress as secondary reference.',
        doneMessage:
          'Edited preview validation is complete and any post-edit issues have been summarized.',
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

  getStepOrder(
    jobId: string | undefined,
    jobs: Map<string, PipelineStatus>,
  ): string[] {
    const state = jobId ? jobs.get(jobId) : undefined;
    if (state?.steps?.length) {
      return state.steps.map((step) => step.name);
    }
    return Object.keys(STEP_META);
  }

  getTotalWeight(
    jobId: string | undefined,
    stores: Pick<RuntimeStores, 'jobs' | 'controls'>,
  ): number {
    return this.getStepOrder(jobId, stores.jobs).reduce(
      (sum, stepName) =>
        sum + (this.getStepMeta(stepName, jobId, stores.controls).weight ?? 0),
      0,
    );
  }

  calcPercentBefore(
    name: string,
    jobId: string | undefined,
    stores: Pick<RuntimeStores, 'jobs' | 'controls'>,
  ): number {
    const stepOrder = this.getStepOrder(jobId, stores.jobs);
    const totalWeight = this.getTotalWeight(jobId, stores);
    let done = 0;
    for (const stepName of stepOrder) {
      if (stepName === name) break;
      done += this.getStepMeta(stepName, jobId, stores.controls).weight ?? 0;
    }
    return totalWeight > 0 ? Math.round((done / totalWeight) * 100) : 0;
  }

  calcPercentThrough(
    name: string,
    jobId: string | undefined,
    stores: Pick<RuntimeStores, 'jobs' | 'controls'>,
  ): number {
    const stepOrder = this.getStepOrder(jobId, stores.jobs);
    const totalWeight = this.getTotalWeight(jobId, stores);
    let done = 0;
    for (const stepName of stepOrder) {
      done += this.getStepMeta(stepName, jobId, stores.controls).weight ?? 0;
      if (stepName === name) break;
    }
    return totalWeight > 0 ? Math.round((done / totalWeight) * 100) : 0;
  }

  emitStepProgress(input: {
    state: PipelineStatus;
    name: string;
    progressWithinStep: number;
    message: string;
    data?: ProgressEventData;
    stores: RuntimeStores;
  }): void {
    const { state, name, progressWithinStep, message, data, stores } = input;
    this.assertJobActive(state.jobId, stores.controls);
    this.rememberStepEventData(state.jobId, name, data, stores.stepEventData);

    const meta = this.getStepMeta(name, state.jobId, stores.controls);
    const subject = stores.progress.get(state.jobId);
    const bounded = Math.min(Math.max(progressWithinStep, 0), 0.99);
    const stepOrder = this.getStepOrder(state.jobId, stores.jobs);
    const totalWeight = this.getTotalWeight(state.jobId, stores);
    const beforeWeight = stepOrder
      .slice(0, Math.max(stepOrder.indexOf(name), 0))
      .reduce(
        (sum, stepName) =>
          sum +
          (this.getStepMeta(stepName, state.jobId, stores.controls).weight ??
            0),
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

  assertJobActive(
    jobId: string,
    controls: Map<string, RuntimeControlLike>,
  ): void {
    const control = controls.get(jobId);
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

  rememberStepEventData(
    jobId: string,
    stepName: string,
    data: ProgressEventData | undefined,
    stepEventData: Map<string, Map<string, ProgressEventData>>,
  ): void {
    if (!data) return;
    const existing =
      stepEventData.get(jobId) ?? new Map<string, ProgressEventData>();
    const previous = existing.get(stepName);
    existing.set(stepName, previous ? { ...previous, ...data } : data);
    stepEventData.set(jobId, existing);
  }

  getStepEventData(
    jobId: string,
    stepName: string,
    stepEventData: Map<string, Map<string, ProgressEventData>>,
  ): ProgressEventData | undefined {
    return stepEventData.get(jobId)?.get(stepName);
  }

  clearStepEventData(
    jobId: string,
    stepEventData: Map<string, Map<string, ProgressEventData>>,
  ): void {
    stepEventData.delete(jobId);
  }

  async delayWithControl(
    jobId: string,
    ms: number,
    controls: Map<string, RuntimeControlLike>,
  ): Promise<void> {
    const intervalMs = 100;
    let remaining = ms;
    while (remaining > 0) {
      this.assertJobActive(jobId, controls);
      const slice = Math.min(intervalMs, remaining);
      await new Promise((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
  }

  async stopPreviewProcesses(
    preview?: Pick<PreviewBuilderResult, 'frontendPid' | 'serverPid'>,
  ): Promise<void> {
    if (!preview) return;
    await Promise.all([
      this.cleanup.terminateProcessTree(preview.frontendPid),
      this.cleanup.terminateProcessTree(preview.serverPid),
    ]);
  }

  async broadcastUnexpectedShutdown(
    signal: string | undefined,
    stores: RuntimeStores,
  ): Promise<void> {
    if (this.shutdownBroadcasted) return;

    const activeJobs = [...stores.jobs.entries()].filter(([, state]) =>
      this.isActivePipelineStatus(state.status),
    );
    if (activeJobs.length === 0) {
      this.shutdownBroadcasted = true;
      return;
    }

    this.shutdownBroadcasted = true;
    const shutdownSource = signal?.trim() || 'server shutdown';
    const message = `AI pipeline server was interrupted (${shutdownSource}). The running workflow was stopped.`;

    this.logger.warn(
      `[shutdown] Interrupting ${activeJobs.length} active pipeline job(s) because of ${shutdownSource}.`,
    );

    await Promise.allSettled(
      activeJobs.map(([jobId, state]) =>
        this.interruptJobForShutdown(jobId, state, message, stores),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async finalizeControlledTermination(
    jobId: string,
    state: PipelineStatus,
    err: PipelineControlError,
    stores: RuntimeStores,
  ): Promise<void> {
    const control = stores.controls.get(jobId);
    if (control?.finalized) return;
    if (control) control.finalized = true;

    await this.stopPreviewProcesses(control?.preview);

    const subject = stores.progress.get(jobId);
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
      stores.jobs.delete(jobId);
      stores.controls.delete(jobId);
      stores.progress.delete(jobId);
      this.clearStepEventData(jobId, stores.stepEventData);
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
    this.clearStepEventData(jobId, stores.stepEventData);
  }

  resolveTextLogPath(logPath: string): string | null {
    if (!logPath) return null;
    return logPath.endsWith('.json')
      ? logPath.replace(/\.json$/i, '.log')
      : logPath;
  }

  async logToFile(logPath: string, message: string): Promise<void> {
    const targetPath = this.resolveTextLogPath(logPath);
    await this.appendTimestampedLog(targetPath, message);
  }

  async logVisualMetricsTrace(logPath: string, message: string): Promise<void> {
    const targetPath = this.resolveSiblingLogPath(
      logPath,
      'visual-metrics.trace.log',
    );
    await this.appendTimestampedLog(targetPath, message);
  }

  async logVisualCompareControlTrace(
    logPath: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!logPath) return;
    await this.logVisualMetricsTrace(
      logPath,
      `[Visual Metrics Control] ${JSON.stringify(payload)}`,
    );
  }

  async writeVisualDiagnosisArtifacts(
    logPath: string,
    componentName: string,
    diagnosis: VisualMismatchDiagnosis,
  ): Promise<void> {
    const artifactDir = this.resolveSiblingLogPath(logPath, 'visual-diagnosis');
    if (!artifactDir || !diagnosis.debugTrace) return;

    const { debugTrace } = diagnosis;
    const attempt = this.nextVisualDiagnosisArtifactAttempt(
      logPath,
      componentName,
    );
    const baseName = `${this.sanitizeArtifactFileSegment(componentName)}-attempt-${attempt}`;

    try {
      await mkdir(artifactDir, { recursive: true });
      if (debugTrace.rawModelResponse) {
        await writeFile(
          join(artifactDir, `${baseName}.raw.txt`),
          `${debugTrace.rawModelResponse.trim()}\n`,
          'utf-8',
        );
      }
      if (debugTrace.extractedJson) {
        await writeFile(
          join(artifactDir, `${baseName}.extracted.json`),
          `${debugTrace.extractedJson.trim()}\n`,
          'utf-8',
        );
      }
      if (debugTrace.parsedDiagnosisJson) {
        await writeFile(
          join(artifactDir, `${baseName}.parsed.json`),
          `${debugTrace.parsedDiagnosisJson.trim()}\n`,
          'utf-8',
        );
      }
      if (debugTrace.mergedDiagnosisJson) {
        await writeFile(
          join(artifactDir, `${baseName}.merged.json`),
          `${debugTrace.mergedDiagnosisJson.trim()}\n`,
          'utf-8',
        );
      }
      await writeFile(
        join(artifactDir, `${baseName}.meta.json`),
        `${JSON.stringify(
          {
            componentName,
            route: diagnosis.route ?? null,
            routeKey: diagnosis.routeKey ?? null,
            analysisMode: diagnosis.analysisMode ?? null,
            debugSource: debugTrace.source,
            parseFailed: debugTrace.parseFailed === true,
          },
          null,
          2,
        )}\n`,
        'utf-8',
      );
    } catch (error) {
      this.logger.warn(
        `[Visual Diagnose Debug] Failed to write diagnosis artifacts for "${componentName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveSiblingLogPath(
    logPath: string,
    filename: string,
  ): string | null {
    const targetPath = this.resolveTextLogPath(logPath);
    if (!targetPath) return null;
    return join(targetPath, '..', filename);
  }

  private isActivePipelineStatus(status: PipelineStatus['status']): boolean {
    return (
      status === 'running' ||
      status === 'awaiting_confirmation' ||
      status === 'stopping'
    );
  }

  private async interruptJobForShutdown(
    jobId: string,
    state: PipelineStatus,
    message: string,
    stores: RuntimeStores,
  ): Promise<void> {
    const control = stores.controls.get(jobId);
    if (control?.finalized) return;

    if (control) {
      control.stopRequested = true;
      control.confirmationGate?.reject(
        new PipelineControlError('stopped', message),
      );
      control.confirmationGate = undefined;
      control.finalized = true;
    }

    state.status = 'stopped';
    state.error = message;
    for (const step of state.steps) {
      if (step.status === 'running') {
        step.status = 'stopped';
        step.error = message;
      }
    }

    const subject = stores.progress.get(jobId);
    subject?.next({
      step: 'system',
      label: 'Pipeline Interrupted',
      status: 'stopped',
      percent: this.calcInterruptedPercent(state, stores),
      message,
    });
    subject?.complete();

    await this.stopPreviewProcesses(control?.preview);
    this.clearStepEventData(jobId, stores.stepEventData);
  }

  private calcInterruptedPercent(
    state: PipelineStatus,
    stores: Pick<RuntimeStores, 'jobs' | 'controls'>,
  ): number {
    const interruptedStep = state.steps.find(
      (step) => step.status === 'running' || step.status === 'stopped',
    );
    if (interruptedStep) {
      return this.calcPercentBefore(interruptedStep.name, state.jobId, stores);
    }

    const completedSteps = state.steps.filter((step) => step.status === 'done');
    const lastCompletedStep = completedSteps[completedSteps.length - 1];
    if (lastCompletedStep) {
      return this.calcPercentThrough(
        lastCompletedStep.name,
        state.jobId,
        stores,
      );
    }

    return 0;
  }

  private sanitizeArtifactFileSegment(value: string): string {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
    const collapsed = normalized.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return collapsed || 'component';
  }

  private nextVisualDiagnosisArtifactAttempt(
    logPath: string,
    componentName: string,
  ): number {
    const artifactDir =
      this.resolveSiblingLogPath(logPath, 'visual-diagnosis') ??
      'visual-diagnosis';
    const key = `${artifactDir}::${componentName}`;
    const next = (this.visualDiagnosisArtifactCounters.get(key) ?? 0) + 1;
    this.visualDiagnosisArtifactCounters.set(key, next);
    return next;
  }

  private async appendTimestampedLog(
    targetPath: string | null,
    message: string,
  ): Promise<void> {
    if (!targetPath) return;
    const timestamp = new Date().toISOString();
    const payload = message
      .split(/\r?\n/)
      .map((line) => `[${timestamp}] ${line}`)
      .join('\n');

    try {
      await appendFile(targetPath, `${payload}\n`, 'utf-8');
    } catch (error) {
      this.logger.warn(
        `[logToFile] Failed to append pipeline log "${targetPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
