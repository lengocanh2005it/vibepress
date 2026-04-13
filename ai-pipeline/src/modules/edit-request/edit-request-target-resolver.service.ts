import { Injectable } from '@nestjs/common';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
  PipelineEditTargetHintDto,
} from '../orchestrator/orchestrator.dto.js';

@Injectable()
export class EditRequestTargetResolverService {
  resolve(
    request?: PipelineEditRequestDto,
  ): PipelineEditRequestDto | undefined {
    if (!request) return request;

    const baseTargetHint = request.targetHint;
    const primaryAttachment = this.pickPrimaryAttachment(request.attachments);

    const route =
      normalizeRoute(baseTargetHint?.route) ??
      normalizeRoute(primaryAttachment?.targetNode?.route) ??
      normalizeRoute(primaryAttachment?.captureContext?.page?.route) ??
      normalizeRoute(request.pageContext?.wordpressRoute) ??
      undefined;

    const templateName =
      normalizeTemplateName(baseTargetHint?.templateName) ??
      normalizeTemplateName(primaryAttachment?.targetNode?.templateName) ??
      inferTemplateNameFromRoute(route) ??
      undefined;

    const componentName =
      normalizeComponentName(baseTargetHint?.componentName) ??
      deriveComponentName(templateName) ??
      deriveComponentNameFromRoute(route) ??
      undefined;

    const sectionType =
      normalizeSectionType(baseTargetHint?.sectionType) ??
      inferSectionType(primaryAttachment) ??
      undefined;

    const sectionIndex =
      typeof baseTargetHint?.sectionIndex === 'number'
        ? baseTargetHint.sectionIndex
        : inferSectionIndex(primaryAttachment);

    const targetHint = compactObject<PipelineEditTargetHintDto>({
      ...baseTargetHint,
      route,
      templateName,
      componentName,
      sectionType,
      sectionIndex,
    });

    if (!hasMeaningfulTargetHint(targetHint)) {
      return request;
    }

    return {
      ...request,
      targetHint,
    };
  }

  private pickPrimaryAttachment(
    attachments?: PipelineCaptureAttachmentDto[],
  ): PipelineCaptureAttachmentDto | undefined {
    if (!attachments?.length) return undefined;

    return [...attachments].sort((left, right) => {
      return this.scoreAttachment(right) - this.scoreAttachment(left);
    })[0];
  }

  private scoreAttachment(attachment: PipelineCaptureAttachmentDto): number {
    let score = 0;

    if (attachment.note) score += 2;
    if (attachment.targetNode?.templateName) score += 10;
    if (attachment.targetNode?.route) score += 8;
    if (attachment.targetNode?.blockName) score += 6;
    if (attachment.targetNode?.nearestHeading) score += 4;
    if (attachment.geometry?.normalizedRect) score += 4;
    if (attachment.geometry?.documentRect) score += 3;
    if (attachment.selection) score += 2;
    if (attachment.captureContext?.page?.route) score += 2;

    return score;
  }
}

function inferTemplateNameFromRoute(route?: string | null): string | undefined {
  const normalizedRoute = normalizeRoute(route);
  if (!normalizedRoute) return undefined;
  if (normalizedRoute === '/') return 'home';

  const slug = normalizedRoute.split('/').filter(Boolean).pop();

  return slug ? slug.toLowerCase() : undefined;
}

function deriveComponentName(templateName?: string): string | undefined {
  const normalizedTemplateName = normalizeTemplateName(templateName);
  if (!normalizedTemplateName) return undefined;

  const name = normalizedTemplateName
    .replace(/\.(php|html)$/, '')
    .split(/[\\/_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  if (!name) return undefined;
  return /^\d/.test(name) ? `Page${name}` : name;
}

function deriveComponentNameFromRoute(
  route?: string | null,
): string | undefined {
  const templateName = inferTemplateNameFromRoute(route);
  return deriveComponentName(templateName);
}

function inferSectionType(
  attachment?: PipelineCaptureAttachmentDto,
): string | undefined {
  if (!attachment) return undefined;

  const signal = normalizeSearchText(
    [
      attachment.targetNode?.blockName,
      attachment.targetNode?.tagName,
      attachment.targetNode?.domPath,
      attachment.targetNode?.nearestHeading,
      attachment.targetNode?.nearestLandmark,
      attachment.domTarget?.blockName,
      attachment.domTarget?.tagName,
      attachment.domTarget?.domPath,
      attachment.domTarget?.nearestHeading,
      attachment.domTarget?.nearestLandmark,
      attachment.note,
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (!signal) return undefined;
  if (/\b(hero|banner|cover)\b/.test(signal)) return 'hero';
  if (/\b(header|navigation|navbar|menu)\b/.test(signal)) return 'header';
  if (/\bfooter\b/.test(signal)) return 'footer';
  if (/\bcta|button|call to action\b/.test(signal)) return 'cta';
  if (/\bfaq|accordion\b/.test(signal)) return 'faq';
  if (/\btestimonial|review|quote\b/.test(signal)) return 'testimonial';
  if (/\bpricing|price|plan\b/.test(signal)) return 'pricing';
  if (/\bfeature|benefit|service\b/.test(signal)) return 'features';
  if (/\bcontact|form|signup|newsletter|chat|search|filter\b/.test(signal)) {
    return 'interactive';
  }
  if (/\bgallery|image|media|video\b/.test(signal)) return 'media';
  if (/\bposts|post|query|blog|article\b/.test(signal)) return 'posts';
  if (/\bsidebar|aside\b/.test(signal)) return 'sidebar';
  if (/\bmain\b/.test(signal)) return 'main';
  if (/\bsection|group|columns|column|container\b/.test(signal)) {
    return 'section';
  }

  return undefined;
}

function inferSectionIndex(
  attachment?: PipelineCaptureAttachmentDto,
): number | undefined {
  const y =
    attachment?.geometry?.normalizedRect?.y ??
    deriveNormalizedY(
      attachment?.geometry?.documentRect?.y ?? attachment?.selection?.y,
      attachment?.captureContext?.document?.height,
    );

  if (typeof y !== 'number' || Number.isNaN(y)) {
    return undefined;
  }

  return Math.max(0, Math.min(9, Math.floor(y * 10)));
}

function deriveNormalizedY(
  y?: number,
  documentHeight?: number,
): number | undefined {
  if (
    typeof y !== 'number' ||
    Number.isNaN(y) ||
    typeof documentHeight !== 'number' ||
    Number.isNaN(documentHeight) ||
    documentHeight <= 0
  ) {
    return undefined;
  }

  return clampRatio(y / documentHeight);
}

function normalizeRoute(route?: string | null): string | null {
  if (!route) return null;

  const normalized = route
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');

  return normalized || '/';
}

function normalizeTemplateName(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  return normalized || undefined;
}

function normalizeComponentName(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeSectionType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, '-');
  return normalized || undefined;
}

function normalizeSearchText(value: string): string {
  return stripVietnameseMarks(value.trim().toLowerCase());
}

function stripVietnameseMarks(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function clampRatio(value: number): number {
  return Math.min(Math.max(roundMetric(value), 0), 1);
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hasMeaningfulTargetHint(
  targetHint?: PipelineEditTargetHintDto,
): boolean {
  return Boolean(
    targetHint?.route ||
    targetHint?.templateName ||
    targetHint?.componentName ||
    targetHint?.sectionType ||
    typeof targetHint?.sectionIndex === 'number',
  );
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
