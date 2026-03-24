import { Global, Module } from '@nestjs/common';
import { ANTHROPIC_CLIENT, AnthropicProvider } from './anthropic.provider.js';

@Global()
@Module({
  providers: [AnthropicProvider],
  exports: [ANTHROPIC_CLIENT],
})
export class AnthropicModule {}
