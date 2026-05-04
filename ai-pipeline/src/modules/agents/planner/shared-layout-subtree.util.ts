import type { WpNode } from '../../../common/utils/wp-block-to-json.js';

export interface SharedLayoutSubtreeSignals {
  kinds: Set<string>;
  headingCount: number;
  hasRouteOwnedContent: boolean;
  hasFooterClass: boolean;
  hasCopyrightCopy: boolean;
  socialLinkCount: number;
  linkLikeCount: number;
}

const ROUTE_OWNED_KINDS = new Set([
  'query',
  'query-title',
  'query-no-results',
  'query-pagination',
  'post-template',
  'post-title',
  'post-content',
  'post-excerpt',
  'post-featured-image',
  'post-date',
  'post-author-name',
  'post-terms',
  'post-navigation',
  'comments',
  'search',
  'latest-posts',
  'page-list',
  'archives',
]);

export function summarizeSharedLayoutSubtree(
  node: WpNode,
): SharedLayoutSubtreeSignals {
  const kinds = new Set<string>();
  let headingCount = 0;
  let hasRouteOwnedContent = false;
  let hasFooterClass = false;
  let hasCopyrightCopy = false;
  let socialLinkCount = 0;
  let linkLikeCount = 0;

  const visit = (current: WpNode) => {
    const kind = normalizeWpNodeBlockKind(current.block);
    if (kind) {
      kinds.add(kind);
    }
    if (kind === 'heading') {
      headingCount += 1;
    }
    if (kind === 'social-link' || kind === 'social-links') {
      socialLinkCount += 1;
      linkLikeCount += 1;
    }
    if (ROUTE_OWNED_KINDS.has(kind)) {
      hasRouteOwnedContent = true;
    }

    if (
      (current.customClassNames ?? []).some((value) =>
        /\bfooter\b/i.test(value.trim()),
      )
    ) {
      hasFooterClass = true;
    }

    if (current.href?.trim()) {
      linkLikeCount += 1;
    }

    for (const candidate of [
      current.text,
      stripHtmlToPlainText(current.html),
    ]) {
      const normalized = candidate?.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      if (/©|copyright|all rights reserved|&copy;/i.test(normalized)) {
        hasCopyrightCopy = true;
      }
    }

    for (const child of current.children ?? []) {
      visit(child);
    }
  };

  visit(node);
  return {
    kinds,
    headingCount,
    hasRouteOwnedContent,
    hasFooterClass,
    hasCopyrightCopy,
    socialLinkCount,
    linkLikeCount,
  };
}

function normalizeWpNodeBlockKind(block: string | undefined): string {
  const normalized = String(block ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function stripHtmlToPlainText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const plainText = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return plainText || undefined;
}
