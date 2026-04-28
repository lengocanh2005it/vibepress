import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { EditRequestFacadeService } from '../edit-request/edit-request.facade.service.js';
import type {
  ApplyPendingEditRequestDto,
  RunPipelineRequestDto,
  SkipPendingEditRequestDto,
  SubmitReactVisualEditDto,
  UndoReactVisualEditDto,
} from './orchestrator.dto.js';
import { OrchestratorService } from './orchestrator.service.js';

@Controller('pipeline')
export class OrchestratorController {
  constructor(
    private readonly orchestratorService: OrchestratorService,
    private readonly editRequestFacade: EditRequestFacadeService,
  ) {}

  @Post('run')
  async run(@Body() body: RunPipelineRequestDto) {
    const siteId = body?.siteId?.trim();
    if (!siteId) {
      throw new BadRequestException('siteId is required');
    }
    const resolvedEditRequest = await this.editRequestFacade.resolveOrThrow(
      body.editRequest,
    );
    return this.orchestratorService.run(siteId, resolvedEditRequest);
  }

  @Post('react-visual-edit')
  async submitReactVisualEdit(@Body() body: SubmitReactVisualEditDto) {
    const siteId = body?.siteId?.trim();
    const jobId = body?.jobId?.trim();
    if (!siteId) {
      throw new BadRequestException('siteId is required');
    }
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    if (!body?.editRequest?.reactSourceTarget) {
      throw new BadRequestException(
        'editRequest.reactSourceTarget is required',
      );
    }
    return this.orchestratorService.submitReactVisualEdit(body);
  }

  @Post('approve-pending-edit')
  async approvePendingEdit(@Body() body: ApplyPendingEditRequestDto) {
    const siteId = body?.siteId?.trim();
    const jobId = body?.jobId?.trim();
    if (!siteId) {
      throw new BadRequestException('siteId is required');
    }
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    return this.orchestratorService.approvePendingEditRequest(body);
  }

  @Post('skip-pending-edit')
  async skipPendingEdit(@Body() body: SkipPendingEditRequestDto) {
    const siteId = body?.siteId?.trim();
    const jobId = body?.jobId?.trim();
    if (!siteId) {
      throw new BadRequestException('siteId is required');
    }
    if (!jobId) {
      throw new BadRequestException('jobId is required');
    }
    return this.orchestratorService.skipPendingEditRequest(body);
  }

  @Post('react-visual-edit/undo')
  async undoReactVisualEdit(@Body() body: UndoReactVisualEditDto) {
    const siteId = body?.siteId?.trim();
    const jobId = body?.jobId?.trim();
    if (!siteId) throw new BadRequestException('siteId is required');
    if (!jobId) throw new BadRequestException('jobId is required');
    return this.orchestratorService.undoLastReactEdit({ jobId, siteId });
  }

  @Get('status/:jobId')
  status(@Param('jobId') jobId: string) {
    return this.orchestratorService.getStatus(jobId);
  }

  @Post('stop/:jobId')
  stop(@Param('jobId') jobId: string) {
    return this.orchestratorService.stop(jobId);
  }

  @Post('delete/:jobId')
  delete(@Param('jobId') jobId: string) {
    return this.orchestratorService.delete(jobId);
  }

  @Sse('progress/:jobId')
  progress(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return this.orchestratorService
      .getProgressStream(jobId)
      .pipe(map((event) => ({ data: event }) as MessageEvent));
  }
}
