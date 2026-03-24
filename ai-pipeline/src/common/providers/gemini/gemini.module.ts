import { Global, Module } from '@nestjs/common';
import { GEMINI_CLIENT, GeminiProvider } from './gemini.provider';

@Global()
@Module({
  providers: [GeminiProvider],
  exports: [GEMINI_CLIENT],
})
export class GeminiModule {}
