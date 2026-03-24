import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export interface RunPipelineDto {
  // ── Theme source (chọn 1) ──────────────────────────────────────
  // Mode D (chính): GitHub repo chứa WP theme source
  themeGithubUrl?: string;
  themeGithubToken?: string;
  themeGithubBranch?: string;
  // Fallback: path đến thư mục theme đã extract (từ POST /import/github hoặc /import/theme)
  themeDir?: string;

  // ── DB source (chọn 1) ────────────────────────────────────────
  // Mode A: path đến file .sql đã upload (từ POST /import/sql)
  sqlFilePath?: string;
  // Mode B: credentials kết nối trực tiếp WP DB
  dbCredentials?: WpDbCredentials;

  // ── Output ────────────────────────────────────────────────────
  githubRepoB?: string;
  githubTokenB?: string;
}

@Controller('pipeline')
export class OrchestratorController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post('run')
  run(@Body() dto: RunPipelineDto) {
    return this.orchestratorService.run(dto);
  }

  @Get('status/:jobId')
  status(@Param('jobId') jobId: string) {
    return this.orchestratorService.getStatus(jobId);
  }
}
