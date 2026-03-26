import { Module } from '@nestjs/common';
import { ReactGeneratorService } from './react-generator.service.js';
import { StyleResolverModule } from '../style-resolver/style-resolver.module.js';

@Module({
  imports: [StyleResolverModule],
  providers: [ReactGeneratorService],
  exports: [ReactGeneratorService],
})
export class ReactGeneratorModule {}
