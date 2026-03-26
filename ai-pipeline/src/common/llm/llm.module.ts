import { Global, Module } from '@nestjs/common';
import { LlmFactoryService } from './llm-factory.service.js';

@Global()
@Module({
  providers: [LlmFactoryService],
  exports: [LlmFactoryService],
})
export class LlmModule {}
