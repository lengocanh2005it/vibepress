import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';

export interface EditRequestPromptOptions {
  audience?: 'planner' | 'visual-plan' | 'codegen' | 'section' | 'system';
  componentName?: string;
  route?: string | null;
  maxAttachments?: number;
}

export function buildEditRequestContextNote(
  editRequest?: PipelineEditRequestDto,
  options: EditRequestPromptOptions = {},
): string {
  if (!editRequest) return '';

  const {
    audience = 'codegen',
    componentName,
    route,
    maxAttachments = audience === 'planner' ? 5 : 3,
  } = options;
  const lines: string[] = ['## User edit request context'];
  lines.push(
    'Hard rule: always migrate the full site, even when the request mentions a single page or selected captures.',
  );
  lines.push(
    'Treat page references and capture notes as focus hints for extra fidelity, not as migration scope limits.',
  );

  if (editRequest.prompt) {
    lines.push(`Primary request: ${editRequest.prompt}`);
  }
  if (editRequest.language) {
    lines.push(`Preferred output language: ${editRequest.language}`);
  }

  if (editRequest.pageContext) {
    const pageFacts = [
      editRequest.pageContext.wordpressUrl
        ? `WordPress page: ${editRequest.pageContext.wordpressUrl}`
        : null,
      editRequest.pageContext.pageTitle
        ? `WordPress page title: ${editRequest.pageContext.pageTitle}`
        : null,
      editRequest.pageContext.reactRoute
        ? `React route hint: ${editRequest.pageContext.reactRoute}`
        : null,
      editRequest.pageContext.wordpressRoute
        ? `WordPress route hint: ${editRequest.pageContext.wordpressRoute}`
        : null,
      editRequest.pageContext.iframeSrc
        ? `Iframe source: ${editRequest.pageContext.iframeSrc}`
        : null,
      formatViewportLine(editRequest.pageContext.viewport),
      formatDocumentLine(editRequest.pageContext.document),
    ].filter((value): value is string => Boolean(value));

    if (pageFacts.length > 0) {
      lines.push(...pageFacts);
    }
  }

  if (editRequest.targetHint) {
    const targetParts = [
      editRequest.targetHint.componentName
        ? `component=${editRequest.targetHint.componentName}`
        : null,
      editRequest.targetHint.route
        ? `route=${editRequest.targetHint.route}`
        : null,
      editRequest.targetHint.templateName
        ? `template=${editRequest.targetHint.templateName}`
        : null,
      editRequest.targetHint.sectionType
        ? `sectionType=${editRequest.targetHint.sectionType}`
        : null,
      typeof editRequest.targetHint.sectionIndex === 'number'
        ? `sectionIndex=${editRequest.targetHint.sectionIndex}`
        : null,
    ].filter(Boolean);
    if (targetParts.length > 0) {
      lines.push(`Target hint: ${targetParts.join(', ')}`);
    }
  }

  if (editRequest.constraints) {
    const constraints = [
      editRequest.constraints.preserveOutsideSelection
        ? 'preserve content outside the selected area'
        : null,
      editRequest.constraints.preserveDataContract
        ? 'preserve existing API/data contracts'
        : null,
      editRequest.constraints.rerunFromScratch
        ? 'full regeneration is allowed'
        : null,
    ].filter(Boolean);
    if (constraints.length > 0) {
      lines.push(`Constraints: ${constraints.join('; ')}`);
    }
  }

  const explicitlyTargetedElsewhere = isExplicitlyTargetedElsewhere(
    editRequest,
    componentName,
    route,
  );

  if (componentName || route) {
    lines.push(
      `Current scope: component=${componentName ?? '(unknown)'}, route=${route ?? 'null'}`,
    );
  }

  if (explicitlyTargetedElsewhere) {
    lines.push(
      'This edit request appears to target a different component or route. Preserve this component unless the template/source clearly proves it is the intended target.',
    );
    return lines.join('\n');
  }

  const attachments = selectRelevantAttachments(
    editRequest.attachments,
    componentName,
    route,
  ).slice(0, maxAttachments);

  if (attachments.length > 0) {
    lines.push(
      `Selected captures (${attachments.length}/${editRequest.attachments?.length ?? attachments.length}):`,
    );
    for (const attachment of attachments) {
      lines.push(`- ${formatAttachmentLine(attachment)}`);
    }
    lines.push(
      'Treat screenshot URLs and selection boxes as authoritative visual evidence for the requested change.',
    );
    lines.push(
      'Use documentRect, normalizedRect, route, and DOM fingerprints to match each capture to the nearest section in the WordPress template source.',
    );
  } else if ((editRequest.attachments?.length ?? 0) > 0) {
    lines.push(
      'Selected captures exist for this edit request, but none can be confidently matched to the current scope. Do not force unrelated visual changes here.',
    );
  }

  if (audience !== 'planner') {
    lines.push(
      'Apply this request only where it matches the current component/route. Preserve the approved migration plan everywhere else.',
    );
  }

  return lines.join('\n');
}

