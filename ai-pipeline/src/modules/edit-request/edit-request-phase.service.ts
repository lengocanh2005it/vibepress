import { Injectable } from '@nestjs/common';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';
import type { GeneratedComponent } from '../agents/react-generator/react-generator.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import {
  CapturePlanningService,
} from './capture-planning.service.js';
import type { CaptureSectionMatch } from './capture-section-matcher.service.js';
import { CaptureSectionMatcherService } from './capture-section-matcher.service.js';

export interface PostMigrationEditTask {
  componentName: string;
  route?: string | null;
  feedback: string;
  source: 'prompt' | 'capture' | 'mixed';
  attachments: PipelineCaptureAttachmentDto[];
  sectionMatches: CaptureSectionMatch[];
  matchedAttachmentIds: string[];
  debugSummary: string;
}

@Injectable()
export class EditRequestPhaseService {
  constructor(
    private readonly capturePlanning: CapturePlanningService,
    private readonly captureSectionMatcher: CaptureSectionMatcherService,
  ) {}

  buildPlanningRequest(
    request?: PipelineEditRequestDto,
  ): PipelineEditRequestDto | undefined {
    return this.capturePlanning.buildPlanningRequest(request);
  }

  buildPostMigrationEditTasks(input: {
    request?: PipelineEditRequestDto;
    plan: PlanResult;
    components: GeneratedComponent[];
  }): PostMigrationEditTask[] {
    const { request, plan, components } = input;
    if (!request) return [];

    const planByComponent = new Map(plan.map((entry) => [entry.componentName, entry]));
    const componentNames = new Set(components.map((component) => component.name));

    const promptTargets = this.resolvePromptTargets(request, plan)
      .filter((target) => componentNames.has(target.componentName));
    const captureTargets = this.resolveCaptureTargets(request.attachments, plan)
      .filter((target) => componentNames.has(target.componentName));

    const attachmentsByComponent = new Map<
      string,
      PipelineCaptureAttachmentDto[]
    >();
    const promptTargetComponents = new Set<string>();

    for (const target of promptTargets) {
      promptTargetComponents.add(target.componentName);
    }

    for (const target of captureTargets) {
      attachmentsByComponent.set(
        target.componentName,
        mergeAttachmentLists(
          attachmentsByComponent.get(target.componentName) ?? [],
          target.attachments,
        ),
      );
    }

    const targetedComponents = new Set<string>([
      ...promptTargetComponents,
      ...attachmentsByComponent.keys(),
    ]);

    return Array.from(targetedComponents).map((componentName) => {
      const componentPlan = planByComponent.get(componentName);
      const attachments = attachmentsByComponent.get(componentName) ?? [];
      const promptIncluded = promptTargetComponents.has(componentName);
      const sectionMatches = this.captureSectionMatcher.matchComponentSections({
        componentPlan,
        attachments,
        request,
      });

      return {
        componentName,
        route: componentPlan?.route,
        feedback: this.buildTaskFeedback({
          request,
          componentName,
          componentRoute: componentPlan?.route,
          promptIncluded,
          attachments,
          sectionMatches,
        }),
        source:
          promptIncluded && attachments.length > 0
            ? 'mixed'
            : promptIncluded
              ? 'prompt'
              : 'capture',
        attachments,
        sectionMatches,
        matchedAttachmentIds: attachments.map((attachment) => attachment.id),
        debugSummary: this.buildTaskDebugSummary({
          request,
          componentName,
          componentRoute: componentPlan?.route,
          promptIncluded,
          attachments,
          sectionMatches,
        }),
      };
    });
  }

