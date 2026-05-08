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
    const t0 = Date.now();

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

    const t1 = Date.now();
    const currentCode = await readFile(filePath, 'utf-8');
    this.logger.log(
      `[timing] readFile "${componentName}" — ${Date.now() - t1}ms | lines=${currentCode.split('\n').length}`,
    );

    const instruction = this.buildEditInstruction(editRequest);
    this.logger.log(
      `[visual-edit] "${componentName}" rewriting — "${instruction.slice(0, 80).replace(/\n/g, ' ')}"`,
    );

    const model = this.reactGenerator.getDefaultModel();
    const t2 = Date.now();
    const targetStartLine = editRequest.targetHint?.targetStartLine;
    const extracted = targetStartLine
      ? extractEditWindow(currentCode, targetStartLine)
      : null;

    let newCode: string;
    if (extracted) {
      const { fragment, windowStart, windowEnd } = extracted;
      this.logger.log(
        `[timing] extractEditWindow — lines ${windowStart}-${windowEnd} (${windowEnd - windowStart + 1} lines from ${currentCode.split('\n').length} total)`,
      );
      const modifiedFragment = await this.codeReviewer.rewriteFragment(
        model,
        fragment,
        instruction,
        windowStart,
        windowEnd,
        logPath,
        componentName,
      );
      const allLines = currentCode.split('\n');
      const before = allLines.slice(0, windowStart - 1).join('\n');
      const after = allLines.slice(windowEnd).join('\n');
      newCode =
        (before ? before + '\n' : '') +
        modifiedFragment +
        (after ? '\n' + after : '');
    } else {
      this.logger.log(
        `[timing] no window extracted (targetStartLine=${targetStartLine ?? 'none'}) — full-file rewrite`,
      );
      newCode = await this.codeReviewer.rewriteFile(
        model,
        currentCode,
        instruction,
        logPath,
        componentName,
      );
    }
    this.logger.log(
      `[timing] rewrite "${componentName}" — ${Date.now() - t2}ms`,
    );

    if (normalizeCode(newCode) === normalizeCode(currentCode)) {
      throw new Error(
        `Visual edit for "${componentName}" did not produce a material code change.`,
      );
    }

    const t3 = Date.now();
    validateGeneratedCode(newCode, componentName);
    this.logger.log(
      `[timing] validateGeneratedCode "${componentName}" — ${Date.now() - t3}ms`,
    );

    this.saveBackup(input.jobId, filePath, currentCode);
    await writeFile(filePath, newCode, 'utf-8');

    this.logger.log(
      `[timing] applyEdit total "${componentName}" — ${Date.now() - t0}ms`,
    );

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

    const imageUrls = (editRequest.imageAssets ?? [])
      .map((a) => a.publicUrl)
      .filter((url): url is string => Boolean(url));
    if (imageUrls.length > 0) {
      parts.push(
        `Add the following image(s) to the component using <img> tag(s) with these src URL(s): ${imageUrls.join(', ')}`,
      );
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
      parts.push(
        'Apply the visual change as described by the attached context.',
      );
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

function findJsxNodeEndLine(
  code: string,
  targetStartLine: number,
): number | null {
  try {
    const ast = babelParse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });

    let endLine: number | null = null;

    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (!n['type']) return;

      if (
        (n['type'] === 'JSXElement' || n['type'] === 'JSXFragment') &&
        (n['loc'] as { start?: { line?: number } } | undefined)?.start?.line ===
          targetStartLine
      ) {
        const end = (n['loc'] as { end?: { line?: number } } | undefined)?.end
          ?.line;
        if (typeof end === 'number' && (endLine === null || end < endLine)) {
          endLine = end;
        }
      }

      for (const key of Object.keys(n)) {
        if (
          key === 'loc' ||
          key === 'start' ||
          key === 'end' ||
          key === 'errors'
        )
          continue;
        const child = n[key];
        if (Array.isArray(child)) {
          for (const item of child) walk(item);
        } else if (
          child &&
          typeof child === 'object' &&
          (child as Record<string, unknown>)['type']
        ) {
          walk(child);
        }
      }
    }

    walk(ast);
    return endLine;
  } catch {
    return null;
  }
}

