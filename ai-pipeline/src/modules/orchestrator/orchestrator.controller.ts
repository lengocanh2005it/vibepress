import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { OrchestratorService } from './orchestrator.service.js';

export interface PipelineViewportDto {
  width: number;
  height: number;
  scrollX?: number;
  scrollY?: number;
  dpr?: number;
}

export interface PipelineCaptureBBoxDto {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: 'iframe-viewport' | 'iframe-document';
}

export interface PipelineScreenshotDto {
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  base64?: string;
  url?: string;
}

export interface PipelineDomTargetDto {
  cssSelector?: string;
  xpath?: string;
  tagName?: string;
  elementId?: string;
  classNames?: string[];
  htmlSnippet?: string;
  textSnippet?: string;
  blockName?: string;
  blockClientId?: string;
}

export interface PipelineEditPageContextDto {
  reactUrl?: string;
  reactRoute?: string;
  wordpressUrl?: string;
  wordpressRoute?: string | null;
  iframeSrc?: string;
  viewport?: PipelineViewportDto;
}

export interface PipelineEditCaptureDto {
  bbox?: PipelineCaptureBBoxDto;
  fullPageScreenshot?: PipelineScreenshotDto;
  croppedScreenshot?: PipelineScreenshotDto;
  selectedText?: string;
  domTarget?: PipelineDomTargetDto;
}

export interface PipelineEditTargetHintDto {
  templateName?: string;
  componentName?: string;
  route?: string | null;
  sectionIndex?: number;
  sectionType?: string;
}

export interface PipelineEditConstraintsDto {
  preserveOutsideSelection?: boolean;
  preserveDataContract?: boolean;
  rerunFromScratch?: boolean;
}

export interface PipelineEditRequestDto {
  userPrompt: string;
  language?: string;
  pageContext?: PipelineEditPageContextDto;
  capture?: PipelineEditCaptureDto;
  captures?: Array<{
    id: string;
    filePath: string;
    url: string;
    comment?: string;
    pageUrl?: string;
  }>;
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

export interface RunPipelineDto {
  themeGithubUrl: string;
  dbConnectionString: string;
  editRequest?: PipelineEditRequestDto;
}

@Controller('pipeline')
export class OrchestratorController {
  constructor(private readonly orchestratorService: OrchestratorService) {}

  @Post('run')
  run(
    @Body('siteId') siteId: string,
    @Body('editRequest') editRequest?: PipelineEditRequestDto,
  ) {
    return this.orchestratorService.run(siteId, editRequest);
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
