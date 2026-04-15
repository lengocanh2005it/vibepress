import { Injectable } from '@nestjs/common';
import type { WpNode } from '../utils/wp-block-to-json.js';
import type { ThemeTokens } from '../../modules/agents/block-parser/block-parser.service.js';

/**
 * StyleResolverService — pre-resolves all abstract style references in a
 * WpNode tree to concrete values before the AI sees the JSON.
 *
 * Responsibilities:
 *  - Spacing CSS vars (var:preset|spacing|N, var(--wp--preset--spacing--N)) → px/rem
 *  - Color slugs (bgColor, textColor, overlayColor) → hex
 *
 * By running this pass, the AI receives concrete values and no longer needs
 * to look up theme token tables for every color or spacing reference.
 */
@Injectable()
export class StyleResolverService {
  /**
   * Run all resolution passes over a WpNode tree.
   * Returns a new tree — does not mutate the input.
   */
  resolve(nodes: WpNode[], tokens?: ThemeTokens): WpNode[] {
    const spacingMap = tokens?.spacing?.length
      ? new Map<string, string>(tokens.spacing.map((s) => [s.slug, s.size]))
      : null;

    const colorMap = tokens?.colors?.length
      ? new Map<string, string>(tokens.colors.map((c) => [c.slug, c.value]))
      : null;

    const fontMap = tokens?.fonts?.length
      ? new Map<string, string>(tokens.fonts.map((f) => [f.slug, f.family]))
      : null;

    const fontSizeMap = tokens?.fontSizes?.length
      ? new Map<string, string>(tokens.fontSizes.map((s) => [s.slug, s.size]))
      : null;

    let result = nodes;
    if (spacingMap) result = this.resolveSpacing(result, spacingMap);
    if (colorMap) result = this.resolveColors(result, colorMap);
    if (fontMap || fontSizeMap)
      result = this.resolveTypography(result, fontMap, fontSizeMap);
    result = this.resolveLayout(result, tokens);
    return result;
  }

  // ── Spacing ─────────────────────────────────────────────────────────────

  private resolveSpacing(nodes: WpNode[], map: Map<string, string>): WpNode[] {
    return nodes.map((node) => {
      const out: WpNode = { ...node };

      if (out.gap != null)
        out.gap = this.resolveSpacingVar(out.gap as string, map);

      if (out.padding) {
        out.padding = {
          top: out.padding.top
            ? this.resolveSpacingVar(out.padding.top, map)
            : undefined,
          right: out.padding.right
            ? this.resolveSpacingVar(out.padding.right, map)
            : undefined,
          bottom: out.padding.bottom
            ? this.resolveSpacingVar(out.padding.bottom, map)
            : undefined,
          left: out.padding.left
            ? this.resolveSpacingVar(out.padding.left, map)
            : undefined,
        };
      }

      if (out.margin) {
        out.margin = {
          top: out.margin.top
            ? this.resolveSpacingVar(out.margin.top, map)
            : undefined,
          right: out.margin.right
            ? this.resolveSpacingVar(out.margin.right, map)
            : undefined,
          bottom: out.margin.bottom
            ? this.resolveSpacingVar(out.margin.bottom, map)
            : undefined,
          left: out.margin.left
            ? this.resolveSpacingVar(out.margin.left, map)
            : undefined,
        };
      }

      if (out.children) out.children = this.resolveSpacing(out.children, map);
      return out;
    });
  }

