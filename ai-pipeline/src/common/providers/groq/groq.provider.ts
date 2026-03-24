import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';

export const GROQ_CLIENT = 'GROQ_CLIENT';

export const GroqProvider: Provider = {
  provide: GROQ_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('groq.apiKey');
    return new Groq({ apiKey });
  },
};
