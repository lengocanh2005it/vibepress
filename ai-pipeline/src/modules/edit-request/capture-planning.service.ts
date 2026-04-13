import { Injectable } from '@nestjs/common';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';

@Injectable()
export class CapturePlanningService {
  buildPlanningRequest(
    request?: PipelineEditRequestDto,
  ): PipelineEditRequestDto | undefined {
    if (!request) return undefined;

    const attachments = this.selectPlanningAttachments(request).slice(0, 5);
    const hasMeaningfulPlanningContext = Boolean(
      request.prompt ||
      request.language ||
      request.pageContext ||
      request.targetHint ||
      request.constraints ||
      attachments.length > 0,
    );

    if (!hasMeaningfulPlanningContext) return undefined;

    return compactObject({
      prompt: request.prompt,
      language: request.language,
      pageContext: request.pageContext,
      targetHint: request.targetHint,
      constraints: request.constraints,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  scopeRequestToComponent(input: {
    request?: PipelineEditRequestDto;
    componentName?: string;
    route?: string | null;
    maxAttachments?: number;
  }): PipelineEditRequestDto | undefined {
    const { request, componentName, route, maxAttachments = 3 } = input;
    if (!request) return undefined;

    const attachments = this.selectRelevantAttachments(
      request.attachments,
      componentName,
      route,
    ).slice(0, maxAttachments);

    return compactObject({
      ...request,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  private selectPlanningAttachments(
    request: PipelineEditRequestDto,
  ): PipelineCaptureAttachmentDto[] {
    if (!request.attachments?.length) return [];

    const hintedRoute =
      normalizeRoute(request.targetHint?.route) ??
      normalizeRoute(request.pageContext?.reactRoute) ??
      normalizeRoute(request.pageContext?.wordpressRoute) ??
      normalizeRoute(request.pageContext?.wordpressUrl);

    return request.attachments
      .map((attachment) => ({
        attachment,
        score: this.scorePlanningAttachment(attachment, hintedRoute),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.attachment);
  }

  private selectRelevantAttachments(
    attachments: PipelineCaptureAttachmentDto[] | undefined,
    componentName?: string,
    route?: string | null,
  ): PipelineCaptureAttachmentDto[] {
    if (!attachments?.length) return [];

    return attachments
      .map((attachment) => ({
        attachment,
        score: this.scoreScopedAttachment(attachment, componentName, route),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.attachment);
  }

  private scorePlanningAttachment(
    attachment: PipelineCaptureAttachmentDto,
    hintedRoute?: string | null,
  ): number {
    let score = 0;
    if (attachment.note) score += 5;
    if (attachment.selection || attachment.geometry?.documentRect) score += 3;
    if (attachment.targetNode) score += 4;
    if (attachment.domTarget) score += 2;
    if (attachment.asset?.publicUrl) score += 2;
    if (attachment.captureContext?.page?.route) score += 2;

    if (hintedRoute) {
      const pageRoute =
        normalizeRoute(attachment.captureContext?.page?.route) ??
        normalizeRoute(attachment.sourcePageUrl) ??
        normalizeRoute(attachment.targetNode?.route);
      if (pageRoute && routeMatchesPath(hintedRoute, pageRoute)) score += 8;
    }

    return score;
  }

  private scoreScopedAttachment(
    attachment: PipelineCaptureAttachmentDto,
    componentName?: string,
    route?: string | null,
  ): number {
    let score = 0;
    if (attachment.note) score += 1;
    if (attachment.selection || attachment.geometry?.documentRect) score += 1;
    if (attachment.domTarget) score += 1;
    if (attachment.targetNode) score += 2;

    if (route) {
      if (routeMatchesPath(route, attachment.targetNode?.route)) score += 12;

      const pageRoute =
        normalizeRoute(attachment.captureContext?.page?.route) ??
        normalizeRoute(attachment.sourcePageUrl);
      if (pageRoute && routeMatchesPath(route, pageRoute)) score += 10;
    }

    if (componentName) {
      const tokens = [
        attachment.targetNode?.templateName,
        attachment.targetNode?.blockName,
        attachment.targetNode?.nearestHeading,
        attachment.targetNode?.nearestLandmark,
        attachment.targetNode?.domPath,
        attachment.domTarget?.blockName,
        attachment.domTarget?.nearestHeading,
        attachment.domTarget?.nearestLandmark,
        attachment.domTarget?.domPath,
        attachment.note,
      ]
        .filter(Boolean)
        .join(' ');
      if (fuzzyMatch(componentName, tokens)) score += 8;
    }

    return score;
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) {
      result[key] = entry;
    }
  }
  return result as T;
}

function normalizeRoute(value?: string | null): string | null {
  if (!value) return null;
  try {
    value = new URL(value).pathname;
  } catch {
    value = value.startsWith('/') ? value : `/${value}`;
  }
  const normalized = value
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');
  return normalized || '/';
}

function routeMatchesPath(
  expected?: string | null,
  actual?: string | null,
): boolean {
  const left = normalizeRoute(expected);
  const right = normalizeRoute(actual);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left === '/') return right === '/';
  return right.startsWith(`${left}/`);
}

function fuzzyMatch(a?: string | null, b?: string | null): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

function normalizeToken(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}
