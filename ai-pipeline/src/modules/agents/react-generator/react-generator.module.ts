import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { GeneratedCodeReviewService } from './generated-code-review.service.js';
import { StyleResolverModule } from '../../../common/style-resolver/style-resolver.module.js';
import { ValidatorModule } from '../validator/validator.module.js';
import { AiLoggerModule } from '../../ai-logger/ai-logger.module.js';

@Module({
  imports: [StyleResolverModule, ValidatorModule, AiLoggerModule],
  providers: [
    ReactGeneratorService,
    CodeGeneratorService,
    CodeReviewerService,
    GeneratedCodeReviewService,
  ],
  exports: [ReactGeneratorService, GeneratedCodeReviewService],
})
export class ReactGeneratorModule {}
