export interface LlmChatParams {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Optional pipeline job ID. When provided, the LlmFactoryService will
   *  automatically thread the job's AbortSignal so that stopping the pipeline
   *  immediately cancels any in-flight HTTP request to the LLM provider. */
  jobId?: string;
}

export interface LlmChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  truncated?: boolean;
}

export type LlmProvider = 'openai' | 'custom';
