import { Module } from '@nestjs/common';
import { PreviewBuilderService } from './preview-builder.service.js';
import { AssetDownloaderService } from './asset-downloader.service.js';
import { ValidatorModule } from '../validator/validator.module.js';

@Module({
  imports: [ValidatorModule],
  providers: [PreviewBuilderService, AssetDownloaderService],
  exports: [PreviewBuilderService],
})
export class PreviewBuilderModule {}
