import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import OpenAI from 'openai';
import { OPENAI_CLIENT } from '../providers/openai/openai.provider.js';
import {
  CUSTOM_CONFIG,
  type CustomConfig,
} from '../providers/custom/custom.provider.js';
import type {
  LlmChatParams,
  LlmChatResult,
  LlmProvider,
} from './llm.interface.js';

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-5.3-codex',
  custom: 'Qwen/Qwen2.5-Coder-14B-Instruct',
};

@Injectable()
export class LlmFactoryService {
  private readonly logger = new Logger(LlmFactoryService.name);
  private readonly maxRetryAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    @Inject(CUSTOM_CONFIG) private readonly customConfig: CustomConfig,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.maxRetryAttempts = Math.max(
      1,
      this.configService.get<number>('llm.retry.maxAttempts', 3),
    );
    this.retryBaseDelayMs = Math.max(
      100,
      this.configService.get<number>('llm.retry.baseDelayMs', 1000),
    );
  }

  getProvider(): LlmProvider {
    return this.configService.get<LlmProvider>('aiProvider', 'openai');
  }

  getModel(): string {
    const provider = this.getProvider();
    return this.configService.get<string>(
      `${provider}.model`,
      DEFAULT_MODELS[provider],
    );
  }

  getMaxTokens(): number {
    const provider = this.getProvider();
    return this.configService.get<number>(`${provider}.maxTokens`, 8192);
  }

  /**
   * Supported providers — used to parse the "provider/model" format.
   * e.g. "openai/gpt-5.4", "custom/Qwen/Qwen2.5-Coder-14B-Instruct"
   */
  private static readonly KNOWN_PROVIDERS = new Set<LlmProvider>([
    'openai',
    'custom',
  ]);

  private extractCachedTokens(usage: any): number | undefined {
    const cached =
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.input_tokens_details?.cache_read_input_tokens ??
      usage?.cache_creation_input_tokens ??
      usage?.cache_read_input_tokens ??
      usage?.cached_tokens;

    return typeof cached === 'number' ? cached : undefined;
  }

  private normalizeChatCompletionUrl(baseURL: string, path: string): string {
    const trimmedBase = baseURL.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${trimmedBase}${normalizedPath}`;
  }

  private extractTextContent(content: unknown): string | undefined {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    const text = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('')
      .trim();

    return text || undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getRetryDelayMs(attempt: number): number {
    const exponentialDelay = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 250);
    return exponentialDelay + jitter;
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (error instanceof AxiosError) {
      return error.response?.status;
    }

    if (error && typeof error === 'object') {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') {
        return status;
      }

      const nestedStatus = (error as { response?: { status?: unknown } }).response
        ?.status;
      if (typeof nestedStatus === 'number') {
        return nestedStatus;
      }
    }

    return undefined;
  }

  private getErrorCode(error: unknown): string | undefined {
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : undefined;
    }
    return undefined;
  }

  private isRetryableLlmError(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    if (status !== undefined && [408, 409, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    const code = this.getErrorCode(error);
    if (
      code &&
      [
        'ECONNABORTED',
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
      ].includes(code)
    ) {
      return true;
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('temporarily unavailable') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('connection reset') ||
      message.includes('bad gateway') ||
      message.includes('gateway timeout') ||
      message.includes('service unavailable')
    );
  }

  async runWithRetry<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableLlmError(error);
        const hasNextAttempt = attempt < this.maxRetryAttempts;

        if (!retryable || !hasNextAttempt) {
          throw error;
        }

        const delayMs = this.getRetryDelayMs(attempt);
        const status = this.getErrorStatus(error);
        const code = this.getErrorCode(error);
        const details = [
          status ? `status=${status}` : null,
          code ? `code=${code}` : null,
        ]
          .filter(Boolean)
          .join(', ');

        this.logger.warn(
          `[LLM Retry] ${label} failed on attempt ${attempt}/${this.maxRetryAttempts}${details ? ` (${details})` : ''}. Retrying in ${delayMs}ms.`,
        );
        await this.sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    let provider = this.getProvider();
    let model = params.model;

    // Parse "provider/model" format for per-call provider routing.
    // e.g. "openai/gpt-5.4" -> provider=openai, model=gpt-5.4
    //      "custom/DeepSeek-R1-14B" -> provider=custom, model=DeepSeek-R1-14B
    const slashIdx = model.indexOf('/');
    if (slashIdx !== -1) {
      const prefix = model.slice(0, slashIdx) as LlmProvider;
      if (LlmFactoryService.KNOWN_PROVIDERS.has(prefix)) {
        provider = prefix;
        model = model.slice(slashIdx + 1);
      }
    }

    const resolvedParams: LlmChatParams = {
      ...params,
      model,
      maxTokens: params.maxTokens ?? this.getMaxTokens(),
    };

    switch (provider) {
      case 'openai':
        return this.chatOpenAI(resolvedParams);
      case 'custom':
      default:
        return this.chatCustom(resolvedParams);
    }
  }

  private async chatOpenAI(params: LlmChatParams): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const response = await this.runWithRetry(`openai:${model}`, () =>
      this.openai.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          ...(systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }]
            : []),
          { role: 'user' as const, content: userPrompt },
        ],
      }),
    );

    const text = response.choices[0]?.message?.content;
    const finishReason = response.choices[0]?.finish_reason;
    if (!text) {
      throw new Error(
        `Empty response from ${model} (finish_reason: ${finishReason ?? 'unknown'})`,
      );
    }

    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cachedTokens: this.extractCachedTokens(response.usage),
      truncated: finishReason === 'length',
    };
  }

  private async chatCustom(params: LlmChatParams): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;
    const {
      baseURL,
      apiKey,
      chatCompletionsPath,
      authHeader,
      authValuePrefix,
    } = this.customConfig;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const trimmedApiKey = apiKey.trim();
    if (trimmedApiKey) {
      headers[authHeader] = `${authValuePrefix}${trimmedApiKey}`;
    }

    const response = await this.runWithRetry(`custom:${model}`, () =>
      firstValueFrom(
        this.httpService.post(
          this.normalizeChatCompletionUrl(baseURL, chatCompletionsPath),
          {
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [
              ...(systemPrompt
                ? [{ role: 'system', content: systemPrompt }]
                : []),
              { role: 'user', content: userPrompt },
            ],
          },
          {
            headers,
          },
        ),
      ),
    );

    const text =
      response.data?.text ??
      this.extractTextContent(response.data?.choices?.[0]?.message?.content);
    const inputTokens =
      response.data?.inputTokens ?? response.data?.usage?.prompt_tokens;
    const outputTokens =
      response.data?.outputTokens ?? response.data?.usage?.completion_tokens;
    const cachedTokens =
      response.data?.cachedTokens ??
      this.extractCachedTokens(response.data?.usage);
    const finishReason = response.data.choices?.[0]?.finish_reason;

    if (!text) {
      throw new Error(
        `Empty response from custom model ${model} (finish_reason: ${finishReason ?? 'unknown'})`,
      );
    }

    return {
      text,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cachedTokens: typeof cachedTokens === 'number' ? cachedTokens : undefined,
      truncated: finishReason === 'length',
    };
  }
}
