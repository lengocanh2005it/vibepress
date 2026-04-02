export interface LlmChatParams {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  truncated?: boolean;
}

export type LlmProvider =
  | 'anthropic'
  | 'mistral'
  | 'groq'
  | 'cerebras'
  | 'gemini'
  | 'openai'
  | 'ollama'
  | 'custom';