  private resolvePromptTargets(
    request: PipelineEditRequestDto,
    plan: PlanResult,
  ): Array<{ componentName: string }> {
    if (!shouldIncludePromptInPostEdit(request)) return [];

    const scored = plan
      .map((componentPlan) => ({
        componentName: componentPlan.componentName,
        score: scorePlanAgainstTargetHint(componentPlan, request),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (!scored.length) return [];

    const bestScore = scored[0].score;
    return scored
      .filter((entry) => entry.score >= Math.max(8, bestScore - 2))
      .slice(0, 3)
      .map((entry) => ({ componentName: entry.componentName }));
  }

  private resolveCaptureTargets(
    attachments: PipelineCaptureAttachmentDto[] | undefined,
    plan: PlanResult,
  ): Array<{
    componentName: string;
    attachments: PipelineCaptureAttachmentDto[];
  }> {
    if (!attachments?.length) return [];

    const grouped = new Map<string, PipelineCaptureAttachmentDto[]>();

    for (const attachment of attachments) {
      const bestMatch = plan
        .map((componentPlan) => ({
          componentName: componentPlan.componentName,
          score: scoreAttachmentAgainstPlan(componentPlan, attachment),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0];

      if (!bestMatch || bestMatch.score < 8) continue;

      const existing = grouped.get(bestMatch.componentName) ?? [];
      existing.push(attachment);
      grouped.set(bestMatch.componentName, existing);
    }

    return Array.from(grouped.entries()).map(([componentName, matchedAttachments]) => ({
      componentName,
      attachments: matchedAttachments,
    }));
  }

  private buildTaskFeedback(input: {
    request: PipelineEditRequestDto;
    componentName: string;
    componentRoute?: string | null;
    promptIncluded: boolean;
    attachments: PipelineCaptureAttachmentDto[];
    sectionMatches: CaptureSectionMatch[];
  }): string {
    const {
      request,
      componentName,
      componentRoute,
      promptIncluded,
      attachments,
      sectionMatches,
    } = input;
    const lines = [
      'This component was generated as part of the full-site baseline migration.',
      'Apply only the focused post-migration refinements that clearly belong to this component.',
      'Preserve unrelated layout, behavior, routing, and data contracts.',
      `Target component: ${componentName}`,
      `Target route: ${componentRoute ?? 'null'}`,
    ];

    if (request.targetHint) {
      const targetParts = [
        request.targetHint.componentName
          ? `component=${request.targetHint.componentName}`
          : null,
        request.targetHint.route ? `route=${request.targetHint.route}` : null,
        request.targetHint.templateName
          ? `template=${request.targetHint.templateName}`
          : null,
        request.targetHint.sectionType
          ? `sectionType=${request.targetHint.sectionType}`
          : null,
        typeof request.targetHint.sectionIndex === 'number'
          ? `sectionIndex=${request.targetHint.sectionIndex}`
          : null,
      ].filter(Boolean);
      if (targetParts.length > 0) {
        lines.push(`Global target hint: ${targetParts.join(', ')}`);
      }
    }

    if (promptIncluded && request.prompt) {
      lines.push(`Global focused request: ${request.prompt}`);
    }

    if (attachments.length > 0) {
      lines.push('Relevant captures for this component:');
      for (const attachment of attachments) {
        lines.push(`- ${formatAttachmentInstruction(attachment)}`);
      }
      lines.push(
        'Treat the capture notes and screenshots as the source of truth for these local refinements.',
      );
    }

    if (sectionMatches.length > 0) {
      lines.push('Matched target sections:');
      for (const match of sectionMatches.slice(0, 4)) {
        lines.push(
          `- attachment=${match.attachmentId} -> section[${match.sectionIndex}] ${match.sectionType} (score=${match.score}, via ${match.reasons.join(', ')})`,
        );
      }
      lines.push(
        'Prefer localized edits inside the matched section(s). Preserve nearby sections unless the captures explicitly show they should change too.',
      );
    }

    lines.push(
      'Return a complete corrected TSX component with these refinements applied only where the evidence matches this component.',
    );

    return lines.join('\n');
  }

  private buildTaskDebugSummary(input: {
    request: PipelineEditRequestDto;
    componentName: string;
    componentRoute?: string | null;
    promptIncluded: boolean;
    attachments: PipelineCaptureAttachmentDto[];
    sectionMatches: CaptureSectionMatch[];
  }): string {
    const {
      request,
      componentName,
      componentRoute,
      promptIncluded,
      attachments,
      sectionMatches,
    } = input;

    const parts = [
      `component=${componentName}`,
      `route=${componentRoute ?? 'null'}`,
      `promptIncluded=${promptIncluded ? 'yes' : 'no'}`,
    ];

    if (request.targetHint) {
      const targetParts = [
        request.targetHint.componentName
          ? `targetComponent=${request.targetHint.componentName}`
          : null,
        request.targetHint.route ? `targetRoute=${request.targetHint.route}` : null,
        request.targetHint.templateName
          ? `targetTemplate=${request.targetHint.templateName}`
          : null,
        request.targetHint.sectionType
          ? `targetSection=${request.targetHint.sectionType}`
          : null,
        typeof request.targetHint.sectionIndex === 'number'
          ? `targetSectionIndex=${request.targetHint.sectionIndex}`
          : null,
      ].filter((value): value is string => Boolean(value));

      if (targetParts.length > 0) {
        parts.push(...targetParts);
      }
    }

    if (attachments.length > 0) {
      parts.push(
        `captures=${attachments
          .map((attachment) => {
            const attachmentParts = [`id=${attachment.id}`];
            if (attachment.captureContext?.page?.route) {
              attachmentParts.push(`pageRoute=${attachment.captureContext.page.route}`);
            }
            if (attachment.targetNode?.route) {
              attachmentParts.push(`targetRoute=${attachment.targetNode.route}`);
            }
            if (attachment.targetNode?.templateName) {
              attachmentParts.push(
                `template=${attachment.targetNode.templateName}`,
              );
            }
            if (attachment.targetNode?.blockName) {
              attachmentParts.push(`block=${attachment.targetNode.blockName}`);
            }
            if (attachment.targetNode?.nearestHeading) {
              attachmentParts.push(
                `heading="${truncate(attachment.targetNode.nearestHeading, 50)}"`,
              );
            }
            return `{${attachmentParts.join(', ')}}`;
          })
          .join(' ')}`,
      );
    }

    if (sectionMatches.length > 0) {
      parts.push(
        `sections=${sectionMatches
          .slice(0, 4)
          .map(
            (match) =>
              `{attachment=${match.attachmentId},index=${match.sectionIndex},type=${match.sectionType},score=${match.score}}`,
          )
          .join(' ')}`,
      );
    }

    return parts.join(' | ');
  }
}

function shouldIncludePromptInPostEdit(request: PipelineEditRequestDto): boolean {
  return Boolean(request.prompt && request.targetHint);
}

function scorePlanAgainstTargetHint(
  componentPlan: PlanResult[number],
  request: PipelineEditRequestDto,
): number {
  const targetHint = request.targetHint;
  if (!targetHint) return 0;

  let score = 0;
  if (
    targetHint.componentName &&
    fuzzyMatch(targetHint.componentName, componentPlan.componentName)
  ) {
    score += 12;
  }
  if (
    targetHint.templateName &&
    fuzzyMatch(targetHint.templateName, componentPlan.templateName)
  ) {
    score += 10;
  }
  if (routeMatchesPath(targetHint.route, componentPlan.route)) {
    score += 12;
  }

  return score;
}

function scoreAttachmentAgainstPlan(
  componentPlan: PlanResult[number],
  attachment: PipelineCaptureAttachmentDto,
): number {
  let score = 0;

  if (routeMatchesPath(attachment.targetNode?.route, componentPlan.route)) {
    score += 12;
  }
  if (
    routeMatchesPath(
      attachment.captureContext?.page?.route,
      componentPlan.route,
    )
  ) {
    score += 8;
  }
  if (
    attachment.targetNode?.templateName &&
    fuzzyMatch(attachment.targetNode.templateName, componentPlan.templateName)
  ) {
    score += 10;
  }
  if (
    attachment.targetNode?.templateName &&
    fuzzyMatch(attachment.targetNode.templateName, componentPlan.componentName)
  ) {
    score += 8;
  }

  const textCorpus = [
    attachment.note,
    attachment.targetNode?.blockName,
    attachment.targetNode?.nearestHeading,
    attachment.targetNode?.nearestLandmark,
    attachment.targetNode?.domPath,
    attachment.domTarget?.blockName,
    attachment.domTarget?.nearestHeading,
    attachment.domTarget?.domPath,
  ]
    .filter(Boolean)
    .join(' ');

  if (textCorpus && fuzzyMatch(componentPlan.componentName, textCorpus)) {
    score += 6;
  }
  if (textCorpus && fuzzyMatch(componentPlan.templateName, textCorpus)) {
    score += 5;
  }

  return score;
}

function formatAttachmentInstruction(
  attachment: PipelineCaptureAttachmentDto,
): string {
  const parts = [`id=${attachment.id}`];

  if (attachment.note) {
    parts.push(`note="${truncate(attachment.note, 180)}"`);
  }
  if (attachment.captureContext?.page?.route) {
    parts.push(`route=${attachment.captureContext.page.route}`);
  }
  if (attachment.targetNode?.templateName) {
    parts.push(`template=${attachment.targetNode.templateName}`);
  }
  if (attachment.targetNode?.blockName) {
    parts.push(`block=${attachment.targetNode.blockName}`);
  }
  if (attachment.targetNode?.nearestHeading) {
    parts.push(
      `heading="${truncate(attachment.targetNode.nearestHeading, 80)}"`,
    );
  }
  if (attachment.geometry?.documentRect) {
    const rect = attachment.geometry.documentRect;
    parts.push(
      `documentRect=(${rect.x},${rect.y},${rect.width},${rect.height})`,
    );
  } else if (attachment.selection) {
    const rect = attachment.selection;
    parts.push(`selection=(${rect.x},${rect.y},${rect.width},${rect.height})`);
  }
  if (attachment.asset?.publicUrl) {
    parts.push(`image=${attachment.asset.publicUrl}`);
  }

  return parts.join(' | ');
}

function mergeAttachmentLists(
  left: PipelineCaptureAttachmentDto[],
  right: PipelineCaptureAttachmentDto[],
): PipelineCaptureAttachmentDto[] {
  const merged = new Map<string, PipelineCaptureAttachmentDto>();

  for (const attachment of [...left, ...right]) {
    merged.set(attachment.id, attachment);
  }

  return Array.from(merged.values());
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
  const normalized = value
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');
  return normalized || '/';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
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
