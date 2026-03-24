import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export const CEREBRAS_CLIENT = 'CEREBRAS_CLIENT';

export const CerebrasProvider: Provider = {
  provide: CEREBRAS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('cerebras.apiKey')!;
    return new OpenAI({
      apiKey,
      baseURL: 'https://api.cerebras.ai/v1',
    });
  },
};
