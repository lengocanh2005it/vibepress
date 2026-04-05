import { Module } from '@nestjs/common';
import { PlannerService } from './planner.service.js';
import { AiLoggerModule } from '../../ai-logger/ai-logger.module.js';

@Module({
  imports: [AiLoggerModule],
  providers: [PlannerService],
  exports: [PlannerService],
})
export class PlannerModule {}
