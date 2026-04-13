import { Injectable } from '@nestjs/common';
import {
  CaptureSectionMatcherService,
  type CaptureSectionMatch,
} from '../../edit-request/capture-section-matcher.service.js';
import { CaptureVisionInputService } from '../../edit-request/capture-vision-input.service.js';
import type { PostMigrationEditTask } from '../../edit-request/edit-request-phase.service.js';
import type { ResolvedCaptureTargetRecord } from '../../edit-request/ui-source-map.types.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import type { PlanResult } from '../planner/planner.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import { ReactGeneratorService } from './react-generator.service.js';

export interface SectionEditResult {
  componentName: string;
  editedComponentName: string;
  component: GeneratedComponent;
  debugSummary: string;
}

@Injectable()
export class SectionEditService {
  constructor(
    private readonly reactGenerator: ReactGeneratorService,
    private readonly captureSectionMatcher: CaptureSectionMatcherService,
    private readonly captureVisionInput: CaptureVisionInputService,
  ) {}

  async applyFocusedTask(input: {
    task: PostMigrationEditTask;
    request?: PipelineEditRequestDto;
    plan: PlanResult;
    components: GeneratedComponent[];
    modelConfig?: { fixAgent?: string };
    logPath?: string;
  }): Promise<SectionEditResult | null> {
    const { task, request, plan, components, modelConfig, logPath } = input;
    const parentComponent = components.find(
      (component) => component.name === task.componentName,
    );
    if (!parentComponent) return null;

    const componentPlan = plan.find(
      (entry) => entry.componentName === task.planComponentName,
    );
    const sectionMatches =
      task.sectionMatches.length > 0
        ? task.sectionMatches
        : this.captureSectionMatcher.matchComponentSections({
            componentPlan,
            attachments: task.attachments,
            request,
          });

    const target = this.resolveTargetComponent(
      task,
      sectionMatches,
      components,
    );
    const visionInput = this.captureVisionInput.buildVisionInput({
      attachments: task.attachments,
      maxImages: target.isSectionTarget ? 2 : 3,
    });
    const scopedFeedback = buildScopedFeedback({
      task,
      editedComponentName: target.name,
      sectionMatches,
      currentCode: target.component.code,
    });
    let fixed = await this.reactGenerator.fixComponent({
      component: target.component,
      plan,
      feedback: scopedFeedback,
      modelConfig,
      logPath,
      visionImageUrls: visionInput.imageUrls,
      visionContextNote: visionInput.summaryNote,
      tokenScope: 'edit-request',
    });
    const mutationAudit = assessFocusedEditMutation({
      originalCode: target.component.code,
      updatedCode: fixed.code,
      editedComponentName: target.name,
      exactTargets: task.exactTargets,
      sectionMatches,
    });
    if (!mutationAudit.hasMeaningfulChange) {
      fixed = await this.reactGenerator.fixComponent({
        component: target.component,
        plan,
        feedback: `${scopedFeedback}\n\n${mutationAudit.retryFeedback}`,
        modelConfig,
        logPath,
        visionImageUrls: visionInput.imageUrls,
        visionContextNote: visionInput.summaryNote,
        tokenScope: 'edit-request',
      });
    }

    return {
      componentName: task.componentName,
      editedComponentName: target.name,
      component: fixed,
      debugSummary:
        target.name === task.componentName
          ? `target=${task.componentName} | mode=component`
          : `target=${task.componentName} | edited=${target.name} | mode=section`,
    };
  }

