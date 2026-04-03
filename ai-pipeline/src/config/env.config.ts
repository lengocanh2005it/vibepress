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
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
      process.env.REACT_GEN_DELAY_MS ?? '5000',
      10,
    ),
  },
  planner: {
    visualPlanConcurrency: parseInt(
      process.env.PLANNER_VISUAL_CONCURRENCY ?? '3',
      10,
    ),
    minimalVisualPlan: process.env.PLANNER_MINIMAL_VISUAL_PLAN === 'true',
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
      'mistral/mistral-large-latest',
    genCodeModel: process.env.GEN_CODE_MODEL ?? 'mistral/codestral-latest',
    reviewCodeModel:
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      'mistral/mistral-large-latest',
    backendReviewModel:
      process.env.BACKEND_REVIEW_MODEL ??
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      'mistral/mistral-large-latest',
    fixAgentModel:
      process.env.FIX_AGENT_MODEL ??
      process.env.REVIEW_CODE_MODEL ??
      process.env.CODE_REVIEWER_MODEL ??
      process.env.GEN_CODE_MODEL ??
      'mistral/codestral-latest',
    aiReviewMode: process.env.AI_REVIEW_MODE ?? 'warn',
    backendAiReviewMode: process.env.BACKEND_AI_REVIEW_MODE ?? 'warn',
  },
  github: {
    wpRepoToken: process.env.GITHUB_WP_REPO_TOKEN,
    reactRepoToken: process.env.GITHUB_REACT_REPO_TOKEN,
  },
  automation: {
    url: process.env.AUTOMATION_URL,
  },
});
