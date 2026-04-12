import { Injectable } from '@nestjs/common';
import {
  CaptureSectionMatcherService,
  type CaptureSectionMatch,
} from '../../edit-request/capture-section-matcher.service.js';
import { CaptureVisionInputService } from '../../edit-request/capture-vision-input.service.js';
import type { PostMigrationEditTask } from '../../edit-request/edit-request-phase.service.js';
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
    const scopedFeedback = buildScopedFeedback(task, target.name, sectionMatches);
    const fixed = await this.reactGenerator.fixComponent({
      component: target.component,
      plan,
      feedback: scopedFeedback,
      modelConfig,
      logPath,
      visionImageUrls: visionInput.imageUrls,
      visionContextNote: visionInput.summaryNote,
    });

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

function buildScopedFeedback(
  task: PostMigrationEditTask,
  editedComponentName: string,
  sectionMatches: CaptureSectionMatch[],
): string {
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

  if (sectionMatches.length > 0) {
    lines.push('Prioritized section evidence:');
    for (const match of sectionMatches.slice(0, 4)) {
      lines.push(
        `- attachment=${match.attachmentId} -> section[${match.sectionIndex}] ${match.sectionType} (score=${match.score})`,
      );
    }
  }

  return lines.join('\n\n');
}

function formatLineRange(startLine?: number, endLine?: number): string {
  if (typeof startLine === 'number' && typeof endLine === 'number') {
    return `${startLine}-${endLine}`;
  }

  return 'unknown';
}
