import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { OrchestratorService } from './orchestrator.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

/**
 * Per-step model overrides for the pipeline.
 * Each field is optional — omitting it falls back to the default model
 * resolved from environment variables (AI_PROVIDER + *_MODEL).
 *
 * Agents that only run deterministic logic (normalizer, plan-reviewer,
 * code-generator, validator, api-builder, preview-builder) are not listed
 * here because they never call an LLM.
 */
export interface PipelineModelConfig {
  /** Model for Planner Phase A (architecture plan) + Phase C (visual sections per component) */
  planning?: string;
  /** Model for React code generation in the generator stage */
  genCode?: string;
  /** Model for review/repair passes in the generator stage */
  reviewCode?: string;
  /** Model for backend/API review after server generation */
  backendReview?: string;
  /** @deprecated use `planning` */
  planner?: string;
  /** @deprecated use `reviewCode` */
  codeReviewer?: string;
  /** Optional override for the repair pass. Defaults to reviewCode if omitted. */
  fixAgent?: string;
}

export interface RunPipelineDto {
  // ── Theme source (chọn 1) ──────────────────────────────────────
  // Mode D (chính): GitHub repo chứa WP theme source
  themeGithubUrl?: string;
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
  /** Absolute path on the local machine to copy generated TSX files into for inspection.
   *  Files are written to {localOutputDir}/pages/ and {localOutputDir}/components/.
   *  The directory is created if it does not exist. */
  localOutputDir?: string;

  // ── Per-step model overrides ──────────────────────────────────
  modelConfig?: PipelineModelConfig;
}

@Controller('pipeline')
export class OrchestratorController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post('run')
  run(@Body('email') email: string) {
    return this.orchestratorService.run(email);
  }

  @Get('status/:jobId')
  status(@Param('jobId') jobId: string) {
    return this.orchestratorService.getStatus(jobId);
  }

  @Sse('progress/:jobId')
  progress(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return this.orchestratorService
      .getProgressStream(jobId)
      .pipe(map((event) => ({ data: event }) as MessageEvent));
  }
}
