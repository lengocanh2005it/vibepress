import { Injectable, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { basename, isAbsolute, join, resolve } from 'path';
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
import { ValidatorService } from '../validator/validator.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import { ReactGeneratorService } from './react-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';

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

  constructor(
    private readonly reactGenerator: ReactGeneratorService,
    private readonly validator: ValidatorService,
    private readonly codeReviewer: CodeReviewerService,
  ) {}

  private saveBackup(jobId: string, filePath: string, code: string): void {
    if (!this.backupStore.has(jobId)) this.backupStore.set(jobId, []);
    this.backupStore.get(jobId)!.push({ filePath, code });
  }

  private extractFocusedRegion(
    code: string,
    hint?: PipelineEditTargetHintDto,
  ): { snippet: string; startLine: number; endLine: number } | undefined {
    const anchorLine = hint?.targetStartLine ?? hint?.startLine;
    if (anchorLine === undefined) return undefined;
    const lines = code.split('\n');
    const total = lines.length;
    const CONTEXT = 15;
    const startLine = Math.max(1, Math.round(anchorLine));
    const endLine = Math.max(startLine, Math.round(hint?.endLine ?? startLine));
    const from = Math.max(0, startLine - 1 - CONTEXT);
    const to = Math.min(total - 1, endLine - 1 + CONTEXT);
    const snippet = lines.slice(from, to + 1).join('\n');
    return { snippet, startLine: from + 1, endLine: to + 1 };
  }

  async applyEdit(input: VisualEditInput): Promise<VisualEditResult> {
    const { frontendDir, plan, routeEntries, editRequest, logPath } = input;

    const startLine =
      editRequest.targetHint?.targetStartLine ?? editRequest.targetHint?.startLine;
    const endLine = editRequest.targetHint?.endLine;
    if (startLine !== undefined && endLine !== undefined && startLine <= endLine) {
      return this.applySurgicalPatch(input, startLine, endLine);
    }

    const componentName = this.resolveComponentName(
      editRequest.targetHint,
      routeEntries,
    );
    if (!componentName) {
      throw new Error(
        'Cannot resolve target component: provide targetHint.componentName, targetHint.templateName, or targetHint.route',
      );
    }

    const filePath = this.resolveTargetFilePath(
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
      fixMode: 'edit-request-safe',
      visionImageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      tokenScope: 'edit-request',
      logPath,
    });

    if (
      normalizeCodeForComparison(fixed.code) ===
      normalizeCodeForComparison(currentCode)
    ) {
      throw new Error(
        `Visual edit for "${componentName}" did not produce a material code change in the targeted component.`,
      );
    }

    const validatedCode = this.validateEditedComponent({
      component,
      componentPlan,
      code: fixed.code,
    });

    this.saveBackup(input.jobId, filePath, currentCode);

    await writeFile(filePath, validatedCode, 'utf-8');

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

  private async applySurgicalPatch(
    input: VisualEditInput,
    startLine: number,
    endLine: number,
  ): Promise<VisualEditResult> {
    const { frontendDir, routeEntries, editRequest, logPath } = input;

    const componentName = this.resolveComponentName(editRequest.targetHint, routeEntries);
    if (!componentName) {
      throw new Error(
        'Cannot resolve target component: provide targetHint.componentName, targetHint.templateName, or targetHint.route',
      );
    }

    const filePath = this.resolveTargetFilePath(frontendDir, componentName, editRequest.targetHint);
    const currentCode = await readFile(filePath, 'utf-8');
    const lines = currentCode.split('\n');

    const from = Math.max(0, startLine - 1);
    const to = Math.min(lines.length - 1, endLine - 1);
    const originalSnippet = lines.slice(from, to + 1).join('\n');

    const instruction = this.buildSurgicalInstruction(editRequest, from + 1, to + 1);

    this.logger.log(
      `[visual-edit] "${componentName}" surgical patch lines ${from + 1}–${to + 1} — "${instruction.slice(0, 80).replace(/\n/g, ' ')}"`,
    );

    const model = this.reactGenerator.getDefaultModel();
    const patchedSnippet = await this.codeReviewer.patchSnippet(
      model,
      originalSnippet,
      instruction,
      logPath,
      componentName,
    );

    if (normalizeCodeForComparison(patchedSnippet) === normalizeCodeForComparison(originalSnippet)) {
      throw new Error(
        `Visual edit for "${componentName}" did not produce a material code change in the targeted region (lines ${from + 1}–${to + 1}).`,
      );
    }

    const balanceError = checkSnippetJsxBalance(patchedSnippet);
    if (balanceError) {
      throw new Error(`Visual edit produced unbalanced JSX in the patched region: ${balanceError}`);
    }

    const patchedLines = patchedSnippet.split('\n');
    const newCode = [...lines.slice(0, from), ...patchedLines, ...lines.slice(to + 1)].join('\n');

    this.saveBackup(input.jobId, filePath, currentCode);
    await writeFile(filePath, newCode, 'utf-8');

    this.logger.log(`[visual-edit] "${componentName}" ✓ surgical patch written to ${filePath}`);

    return { componentName, filePath, isValid: true, warnings: [] };
  }

  private buildSurgicalInstruction(
    editRequest: PipelineReactVisualEditRequestDto,
    startLine: number,
    endLine: number,
  ): string {
    const parts: string[] = [];

    if (editRequest.prompt?.trim()) {
      parts.push(editRequest.prompt.trim());
    }

    const attachmentNotes = (editRequest.attachments ?? [])
      .map((a) => a.note?.trim())
      .filter((n): n is string => Boolean(n));
    if (attachmentNotes.length > 0) {
      parts.push(attachmentNotes.join(' '));
    }

    if (parts.length === 0) {
      parts.push('Apply the visual change as described by the attached context.');
    }

    parts.push(
      `This snippet spans lines ${startLine}–${endLine} of the component. Modify only what is needed. Do NOT add imports or export statements.`,
    );

    return parts.join('\n');
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

    const hintedFile =
      targetHint?.outputFilePath?.trim() || targetHint?.sourceFile?.trim();
    if (hintedFile) {
      const fileName = basename(hintedFile).replace(/\.(t|j)sx?$/i, '');
      if (fileName) return fileName;
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
    if (hintedPath) {
      if (isAbsolute(hintedPath)) {
        return hintedPath;
      }
      return resolve(frontendDir, hintedPath);
    }

    const sourceFile = targetHint?.sourceFile?.trim();
    if (sourceFile) {
      if (isAbsolute(sourceFile)) {
        return sourceFile;
      }
      return resolve(frontendDir, sourceFile);
    }

    return this.deriveFilePath(frontendDir, componentName);
  }

  private validateEditedComponent(input: {
    component: GeneratedComponent;
    componentPlan?: ComponentPlan;
    code: string;
  }): string {
    const { component, componentPlan, code } = input;
    const candidate: GeneratedComponent = {
      ...component,
      code,
      type: componentPlan?.type ?? component.type,
      route: componentPlan?.route ?? component.route,
      isDetail: componentPlan?.isDetail ?? component.isDetail,
      fixedSlug: componentPlan?.fixedSlug ?? component.fixedSlug,
      dataNeeds: componentPlan?.dataNeeds ?? component.dataNeeds,
      requiredCustomClassNames:
        componentPlan?.customClassNames ?? component.requiredCustomClassNames,
      visualPlan: componentPlan?.visualPlan ?? component.visualPlan,
      surfacePlan: componentPlan?.surfacePlan ?? component.surfacePlan,
      renderContract: componentPlan?.renderContract ?? component.renderContract,
    };
    const validation = this.validator.collectValidationIssues([candidate]);
    if (validation.failures.length > 0) {
      throw new Error(
        `Visual edit produced invalid component code: ${validation.failures[0].error}`,
      );
    }
    return validation.components[0]?.code ?? code;
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

    lines.push(
      'Supported edit scope is limited to content, background, color, or layout changes only.',
    );
    lines.push(
      'Do NOT add/remove/replace sections or components, do NOT introduce new widgets/features, and do NOT alter routing or data contracts.',
    );

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

function normalizeCodeForComparison(code: string): string {
  return code.replace(/\r\n/g, '\n').trim();
}

function checkSnippetJsxBalance(snippet: string): string | null {
  let depth = 0;
  for (const ch of snippet) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) return `Unbalanced braces (depth: ${depth})`;

  const parenDepth = [...snippet].reduce((acc, ch) => {
    if (ch === '(') return acc + 1;
    if (ch === ')') return acc - 1;
    return acc;
  }, 0);
  if (parenDepth !== 0) return `Unbalanced parentheses (depth: ${parenDepth})`;

  return null;
}

function buildInstructionText(
  editRequest: PipelineReactVisualEditRequestDto,
): string {
  return [
    editRequest.prompt?.trim(),
    ...(editRequest.attachments ?? []).map((attachment) =>
      attachment.note?.trim(),
    ),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function formatVisualAttachment(
  attachment: NonNullable<
    PipelineReactVisualEditRequestDto['attachments']
  >[number],
): string {
  const parts = [`id=${attachment.id}`];
  if (attachment.note?.trim()) {
    parts.push(`note="${truncate(attachment.note.trim(), 160)}"`);
  }
  if (attachment.captureContext?.page?.route) {
    parts.push(`pageRoute=${attachment.captureContext.page.route}`);
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
