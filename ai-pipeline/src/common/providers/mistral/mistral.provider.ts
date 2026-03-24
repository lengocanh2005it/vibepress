import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export const MISTRAL_CLIENT = 'MISTRAL_CLIENT';

export const MistralProvider: Provider = {
  provide: MISTRAL_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('mistral.apiKey')!;
    return new OpenAI({
      apiKey,
      baseURL: 'https://api.mistral.ai/v1',
    });
  },
};
