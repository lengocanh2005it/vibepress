import { Injectable } from '@nestjs/common';
import {
  COMMENT_INTERFACE,
  FOOTER_COLUMN_INTERFACE,
  MENU_INTERFACE,
  MENU_ITEM_INTERFACE,
  PAGE_INTERFACE,
  POST_INTERFACE,
  SITE_INFO_INTERFACE,
} from './api-contract.js';

// ── Data-need aliases (plan uses both forms) ──────────────────────────────────
const NEED_ALIASES: Record<string, string> = {
  'site-info': 'siteInfo',
  'post-detail': 'postDetail',
  'page-detail': 'pageDetail',
};

export const FRAME_PLACEHOLDER = '{{AI_JSX_BLOCK}}';

export interface FrameOptions {
  componentName: string;
  type: 'page' | 'partial';
  dataNeeds: string[];
  isDetail: boolean;
  route?: string | null;
  fixedSlug?: string;
}

/**
 * Generates a deterministic TypeScript frame for a React component.
 *
 * The frame contains all imports, TypeScript interfaces, useState declarations,
 * useEffect data fetching, and a loading guard — everything derivable from
 * the component plan. The JSX return body is left as a placeholder
 * (FRAME_PLACEHOLDER) for the AI to fill in.
 *
 * This ensures:
 * - Tầng 1 (imports, hooks, boilerplate) is always correct — no AI mistakes
 * - Tầng 3 (export default, loading guard) is always present
 * - AI only writes Tầng 2 (JSX layout), which is much smaller and focused
 */
