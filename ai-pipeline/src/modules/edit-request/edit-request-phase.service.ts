import { Injectable } from '@nestjs/common';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';
import {
  detectEditOperation,
  buildOperationInstruction,
} from './edit-operation.util.js';
import type { GeneratedComponent } from '../agents/react-generator/react-generator.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import { CapturePlanningService } from './capture-planning.service.js';
import type {
  ResolvedCaptureTargetRecord,
  UiMutationCandidate,
  UiMutationNodeRole,
} from './ui-source-map.types.js';
import type { ResolvedEditRequestContext } from './edit-request.types.js';

export interface PostMigrationEditTask {
  componentName: string;
  planComponentName: string;
  route?: string | null;
  feedback: string;
  source: 'prompt' | 'capture' | 'mixed';
  attachments: PipelineCaptureAttachmentDto[];
  matchedAttachmentIds: string[];
  exactTargets: ResolvedCaptureTargetRecord[];
  debugSummary: string;
}

@Injectable()
export class EditRequestPhaseService {
  constructor(private readonly capturePlanning: CapturePlanningService) {}

  buildPlanningRequest(
    request?: PipelineEditRequestDto,
  ): PipelineEditRequestDto | undefined {
    return this.capturePlanning.buildPlanningRequest(request);
  }

  buildPostMigrationEditTasks(input: {
    request?: PipelineEditRequestDto;
    context?: ResolvedEditRequestContext;
    plan: PlanResult;
    components: GeneratedComponent[];
    mutationCandidates?: UiMutationCandidate[];
  }): PostMigrationEditTask[] {
    const {
      request,
      context,
      plan,
      components,
      mutationCandidates,
    } = input;
    if (!request) return [];

    const planByComponent = new Map(
      plan.map((entry) => [entry.componentName, entry]),
    );
    const componentNames = new Set(
      components.map((component) => component.name),
    );

    const promptTargets = this.resolvePromptTargets(request, plan).filter(
      (target) => componentNames.has(target.componentName),
    );
    const captureTargets = this.resolveCaptureTargets({
      attachments: request.attachments,
      plan,
      componentNames,
      mutationCandidates,
    }).filter((target) => componentNames.has(target.componentName));

    const attachmentsByComponent = new Map<
      string,
      PipelineCaptureAttachmentDto[]
    >();
    const exactTargetsByComponent = new Map<
      string,
      ResolvedCaptureTargetRecord[]
    >();
    const planComponentByTargetComponent = new Map<string, string>();
    const promptTargetComponents = new Set<string>();

    for (const target of promptTargets) {
      promptTargetComponents.add(target.componentName);
      planComponentByTargetComponent.set(
        target.componentName,
        target.componentName,
      );
    }

    for (const target of captureTargets) {
      attachmentsByComponent.set(
        target.componentName,
        mergeAttachmentLists(
          attachmentsByComponent.get(target.componentName) ?? [],
          target.attachments,
        ),
      );
      exactTargetsByComponent.set(
        target.componentName,
        mergeExactTargets(
          exactTargetsByComponent.get(target.componentName) ?? [],
          target.exactTargets ?? [],
        ),
      );
      planComponentByTargetComponent.set(
        target.componentName,
        target.planComponentName,
      );
    }

    const targetedComponents = new Set<string>([
      ...promptTargetComponents,
      ...attachmentsByComponent.keys(),
    ]);

    return Array.from(targetedComponents).map((componentName) => {
      const planComponentName =
        planComponentByTargetComponent.get(componentName) ?? componentName;
      const componentPlan = planByComponent.get(planComponentName);
      const attachments = attachmentsByComponent.get(componentName) ?? [];
      const exactTargets = exactTargetsByComponent.get(componentName) ?? [];
      const promptIncluded = promptTargetComponents.has(componentName);

      return {
        componentName,
        planComponentName,
        route: componentPlan?.route,
        feedback: this.buildTaskFeedback({
          request,
          context,
          componentName,
          planComponentName,
          componentRoute: componentPlan?.route,
          promptIncluded,
          attachments,
          exactTargets,
        }),
        source:
          promptIncluded && attachments.length > 0
            ? 'mixed'
            : promptIncluded
              ? 'prompt'
              : 'capture',
        attachments,
        matchedAttachmentIds: attachments.map((attachment) => attachment.id),
        exactTargets,
        debugSummary: this.buildTaskDebugSummary({
          request,
          context,
          componentName,
          planComponentName,
          componentRoute: componentPlan?.route,
          promptIncluded,
          attachments,
          exactTargets,
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

  private resolveCaptureTargets(input: {
    attachments: PipelineCaptureAttachmentDto[] | undefined;
    plan: PlanResult;
    componentNames: Set<string>;
    mutationCandidates?: UiMutationCandidate[];
  }): Array<{
    componentName: string;
    planComponentName: string;
    attachments: PipelineCaptureAttachmentDto[];
    exactTargets: ResolvedCaptureTargetRecord[];
  }> {
    const {
      attachments,
      plan,
      componentNames,
      mutationCandidates,
    } = input;
    if (!attachments?.length) return [];

    const grouped = new Map<
      string,
      {
        planComponentName: string;
        attachments: PipelineCaptureAttachmentDto[];
        exactTargets: ResolvedCaptureTargetRecord[];
      }
    >();

    for (const attachment of attachments) {
      const bestMatch = plan
        .map((componentPlan) => ({
          componentName: componentPlan.componentName,
          score: scoreAttachmentAgainstPlan(componentPlan, attachment),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0];

      if (!bestMatch || bestMatch.score < 8) continue;

      const existing = grouped.get(bestMatch.componentName) ?? {
        planComponentName: bestMatch.componentName,
        attachments: [],
        exactTargets: [],
      };
      existing.attachments.push(attachment);
      const componentPlan = plan.find(
        (entry) => entry.componentName === bestMatch.componentName,
      );
      const componentScopedTarget = resolveMutationTargetForComponent({
        attachment,
        componentName: bestMatch.componentName,
        componentPlan,
        mutationCandidates: mutationCandidates ?? [],
      });
      if (componentScopedTarget) {
        existing.exactTargets.push(componentScopedTarget);
      }
      grouped.set(bestMatch.componentName, existing);
    }

    return Array.from(grouped.entries()).map(([componentName, matched]) => ({
      componentName,
      planComponentName: matched.planComponentName,
      attachments: matched.attachments,
      exactTargets: matched.exactTargets,
    }));
  }

  private buildTaskFeedback(input: {
    request: PipelineEditRequestDto;
    context?: ResolvedEditRequestContext;
    componentName: string;
    planComponentName: string;
    componentRoute?: string | null;
    promptIncluded: boolean;
    attachments: PipelineCaptureAttachmentDto[];
    exactTargets: ResolvedCaptureTargetRecord[];
  }): string {
    const {
      request,
      context,
      componentName,
      planComponentName,
      componentRoute,
      promptIncluded,
      attachments,
      exactTargets,
    } = input;
    const editOperation =
      context?.editOperation ?? detectEditOperation(request.prompt ?? '');
    const operationInstruction = buildOperationInstruction(
      editOperation,
      request.prompt ?? '',
    );

    const lines = [
      'This component was generated as part of the full-site baseline migration.',
      'Apply only the focused post-migration refinements that clearly belong to this component.',
      'Supported edit scope is limited to content, background, color, or layout changes only.',
      'Preserve unrelated layout, behavior, routing, and data contracts.',
      'Do NOT add/remove/replace sections or components, and do NOT introduce new widgets/features.',
      operationInstruction || null,
      `Target component: ${componentName}`,
      planComponentName !== componentName
        ? `Plan component: ${planComponentName}`
        : null,
      `Target route: ${componentRoute ?? 'null'}`,
    ].filter((value): value is string => Boolean(value));

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

    if (context) {
      lines.push(
        `Resolved intent: category=${context.category}; scope=${context.targetScope}; strategy=${context.recommendedStrategy}; needsInference=${context.needsInference ? 'yes' : 'no'}`,
      );
      if (context.globalIntent) {
        lines.push(`Resolved global intent: ${context.globalIntent}`);
      }
      if (context.focusHint) {
        lines.push(`Resolved focus hint: ${context.focusHint}`);
      }
      if (context.targetCandidates.length > 0) {
        lines.push('Highest-confidence inferred targets:');
        for (const candidate of context.targetCandidates.slice(0, 3)) {
          lines.push(`- ${formatIntentTargetCandidate(candidate)}`);
        }
      }
      if (context.inferredAssumptions.length > 0) {
        lines.push(
          'Inference assumptions to preserve unless contradicted by stronger evidence:',
        );
        for (const assumption of context.inferredAssumptions.slice(0, 4)) {
          lines.push(`- ${assumption}`);
        }
      }
      if (context.ambiguities.length > 0) {
        lines.push('Known ambiguities:');
        for (const ambiguity of context.ambiguities.slice(0, 4)) {
          lines.push(`- ${ambiguity}`);
        }
        lines.push(
          'If ambiguity remains during editing, choose the smallest localized change that fits the strongest target evidence.',
        );
      }
      if (context.warnings.length > 0) {
        lines.push('Context warnings:');
        for (const warning of context.warnings.slice(0, 4)) {
          lines.push(`- ${warning}`);
        }
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

    if (exactTargets.length > 0) {
      lines.push('Exact generated React target regions:');
      for (const target of exactTargets) {
        lines.push(`- ${formatExactTargetInstruction(target)}`);
      }
      lines.push(
        'Make the requested change in these exact file regions first. Preserve the semantic ownership and keep unrelated regions unchanged.',
      );
      const focusedChildTargets = exactTargets.filter(
        (target) =>
          target.targetNodeRole &&
          !['section', 'container'].includes(target.targetNodeRole),
      );
      if (focusedChildTargets.length > 0) {
        lines.push(
          'Mutation guardrail: do NOT move local style changes up to the outer section/container when the resolved target is a child element such as a button, heading, text block, media node, or card.',
        );
      }
    }

    lines.push(
      'Return a complete corrected TSX component with these refinements applied only where the evidence matches this component.',
    );

    return lines.join('\n');
  }

  private buildTaskDebugSummary(input: {
    request: PipelineEditRequestDto;
    context?: ResolvedEditRequestContext;
    componentName: string;
    planComponentName: string;
    componentRoute?: string | null;
    promptIncluded: boolean;
    attachments: PipelineCaptureAttachmentDto[];
    exactTargets: ResolvedCaptureTargetRecord[];
  }): string {
    const {
      request,
      context,
      componentName,
      planComponentName,
      componentRoute,
      promptIncluded,
      attachments,
      exactTargets,
    } = input;

    const parts = [
      `component=${componentName}`,
      planComponentName !== componentName
        ? `planComponent=${planComponentName}`
        : null,
      `route=${componentRoute ?? 'null'}`,
      `promptIncluded=${promptIncluded ? 'yes' : 'no'}`,
      context?.editOperation ? `operation=${context.editOperation}` : null,
      context?.targetScope ? `scope=${context.targetScope}` : null,
      context?.recommendedStrategy
        ? `strategy=${context.recommendedStrategy}`
        : null,
      context
        ? `needsInference=${context.needsInference ? 'yes' : 'no'}`
        : null,
    ].filter((value): value is string => Boolean(value));

    if (context?.targetCandidates.length) {
      parts.push(
        `candidates=${context.targetCandidates
          .slice(0, 3)
          .map(
            (candidate) =>
              `{component=${candidate.componentName ?? 'null'},route=${candidate.route ?? 'null'},template=${candidate.templateName ?? 'null'},region=${candidate.sectionType ?? candidate.debugKey ?? candidate.sectionKey ?? 'null'},role=${candidate.targetNodeRole ?? 'null'},confidence=${candidate.confidence.toFixed(2)}}`,
          )
          .join(' ')}`,
      );
    }

    if (context?.ambiguities.length) {
      parts.push(
        `ambiguities=${context.ambiguities
          .slice(0, 3)
          .map((ambiguity) => `"${truncate(ambiguity, 80)}"`)
          .join(' ')}`,
      );
    }

    if (context?.warnings.length) {
      parts.push(
        `warnings=${context.warnings
          .slice(0, 3)
          .map((warning) => `"${truncate(warning, 80)}"`)
          .join(' ')}`,
      );
    }

    if (request.targetHint) {
      const targetParts = [
        request.targetHint.componentName
          ? `targetComponent=${request.targetHint.componentName}`
          : null,
        request.targetHint.route
          ? `targetRoute=${request.targetHint.route}`
          : null,
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
              attachmentParts.push(
                `pageRoute=${attachment.captureContext.page.route}`,
              );
            }
            return `{${attachmentParts.join(', ')}}`;
          })
          .join(' ')}`,
      );
    }

    if (exactTargets.length > 0) {
      parts.push(
        `exactTargets=${exactTargets
          .map(
            (target) =>
              `{attachment=${target.captureId},file=${target.outputFilePath},ownerLines=${formatLineRange(target.startLine, target.endLine)},targetComponent=${target.targetComponentName ?? target.componentName},targetRole=${target.targetNodeRole ?? 'section'},targetLines=${formatLineRange(target.targetStartLine, target.targetEndLine)},resolution=${target.resolution},confidence=${target.confidence.toFixed(2)}}`,
          )
          .join(' ')}`,
      );
    }

    return parts.join(' | ');
  }
}

function shouldIncludePromptInPostEdit(
  request: PipelineEditRequestDto,
): boolean {
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

  if (
    routeMatchesPath(
      attachment.captureContext?.page?.route,
      componentPlan.route,
    )
  ) {
    score += 8;
  }

  if (
    attachment.note &&
    fuzzyMatch(componentPlan.componentName, attachment.note)
  ) {
    score += 6;
  }
  if (
    attachment.note &&
    fuzzyMatch(componentPlan.templateName, attachment.note)
  ) {
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

function formatIntentTargetCandidate(
  candidate: ResolvedEditRequestContext['targetCandidates'][number],
): string {
  const parts = [
    candidate.componentName ? `component=${candidate.componentName}` : null,
    candidate.route ? `route=${candidate.route}` : null,
    candidate.templateName ? `template=${candidate.templateName}` : null,
    candidate.sectionType ? `sectionType=${candidate.sectionType}` : null,
    candidate.targetNodeRole ? `role=${candidate.targetNodeRole}` : null,
    `confidence=${candidate.confidence.toFixed(2)}`,
  ].filter((value): value is string => Boolean(value));

  if (candidate.evidence.length > 0) {
    parts.push(
      `evidence=${candidate.evidence
        .slice(0, 3)
        .map((entry) => `"${truncate(entry, 60)}"`)
        .join(' ')}`,
    );
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
  return (
    normalizedPath.startsWith(`${normalizedRoute}/`) ||
    normalizedRoute.startsWith(`${normalizedPath}/`)
  );
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

function deriveTargetComponentNameFromExactRecord(
  target: ResolvedCaptureTargetRecord,
): string {
  if (target.targetComponentName) return target.targetComponentName;
  const fileName =
    target.outputFilePath.split('/').pop() ?? target.outputFilePath;
  return fileName.replace(/\.tsx$/i, '');
}

function formatExactTargetInstruction(
  target: ResolvedCaptureTargetRecord,
): string {
  const parts = [
    `attachment=${target.captureId}`,
    `file=${target.outputFilePath}`,
    `template=${target.templateName}`,
    `sourceFile=${target.sourceFile}`,
    `lines=${formatLineRange(target.startLine, target.endLine)}`,
    target.targetComponentName
      ? `targetComponent=${target.targetComponentName}`
      : null,
    target.targetSourceNodeId
      ? `targetSourceNodeId=${target.targetSourceNodeId}`
      : null,
    target.targetNodeRole ? `targetRole=${target.targetNodeRole}` : null,
    target.targetElementTag ? `targetTag=${target.targetElementTag}` : null,
    target.targetTextPreview
      ? `targetText="${truncate(target.targetTextPreview, 80)}"`
      : null,
    `targetLines=${formatLineRange(target.targetStartLine, target.targetEndLine)}`,
    `resolution=${target.resolution}`,
    `confidence=${target.confidence.toFixed(2)}`,
  ].filter((value): value is string => Boolean(value));

  return parts.join(' | ');
}

function formatLineRange(startLine?: number, endLine?: number): string {
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return `${startLine}-${endLine}`;
  }

  return 'unknown';
}

function mergeExactTargets(
  left: ResolvedCaptureTargetRecord[],
  right: ResolvedCaptureTargetRecord[],
): ResolvedCaptureTargetRecord[] {
  const merged = new Map<string, ResolvedCaptureTargetRecord>();
  for (const target of [...left, ...right]) {
    merged.set(target.captureId, target);
  }
  return Array.from(merged.values());
}

interface CaptureEditIntentDescriptor {
  targetRoles: UiMutationNodeRole[];
  styleProperty?: 'background' | 'color' | 'layout' | 'content' | 'generic';
  rawInstruction: string;
}

function inferCaptureEditIntent(
  note?: string,
  prompt?: string,
): CaptureEditIntentDescriptor {
  const rawInstruction = [note, prompt].filter(Boolean).join(' ').trim();
  const normalized = normalizeSearchText(rawInstruction);
  const targetRoles: UiMutationNodeRole[] = [];

  if (/\b(button|btn|cta|call to action|nut)\b/.test(normalized)) {
    targetRoles.push('button', 'link');
  }
  if (/\b(link|anchor|url)\b/.test(normalized)) {
    targetRoles.push('link');
  }
  if (/\b(heading|title|headline|tieu de)\b/.test(normalized)) {
    targetRoles.push('heading');
  }
  if (/\b(text|paragraph|copy|description|noi dung|chu)\b/.test(normalized)) {
    targetRoles.push('text');
  }
  if (
    /\b(image|img|media|photo|banner|cover|hero image|hinh)\b/.test(normalized)
  ) {
    targetRoles.push('media');
  }
  if (/\b(card|panel|tile|badge|box)\b/.test(normalized)) {
    targetRoles.push('card', 'container');
  }
  if (/\b(form|input|field|search|newsletter)\b/.test(normalized)) {
    targetRoles.push('input', 'form');
  }
  if (
    /\b(section|container|wrapper|block|background cả vùng|toan bo vung|toan bo section|whole section|entire section)\b/.test(
      normalized,
    )
  ) {
    targetRoles.push('section', 'container');
  }

  const styleProperty = inferIntentStyleProperty(normalized);

  return {
    targetRoles: dedupeNodeRoles(targetRoles),
    styleProperty,
    rawInstruction,
  };
}

function inferIntentStyleProperty(
  normalized: string,
): CaptureEditIntentDescriptor['styleProperty'] {
  if (/\b(background|bg|nen|backgroud|overlay|gradient)\b/.test(normalized)) {
    return 'background';
  }
  if (/\b(text color|font color|chu|mau chu|color)\b/.test(normalized)) {
    return 'color';
  }
  if (
    /\b(border|outline|stroke|vien|padding|margin|spacing|gap|khoang cach|align|column|layout|bo cuc)\b/.test(
      normalized,
    )
  ) {
    return 'layout';
  }
  if (/\b(text|copy|label|content|noi dung)\b/.test(normalized)) {
    return 'content';
  }
  return normalized ? 'generic' : undefined;
}

function resolveMutationTargetForComponent(input: {
  attachment: PipelineCaptureAttachmentDto;
  componentName: string;
  componentPlan?: PlanResult[number];
  mutationCandidates: UiMutationCandidate[];
}): ResolvedCaptureTargetRecord | undefined {
  const { attachment, componentName, componentPlan, mutationCandidates } = input;
  const candidates = mutationCandidates.filter(
    (candidate) =>
      candidate.componentName === componentName ||
      candidate.ownerComponentName === componentName,
  );
  if (candidates.length === 0) return undefined;

  const intent = inferCaptureEditIntent(attachment.note);
  const scoredCandidates = candidates
    .map((candidate) => ({
      candidate,
      scored: scoreComponentScopedMutationCandidate({
        candidate,
        attachment,
        intent,
      }),
    }))
    .sort((left, right) => right.scored.score - left.scored.score);
  const best = scoredCandidates[0];
  if (!best || best.scored.score < 24) {
    return undefined;
  }

  const ownerSourceNodeId =
    best.candidate.ownerSourceNodeId ??
    best.candidate.sourceNodeId ??
    `${componentName}:${best.candidate.nodeRole}:${best.candidate.startLine ?? 0}`;

  return compactObject({
    captureId: attachment.id,
    sourceNodeId: ownerSourceNodeId,
    templateName: componentPlan?.templateName ?? componentName,
    sourceFile:
      componentPlan?.planningSourceFile ??
      componentPlan?.templateName ??
      componentName,
    componentName,
    sectionKey: best.candidate.ownerSectionKey,
    debugKey: best.candidate.ownerSectionKey,
    outputFilePath: best.candidate.outputFilePath,
    startLine: best.candidate.startLine,
    endLine: best.candidate.endLine,
    targetComponentName: best.candidate.componentName,
    targetSourceNodeId:
      best.candidate.sourceNodeId ??
      best.candidate.ownerSourceNodeId ??
      ownerSourceNodeId,
    targetNodeRole: best.candidate.nodeRole,
    targetElementTag: best.candidate.elementTag,
    targetTextPreview: best.candidate.textPreview,
    targetStartLine: best.candidate.startLine,
    targetEndLine: best.candidate.endLine,
    resolution:
      best.candidate.nodeRole === 'section' ||
      best.candidate.nodeRole === 'container'
        ? 'intent-owner-fallback'
        : 'intent-element-match',
    confidence: clampMetric(0.45 + best.scored.confidenceBoost),
  });
}

function scoreComponentScopedMutationCandidate(input: {
  candidate: UiMutationCandidate;
  attachment: PipelineCaptureAttachmentDto;
  intent: CaptureEditIntentDescriptor;
}): {
  score: number;
  confidenceBoost: number;
} {
  const { candidate, attachment, intent } = input;
  let score = 18;

  if (intent.targetRoles.length > 0) {
    if (intent.targetRoles.includes(candidate.nodeRole)) {
      score += 32;
    } else if (
      intent.targetRoles.includes('button') &&
      candidate.nodeRole === 'link'
    ) {
      score += 24;
    } else if (candidate.nodeRole === 'section') {
      score -= 8;
    }
  } else if (candidate.nodeRole === 'section') {
    score += 10;
  } else {
    score += 4;
  }

  if (
    intent.styleProperty === 'background' &&
    ['section', 'container', 'card'].includes(candidate.nodeRole)
  ) {
    score += 8;
  }
  if (
    intent.styleProperty === 'background' &&
    candidate.nodeRole === 'section' &&
    intent.targetRoles.some((role) => !['section', 'container'].includes(role))
  ) {
    score -= 10;
  }

  if (
    attachment.note &&
    candidate.textPreview &&
    fuzzyMatch(attachment.note, candidate.textPreview)
  ) {
    score += 8;
  }

  if (attachment.note && candidate.textPreview) {
    const noteText = normalizeSearchText(attachment.note);
    const candidateText = normalizeSearchText(candidate.textPreview);
    if (noteText && candidateText && noteText.includes(candidateText)) {
      score += 10;
    } else if (fuzzyMatch(noteText, candidateText)) {
      score += 6;
    }
  }

  if (
    candidate.nodeRole === 'button' &&
    /\b(button|btn|cta|call to action|nut)\b/.test(
      normalizeSearchText(intent.rawInstruction),
    )
  ) {
    score += 6;
  }

  if (
    candidate.nodeRole === 'heading' &&
    /\b(heading|title|headline|tieu de)\b/.test(
      normalizeSearchText(intent.rawInstruction),
    )
  ) {
    score += 6;
  }

  return {
    score,
    confidenceBoost: Math.min(Math.max(score, 0), 35) / 100,
  };
}

function dedupeNodeRoles(roles: UiMutationNodeRole[]): UiMutationNodeRole[] {
  return Array.from(new Set(roles));
}

function normalizeSearchText(value?: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

function clampMetric(value: number): number {
  return Math.min(Math.max(Math.round(value * 100) / 100, 0), 1);
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
