import { Module } from '@nestjs/common';
import { CapturePlanningService } from './capture-planning.service.js';
import { CaptureSectionMatcherService } from './capture-section-matcher.service.js';
import { CaptureVisionInputService } from './capture-vision-input.service.js';
import { EditIntentService } from './edit-intent.service.js';
import { EditRequestFacadeService } from './edit-request.facade.service.js';
import { EditRequestPhaseService } from './edit-request-phase.service.js';
import { EditRequestService } from './edit-request.service.js';
import { EditRequestTargetResolverService } from './edit-request-target-resolver.service.js';
import { EditRequestValidatorService } from './edit-request-validator.service.js';

@Module({
  providers: [
    CapturePlanningService,
    CaptureSectionMatcherService,
    CaptureVisionInputService,
    EditRequestService,
    EditRequestValidatorService,
    EditRequestTargetResolverService,
    EditRequestPhaseService,
    EditIntentService,
    EditRequestFacadeService,
  ],
  exports: [
    CapturePlanningService,
    CaptureSectionMatcherService,
    CaptureVisionInputService,
    EditRequestService,
    EditRequestFacadeService,
    EditRequestPhaseService,
  ],
})
export class EditRequestModule {}
