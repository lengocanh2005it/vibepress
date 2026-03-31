import { Global, Module } from '@nestjs/common';
import { OLLAMA_CLIENT, OllamaProvider } from './ollama.provider';

@Global()
@Module({
  providers: [OllamaProvider],
  exports: [OLLAMA_CLIENT],
})
export class OllamaModule {}
