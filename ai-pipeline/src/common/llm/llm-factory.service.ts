import { Inject, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
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
import { PipelineSignalRegistry } from './pipeline-signal.registry.js';

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: 'gpt-5.3-codex',
  custom: 'Qwen/Qwen2.5-Coder-14B-Instruct',
};

@Injectable()
export class LlmFactoryService {
  constructor(
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    @Inject(CUSTOM_CONFIG) private readonly customConfig: CustomConfig,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly signalRegistry: PipelineSignalRegistry,
  ) {}

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

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const signal = params.jobId
      ? this.signalRegistry.getSignal(params.jobId)
      : undefined;

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
        return this.chatOpenAI(resolvedParams, signal);
      case 'custom':
      default:
        return this.chatCustom(resolvedParams, signal);
    }
  }

  private async chatOpenAI(
    params: LlmChatParams,
    signal?: AbortSignal,
  ): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const response = await this.openai.chat.completions.create(
      {
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          ...(systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }]
            : []),
          { role: 'user' as const, content: userPrompt },
        ],
      },
      { signal },
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

  private async chatCustom(
    params: LlmChatParams,
    signal?: AbortSignal,
  ): Promise<LlmChatResult> {
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

    const response = await firstValueFrom(
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
          ...(signal ? { signal } : {}),
        },
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
