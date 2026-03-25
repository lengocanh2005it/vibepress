import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export const ANTHROPIC_CLIENT = 'ANTHROPIC_CLIENT';

export const AnthropicProvider: Provider = {
  provide: ANTHROPIC_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const apiKey = configService.get<string>('anthropic.apiKey', '');
    return new Anthropic({ apiKey, timeout: 10 * 60 * 1000 });
  },
};
