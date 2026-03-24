import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const GEMINI_CLIENT = 'GEMINI_CLIENT';

export const GeminiProvider: Provider = {
  provide: GEMINI_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('gemini.apiKey')!;
    return new GoogleGenerativeAI(apiKey);
  },
};
