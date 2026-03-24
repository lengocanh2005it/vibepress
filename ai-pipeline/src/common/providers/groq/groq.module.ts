import { Global, Module } from '@nestjs/common';
import { GROQ_CLIENT, GroqProvider } from './groq.provider';

@Global()
@Module({
  providers: [GroqProvider],
  exports: [GROQ_CLIENT],
})
export class GroqModule {}
