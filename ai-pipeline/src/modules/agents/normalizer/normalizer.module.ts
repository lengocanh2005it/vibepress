import { Module } from '@nestjs/common';
import { NormalizerService } from './normalizer.service.js';

@Module({
  providers: [NormalizerService],
  exports: [NormalizerService],
})
export class NormalizerModule {}
