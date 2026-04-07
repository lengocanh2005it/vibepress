import { Module } from '@nestjs/common';
import { PreviewBuilderService } from './preview-builder.service.js';
import { AssetDownloaderService } from './asset-downloader.service.js';
import { VisualRouteReviewService } from './visual-route-review.service.js';
import { ValidatorModule } from '../validator/validator.module.js';

@Module({
  imports: [ValidatorModule],
  providers: [
    PreviewBuilderService,
    AssetDownloaderService,
    VisualRouteReviewService,
  ],
  exports: [PreviewBuilderService, VisualRouteReviewService],
})
export class PreviewBuilderModule {}
