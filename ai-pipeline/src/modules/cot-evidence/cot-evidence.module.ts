import { Module } from '@nestjs/common';
import { CotEvidenceService } from './cot-evidence.service.js';

@Module({
  providers: [CotEvidenceService],
  exports: [CotEvidenceService],
})
export class CotEvidenceModule {}
