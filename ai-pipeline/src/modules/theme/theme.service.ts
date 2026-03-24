import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import simpleGit from 'simple-git';
import { v4 as uuidv4 } from 'uuid';
import {
  ThemeDetectResult,
  ThemeDetectorService,
} from './theme-detector.service.js';

export interface ThemeExtractResult {
  jobId: string;
  themeDir: string;
  detection: ThemeDetectResult;
}

@Injectable()
export class ThemeService {
  private readonly logger = new Logger(ThemeService.name);
  private readonly reposDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly detector: ThemeDetectorService,
  ) {
    this.reposDir = './temp/repos';
  }

  // Xử lý file .zip upload từ import.service
  async extractZip(
    filePath: string,
    jobId?: string,
  ): Promise<ThemeExtractResult> {
    const id = jobId ?? uuidv4();
    const destDir = join(this.reposDir, id);
    await mkdir(destDir, { recursive: true });

    this.logger.log(`Extracting zip: ${filePath} → ${destDir}`);

    const zip = new AdmZip(filePath);
    zip.extractAllTo(destDir, true);

    // Nếu zip chứa 1 thư mục wrapper, đi vào bên trong
    const themeDir = await this.resolveThemeRoot(destDir);

    const detection = await this.detector.detect(themeDir);
    this.logger.log(`Detected theme type: ${detection.type}`);

    return { jobId: id, themeDir, detection };
  }

  // Clone từ GitHub URL
  async cloneRepo(
    githubUrl: string,
    jobId?: string,
  ): Promise<ThemeExtractResult> {
    if (!this.isGithubUrl(githubUrl)) {
      throw new BadRequestException('Invalid GitHub URL');
    }

    const id = jobId ?? uuidv4();
    const destDir = join(this.reposDir, id);
    await mkdir(destDir, { recursive: true });

    this.logger.log(`Cloning repo: ${githubUrl} → ${destDir}`);

    const git = simpleGit();
    await git.clone(githubUrl, destDir, ['--depth', '1']);

    const detection = await this.detector.detect(destDir);
    this.logger.log(`Detected theme type: ${detection.type}`);

    return { jobId: id, themeDir: destDir, detection };
  }

  async cleanup(jobId: string): Promise<void> {
    const destDir = join(this.reposDir, jobId);
    await rm(destDir, { recursive: true, force: true });
    this.logger.log(`Cleaned up temp dir: ${destDir}`);
  }

  // Extract zip rồi tìm theme folder khớp với activeSlug
  async extractAndFindTheme(
    filePath: string,
    activeSlug: string,
    jobId?: string,
  ): Promise<ThemeExtractResult> {
    const id = jobId ?? uuidv4();
    const destDir = join(this.reposDir, id);
    await mkdir(destDir, { recursive: true });

    this.logger.log(
      `Extracting zip for theme "${activeSlug}": ${filePath} → ${destDir}`,
    );

    const zip = new AdmZip(filePath);
    zip.extractAllTo(destDir, true);

    const themeDir = await this.findThemeFolder(destDir, activeSlug);
    this.logger.log(`Found theme dir: ${themeDir}`);

    const detection = await this.detector.detect(themeDir);
    return { jobId: id, themeDir, detection };
  }

  // Tìm folder chứa style.css với Theme Name hoặc folder name khớp slug
  private async findThemeFolder(
    extractDir: string,
    slug: string,
  ): Promise<string> {
    const { readdir, stat, readFile } = await import('fs/promises');

    const scanDir = async (dir: string, depth = 0): Promise<string | null> => {
      if (depth > 3) return null;
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;

        // Kiểm tra folder name khớp slug
        if (entry.toLowerCase() === slug.toLowerCase()) {
          return fullPath;
        }

        // Kiểm tra style.css trong folder này
        try {
          const stylePath = join(fullPath, 'style.css');
          const styleContent = await readFile(stylePath, 'utf8');
          // WP theme slug = text slug của Theme Name, hoặc folder name
          if (
            styleContent.includes(`Text Domain: ${slug}`) ||
            entry.toLowerCase() === slug.toLowerCase()
          ) {
            return fullPath;
          }
        } catch {
          // không có style.css, tiếp tục scan sâu hơn
        }

        const found = await scanDir(fullPath, depth + 1);
        if (found) return found;
      }
      return null;
    };

    const found = await scanDir(extractDir);
    if (found) return found;

    // Fallback: dùng resolveThemeRoot như cũ
    this.logger.warn(`Theme slug "${slug}" not found in zip, using root`);
    return this.resolveThemeRoot(extractDir);
  }

  // Nếu zip extract ra 1 folder duy nhất thì dùng folder đó làm root
  private async resolveThemeRoot(dir: string): Promise<string> {
    const { readdir, stat } = await import('fs/promises');
    const entries = await readdir(dir);
    if (entries.length === 1) {
      const child = join(dir, entries[0]);
      const s = await stat(child);
      if (s.isDirectory()) return child;
    }
    return dir;
  }

  private isGithubUrl(url: string): boolean {
    return /^https:\/\/github\.com\/.+\/.+/.test(url);
  }
}
