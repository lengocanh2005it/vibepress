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
  reactGenerator: {
    delayBetweenComponents: parseInt(
      process.env.REACT_GEN_DELAY_MS ?? '5000',
      10,
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
