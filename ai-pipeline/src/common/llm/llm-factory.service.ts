import { Inject, Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Ollama } from 'ollama';
import { ANTHROPIC_CLIENT } from '../providers/anthropic/anthropic.provider.js';
import { MISTRAL_CLIENT } from '../providers/mistral/mistral.provider.js';
import { GROQ_CLIENT } from '../providers/groq/groq.provider.js';
import { CEREBRAS_CLIENT } from '../providers/cerebras/cerebras.provider.js';
import { GEMINI_CLIENT } from '../providers/gemini/gemini.provider.js';
import { OPENAI_CLIENT } from '../providers/openai/openai.provider.js';
import { OLLAMA_CLIENT } from '../providers/ollama/ollama.provider.js';
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
  anthropic: 'claude-sonnet-4-6',
  mistral: 'mistral-small-latest',
  groq: 'llama-3.3-70b-versatile',
  cerebras: 'llama3.3-70b',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  ollama: 'qwen2.5-coder:7b',
  custom: 'default',
};

@Injectable()
export class LlmFactoryService {
  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    @Inject(MISTRAL_CLIENT) private readonly mistral: OpenAI,
    @Inject(GROQ_CLIENT) private readonly groq: Groq,
    @Inject(CEREBRAS_CLIENT) private readonly cerebras: OpenAI,
    @Inject(GEMINI_CLIENT) private readonly gemini: GoogleGenerativeAI,
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
    @Inject(OLLAMA_CLIENT) private readonly ollama: Ollama,
    @Inject(CUSTOM_CONFIG) private readonly customConfig: CustomConfig,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  getProvider(): LlmProvider {
    return this.configService.get<LlmProvider>('aiProvider', 'mistral');
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

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const provider = this.getProvider();
    if (params.maxTokens === undefined) {
      params = { ...params, maxTokens: this.getMaxTokens() };
    }
    switch (provider) {
      case 'anthropic':
        return this.chatAnthropic(params);
      case 'gemini':
        return this.chatGemini(params);
      case 'groq':
        return this.chatOpenAICompat(this.groq as unknown as OpenAI, params);
      case 'cerebras':
        return this.chatOpenAICompat(this.cerebras, params);
      case 'openai':
        return this.chatOpenAINative(params);
      case 'ollama':
        return this.chatOllama(params);
      case 'custom':
        return this.chatCustom(params);
      case 'mistral':
      default:
        return this.chatOpenAICompat(this.mistral, params);
    }
  }

  private async chatOpenAICompat(
    client: OpenAI,
    params: LlmChatParams,
  ): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user' as const, content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new Error(
        `Empty response from ${model} (finish_reason: ${response.choices[0]?.finish_reason ?? 'unknown'})`,
      );
    }

    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  private async chatOpenAINative(
    params: LlmChatParams,
  ): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 1,
    } = params;

    const response = await this.openai.chat.completions.create({
      model,
      max_completion_tokens: maxTokens,
      temperature,
      messages: [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user' as const, content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content;
    if (!text) {
      throw new Error(
        `Empty response from ${model} (finish_reason: ${response.choices[0]?.finish_reason ?? 'unknown'})`,
      );
    }

    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  private async chatAnthropic(params: LlmChatParams): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const response = await this.anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userPrompt }],
    });

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== 'text' || !firstBlock.text) {
      throw new Error(
        `Empty response from ${model} (stop_reason: ${response.stop_reason ?? 'unknown'})`,
      );
    }

    return {
      text: firstBlock.text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  private async chatGemini(params: LlmChatParams): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const genModel = this.gemini.getGenerativeModel({
      model,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });

    const result = await genModel.generateContent(userPrompt);
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error(`Empty response from ${model}`);
    }

    return {
      text,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
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
    const { baseURL, apiKey } = this.customConfig;

    const response = await firstValueFrom(
      this.httpService.post(
        `${baseURL}/gateway/chat/completions`,
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
          headers: {
            Authorization: `${apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const { text, inputTokens, outputTokens } = response.data;

    if (!text) {
      throw new Error(
        `Empty response from custom model ${model} (finish_reason: ${response.data.choices?.[0]?.finish_reason ?? 'unknown'})`,
      );
    }

    return {
      text,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    };
  }

  private async chatOllama(params: LlmChatParams): Promise<LlmChatResult> {
    const {
      model,
      systemPrompt,
      userPrompt,
      maxTokens = 8192,
      temperature = 0,
    } = params;

    const response = await this.ollama.chat({
      model,
      messages: [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user' as const, content: userPrompt },
      ],
      stream: false,
      options: { temperature, num_predict: maxTokens },
    });

    const text = response.message.content;
    if (!text) {
      throw new Error(`Empty response from ${model}`);
    }

    return {
      text,
      inputTokens: response.prompt_eval_count ?? 0,
      outputTokens: response.eval_count ?? 0,
    };
  }
}
