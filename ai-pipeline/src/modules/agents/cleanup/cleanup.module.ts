import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service.js';

@Module({
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
