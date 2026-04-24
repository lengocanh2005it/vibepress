import { Injectable, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import type {
  PipelineEditTargetHintDto,
  PipelineReactVisualEditRequestDto,
} from '../../orchestrator/orchestrator.dto.js';
import {
  buildOperationInstruction,
  detectEditOperation,
} from '../../edit-request/edit-operation.util.js';
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
      this.resolveTargetFilePath(
        frontendDir,
        componentName,
        editRequest.targetHint,
      );

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

  private resolveTargetFilePath(
    frontendDir: string,
    componentName: string,
    targetHint?: PipelineEditTargetHintDto,
  ): string {
    const hintedPath = targetHint?.outputFilePath?.trim();
    if (!hintedPath) {
      return this.deriveFilePath(frontendDir, componentName);
    }

    if (isAbsolute(hintedPath)) {
      return hintedPath;
    }

    return resolve(frontendDir, hintedPath);
  }

  private buildFeedback(
    editRequest: PipelineReactVisualEditRequestDto,
    componentPlan?: ComponentPlan,
    focusedRegion?: { snippet: string; startLine: number; endLine: number },
  ): string {
    const lines: string[] = [];
    const combinedInstruction = buildInstructionText(editRequest);

    if (editRequest.prompt?.trim()) {
      lines.push(editRequest.prompt.trim());
    }

    const editOperation = detectEditOperation(combinedInstruction);
    const operationInstruction = buildOperationInstruction(
      editOperation,
      combinedInstruction,
    );
    if (operationInstruction) {
      lines.push(operationInstruction);
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
      if (hint.componentName?.trim()) {
        hintLines.push(`Target component: ${hint.componentName.trim()}`);
      }
      if (hint.route?.trim()) {
        hintLines.push(`Target route: ${hint.route.trim()}`);
      }
      if (hint.templateName?.trim()) {
        hintLines.push(`Target template: ${hint.templateName.trim()}`);
      }
      if (hint.outputFilePath?.trim()) {
        hintLines.push(`Target file hint: ${hint.outputFilePath.trim()}`);
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

    if (editRequest.pageContext) {
      const pageContextLines = [
        editRequest.pageContext.reactRoute
          ? `React route: ${editRequest.pageContext.reactRoute}`
          : null,
        editRequest.pageContext.wordpressRoute
          ? `WordPress route: ${editRequest.pageContext.wordpressRoute}`
          : null,
        editRequest.pageContext.pageTitle
          ? `Page title: ${editRequest.pageContext.pageTitle}`
          : null,
      ].filter((value): value is string => Boolean(value));

      if (pageContextLines.length > 0) {
        lines.push(pageContextLines.join('\n'));
      }
    }

    if ((editRequest.attachments?.length ?? 0) > 0) {
      lines.push('Visual evidence and local target notes:');
      for (const attachment of (editRequest.attachments ?? []).slice(0, 4)) {
        lines.push(`- ${formatVisualAttachment(attachment)}`);
      }
      lines.push(
        'Use these captures as primary evidence for the local change. Preserve unrelated sections and behavior.',
      );
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
    if (constraints?.rerunFromScratch) {
      lines.push(
        'Constraint: the user explicitly allows a broader rewrite of this component if needed, but still keep the route and data contract intact.',
      );
    }

    if (componentPlan?.description) {
      lines.push(`Component purpose: ${componentPlan.description}`);
    }
    if (componentPlan?.route) {
      lines.push(`Planned route: ${componentPlan.route}`);
    }

    return (
      lines.join('\n\n') ||
      'Apply the visual edit as described by the attached context.'
    );
  }
}

function buildInstructionText(
  editRequest: PipelineReactVisualEditRequestDto,
): string {
  return [
    editRequest.prompt?.trim(),
    ...(editRequest.attachments ?? []).map((attachment) => attachment.note?.trim()),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function formatVisualAttachment(
  attachment: NonNullable<PipelineReactVisualEditRequestDto['attachments']>[number],
): string {
  const parts = [`id=${attachment.id}`];
  if (attachment.note?.trim()) {
    parts.push(`note="${truncate(attachment.note.trim(), 160)}"`);
  }
  if (attachment.captureContext?.page?.route) {
    parts.push(`pageRoute=${attachment.captureContext.page.route}`);
  }
  if (attachment.targetNode?.route) {
    parts.push(`targetRoute=${attachment.targetNode.route}`);
  }
  if (attachment.targetNode?.templateName) {
    parts.push(`template=${attachment.targetNode.templateName}`);
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
  if (attachment.targetNode?.nearestHeading) {
    parts.push(
      `heading="${truncate(attachment.targetNode.nearestHeading, 80)}"`,
    );
  }
  if (attachment.domTarget?.textSnippet) {
    parts.push(`text="${truncate(attachment.domTarget.textSnippet, 80)}"`);
  }
  if (attachment.asset?.publicUrl) {
    parts.push(`image=${attachment.asset.publicUrl}`);
  }
  return parts.join(' | ');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
