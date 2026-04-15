import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { GeneratedCodeReviewService } from './generated-code-review.service.js';
import { SectionEditService } from './section-edit.service.js';
import { StyleResolverModule } from '../../../common/style-resolver/style-resolver.module.js';
import { ValidatorModule } from '../validator/validator.module.js';
import { AiLoggerModule } from '../../ai-logger/ai-logger.module.js';
import { EditRequestModule } from '../../edit-request/edit-request.module.js';

@Module({
  imports: [
    StyleResolverModule,
    ValidatorModule,
    AiLoggerModule,
    EditRequestModule,
  ],
  providers: [
    ReactGeneratorService,
    CodeReviewerService,
    GeneratedCodeReviewService,
    SectionEditService,
  ],
  exports: [
    ReactGeneratorService,
    GeneratedCodeReviewService,
    SectionEditService,
  ],
})
export class ReactGeneratorModule {}
