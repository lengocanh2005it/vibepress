import { Module } from '@nestjs/common';
import { GenerationContractAuditService } from './generation-contract-audit.service.js';
import { ValidatorService } from './validator.service.js';

@Module({
  providers: [ValidatorService, GenerationContractAuditService],
  exports: [ValidatorService, GenerationContractAuditService],
})
export class ValidatorModule {}