function extractEditWindow(
  code: string,
  targetStartLine: number,
): { fragment: string; windowStart: number; windowEnd: number } | null {
  const lines = code.split('\n');
  const totalLines = lines.length;

  if (targetStartLine < 1 || targetStartLine > totalLines) return null;

  const endLine = findJsxNodeEndLine(code, targetStartLine) ?? targetStartLine;
  const effectiveEnd = Math.max(targetStartLine, endLine);

  const PADDING = 30;
  const windowStart = Math.max(1, targetStartLine - PADDING);
  const windowEnd = Math.min(totalLines, effectiveEnd + PADDING);

  // Not worth fragmenting if window already covers 70%+ of file
  if (windowEnd - windowStart + 1 >= totalLines * 0.7) return null;

  const fragment = lines.slice(windowStart - 1, windowEnd).join('\n');
  return { fragment, windowStart, windowEnd };
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
    throw new Error(
      `Visual edit for "${componentName}" produced invalid TSX syntax: ${msg}`,
    );
  }

  // 2. Structural check — must still have a default export
  if (!/export\s+default\s+/m.test(code)) {
    throw new Error(
      `Visual edit for "${componentName}" removed the default export — aborting write.`,
    );
  }

  // 3. Security scan — reject dangerous patterns injected via prompt
  scanForMaliciousPatterns(code, componentName);
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\beval\s*\(/,
    reason: 'eval() is not allowed in generated components',
  },
  {
    pattern: /new\s+Function\s*\(/,
    reason: 'new Function() is not allowed in generated components',
  },
  {
    pattern: /document\.write\s*\(/,
    reason: 'document.write() is not allowed in generated components',
  },
  {
    pattern: /\.createElement\s*\(\s*['"`]script['"`]/,
    reason: 'Dynamic <script> element creation is not allowed',
  },
  {
    // Catches import ... from 'child_process' / 'fs' / 'vm' / 'net' / 'os' / 'cluster'
    pattern:
      /\bimport\b[^'"]*from\s+['"`](child_process|fs|path|os|net|vm|cluster)['"`]/,
    reason:
      'Node.js built-in module imports are not allowed in React components',
  },
  {
    // Catches require('child_process') style calls
    pattern:
      /\brequire\s*\(\s*['"`](child_process|fs|path|os|net|http|https|vm|cluster)['"`]/,
    reason:
      'Node.js built-in require() calls are not allowed in React components',
  },
  {
    pattern: /\bchild_process\b/,
    reason: 'child_process references are not allowed in generated components',
  },
  {
    pattern: /\b(execSync|spawnSync)\s*\(/,
    reason:
      'Synchronous shell execution is not allowed in generated components',
  },
  {
    // exec( and spawn( only when clearly a shell call (followed by a string arg)
    pattern: /\b(?:exec|spawn)\s*\(\s*['"`]/,
    reason: 'Shell execution calls are not allowed in generated components',
  },
  {
    pattern: /\bprocess\.(exit|kill|binding|dlopen)\s*\(/,
    reason:
      'Dangerous process operations are not allowed in generated components',
  },
  {
    // Dynamic import of an absolute external URL
    pattern: /\bimport\s*\(\s*['"`]https?:\/\//,
    reason: 'Dynamic imports from external URLs are not allowed',
  },
  {
    // fetch() with a hardcoded external URL literal
    pattern: /\bfetch\s*\(\s*['"`]https?:\/\//,
    reason:
      'fetch() with hardcoded external URLs is not allowed; use relative API paths',
  },
  {
    // atob/btoa chained with eval — common obfuscation pattern
    pattern:
      /\batob\s*\([\s\S]{0,200}\beval\b|\beval\b[\s\S]{0,200}\batob\s*\(/,
    reason: 'Obfuscated code execution via atob/eval is not allowed',
  },
];

function scanForMaliciousPatterns(code: string, componentName: string): void {
  const violations: string[] = [];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(reason);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Visual edit for "${componentName}" was rejected — disallowed patterns detected:\n` +
        violations.map((v) => `  • ${v}`).join('\n'),
    );
  }
}
