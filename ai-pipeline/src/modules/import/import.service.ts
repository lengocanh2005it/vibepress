import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { mkdir } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import simpleGit from 'simple-git';
import { join } from 'path';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type { ImportResult } from '@/common/types/import.type.js';
import { SqlService } from '../sql/sql.service.js';
import { ThemeService } from '../theme/theme.service.js';
import { WpQueryService } from '../sql/wp-query.service.js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly sqlService: SqlService,
    private readonly themeService: ThemeService,
    private readonly wpQuery: WpQueryService,
    private readonly configService: ConfigService,
  ) {}

  // Mode A: Upload file .sql → import vào shared DB
  async handleSqlUpload(filePath: string): Promise<ImportResult> {
    const jobId = uuidv4();
    this.logger.log(`[Mode A] SQL upload — jobId=${jobId}`);
    await this.ensureTempDirs();
    return { jobId, mode: 'sql', status: 'pending', sqlFilePath: filePath };
  }

  // Mode B: Kết nối trực tiếp WP database
  async handleDirectDb(creds: WpDbCredentials): Promise<ImportResult> {
    const jobId = uuidv4();
    this.logger.log(`[Mode B] Direct DB — jobId=${jobId}, db=${creds.dbName}`);
    await this.ensureTempDirs();

    await this.sqlService.verifyDirectCredentials(creds);

    return {
      jobId,
      mode: 'direct_db',
      status: 'pending',
      dbCredentials: creds,
    };
  }

  // Mode D: Clone GitHub repo (nguồn theme chính)
  async handleGithubImport(
    repoUrl: string,
    branch = 'main',
  ): Promise<ImportResult> {
    const jobId = uuidv4();
    this.logger.log(`[Mode D] GitHub import — jobId=${jobId}, repo=${repoUrl}`);
    await this.ensureTempDirs();

    if (!this.isGithubUrl(repoUrl))
      throw new BadRequestException('Invalid GitHub URL');

    const destDir = join('./temp/repos', jobId);
    await mkdir(destDir, { recursive: true });

    const token = this.configService.get<string>('github.wpRepoToken', '');
    const cloneUrl = token
      ? repoUrl.replace('https://', `https://${token}@`)
      : repoUrl;

    const git = simpleGit();
    await git.clone(cloneUrl, destDir, ['--depth', '1', '--branch', branch]);

    this.logger.log(`[Mode D] Cloned to ${destDir}`);

    return {
      jobId,
      mode: 'github',
      status: 'pending',
      themeDir: destDir,
      repoUrl,
    };
  }

  // Mode Full: upload SQL + theme zip cùng lúc → auto detect active theme
  async handleFullImport(
    sqlFilePath: string,
    themeZipPath: string,
  ): Promise<ImportResult & { activeTheme: string }> {
    const jobId = uuidv4();
    this.logger.log(`[Mode Full] jobId=${jobId}`);
    await this.ensureTempDirs();

    // 1. Import SQL vào DB
    const dbCreds = await this.sqlService.importToTempDb(sqlFilePath, jobId);

    // 2. Query active theme slug từ DB
    const activeTheme = await this.wpQuery.getActiveTheme(dbCreds);
    this.logger.log(`[Mode Full] Active theme: ${activeTheme}`);

    // 3. Extract zip, tìm folder khớp slug
    const { themeDir } = await this.themeService.extractAndFindTheme(
      themeZipPath,
      activeTheme,
      jobId,
    );

    return {
      jobId,
      mode: 'sql',
      status: 'pending',
      sqlFilePath,
      dbCredentials: dbCreds,
      themeDir,
      activeTheme,
    };
  }

  // Theme zip upload (dự phòng)
  async handleThemeUpload(filePath: string): Promise<ImportResult> {
    const jobId = uuidv4();
    this.logger.log(`[Theme zip] upload — jobId=${jobId}`);
    await this.ensureTempDirs();

    const result = await this.themeService.extractZip(filePath, jobId);

    return {
      jobId,
      mode: 'theme_zip',
      status: 'pending',
      themeDir: result.themeDir,
    };
  }

  private isGithubUrl(url: string): boolean {
    return /^https:\/\/github\.com\/.+\/.+/.test(url);
  }

  private async ensureTempDirs(): Promise<void> {
    await Promise.all([
      mkdir('./temp/uploads', { recursive: true }),
      mkdir('./temp/repos', { recursive: true }),
    ]);
  }
}