  private resolveTargetComponent(
    task: PostMigrationEditTask,
    sectionMatches: CaptureSectionMatch[],
    components: GeneratedComponent[],
  ): {
    name: string;
    component: GeneratedComponent;
    isSectionTarget: boolean;
  } {
    const exactComponent = components.find(
      (component) => component.name === task.componentName,
    );
    if (exactComponent) {
      return {
        name: task.componentName,
        component: exactComponent,
        isSectionTarget: task.planComponentName !== task.componentName,
      };
    }

    for (const match of sectionMatches) {
      const candidateName = `${task.planComponentName}Section${match.sectionIndex + 1}`;
      const sectionComponent = components.find(
        (component) => component.name === candidateName,
      );
      if (sectionComponent) {
        return {
          name: candidateName,
          component: sectionComponent,
          isSectionTarget: true,
        };
      }
    }

    const parentComponent = components.find(
      (component) => component.name === task.planComponentName,
    );
    if (!parentComponent) {
      throw new Error(
        `Missing component "${task.planComponentName}" for focused edit`,
      );
    }

    return {
      name: task.planComponentName,
      component: parentComponent,
      isSectionTarget: false,
    };
  }
}

function buildScopedFeedback(input: {
  task: PostMigrationEditTask;
  editedComponentName: string;
  sectionMatches: CaptureSectionMatch[];
  currentCode: string;
}): string {
  const { task, editedComponentName, sectionMatches, currentCode } = input;
  const lines = [task.feedback];

  if (editedComponentName !== task.componentName) {
    lines.push(
      `Scope restriction: apply these refinements only inside subcomponent "${editedComponentName}". Preserve the parent layout and sibling sections.`,
    );
  }

  if (task.exactTargets.length > 0) {
    lines.push('Exact generated React target metadata:');
    for (const target of task.exactTargets) {
      lines.push(
        `- attachment=${target.captureId} -> file=${target.outputFilePath} section=${target.sectionKey} sourceNodeId=${target.sourceNodeId} lines=${formatLineRange(target.startLine, target.endLine)} resolution=${target.resolution} confidence=${target.confidence.toFixed(2)}`,
      );
    }
  }

  const exactTargetExcerpts = buildExactTargetExcerpts(
    currentCode,
    editedComponentName,
    task.exactTargets,
  );
  if (exactTargetExcerpts.length > 0) {
    lines.push('Current code excerpts for the exact target region(s):');
    for (const excerpt of exactTargetExcerpts) {
      lines.push(
        [
          `- attachment=${excerpt.target.captureId} role=${excerpt.target.targetNodeRole ?? 'section'} lines=${formatLineRange(excerpt.startLine, excerpt.endLine)}`,
          '```tsx',
          excerpt.snippet,
          '```',
        ].join('\n'),
      );
    }
  }

  if (sectionMatches.length > 0) {
    lines.push('Prioritized section evidence:');
    for (const match of sectionMatches.slice(0, 4)) {
      lines.push(
        `- attachment=${match.attachmentId} -> section[${match.sectionIndex}] ${match.sectionType} (score=${match.score})`,
      );
    }
  }

  lines.push(
    'Material change requirement: do NOT return the component unchanged or with only unrelated edits. The targeted capture region must show a visible code change that implements the requested refinement while preserving source-tracking attributes.',
  );

  return lines.join('\n\n');
}

function formatLineRange(startLine?: number, endLine?: number): string {
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return `${startLine}-${endLine}`;
  }

  return 'unknown';
}

function buildExactTargetExcerpts(
  code: string,
  editedComponentName: string,
  exactTargets: ResolvedCaptureTargetRecord[],
): Array<{
  target: ResolvedCaptureTargetRecord;
  startLine?: number;
  endLine?: number;
  snippet: string;
}> {
  return exactTargets
    .filter(
      (target) =>
        resolveExactTargetComponentName(target) === editedComponentName,
    )
    .map((target) => {
      const startLine = target.targetStartLine ?? target.startLine;
      const endLine = target.targetEndLine ?? target.endLine;
      return {
        target,
        startLine,
        endLine,
        snippet: extractCodeSnippet(code, startLine, endLine),
      };
    })
    .filter((entry) => Boolean(entry.snippet))
    .slice(0, 3);
}

