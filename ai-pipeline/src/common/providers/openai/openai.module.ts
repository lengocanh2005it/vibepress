import { Global, Module } from '@nestjs/common';
import { OPENAI_CLIENT, OpenAIProvider } from './openai.provider';

@Global()
@Module({
  providers: [OpenAIProvider],
  exports: [OPENAI_CLIENT],
})
export class OpenAIModule {}