  private resolveSpacingVar(value: string, map: Map<string, string>): string {
    const str = typeof value === 'string' ? value : String(value);
    if (!str.includes('var')) return str;
    value = str;
    const shorthand = value.match(/var:preset\|spacing\|([^|)\s]+)/);
    if (shorthand) return map.get(shorthand[1]) ?? value;
    const cssVar = value.match(/var\(--wp--preset--spacing--([^)]+)\)/);
    if (cssVar) return map.get(cssVar[1]) ?? value;
    return value;
  }

  // ── Colors ──────────────────────────────────────────────────────────────

  private resolveColors(nodes: WpNode[], map: Map<string, string>): WpNode[] {
    return nodes.map((node) => {
      const out: WpNode = { ...node };

      if (out.bgColor && !out.bgColor.startsWith('#'))
        out.bgColor = map.get(out.bgColor) ?? out.bgColor;
      if (out.textColor && !out.textColor.startsWith('#'))
        out.textColor = map.get(out.textColor) ?? out.textColor;
      if (out.overlayColor && !out.overlayColor.startsWith('#'))
        out.overlayColor = map.get(out.overlayColor) ?? out.overlayColor;

      if (out.children) out.children = this.resolveColors(out.children, map);
      return out;
    });
  }

  private resolveTypography(
    nodes: WpNode[],
    fontMap: Map<string, string> | null,
    fontSizeMap: Map<string, string> | null,
  ): WpNode[] {
    return nodes.map((node) => {
      const out: WpNode = { ...node };

      if (out.fontFamily && fontMap) {
        out.fontFamily = this.resolveFontFamilyVar(out.fontFamily, fontMap);
      }

      if (out.typography) {
        out.typography = {
          ...out.typography,
          ...(out.typography.fontFamily && fontMap
            ? {
                fontFamily: this.resolveFontFamilyVar(
                  out.typography.fontFamily,
                  fontMap,
                ),
              }
            : {}),
          ...(out.typography.fontSize && fontSizeMap
            ? {
                fontSize: this.resolveFontSizeVar(
                  out.typography.fontSize,
                  fontSizeMap,
                ),
              }
            : {}),
        };
      }

      if (out.children)
        out.children = this.resolveTypography(
          out.children,
          fontMap,
          fontSizeMap,
        );
      return out;
    });
  }

  private resolveFontFamilyVar(
    value: string,
    map: Map<string, string>,
  ): string {
    const trimmed = value.trim();
    const shorthand = trimmed.match(/var:preset\|font-family\|([^|)\s]+)/);
    if (shorthand) return map.get(shorthand[1]) ?? value;
    const cssVar = trimmed.match(/var\(--wp--preset--font-family--([^)]+)\)/);
    if (cssVar) return map.get(cssVar[1]) ?? value;
    return trimmed;
  }

  private resolveFontSizeVar(value: string, map: Map<string, string>): string {
    const trimmed = value.trim();
    const shorthand = trimmed.match(/var:preset\|font-size\|([^|)\s]+)/);
    if (shorthand) return map.get(shorthand[1]) ?? value;
    const cssVar = trimmed.match(/var\(--wp--preset--font-size--([^)]+)\)/);
    if (cssVar) return map.get(cssVar[1]) ?? value;
    return trimmed;
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  private resolveLayout(nodes: WpNode[], tokens?: ThemeTokens): WpNode[] {
    const defaults = tokens?.defaults;
    return nodes.map((node) => {
      const out: WpNode = { ...node };
      const layout =
        out.params?.layout && typeof out.params.layout === 'object'
          ? { ...(out.params.layout as Record<string, unknown>) }
          : null;

      if (layout) {
        if (typeof layout.contentSize === 'string') {
          layout.contentSize = this.normalizeLayoutLength(layout.contentSize);
        } else if (
          layout.type === 'constrained' &&
          typeof defaults?.contentWidth === 'string' &&
          defaults.contentWidth.trim()
        ) {
          // Gutenberg omits contentSize on many groups and falls back to
          // theme.json.settings.layout.contentSize at render time. Preserve
          // that implicit contract here so mapper/prompt don't lose prose width.
          layout.contentSize = defaults.contentWidth.trim();
        }

        if (typeof layout.wideSize === 'string') {
          layout.wideSize = this.normalizeLayoutLength(layout.wideSize);
        } else if (
          layout.type === 'constrained' &&
          typeof defaults?.wideWidth === 'string' &&
          defaults.wideWidth.trim()
        ) {
          layout.wideSize = defaults.wideWidth.trim();
        }

        if (typeof layout.minimumColumnWidth === 'string') {
          layout.minimumColumnWidth = this.normalizeLayoutLength(
            layout.minimumColumnWidth,
          );
        }

        out.params = {
          ...out.params,
          layout,
        };
      }

      if (out.children) out.children = this.resolveLayout(out.children, tokens);
      return out;
    });
  }

  private normalizeLayoutLength(value: string): string {
    return value.trim();
  }
}
