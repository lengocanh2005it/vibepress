export default () => ({
  port: process.env.PORT || '3001',
  aiProvider: process.env.AI_PROVIDER || 'mistral',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY,
    model: process.env.CEREBRAS_MODEL || 'llama3.3-70b',
  },
  mistral: {
    apiKey: process.env.MISTRAL_API_KEY,
    model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
    maxTokens: parseInt(process.env.MISTRAL_MAX_TOKENS ?? '16384', 10),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL || 'gpt-5.3-codex',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },
  ollama: {
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
  },
  custom: {
    baseURL: process.env.CUSTOM_BASE_URL || 'http://localhost:8000',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: process.env.CUSTOM_MODEL || 'default',
    maxTokens: parseInt(process.env.CUSTOM_MAX_TOKENS ?? '8192', 10),
  },
  reactGenerator: {
    delayBetweenComponents: parseInt(
      process.env.REACT_GEN_DELAY_MS ?? '1500',
      10,
    ),
    generationConcurrency: parseInt(
      process.env.REACT_GEN_CONCURRENCY ?? '2',
      10,
    ),
    sectionConcurrency: parseInt(
      process.env.REACT_GEN_SECTION_CONCURRENCY ?? '2',
      10,
    ),
  },
  planner: {
    agentEnabled: process.env.PLANNER_AGENT_ENABLED !== 'false',
    agentMaxRounds: parseInt(process.env.PLANNER_AGENT_MAX_ROUNDS ?? '6', 10),
    visualPlanConcurrency: parseInt(
      process.env.PLANNER_VISUAL_CONCURRENCY ?? '3',
      10,
    ),
    minimalVisualPlan: process.env.PLANNER_MINIMAL_VISUAL_PLAN === 'true',
    visualReferenceEnabled:
      process.env.PLANNER_VISUAL_REFERENCE_ENABLED !== 'false',
    visualWpBaseUrl: process.env.PLANNER_VISUAL_WP_BASE_URL,
    visualViewportWidth: parseInt(
      process.env.PLANNER_VISUAL_VIEWPORT_WIDTH ?? '1440',
      10,
    ),
    visualViewportHeight: parseInt(
      process.env.PLANNER_VISUAL_VIEWPORT_HEIGHT ?? '1400',
      10,
    ),
  },
  preview: {
    runtimeRouteDelayMs: parseInt(
      process.env.PREVIEW_RUNTIME_ROUTE_DELAY_MS ?? '400',
      10,
    ),
    runtimeServerReadyTimeoutMs: parseInt(
      process.env.PREVIEW_RUNTIME_READY_TIMEOUT_MS ?? '30000',
      10,
    ),
    wpAssetCopyConcurrency: parseInt(
      process.env.PREVIEW_WP_ASSET_COPY_CONCURRENCY ?? '6',
      10,
    ),
  },
  // Per-step model overrides — format: "provider/model" or plain model name.
  // Preferred env names:
  //   PLANNING_MODEL=mistral/mistral-large-latest
  //   GEN_CODE_MODEL=mistral/codestral-latest
  //   REVIEW_CODE_MODEL=mistral/codestral-latest
  //   AI_REVIEW_MODE=warn
  //   BACKEND_AI_REVIEW_MODE=warn
  // Backward-compatible aliases:
  //   PLANNER_MODEL, CODE_REVIEWER_MODEL, FIX_AGENT_MODEL
  pipeline: {
    planningModel:
      process.env.PLANNING_MODEL ??
      process.env.PLANNER_MODEL ??
      'openai/gpt-5.4',
    genCodeModel: process.env.GEN_CODE_MODEL ?? 'openai/gpt-5.3-codex',
    reviewCodeModel:
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      'openai/gpt-5.3-codex',
    backendReviewModel:
      process.env.BACKEND_REVIEW_MODEL ??
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      'openai/gpt-5.4',
    fixAgentModel:
      process.env.FIX_AGENT_MODEL ??
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      process.env.GEN_CODE_MODEL ??
      'openai/gpt-5.3-codex',
    aiReviewMode: process.env.AI_REVIEW_MODE ?? 'warn',
    backendAiReviewMode: process.env.BACKEND_AI_REVIEW_MODE ?? 'warn',
  },
  visualReview: {
    model:
      process.env.VISUAL_REVIEW_MODEL ??
      process.env.PLANNING_MODEL ??
      process.env.PLANNER_MODEL ??
      'openai/gpt-5.4',
    maxRoutes: parseInt(process.env.VISUAL_REVIEW_MAX_ROUTES ?? '4', 10),
    maxFixRounds: parseInt(process.env.VISUAL_REVIEW_MAX_FIX_ROUNDS ?? '1', 10),
    minCheapDiffScore: parseFloat(
      process.env.VISUAL_REVIEW_MIN_CHEAP_DIFF_SCORE ?? '0.18',
    ),
  },
  github: {
    wpRepoToken: process.env.GITHUB_WP_REPO_TOKEN,
    reactRepoToken: process.env.GITHUB_REACT_REPO_TOKEN,
  },
  automation: {
    url: process.env.AUTOMATION_URL,
  },
});
