import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CUSTOM_CONFIG = 'CUSTOM_CONFIG';

export interface CustomConfig {
  baseURL: string;
  apiKey: string;
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
  }),
};
