import { Module } from '@nestjs/common';
import { ApiBuilderService } from './api-builder.service.js';
import { GeneratedApiReviewService } from './generated-api-review.service.js';

@Module({
  providers: [ApiBuilderService, GeneratedApiReviewService],
  exports: [ApiBuilderService, GeneratedApiReviewService],
})
export class ApiBuilderModule {}
