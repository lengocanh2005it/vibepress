import {
  wpBlocksToJson,
  type WpNode,
} from '../../../common/utils/wp-block-to-json.js';
import { mapWpNodesToDraftSections } from '../../../common/utils/wp-node-to-sections-mapper.js';
import { extractStaticImageSources } from '../../../common/utils/theme-asset.util.js';

function flattenBlockNames(node: WpNode): string[] {
  return [
    node.block,
    ...(node.children ?? []).flatMap((child) => flattenBlockNames(child)),
  ];
}

function collectCustomClassNamesFromValue(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectCustomClassNamesFromValue(entry));
  }
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const classNames: string[] = [];

  for (const [key, entry] of Object.entries(record)) {
    if (key === 'customClassNames' && Array.isArray(entry)) {
      classNames.push(
        ...entry
          .map((item) => String(item ?? '').trim())
          .filter((item) => item.length > 0),
      );
      continue;
    }
    if (key === 'className' && typeof entry === 'string' && entry.trim()) {
      classNames.push(
        ...entry
          .split(/\s+/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      );
      continue;
    }
    classNames.push(...collectCustomClassNamesFromValue(entry));
  }

  return classNames;
}

export function sourceContainsBlock(
  source: string,
  blockName: string,
): boolean {
  const escaped = blockName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:core\\/)?${escaped}\\b`, 'i').test(source);
}

export function scorePlanningSourceRichness(source: string): number {
  const trimmed = source.trim();
  if (!trimmed) return 0;

  let score = Math.min(80, Math.floor(trimmed.length / 120));
  score += detectInteractiveWidgetsFromSource(trimmed).length * 25;
  score += extractStaticImageSources(trimmed).length * 8;
  score += (trimmed.match(/<!--\s*wp:/g) ?? []).length * 3;
  score += (trimmed.match(/<img\b/gi) ?? []).length * 4;
  score +=
    (
      trimmed.match(
        /\b(core\/|wp:)(cover|columns|group|gallery|image|media-text|query|buttons?|heading|paragraph)\b/gi,
      ) ?? []
    ).length * 2;

  try {
    const nodes = wpBlocksToJson(trimmed);
    const draftSections = mapWpNodesToDraftSections(nodes);
    const distinctBlocks = new Set(
      nodes.flatMap((node) => flattenBlockNames(node)),
    );
    score += draftSections.length * 40;
    score += distinctBlocks.size * 4;
    score += nodes.length * 2;
  } catch {
    // Best-effort scoring only.
  }

  return score;
}

export function countDraftSectionsInSource(source: string): number {
  try {
    const nodes = wpBlocksToJson(source);
    return mapWpNodesToDraftSections(nodes).length;
  } catch {
    return 0;
  }
}

export function extractHeadingTextsFromSource(source: string): string[] {
  const collected = new Set<string>();
  const pushText = (value: string | undefined) => {
    const normalized = String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized.length >= 3) collected.add(normalized);
  };

  try {
    const visit = (node: WpNode) => {
      if (/heading|site-title|post-title|query-title/i.test(node.block)) {
        pushText(node.text);
        pushText(node.html);
        const contentValue =
          typeof node.params?.content === 'string'
            ? node.params.content
            : undefined;
        pushText(contentValue);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of wpBlocksToJson(source)) visit(node);
  } catch {
    const matches = source.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi);
    for (const match of matches) {
      pushText(match[1]);
    }
  }

  return [...collected].slice(0, 12);
}

export function extractParagraphTextsFromSource(source: string): string[] {
  const collected = new Set<string>();
  const pushText = (value: string | undefined) => {
    const normalized = String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized.length >= 3) collected.add(normalized);
  };

  try {
    const visit = (node: WpNode) => {
      if (/paragraph/i.test(node.block)) {
        pushText(node.text);
        pushText(node.html);
        const contentValue =
          typeof node.params?.content === 'string'
            ? node.params.content
            : undefined;
        pushText(contentValue);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of wpBlocksToJson(source)) visit(node);
  } catch {
    const matches = source.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
    for (const match of matches) {
      pushText(match[1]);
    }
  }

  return [...collected].slice(0, 12);
}

export function extractNavigationLinkItemsFromSource(
  source: string,
): Array<{ label: string; url?: string }> {
  const collected: Array<{ label: string; url?: string }> = [];
  const seen = new Set<string>();
  const pushItem = (label?: string, url?: string) => {
    const normalizedLabel = String(label ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedUrl =
      typeof url === 'string' && url.trim() ? url.trim() : undefined;
    if (normalizedLabel.length < 2) return;
    const key = `${normalizedLabel}::${normalizedUrl ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(
      normalizedUrl
        ? { label: normalizedLabel, url: normalizedUrl }
        : { label: normalizedLabel },
    );
  };

  try {
    const visit = (node: WpNode) => {
      if (/navigation-link/i.test(node.block)) {
        const labelValue =
          typeof node.params?.label === 'string'
            ? node.params.label
            : (node.text ?? node.html);
        const urlValue =
          typeof node.params?.url === 'string' ? node.params.url : undefined;
        pushItem(labelValue, urlValue);
      }
      for (const child of node.children ?? []) visit(child);
    };
    for (const node of wpBlocksToJson(source)) visit(node);
  } catch {
    const matches = source.matchAll(
      /navigation-link[^]*?"label":"([^"]+)"[^]*?(?:"url":"([^"]*)")?/gi,
    );
    for (const match of matches) {
      pushItem(match[1], match[2]);
    }
  }

  return collected.slice(0, 12);
}

