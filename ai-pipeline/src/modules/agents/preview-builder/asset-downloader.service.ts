import { Injectable, Logger } from '@nestjs/common';
import { cp, mkdir } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class AssetDownloaderService {
  private readonly logger = new Logger(AssetDownloaderService.name);

  /**
   * Copy assets (images, fonts) từ theme folder vào React app
   * @param themeAssetsDir - Đường dẫn đến theme/assets
   * @param destImagesDir - Đường dẫn đến frontend/src/assets/images
   * @param destFontsDir - Đường dẫn đến frontend/src/assets/fonts
   */
  async copyAssets(
    themeAssetsDir: string,
    destImagesDir: string,
    destFontsDir: string,
  ): Promise<{ imagesCopied: boolean; fontsCopied: boolean }> {
    let imagesCopied = false;
    let fontsCopied = false;

    try {
      // Copy images folder
      const sourceImagesDir = join(themeAssetsDir, 'images');
      await mkdir(destImagesDir, { recursive: true });
      await cp(sourceImagesDir, destImagesDir, {
        recursive: true,
        force: true,
      });
      this.logger.log(`Copied theme images to: ${destImagesDir}`);
      imagesCopied = true;
    } catch (error) {
      this.logger.warn(
        `Failed to copy images from theme: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    try {
      // Copy fonts folder
      const sourceFontsDir = join(themeAssetsDir, 'fonts');
      await mkdir(destFontsDir, { recursive: true });
      await cp(sourceFontsDir, destFontsDir, { recursive: true, force: true });
      this.logger.log(`Copied theme fonts to: ${destFontsDir}`);
      fontsCopied = true;
    } catch (error) {
      this.logger.warn(
        `Failed to copy fonts from theme: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    return { imagesCopied, fontsCopied };
  }
}
