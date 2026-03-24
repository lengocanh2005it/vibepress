import { Injectable } from '@nestjs/common';
import { readdir } from 'fs/promises';
import { join } from 'path';

export type ThemeType = 'fse' | 'classic';

export interface ThemeDetectResult {
  type: ThemeType;
  themeDir: string;
  hasThemeJson: boolean;
  hasTemplatesDir: boolean;
  hasFunctionsPHP: boolean;
}

@Injectable()
export class ThemeDetectorService {
  async detect(themeDir: string): Promise<ThemeDetectResult> {
    const entries = await readdir(themeDir);
    const names = new Set(entries.map((e) => e.toLowerCase()));

    const hasThemeJson = names.has('theme.json');
    const hasTemplatesDir = names.has('templates');
    const hasFunctionsPHP = names.has('functions.php');

    // FSE: có theme.json + thư mục templates/
    const isFse = hasThemeJson && hasTemplatesDir;

    return {
      type: isFse ? 'fse' : 'classic',
      themeDir,
      hasThemeJson,
      hasTemplatesDir,
      hasFunctionsPHP,
    };
  }
}
