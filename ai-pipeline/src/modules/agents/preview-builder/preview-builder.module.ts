import { Module } from '@nestjs/common';
import { PreviewBuilderService } from './preview-builder.service.js';
import { AssetDownloaderService } from './asset-downloader.service.js';
import { SectionManifestService } from './section-manifest.service.js';
import { ValidatorModule } from '../validator/validator.module.js';

@Module({
  imports: [ValidatorModule],
  providers: [
    PreviewBuilderService,
    AssetDownloaderService,
    SectionManifestService,
  ],
  exports: [PreviewBuilderService, SectionManifestService],
})
export class PreviewBuilderModule {}
