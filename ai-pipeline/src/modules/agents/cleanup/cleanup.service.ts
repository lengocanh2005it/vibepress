import { Injectable, Logger } from '@nestjs/common';
import { rm } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  /**
   * Remove temp folders created during a pipeline job:
   * - ./temp/repos/<jobId>   (cloned theme repo)
   * - ./temp/uploads/<jobId> (uploaded SQL file, if any)
   */
  async cleanup(jobId: string): Promise<void> {
    const targets = [
      join('./temp/repos', jobId),
      join('./temp/uploads', jobId),
    ];

    for (const dir of targets) {
      try {
        await rm(dir, { recursive: true, force: true });
        this.logger.log(`Removed ${dir}`);
      } catch (err: any) {
        // Non-fatal — log and continue
        this.logger.warn(`Could not remove ${dir}: ${err.message}`);
      }
    }
  }
}
