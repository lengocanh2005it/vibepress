import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { cloneRepoWithRetry } from '../../common/utils/git-clone.util.js';
import {
  ThemeDetectResult,
  ThemeDetectorService,
} from './theme-detector.service.js';
import { ThemeRepoLayoutResolverService } from './theme-repo-layout-resolver.service.js';

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
    private readonly themeRepoLayoutResolver: ThemeRepoLayoutResolverService,
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

    const themeDir = await this.resolveResolvedThemeDir(destDir);

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

    await cloneRepoWithRetry({
      repoUrl: githubUrl,
      destDir,
      logger: this.logger,
      label: `theme service clone:${id}`,
    });

    const themeDir = await this.resolveResolvedThemeDir(destDir);
    const detection = await this.detector.detect(themeDir);
    this.logger.log(`Detected theme type: ${detection.type}`);

    return { jobId: id, themeDir, detection };
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

    const themeDir = await this.resolveResolvedThemeDir(destDir, activeSlug);
    this.logger.log(`Found theme dir: ${themeDir}`);

    const detection = await this.detector.detect(themeDir);
    return { jobId: id, themeDir, detection };
  }

  private async resolveResolvedThemeDir(
    extractDir: string,
    activeSlug?: string,
  ): Promise<string> {
    const repoRoot = await this.resolveThemeRoot(extractDir);
    try {
      return await this.themeRepoLayoutResolver.resolve({
        repoRoot,
        activeSlug,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      this.logger.warn(
        `Theme layout resolver could not resolve a nested FSE theme from "${repoRoot}"${activeSlug ? ` for slug "${activeSlug}"` : ''}. Falling back to repo root. ${message}`,
      );
      return repoRoot;
    }
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
