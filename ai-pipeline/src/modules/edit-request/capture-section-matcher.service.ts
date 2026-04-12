import { Injectable } from '@nestjs/common';
import type { PlanResult } from '../agents/planner/planner.service.js';
import type { SectionPlan } from '../agents/react-generator/visual-plan.schema.js';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';

export interface CaptureSectionMatch {
  attachmentId: string;
  sectionIndex: number;
  sectionType: SectionPlan['type'];
  score: number;
  reasons: string[];
}

@Injectable()
export class CaptureSectionMatcherService {
  matchComponentSections(input: {
    componentPlan?: PlanResult[number];
    attachments?: PipelineCaptureAttachmentDto[];
    request?: PipelineEditRequestDto;
  }): CaptureSectionMatch[] {
    const { componentPlan, attachments, request } = input;
    const sections = componentPlan?.visualPlan?.sections ?? [];
    if (sections.length === 0) return [];

    const matches: CaptureSectionMatch[] = [];

    if (
      typeof request?.targetHint?.sectionIndex === 'number' &&
      request.targetHint.sectionIndex >= 0 &&
      request.targetHint.sectionIndex < sections.length
    ) {
      const section = sections[request.targetHint.sectionIndex];
      matches.push({
        attachmentId: 'target-hint',
        sectionIndex: request.targetHint.sectionIndex,
        sectionType: section.type,
        score: 30,
        reasons: ['request.targetHint.sectionIndex'],
      });
    }

    for (const attachment of attachments ?? []) {
      let best:
        | {
            sectionIndex: number;
            sectionType: SectionPlan['type'];
            score: number;
            reasons: string[];
          }
        | undefined;

      sections.forEach((section, index) => {
        const scored = scoreSectionMatch(section, index, sections.length, attachment, request);
        if (!best || scored.score > best.score) {
          best = scored;
        }
      });

      if (best && best.score > 0) {
        matches.push({
          attachmentId: attachment.id,
          sectionIndex: best.sectionIndex,
          sectionType: best.sectionType,
          score: best.score,
          reasons: best.reasons,
        });
      }
    }

    return matches.sort((left, right) => right.score - left.score);
  }

  summarizeMatches(matches: CaptureSectionMatch[]): string[] {
    return matches.map(
      (match) =>
        `attachment=${match.attachmentId} -> section[${match.sectionIndex}] ${match.sectionType} (${match.score}) via ${match.reasons.join(', ')}`,
    );
  }
}

function scoreSectionMatch(
  section: SectionPlan,
  index: number,
  sectionCount: number,
  attachment: PipelineCaptureAttachmentDto,
  request?: PipelineEditRequestDto,
): {
  sectionIndex: number;
  sectionType: SectionPlan['type'];
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const sectionCorpus = buildSectionCorpus(section);
  const hintedType = normalizeToken(request?.targetHint?.sectionType);

  if (hintedType && hintedType === normalizeToken(section.type)) {
    score += 14;
    reasons.push('targetHint.sectionType');
  }

  const blockType = normalizeToken(
    attachment.targetNode?.blockName ?? attachment.domTarget?.blockName,
  );
  if (blockType && blockType.includes(normalizeToken(section.type))) {
    score += 10;
    reasons.push('blockName~sectionType');
  }

  const heading = attachment.targetNode?.nearestHeading ?? attachment.domTarget?.nearestHeading;
  if (heading && fuzzyMatch(heading, sectionCorpus)) {
    score += 12;
    reasons.push('nearestHeading');
  }

  if (attachment.note && fuzzyMatch(attachment.note, sectionCorpus)) {
    score += 10;
    reasons.push('attachment.note');
  }

  if (
    request?.targetHint?.componentName &&
    fuzzyMatch(request.targetHint.componentName, sectionCorpus)
  ) {
    score += 5;
    reasons.push('targetHint.componentName');
  }

  const rectY =
    attachment.geometry?.documentRect?.y ?? attachment.selection?.y ?? undefined;
  const docHeight = attachment.captureContext?.document?.height;
  if (rectY != null && docHeight && docHeight > 0) {
    const ratio = clamp(rectY / docHeight, 0, 0.999);
    const approxIndex = Math.min(
      sectionCount - 1,
      Math.max(0, Math.floor(ratio * sectionCount)),
    );
    if (approxIndex === index) {
      score += 7;
      reasons.push('documentRect.y');
    } else if (Math.abs(approxIndex - index) === 1) {
      score += 3;
      reasons.push('documentRect.y~neighbor');
    }
  }

  return {
    sectionIndex: index,
    sectionType: section.type,
    score,
    reasons,
  };
}

function buildSectionCorpus(section: SectionPlan): string {
  const values: Array<string | undefined> = [section.type];

  switch (section.type) {
    case 'hero':
      values.push(section.heading, section.subheading, section.cta?.text);
      break;
    case 'cover':
      values.push(section.heading, section.subheading, section.cta?.text);
      break;
    case 'post-list':
      values.push(section.title);
      break;
    case 'card-grid':
      values.push(
        section.title,
        section.subtitle,
        ...section.cards.flatMap((card) => [card.heading, card.body]),
      );
      break;
    case 'media-text':
      values.push(
        section.heading,
        section.body,
        section.cta?.text,
        ...(section.listItems ?? []),
      );
      break;
    case 'testimonial':
      values.push(section.quote, section.authorName, section.authorTitle);
      break;
    case 'newsletter':
      values.push(section.heading, section.subheading, section.buttonText);
      break;
    case 'footer':
      values.push(
        section.brandDescription,
        section.copyright,
        ...section.menuColumns.flatMap((column) => [column.title, column.menuSlug]),
      );
      break;
    case 'sidebar':
      values.push(section.title, section.menuSlug);
      break;
    case 'search':
      values.push(section.title);
      break;
    default:
      break;
  }

  return values.filter(Boolean).join(' ');
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
