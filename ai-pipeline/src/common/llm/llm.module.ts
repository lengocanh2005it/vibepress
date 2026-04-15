import { Global, Module } from '@nestjs/common';
import { LlmFactoryService } from './llm-factory.service.js';
import { PipelineSignalRegistry } from './pipeline-signal.registry.js';

@Global()
@Module({
  providers: [LlmFactoryService, PipelineSignalRegistry],
  exports: [LlmFactoryService, PipelineSignalRegistry],
})
export class LlmModule {}
