import { Injectable, Logger } from '@nestjs/common';
import { cp, mkdir } from 'fs/promises';
import { join } from 'path';

// Common WordPress theme asset directory patterns.
// Each entry: [src relative to themeDir, dest relative to publicDir]
const THEME_ASSET_DIRS: [string, string][] = [
  ['assets', 'assets'], // most common: assets/ (preserves sub-structure)
  ['images', 'assets/images'], // theme root images/
  ['img', 'assets/img'], // theme root img/
  ['fonts', 'assets/fonts'], // theme root fonts/
  ['svg', 'assets/svg'], // theme root svg/
  ['icons', 'assets/icons'], // theme root icons/
];

@Injectable()
export class AssetDownloaderService {
  private readonly logger = new Logger(AssetDownloaderService.name);

  /**
   * Copy all theme assets into the React app public directory.
   * Scans common asset folder patterns (assets/, images/, img/, fonts/, etc.)
   * so themes that don't follow the assets/images + assets/fonts convention
   * are still fully covered. Missing folders are silently skipped.
   */
  async copyThemeAssets(
    themeDir: string,
    publicDir: string,
  ): Promise<{ copied: string[]; skipped: string[] }> {
    const copied: string[] = [];
    const skipped: string[] = [];

    for (const [srcSub, destSub] of THEME_ASSET_DIRS) {
      const srcPath = join(themeDir, srcSub);
      const destPath = join(publicDir, destSub);
      try {
        await mkdir(destPath, { recursive: true });
        await cp(srcPath, destPath, { recursive: true, force: true });
        this.logger.log(`Copied theme assets: ${srcSub}/ → public/${destSub}/`);
        copied.push(srcSub);
      } catch {
        skipped.push(srcSub);
      }
    }

    return { copied, skipped };
  }

  /** @deprecated Use copyThemeAssets instead */
  async copyAssets(
    themeAssetsDir: string,
    destImagesDir: string,
    destFontsDir: string,
  ): Promise<{ imagesCopied: boolean; fontsCopied: boolean }> {
    let imagesCopied = false;
    let fontsCopied = false;

    try {
      const sourceImagesDir = join(themeAssetsDir, 'images');
      await mkdir(destImagesDir, { recursive: true });
      await cp(sourceImagesDir, destImagesDir, {
        recursive: true,
        force: true,
      });
      imagesCopied = true;
    } catch {
      // not found
    }

    try {
      const sourceFontsDir = join(themeAssetsDir, 'fonts');
      await mkdir(destFontsDir, { recursive: true });
      await cp(sourceFontsDir, destFontsDir, { recursive: true, force: true });
      fontsCopied = true;
    } catch {
      // not found
    }

    return { imagesCopied, fontsCopied };
  }
}
