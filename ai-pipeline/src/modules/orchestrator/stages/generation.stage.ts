import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';

export class GenerationStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const {
      state,
      logPath,
      normalizedTheme,
      content,
      reviewResult,
      repoResult,
      jobId,
      resolvedModels,
    } = context;

    if (!normalizedTheme || !content || !reviewResult || !repoResult) {
      throw new Error(
        'GenerationStage requires normalized theme, content, plan review, and repo analysis',
      );
    }

    const generationResult = await runtime.runStep(
      state,
      '6_generator',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '6_generator',
          0.08,
          'Generating React components from the approved visual plans.',
        );

        const result = await runtime.reactGenerator.generate({
          theme: normalizedTheme,
          content,
          plan: reviewResult.plan,
          repoManifest: repoResult.themeManifest,
          jobId,
          logPath,
          modelConfig: {
            codeGenerator: resolvedModels.genCode,
            reviewCode: resolvedModels.reviewCode,
            fixAgent: resolvedModels.fixAgent,
          },
        });

        runtime.logger.log(
          `[Stage 4: D4 Validator] Validating & cleaning ${result.components.length} components`,
        );
        runtime.emitStepProgress(
          state,
          '6_generator',
          0.45,
          `Generated ${result.components.length} component file(s). Running validator cleanup and contract checks.`,
        );
        let components = runtime.validator.validate(result.components);

        const aiComponents = components.filter(
          (c) => c.generationMode !== 'deterministic',
        );
        const deterministicNames = components
          .filter((c) => c.generationMode === 'deterministic')
          .map((c) => c.name);
        if (deterministicNames.length > 0) {
          runtime.logger.log(
            `[Stage 5: AI Generated Code Review] Skipping ${deterministicNames.length} deterministic component(s): ${deterministicNames.join(', ')}`,
          );
        }

        const maxFixAttempts = 2;
        for (let attempt = 1; attempt <= maxFixAttempts; attempt++) {
          runtime.emitStepProgress(
            state,
            '6_generator',
            0.65,
            `AI review pass ${attempt}/${maxFixAttempts}: checking generated components against the approved contract.`,
          );
          runtime.logger.log(
            `[Stage 5: AI Generated Code Review] Reviewing ${aiComponents.length} components (attempt ${attempt}/${maxFixAttempts})`,
          );
          const review = await runtime.generatedCodeReview.review({
            components: aiComponents,
            plan: reviewResult.plan,
            modelName: resolvedModels.reviewCode,
            mode: resolvedModels.aiReviewMode,
            logPath,
          });

          if (review.success || review.failures.length === 0) {
            break;
          }

          runtime.logger.warn(
            `[Stage 5: AI Generated Code Review] ${review.failures.length} components failed review. Attempting auto-fix.`,
          );
          runtime.emitStepProgress(
            state,
            '6_generator',
            0.82,
            `Auto-fixing ${review.failures.length} component(s) that failed AI review.`,
          );
          await runtime.logToFile(
            logPath,
            `[Stage 5] ${review.failures.length} components failed review. Attempting auto-fix loop (attempt ${attempt}/${maxFixAttempts})`,
          );

          const fixResults = await Promise.all(
            review.failures.map(async (failure) => {
              const compIndex = aiComponents.findIndex(
                (c) => c.name === failure.componentName,
              );
              if (compIndex === -1) return null;
              const fixed = await runtime.reactGenerator.fixComponent({
                component: aiComponents[compIndex],
                plan: reviewResult.plan,
                feedback: failure.message,
                modelConfig: { fixAgent: resolvedModels.fixAgent },
                logPath,
              });
              try {
                const revalidated = runtime.validator.validate([fixed]);
                return { compIndex, component: revalidated[0] };
              } catch (validationErr: any) {
                runtime.logger.warn(
                  `[Stage 5: Fix Loop] Re-validation failed for "${failure.componentName}" after fix — keeping original. Error: ${validationErr?.message}`,
                );
                await runtime.logToFile(
                  logPath,
                  `[Stage 5] Re-validation failed for "${failure.componentName}": ${validationErr?.message}`,
                );
                return null;
              }
            }),
          );
          for (const result of fixResults) {
            if (result) aiComponents[result.compIndex] = result.component;
          }
        }

        for (const fixed of aiComponents) {
          const idx = components.findIndex((c) => c.name === fixed.name);
          if (idx !== -1) components[idx] = fixed;
        }

        runtime.emitStepProgress(
          state,
          '6_generator',
          0.94,
          'React generation, validation, and repair loops have finished successfully.',
        );
        return { ...result, components };
      },
    );
    await runtime.delayBetweenSteps();

    return {
      ...context,
      generationResult,
      buildComponents: generationResult.components,
    };
  }
}
