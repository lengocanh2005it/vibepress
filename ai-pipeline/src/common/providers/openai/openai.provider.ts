import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export const OPENAI_CLIENT = 'OPENAI_CLIENT';

export const OpenAIProvider: Provider = {
  provide: OPENAI_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('openai.apiKey')!;
    const baseURL = configService.get<string>('openai.baseURL');
    return new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  },
};
