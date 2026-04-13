import { Injectable, Logger } from '@nestjs/common';
import type { DbContentResult } from './db-content/db-content.service.js';
import {
  BlockParserService,
  type BlockParseResult,
} from './block-parser/block-parser.service.js';
import type { PhpParseResult } from './php-parser/php-parser.service.js';

@Injectable()
export class DbTemplateOverlayService {
  private readonly logger = new Logger(DbTemplateOverlayService.name);

  constructor(private readonly blockParser: BlockParserService) {}

  apply(
    theme: PhpParseResult | BlockParseResult,
    content: Pick<
      DbContentResult,
      'dbTemplates' | 'dbGlobalStyles' | 'readingSettings'
    >,
  ): PhpParseResult | BlockParseResult {
    if (theme.type !== 'fse') {
      return theme;
    }

    const globalStylesOverride = this.parseGlobalStylesOverride(
      content.dbGlobalStyles,
    );
    const templateRows = content.dbTemplates.filter(
      (row) => row.postType === 'wp_template' && row.content.trim().length > 0,
    );
    const partRows = content.dbTemplates.filter(
      (row) =>
        row.postType === 'wp_template_part' && row.content.trim().length > 0,
    );

    if (
      templateRows.length === 0 &&
      partRows.length === 0 &&
      !globalStylesOverride
    ) {
      return theme;
    }

    let nextTheme: BlockParseResult = globalStylesOverride
      ? this.blockParser.applyThemeJsonOverride(theme, globalStylesOverride)
      : theme;

    const rawPartMap = new Map<string, string>();
    const repoPartNameByKey = new Map<string, string>();
    for (const part of nextTheme.parts) {
      const key = this.normalizeEntityName(part.name);
      rawPartMap.set(key, part.markup);
      repoPartNameByKey.set(key, part.name);
    }

    let appliedParts = 0;
    for (const row of partRows) {
      const key = this.normalizeEntityName(row.slug);
      if (!key) continue;
      rawPartMap.set(key, row.content);
      appliedParts++;
    }

    const resolvedPartMap = new Map<string, string>();
    const resolvePartMarkup = (
      partKey: string,
      stack = new Set<string>(),
    ): string => {
      const cached = resolvedPartMap.get(partKey);
      if (cached != null) return cached;

      const raw = rawPartMap.get(partKey);
      if (!raw) {
        return `<!-- part:${partKey} not found -->`;
      }
      if (stack.has(partKey)) {
        return `<!-- part:${partKey} circular reference -->`;
      }

      const nextStack = new Set(stack);
      nextStack.add(partKey);

      const resolved = raw.replace(
        /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
        (_match, slug: string) => {
          const nestedKey = this.findEntityKey(slug, rawPartMap);
          if (!nestedKey) return `<!-- part:${slug} not found -->`;
          return this.wrapResolvedPart(
            slug,
            resolvePartMarkup(nestedKey, nextStack),
          );
        },
      );

      resolvedPartMap.set(partKey, resolved);
      return resolved;
    };

    for (const key of rawPartMap.keys()) {
      resolvePartMarkup(key);
    }

    const nextParts = [...nextTheme.parts];
    for (const [key, markup] of resolvedPartMap.entries()) {
      const existingIndex = this.findEntityIndex(nextParts, key);
      const name = repoPartNameByKey.get(key) ?? key;
      if (existingIndex === -1) {
        nextParts.push({ name, markup });
        continue;
      }
      nextParts[existingIndex] = {
        ...nextParts[existingIndex],
        markup,
      };
    }

    const nextTemplates = [...nextTheme.templates];
    let appliedTemplates = 0;
    for (const row of templateRows) {
      const key = this.normalizeEntityName(row.slug);
      if (!key) continue;

      const resolvedMarkup = this.resolveTemplateParts(
        row.content,
        resolvedPartMap,
      );
      const existingIndex = this.findEntityIndex(nextTemplates, key);
      const name =
        existingIndex === -1 ? key : nextTemplates[existingIndex].name;

      if (existingIndex === -1) {
        nextTemplates.push({ name, markup: resolvedMarkup });
      } else {
        nextTemplates[existingIndex] = {
          ...nextTemplates[existingIndex],
          markup: resolvedMarkup,
        };
      }
      appliedTemplates++;
    }

    if (appliedTemplates > 0 || appliedParts > 0) {
      this.logger.log(
        `Applied DB template overlay: templates=${appliedTemplates}, parts=${appliedParts}, show_on_front=${content.readingSettings.showOnFront}, dbGlobalStyles=${content.dbGlobalStyles.length}`,
      );
    }

    return {
      ...nextTheme,
      templates: nextTemplates,
      parts: nextParts,
    };
  }

  private parseGlobalStylesOverride(
    rows: Array<{ content: string; slug: string }>,
  ): Record<string, any> | null {
    for (const row of rows) {
      const parsed = this.parseJsonObject(row.content);
      if (parsed) {
        this.logger.log(
          `Using wp_global_styles override from "${row.slug || 'unnamed'}"`,
        );
        return parsed;
      }
    }
    return null;
  }

  private parseJsonObject(raw: string): Record<string, any> | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;

    const attempts = [
      trimmed,
      trimmed.replace(/\\"/g, '"'),
      (() => {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        return start >= 0 && end > start ? trimmed.slice(start, end + 1) : '';
      })(),
    ].filter(Boolean);

    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
      } catch {
        // Try the next candidate.
      }
    }

    return null;
  }

  private resolveTemplateParts(
    markup: string,
    resolvedPartMap: Map<string, string>,
  ): string {
    return markup.replace(
      /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
      (_match, slug: string) => {
        const partKey = this.findEntityKey(slug, resolvedPartMap);
        const partMarkup = partKey
          ? resolvedPartMap.get(partKey)
          : `<!-- part:${slug} not found -->`;
        return this.wrapResolvedPart(
          slug,
          partMarkup ?? `<!-- part:${slug} not found -->`,
        );
      },
    );
  }

  private wrapResolvedPart(slug: string, markup: string): string {
    return [
      `<!-- vibepress:part:start ${slug} -->`,
      markup,
      `<!-- vibepress:part:end ${slug} -->`,
    ].join('\n');
  }

  private findEntityIndex(
    entries: Array<{ name: string }>,
    normalizedKey: string,
  ): number {
    return entries.findIndex(
      (entry) => this.normalizeEntityName(entry.name) === normalizedKey,
    );
  }

  private findEntityKey(
    slug: string,
    map: Map<string, unknown>,
  ): string | undefined {
    const normalized = this.normalizeEntityName(slug);
    if (!normalized) return undefined;
    if (map.has(normalized)) return normalized;

    const matches = [...map.keys()].filter(
      (key) =>
        key === normalized ||
        key.endsWith(`/${normalized}`) ||
        key.split('/').pop() === normalized,
    );
    return matches.length > 0 ? matches[0] : undefined;
  }

  private normalizeEntityName(value: string): string {
    const trimmed = String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\.html?$/i, '')
      .replace(/^\/+|\/+$/g, '');

    if (!trimmed) return '';

    const themeScoped = trimmed.includes('//')
      ? (trimmed.split('//').pop() ?? trimmed)
      : trimmed;
    return themeScoped.toLowerCase();
  }
}
