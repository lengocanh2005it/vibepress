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

    // ── Hard failures (return immediately — no point collecting more) ─────────

    // 1. Output is JSON instead of a React component (AI gave up and returned planner JSON)
    const trimmed = code.trimStart();
    if (
      trimmed.startsWith('{') &&
      /"(?:componentName|templateName|type|route|components|description)"\s*:/.test(
        trimmed,
      )
    ) {
      return {
        isValid: false,
        error:
          'Output is JSON, not a React component. Re-generate as a TSX file.',
      };
    }

    // 2. No export default — file is truncated or fundamentally wrong
    if (!/export\s+default\s+/.test(code)) {
      return {
        isValid: false,
        error:
          'Missing `export default` — component is truncated or incomplete.',
      };
    }

    // 3. No JSX return — component renders nothing
    if (!/return\s*[\s\S]*?</.test(code)) {
      return {
        isValid: false,
        error: 'No JSX return found — component has no rendered output.',
      };
    }

    // 4. External CSS / inline <style>
    if (
      /import\s+(?:.+?\s+from\s+)?['"][^'"]+\.s?css['"];?/s.test(code) ||
      /<style[\s>]/i.test(code)
    ) {
      return {
        isValid: false,
        error: 'External CSS or inline <style> tags are not allowed.',
      };
    }

    // 5. Duplicate className on same tag
    if (
      /(<[a-zA-Z0-9]+[^>]*?className=["'][^"']*["'][^>]*?className=["'][^"']*["'][^>]*?>)/s.test(
        code,
      )
    ) {
      return { isValid: false, error: 'Duplicate className attributes found.' };
    }

    // 6. Unbalanced braces — truncated output
    let depth = 0;
    for (const char of code) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth !== 0) {
      return { isValid: false, error: `Unbalanced braces (depth: ${depth})` };
    }

    // ── Content violations — collect ALL before returning ─────────────────────

    const violations: string[] = [];

    // 7. <a href> used for internal React Router paths — breaks SPA navigation
    const internalAHref = code.match(
      /<a\s[^>]*href=["']\/(post|page|archive|category|tag)[/?"]/,
    );
    if (internalAHref) {
      violations.push(
        `Internal link uses \`<a href>\` for route "${internalAHref[0].match(/href=["']([^"']+)["']/)?.[1]}" — use \`<Link to="...">\` from react-router-dom instead.`,
      );
    }

    // 8. CSS variable inside Tailwind arbitrary value — never works
    if (/className=["'][^"']*\[var\(--/.test(code)) {
      violations.push(
        '`[var(--...]` inside className breaks Tailwind — resolve to actual px/rem (e.g. `rounded-[8px]`, `gap-[24px]`); if the value is unresolvable, omit the class entirely.',
      );
    }

    // 8b. Space inside CSS function in Tailwind arbitrary value — class silently ignored
    // e.g. py-[min(6.5rem, 8vw)] → Tailwind drops the class entirely
    if (/className=["'][^"']*\[(min|max|clamp)\([^)]*,\s/.test(code)) {
      violations.push(
        'Space inside CSS function in Tailwind arbitrary value: `py-[min(6.5rem, 8vw)]` is silently ignored. Remove the space: `py-[min(6.5rem,8vw)]`.',
      );
    }

    // 9. Bare numeric+unit Tailwind class (no brackets) — e.g. gap-1rem, mt-2rem
    const classStrings = [
      ...[...code.matchAll(/className=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...code.matchAll(/className=\{`([^`]+)`\}/g)].map((m) => m[1]),
    ].join(' ');
    const bareNumericUnit =
      /\b(?:gap|mt|mb|ml|mr|pt|pb|pl|pr|mx|my|px|py|m|p|w|h|text|leading|tracking|rounded(?:-[a-z]+)?|font|min-[wh]|max-[wh])-\d[\d.]*(?:px|rem|em|vh|vw|%)\b/;
    const numericMatch = classStrings.match(bareNumericUnit);
    if (numericMatch) {
      violations.push(
        `Invalid Tailwind class \`${numericMatch[0]}\`: numeric values need brackets — write \`gap-[1rem]\` not \`gap-1rem\`.`,
      );
    }

    // 10. Wrong siteInfo field names
    const siteInfoMatch = code.match(/\bsiteInfo\.(name|url|description)\b/);
    if (siteInfoMatch) {
      violations.push(
        `\`siteInfo.${siteInfoMatch[1]}\` does not exist. Use \`siteInfo.siteName\` / \`siteInfo.siteUrl\` / \`siteInfo.blogDescription\`.`,
      );
    }

    // 11. Wrong post field names
    const postFieldMatch = code.match(/\bpost\.(tags|title\.rendered)\b/);
    if (postFieldMatch) {
      violations.push(
        `\`post.${postFieldMatch[1]}\` does not exist. Use \`post.title\` (string) or \`post.categories\` (string[]).`,
      );
    }

    if (violations.length > 0) {
      return { isValid: false, error: violations.join('\n') };
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