function assessFocusedEditMutation(input: {
  originalCode: string;
  updatedCode: string;
  editedComponentName: string;
  exactTargets: ResolvedCaptureTargetRecord[];
  sectionMatches: CaptureSectionMatch[];
}): {
  hasMeaningfulChange: boolean;
  retryFeedback: string;
} {
  const {
    originalCode,
    updatedCode,
    editedComponentName,
    exactTargets,
    sectionMatches,
  } = input;
  if (normalizeForDiff(originalCode) === normalizeForDiff(updatedCode)) {
    return {
      hasMeaningfulChange: false,
      retryFeedback: buildNoOpRetryFeedback({
        editedComponentName,
        exactTargets,
        sectionMatches,
        originalCode,
        reason:
          'The previous attempt returned code that is effectively unchanged from the original component.',
      }),
    };
  }

  const relevantTargets = exactTargets.filter(
    (target) => resolveExactTargetComponentName(target) === editedComponentName,
  );
  if (relevantTargets.length === 0) {
    return {
      hasMeaningfulChange: true,
      retryFeedback: '',
    };
  }

  const targetedMutationDetected = relevantTargets.some((target) => {
    const startLine = target.targetStartLine ?? target.startLine;
    const endLine = target.targetEndLine ?? target.endLine;
    const beforeSnippet = extractCodeSnippet(originalCode, startLine, endLine);
    const afterSnippet = extractCodeSnippet(updatedCode, startLine, endLine);
    return normalizeForDiff(beforeSnippet) !== normalizeForDiff(afterSnippet);
  });
  if (targetedMutationDetected) {
    return {
      hasMeaningfulChange: true,
      retryFeedback: '',
    };
  }

  return {
    hasMeaningfulChange: false,
    retryFeedback: buildNoOpRetryFeedback({
      editedComponentName,
      exactTargets: relevantTargets,
      sectionMatches,
      originalCode,
      reason:
        'The previous attempt changed code outside the exact capture target, but the target region itself still appears unchanged.',
    }),
  };
}

function buildNoOpRetryFeedback(input: {
  editedComponentName: string;
  exactTargets: ResolvedCaptureTargetRecord[];
  sectionMatches: CaptureSectionMatch[];
  originalCode: string;
  reason: string;
}): string {
  const {
    editedComponentName,
    exactTargets,
    sectionMatches,
    originalCode,
    reason,
  } = input;
  const lines = [
    `Retry required for "${editedComponentName}".`,
    reason,
    'You MUST materially modify the targeted capture region first. Do not return the original code and do not spend the edit budget on unrelated parts of the component.',
    'Preserve existing source-tracking attributes such as data-vp-source-node, data-vp-section-key, and related metadata on the same logical element.',
  ];

  if (sectionMatches.length > 0) {
    lines.push(
      `Matched section priority: ${sectionMatches
        .slice(0, 3)
        .map(
          (match) =>
            `attachment=${match.attachmentId} -> section[${match.sectionIndex}] ${match.sectionType}`,
        )
        .join(' | ')}`,
    );
  }

  const exactTargetExcerpts = buildExactTargetExcerpts(
    originalCode,
    editedComponentName,
    exactTargets,
  );
  if (exactTargetExcerpts.length > 0) {
    lines.push(
      'Rewrite one or more of these exact regions to satisfy the capture request:',
    );
    for (const excerpt of exactTargetExcerpts) {
      lines.push(
        [
          `- attachment=${excerpt.target.captureId} role=${excerpt.target.targetNodeRole ?? 'section'} lines=${formatLineRange(excerpt.startLine, excerpt.endLine)}`,
          '```tsx',
          excerpt.snippet,
          '```',
        ].join('\n'),
      );
    }
  }

  return lines.join('\n\n');
}

function resolveExactTargetComponentName(
  target: ResolvedCaptureTargetRecord,
): string {
  return (
    target.targetComponentName ??
    target.sectionComponentName ??
    target.componentName
  );
}

function extractCodeSnippet(
  code: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = code.split(/\r?\n/);
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return '';
  }

  const safeStart = Math.max(1, startLine - 1);
  const safeEnd = Math.min(lines.length, endLine + 1);
  return lines.slice(safeStart - 1, safeEnd).join('\n');
}

function normalizeForDiff(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
