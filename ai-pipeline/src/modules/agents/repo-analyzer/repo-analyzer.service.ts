import { Injectable, Logger } from '@nestjs/common';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

export interface RepoAnalyzeResult {
  themeDir: string;
  fileTree: string[];
  totalFiles: number;
}

@Injectable()
export class RepoAnalyzerService {
  private readonly logger = new Logger(RepoAnalyzerService.name);

  async analyze(themeDir: string): Promise<RepoAnalyzeResult> {
    this.logger.log(`Analyzing repo: ${themeDir}`);
    const fileTree = await this.walk(themeDir);
    return { themeDir, fileTree, totalFiles: fileTree.length };
  }

  private async walk(dir: string, base = dir): Promise<string[]> {
    const entries = await readdir(dir);
    const results: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory()) {
        results.push(...(await this.walk(full, base)));
      } else {
        results.push(full.replace(base, '').replace(/\\/g, '/'));
      }
    }
    return results;
  }
}
