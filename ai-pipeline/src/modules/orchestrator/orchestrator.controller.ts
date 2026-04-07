import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { OrchestratorService } from './orchestrator.service.js';

export interface RunPipelineDto {
  themeGithubUrl: string;
  dbConnectionString: string;
}

@Controller('pipeline')
export class OrchestratorController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post('run')
  run(@Body('siteId') siteId: string) {
    return this.orchestratorService.run(siteId);
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
