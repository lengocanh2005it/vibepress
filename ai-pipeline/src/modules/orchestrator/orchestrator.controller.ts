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

export interface PipelineCaptureAssetDto {
  provider: 'local' | 'cloudinary' | 'imagekit';
  fileName: string;
  publicUrl: string;
  storagePath?: string;
  originalPath?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes?: number;
  width?: number;
  height?: number;
  createdAt?: string;
  providerAssetId?: string;
  providerAssetPath?: string;
  format?: string;
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

export interface PipelineAttachmentCaptureContextDto {
  capturedAt?: string;
  iframeSrc?: string;
  viewport?: PipelineViewportDto;
}

export interface PipelineCaptureAttachmentDto {
  id: string;
  note?: string;
  sourcePageUrl?: string;
  asset: PipelineCaptureAssetDto;
  captureContext?: PipelineAttachmentCaptureContextDto;
  selection?: PipelineCaptureBBoxDto;
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
  prompt: string;
  language?: string;
  pageContext?: PipelineEditPageContextDto;
  attachments?: PipelineCaptureAttachmentDto[];
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

interface LegacyPipelineEditRequestDto {
  userPrompt?: string;
  language?: string;
  pageContext?: PipelineEditPageContextDto;
  capture?: {
    bbox?: PipelineCaptureBBoxDto;
    croppedScreenshot?: {
      url?: string;
      mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    };
    domTarget?: PipelineDomTargetDto;
  };
  captures?: Array<{
    id: string;
    fileName?: string;
    filePath?: string;
    url?: string;
    comment?: string;
    pageUrl?: string;
    capturedAt?: string;
    iframeSrc?: string;
    viewport?: PipelineViewportDto;
    provider?: 'local' | 'cloudinary' | 'imagekit';
    bytes?: number;
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    width?: number;
    height?: number;
    createdAt?: string;
    publicId?: string;
    fileId?: string;
    providerFilePath?: string;
    originalPath?: string;
    format?: string;
    bbox?: PipelineCaptureBBoxDto;
    domTarget?: PipelineDomTargetDto;
  }>;
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

export interface RunPipelineRequestDto {
  siteId: string;
  editRequest?: PipelineEditRequestDto | LegacyPipelineEditRequestDto;
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
  run(@Body() body: RunPipelineRequestDto) {
    const siteId = body?.siteId?.trim();
    if (!siteId) {
      throw new BadRequestException('siteId is required');
    }

    const editRequest = this.normalizeEditRequest(body.editRequest);
    return this.orchestratorService.run(siteId, editRequest);
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

  private normalizeEditRequest(
    raw?: PipelineEditRequestDto | LegacyPipelineEditRequestDto,
  ): PipelineEditRequestDto | undefined {
    if (!raw) return undefined;

    if ('prompt' in raw) {
      return raw;
    }

    const legacy = raw as LegacyPipelineEditRequestDto;
    const attachments: PipelineCaptureAttachmentDto[] = [];

    if (Array.isArray(legacy.captures)) {
      for (const capture of legacy.captures) {
        if (!capture?.id || !capture.url) continue;
        attachments.push({
          id: capture.id,
          note: capture.comment,
          sourcePageUrl: capture.pageUrl,
          asset: {
            provider: capture.provider ?? 'local',
            fileName: capture.fileName ?? capture.filePath?.split('/').pop() ?? capture.id,
            publicUrl: capture.url,
            storagePath: capture.filePath,
            originalPath: capture.originalPath,
            mimeType: capture.mimeType,
            bytes: capture.bytes,
            width: capture.width,
            height: capture.height,
            createdAt: capture.createdAt,
            providerAssetId: capture.publicId ?? capture.fileId,
            providerAssetPath: capture.providerFilePath,
            format: capture.format,
          },
          captureContext: {
            capturedAt: capture.capturedAt,
            iframeSrc: capture.iframeSrc,
            viewport: capture.viewport,
          },
          selection: capture.bbox,
          domTarget: capture.domTarget,
        });
      }
    } else if (legacy.capture?.croppedScreenshot?.url) {
      attachments.push({
        id: 'legacy-capture',
        asset: {
          provider: 'local',
          fileName:
            legacy.capture.croppedScreenshot.url.split('/').pop() ??
            'legacy-capture.png',
          publicUrl: legacy.capture.croppedScreenshot.url,
          mimeType: legacy.capture.croppedScreenshot.mimeType,
        },
        captureContext: {
          viewport: legacy.pageContext?.viewport,
          iframeSrc: legacy.pageContext?.iframeSrc,
        },
        selection: legacy.capture.bbox,
        domTarget: legacy.capture.domTarget,
      });
    }

    return {
      prompt: legacy.userPrompt ?? '',
      language: legacy.language,
      pageContext: legacy.pageContext,
      attachments,
      targetHint: legacy.targetHint,
      constraints: legacy.constraints,
    };
  }
}
