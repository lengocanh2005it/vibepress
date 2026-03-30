import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { StyleResolverModule } from '../style-resolver/style-resolver.module.js';
import { ValidatorModule } from '../validator/validator.module.js';

@Module({
  imports: [StyleResolverModule, ValidatorModule],
  providers: [ReactGeneratorService, CodeGeneratorService],
  exports: [ReactGeneratorService],
})
export class ReactGeneratorModule {}
