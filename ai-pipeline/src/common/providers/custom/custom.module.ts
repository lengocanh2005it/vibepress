import { Global, Module } from '@nestjs/common';
import { CUSTOM_CONFIG, CustomProvider } from './custom.provider';

@Global()
@Module({
  providers: [CustomProvider],
  exports: [CUSTOM_CONFIG],
})
export class CustomModule {}
