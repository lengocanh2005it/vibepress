import { Injectable } from '@nestjs/common';
import type {
  PipelineCaptureAttachmentDto,
  PipelineEditRequestDto,
} from '../orchestrator/orchestrator.dto.js';
import { detectEditOperation, buildOperationInstruction } from './edit-operation.util.js';
import type { GeneratedComponent } from '../agents/react-generator/react-generator.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import { CapturePlanningService } from './capture-planning.service.js';
import type { CaptureSectionMatch } from './capture-section-matcher.service.js';
import { CaptureSectionMatcherService } from './capture-section-matcher.service.js';
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
  sectionMatches: CaptureSectionMatch[];
  matchedAttachmentIds: string[];
  exactTargets: ResolvedCaptureTargetRecord[];
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
    context?: ResolvedEditRequestContext;
    plan: PlanResult;
    components: GeneratedComponent[];
    exactCaptureTargets?: ResolvedCaptureTargetRecord[];
    mutationCandidates?: UiMutationCandidate[];
  }): PostMigrationEditTask[] {
    const {
      request,
      context,
      plan,
      components,
      exactCaptureTargets,
      mutationCandidates,
    } = input;
    if (!request) return [];

    const planByComponent = new Map(
      plan.map((entry) => [entry.componentName, entry]),
    );
    const componentNames = new Set(
      components.map((component) => component.name),
    );
    const resolvedCaptureTargets = exactCaptureTargets?.some(
      (target) =>
        !!target.targetNodeRole ||
        !!target.targetComponentName ||
        target.resolution === 'intent-element-match' ||
        target.resolution === 'intent-owner-fallback',
    )
      ? (exactCaptureTargets ?? [])
      : this.resolveIntentAwareCaptureTargets({
          request,
          exactCaptureTargets,
          mutationCandidates,
        });

    const promptTargets = this.resolvePromptTargets(request, plan).filter(
      (target) => componentNames.has(target.componentName),
    );
    const captureTargets = this.resolveCaptureTargets({
      attachments: request.attachments,
      plan,
      componentNames,
      exactCaptureTargets: resolvedCaptureTargets,
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
      const sectionMatches = this.captureSectionMatcher.matchComponentSections({
        componentPlan,
        attachments,
        request,
      });

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
          sectionMatches,
        }),
      };
    });
  }

  resolveIntentAwareCaptureTargets(input: {
    request?: PipelineEditRequestDto;
    exactCaptureTargets?: ResolvedCaptureTargetRecord[];
    mutationCandidates?: UiMutationCandidate[];
  }): ResolvedCaptureTargetRecord[] {
    const { request, exactCaptureTargets, mutationCandidates } = input;
    const attachments = request?.attachments ?? [];
    if (!attachments.length || !(exactCaptureTargets?.length ?? 0)) {
      return [];
    }

    const ownerTargetsByCaptureId = new Map(
      (exactCaptureTargets ?? []).map((target) => [target.captureId, target]),
    );
    const resolved: ResolvedCaptureTargetRecord[] = [];

    for (const attachment of attachments) {
      const ownerTarget = ownerTargetsByCaptureId.get(attachment.id);
      if (!ownerTarget) continue;

      const intent = inferCaptureEditIntent(
        attachment.note,
        request?.prompt,
        attachment,
      );
      const candidates = selectMutationCandidatesForOwner(
        mutationCandidates ?? [],
        ownerTarget,
      );
      const frontendStructuredTarget = resolveFrontendStructuredMutationTarget({
        attachment,
        ownerTarget,
        candidates,
      });
      if (frontendStructuredTarget) {
        resolved.push(frontendStructuredTarget);
        continue;
      }
      const scoredCandidates = candidates
        .map((candidate) => ({
          candidate,
          scored: scoreMutationCandidate({
            candidate,
            ownerTarget,
            attachment,
            intent,
          }),
        }))
        .sort((left, right) => right.scored.score - left.scored.score);
      const best = scoredCandidates[0];

      if (!best || best.scored.score < 20) {
        resolved.push({
          ...ownerTarget,
          targetComponentName:
            deriveTargetComponentNameFromExactRecord(ownerTarget),
          targetSourceNodeId: ownerTarget.sourceNodeId,
          targetNodeRole: 'section',
          targetStartLine: ownerTarget.startLine,
          targetEndLine: ownerTarget.endLine,
          resolution: 'intent-owner-fallback',
          confidence: clampMetric(ownerTarget.confidence * 0.92),
        });
        continue;
      }

      resolved.push({
        ...ownerTarget,
        outputFilePath: best.candidate.outputFilePath,
        targetComponentName: best.candidate.componentName,
        targetSourceNodeId:
          best.candidate.sourceNodeId ??
          best.candidate.ownerSourceNodeId ??
          ownerTarget.sourceNodeId,
        targetNodeRole: best.candidate.nodeRole,
        targetElementTag: best.candidate.elementTag,
        targetTextPreview: best.candidate.textPreview,
        targetStartLine: best.candidate.startLine,
        targetEndLine: best.candidate.endLine,
        resolution:
          best.candidate.nodeRole === 'section' &&
          (best.candidate.ownerSourceNodeId === ownerTarget.sourceNodeId ||
            best.candidate.sourceNodeId === ownerTarget.sourceNodeId)
            ? ownerTarget.resolution
            : 'intent-element-match',
        confidence: clampMetric(
          ownerTarget.confidence * 0.65 + best.scored.confidenceBoost,
        ),
      });
    }

    return resolved;
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
    exactCaptureTargets?: ResolvedCaptureTargetRecord[];
  }): Array<{
    componentName: string;
    planComponentName: string;
    attachments: PipelineCaptureAttachmentDto[];
    exactTargets: ResolvedCaptureTargetRecord[];
  }> {
    const { attachments, plan, componentNames, exactCaptureTargets } = input;
    if (!attachments?.length) return [];

    const grouped = new Map<
      string,
      {
        planComponentName: string;
        attachments: PipelineCaptureAttachmentDto[];
        exactTargets: ResolvedCaptureTargetRecord[];
      }
    >();
    const exactTargetByAttachmentId = new Map(
      (exactCaptureTargets ?? []).map((target) => [target.captureId, target]),
    );

    for (const attachment of attachments) {
      const exactTarget = exactTargetByAttachmentId.get(attachment.id);
      const exactOutputComponentName = exactTarget
        ? deriveTargetComponentNameFromExactRecord(exactTarget)
        : undefined;
      if (
        exactTarget &&
        exactOutputComponentName &&
        componentNames.has(exactOutputComponentName)
      ) {
        const existing = grouped.get(exactOutputComponentName) ?? {
          planComponentName: exactTarget.componentName,
          attachments: [],
          exactTargets: [],
        };
        existing.attachments.push(attachment);
        existing.exactTargets.push(exactTarget);
        grouped.set(exactOutputComponentName, existing);
        continue;
      }

      const exactComponentName = resolveExactComponentNameFromAttachment(
        attachment,
        plan,
      );
      if (exactComponentName) {
        const existing = grouped.get(exactComponentName) ?? {
          planComponentName: exactComponentName,
          attachments: [],
          exactTargets: [],
        };
        existing.attachments.push(attachment);
        grouped.set(exactComponentName, existing);
        continue;
      }

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
    sectionMatches: CaptureSectionMatch[];
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
      sectionMatches,
    } = input;
    const editOperation =
      context?.editOperation ?? detectEditOperation(request.prompt ?? '');
    const operationInstruction = buildOperationInstruction(editOperation, request.prompt ?? '');

    const lines = [
      'This component was generated as part of the full-site baseline migration.',
      'Apply only the focused post-migration refinements that clearly belong to this component.',
      'Preserve unrelated layout, behavior, routing, and data contracts.',
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
        lines.push('Inference assumptions to preserve unless contradicted by stronger evidence:');
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
      lines.push('Exact generated React targets resolved from ui-source-map:');
      for (const target of exactTargets) {
        lines.push(`- ${formatExactTargetInstruction(target)}`);
      }
      lines.push(
        'Make the requested change in these exact file regions first. Preserve tracking markers such as data-vp-source-node, data-vp-section-key, and related source metadata.',
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
    context?: ResolvedEditRequestContext;
    componentName: string;
    planComponentName: string;
    componentRoute?: string | null;
    promptIncluded: boolean;
    attachments: PipelineCaptureAttachmentDto[];
    exactTargets: ResolvedCaptureTargetRecord[];
    sectionMatches: CaptureSectionMatch[];
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
      sectionMatches,
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
      context ? `needsInference=${context.needsInference ? 'yes' : 'no'}` : null,
    ].filter((value): value is string => Boolean(value));

    if (context?.targetCandidates.length) {
      parts.push(
        `candidates=${context.targetCandidates
          .slice(0, 3)
          .map(
            (candidate) =>
              `{component=${candidate.componentName ?? 'null'},route=${candidate.route ?? 'null'},template=${candidate.templateName ?? 'null'},section=${candidate.sectionType ?? candidate.sectionKey ?? 'null'},role=${candidate.targetNodeRole ?? 'null'},confidence=${candidate.confidence.toFixed(2)}}`,
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
            if (attachment.targetNode?.route) {
              attachmentParts.push(
                `targetRoute=${attachment.targetNode.route}`,
              );
            }
            if (attachment.targetNode?.templateName) {
              attachmentParts.push(
                `template=${attachment.targetNode.templateName}`,
              );
            }
            if (
              attachment.targetNode?.ownerSourceNodeId ||
              attachment.targetNode?.sourceNodeId
            ) {
              attachmentParts.push(
                `ownerSourceNodeId=${attachment.targetNode?.ownerSourceNodeId ?? attachment.targetNode?.sourceNodeId}`,
              );
            }
            if (attachment.targetNode?.editSourceNodeId) {
              attachmentParts.push(
                `editSourceNodeId=${attachment.targetNode.editSourceNodeId}`,
              );
            }
            if (attachment.targetNode?.editNodeRole) {
              attachmentParts.push(
                `editRole=${attachment.targetNode.editNodeRole}`,
              );
            }
            if (attachment.targetNode?.editTagName) {
              attachmentParts.push(
                `editTag=${attachment.targetNode.editTagName}`,
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

    if (exactTargets.length > 0) {
      parts.push(
        `exactTargets=${exactTargets
          .map(
            (target) =>
              `{attachment=${target.captureId},file=${target.outputFilePath},section=${target.sectionKey},ownerLines=${formatLineRange(target.startLine, target.endLine)},targetSourceNodeId=${target.targetSourceNodeId ?? target.sourceNodeId},targetRole=${target.targetNodeRole ?? 'section'},targetLines=${formatLineRange(target.targetStartLine, target.targetEndLine)},sourceNodeId=${target.sourceNodeId}}`,
          )
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
  const exactSourceNodeId = attachment.targetNode?.sourceNodeId?.trim();

  if (
    exactSourceNodeId &&
    componentPlan.visualPlan?.sections?.some(
      (section) => section.sourceRef?.sourceNodeId === exactSourceNodeId,
    )
  ) {
    score += 100;
  }

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

function resolveExactComponentNameFromAttachment(
  attachment: PipelineCaptureAttachmentDto,
  plan: PlanResult,
): string | undefined {
  const sourceNodeId = attachment.targetNode?.sourceNodeId?.trim();
  if (!sourceNodeId) return undefined;

  return plan.find((componentPlan) =>
    componentPlan.visualPlan?.sections?.some(
      (section) => section.sourceRef?.sourceNodeId === sourceNodeId,
    ),
  )?.componentName;
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
  if (
    attachment.targetNode?.ownerSourceNodeId ||
    attachment.targetNode?.sourceNodeId
  ) {
    parts.push(
      `ownerSourceNodeId=${attachment.targetNode?.ownerSourceNodeId ?? attachment.targetNode?.sourceNodeId}`,
    );
  }
  if (attachment.targetNode?.editSourceNodeId) {
    parts.push(`editSourceNodeId=${attachment.targetNode.editSourceNodeId}`);
  }
  if (attachment.targetNode?.editNodeRole) {
    parts.push(`editRole=${attachment.targetNode.editNodeRole}`);
  }
  if (attachment.targetNode?.editTagName) {
    parts.push(`editTag=${attachment.targetNode.editTagName}`);
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

function formatIntentTargetCandidate(
  candidate: ResolvedEditRequestContext['targetCandidates'][number],
): string {
  const parts = [
    candidate.componentName ? `component=${candidate.componentName}` : null,
    candidate.route ? `route=${candidate.route}` : null,
    candidate.templateName ? `template=${candidate.templateName}` : null,
    candidate.sectionKey ? `sectionKey=${candidate.sectionKey}` : null,
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
    `sourceNodeId=${target.sourceNodeId}`,
    `file=${target.outputFilePath}`,
    `section=${target.sectionKey}`,
    target.sectionComponentName
      ? `sectionComponent=${target.sectionComponentName}`
      : null,
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
  styleProperty?:
    | 'background'
    | 'text-color'
    | 'border'
    | 'spacing'
    | 'typography'
    | 'content'
    | 'generic';
  rawInstruction: string;
}

function inferCaptureEditIntent(
  note?: string,
  prompt?: string,
  attachment?: PipelineCaptureAttachmentDto,
): CaptureEditIntentDescriptor {
  const rawInstruction = [note, prompt, attachment?.targetNode?.blockName]
    .filter(Boolean)
    .join(' ')
    .trim();
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
    return 'text-color';
  }
  if (/\b(border|outline|stroke|vien)\b/.test(normalized)) {
    return 'border';
  }
  if (/\b(padding|margin|spacing|gap|khoang cach)\b/.test(normalized)) {
    return 'spacing';
  }
  if (/\b(font|size|weight|typography|line-height)\b/.test(normalized)) {
    return 'typography';
  }
  if (/\b(text|copy|label|content|noi dung)\b/.test(normalized)) {
    return 'content';
  }
  return normalized ? 'generic' : undefined;
}

function selectMutationCandidatesForOwner(
  candidates: UiMutationCandidate[],
  ownerTarget: ResolvedCaptureTargetRecord,
): UiMutationCandidate[] {
  const ownerComponentName =
    deriveTargetComponentNameFromExactRecord(ownerTarget);

  return candidates.filter((candidate) => {
    if (
      ownerTarget.outputFilePath &&
      candidate.outputFilePath === ownerTarget.outputFilePath
    ) {
      return true;
    }
    if (
      ownerTarget.sourceNodeId &&
      candidate.ownerSourceNodeId === ownerTarget.sourceNodeId
    ) {
      return true;
    }
    if (candidate.componentName === ownerComponentName) {
      return true;
    }
    return false;
  });
}

function scoreMutationCandidate(input: {
  candidate: UiMutationCandidate;
  ownerTarget: ResolvedCaptureTargetRecord;
  attachment: PipelineCaptureAttachmentDto;
  intent: CaptureEditIntentDescriptor;
}): {
  score: number;
  confidenceBoost: number;
} {
  const { candidate, ownerTarget, attachment, intent } = input;
  let score = 0;

  if (candidate.ownerSourceNodeId === ownerTarget.sourceNodeId) {
    score += 40;
  }
  if (candidate.outputFilePath === ownerTarget.outputFilePath) {
    score += 18;
  }
  if (
    typeof ownerTarget.startLine === 'number' &&
    typeof ownerTarget.endLine === 'number' &&
    typeof candidate.startLine === 'number' &&
    typeof candidate.endLine === 'number' &&
    candidate.startLine >= ownerTarget.startLine &&
    candidate.endLine <= ownerTarget.endLine
  ) {
    score += 18;
  }

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
    score += 12;
  }

  if (
    intent.styleProperty === 'background' &&
    !['section', 'container'].includes(candidate.nodeRole) &&
    intent.targetRoles.length > 0
  ) {
    score += 6;
  }

  if (
    intent.styleProperty === 'background' &&
    candidate.nodeRole === 'section' &&
    intent.targetRoles.some((role) => !['section', 'container'].includes(role))
  ) {
    score -= 12;
  }

  if (
    attachment.targetNode?.nearestHeading &&
    candidate.textPreview &&
    fuzzyMatch(attachment.targetNode.nearestHeading, candidate.textPreview)
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
    /\b(background|bg|nen|mau vang|yellow)\b/.test(
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

function resolveFrontendStructuredMutationTarget(input: {
  attachment: PipelineCaptureAttachmentDto;
  ownerTarget: ResolvedCaptureTargetRecord;
  candidates: UiMutationCandidate[];
}): ResolvedCaptureTargetRecord | undefined {
  const { attachment, ownerTarget, candidates } = input;
  if (!hasStructuredEditHint(attachment) || candidates.length === 0) {
    return undefined;
  }

  const scoredCandidates = candidates
    .map((candidate) => ({
      candidate,
      scored: scoreFrontendStructuredCandidate({
        candidate,
        attachment,
        ownerTarget,
      }),
    }))
    .sort((left, right) => right.scored.score - left.scored.score);
  const best = scoredCandidates[0];
  if (!best || best.scored.score < 32) {
    return undefined;
  }

  return {
    ...ownerTarget,
    outputFilePath: best.candidate.outputFilePath,
    targetComponentName: best.candidate.componentName,
    targetSourceNodeId:
      best.candidate.sourceNodeId ??
      best.candidate.ownerSourceNodeId ??
      ownerTarget.sourceNodeId,
    targetNodeRole: best.candidate.nodeRole,
    targetElementTag: best.candidate.elementTag,
    targetTextPreview: best.candidate.textPreview,
    targetStartLine: best.candidate.startLine,
    targetEndLine: best.candidate.endLine,
    resolution:
      best.candidate.nodeRole === 'section' &&
      (best.candidate.ownerSourceNodeId === ownerTarget.sourceNodeId ||
        best.candidate.sourceNodeId === ownerTarget.sourceNodeId)
        ? ownerTarget.resolution
        : 'intent-element-match',
    confidence: clampMetric(
      ownerTarget.confidence * 0.72 + best.scored.confidenceBoost,
    ),
  };
}

function hasStructuredEditHint(
  attachment: PipelineCaptureAttachmentDto,
): boolean {
  return Boolean(
    attachment.targetNode?.editSourceNodeId ||
    attachment.targetNode?.editNodeRole ||
    attachment.targetNode?.editTagName,
  );
}

function scoreFrontendStructuredCandidate(input: {
  candidate: UiMutationCandidate;
  attachment: PipelineCaptureAttachmentDto;
  ownerTarget: ResolvedCaptureTargetRecord;
}): {
  score: number;
  confidenceBoost: number;
} {
  const { candidate, attachment, ownerTarget } = input;
  const editSourceNodeId = attachment.targetNode?.editSourceNodeId?.trim();
  const editNodeRole = normalizeUiMutationNodeRole(
    attachment.targetNode?.editNodeRole,
  );
  const editTagName = attachment.targetNode?.editTagName?.trim().toLowerCase();
  const domTargetText = attachment.domTarget?.textSnippet?.trim();
  const targetHeading = attachment.targetNode?.nearestHeading?.trim();

  let score = 0;

  if (candidate.ownerSourceNodeId === ownerTarget.sourceNodeId) {
    score += 30;
  }
  if (candidate.outputFilePath === ownerTarget.outputFilePath) {
    score += 12;
  }
  if (
    typeof ownerTarget.startLine === 'number' &&
    typeof ownerTarget.endLine === 'number' &&
    typeof candidate.startLine === 'number' &&
    typeof candidate.endLine === 'number' &&
    candidate.startLine >= ownerTarget.startLine &&
    candidate.endLine <= ownerTarget.endLine
  ) {
    score += 10;
  }

  if (editSourceNodeId) {
    if (candidate.sourceNodeId === editSourceNodeId) {
      score += 60;
    } else if (candidate.ownerSourceNodeId === editSourceNodeId) {
      score += 20;
    } else {
      score -= 6;
    }
  }

  if (editNodeRole) {
    if (candidate.nodeRole === editNodeRole) {
      score += 42;
    } else if (editNodeRole === 'button' && candidate.nodeRole === 'link') {
      score += 28;
    } else if (['section', 'container'].includes(candidate.nodeRole)) {
      score -= 10;
    } else {
      score -= 4;
    }
  }

  if (editTagName) {
    if (candidate.elementTag === editTagName) {
      score += 18;
    } else if (
      editTagName === 'button' &&
      candidate.elementTag === 'a' &&
      candidate.nodeRole === 'button'
    ) {
      score += 12;
    }
  }

  if (
    domTargetText &&
    candidate.textPreview &&
    fuzzyMatch(domTargetText, candidate.textPreview)
  ) {
    score += 14;
  }
  if (
    targetHeading &&
    candidate.textPreview &&
    fuzzyMatch(targetHeading, candidate.textPreview)
  ) {
    score += 8;
  }

  return {
    score,
    confidenceBoost: Math.min(Math.max(score, 0), 42) / 100,
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

function normalizeUiMutationNodeRole(
  value?: string,
): UiMutationNodeRole | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;

  const supportedRoles: UiMutationNodeRole[] = [
    'section',
    'container',
    'card',
    'button',
    'link',
    'heading',
    'text',
    'media',
    'form',
    'input',
    'list',
    'unknown',
  ];

  return supportedRoles.includes(normalized as UiMutationNodeRole)
    ? (normalized as UiMutationNodeRole)
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
