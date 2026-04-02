import { Injectable, Logger } from '@nestjs/common';
import type { PhpParseResult } from '../php-parser/php-parser.service.js';
import type { BlockParseResult } from '../block-parser/block-parser.service.js';

@Injectable()
export class NormalizerService {
  private readonly logger = new Logger(NormalizerService.name);

  async normalize(
    theme: PhpParseResult | BlockParseResult,
  ): Promise<PhpParseResult | BlockParseResult> {
    this.logger.log(
      `[Stage 1: A3 Normalizer] Cleaning template markup for ${theme.type} theme...`,
    );

    if (theme.type === 'classic') {
      const templates = theme.templates.map((template) => ({
        ...template,
        html: this.cleanMarkup(template.html),
      }));

      if (templates.every((template) => template.html.trim().length === 0)) {
        throw new Error(
          'Normalization failed: all classic theme templates became empty after cleanup',
        );
      }

      return {
        ...theme,
        templates,
      };
    }

    const templates = theme.templates.map((template) => ({
      ...template,
      markup: this.cleanMarkup(template.markup),
    }));
    const parts = theme.parts.map((part) => ({
      ...part,
      markup: this.cleanMarkup(part.markup),
    }));

    if (templates.every((template) => template.markup.trim().length === 0)) {
      throw new Error(
        'Normalization failed: all block theme templates became empty after cleanup',
      );
    }

    return {
      ...theme,
      templates,
      parts,
    };
  }

  private cleanMarkup(input: string): string {
    if (!input) return '';

    return (
      input
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        // Remove empty HTML comments but preserve block comments and semantic placeholders
        .replace(/<!--\s*-->/g, '')
        // Normalize pure inter-tag whitespace without collapsing visible text content
        .replace(/>\s+</g, '>\n<')
        // Collapse excessive blank lines while keeping logical separation
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }
}
