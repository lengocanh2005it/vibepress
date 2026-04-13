import { Module } from '@nestjs/common';
import { OrchestratorController } from './orchestrator.controller.js';
import { OrchestratorService } from './orchestrator.service.js';
import { SqlModule } from '../sql/sql.module.js';
import { RepoAnalyzerModule } from '../agents/repo-analyzer/repo-analyzer.module.js';
import { PhpParserModule } from '../agents/php-parser/php-parser.module.js';
import { BlockParserModule } from '../agents/block-parser/block-parser.module.js';
import { DbContentModule } from '../agents/db-content/db-content.module.js';
import { PlannerModule } from '../agents/planner/planner.module.js';
import { PlanReviewerModule } from '../agents/plan-reviewer/plan-reviewer.module.js';
import { ReactGeneratorModule } from '../agents/react-generator/react-generator.module.js';
import { ApiBuilderModule } from '../agents/api-builder/api-builder.module.js';
import { PreviewBuilderModule } from '../agents/preview-builder/preview-builder.module.js';
import { DeployAgentModule } from '../agents/deploy-agent/deploy-agent.module.js';
import { ValidatorModule } from '../agents/validator/validator.module.js';
import { CleanupModule } from '../agents/cleanup/cleanup.module.js';
import { ThemeModule } from '../theme/theme.module.js';
import { AiLoggerModule } from '../ai-logger/ai-logger.module.js';
import { NormalizerModule } from '../agents/normalizer/normalizer.module.js';
import { SourceResolverModule } from '../agents/source-resolver/source-resolver.module.js';
import { DbTemplateOverlayService } from '../agents/db-template-overlay.service.js';
import { EditRequestModule } from '../edit-request/edit-request.module.js';

@Module({
  imports: [
    SqlModule,
    ThemeModule,
    RepoAnalyzerModule,
    PhpParserModule,
    BlockParserModule,
    DbContentModule,
    PlannerModule,
    PlanReviewerModule,
    ReactGeneratorModule,
    ApiBuilderModule,
    PreviewBuilderModule,
    DeployAgentModule,
    ValidatorModule,
    CleanupModule,
    AiLoggerModule,
    NormalizerModule,
    SourceResolverModule,
    EditRequestModule,
  ],
  controllers: [OrchestratorController],
  providers: [OrchestratorService, DbTemplateOverlayService],
})
export class OrchestratorModule {}