export function extractCustomClassNamesFromSource(source: string): string[] {
  try {
    const parsed = JSON.parse(source);
    return [...new Set(collectCustomClassNamesFromValue(parsed))];
  } catch {
    return [];
  }
}

export function detectInteractiveWidgetsFromSource(source: string): string[] {
  const normalized = source.toLowerCase();
  const hints = new Set<string>();
  const hasMarker = (pattern: RegExp) => pattern.test(normalized);

  if (
    normalized.includes('"block":"uagb/') ||
    normalized.includes('wp:uagb/') ||
    normalized.includes('uagb-') ||
    normalized.includes('spectra')
  ) {
    hints.add('spectra/uagb');
  }
  if (
    hasMarker(
      /(?:wp:|\"block\":\")(?:uagb\/(?:modal(?:-popup)?|popup)|kadence\/modal)/,
    ) ||
    hasMarker(/\b(?:wp-block-uagb-modal-popup|uagb-modal-popup)\b/)
  ) {
    hints.add('modal');
  }
  if (
    hasMarker(
      /(?:wp:|\"block\":\")(?:uagb\/(?:slider|content-slider|post-carousel|testimonials|team)|kadence\/(?:slider|carousel))/,
    ) ||
    hasMarker(/\b(?:swiper(?:-container|-wrapper)?|slick-slider)\b/)
  ) {
    hints.add('slider');
  }
  if (
    hasMarker(
      /(?:wp:|\"block\":\")(?:uagb\/(?:post-carousel|slider|content-slider)|kadence\/carousel)/,
    ) ||
    hasMarker(
      /\b(?:swiper(?:-container|-wrapper)?|slick-slider|wp-block-kadence-carousel)\b/,
    )
  ) {
    hints.add('carousel');
  }
  if (
    hasMarker(
      /(?:wp:|\"block\":\")(?:uagb\/(?:faq|content-toggle)|(?:core\/)?details)/,
    ) ||
    hasMarker(
      /\b(?:wp-block-details|wp-block-uagb-faq|wp-block-uagb-content-toggle)\b/,
    )
  ) {
    hints.add('accordion');
  }
  if (
    hasMarker(/(?:wp:|\"block\":\")uagb\/tabs/) ||
    hasMarker(/\b(?:wp-block-uagb-tabs|uagb-tabs__wrap)\b/)
  ) {
    hints.add('tabs');
  }
  if (
    hasMarker(/\b(?:lightbox|data-lightbox|glightbox|fslightbox)\b/) &&
    (hasMarker(
      /(?:wp:|\"block\":\")(?:core\/gallery|core\/image|uagb\/image-gallery)/,
    ) ||
      hasMarker(/\b(?:wp-block-gallery|wp-block-image|uagb-image-gallery)\b/))
  ) {
    hints.add('lightbox');
  }

  return [...hints];
}
