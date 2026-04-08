import axios from 'axios';
import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';
import type { VisualReviewResult } from '../../agents/preview-builder/visual-route-review.service.js';

export class VisualCompareStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const { state, logPath, content, preview, reviewResult, resolvedModels } =
      context;

    if (!content || !preview || !reviewResult) {
      throw new Error(
        'VisualCompareStage requires content, preview, and reviewed plan',
      );
    }

    let buildComponents = [...(context.buildComponents ?? [])];
    const visualResult = await runtime.runStep(
      state,
      '9_visual_compare',
      logPath,
      async () => {
        const wpBaseUrl = content.siteInfo.siteUrl || 'http://localhost:8000/';
        const reactBeUrl = preview.apiBaseUrl.replace(/\/api\/?$/, '');
        runtime.emitStepProgress(
          state,
          '9_visual_compare',
          0.15,
          'Capturing representative routes and running cheap visual diff gates before AI review.',
        );
        const maxVisualFixRounds =
          runtime.configService.get<number>('visualReview.maxFixRounds') ?? 1;

        let visualRouteResults: VisualReviewResult[] = [];
        for (let round = 1; round <= maxVisualFixRounds; round++) {
          visualRouteResults = await runtime.visualRouteReview.reviewRoutes({
            jobId: context.jobId,
            preview,
            wpBaseUrl,
            plan: reviewResult.plan,
            components: buildComponents,
            content,
            logPath,
            modelName: resolvedModels.planning,
          });

          const actionableResults = visualRouteResults.filter(
            (result) =>
              Array.isArray(result.issues) && result.issues.length > 0,
          );
          if (actionableResults.length === 0) {
            await runtime.logToFile(
              logPath,
              `[Stage 9] Visual route review round ${round}: no actionable issues`,
            );
            break;
          }

          runtime.emitStepProgress(
            state,
            '9_visual_compare',
            0.45,
            `Visual review round ${round}/${maxVisualFixRounds}: fixing ${actionableResults.length} route(s) with actionable UI drift.`,
          );

          const feedbackByComponent = new Map<string, string[]>();
          const routesToSmoke = new Set<string>();
          for (const result of actionableResults) {
            routesToSmoke.add(result.route);
            for (const issue of result.issues) {
              if (!feedbackByComponent.has(issue.componentName)) {
                feedbackByComponent.set(issue.componentName, []);
              }
              feedbackByComponent
                .get(issue.componentName)!
                .push(`[route ${result.route}] ${issue.feedback}`);
            }
          }

          let fixedCount = 0;
          for (const [componentName, feedbacks] of feedbackByComponent) {
            const idx = buildComponents.findIndex(
              (c) => c.name === componentName,
            );
            if (idx === -1) continue;
            buildComponents[idx] = await runtime.reactGenerator.fixComponent({
              component: buildComponents[idx],
              plan: reviewResult.plan,
              feedback: `Visual review feedback:\n${feedbacks.join('\n\n')}`,
              modelConfig: { fixAgent: resolvedModels.fixAgent },
              logPath,
            });
            fixedCount++;
          }

          if (fixedCount === 0) {
            await runtime.logToFile(
              logPath,
              `[Stage 9] Visual route review round ${round}: issues found but no matching components to fix`,
            );
            break;
          }

          await runtime.previewBuilder.syncGeneratedComponents(
            preview.previewDir,
            buildComponents,
          );
          await runtime.validator.assertPreviewBuild(preview.frontendDir);
          await runtime.validator.assertPreviewRuntime(preview.previewUrl, [
            ...routesToSmoke,
          ]);
        }

        runtime.emitStepProgress(
          state,
          '9_visual_compare',
          0.72,
          'Collecting final whole-site compare metrics after route-level visual fixes.',
        );

        let metrics: unknown = null;
        try {
          const response = await axios.post(
            `${runtime.configService.get<string>('automation.url', '')}/site/compare`,
            {
              wpBaseUrl,
              reactFeUrl: preview.previewUrl,
              reactBeUrl,
            },
          );
          metrics = response.data?.result ?? response.data;
        } catch (err: any) {
          runtime.logger.error(
            `[visual/compare] failed — ${err?.message ?? err}`,
            err?.response?.data ?? err?.stack,
          );
        }

        runtime.emitStepProgress(
          state,
          '9_visual_compare',
          0.85,
          metrics
            ? 'Route-level visual review finished and final compare metrics are attached.'
            : 'Route-level visual review finished without final compare metrics; pipeline will continue with cleanup.',
        );
        return { metrics, routeReviews: visualRouteResults };
      },
    );
    await runtime.delayBetweenSteps();

    return {
      ...context,
      buildComponents,
      metrics: visualResult.metrics,
      visualRouteResults: visualResult.routeReviews,
    };
  }
}
