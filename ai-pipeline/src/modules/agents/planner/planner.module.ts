import { Module } from '@nestjs/common';
import { PlannerService } from './planner.service.js';
import { AiLoggerModule } from '../../ai-logger/ai-logger.module.js';
import { StyleResolverModule } from '../../../common/style-resolver/style-resolver.module.js';

@Module({
  imports: [AiLoggerModule, StyleResolverModule],
  providers: [PlannerService],
  exports: [PlannerService],
})
export class PlannerModule {}
