import type { PlanReviewResult } from '../../agents/plan-reviewer/plan-reviewer.service.js';
import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';

export class PlanningStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const {
      state,
      logPath,
      normalizedTheme,
      content,
      resolvedModels,
      jobId,
      repoResult,
    } = context;

    if (!normalizedTheme || !content || !repoResult) {
      throw new Error(
        'PlanningStage requires normalized theme, content, and repo analysis',
      );
    }

    const expectedTemplateNames =
      normalizedTheme.type === 'classic'
        ? normalizedTheme.templates.map((t) => t.name)
        : [...normalizedTheme.templates, ...normalizedTheme.parts].map(
            (t) => t.name,
          );

    const reviewResult = await runtime.runStep(
      state,
      '5_planner',
      logPath,
      async () => {
        if (runtime.configService.get<boolean>('planner.agentEnabled', true)) {
          try {
            runtime.emitStepProgress(
              state,
              '5_planner',
              0.08,
              'Planner agent is selecting tools for route mapping, consistency review, and visual section generation.',
            );
            const agentResult = await runtime.plannerAgentRuntime.run({
              normalizedTheme,
              content,
              repoManifest: repoResult.themeManifest,
              expectedTemplateNames,
              modelName: resolvedModels.planning,
              jobId,
              logPath,
              maxRounds:
                runtime.configService.get<number>('planner.agentMaxRounds') ??
                6,
            });

            runtime.emitStepProgress(
              state,
              '5_planner',
              0.92,
              `Planner agent completed ${agentResult.history.length} tool call(s) and locked the reviewed visual plan.`,
            );
            return agentResult.reviewResult;
          } catch (error: any) {
            runtime.logger.warn(
              `[${jobId}] [Stage 3: Planner Agent] failed: ${error?.message ?? error} — falling back to legacy planning loop`,
            );
            await runtime.logToFile(
              logPath,
              `[Stage 3: Planner Agent] fallback triggered: ${error?.message ?? error}`,
            );
          }
        }

        return this.runLegacyPlanning({
          context,
          runtime,
          expectedTemplateNames,
        });
      },
    );
    await runtime.delayBetweenSteps();

    return { ...context, reviewResult };
  }

  private async runLegacyPlanning(input: {
    context: PipelineExecutionContext;
    runtime: OrchestratorStageRuntime;
    expectedTemplateNames: string[];
  }): Promise<PlanReviewResult> {
    const { context, runtime, expectedTemplateNames } = input;
    const {
      state,
      normalizedTheme,
      content,
      resolvedModels,
      jobId,
      repoResult,
      logPath,
    } = context;

    if (!normalizedTheme || !content || !repoResult) {
      throw new Error(
        'Legacy planner requires normalized theme, content, and repo analysis',
      );
    }

    const maxPlanRetries = 3;
    runtime.emitStepProgress(
      state,
      '5_planner',
      0.08,
      'Building the first component architecture pass from normalized theme source and WordPress content.',
    );

    let plan = await runtime.planner.plan(
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
    runtime.emitStepProgress(
      state,
      '5_planner',
      0.4,
      `Initial architecture plan created for ${plan.length} component contract(s). Running consistency review before visual sections are generated.`,
    );

    let review = runtime.planReviewer.review(
      plan,
      expectedTemplateNames,
      repoResult.themeManifest,
    );

    for (
      let attempt = 2;
      attempt <= maxPlanRetries && !review.isValid;
      attempt++
    ) {
      runtime.logger.warn(
        `[${jobId}] [Stage 3: Phase D] Plan invalid (attempt ${attempt - 1}/${maxPlanRetries}): ${review.errors.join('; ')} — retrying Phases A→C`,
      );
      await runtime.logToFile(
        logPath,
        `[Stage 3: C6 Retry] attempt ${attempt}: ${review.errors.join('; ')}`,
      );
      runtime.emitStepProgress(
        state,
        '5_planner',
        0.35,
        `Planner retry ${attempt}/${maxPlanRetries}: rebuilding routes, data needs, and visual sections after review feedback.`,
      );

      plan = await runtime.planner.plan(
        normalizedTheme,
        content,
        resolvedModels.planning,
        jobId,
        {
          includeVisualPlans: false,
          logPath,
          repoManifest: repoResult.themeManifest,
          planReviewErrors: review.errors,
        },
      );
      review = runtime.planReviewer.review(
        plan,
        expectedTemplateNames,
        repoResult.themeManifest,
      );
      runtime.emitStepProgress(
        state,
        '5_planner',
        0.55,
        `Planner retry ${attempt}/${maxPlanRetries}: re-running consistency review on the regenerated architecture plan.`,
      );
    }

    if (!review.isValid) {
      throw new Error(
        `[Stage 3] Plan still invalid after ${maxPlanRetries} attempts: ${review.errors.join('; ')}`,
      );
    }

    runtime.emitStepProgress(
      state,
      '5_planner',
      0.72,
      'Architecture review passed. Generating visual sections from the reviewed route map and data contracts.',
    );

    const maxVisualRetries = 2;
    let planWithVisuals = await runtime.planner.attachVisualPlans(
      normalizedTheme,
      content,
      review.plan,
      resolvedModels.planning,
      repoResult.themeManifest,
    );
    let visualReview = runtime.planReviewer.review(
      planWithVisuals,
      expectedTemplateNames,
      repoResult.themeManifest,
    );
    for (
      let vAttempt = 2;
      vAttempt <= maxVisualRetries && !visualReview.isValid;
      vAttempt++
    ) {
      runtime.logger.warn(
        `[${jobId}] [Stage 3: Visual Plan] Review failed (attempt ${vAttempt - 1}/${maxVisualRetries}): ${visualReview.errors.join('; ')} — retrying attachVisualPlans`,
      );
      await runtime.logToFile(
        logPath,
        `[Stage 3: Visual Plan Retry] attempt ${vAttempt}: ${visualReview.errors.join('; ')}`,
      );
      runtime.emitStepProgress(
        state,
        '5_planner',
        0.82,
        `Visual plan retry ${vAttempt}/${maxVisualRetries}: regenerating visual sections after consistency check failed.`,
      );
      planWithVisuals = await runtime.planner.attachVisualPlans(
        normalizedTheme,
        content,
        review.plan,
        resolvedModels.planning,
        repoResult.themeManifest,
      );
      visualReview = runtime.planReviewer.review(
        planWithVisuals,
        expectedTemplateNames,
        repoResult.themeManifest,
      );
    }

    if (!visualReview.isValid) {
      throw new Error(
        `[Stage 3] Visual-plan synchronization failed after ${maxVisualRetries} attempts: ${visualReview.errors.join('; ')}`,
      );
    }

    runtime.emitStepProgress(
      state,
      '5_planner',
      0.92,
      'Planner review passed. Route map, data contracts, and visual sections are locked in.',
    );
    return visualReview;
  }
}
