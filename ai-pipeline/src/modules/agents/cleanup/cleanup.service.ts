import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
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
      await this.removeDir(dir);
    }
  }

  /**
   * Remove all temp folders created during a pipeline job, including generated
   * preview output and logs.
   */
  async cleanupAll(jobId: string): Promise<void> {
    const targets = [
      join('./temp/repos', jobId),
      join('./temp/uploads', jobId),
      join('./temp/generated', jobId),
      join('./temp/logs', jobId),
    ];

    for (const dir of targets) {
      await this.removeDir(dir);
    }
  }

  async terminateProcessTree(pid?: number): Promise<void> {
    if (!pid) return;

    await new Promise<void>((resolve) => {
      const command = process.platform === 'win32' ? 'taskkill' : 'kill';
      const args =
        process.platform === 'win32'
          ? ['/PID', String(pid), '/T', '/F']
          : ['-TERM', String(pid)];
      const proc = spawn(command, args, {
        stdio: 'ignore',
        shell: false,
      });

      proc.on('error', (err: any) => {
        this.logger.warn(
          `Could not terminate process tree ${pid}: ${err?.message ?? 'unknown error'}`,
        );
        resolve();
      });
      proc.on('close', () => resolve());
    });
  }

  private async removeDir(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
      this.logger.log(`Removed ${dir}`);
    } catch (err: any) {
      // Non-fatal — log and continue
      this.logger.warn(`Could not remove ${dir}: ${err.message}`);
    }
  }
}
