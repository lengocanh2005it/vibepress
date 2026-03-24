import { Module } from '@nestjs/common';
import { PreviewBuilderService } from './preview-builder.service.js';

@Module({
  providers: [PreviewBuilderService],
  exports: [PreviewBuilderService],
})
export class PreviewBuilderModule {}
