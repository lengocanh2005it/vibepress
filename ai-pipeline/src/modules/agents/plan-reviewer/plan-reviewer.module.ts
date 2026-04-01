import { Module } from '@nestjs/common';
import { PlanReviewerService } from './plan-reviewer.service.js';

@Module({
  providers: [PlanReviewerService],
  exports: [PlanReviewerService],
})
export class PlanReviewerModule {}
