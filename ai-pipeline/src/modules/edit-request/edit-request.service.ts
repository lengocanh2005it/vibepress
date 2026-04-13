import { Injectable } from '@nestjs/common';
import type {
  LegacyPipelineEditRequestDto,
  PipelineClientEditRequestDto,
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
  PipelineEditPageContextDto,
  PipelineIncomingEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';
import type {
  EditRequestPreparationResult,
  EditRequestPreparationSummary,
} from './edit-request.types.js';

@Injectable()
export class EditRequestService {
  prepare(raw?: PipelineIncomingEditRequestDto): EditRequestPreparationResult {
    if (!raw) {
      return {
        raw,
        request: undefined,
        summary: this.buildSummary(undefined, 'empty'),
      };
    }

    const requestFormat = isCurrentEditRequest(raw) ? 'current' : 'legacy';
    const request =
      requestFormat === 'current'
        ? this.normalizeCurrentRequest(raw)
        : this.normalizeLegacyRequest(raw);

    const meaningfulRequest = this.isMeaningfulRequest(request)
      ? request
      : undefined;

    return {
      raw,
      request: meaningfulRequest,
      summary: this.buildSummary(meaningfulRequest, requestFormat),
    };
  }

  private normalizeCurrentRequest(
    request: PipelineClientEditRequestDto,
  ): PipelineEditRequestDto {
    const pageContext = this.normalizePageContext(request.pageContext);
    const attachments = this.normalizeAttachments(
      request.attachments,
      pageContext,
    );
    const prompt = request.prompt?.trim() ?? '';
    const language = normalizeRequestedLanguage(
      request.language,
      prompt,
      attachments,
    );
    return {
      ...request,
      prompt,
      language,
      pageContext,
      attachments,
    };
  }

  private normalizeLegacyRequest(
    legacy: LegacyPipelineEditRequestDto,
  ): PipelineEditRequestDto {
    const attachments: PipelineCaptureAttachmentDto[] = [];

    if (Array.isArray(legacy.captures)) {
      for (const capture of legacy.captures) {
        const publicUrl = capture?.url?.trim();
        if (!capture?.id || !publicUrl) continue;
        attachments.push({
          id: capture.id,
          note: capture.comment?.trim() || undefined,
          sourcePageUrl: capture.pageUrl?.trim() || undefined,
          asset: {
            provider: capture.provider ?? 'local',
            fileName:
              capture.fileName ??
              capture.filePath?.split('/').pop() ??
              capture.id,
            publicUrl,
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
            page: {
              url: capture.pageUrl?.trim() || undefined,
              route: toComparablePath(capture.pageUrl),
            },
            document: capture.document,
          },
          selection: capture.bbox,
          geometry: capture.geometry,
          domTarget: capture.domTarget,
          targetNode: capture.targetNode,
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
          page: {
            url: legacy.pageContext?.wordpressUrl,
            route:
              legacy.pageContext?.wordpressRoute ??
              toComparablePath(legacy.pageContext?.wordpressUrl),
            title: legacy.pageContext?.pageTitle,
          },
          document: legacy.pageContext?.document,
        },
        selection: legacy.capture.bbox,
        domTarget: legacy.capture.domTarget,
        targetNode: legacy.capture.targetNode,
      });
    }

    const prompt = legacy.userPrompt?.trim() ?? '';
    const language = normalizeRequestedLanguage(
      legacy.language,
      prompt,
      attachments,
    );

    return {
      prompt,
      language,
      pageContext: this.normalizePageContext(legacy.pageContext),
      attachments: this.normalizeAttachments(
        attachments,
        this.normalizePageContext(legacy.pageContext),
      ),
      targetHint: legacy.targetHint,
      constraints: legacy.constraints,
    };
  }

  private normalizePageContext(
    pageContext?: PipelineEditPageContextDto,
  ): PipelineEditPageContextDto | undefined {
    if (!pageContext) return undefined;

    const wordpressUrl = pageContext.wordpressUrl?.trim() || undefined;
    const reactUrl = pageContext.reactUrl?.trim() || undefined;
    const reactRoute = pageContext.reactRoute?.trim() || undefined;
    const iframeSrc = pageContext.iframeSrc?.trim() || undefined;
    const pageTitle = pageContext.pageTitle?.trim() || undefined;
    const wordpressRoute =
      pageContext.wordpressRoute?.trim() ||
      toComparablePath(wordpressUrl) ||
      undefined;

    return compactObject({
      ...pageContext,
      reactUrl,
      reactRoute,
      wordpressUrl,
      wordpressRoute,
      iframeSrc,
      pageTitle,
      document: normalizeDocumentDimensions(pageContext.document),
    });
  }

  private normalizeAttachments(
    attachments?: PipelineCaptureAttachmentDto[],
    pageContext?: PipelineEditPageContextDto,
  ): PipelineCaptureAttachmentDto[] | undefined {
    const normalized = (attachments ?? [])
      .filter((attachment) => attachment?.id && attachment?.asset?.publicUrl)
      .map((attachment) => this.normalizeAttachment(attachment, pageContext));

    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeAttachment(
    attachment: PipelineCaptureAttachmentDto,
    pageContext?: PipelineEditPageContextDto,
  ): PipelineCaptureAttachmentDto {
    const sourcePageUrl = attachment.sourcePageUrl?.trim() || undefined;
    const captureContext = compactObject({
      ...attachment.captureContext,
      capturedAt: attachment.captureContext?.capturedAt?.trim() || undefined,
      iframeSrc: attachment.captureContext?.iframeSrc?.trim() || undefined,
      page: {
        url:
          attachment.captureContext?.page?.url?.trim() ||
          sourcePageUrl ||
          pageContext?.wordpressUrl,
        route:
          attachment.captureContext?.page?.route?.trim() ||
          toComparablePath(
            attachment.captureContext?.page?.url ??
              sourcePageUrl ??
              pageContext?.wordpressUrl,
          ) ||
          pageContext?.wordpressRoute ||
          undefined,
        title:
          attachment.captureContext?.page?.title?.trim() ||
          pageContext?.pageTitle ||
          undefined,
      },
      document: normalizeDocumentDimensions(
        attachment.captureContext?.document ?? pageContext?.document,
      ),
    });

    const geometry =
      normalizeAttachmentGeometry(
        attachment.geometry,
        attachment.selection,
        attachment.captureContext?.viewport ?? pageContext?.viewport,
        captureContext.document,
      ) || undefined;

    return compactObject({
      ...attachment,
      note: attachment.note?.trim() || undefined,
      sourcePageUrl,
      captureContext,
      selection:
        geometry?.documentRect ??
        normalizeBoundingBox(attachment.selection) ??
        geometry?.viewportRect,
      geometry,
      asset: {
        ...attachment.asset,
        fileName: attachment.asset.fileName?.trim() || attachment.id,
        publicUrl: attachment.asset.publicUrl.trim(),
      },
      domTarget: normalizeDomTarget(attachment.domTarget),
      targetNode: normalizeTargetNode(
        attachment.targetNode,
        sourcePageUrl,
        captureContext.page?.route,
      ),
    });
  }

  private isMeaningfulRequest(request: PipelineEditRequestDto): boolean {
    return Boolean(
      request.prompt ||
      request.attachments?.length ||
      request.targetHint ||
      request.constraints,
    );
  }

  private buildSummary(
    request: PipelineEditRequestDto | undefined,
    source: EditRequestPreparationSummary['source'],
  ): EditRequestPreparationSummary {
    const attachmentCount = request?.attachments?.length ?? 0;
    const hasVisualContext = Boolean(
      request?.pageContext?.iframeSrc ||
      request?.pageContext?.viewport ||
      request?.pageContext?.document ||
      request?.attachments?.some(
        (attachment) =>
          attachment.asset.publicUrl ||
          attachment.captureContext?.viewport ||
          attachment.captureContext?.iframeSrc ||
          attachment.captureContext?.document ||
          attachment.selection ||
          attachment.geometry ||
          attachment.domTarget ||
          attachment.targetNode,
      ),
    );

    return {
      source,
      attachmentCount,
      hasPrompt: Boolean(request?.prompt),
      hasVisualContext,
    };
  }
}

function normalizeRequestedLanguage(
  language: string | undefined,
  prompt: string,
  attachments?: PipelineCaptureAttachmentDto[],
): string | undefined {
  const normalizedLanguage = normalizeLanguageToken(language);
  if (normalizedLanguage) return normalizedLanguage;

  const combined = [
    prompt,
    ...(attachments ?? []).map((attachment) => attachment.note ?? ''),
  ]
    .join(' ')
    .trim();

  if (!combined) return undefined;
  return inferLanguageFromContent(combined);
}

function normalizeLanguageToken(language?: string): 'vi' | 'en' | undefined {
  const normalized = stripVietnameseMarks(language?.trim().toLowerCase() ?? '');
  if (!normalized) return undefined;

  if (['vi', 'vi-vn', 'vietnamese', 'tieng viet'].includes(normalized)) {
    return 'vi';
  }

  if (['en', 'en-us', 'en-gb', 'english'].includes(normalized)) {
    return 'en';
  }

  return undefined;
}

function inferLanguageFromContent(value: string): 'vi' | 'en' {
  const normalized = stripVietnameseMarks(value.toLowerCase());
  const hasVietnameseDiacritics = normalized !== value.toLowerCase();
  const hasVietnameseKeywords =
    /\b(hay|giup|toan bo|toan site|toan website|chuyen doi|dich chuyen|giu nguyen|dieu chinh|chinh sua|doi mau|trang chu|dau trang|chan trang|khu vuc)\b/.test(
      normalized,
    );

  return hasVietnameseDiacritics || hasVietnameseKeywords ? 'vi' : 'en';
}

function stripVietnameseMarks(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeDocumentDimensions(
  document?:
    | {
        width: number;
        height: number;
      }
    | undefined,
): { width: number; height: number } | undefined {
  if (!document) return undefined;

  const width = Number(document.width);
  const height = Number(document.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function normalizeBoundingBox(
  box?:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
        coordinateSpace?: 'iframe-viewport' | 'iframe-document';
      }
    | undefined,
) {
  if (!box) return undefined;

  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }

  return compactObject({
    x: roundMetric(x),
    y: roundMetric(y),
    width: roundMetric(Math.max(1, width)),
    height: roundMetric(Math.max(1, height)),
    coordinateSpace: box.coordinateSpace,
  });
}

function normalizeNormalizedBoundingBox(
  box?:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
        coordinateSpace?: 'iframe-document-normalized';
      }
    | undefined,
) {
  if (!box) return undefined;

  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }

  return compactObject({
    x: clampRatio(x),
    y: clampRatio(y),
    width: clampRatio(width),
    height: clampRatio(height),
    coordinateSpace: box.coordinateSpace ?? 'iframe-document-normalized',
  });
}

function normalizeAttachmentGeometry(
  geometry: PipelineCaptureAttachmentDto['geometry'] | undefined,
  selection: PipelineCaptureAttachmentDto['selection'] | undefined,
  viewport:
    | {
        width: number;
        height: number;
        scrollX?: number;
        scrollY?: number;
      }
    | undefined,
  document:
    | {
        width: number;
        height: number;
      }
    | undefined,
) {
  const viewportRect = normalizeBoundingBox(
    geometry?.viewportRect ??
      (selection?.coordinateSpace === 'iframe-viewport'
        ? selection
        : undefined),
  );
  const documentRect = normalizeBoundingBox(
    geometry?.documentRect ?? deriveDocumentRect(selection, viewport),
  );
  const normalizedRect = normalizeNormalizedBoundingBox(
    geometry?.normalizedRect ?? deriveNormalizedRect(documentRect, document),
  );

  if (!viewportRect && !documentRect && !normalizedRect) {
    return undefined;
  }

  return compactObject({
    viewportRect,
    documentRect,
    normalizedRect,
  });
}

function deriveDocumentRect(
  selection: PipelineCaptureAttachmentDto['selection'] | undefined,
  viewport:
    | {
        scrollX?: number;
        scrollY?: number;
      }
    | undefined,
) {
  const box = normalizeBoundingBox(selection);
  if (!box) return undefined;
  if (box.coordinateSpace === 'iframe-document') return box;
  if (box.coordinateSpace !== 'iframe-viewport') return undefined;

  return compactObject({
    ...box,
    x: roundMetric(box.x + Number(viewport?.scrollX ?? 0)),
    y: roundMetric(box.y + Number(viewport?.scrollY ?? 0)),
    coordinateSpace: 'iframe-document' as const,
  });
}

function deriveNormalizedRect(
  documentRect:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | undefined,
  document:
    | {
        width: number;
        height: number;
      }
    | undefined,
) {
  if (!documentRect || !document) return undefined;

  return compactObject({
    x: clampRatio(documentRect.x / Math.max(1, document.width)),
    y: clampRatio(documentRect.y / Math.max(1, document.height)),
    width: clampRatio(documentRect.width / Math.max(1, document.width)),
    height: clampRatio(documentRect.height / Math.max(1, document.height)),
    coordinateSpace: 'iframe-document-normalized' as const,
  });
}

function normalizeDomTarget(
  domTarget?: PipelineCaptureAttachmentDto['domTarget'],
) {
  if (!domTarget) return undefined;

  return compactObject({
    ...domTarget,
    cssSelector: domTarget.cssSelector?.trim() || undefined,
    xpath: domTarget.xpath?.trim() || undefined,
    tagName: domTarget.tagName?.trim() || undefined,
    elementId: domTarget.elementId?.trim() || undefined,
    classNames:
      domTarget.classNames
        ?.map((className) => className.trim())
        .filter(Boolean) || undefined,
    htmlSnippet: domTarget.htmlSnippet?.trim() || undefined,
    textSnippet: domTarget.textSnippet?.trim() || undefined,
    blockName: domTarget.blockName?.trim() || undefined,
    blockClientId: domTarget.blockClientId?.trim() || undefined,
    domPath: domTarget.domPath?.trim() || undefined,
    role: domTarget.role?.trim() || undefined,
    ariaLabel: domTarget.ariaLabel?.trim() || undefined,
    nearestHeading: domTarget.nearestHeading?.trim() || undefined,
    nearestLandmark: domTarget.nearestLandmark?.trim() || undefined,
  });
}

function normalizeTargetNode(
  targetNode?: PipelineCaptureAttachmentDto['targetNode'],
  sourcePageUrl?: string,
  pageRoute?: string | null,
) {
  if (!targetNode) return undefined;

  const ownerSourceNodeId = targetNode.ownerSourceNodeId?.trim() || undefined;
  const ownerSourceFile = targetNode.ownerSourceFile?.trim() || undefined;
  const ownerTemplateName = targetNode.ownerTemplateName?.trim() || undefined;
  const ownerTopLevelIndex = normalizeOptionalNumber(
    targetNode.ownerTopLevelIndex,
  );
  const editSourceNodeId = targetNode.editSourceNodeId?.trim() || undefined;
  const editSourceFile = targetNode.editSourceFile?.trim() || undefined;
  const editTemplateName = targetNode.editTemplateName?.trim() || undefined;
  const editTopLevelIndex = normalizeOptionalNumber(
    targetNode.editTopLevelIndex,
  );

  return compactObject({
    nodeId:
      targetNode.nodeId?.trim() || targetNode.ownerNodeId?.trim() || undefined,
    sourceNodeId:
      targetNode.sourceNodeId?.trim() || ownerSourceNodeId || undefined,
    sourceFile: targetNode.sourceFile?.trim() || ownerSourceFile || undefined,
    topLevelIndex:
      normalizeOptionalNumber(targetNode.topLevelIndex) ?? ownerTopLevelIndex,
    templateName:
      targetNode.templateName?.trim() || ownerTemplateName || undefined,
    ownerNodeId: targetNode.ownerNodeId?.trim() || undefined,
    ownerSourceNodeId,
    ownerSourceFile,
    ownerTopLevelIndex,
    ownerTemplateName,
    editNodeId: targetNode.editNodeId?.trim() || undefined,
    editSourceNodeId,
    editSourceFile,
    editTopLevelIndex,
    editTemplateName,
    editNodeRole: targetNode.editNodeRole?.trim() || undefined,
    editTagName: targetNode.editTagName?.trim() || undefined,
    ancestorSourceNodeIds: normalizeStringArray(
      targetNode.ancestorSourceNodeIds,
    ),
    route:
      targetNode.route?.trim() ||
      pageRoute ||
      toComparablePath(sourcePageUrl) ||
      undefined,
    blockName: targetNode.blockName?.trim() || undefined,
    blockClientId: targetNode.blockClientId?.trim() || undefined,
    tagName:
      targetNode.tagName?.trim() || targetNode.editTagName?.trim() || undefined,
    domPath: targetNode.domPath?.trim() || undefined,
    nearestHeading: targetNode.nearestHeading?.trim() || undefined,
    nearestLandmark: targetNode.nearestLandmark?.trim() || undefined,
  });
}

function toComparablePath(value?: string | null): string | null {
  if (!value) return null;
  try {
    const path = new URL(value).pathname.replace(/\/+$/g, '');
    return path || '/';
  } catch {
    const normalized = value.trim().replace(/\/+$/g, '');
    return normalized || '/';
  }
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampRatio(value: number): number {
  return Math.min(Math.max(roundMetric(value), 0), 1);
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeStringArray(values?: string[]): string[] | undefined {
  const normalized = values
    ?.map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return normalized && normalized.length > 0
    ? Array.from(new Set(normalized))
    : undefined;
}

function compactObject<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactObject(item))
      .filter((item) => item !== undefined) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const compactedEntries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [key, compactObject(entryValue)] as const)
    .filter(([, entryValue]) => entryValue !== undefined);

  return Object.fromEntries(compactedEntries) as T;
}

function isCurrentEditRequest(
  raw: PipelineIncomingEditRequestDto,
): raw is PipelineClientEditRequestDto {
  if ('attachments' in raw || 'prompt' in raw) {
    return true;
  }

  if ('captures' in raw || 'capture' in raw || 'userPrompt' in raw) {
    return false;
  }

  // Default ambiguous payloads to the current schema so attachment-free
  // requests still preserve the modern field layout.
  return true;
}
