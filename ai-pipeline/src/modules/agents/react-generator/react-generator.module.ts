import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';
import { StyleResolverModule } from '../style-resolver/style-resolver.module.js';
import { ValidatorModule } from '../validator/validator.module.js';

@Module({
  imports: [StyleResolverModule, ValidatorModule],
  providers: [ReactGeneratorService],
  exports: [ReactGeneratorService],
})
export class ReactGeneratorModule {}