@Injectable()
export class FrameGeneratorService {
  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Generate the deterministic frame. Returns a TypeScript string with
   * FRAME_PLACEHOLDER where the AI JSX block should be inserted.
   */
  generateFrame(options: FrameOptions): string {
    const { componentName, type, dataNeeds, isDetail, route, fixedSlug } =
      options;
    const needs = this.normalizeNeeds(dataNeeds);
    const usesRouteParams =
      isDetail && /:[A-Za-z_]/.test(route ?? '') && !fixedSlug;

    const hasPostDetail = needs.has('postDetail') && isDetail;
    const hasPageDetail = needs.has('pageDetail') && isDetail;
    const hasPosts = needs.has('posts');
    const hasPages = needs.has('pages');
    const hasMenus = needs.has('menus');
    const hasSiteInfo = needs.has('siteInfo');
    const hasComments = needs.has('comments') && isDetail;
    const isFooter = componentName.toLowerCase().includes('footer');
    // Archive component: handles /archive, /category/:slug, /author/:slug, /tag/:slug
    const isArchive =
      componentName.toLowerCase() === 'archive' || route === '/archive';

    const needsPost = hasPostDetail || hasPosts;
    const needsPage = hasPageDetail || hasPages;

    const lines: string[] = [];

    // ── 1. Imports ────────────────────────────────────────────────────────────
    const routerImports = ['Link'];
    if (usesRouteParams) routerImports.push('useParams');
    if (isArchive) {
      if (!routerImports.includes('useParams')) routerImports.push('useParams');
      routerImports.push('useLocation');
    }
    if (hasPosts || isArchive) routerImports.push('useSearchParams');
    lines.push(`import React, { useState, useEffect } from 'react';`);
    lines.push(
      `import { ${Array.from(new Set(routerImports)).join(', ')} } from 'react-router-dom';`,
    );
    lines.push('');

    // ── 2. TypeScript interfaces ──────────────────────────────────────────────
    if (needsPost) {
      lines.push(POST_INTERFACE);
    }
    if (needsPage) {
      lines.push(PAGE_INTERFACE);
    }
    if (hasMenus && !isFooter) {
      lines.push(MENU_ITEM_INTERFACE);
      lines.push(MENU_INTERFACE);
    }
    if (isFooter) {
      lines.push(FOOTER_COLUMN_INTERFACE);
    }
    if (hasSiteInfo) {
      lines.push(SITE_INFO_INTERFACE);
    }
    if (hasComments) {
      lines.push(COMMENT_INTERFACE);
    }
    if (
      needsPost ||
      needsPage ||
      hasMenus ||
      isFooter ||
      hasSiteInfo ||
      hasComments
    ) {
      lines.push('');
    }

    // ── 3. Component function ─────────────────────────────────────────────────
    lines.push(`export default function ${componentName}() {`);

    // ── 4. useParams / archive detection ─────────────────────────────────────
    if (isArchive) {
      lines.push(`  const { slug } = useParams<{ slug?: string }>();`);
      lines.push(`  const location = useLocation();`);
      lines.push(
        `  const archiveType = location.pathname.startsWith('/category/') ? 'category'`,
      );
      lines.push(`    : location.pathname.startsWith('/author/') ? 'author'`);
      lines.push(`    : location.pathname.startsWith('/tag/') ? 'tag' : null;`);
    } else if (usesRouteParams) {
      lines.push(`  const { slug } = useParams<{ slug: string }>();`);
    } else if (isDetail && fixedSlug) {
      lines.push(`  const slug = ${JSON.stringify(fixedSlug)};`);
    }
    if (hasPosts || isArchive) {
      lines.push(
        `  const [searchParams, setSearchParams] = useSearchParams();`,
      );
      lines.push(
        `  const currentPage = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);`,
      );
      lines.push(`  const perPage = 10;`);
      lines.push(`  const [totalPages, setTotalPages] = useState(1);`);
      lines.push(`  const updatePage = (nextPage: number) => {`);
      lines.push(
        `    const safePage = Math.min(Math.max(nextPage, 1), Math.max(totalPages, 1));`,
      );
      lines.push(`    const nextParams = new URLSearchParams(searchParams);`);
      lines.push(`    if (safePage <= 1) nextParams.delete('page');`);
      lines.push(`    else nextParams.set('page', String(safePage));`);
      lines.push(`    setSearchParams(nextParams);`);
      lines.push(
        `    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });`,
      );
      lines.push(`  };`);
    }

    // ── 5. State declarations ────────────────────────────────────────────────
    if (hasPostDetail) {
      lines.push(`  const [post, setPost] = useState<Post | null>(null);`);
    } else if (hasPosts) {
      lines.push(`  const [posts, setPosts] = useState<Post[]>([]);`);
    }
    if (hasPageDetail) {
      lines.push(`  const [page, setPage] = useState<Page | null>(null);`);
    } else if (hasPages) {
      lines.push(`  const [pages, setPages] = useState<Page[]>([]);`);
    }
    if (hasMenus && !isFooter) {
      lines.push(`  const [menus, setMenus] = useState<Menu[]>([]);`);
    }
    if (isFooter) {
      lines.push(
        `  const [footerColumns, setFooterColumns] = useState<FooterColumn[]>([]);`,
      );
    }
    if (hasSiteInfo) {
      lines.push(
        `  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);`,
      );
    }
    if (hasComments) {
      lines.push(`  const [comments, setComments] = useState<Comment[]>([]);`);
    }

    // ── 6. useEffect ─────────────────────────────────────────────────────────
    const fetches = this.buildFetches({
      hasPostDetail,
      hasPosts,
      hasPageDetail,
      hasPages,
      hasMenus,
      hasSiteInfo,
      hasComments,
      isDetail,
      isFooter,
      isArchive,
    });

    if (fetches.length > 0) {
      lines.push('');
      const depArray = isArchive
        ? '[slug, archiveType, currentPage]'
        : isDetail && usesRouteParams
          ? '[slug]'
          : hasPosts
            ? '[currentPage]'
            : '[]';
      lines.push(`  useEffect(() => {`);
      lines.push(`    (async () => {`);
      if (fetches.length === 1) {
        lines.push(`      const res = await fetch(${fetches[0].url});`);
        if (fetches[0].setter === 'setPosts') {
          lines.push(`      const postsData = await res.json();`);
          lines.push(
            `      setPosts(Array.isArray(postsData) ? postsData : []);`,
          );
          lines.push(
            `      setTotalPages(Number(res.headers.get('X-WP-TotalPages') ?? '1'));`,
          );
        } else {
          lines.push(`      ${fetches[0].setter}(await res.json());`);
        }
      } else {
        const vars = fetches.map((f, i) => `r${i}`).join(', ');
        lines.push(`      const [${vars}] = await Promise.all([`);
        fetches.forEach((f, i) => {
          lines.push(
            `        fetch(${f.url})${i < fetches.length - 1 ? ',' : ''}`,
          );
        });
        lines.push(`      ]);`);
        fetches.forEach((f, i) => {
          if (f.setter === 'setPosts') {
            lines.push(`      const postsData${i} = await r${i}.json();`);
            lines.push(
              `      setPosts(Array.isArray(postsData${i}) ? postsData${i} : []);`,
            );
            lines.push(
              `      setTotalPages(Number(r${i}.headers.get('X-WP-TotalPages') ?? '1'));`,
            );
          } else {
            lines.push(`      ${f.setter}(await r${i}.json());`);
          }
        });
      }
      lines.push(`    })();`);
      lines.push(`  }, ${depArray});`);
    }

    // ── 7. Loading guard ──────────────────────────────────────────────────────
    lines.push('');
    if (hasPostDetail) {
      lines.push(
        `  if (!post) return <div className="p-8 text-center text-gray-500">Loading...</div>;`,
      );
    } else if (hasPageDetail) {
      lines.push(
        `  if (!page) return <div className="p-8 text-center text-gray-500">Loading...</div>;`,
      );
    } else if (hasSiteInfo && type === 'partial') {
      lines.push(`  if (!siteInfo) return null;`);
    } else if (hasPosts) {
      lines.push(
        `  if (!posts.length) return <div className="p-8 text-center text-gray-500">Loading...</div>;`,
      );
    }

    // ── 7.5. Deterministic menu helpers for Header/Footer/Nav ─────────────────
    // These are injected as constants so AI only writes JSX layout, not menu logic.
    if (hasMenus && !isFooter) {
      const nameLower = componentName.toLowerCase();
      if (nameLower.includes('header') || nameLower.includes('nav')) {
        lines.push('');
        // Header/Nav uses the primary location menu, falling back by slug then position
        lines.push(
          `  const navMenu = menus.find(m => m.location === 'primary') ?? menus.find(m => m.slug === 'primary') ?? menus[0];`,
        );
        lines.push(
          `  const topLevelItems = navMenu?.items?.filter(item => item.parentId === 0) ?? [];`,
        );
      }
    }

    // ── 8. Return with AI placeholder ────────────────────────────────────────
    lines.push('');
    lines.push(`  return (`);
    lines.push(`    ${FRAME_PLACEHOLDER}`);
    lines.push(`  );`);
    lines.push(`}`);

    return lines.join('\n');
  }

