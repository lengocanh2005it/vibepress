import { Injectable, Logger } from '@nestjs/common';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import simpleGit from 'simple-git';

const execAsync = promisify(exec);

export interface DeployResult {
  jobId: string;
  repoUrl: string;
  commitSha: string;
  devUrl: string;
  previewAppDir: string;
}

@Injectable()
export class DeployAgentService {
  private readonly logger = new Logger(DeployAgentService.name);

  // Bước 1: clone repo B, trả về cloneDir để preview-builder build vào
  async cloneRepoB(input: {
    jobId: string;
    repoUrl: string;
    accessToken?: string;
  }): Promise<string> {
    const { jobId, repoUrl, accessToken } = input;
    const cloneDir = join('./temp/repos', `deploy_${jobId}`);
    await mkdir(cloneDir, { recursive: true });

    const cloneUrl = accessToken
      ? repoUrl.replace('https://', `https://${accessToken}@`)
      : repoUrl;

    this.logger.log(`Cloning repo B: ${repoUrl} → ${cloneDir}`);
    await simpleGit().clone(cloneUrl, cloneDir, ['--depth', '1']);
    return cloneDir;
  }

  // Bước 2: commit + push + start dev server
  async commitAndPush(input: {
    jobId: string;
    repoUrl: string;
    cloneDir: string;
    previewDir: string;
  }): Promise<DeployResult> {
    const { jobId, repoUrl, cloneDir, previewDir } = input;

    const repoGit = simpleGit(cloneDir);
    await repoGit.addConfig('user.email', 'pipeline@vibress.ai');
    await repoGit.addConfig('user.name', 'Vibress Pipeline');
    await repoGit.add('.');
    await repoGit.commit(`feat: migrate WordPress theme [jobId=${jobId}]`);
    await repoGit.push('origin', 'main');

    const log = await repoGit.log({ maxCount: 1 });
    const commitSha = log.latest?.hash ?? '';
    this.logger.log(`Pushed commit: ${commitSha}`);

    const devUrl = await this.startDevServer(previewDir, jobId);
    return { jobId, repoUrl, commitSha, devUrl, previewAppDir: previewDir };
  }

  private async startDevServer(appDir: string, jobId: string): Promise<string> {
    this.logger.log(`Installing dependencies in: ${appDir}`);
    await execAsync('npm install', { cwd: appDir });

    const port = this.pickPort(jobId);
    this.logger.log(`Starting dev server on port ${port} for job ${jobId}`);

    const child = exec(`npm run dev:all -- --port ${port}`, { cwd: appDir });
    child.stdout?.on('data', (d) =>
      this.logger.log(`[dev:${jobId.slice(0, 6)}] ${d.toString().trim()}`),
    );
    child.stderr?.on('data', (d) =>
      this.logger.warn(`[dev:${jobId.slice(0, 6)}] ${d.toString().trim()}`),
    );

    await new Promise((r) => setTimeout(r, 3000));
    return `http://localhost:${port}`;
  }

  // Port 5200–5999 từ jobId để tránh conflict
  private pickPort(_jobId: string): number {
    return 5353;
  }
}
