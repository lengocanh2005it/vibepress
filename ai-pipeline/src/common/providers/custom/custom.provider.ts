import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CUSTOM_CONFIG = 'CUSTOM_CONFIG';

export interface CustomConfig {
  baseURL: string;
  apiKey: string;
  chatCompletionsPath: string;
  authHeader: string;
  authValuePrefix: string;
}

export const CustomProvider: Provider = {
  provide: CUSTOM_CONFIG,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): CustomConfig => ({
    baseURL: configService.get<string>(
      'custom.baseURL',
      'http://localhost:8000',
    ),
    apiKey: configService.get<string>('custom.apiKey', ''),
    chatCompletionsPath: configService.get<string>(
      'custom.chatCompletionsPath',
      '/gateway/chat/completions',
    ),
    authHeader: configService.get<string>('custom.authHeader', 'Authorization'),
    authValuePrefix: configService.get<string>('custom.authValuePrefix', ''),
  }),
};
