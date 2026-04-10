import { Module } from '@nestjs/common';
import { EditIntentService } from './edit-intent.service.js';
import { EditRequestFacadeService } from './edit-request.facade.service.js';
import { EditRequestPhaseService } from './edit-request-phase.service.js';
import { EditRequestService } from './edit-request.service.js';
import { EditRequestTargetResolverService } from './edit-request-target-resolver.service.js';
import { EditRequestValidatorService } from './edit-request-validator.service.js';

@Module({
  providers: [
    EditRequestService,
    EditRequestValidatorService,
    EditRequestTargetResolverService,
    EditRequestPhaseService,
    EditIntentService,
    EditRequestFacadeService,
  ],
  exports: [
    EditRequestService,
    EditRequestFacadeService,
    EditRequestPhaseService,
  ],
})
export class EditRequestModule {}
