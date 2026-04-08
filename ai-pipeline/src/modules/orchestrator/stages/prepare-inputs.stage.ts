import type {
  OrchestratorStageRuntime,
  PipelineExecutionContext,
} from './pipeline-stage.types.js';

export class PrepareInputsStage {
  async run(
    context: PipelineExecutionContext,
    runtime: OrchestratorStageRuntime,
  ): Promise<PipelineExecutionContext> {
    const { dto, state, logPath, jobLogDir, jobId, themeGithubToken } = context;
    const { dbConnectionString, themeGithubUrl } = dto;

    await runtime.sqlService.verifyDirectCredentials(dbConnectionString);

    const repoResult = await runtime.runStep(
      state,
      '1_repo_analyzer',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '1_repo_analyzer',
          0.1,
          'Resolving the theme source input and preparing repository analysis.',
        );
        runtime.emitStepProgress(
          state,
          '1_repo_analyzer',
          0.35,
          'Cloning the WordPress theme repository from GitHub.',
        );
        const repoRoot = await runtime.cloneThemeRepo(
          themeGithubUrl,
          themeGithubToken,
          jobId,
        );
        runtime.emitStepProgress(
          state,
          '1_repo_analyzer',
          0.7,
          'Repository cloned. Resolving the active theme directory from WordPress data.',
        );
        const resolvedDir = await runtime.resolveThemeDir(
          repoRoot,
          dbConnectionString,
        );
        runtime.emitStepProgress(
          state,
          '1_repo_analyzer',
          0.9,
          'Scanning theme folders, templates, and structural entry points.',
        );
        const repoAnalysis = await runtime.repoAnalyzer.analyze(resolvedDir);
        await runtime.recordRepoAnalysis(jobLogDir, logPath, repoAnalysis);
        return repoAnalysis;
      },
    );
    const themeDir = repoResult.themeDir;
    await runtime.delayBetweenSteps();

    const parsedTheme = await runtime.runStep(
      state,
      '2_theme_parser',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '2_theme_parser',
          0.15,
          'Detecting whether the source theme is classic PHP or block-based FSE.',
        );
        const detection = await runtime.themeDetector.detect(themeDir);
        runtime.emitStepProgress(
          state,
          '2_theme_parser',
          0.55,
          detection.type === 'fse'
            ? 'Parsing block templates and template parts from the FSE theme.'
            : 'Parsing PHP templates, partials, and WordPress template hints from the classic theme.',
        );
        return detection.type === 'fse'
          ? runtime.blockParser.parse(themeDir)
          : runtime.phpParser.parse(themeDir);
      },
    );
    await runtime.delayBetweenSteps();

    let normalizedTheme = await runtime.runStep(
      state,
      '3_normalizer',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '3_normalizer',
          0.25,
          'Cleaning parsed template source and removing noisy markup before planning.',
        );
        const result = await runtime.normalizer.normalize(parsedTheme);
        runtime.emitStepProgress(
          state,
          '3_normalizer',
          0.8,
          'Normalized source is ready for route and component planning.',
        );
        return result;
      },
    );
    await runtime.delayBetweenSteps();

    const content = await runtime.runStep(
      state,
      '4_content_graph',
      logPath,
      async () => {
        runtime.emitStepProgress(
          state,
          '4_content_graph',
          0.15,
          'Querying WordPress tables for site info, pages, posts, menus, and taxonomies.',
        );
        const result = await runtime.dbContent.extract(dbConnectionString);
        runtime.emitStepProgress(
          state,
          '4_content_graph',
          0.75,
          'Combining runtime capabilities, plugin discovery, and extracted content into one content graph.',
        );
        return result;
      },
    );
    await runtime.delayBetweenSteps();

    const resolvedSource = await runtime.sourceResolver.resolve({
      manifest: repoResult.themeManifest,
      dbConnectionString,
      content,
    });
    repoResult.themeManifest.resolvedSource = resolvedSource;
    await runtime.recordRepoAnalysis(jobLogDir, logPath, repoResult);

    const enrichResult = await runtime.enrichThemeWithPluginTemplates({
      theme: normalizedTheme,
      themeDir,
      manifest: repoResult.themeManifest,
      resolvedSource,
      logPath,
    });
    normalizedTheme = enrichResult.theme;

    return {
      ...context,
      repoResult,
      themeDir,
      parsedTheme,
      normalizedTheme,
      content,
      resolvedSource,
    };
  }
}
