import { Module } from '@nestjs/common';
import { PreviewBuilderService } from './preview-builder.service.js';
import { AssetDownloaderService } from './asset-downloader.service.js';

@Module({
  providers: [PreviewBuilderService, AssetDownloaderService],
  exports: [PreviewBuilderService],
})
export class PreviewBuilderModule {}