  /**
   * Replace the FRAME_PLACEHOLDER in the frame with the AI-generated JSX fragment.
   */
  assembleComponent(frame: string, jsxFragment: string): string {
    const cleaned = this.stripMarkdownFences(jsxFragment).trim();
    return frame.replace(FRAME_PLACEHOLDER, cleaned);
  }

  /**
   * Returns a human-readable description of declared variables for the fragment prompt.
   * Example: "posts: Post[], menus: Menu[], slug: string (from URL)"
   */
  describeVariables(options: {
    type: 'page' | 'partial';
    dataNeeds: string[];
    isDetail: boolean;
    fixedSlug?: string;
  }): string {
    const { type, dataNeeds, isDetail, fixedSlug } = options;
    const needs = this.normalizeNeeds(dataNeeds);
    const vars: string[] = [];

    const hasPostDetail = needs.has('postDetail') && isDetail;
    const hasPageDetail = needs.has('pageDetail') && isDetail;

    if (hasPostDetail) vars.push('`post: Post | null`');
    else if (needs.has('posts')) {
      vars.push('`posts: Post[]`');
      vars.push('`currentPage: number`');
      vars.push('`totalPages: number`');
      vars.push('`updatePage(nextPage: number): void`');
    }
    if (hasPageDetail) vars.push('`page: Page | null`');
    else if (needs.has('pages')) vars.push('`pages: Page[]`');
    if (needs.has('menus')) vars.push('`menus: Menu[]`');
    if (needs.has('siteInfo')) vars.push('`siteInfo: SiteInfo | null`');
    if (needs.has('comments') && isDetail) vars.push('`comments: Comment[]`');
    if (isDetail && fixedSlug)
      vars.push(`\`slug: "${fixedSlug}"\` (fixed plan binding)`);
    else if (isDetail) vars.push('`slug: string` (URL param)');

    return vars.length > 0 ? vars.join(', ') : '(no data variables)';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private normalizeNeeds(dataNeeds: string[]): Set<string> {
    const result = new Set<string>();
    for (const need of dataNeeds) {
      result.add(NEED_ALIASES[need] ?? need);
    }
    return result;
  }

  private buildFetches(flags: {
    hasPostDetail: boolean;
    hasPosts: boolean;
    hasPageDetail: boolean;
    hasPages: boolean;
    hasMenus: boolean;
    hasSiteInfo: boolean;
    hasComments: boolean;
    isDetail: boolean;
    isFooter: boolean;
    isArchive: boolean;
  }): Array<{ setter: string; url: string }> {
    const fetches: Array<{ setter: string; url: string }> = [];

    if (flags.isArchive) {
      // Dynamic URL based on archive type detected from location.pathname
      fetches.push({
        setter: 'setPosts',
        url:
          `archiveType === 'category' && slug ? \`/api/taxonomies/category/\${slug}/posts?page=\${currentPage}&perPage=\${perPage}\`` +
          ` : archiveType === 'tag' && slug ? \`/api/taxonomies/post_tag/\${slug}/posts?page=\${currentPage}&perPage=\${perPage}\`` +
          ` : archiveType === 'author' && slug ? \`/api/posts?author=\${slug}&page=\${currentPage}&perPage=\${perPage}\`` +
          ` : \`/api/posts?page=\${currentPage}&perPage=\${perPage}\``,
      });
    } else if (flags.hasPostDetail) {
      fetches.push({ setter: 'setPost', url: '`/api/posts/${slug}`' });
    } else if (flags.hasPosts) {
      fetches.push({
        setter: 'setPosts',
        url: '`/api/posts?page=${currentPage}&perPage=${perPage}`',
      });
    }

    if (flags.hasPageDetail) {
      fetches.push({ setter: 'setPage', url: '`/api/pages/${slug}`' });
    } else if (flags.hasPages) {
      fetches.push({ setter: 'setPages', url: `'/api/pages'` });
    }

    if (flags.hasMenus && !flags.isFooter) {
      fetches.push({ setter: 'setMenus', url: `'/api/menus'` });
    }
    if (flags.isFooter) {
      fetches.push({ setter: 'setFooterColumns', url: `'/api/footer-links'` });
    }

    if (flags.hasSiteInfo) {
      fetches.push({ setter: 'setSiteInfo', url: `'/api/site-info'` });
    }

    if (flags.hasComments) {
      fetches.push({
        setter: 'setComments',
        url: '`/api/comments?slug=${slug}`',
      });
    }

    return fetches;
  }

  private stripMarkdownFences(raw: string): string {
    return raw
      .replace(/^```(?:tsx|jsx|ts|js)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
  }
}
