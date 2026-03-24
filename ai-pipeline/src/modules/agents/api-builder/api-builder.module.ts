import { Module } from '@nestjs/common';
import { ApiBuilderService } from './api-builder.service.js';

@Module({
  providers: [ApiBuilderService],
  exports: [ApiBuilderService],
})
export class ApiBuilderModule {}
