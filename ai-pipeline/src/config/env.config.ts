type SupportedLlmProfile = 'openai' | 'custom';

const OPENAI_CODE_MODEL = 'gpt-5.3-codex';
const OPENAI_REASONING_MODEL = 'gpt-5.4';
const CUSTOM_CODE_MODEL = 'Qwen/Qwen2.5-Coder-14B-Instruct';
const CUSTOM_REASONING_MODEL = 'DeepSeek-R1-14B';

const OPENAI_ALLOWED_MODELS = new Set([
  OPENAI_CODE_MODEL,
  OPENAI_REASONING_MODEL,
]);
const CUSTOM_ALLOWED_MODELS = new Set([
  CUSTOM_CODE_MODEL,
  CUSTOM_REASONING_MODEL,
]);

function withProvider(
  provider: SupportedLlmProfile,
  model: string,
): string {
  return `${provider}/${model}`;
}

function stripProviderPrefix(
  value: string,
  provider: SupportedLlmProfile,
): string {
  const prefix = `${provider}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function normalizeLlmProfile(value?: string): SupportedLlmProfile {
  return value?.trim().toLowerCase() === 'custom' ? 'custom' : 'openai';
}

function normalizeSupportedModel(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed.startsWith('openai/')) {
    const model = trimmed.slice('openai/'.length);
    if (OPENAI_ALLOWED_MODELS.has(model)) {
      return trimmed;
    }
  } else if (trimmed.startsWith('custom/')) {
    const model = trimmed.slice('custom/'.length);
    if (CUSTOM_ALLOWED_MODELS.has(model)) {
      return trimmed;
    }
  } else if (OPENAI_ALLOWED_MODELS.has(trimmed)) {
    return withProvider('openai', trimmed);
  } else if (CUSTOM_ALLOWED_MODELS.has(trimmed)) {
    return withProvider('custom', trimmed);
  }

  throw new Error(
    `Unsupported LLM model "${trimmed}". Supported models: openai/${OPENAI_CODE_MODEL}, openai/${OPENAI_REASONING_MODEL}, custom/${CUSTOM_CODE_MODEL}, custom/${CUSTOM_REASONING_MODEL}`,
  );
}

function buildLlmPreset(profile: SupportedLlmProfile): {
  provider: SupportedLlmProfile;
  providerModel: string;
  planningModel: string;
  genCodeModel: string;
  reviewCodeModel: string;
  backendReviewModel: string;
  fixAgentModel: string;
} {
  if (profile === 'custom') {
    return {
      provider: 'custom',
      providerModel: CUSTOM_CODE_MODEL,
      planningModel: withProvider('custom', CUSTOM_REASONING_MODEL),
      genCodeModel: withProvider('custom', CUSTOM_CODE_MODEL),
      reviewCodeModel: withProvider('custom', CUSTOM_REASONING_MODEL),
      backendReviewModel: withProvider('custom', CUSTOM_REASONING_MODEL),
      fixAgentModel: withProvider('custom', CUSTOM_CODE_MODEL),
    };
  }

  return {
    provider: 'openai',
    providerModel: OPENAI_CODE_MODEL,
    planningModel: withProvider('openai', OPENAI_REASONING_MODEL),
    genCodeModel: withProvider('openai', OPENAI_CODE_MODEL),
    reviewCodeModel: withProvider('openai', OPENAI_REASONING_MODEL),
    backendReviewModel: withProvider('openai', OPENAI_REASONING_MODEL),
    fixAgentModel: withProvider('openai', OPENAI_CODE_MODEL),
  };
}

export default () => {
  const llmProfile = normalizeLlmProfile(
    process.env.LLM_PROFILE ?? process.env.AI_PROVIDER,
  );
  const llmPreset = buildLlmPreset(llmProfile);

  return {
  port: process.env.PORT || '3001',
  aiProvider: llmPreset.provider,
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: stripProviderPrefix(
      normalizeSupportedModel(
        process.env.OPENAI_MODEL,
        withProvider('openai', OPENAI_CODE_MODEL),
      ),
      'openai',
    ),
  },
  custom: {
    baseURL: process.env.CUSTOM_BASE_URL || 'http://localhost:8000',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: stripProviderPrefix(
      normalizeSupportedModel(
        process.env.CUSTOM_MODEL,
        withProvider('custom', CUSTOM_CODE_MODEL),
      ),
      'custom',
    ),
    maxTokens: parseInt(process.env.CUSTOM_MAX_TOKENS ?? '8192', 10),
    chatCompletionsPath:
      process.env.CUSTOM_CHAT_COMPLETIONS_PATH || '/gateway/chat/completions',
    authHeader: process.env.CUSTOM_AUTH_HEADER || 'Authorization',
    authValuePrefix: process.env.CUSTOM_AUTH_VALUE_PREFIX || '',
  },
  llm: {
    profile: llmProfile,
    retry: {
      maxAttempts: parseInt(process.env.LLM_RETRY_MAX_ATTEMPTS ?? '3', 10),
      baseDelayMs: parseInt(process.env.LLM_RETRY_BASE_DELAY_MS ?? '1000', 10),
    },
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
  // Primary switch:
  //   LLM_PROFILE=openai -> planning/review use gpt-5.4, code/fix use gpt-5.3-codex
  //   LLM_PROFILE=custom -> planning/review use DeepSeek-R1-14B, code/fix use Qwen2.5-Coder-14B-Instruct
  // Optional per-step overrides still exist, but they are validated against the supported model allowlist.
  pipeline: {
    planningModel: normalizeSupportedModel(
      process.env.PLANNING_MODEL ?? process.env.PLANNER_MODEL,
      llmPreset.planningModel,
    ),
    genCodeModel: normalizeSupportedModel(
      process.env.GEN_CODE_MODEL,
      llmPreset.genCodeModel,
    ),
    reviewCodeModel: normalizeSupportedModel(
      process.env.REVIEW_CODE_MODEL ?? process.env.CODE_REVIEWER_MODEL,
      llmPreset.reviewCodeModel,
    ),
    backendReviewModel: normalizeSupportedModel(
      process.env.BACKEND_REVIEW_MODEL ??
        process.env.REVIEW_CODE_MODEL ??
        process.env.CODE_REVIEWER_MODEL,
      llmPreset.backendReviewModel,
    ),
    fixAgentModel: normalizeSupportedModel(
      process.env.FIX_AGENT_MODEL ??
        process.env.REVIEW_CODE_MODEL ??
        process.env.CODE_REVIEWER_MODEL ??
        process.env.GEN_CODE_MODEL,
      llmPreset.fixAgentModel,
    ),
    aiReviewMode: process.env.AI_REVIEW_MODE ?? 'warn',
    backendAiReviewMode: process.env.BACKEND_AI_REVIEW_MODE ?? 'warn',
  },
  github: {
    wpRepoToken: process.env.GITHUB_WP_REPO_TOKEN,
    reactRepoToken: process.env.GITHUB_REACT_REPO_TOKEN,
  },
  automation: {
    url: process.env.AUTOMATION_URL,
    previewPublicBaseUrl: process.env.PREVIEW_PUBLIC_BASE_URL?.replace(/\/$/, ''),
  },
  };
};