function selectRelevantAttachments(
  attachments: PipelineCaptureAttachmentDto[] | undefined,
  componentName?: string,
  route?: string | null,
): PipelineCaptureAttachmentDto[] {
  if (!attachments?.length) return [];

  const scored = attachments.map((attachment) => ({
    attachment,
    score: scoreAttachment(attachment, componentName, route),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.attachment);
}

function scoreAttachment(
  attachment: PipelineCaptureAttachmentDto,
  componentName?: string,
  route?: string | null,
): number {
  let score = 0;
  if (attachment.note) score += 1;
  if (attachment.selection) score += 1;
  if (attachment.domTarget) score += 1;
  if (attachment.targetNode) score += 2;

  if (componentName && attachment.domTarget) {
    const domTokens = [
      attachment.domTarget.blockName,
      attachment.domTarget.blockClientId,
      attachment.domTarget.elementId,
      attachment.domTarget.tagName,
      attachment.domTarget.cssSelector,
      attachment.domTarget.domPath,
      attachment.domTarget.classNames?.join(' '),
      attachment.domTarget.nearestHeading,
      attachment.domTarget.nearestLandmark,
      attachment.domTarget.textSnippet,
    ]
      .filter(Boolean)
      .join(' ');
    if (fuzzyMatch(componentName, domTokens)) score += 5;
  }

  if (componentName && attachment.targetNode) {
    const targetTokens = [
      attachment.targetNode.templateName,
      attachment.targetNode.blockName,
      attachment.targetNode.tagName,
      attachment.targetNode.domPath,
      attachment.targetNode.nearestHeading,
      attachment.targetNode.nearestLandmark,
    ]
      .filter(Boolean)
      .join(' ');
    if (fuzzyMatch(componentName, targetTokens)) score += 6;
  }

  if (route) {
    if (routeMatchesPath(route, attachment.targetNode?.route)) score += 10;

    const pageRoute =
      attachment.captureContext?.page?.route ??
      toComparablePath(attachment.sourcePageUrl);
    if (routeMatchesPath(route, pageRoute)) score += 8;

    const sourcePath = toComparablePath(attachment.sourcePageUrl);
    if (routeMatchesPath(route, sourcePath)) score += 6;
  }

  return score;
}

function formatAttachmentLine(
  attachment: PipelineCaptureAttachmentDto,
): string {
  const parts = [`id=${attachment.id}`];

  if (attachment.note) {
    parts.push(`note="${truncate(attachment.note, 180)}"`);
  }
  if (attachment.sourcePageUrl) {
    parts.push(`sourcePage=${attachment.sourcePageUrl}`);
  }
  if (attachment.captureContext?.page?.route) {
    parts.push(`route=${attachment.captureContext.page.route}`);
  }
  if (attachment.captureContext?.page?.title) {
    parts.push(
      `pageTitle="${truncate(attachment.captureContext.page.title, 80)}"`,
    );
  }
  if (attachment.asset?.publicUrl) {
    parts.push(`image=${attachment.asset.publicUrl}`);
  }
  if (attachment.selection) {
    parts.push(
      `selection=(${attachment.selection.x},${attachment.selection.y},${attachment.selection.width},${attachment.selection.height}) ${attachment.selection.coordinateSpace ?? 'iframe-viewport'}`,
    );
  }
  const geometryLine = formatGeometryLine(attachment);
  if (geometryLine) {
    parts.push(geometryLine);
  }
  const targetNodeLine = formatTargetNodeLine(attachment);
  if (targetNodeLine) {
    parts.push(targetNodeLine);
  }
  const viewportLine = formatViewportLine(attachment.captureContext?.viewport);
  if (viewportLine) {
    parts.push(viewportLine.replace(/^Viewport: /, 'viewport='));
  }
  const documentLine = formatDocumentLine(attachment.captureContext?.document);
  if (documentLine) {
    parts.push(documentLine.replace(/^Document: /, 'document='));
  }
  if (attachment.captureContext?.capturedAt) {
    parts.push(`capturedAt=${attachment.captureContext.capturedAt}`);
  }
  const domTarget = formatDomTarget(attachment);
  if (domTarget) {
    parts.push(`dom=${domTarget}`);
  }

  return parts.join(' | ');
}

function formatViewportLine(
  viewport?:
    | {
        width: number;
        height: number;
        scrollX?: number;
        scrollY?: number;
        dpr?: number;
      }
    | undefined,
): string | null {
  if (!viewport) return null;
  const parts = [
    `${viewport.width}x${viewport.height}`,
    typeof viewport.scrollX === 'number' || typeof viewport.scrollY === 'number'
      ? `scroll=(${viewport.scrollX ?? 0},${viewport.scrollY ?? 0})`
      : null,
    typeof viewport.dpr === 'number' ? `dpr=${viewport.dpr}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `Viewport: ${parts.join(' ')}` : null;
}

function formatDocumentLine(
  document?:
    | {
        width: number;
        height: number;
      }
    | undefined,
): string | null {
  if (!document) return null;
  return `Document: ${document.width}x${document.height}`;
}

function formatGeometryLine(
  attachment: PipelineCaptureAttachmentDto,
): string | null {
  const parts: string[] = [];

  if (attachment.geometry?.viewportRect) {
    parts.push(
      `viewportRect=(${attachment.geometry.viewportRect.x},${attachment.geometry.viewportRect.y},${attachment.geometry.viewportRect.width},${attachment.geometry.viewportRect.height})`,
    );
  }
  if (attachment.geometry?.documentRect) {
    parts.push(
      `documentRect=(${attachment.geometry.documentRect.x},${attachment.geometry.documentRect.y},${attachment.geometry.documentRect.width},${attachment.geometry.documentRect.height})`,
    );
  }
  if (attachment.geometry?.normalizedRect) {
    parts.push(
      `normalizedRect=(${attachment.geometry.normalizedRect.x},${attachment.geometry.normalizedRect.y},${attachment.geometry.normalizedRect.width},${attachment.geometry.normalizedRect.height})`,
    );
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

function formatTargetNodeLine(
  attachment: PipelineCaptureAttachmentDto,
): string | null {
  if (!attachment.targetNode) return null;

  const parts = [
    attachment.targetNode.nodeId
      ? `node=${attachment.targetNode.nodeId}`
      : null,
    attachment.targetNode.templateName
      ? `template=${attachment.targetNode.templateName}`
      : null,
    attachment.targetNode.route
      ? `targetRoute=${attachment.targetNode.route}`
      : null,
    attachment.targetNode.blockName
      ? `block=${attachment.targetNode.blockName}`
      : null,
    attachment.targetNode.blockClientId
      ? `blockClientId=${attachment.targetNode.blockClientId}`
      : null,
    attachment.targetNode.tagName
      ? `targetTag=${attachment.targetNode.tagName}`
      : null,
    attachment.targetNode.domPath
      ? `targetPath=${attachment.targetNode.domPath}`
      : null,
    attachment.targetNode.nearestHeading
      ? `targetHeading="${truncate(attachment.targetNode.nearestHeading, 60)}"`
      : null,
    attachment.targetNode.nearestLandmark
      ? `targetLandmark=${attachment.targetNode.nearestLandmark}`
      : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : null;
}

function formatDomTarget(
  attachment: PipelineCaptureAttachmentDto,
): string | null {
  if (!attachment.domTarget) return null;
  const parts = [
    attachment.domTarget.blockName,
    attachment.domTarget.elementId
      ? `#${attachment.domTarget.elementId}`
      : null,
    attachment.domTarget.cssSelector,
    attachment.domTarget.domPath
      ? `path=${attachment.domTarget.domPath}`
      : null,
    attachment.domTarget.nearestLandmark
      ? `landmark=${attachment.domTarget.nearestLandmark}`
      : null,
    attachment.domTarget.nearestHeading
      ? `heading="${truncate(attachment.domTarget.nearestHeading, 60)}"`
      : null,
    attachment.domTarget.textSnippet
      ? `"${truncate(attachment.domTarget.textSnippet, 80)}"`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function isExplicitlyTargetedElsewhere(
  editRequest: PipelineEditRequestDto,
  componentName?: string,
  route?: string | null,
): boolean {
  const target = editRequest.targetHint;
  if (!target) return false;

  if (target.componentName && componentName) {
    return !fuzzyMatch(target.componentName, componentName);
  }

  if (target.route && route) {
    return !routeMatchesPath(target.route, route);
  }

  return false;
}

function fuzzyMatch(a: string, b: string): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function routeMatchesPath(
  route?: string | null,
  path?: string | null,
): boolean {
  if (!route || !path) return false;
  const normalizedRoute = normalizeRoute(route);
  const normalizedPath = normalizeRoute(path);
  if (!normalizedRoute || !normalizedPath) return false;
  if (normalizedRoute === normalizedPath) return true;
  if (normalizedRoute === '/') return normalizedPath === '/';
  return normalizedPath.startsWith(`${normalizedRoute}/`);
}

function normalizeRoute(value?: string | null): string | null {
  if (!value) return null;
  const withoutDynamicSegments = value
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');
  return withoutDynamicSegments || '/';
}

function toComparablePath(value?: string): string | null {
  if (!value) return null;
  try {
    return normalizeRoute(new URL(value).pathname);
  } catch {
    return normalizeRoute(value);
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
