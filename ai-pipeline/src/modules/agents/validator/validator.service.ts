import { Injectable, Logger } from '@nestjs/common';
import type { GeneratedComponent } from '../react-generator/react-generator.service.js';

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  /**
   * Post-process all generated components:
   * - Remove unused imports from each .tsx file
   */
  validate(components: GeneratedComponent[]): GeneratedComponent[] {
    return components.map((comp) => ({
      ...comp,
      code: this.removeUnusedImports(comp.code),
    }));
  }

  /**
   * Basic structural validation to detect obvious layout-breaking code
   */
  checkCodeStructure(code: string): { isValid: boolean; error?: string } {
    if (!code.trim()) return { isValid: false, error: 'Empty code' };

    if (
      /import\s+(?:.+?\s+from\s+)?['"][^'"]+\.s?css['"];?/s.test(code) ||
      /<style[\s>]/i.test(code)
    ) {
      return {
        isValid: false,
        error: 'External CSS or inline <style> tags are not allowed.',
      };
    }

    // Check for obvious duplicate classNames
    // Looks for a tag that contains 'className=' at least twice
    const classNameMatches = (code.match(/className=["'][^"']*["']/g) || [])
      .length;
    // This is still a bit naive, but let's count className occurrences per tag if possible.
    // Given the complexity of parsing JSX, let's use a simpler heuristic for now.
    if (
      /(<[a-zA-Z0-9]+[^>]*?className=["'][^"']*["'][^>]*?className=["'][^"']*["'][^>]*?>)/s.test(
        code,
      )
    ) {
      return { isValid: false, error: 'Duplicate className attributes found.' };
    }

    // Check for unbalanced braces (safety catch)
    let depth = 0;
    for (const char of code) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth !== 0) {
      return { isValid: false, error: `Unbalanced braces (depth: ${depth})` };
    }

    return { isValid: true };
  }

  // ── Core: strip unused imports ──────────────────────────────────────────────

  removeUnusedImports(code: string): string {
    const lines = code.split('\n');

    // Collect all import line indices + their parsed identifiers
    const importBlocks: Array<{
      lineIdx: number;
      raw: string;
      identifiers: string[]; // named/default identifiers that can be checked
      alwaysKeep: boolean; // e.g. side-effect imports, React, type-only
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trimStart().startsWith('import ')) continue;

      // Side-effect import: import './foo.css'
      if (/^import\s+['"]/.test(line.trim())) {
        importBlocks.push({
          lineIdx: i,
          raw: line,
          identifiers: [],
          alwaysKeep: true,
        });
        continue;
      }

      // Type-only import: import type { ... }
      if (/^import\s+type\s/.test(line.trim())) {
        importBlocks.push({
          lineIdx: i,
          raw: line,
          identifiers: [],
          alwaysKeep: true,
        });
        continue;
      }

      const identifiers: string[] = [];

      // Default import: import Foo from '...'  OR  import React from '...'
      const defaultMatch = line.match(
        /^import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\s+from)/,
      );
      if (defaultMatch) {
        identifiers.push(defaultMatch[1]);
      }

      // Named imports: import { A, B as C } from '...'
      const namedMatch = line.match(/\{([^}]+)\}/);
      if (namedMatch) {
        const names = namedMatch[1]
          .split(',')
          .map((s) => {
            // Handle "Foo as Bar" → use Bar (the local alias)
            const alias = s.trim().match(/(?:.*\s+as\s+)?(\S+)$/);
            return alias ? alias[1] : s.trim();
          })
          .filter(Boolean);
        identifiers.push(...names);
      }

      // Namespace import: import * as Foo from '...'
      const nsMatch = line.match(
        /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      );
      if (nsMatch) {
        identifiers.push(nsMatch[1]);
      }

      // Always keep React — JSX transforms still reference it in some setups
      const isReact =
        /from\s+['"]react['"]/.test(line) && identifiers.includes('React');

      importBlocks.push({
        lineIdx: i,
        raw: line,
        identifiers,
        alwaysKeep: isReact || identifiers.length === 0,
      });
    }

    if (importBlocks.length === 0) return code;

    // Build the non-import portion of the code to check usage
    const importLineIndices = new Set(importBlocks.map((b) => b.lineIdx));
    const bodyLines = lines.filter((_, i) => !importLineIndices.has(i));
    const body = bodyLines.join('\n');

    // Decide which import lines to keep
    const linesToRemove = new Set<number>();

    for (const block of importBlocks) {
      if (block.alwaysKeep) continue;

      const unusedIdents = block.identifiers.filter(
        (ident) => !this.isIdentifierUsed(ident, body),
      );

      if (unusedIdents.length === 0) continue; // all used — keep as-is

      if (unusedIdents.length === block.identifiers.length) {
        // Nothing used → drop the whole line
        linesToRemove.add(block.lineIdx);
        this.logger.debug(`Removing unused import: ${block.raw.trim()}`);
      } else {
        // Partial removal — rebuild the import line without the unused named imports
        lines[block.lineIdx] = this.stripUnusedNamed(block.raw, unusedIdents);
        this.logger.debug(
          `Partial removal on import line ${block.lineIdx}: removed ${unusedIdents.join(', ')}`,
        );
      }
    }

    const result = lines.filter((_, i) => !linesToRemove.has(i)).join('\n');

    // Clean up any double blank lines that removal may have introduced
    return result.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isIdentifierUsed(ident: string, body: string): boolean {
    // Use word-boundary regex so "useState" doesn't match "useStateExtra"
    const re = new RegExp(`\\b${ident}\\b`);
    return re.test(body);
  }

  private stripUnusedNamed(importLine: string, unusedIdents: string[]): string {
    return importLine
      .replace(/\{([^}]+)\}/, (_, inner: string) => {
        const kept = inner
          .split(',')
          .map((s) => s.trim())
          .filter((s) => {
            // "Foo as Bar" → check alias Bar
            const alias = s.match(/(?:.*\s+as\s+)?(\S+)$/)?.[1] ?? s;
            return !unusedIdents.includes(alias);
          });
        return kept.length > 0 ? `{ ${kept.join(', ')} }` : '';
      })
      .replace(/,\s*\{\s*\}/, '')
      .replace(/\{\s*\},?\s*/, '');
  }
}
