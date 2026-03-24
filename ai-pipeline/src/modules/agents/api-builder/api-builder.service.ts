import { Injectable, Logger } from '@nestjs/common';
import { cp } from 'fs/promises';
import { join, resolve } from 'path';

const TEMPLATE_DIR = resolve('templates/express-server');

export interface ApiBuilderResult {
  outDir: string;
  files: { name: string; filePath: string; code: string }[];
}

@Injectable()
export class ApiBuilderService {
  private readonly logger = new Logger(ApiBuilderService.name);

  async build(input: { jobId?: string }): Promise<ApiBuilderResult> {
    const { jobId = 'unknown' } = input;
    const outDir = join('./temp/generated', jobId, 'server');

    this.logger.log(`Copying Express server template for job: ${jobId}`);
    await cp(TEMPLATE_DIR, outDir, { recursive: true });

    return { outDir, files: [] };
  }
}
