import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';

export class PreviewAssemblyStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const {
      state,
      logPath,
      content,
      reviewResult,
      resolvedModels,
      dbCreds,
      themeDir,
      normalizedTheme,
      generationResult,
    } = context;

    if (
      !content ||
      !reviewResult ||
      !dbCreds ||
      !generationResult ||
      !normalizedTheme
    ) {
      throw new Error(
        'PreviewAssemblyStage requires content, plan review, credentials, generated components, and normalized theme',
      );
    }

    await runtime.runStep(state, '7_api_builder', logPath, async () => {
      runtime.emitStepProgress(
        state,
        '7_api_builder',
        0.15,
        'Building the Express preview API template and injecting required routes.',
      );
      let api = await runtime.apiBuilder.build({
        jobId: context.jobId,
        dbName: dbCreds.dbName,
        logPath,
        content,
      });
      runtime.emitStepProgress(
        state,
        '7_api_builder',
        0.55,
        'Running backend review to verify API coverage matches the generated frontend contracts.',
      );

      const maxFixAttempts = 2;
      for (let attempt = 1; attempt <= maxFixAttempts; attempt++) {
        runtime.logger.log(
          `[Stage 6: AI Generated Backend Review] Reviewing ${api.files.length} backend file(s) (attempt ${attempt}/${maxFixAttempts})`,
        );
        const review = await runtime.generatedApiReview.review({
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

        runtime.logger.warn(
          `[Stage 6: AI Generated Backend Review] Backend failed review: ${review.blockingMessage}. Attempting auto-fix.`,
        );
        runtime.emitStepProgress(
          state,
          '7_api_builder',
          0.78,
          `Backend auto-fix ${attempt}/${maxFixAttempts}: repairing generated API code from review feedback.`,
        );
        await runtime.logToFile(
          logPath,
          `[Stage 6] Backend failed review: ${review.blockingMessage}. Attempting auto-fix loop (attempt ${attempt}/${maxFixAttempts})`,
        );

        api = await runtime.apiBuilder.fixApi({
          result: api,
          feedback: review.blockingMessage,
          modelName: resolvedModels.fixAgent,
          logPath,
        });
      }

      runtime.emitStepProgress(
        state,
        '7_api_builder',
        0.93,
        'Preview API layer is ready for the runtime preview environment.',
      );
      return api;
    });
    await runtime.delayBetweenSteps();

    let buildComponents = [
      ...(context.buildComponents ?? generationResult.components),
    ];
    const maxBuildFixAttempts = 2;
    const preview = await runtime.runStep(
      state,
      '8_preview_builder',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '8_preview_builder',
          0.08,
          'Copying the React preview template, writing generated pages, and preparing environment files.',
        );
        for (let attempt = 1; attempt <= maxBuildFixAttempts + 1; attempt++) {
          try {
            runtime.emitStepProgress(
              state,
              '8_preview_builder',
              0.38,
              `Preview build attempt ${attempt}/${maxBuildFixAttempts + 1}: installing dependencies, building, and starting dev servers.`,
            );
            return await runtime.previewBuilder.build({
              jobId: context.jobId,
              components: {
                ...generationResult,
                components: buildComponents,
              },
              dbCreds,
              themeDir,
              tokens: normalizedTheme.tokens,
              plan: reviewResult.plan,
            });
          } catch (err: any) {
            const errMsg: string = err?.message ?? String(err);
            const isBuildFail = errMsg.includes(
              '[validator] Preview build failed:',
            );
            if (!isBuildFail || attempt > maxBuildFixAttempts) throw err;

            const tsErrors = runtime.parseTsBuildErrors(errMsg);
            if (tsErrors.length === 0) throw err;

            runtime.logger.warn(
              `[Stage 8: Build Fix] ${tsErrors.length} TS error(s). Attempting auto-fix (attempt ${attempt}/${maxBuildFixAttempts}).`,
            );
            runtime.emitStepProgress(
              state,
              '8_preview_builder',
              0.7,
              `Preview build fix ${attempt}/${maxBuildFixAttempts}: repairing ${tsErrors.length} TypeScript build issue(s).`,
            );
            await runtime.logToFile(
              logPath,
              `[Stage 8] Build failed with ${tsErrors.length} TS error(s). Attempting auto-fix (attempt ${attempt}/${maxBuildFixAttempts})`,
            );

            const buildFixes = await Promise.all(
              tsErrors.map(async ({ componentName, error }) => {
                const idx = buildComponents.findIndex(
                  (c) => c.name === componentName,
                );
                if (idx === -1) return null;
                const fixed = await runtime.reactGenerator.fixComponent({
                  component: buildComponents[idx],
                  plan: reviewResult.plan,
                  feedback: `TypeScript build error:\n${error}`,
                  modelConfig: { fixAgent: resolvedModels.fixAgent },
                  logPath,
                });
                return { idx, fixed };
              }),
            );
            for (const result of buildFixes) {
              if (result) buildComponents[result.idx] = result.fixed;
            }
          }
        }

        throw new Error('[Stage 8] Build fix-loop exhausted all attempts');
      },
    );
    await runtime.delayBetweenSteps();

    return {
      ...context,
      buildComponents,
      preview,
    };
  }
}
