import { Global, Module } from '@nestjs/common';
import { CEREBRAS_CLIENT, CerebrasProvider } from './cerebras.provider';

@Global()
@Module({
  providers: [CerebrasProvider],
  exports: [CEREBRAS_CLIENT],
})
export class CerebrasModule {}
