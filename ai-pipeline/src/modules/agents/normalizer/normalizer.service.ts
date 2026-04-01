import { Injectable, Logger } from '@nestjs/common';
import type { PhpParseResult } from '../php-parser/php-parser.service.js';
import type { BlockParseResult } from '../block-parser/block-parser.service.js';

@Injectable()
export class NormalizerService {
  private readonly logger = new Logger(NormalizerService.name);

  async normalize(theme: PhpParseResult | BlockParseResult): Promise<PhpParseResult | BlockParseResult> {
    this.logger.log(`[Stage 1: A3 Normalizer] Cleaning HTML for ${theme.type} theme...`);

    if (theme.type === 'classic') {
      return {
        ...theme,
        templates: theme.templates.map(t => ({
          ...t,
          html: this.cleanHtml(t.html)
        }))
      };
    } else {
      return {
        ...theme,
        templates: theme.templates.map(t => ({
          ...t,
          markup: this.cleanHtml(t.markup)
        })),
        parts: theme.parts.map(p => ({
          ...p,
          markup: this.cleanHtml(p.markup)
        }))
      };
    }
  }

  private cleanHtml(html: string): string {
    if (!html) return '';

    return html
      // Replace multiple newlines with a single newline
      .replace(/\n\s*\n/g, '\n')
      // Remove empty HTML comments (but preserve WP hint comments like {/* WP: ... */})
      .replace(/<!--\s*-->/g, '')
      // Remove multiple spaces between tags
      .replace(/>\s+</g, '><')
      // Trim start and end whitespace
      .trim();
  }
}
