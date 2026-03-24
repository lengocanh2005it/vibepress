import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

export interface ThemeTokens {
  colors: { slug: string; value: string }[];
  fonts: { slug: string; family: string; name: string }[];
  spacing: { slug: string; size: string }[];
}

export interface BlockParseResult {
  type: 'fse';
  themeJson: Record<string, any> | null;
  tokens: ThemeTokens;
  templates: { name: string; markup: string }[];
  parts: { name: string; markup: string }[];
}

@Injectable()
export class BlockParserService {
  private readonly logger = new Logger(BlockParserService.name);

  async parse(themeDir: string): Promise<BlockParseResult> {
    this.logger.log(`Parsing FSE/Block theme: ${themeDir}`);

    const themeJson = await this.readJson(join(themeDir, 'theme.json'));
    const tokens = this.extractTokens(themeJson);

    // Build pattern map: slug → markup (from patterns/*.php)
    const patternMap = await this.buildPatternMap(join(themeDir, 'patterns'));

    const rawParts = await this.readHtmlDir(join(themeDir, 'parts'));

    // Build part map: slug → resolved markup
    const partMap = new Map<string, string>();
    for (const p of rawParts) {
      partMap.set(p.name, this.resolvePatterns(p.markup, patternMap));
    }

    const rawTemplates = await this.readHtmlDir(join(themeDir, 'templates'));

    // Resolve patterns + template-parts in templates
    const templates = rawTemplates.map((t) => ({
      name: t.name,
      markup: this.resolveTemplateParts(
        this.resolvePatterns(t.markup, patternMap),
        partMap,
      ),
    }));

    const parts = rawParts.map((p) => ({
      name: p.name,
      markup: partMap.get(p.name) ?? p.markup,
    }));

    return { type: 'fse', themeJson, tokens, templates, parts };
  }

  private extractTokens(themeJson: Record<string, any> | null): ThemeTokens {
    if (!themeJson) return { colors: [], fonts: [], spacing: [] };
    const settings = themeJson.settings ?? {};

    const colors: ThemeTokens['colors'] = (settings.color?.palette ?? []).map(
      (c: any) => ({ slug: c.slug, value: c.color }),
    );

    const fonts: ThemeTokens['fonts'] = (
      settings.typography?.fontFamilies ?? []
    ).map((f: any) => ({ slug: f.slug, family: f.fontFamily, name: f.name }));

    const spacing: ThemeTokens['spacing'] = (
      settings.spacing?.spacingSizes ?? []
    ).map((s: any) => ({ slug: s.slug, size: s.size }));

    return { colors, fonts, spacing };
  }

  /**
   * Replace <!-- wp:template-part {"slug":"header",...} /--> with part markup.
   */
  private resolveTemplateParts(
    markup: string,
    partMap: Map<string, string>,
  ): string {
    return markup.replace(
      /<!-- wp:template-part \{[^}]*"slug":"([^"]+)"[^}]*\} \/-->/g,
      (_, slug) => partMap.get(slug) ?? `<!-- part:${slug} not found -->`,
    );
  }

  /**
   * Read patterns/*.php, extract slug from PHP header comment,
   * strip PHP tags, return map of slug → markup.
   */
  private async buildPatternMap(
    patternsDir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const files = (await readdir(patternsDir)).filter((f) =>
        f.endsWith('.php'),
      );
      for (const file of files) {
        const raw = await readFile(join(patternsDir, file), 'utf-8');
        const slugMatch = raw.match(/\*\s*Slug:\s*(.+)/);
        if (!slugMatch) continue;
        const slug = slugMatch[1].trim();
        const markup = this.stripPhp(raw);
        map.set(slug, markup);
      }
    } catch {
      // patterns dir may not exist
    }
    return map;
  }

  /**
   * Replace <!-- wp:pattern {"slug":"..."} /--> with actual pattern markup.
   * Resolves recursively up to 5 levels deep.
   */
  private resolvePatterns(
    markup: string,
    patternMap: Map<string, string>,
    depth = 0,
  ): string {
    if (depth > 5) return markup;
    return markup.replace(
      /<!-- wp:pattern \{"slug":"([^"]+)"\} \/-->/g,
      (_, slug) => {
        const patternMarkup = patternMap.get(slug);
        if (!patternMarkup) return `<!-- pattern:${slug} not found -->`;
        return this.resolvePatterns(patternMarkup, patternMap, depth + 1);
      },
    );
  }

  /**
   * Strip PHP from pattern files:
   * 1. Remove the header <?php ... ?> doc block
   * 2. Replace echo esc_html_x('text', ...) etc. → text
   * 3. Remove remaining <?php ... ?> tags
   */
  private stripPhp(raw: string): string {
    return (
      raw
        .replace(/<\?php\s*\/\*\*[\s\S]*?\*\/\s*\?>/g, '')
        // PHP i18n in JSON string values: "<?php esc_html_e('Team', 'domain'); ?>" → "Team"
        .replace(
          /"<\?php\s+(?:esc_html_e|esc_attr_e|esc_html|esc_attr|__|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>"/g,
          '"$1"',
        )
        // PHP i18n in HTML content: <?php esc_html_e('text', 'domain'); ?> → text
        // Also handles esc_attr_e (e.g. alt attributes)
        .replace(
          /<\?php\s+(?:esc_html_e|esc_attr_e|_e)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(
          /<\?php\s+echo\s+(?:esc_html|esc_attr|__)\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        // <?php echo esc_html_x('text', 'context', 'domain'); ?> → text
        // Must run BEFORE the bare esc_html_x regex so outer PHP tags are removed together
        .replace(
          /<\?php\s+echo\s+esc_html_x\s*\(\s*'([^']+)'[\s\S]*?\?>/g,
          '$1',
        )
        .replace(/esc_html_x\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_html__\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_attr_e\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/esc_attr__\(\s*(['"`])([\s\S]*?)\1\s*,[\s\S]*?\)/g, '$2')
        .replace(/echo\s+(['"`])([\s\S]*?)\1\s*;/g, '$2')
        .replace(/<\?php[\s\S]*?\?>/g, '')
        .replace(/<\?php[^>]*$/gm, '')
        .trim()
    );
  }

  private async readHtmlDir(
    dir: string,
  ): Promise<{ name: string; markup: string }[]> {
    try {
      const entries = await readdir(dir);
      return Promise.all(
        entries
          .filter((f) => f.endsWith('.html'))
          .map(async (file) => ({
            name: file.replace('.html', ''),
            markup: await readFile(join(dir, file), 'utf-8'),
          })),
      );
    } catch {
      return [];
    }
  }

  private async readJson(path: string): Promise<Record<string, any> | null> {
    try {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
