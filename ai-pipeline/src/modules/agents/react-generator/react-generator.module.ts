import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';

@Module({
  providers: [ReactGeneratorService],
  exports: [ReactGeneratorService],
})
export class ReactGeneratorModule {}
