import { Injectable, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
  PipelineEditTargetHintDto,
  PipelineReactVisualEditRequestDto,
} from '../../orchestrator/orchestrator.dto.js';
import type { ComponentPlan, PlanResult } from '../planner/planner.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import type { GeneratedComponent } from './react-generator.service.js';
import { ReactGeneratorService } from './react-generator.service.js';

export interface VisualEditInput {
  jobId: string;
  frontendDir: string;
  plan: PlanResult;
  routeEntries?: Array<{ route: string; componentName: string }>;
  editRequest: PipelineReactVisualEditRequestDto;
  logPath?: string;
}

export interface VisualEditResult {
  componentName: string;
  filePath: string;
  isValid: boolean;
  warnings: string[];
}

@Injectable()
export class ReactVisualEditService {
  private readonly logger = new Logger(ReactVisualEditService.name);
  private readonly backupStore = new Map<
    string,
    Array<{ filePath: string; code: string }>
  >();

  constructor(private readonly reactGenerator: ReactGeneratorService) {}

  private saveBackup(jobId: string, filePath: string, code: string): void {
    if (!this.backupStore.has(jobId)) this.backupStore.set(jobId, []);
    this.backupStore.get(jobId)!.push({ filePath, code });
  }

  private extractFocusedRegion(
    code: string,
    hint?: PipelineEditTargetHintDto,
  ): { snippet: string; startLine: number; endLine: number } | undefined {
    if (hint?.startLine === undefined || hint?.endLine === undefined)
      return undefined;
    const lines = code.split('\n');
    const total = lines.length;
    const CONTEXT = 15;
    const from = Math.max(0, hint.startLine - 1 - CONTEXT);
    const to = Math.min(total - 1, hint.endLine - 1 + CONTEXT);
    const snippet = lines.slice(from, to + 1).join('\n');
    return { snippet, startLine: from + 1, endLine: to + 1 };
  }

  async applyEdit(input: VisualEditInput): Promise<VisualEditResult> {
    const { frontendDir, plan, routeEntries, editRequest, logPath } = input;

    const componentName = this.resolveComponentName(
      editRequest.targetHint,
      routeEntries,
    );
    if (!componentName) {
      throw new Error(
        'Cannot resolve target component: provide targetHint.componentName, targetHint.templateName, or targetHint.route',
      );
    }

    const filePath =
      editRequest.targetHint?.outputFilePath?.trim() ||
      this.deriveFilePath(frontendDir, componentName);

    const currentCode = await readFile(filePath, 'utf-8');

    const componentPlan = plan.find((p) => p.componentName === componentName);

    const component: GeneratedComponent = {
      name: componentName,
      filePath,
      code: currentCode,
      type: componentPlan?.type,
      route: componentPlan?.route,
      isDetail: componentPlan?.isDetail,
      generationMode: 'ai',
      ...(componentPlan?.visualPlan
        ? { visualPlan: componentPlan.visualPlan }
        : {}),
    };

    const focusedRegion = this.extractFocusedRegion(
      currentCode,
      editRequest.targetHint,
    );
    const feedback = this.buildFeedback(
      editRequest,
      componentPlan,
      focusedRegion,
    );
    const imageUrls = (editRequest.attachments ?? [])
      .filter((a) => Boolean(a.asset?.publicUrl))
      .slice(0, 3)
      .map((a) => a.asset.publicUrl);

    this.logger.log(
      `[visual-edit] "${componentName}" applying edit — "${feedback.slice(0, 80).replace(/\n/g, ' ')}"`,
    );

    const fixed = await this.reactGenerator.fixComponent({
      component,
      plan,
      feedback,
      visionImageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      tokenScope: 'edit-request',
      logPath,
    });

    this.saveBackup(input.jobId, filePath, currentCode);

    await writeFile(filePath, fixed.code, 'utf-8');

    this.logger.log(
      `[visual-edit] "${componentName}" ✓ written to ${filePath}`,
    );

    return {
      componentName,
      filePath,
      isValid: true,
      warnings: [],
    };
  }

  undoLast(jobId: string): { filePath: string; code: string } | undefined {
    const stack = this.backupStore.get(jobId);
    return stack?.pop();
  }

  hasUndo(jobId: string): boolean {
    return (this.backupStore.get(jobId)?.length ?? 0) > 0;
  }

  private resolveComponentName(
    targetHint?: PipelineEditTargetHintDto,
    routeEntries?: Array<{ route: string; componentName: string }>,
  ): string | undefined {
    if (targetHint?.componentName?.trim())
      return targetHint.componentName.trim();

    if (targetHint?.templateName?.trim()) {
      return this.templateNameToComponentName(targetHint.templateName.trim());
    }

    if (targetHint?.route?.trim() && routeEntries) {
      const normalizedRoute =
        targetHint.route.trim().replace(/\/+$/, '') || '/';
      const entry = routeEntries.find(
        (e) => (e.route.replace(/\/+$/, '') || '/') === normalizedRoute,
      );
      if (entry) return entry.componentName;
    }

    return undefined;
  }

  private templateNameToComponentName(templateName: string): string {
    return templateName
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  private deriveFilePath(frontendDir: string, componentName: string): string {
    const subDir = isPartialComponentName(componentName)
      ? 'components'
      : 'pages';
    return join(frontendDir, 'src', subDir, `${componentName}.tsx`);
  }

  private buildFeedback(
    editRequest: PipelineReactVisualEditRequestDto,
    componentPlan?: ComponentPlan,
    focusedRegion?: { snippet: string; startLine: number; endLine: number },
  ): string {
    const lines: string[] = [];

    if (editRequest.prompt?.trim()) {
      lines.push(editRequest.prompt.trim());
    }

    const hint = editRequest.targetHint;
    if (hint) {
      const hintLines: string[] = [];

      if (hint.sectionType) {
        hintLines.push(`Target section type: ${hint.sectionType}`);
      }
      if (hint.sectionIndex !== undefined) {
        hintLines.push(`Target section index: ${hint.sectionIndex}`);
      }
      if (hint.targetNodeRole) {
        hintLines.push(`Target element role: ${hint.targetNodeRole}`);
      }
      if (hint.targetElementTag) {
        hintLines.push(`Target element tag: ${hint.targetElementTag}`);
      }
      if (hint.targetTextPreview?.trim()) {
        hintLines.push(
          `Target text preview: "${hint.targetTextPreview.trim()}"`,
        );
      }
      if (hint.startLine !== undefined && hint.endLine !== undefined) {
        hintLines.push(
          `Target source lines: ${hint.startLine}–${hint.endLine}`,
        );
      }

      if (hintLines.length > 0) {
        lines.push(hintLines.join('\n'));
      }
    }

    if (focusedRegion) {
      lines.push(
        `EXACT TARGET REGION (lines ${focusedRegion.startLine}–${focusedRegion.endLine} with context — modify ONLY this region, return the complete file):\n\`\`\`tsx\n${focusedRegion.snippet}\n\`\`\``,
      );
    }

    const constraints = editRequest.constraints;
    if (constraints?.preserveOutsideSelection) {
      lines.push(
        'Constraint: preserve all content outside the targeted selection unchanged.',
      );
    }
    if (constraints?.preserveDataContract) {
      lines.push(
        'Constraint: preserve all data fetching, API calls, and state contracts.',
      );
    }

    if (componentPlan?.description) {
      lines.push(`Component purpose: ${componentPlan.description}`);
    }

    return (
      lines.join('\n\n') ||
      'Apply the visual edit as described by the attached context.'
    );
  }
}
