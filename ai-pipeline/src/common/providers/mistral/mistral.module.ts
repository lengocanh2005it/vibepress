import { Global, Module } from '@nestjs/common';
import { MISTRAL_CLIENT, MistralProvider } from './mistral.provider';

@Global()
@Module({
  providers: [MistralProvider],
  exports: [MISTRAL_CLIENT],
})
export class MistralModule {}
