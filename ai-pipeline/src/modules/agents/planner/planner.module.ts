import { Module } from '@nestjs/common';
import { PlannerService } from './planner.service.js';
import { PlannerVisualRepairService } from './planner-visual-repair.service.js';
import { AiLoggerModule } from '../../ai-logger/ai-logger.module.js';
import { StyleResolverModule } from '../../../common/style-resolver/style-resolver.module.js';
import { EditRequestModule } from '../../edit-request/edit-request.module.js';
import { ThemeModule } from '../../theme/theme.module.js';

@Module({
  imports: [
    AiLoggerModule,
    StyleResolverModule,
    EditRequestModule,
    ThemeModule,
  ],
  providers: [PlannerService, PlannerVisualRepairService],
  exports: [PlannerService],
})
export class PlannerModule {}
