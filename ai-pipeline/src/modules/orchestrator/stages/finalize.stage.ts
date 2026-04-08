import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';

export class FinalizeStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const { state, logPath, dbCreds, preview, metrics } = context;

    if (!preview) {
      throw new Error('FinalizeStage requires a built preview');
    }

    await runtime.runStep(state, '10_cleanup', logPath, () =>
      runtime.cleanup.cleanup(context.jobId),
    );
    await runtime.delayBetweenSteps();

    const totalElapsed = ((Date.now() - context.pipelineStart) / 1000).toFixed(
      1,
    );
    await runtime.runStep(state, '11_done', logPath, async () => {
      state.status = 'done';
      state.result = {
        previewDir: preview.previewDir,
        previewUrl: preview.previewUrl,
        dbCreds,
        visualRouteResults: context.visualRouteResults ?? [],
        metrics,
      };
      runtime.emitCompletion(state, {
        previewUrl: preview.previewUrl,
        metrics,
        totalElapsed,
      });
      return { success: true, previewUrl: preview.previewUrl, metrics };
    });
    await runtime.delayBetweenSteps();

    runtime.completeProgress(context.jobId);
    runtime.scheduleProgressCleanup(context.jobId);

    return {
      ...context,
      totalElapsed,
    };
  }
}
