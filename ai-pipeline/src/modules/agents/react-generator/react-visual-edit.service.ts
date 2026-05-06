import { Injectable, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { basename, isAbsolute, join, resolve } from 'path';
import { parse as babelParse } from '@babel/parser';
import type {
  PipelineEditTargetHintDto,
  PipelineReactVisualEditRequestDto,
} from '../../orchestrator/orchestrator.dto.js';
import type { PlanResult } from '../planner/planner.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
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
    private readonly codeReviewer: CodeReviewerService,
  ) {}

  private saveBackup(jobId: string, filePath: string, code: string): void {
    if (!this.backupStore.has(jobId)) this.backupStore.set(jobId, []);
    this.backupStore.get(jobId)!.push({ filePath, code });
  }

  async applyEdit(input: VisualEditInput): Promise<VisualEditResult> {
    const { frontendDir, routeEntries, editRequest, logPath } = input;

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
    const instruction = this.buildEditInstruction(editRequest);

    this.logger.log(
      `[visual-edit] "${componentName}" rewriting — "${instruction.slice(0, 80).replace(/\n/g, ' ')}"`,
    );

    const model = this.reactGenerator.getDefaultModel();
    const newCode = await this.codeReviewer.rewriteFile(
      model,
      currentCode,
      instruction,
      logPath,
      componentName,
    );

    if (normalizeCode(newCode) === normalizeCode(currentCode)) {
      throw new Error(
        `Visual edit for "${componentName}" did not produce a material code change.`,
      );
    }

    validateGeneratedCode(newCode, componentName);

    this.saveBackup(input.jobId, filePath, currentCode);
    await writeFile(filePath, newCode, 'utf-8');

    this.logger.log(`[visual-edit] "${componentName}" ✓ written to ${filePath}`);

    return { componentName, filePath, isValid: true, warnings: [] };
  }

  undoLast(jobId: string): { filePath: string; code: string } | undefined {
    const stack = this.backupStore.get(jobId);
    return stack?.pop();
  }

  hasUndo(jobId: string): boolean {
    return (this.backupStore.get(jobId)?.length ?? 0) > 0;
  }

  private buildEditInstruction(
    editRequest: PipelineReactVisualEditRequestDto,
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

    const hint = editRequest.targetHint;
    if (hint) {
      if (hint.targetElementTag) {
        parts.push(`Target element: <${hint.targetElementTag}>`);
      }
      if (hint.targetNodeRole) {
        parts.push(`Element role: ${hint.targetNodeRole}`);
      }
      if (hint.targetTextPreview?.trim()) {
        parts.push(`Element text: "${hint.targetTextPreview.trim()}"`);
      }
      if (hint.targetStartLine !== undefined) {
        parts.push(`Located near line ${hint.targetStartLine} of the file`);
      }
      if (hint.sectionType) {
        parts.push(`Section type: ${hint.sectionType}`);
      }
      if (hint.componentName?.trim()) {
        parts.push(`Component: ${hint.componentName.trim()}`);
      }
    }

    if (editRequest.pageContext?.pageTitle) {
      parts.push(`Page: ${editRequest.pageContext.pageTitle}`);
    }

    if (parts.length === 0) {
      parts.push('Apply the visual change as described by the attached context.');
    }

    parts.push(
      'Make ONLY the requested change. Do NOT alter routing, data fetching, API calls, state management, or any unrelated code.',
    );

    return parts.join('\n');
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
      if (isAbsolute(hintedPath)) return hintedPath;
      return resolve(frontendDir, hintedPath);
    }

    const sourceFile = targetHint?.sourceFile?.trim();
    if (sourceFile) {
      if (isAbsolute(sourceFile)) return sourceFile;
      return resolve(frontendDir, sourceFile);
    }

    return this.deriveFilePath(frontendDir, componentName);
  }
}

function normalizeCode(code: string): string {
  return code.replace(/\r\n/g, '\n').trim();
}

function validateGeneratedCode(code: string, componentName: string): void {
  // 1. JSX/TSX syntax check via Babel parser
  try {
    babelParse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Visual edit for "${componentName}" produced invalid TSX syntax: ${msg}`);
  }

  // 2. Structural check — must still have a default export
  if (!/export\s+default\s+/m.test(code)) {
    throw new Error(`Visual edit for "${componentName}" removed the default export — aborting write.`);
  }
}
