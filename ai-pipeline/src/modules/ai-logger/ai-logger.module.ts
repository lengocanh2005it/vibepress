import { Module } from '@nestjs/common';
import { AiLoggerService } from './ai-logger.service.js';

@Module({
  providers: [AiLoggerService],
  exports: [AiLoggerService],
})
export class AiLoggerModule {}
