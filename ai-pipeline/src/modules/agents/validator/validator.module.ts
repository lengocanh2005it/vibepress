import { Module } from '@nestjs/common';
import { ValidatorService } from './validator.service.js';

@Module({
  providers: [ValidatorService],
  exports: [ValidatorService],
})
export class ValidatorModule {}
