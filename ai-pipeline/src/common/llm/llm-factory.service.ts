import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ANTHROPIC_CLIENT } from '../providers/anthropic/anthropic.provider.js';
import { MISTRAL_CLIENT } from '../providers/mistral/mistral.provider.js';
import { GROQ_CLIENT } from '../providers/groq/groq.provider.js';
import { CEREBRAS_CLIENT } from '../providers/cerebras/cerebras.provider.js';
import { GEMINI_CLIENT } from '../providers/gemini/gemini.provider.js';
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
};

@Injectable()
export class LlmFactoryService {
  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    @Inject(MISTRAL_CLIENT) private readonly mistral: OpenAI,
    @Inject(GROQ_CLIENT) private readonly groq: Groq,
    @Inject(CEREBRAS_CLIENT) private readonly cerebras: OpenAI,
    @Inject(GEMINI_CLIENT) private readonly gemini: GoogleGenerativeAI,
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

  async chat(params: LlmChatParams): Promise<LlmChatResult> {
    const provider = this.getProvider();
    switch (provider) {
      case 'anthropic':
        return this.chatAnthropic(params);
      case 'gemini':
        return this.chatGemini(params);
      case 'groq':
        return this.chatOpenAICompat(
          this.groq as unknown as OpenAI,
          params,
        );
      case 'cerebras':
        return this.chatOpenAICompat(this.cerebras, params);
      case 'mistral':
      default:
        return this.chatOpenAICompat(this.mistral, params);
    }
  }

  private async chatOpenAICompat(
    client: OpenAI,
    params: LlmChatParams,
  ): Promise<LlmChatResult> {
    const { model, systemPrompt, userPrompt, maxTokens = 8192 } = params;
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user' as const, content: userPrompt },
      ],
    });
    return {
      text: response.choices[0]?.message?.content ?? '',
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  }

  private async chatAnthropic(params: LlmChatParams): Promise<LlmChatResult> {
    const { model, systemPrompt, userPrompt, maxTokens = 8192 } = params;
    const response = await this.anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: userPrompt }],
    });
    const firstBlock = response.content[0];
    return {
      text: firstBlock?.type === 'text' ? firstBlock.text : '',
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }

  private async chatGemini(params: LlmChatParams): Promise<LlmChatResult> {
    const { model, systemPrompt, userPrompt, maxTokens = 8192 } = params;
    const genModel = this.gemini.getGenerativeModel({
      model,
      ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const result = await genModel.generateContent(userPrompt);
    const response = result.response;
    return {
      text: response.text(),
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
