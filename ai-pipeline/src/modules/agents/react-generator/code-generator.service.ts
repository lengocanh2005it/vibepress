import { Injectable } from '@nestjs/common';
import type {
  ComponentVisualPlan,
  ColorPalette,
  TypographyTokens,
  LayoutTokens,
  BlockStyleToken,
  SectionPlan,
  NavbarSection,
  HeroSection,
  CoverSection,
  PostListSection,
  CardGridSection,
  MediaTextSection,
  TestimonialSection,
  NewsletterSection,
  FooterSection,
  PostContentSection,
  PageContentSection,
  CommentsSection,
  SearchSection,
  SidebarSection,
  DataNeed,
} from './visual-plan.schema.js';
import {
  COMMENT_INTERFACE,
  COMMENT_SUBMISSION_INTERFACE,
  MENU_INTERFACE,
  MENU_ITEM_INTERFACE,
  PAGE_INTERFACE,
  POST_INTERFACE,
  SITE_INFO_INTERFACE,
} from './api-contract.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import type { WpNode } from '../../../common/utils/wp-block-to-json.js';

const PADDING_MAP = {
  none: '',
  sm: 'py-8',
  md: 'py-12 lg:py-16',
  lg: 'py-16 lg:py-24',
  xl: 'py-24 lg:py-32',
};
interface RenderCtx {
  p: ColorPalette;
  t: TypographyTokens;
  l: LayoutTokens;
  b?: Record<string, BlockStyleToken>;
}

interface BlockFaithfulPartialInput {
  componentName: string;
  nodes: WpNode[];
  dataNeeds: string[];
  palette?: ColorPalette;
  typography?: TypographyTokens;
  layout?: LayoutTokens;
  blockStyles?: Record<string, BlockStyleToken>;
}

interface BlockFaithfulRenderState {
  navIndex: number;
  componentKind: 'header' | 'footer';
  componentName: string;
}

@Injectable()
export class CodeGeneratorService {
  /**
   * Generate a complete React TSX component from a visual plan.
   * All colors, typography, and layout are read from the plan — nothing hardcoded.
   */
  generate(plan: ComponentVisualPlan): string {
    // Derive effective dataNeeds from both the plan declaration AND the actual
    // sections rendered — prevents missing useState when AI omits a data need.
    const effectiveDataNeeds = this.deriveDataNeeds(plan);
    const effectivePlan = { ...plan, dataNeeds: effectiveDataNeeds };

    const needsRouter = this.needsRouter(effectivePlan);
    const needsParams = this.needsParams(effectivePlan);

    const ctx: RenderCtx = {
      p: effectivePlan.palette,
      t: effectivePlan.typography,
      l: effectivePlan.layout,
      b: effectivePlan.blockStyles,
    };

    const imports = this.buildImports(effectivePlan, needsRouter, needsParams);
    const interfaces = SHARED_INTERFACES;
    const stateAndFetch = this.buildStateAndFetch(effectivePlan);
    const body = this.buildBody(effectivePlan, ctx);

    return [imports, interfaces, stateAndFetch, body]
      .filter(Boolean)
      .join('\n\n');
  }

  generateBlockFaithfulPartial(input: BlockFaithfulPartialInput): string {
    const {
      componentName,
      nodes,
      dataNeeds,
      palette,
      typography,
      layout,
      blockStyles,
    } = input;
    const effectiveDataNeeds = Array.from(new Set(dataNeeds));
    const needsSiteInfo = effectiveDataNeeds.includes('siteInfo');
    const needsMenus = effectiveDataNeeds.includes('menus');
    const ctx: RenderCtx = {
      p: palette ?? {
        background: '#ffffff',
        surface: '#ffffff',
        text: '#111111',
        textMuted: '#666666',
        accent: '#111111',
        accentText: '#ffffff',
        dark: '#111111',
        darkText: '#ffffff',
      },
      t: typography ?? {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-[2.5rem] leading-tight',
        h2: 'text-[2rem] leading-snug',
        h3: 'text-[1.5rem] leading-snug',
        body: 'text-[1rem]',
        small: 'text-sm',
        buttonRadius: 'rounded-md',
      },
      l: layout ?? {
        containerClass: 'max-w-[1280px] mx-auto w-full',
        contentContainerClass: 'max-w-[800px] mx-auto w-full',
        blockGap: 'gap-8',
        includes: [],
      },
      b: blockStyles,
    };
    const renderState: BlockFaithfulRenderState = {
      navIndex: 0,
      componentKind: /^footer/i.test(componentName) ? 'footer' : 'header',
      componentName,
    };
    const rootTag =
      renderState.componentKind === 'footer' ? 'footer' : 'header';
    const fragment = this.renderBlockFaithfulNodes(nodes, ctx, renderState, 3);
    const lines: string[] = [
      "import React, { useEffect, useState } from 'react';",
      "import { Link } from 'react-router-dom';",
      '',
      SHARED_INTERFACES,
      '',
      `const ${componentName}: React.FC = () => {`,
    ];

    if (needsSiteInfo) {
      lines.push(
        `  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);`,
      );
    }
    if (needsMenus) {
      lines.push(`  const [menus, setMenus] = useState<Menu[]>([]);`);
    }
    if (needsSiteInfo || needsMenus) {
      lines.push('');
      lines.push('  useEffect(() => {');
      lines.push('    (async () => {');
      if (needsSiteInfo && needsMenus) {
        lines.push('      const [siteInfoRes, menusRes] = await Promise.all([');
        lines.push("        fetch('/api/site-info'),");
        lines.push("        fetch('/api/menus'),");
        lines.push('      ]);');
        lines.push('      setSiteInfo(await siteInfoRes.json());');
        lines.push('      setMenus(await menusRes.json());');
      } else if (needsSiteInfo) {
        lines.push("      const siteInfoRes = await fetch('/api/site-info');");
        lines.push('      setSiteInfo(await siteInfoRes.json());');
      } else {
        lines.push("      const menusRes = await fetch('/api/menus');");
        lines.push('      setMenus(await menusRes.json());');
      }
      lines.push('    })();');
      lines.push('  }, []);');
    }

    if (needsMenus) {
      lines.push('');
      lines.push(
        '  const navigationMenus = menus.filter((menu) => Array.isArray(menu.items));',
      );
      lines.push(
        "  const normalizeMenuLabel = (value: string) => value.toLowerCase().replace(/\\s+/g, ' ').trim();",
      );
      lines.push(
        "  const primaryMenu = navigationMenus.find((menu) => menu.location === 'primary') ?? navigationMenus.find((menu) => menu.slug === 'primary') ?? navigationMenus[0] ?? null;",
      );
      lines.push(
        "  const footerNavigationMenus = navigationMenus.filter((menu) => menu !== primaryMenu && menu.location !== 'primary' && menu.slug !== 'primary');",
      );
      lines.push(
        '  const scoreMenuByHints = (menu: Menu, hintTitles: string[]) => {',
      );
      lines.push('    if (hintTitles.length === 0) return 0;');
      lines.push('    const topLevelTitles = (menu.items ?? [])');
      lines.push('      .filter((item) => item.parentId === 0)');
      lines.push('      .map((item) => normalizeMenuLabel(item.title));');
      lines.push('    return hintTitles.reduce((score, title) => {');
      lines.push(
        '      return score + (topLevelTitles.includes(normalizeMenuLabel(title)) ? 1 : 0);',
      );
      lines.push('    }, 0);');
      lines.push('  };');
      lines.push(
        '  const resolveNavigationMenu = (hintTitles: string[] = [], index = 0, preferFooter = false) => {',
      );
      lines.push('    const hintedTitles = hintTitles.filter(Boolean);');
      lines.push('    const pool = preferFooter');
      lines.push(
        '      ? (footerNavigationMenus.length > 0 ? footerNavigationMenus : navigationMenus.filter((menu) => menu !== primaryMenu))',
      );
      lines.push(
        '      : (primaryMenu ? [primaryMenu, ...navigationMenus.filter((menu) => menu !== primaryMenu)] : navigationMenus);',
      );
      lines.push('    if (pool.length === 0) return null;');
      lines.push('    const scored = pool');
      lines.push(
        '      .map((menu) => ({ menu, score: scoreMenuByHints(menu, hintedTitles) }))',
      );
      lines.push('      .sort((a, b) => b.score - a.score);');
      lines.push(
        '    if ((scored[0]?.score ?? 0) > 0) return scored[0]?.menu ?? null;',
      );
      lines.push('    return pool[index] ?? pool[0] ?? null;');
      lines.push('  };');
      lines.push(
        '  const renderMenuItems = (items: MenuItem[], parentId = 0, vertical = false): React.ReactNode =>',
      );
      lines.push('    items');
      lines.push('      .filter((item) => item.parentId === parentId)');
      lines.push('      .sort((a, b) => a.order - b.order)');
      lines.push('      .map((item) => {');
      lines.push(
        '        const hasChildren = items.some((child) => child.parentId === item.id);',
      );
      lines.push('        return (');
      lines.push(
        '          <li key={item.id} className={vertical ? "flex flex-col gap-2" : "relative"}>',
      );
      lines.push('            {isInternalPath(item.url) ? (');
      lines.push(
        '              <Link to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="transition-opacity hover:opacity-75">',
      );
      lines.push('                {item.title}');
      lines.push('              </Link>');
      lines.push('            ) : (');
      lines.push(
        '              <a href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="transition-opacity hover:opacity-75">',
      );
      lines.push('              {item.title}');
      lines.push('            </a>');
      lines.push('            )}');
      lines.push('            {hasChildren ? (');
      lines.push(
        '              <ul className={vertical ? "pl-4 flex flex-col gap-2" : "pl-4 mt-2 flex flex-col gap-2"}>',
      );
      lines.push('                {renderMenuItems(items, item.id, true)}');
      lines.push('              </ul>');
      lines.push('            ) : null}');
      lines.push('          </li>');
      lines.push('        );');
      lines.push('      });');
    }

    lines.push('');
    lines.push('  const toAppPath = (url?: string) => {');
    lines.push("    if (!url) return '/';");
    lines.push('    try {');
    lines.push('      if (!siteInfo?.siteUrl) return url;');
    lines.push('      const site = new URL(siteInfo.siteUrl);');
    lines.push('      const resolved = new URL(url, siteInfo.siteUrl);');
    lines.push('      if (resolved.origin === site.origin) {');
    lines.push(
      "        return `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';",
    );
    lines.push('      }');
    lines.push('      return url;');
    lines.push('    } catch {');
    lines.push('      return url;');
    lines.push('    }');
    lines.push('  };');
    lines.push('');
    lines.push('  const isInternalPath = (url?: string) => {');
    lines.push('    const next = toAppPath(url);');
    lines.push("    return next.startsWith('/');");
    lines.push('  };');

    if (needsSiteInfo) {
      lines.push('');
      lines.push('  if (!siteInfo) return null;');
    }

    lines.push('');
    lines.push('  return (');
    lines.push(`    <${rootTag} className="w-full">`);
    if (fragment) lines.push(fragment);
    lines.push(`    </${rootTag}>`);
    lines.push('  );');
    lines.push('};');
    lines.push('');
    lines.push(`export default ${componentName};`);

    return lines.join('\n');
  }

  /**
   * Merge plan.dataNeeds with data vars required by the concrete sections.
   * Prevents mismatches when AI forgets to declare a data dependency.
   */
  private deriveDataNeeds(plan: ComponentVisualPlan): DataNeed[] {
    const needs = new Set(plan.dataNeeds);
    for (const section of plan.sections) {
      switch (section.type) {
        case 'navbar':
          needs.add('siteInfo');
          needs.add('menus');
          break;
        case 'footer':
          needs.add('siteInfo');
          needs.add('menus');
          break;
        case 'post-list':
        case 'search':
          needs.add('posts');
          break;
        case 'post-content':
        case 'comments':
          needs.add('postDetail');
          break;
        case 'page-content':
          needs.add('pageDetail');
          break;
        case 'sidebar': {
          const sidebar = section as SidebarSection;
          if (sidebar.showSiteInfo) needs.add('siteInfo');
          if (sidebar.showPages) needs.add('pages');
          if (sidebar.showPosts) needs.add('posts');
          if (sidebar.menuSlug) needs.add('menus');
          break;
        }
      }
    }
    return Array.from(needs);
  }

  // ── Imports ───────────────────────────────────────────────────────────────

  private buildImports(
    plan: ComponentVisualPlan,
    needsRouter: boolean,
    needsParams: boolean,
  ): string {
    const lines: string[] = [
      "import React, { useState, useEffect } from 'react';",
    ];
    const routerParts: string[] = [];
    if (needsRouter) routerParts.push('Link');
    if (needsParams) routerParts.push('useParams');
    if (this.needsPagination(plan)) routerParts.push('useSearchParams');
    if (routerParts.length > 0) {
      lines.push(
        `import { ${Array.from(new Set(routerParts)).join(', ')} } from 'react-router-dom';`,
      );
    }
    // Import shared partial components (Header, Footer, etc.) from layout plan
    const currentFolder = isPartialComponentName(plan.componentName)
      ? 'components'
      : 'pages';
    for (const name of plan.layout.includes) {
      const targetFolder = isPartialComponentName(name)
        ? 'components'
        : 'pages';
      const importPath =
        currentFolder === targetFolder
          ? `./${name}`
          : `../${targetFolder}/${name}`;
      lines.push(`import ${name} from '${importPath}';`);
    }
    return lines.join('\n');
  }

  private needsRouter(plan: ComponentVisualPlan): boolean {
    return plan.sections.some((s) =>
      [
        'navbar',
        'footer',
        'breadcrumb',
        'post-list',
        'search',
        'sidebar',
        'hero',
        'cover',
      ].includes(s.type),
    );
  }

  private needsParams(plan: ComponentVisualPlan): boolean {
    return (
      plan.dataNeeds.includes('postDetail') ||
      plan.dataNeeds.includes('pageDetail')
    );
  }

  private needsPagination(plan: ComponentVisualPlan): boolean {
    return plan.dataNeeds.includes('posts');
  }

  // ── State + fetch ─────────────────────────────────────────────────────────

  private buildStateAndFetch(plan: ComponentVisualPlan): string {
    const { dataNeeds, componentName } = plan;
    const commentsSection =
      plan.sections.find(
        (section): section is CommentsSection => section.type === 'comments',
      ) ?? null;
    const needsComments = !!commentsSection && dataNeeds.includes('postDetail');
    const supportsCommentForm = needsComments && commentsSection.showForm;
    const lines: string[] = [];

    lines.push(`const ${componentName}: React.FC = () => {`);

    // State
    if (dataNeeds.includes('siteInfo'))
      lines.push(
        `  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);`,
      );
    if (dataNeeds.includes('posts')) {
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
      lines.push(`  const [posts, setPosts] = useState<Post[]>([]);`);
    }
    if (dataNeeds.includes('pages'))
      lines.push(`  const [pages, setPages] = useState<Page[]>([]);`);
    if (dataNeeds.includes('menus'))
      lines.push(`  const [menus, setMenus] = useState<Menu[]>([]);`);
    if (dataNeeds.includes('postDetail')) {
      lines.push(`  const [item, setItem] = useState<Post | null>(null);`);
      lines.push(`  const { slug } = useParams<{ slug: string }>();`);
    } else if (dataNeeds.includes('pageDetail')) {
      lines.push(`  const [item, setItem] = useState<Page | null>(null);`);
      lines.push(`  const { slug } = useParams<{ slug: string }>();`);
    }
    if (needsComments) {
      lines.push(`  const [comments, setComments] = useState<Comment[]>([]);`);
      lines.push(
        `  const topLevelComments = comments.filter((comment) => (comment.parentId ?? 0) === 0);`,
      );
      lines.push(
        `  const repliesFor = (parentId: number) => comments.filter((comment) => (comment.parentId ?? 0) === parentId);`,
      );
    }
    if (supportsCommentForm) {
      lines.push(
        `  const [pendingComments, setPendingComments] = useState<CommentSubmission[]>([]);`,
      );
      lines.push(`  const [commentClientToken] = useState(() => {`);
      lines.push(
        `    if (typeof window === 'undefined') return 'vibepress-comment-client';`,
      );
      lines.push(`    const storageKey = 'vibepress-comment-client-token';`);
      lines.push(
        `    const existing = window.localStorage.getItem(storageKey);`,
      );
      lines.push(`    if (existing) return existing;`);
      lines.push(
        `    const created = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'vp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);`,
      );
      lines.push(`    window.localStorage.setItem(storageKey, created);`);
      lines.push(`    return created;`);
      lines.push(`  });`);
      lines.push(`  const [commentAuthor, setCommentAuthor] = useState('');`);
      lines.push(`  const [commentEmail, setCommentEmail] = useState('');`);
      lines.push(`  const [commentContent, setCommentContent] = useState('');`);
      lines.push(
        `  const [submittingComment, setSubmittingComment] = useState(false);`,
      );
      lines.push(
        `  const [commentError, setCommentError] = useState<string | null>(null);`,
      );
      lines.push(
        `  const [commentSuccess, setCommentSuccess] = useState<string | null>(null);`,
      );
    }
    lines.push(`  const [loading, setLoading] = useState(true);`);
    lines.push(`  const [error, setError] = useState<string | null>(null);`);
    lines.push('');

    if (needsComments) {
      lines.push(`  const fetchComments = async () => {`);
      lines.push(`    if (!slug) return;`);
      lines.push(
        `    const commentsRes = await fetch(\`/api/comments?slug=\${encodeURIComponent(slug)}\`);`,
      );
      lines.push(
        `    if (!commentsRes.ok) throw new Error('Comments not available');`,
      );
      lines.push(`    const commentsData = await commentsRes.json();`);
      lines.push(
        `    setComments(Array.isArray(commentsData) ? commentsData : []);`,
      );
      lines.push(`  };`);
      lines.push('');
    }
    if (supportsCommentForm) {
      lines.push(`  const fetchTrackedComments = async () => {`);
      lines.push(`    if (!slug) return [];`);
      lines.push(
        `    const trackedRes = await fetch(\`/api/comments/submissions?slug=\${encodeURIComponent(slug)}&clientToken=\${encodeURIComponent(commentClientToken)}\`);`,
      );
      lines.push(
        `    if (!trackedRes.ok) throw new Error('Comment moderation status not available');`,
      );
      lines.push(`    const trackedData = await trackedRes.json();`);
      lines.push(`    return Array.isArray(trackedData) ? trackedData : [];`);
      lines.push(`  };`);
      lines.push('');
    }

    // Fetch
    lines.push(`  useEffect(() => {`);
    lines.push(`    const fetchData = async () => {`);
    lines.push(`      try {`);

    const fetches: string[] = [];
    const setters: string[] = [];

    if (dataNeeds.includes('siteInfo')) {
      fetches.push(`fetch('/api/site-info')`);
      setters.push(`setSiteInfo(await res0.json());`);
    }
    if (dataNeeds.includes('posts')) {
      fetches.push(
        `fetch(\`/api/posts?page=\${currentPage}&perPage=\${perPage}\`)`,
      );
      setters.push(
        `const postsData = await res${fetches.length - 1}.json(); setPosts(Array.isArray(postsData) ? postsData : []); setTotalPages(Number(res${fetches.length - 1}.headers.get('X-WP-TotalPages') ?? '1'));`,
      );
    }
    if (dataNeeds.includes('pages')) {
      fetches.push(`fetch('/api/pages')`);
      setters.push(`setPages(await res${fetches.length - 1}.json());`);
    }
    if (dataNeeds.includes('menus')) {
      fetches.push(`fetch('/api/menus')`);
      setters.push(`setMenus(await res${fetches.length - 1}.json());`);
    }
    if (dataNeeds.includes('postDetail')) {
      lines.push(
        `        if (!slug) throw new Error('Post slug is required');`,
      );
      lines.push(
        `        const detailRes = await fetch(\`/api/posts/\${slug}\`);`,
      );
      lines.push(
        `        if (!detailRes.ok) throw new Error('Post not found');`,
      );
      lines.push(`        setItem(await detailRes.json());`);
      if (needsComments) lines.push(`        await fetchComments();`);
    }
    if (dataNeeds.includes('pageDetail')) {
      lines.push(
        `        if (!slug) throw new Error('Page slug is required');`,
      );
      lines.push(
        `        const detailRes = await fetch(\`/api/pages/\${slug}\`);`,
      );
      lines.push(
        `        if (!detailRes.ok) throw new Error('Page not found');`,
      );
      lines.push(`        setItem(await detailRes.json());`);
    }

    if (fetches.length > 0) {
      lines.push(
        `        const [${fetches.map((_, i) => `res${i}`).join(', ')}] = await Promise.all([`,
      );
      for (const f of fetches) lines.push(`          ${f},`);
      lines.push(`        ]);`);
      for (let i = 0; i < setters.length; i++) {
        lines.push(`        ${setters[i]}`);
      }
    }

    lines.push(`      } catch (err) {`);
    lines.push(
      `        setError(err instanceof Error ? err.message : 'Error loading data');`,
    );
    lines.push(`      } finally {`);
    lines.push(`        setLoading(false);`);
    lines.push(`      }`);
    lines.push(`    };`);
    lines.push(`    fetchData();`);

    if (dataNeeds.includes('postDetail') || dataNeeds.includes('pageDetail')) {
      lines.push(`  }, [slug]);`);
    } else if (dataNeeds.includes('posts')) {
      lines.push(`  }, [currentPage]);`);
    } else {
      lines.push(`  }, []);`);
    }

    lines.push('');

    if (supportsCommentForm) {
      lines.push(`  useEffect(() => {`);
      lines.push(`    if (!slug) return;`);
      lines.push(`    let cancelled = false;`);
      lines.push(`    setPendingComments([]);`);
      lines.push(``);
      lines.push(`    const syncTrackedComments = async () => {`);
      lines.push(`      try {`);
      lines.push(
        `        const trackedComments = await fetchTrackedComments();`,
      );
      lines.push(`        if (cancelled) return;`);
      lines.push(
        `        const pendingOnly = trackedComments.filter((comment) => comment.moderationStatus === 'pending');`,
      );
      lines.push(`        setPendingComments(pendingOnly);`);
      lines.push(
        `        if (trackedComments.some((comment) => comment.moderationStatus === 'approved')) {`,
      );
      lines.push(`          await fetchComments();`);
      lines.push(`        }`);
      lines.push(`      } catch {`);
      lines.push(
        `        // Ignore tracking errors so the public comments UI still works.`,
      );
      lines.push(`      }`);
      lines.push(`    };`);
      lines.push(``);
      lines.push(`    void syncTrackedComments();`);
      lines.push(``);
      lines.push(`    return () => {`);
      lines.push(`      cancelled = true;`);
      lines.push(`    };`);
      lines.push(`  }, [slug, commentClientToken]);`);
      lines.push(``);
      lines.push(`  useEffect(() => {`);
      lines.push(`    if (!slug || pendingComments.length === 0) return;`);
      lines.push(`    let cancelled = false;`);
      lines.push(``);
      lines.push(`    const pollTrackedComments = async () => {`);
      lines.push(`      try {`);
      lines.push(
        `        const trackedComments = await fetchTrackedComments();`,
      );
      lines.push(`        if (cancelled) return;`);
      lines.push(
        `        const approvedCount = trackedComments.filter((comment) => comment.moderationStatus === 'approved').length;`,
      );
      lines.push(
        `        const rejectedCount = trackedComments.filter((comment) => comment.moderationStatus === 'spam' || comment.moderationStatus === 'trash').length;`,
      );
      lines.push(
        `        const nextPending = trackedComments.filter((comment) => comment.moderationStatus === 'pending');`,
      );
      lines.push(`        setPendingComments(nextPending);`);
      lines.push(`        if (approvedCount > 0) {`);
      lines.push(`          await fetchComments();`);
      lines.push(`          if (!cancelled) {`);
      lines.push(
        `            setCommentSuccess('Your comment was approved and is now visible.');`,
      );
      lines.push(`          }`);
      lines.push(
        `        } else if (rejectedCount > 0 && nextPending.length === 0) {`,
      );
      lines.push(
        `          setCommentError('A submitted comment was not approved.');`,
      );
      lines.push(`        }`);
      lines.push(`      } catch {`);
      lines.push(`        // Ignore temporary polling failures.`);
      lines.push(`      }`);
      lines.push(`    };`);
      lines.push(``);
      lines.push(`    const intervalId = window.setInterval(() => {`);
      lines.push(`      void pollTrackedComments();`);
      lines.push(`    }, 15000);`);
      lines.push(``);
      lines.push(`    void pollTrackedComments();`);
      lines.push(``);
      lines.push(`    return () => {`);
      lines.push(`      cancelled = true;`);
      lines.push(`      window.clearInterval(intervalId);`);
      lines.push(`    };`);
      lines.push(`  }, [slug, pendingComments.length, commentClientToken]);`);
      lines.push(``);
      const authorValue = commentsSection.requireName
        ? 'commentAuthor.trim()'
        : "'Guest'";
      const emailValue = commentsSection.requireEmail
        ? 'commentEmail.trim()'
        : "'guest@local.dev'";
      lines.push(
        `  const handleCommentSubmit = async (event: React.FormEvent<HTMLFormElement>) => {`,
      );
      lines.push(`    event.preventDefault();`);
      lines.push(`    if (!slug) {`);
      lines.push(`      setCommentError('Post slug is missing.');`);
      lines.push(`      return;`);
      lines.push(`    }`);
      if (commentsSection.requireName) {
        lines.push(`    if (!commentAuthor.trim()) {`);
        lines.push(`      setCommentError('Name is required.');`);
        lines.push(`      return;`);
        lines.push(`    }`);
      }
      if (commentsSection.requireEmail) {
        lines.push(`    if (!commentEmail.trim()) {`);
        lines.push(`      setCommentError('Email is required.');`);
        lines.push(`      return;`);
        lines.push(`    }`);
      }
      lines.push(`    if (!commentContent.trim()) {`);
      lines.push(`      setCommentError('Comment is required.');`);
      lines.push(`      return;`);
      lines.push(`    }`);
      lines.push('');
      lines.push(`    setSubmittingComment(true);`);
      lines.push(`    setCommentError(null);`);
      lines.push(`    setCommentSuccess(null);`);
      lines.push('');
      lines.push(`    try {`);
      lines.push(`      const response = await fetch('/api/comments', {`);
      lines.push(`        method: 'POST',`);
      lines.push(`        headers: { 'Content-Type': 'application/json' },`);
      lines.push(`        body: JSON.stringify({`);
      lines.push(`          slug,`);
      lines.push(`          author: ${authorValue},`);
      lines.push(`          email: ${emailValue},`);
      lines.push(`          content: commentContent.trim(),`);
      lines.push(`          parentId: 0,`);
      lines.push(`          clientToken: commentClientToken,`);
      lines.push(`        }),`);
      lines.push(`      });`);
      lines.push('');
      lines.push(`      const createdComment = await response.json();`);
      lines.push(`      if (!response.ok) {`);
      lines.push(
        `        throw new Error(createdComment?.error || 'Could not post comment');`,
      );
      lines.push(`      }`);
      lines.push('');
      lines.push(`      setPendingComments((prev) => {`);
      lines.push(
        `        const next = [createdComment, ...prev.filter((comment) => comment.id !== createdComment.id)];`,
      );
      lines.push(
        `        return next.filter((comment) => comment.moderationStatus === 'pending');`,
      );
      lines.push(`      });`);
      lines.push(`      setCommentContent('');`);
      lines.push(
        `      setCommentSuccess('Comment submitted and awaiting moderation.');`,
      );
      if (commentsSection.requireName)
        lines.push(`      setCommentAuthor('');`);
      if (commentsSection.requireEmail)
        lines.push(`      setCommentEmail('');`);
      lines.push(`    } catch (err) {`);
      lines.push(
        `      setCommentError(err instanceof Error ? err.message : 'Could not post comment');`,
      );
      lines.push(`    } finally {`);
      lines.push(`      setSubmittingComment(false);`);
      lines.push(`    }`);
      lines.push(`  };`);
      lines.push('');
    }

    lines.push(
      `  if (loading) return <div className="min-h-screen flex items-center justify-center"><span>Loading...</span></div>;`,
    );
    lines.push(
      `  if (error) return <div className="min-h-screen flex items-center justify-center text-red-500">{error}</div>;`,
    );
    lines.push('');

    return lines.join('\n');
  }

  // ── Component body ────────────────────────────────────────────────────────

  private buildBody(plan: ComponentVisualPlan, ctx: RenderCtx): string {
    const { componentName, palette, sections } = plan;
    const sectionJsx = this.buildSections(plan, ctx);
    const rootStyle = this.buildStyleAttr({
      fontFamily: ctx.t.bodyFamily,
    });

    return `  return (
    <div className="bg-[${palette.background}] text-[${palette.text}] flex flex-col ${ctx.l.blockGap}"${rootStyle}>
${sectionJsx}
    </div>
  );
};

export default ${componentName};`;
  }

  private contentContainerClass(ctx: RenderCtx): string {
    return ctx.l.contentContainerClass ?? 'max-w-[800px] mx-auto w-full';
  }

  private buildSections(plan: ComponentVisualPlan, ctx: RenderCtx): string {
    const parts: string[] = [];
    const sidebarSection =
      plan.layout.contentLayout && plan.layout.contentLayout !== 'single-column'
        ? (plan.sections.find(
            (s): s is SidebarSection => s.type === 'sidebar',
          ) ?? null)
        : null;
    const mainContentSection = plan.sections.find(
      (s) => s.type === 'page-content' || s.type === 'post-content',
    );

    for (const section of plan.sections) {
      if (sidebarSection && section === sidebarSection && mainContentSection) {
        continue;
      }
      if (
        sidebarSection &&
        mainContentSection &&
        section === mainContentSection
      ) {
        parts.push(
          this.renderContentWithSidebar(
            mainContentSection,
            sidebarSection,
            ctx,
            plan.layout.contentLayout === 'sidebar-left',
            plan.componentName,
          ),
        );
        continue;
      }
      parts.push(this.renderSection(section, ctx, plan.componentName));
    }

    return parts.join('\n\n');
  }

  // ── Section dispatcher ────────────────────────────────────────────────────

  private renderSection(
    section: SectionPlan,
    ctx: RenderCtx,
    componentName: string,
  ): string {
    const bg = section.background ?? ctx.p.background;
    const tc = section.textColor ?? ctx.p.text;
    const py = this.sectionPaddingClass(section);
    let markup = '';

    switch (section.type) {
      case 'navbar':
        markup = this.renderNavbar(section, ctx);
        break;
      case 'hero':
        markup = this.renderHero(section, ctx, py);
        break;
      case 'cover':
        markup = this.renderCover(section, ctx);
        break;
      case 'post-list':
        markup = this.renderPostList(section, ctx, bg, tc, py);
        break;
      case 'card-grid':
        markup = this.renderCardGrid(section, ctx, bg, tc, py);
        break;
      case 'media-text':
        markup = this.renderMediaText(section, ctx, bg, tc, py);
        break;
      case 'testimonial':
        markup = this.renderTestimonial(section, ctx, py);
        break;
      case 'newsletter':
        markup = this.renderNewsletter(section, ctx, bg, tc, py);
        break;
      case 'footer':
        markup = this.renderFooter(section, ctx);
        break;
      case 'post-content':
        markup = this.renderPostContent(section, ctx, py);
        break;
      case 'page-content':
        markup = this.renderPageContent(section, ctx, py);
        break;
      case 'comments':
        markup = this.renderComments(section, ctx, py);
        break;
      case 'search':
        markup = this.renderSearch(section, ctx, py);
        break;
      case 'breadcrumb':
        markup = this.renderBreadcrumb(ctx);
        break;
      case 'sidebar':
        markup = this.renderSidebar(section, ctx, py);
        break;
    }

    return this.annotateSectionMarkup(section, markup, componentName);
  }

  private buildStyleAttr(
    style: Record<string, string | number | undefined>,
  ): string {
    const entries = Object.entries(style).filter(
      ([, value]) => value !== undefined && value !== '',
    );
    if (entries.length === 0) return '';

    return ` style={{ ${entries
      .map(([key, value]) =>
        typeof value === 'number'
          ? `${key}: ${value}`
          : `${key}: '${String(value).replace(/'/g, "\\'")}'`,
      )
      .join(', ')} }}`;
  }

  private buildSectionStyleAttr(
    section: SectionPlan,
    extra: Record<string, string | number | undefined> = {},
  ): string {
    return this.buildStyleAttr({
      padding: section.paddingStyle,
      margin: section.marginStyle,
      ...extra,
    });
  }

  private sectionPaddingClass(section: SectionPlan): string {
    if (section.paddingStyle) return '';
    return PADDING_MAP[section.padding ?? 'lg'];
  }

  private buildSectionGapStyleAttr(section: SectionPlan): string {
    return section.gapStyle
      ? this.buildStyleAttr({ gap: section.gapStyle })
      : '';
  }

  private annotateSectionMarkup(
    section: SectionPlan,
    markup: string,
    componentName: string,
  ): string {
    const trackingAttrs = this.buildSectionTrackingAttrs(
      section,
      componentName,
    );
    if (!trackingAttrs) return markup;

    return markup.replace(
      /(<(?:section|header|footer|main|article|aside|nav|div)\b)(?![^>]*\bdata-vp-source-node=)/,
      `$1${trackingAttrs}`,
    );
  }

  private buildSectionTrackingAttrs(
    section: SectionPlan,
    componentName: string,
  ): string {
    if (!section.sourceRef?.sourceNodeId) return '';

    const attrs = [
      ['data-vp-source-node', section.sourceRef.sourceNodeId],
      ['data-vp-template', section.sourceRef.templateName],
      ['data-vp-source-file', section.sourceRef.sourceFile],
      ['data-vp-section-key', section.sectionKey ?? section.type],
      ['data-vp-component', componentName],
      [
        'data-vp-section-component',
        this.buildTrackedSectionComponentName(
          componentName,
          section.sectionKey ?? section.type,
        ),
      ],
    ].filter(([, value]) => !!value);

    return attrs
      .map(
        ([name, value]) =>
          ` ${name}="${String(value).replace(/"/g, '&quot;')}"`,
      )
      .join('');
  }

  private buildTrackedSectionComponentName(
    componentName: string,
    sectionKey: string,
  ): string {
    return `${componentName}${sectionKey
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join('')}Section`;
  }

  private exactRadiusClass(value?: string): string {
    if (!value) return '';
    const normalized = value.trim();
    if (!normalized || normalized === '0' || normalized === '0px') {
      return 'rounded-none';
    }
    if (normalized.includes('9999')) return 'rounded-full';
    return `rounded-[${normalized}]`;
  }

  private imageRadiusClass(ctx: RenderCtx): string {
    return this.exactRadiusClass(ctx.l.imageRadius);
  }

  private cardRadiusClass(ctx: RenderCtx): string {
    return this.exactRadiusClass(ctx.l.cardRadius);
  }

  private buttonStyleAttr(ctx: RenderCtx): string {
    const style = this.pickBlockStyle(ctx, 'button');
    return this.buildBlockStyleAttr(
      style,
      { padding: ctx.l.buttonPadding },
      true,
    );
  }

  private pickBlockStyle(
    ctx: RenderCtx,
    ...keys: string[]
  ): BlockStyleToken | undefined {
    if (!ctx.b) return undefined;
    for (const key of keys) {
      const value = ctx.b[key];
      if (value) return value;
    }
    return undefined;
  }

  private buildBlockStyleAttr(
    style?: BlockStyleToken,
    base: Record<string, string | number | undefined> = {},
    preferStyle = false,
  ): string {
    const styleMap: Record<string, string | number | undefined> = {
      ...base,
    };
    if (style?.color?.background) {
      if (preferStyle || styleMap.backgroundColor === undefined) {
        styleMap.backgroundColor = style.color.background;
      }
    }
    if (style?.color?.text) {
      if (preferStyle || styleMap.color === undefined) {
        styleMap.color = style.color.text;
      }
    }
    if (style?.typography?.fontSize)
      styleMap.fontSize = style.typography.fontSize;
    if (style?.typography?.fontFamily)
      styleMap.fontFamily = style.typography.fontFamily;
    if (style?.typography?.fontWeight)
      styleMap.fontWeight = style.typography.fontWeight;
    if (style?.typography?.letterSpacing)
      styleMap.letterSpacing = style.typography.letterSpacing;
    if (style?.typography?.lineHeight)
      styleMap.lineHeight = style.typography.lineHeight;
    if (style?.typography?.textTransform)
      styleMap.textTransform = style.typography.textTransform;
    if (style?.border?.radius) styleMap.borderRadius = style.border.radius;
    if (style?.border?.width) styleMap.borderWidth = style.border.width;
    if (style?.border?.style) styleMap.borderStyle = style.border.style;
    if (style?.border?.color) styleMap.borderColor = style.border.color;
    if (style?.spacing?.padding) styleMap.padding = style.spacing.padding;
    if (style?.spacing?.margin) styleMap.margin = style.spacing.margin;
    if (style?.spacing?.gap) styleMap.gap = style.spacing.gap;
    return this.buildStyleAttr(styleMap);
  }

  private buildTypographyStyleAttr(
    ...styles: Array<BlockStyleToken['typography'] | undefined>
  ): string {
    const styleMap: Record<string, string | number | undefined> = {};
    for (const style of styles) {
      if (!style) continue;
      if (style.fontSize) styleMap.fontSize = style.fontSize;
      if (style.fontFamily) styleMap.fontFamily = style.fontFamily;
      if (style.fontWeight) styleMap.fontWeight = style.fontWeight;
      if (style.letterSpacing) styleMap.letterSpacing = style.letterSpacing;
      if (style.lineHeight) styleMap.lineHeight = style.lineHeight;
      if (style.textTransform) styleMap.textTransform = style.textTransform;
    }
    return this.buildStyleAttr(styleMap);
  }

  private responsiveGridColumnsClass(
    columnCount: number,
    columnWidths?: string[],
    breakpoint: 'md' | 'lg' = 'lg',
  ): string {
    const defaults = `grid-cols-1 sm:grid-cols-2 ${columnCount >= 3 ? 'lg:grid-cols-3' : ''} ${columnCount === 4 ? 'xl:grid-cols-4' : ''}`;
    if (!columnWidths || columnWidths.length !== columnCount) return defaults;
    const tracks = columnWidths
      .map((value) => value.trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .join('_');
    if (!tracks) return defaults;
    const base =
      columnCount === 2 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2';
    return `${base} ${breakpoint}:grid-cols-[${tracks}]`;
  }

  // ── Section renderers ─────────────────────────────────────────────────────

  private renderNavbar(s: NavbarSection, ctx: RenderCtx): string {
    const { p, t, l } = ctx;
    const navStyle = this.pickBlockStyle(ctx, 'navigation');
    const bg = s.background ?? p.surface;
    const tc = s.textColor ?? p.text;
    const sticky = s.sticky ? 'sticky top-0 z-50 ' : '';
    const sectionStyle = this.buildBlockStyleAttr(
      navStyle,
      { ...this.extractSectionStyleBase(s) },
      true,
    );
    const buttonStyle = this.buttonStyleAttr(ctx);
    const cta = s.cta
      ? s.cta.style === 'button'
        ? `\n            <Link to="${s.cta.link}" className="bg-[${p.accent}] text-[${p.accentText}] px-4 py-2 ${t.buttonRadius} hover:opacity-90 transition-opacity"${buttonStyle}>${s.cta.text}</Link>`
        : `\n            <Link to="${s.cta.link}" className="text-[${tc}] hover:text-[${p.accent}] transition-colors">${s.cta.text}</Link>`
      : '';

    return `      {/* Navbar */}
      <header className="${sticky}bg-[${bg}] border-b border-black/10 w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex items-center justify-between py-4"${this.buildSectionGapStyleAttr(s)}>
            <Link to="/" className="font-bold text-[${tc}]">{siteInfo?.siteName}</Link>
            <nav className="hidden md:flex items-center gap-6">
              {menus.find(m => m.slug === '${s.menuSlug}')?.items
                .filter(i => i.parentId === 0)
                .map(item => (
                  isInternalPath(item.url) ? (
                    <Link key={item.id} to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="text-[${tc}] hover:text-[${p.accent}] transition-colors">
                      {item.title}
                    </Link>
                  ) : (
                    <a key={item.id} href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="text-[${tc}] hover:text-[${p.accent}] transition-colors">
                      {item.title}
                    </a>
                  )
                ))}
            </nav>
            <div className="flex items-center gap-4">${cta}
            </div>
          </div>
        </div>
      </header>`;
  }

  private renderHero(s: HeroSection, ctx: RenderCtx, py: string): string {
    const { p, t, l } = ctx;
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const headingStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'heading')?.typography,
      s.headingStyle,
    );
    const subheadingStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'paragraph')?.typography,
      s.subheadingStyle,
    );
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const buttonStyle = this.buttonStyleAttr(ctx);
    const imageRadius = this.imageRadiusClass(ctx);
    const cta = s.cta
      ? `\n            <Link to="${s.cta.link}" className="inline-block bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity"${buttonStyle}>${s.cta.text}</Link>`
      : '';
    const image = s.image
      ? s.image.position === 'below'
        ? `\n          <img src="${s.image.src}" alt="${s.image.alt}" className="w-full h-auto mt-8 object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle)} />`
        : `\n          <div className="flex-1"><img src="${s.image.src}" alt="${s.image.alt}" className="w-full h-auto object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle)} /></div>`
      : '';

    const isCenter = s.layout === 'centered';
    const isSplit = s.layout === 'split';

    if (isSplit && s.image) {
      return `      {/* Hero */}
      <section className="bg-[${bg}] ${py}"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex flex-col md:flex-row gap-8 items-center"${this.buildSectionGapStyleAttr(s)}>
            <div className="flex-1 flex flex-col gap-4">
              <h1 className="${t.h1} font-normal text-[${tc}]"${headingStyle}>${s.heading}</h1>
              ${s.subheading ? `<p className="text-lg text-[${p.textMuted}]"${subheadingStyle}>${s.subheading}</p>` : ''}
              ${cta}
            </div>${image}
          </div>
        </div>
      </section>`;
    }

    return `      {/* Hero */}
      <section className="bg-[${bg}] ${py}"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex flex-col ${isCenter ? 'items-center text-center' : 'items-start'} gap-6 max-w-[640px] ${isCenter ? 'mx-auto' : ''}"${this.buildSectionGapStyleAttr(s)}>
            <h1 className="${t.h1} font-normal text-[${tc}]"${headingStyle}>${s.heading}</h1>
            ${s.subheading ? `<p className="text-lg text-[${p.textMuted}]"${subheadingStyle}>${s.subheading}</p>` : ''}
            ${cta}
          </div>${image}
        </div>
      </section>`;
  }

  private renderCover(s: CoverSection, ctx: RenderCtx): string {
    const { p, t } = ctx;
    const tc = s.textColor ?? '#ffffff';
    const imageRadius = this.imageRadiusClass(ctx);
    const headingStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'heading')?.typography,
      s.headingStyle,
    );
    const subheadingStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'paragraph')?.typography,
      s.subheadingStyle,
    );
    const styleAttr = this.buildSectionStyleAttr(s, {
      backgroundImage: `url("${s.imageSrc}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      minHeight: s.minHeight,
    });
    const align =
      s.contentAlign === 'center'
        ? 'items-center text-center'
        : s.contentAlign === 'right'
          ? 'items-end text-right'
          : 'items-start text-left';

    return `      {/* Cover */}
      <section${styleAttr}
        className="relative w-full flex items-center justify-center ${imageRadius}"
      >
        <div className="absolute inset-0 bg-black" style={{ opacity: ${s.dimRatio / 100} }} />
        <div className="relative z-10 w-full flex flex-col ${align} gap-4 px-4 sm:px-6 lg:px-8 py-16"${this.buildSectionGapStyleAttr(s)}>
          ${s.heading ? `<h1 className="${t.h1} font-normal text-[${tc}]"${headingStyle}>${s.heading}</h1>` : ''}
          ${s.subheading ? `<p className="text-lg text-white/80"${subheadingStyle}>${s.subheading}</p>` : ''}
          ${s.cta ? `<Link to="${s.cta.link}" className="inline-block bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity"${this.buttonStyleAttr(ctx)}>${s.cta.text}</Link>` : ''}
        </div>
      </section>`;
  }

  private renderPostList(
    s: PostListSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
  ): string {
    const { p, t, l } = ctx;
    const cardStylePreset = this.pickBlockStyle(ctx, 'group', 'column');
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const sectionStyle = this.buildSectionStyleAttr(s);
    const imageRadius = this.imageRadiusClass(ctx);
    const isGrid = s.layout !== 'list';
    const cols = s.layout === 'grid-3' ? 3 : 2;
    const gridClass = isGrid
      ? `grid grid-cols-1 sm:grid-cols-2 ${cols === 3 ? 'lg:grid-cols-3' : ''} gap-6`
      : 'flex flex-col divide-y divide-black/10';

    const postCard = isGrid
      ? `            <article key={post.id} className="flex flex-col gap-2"${this.buildBlockStyleAttr(cardStylePreset, { padding: l.cardPadding })}>
              ${s.showFeaturedImage ? `{post.featuredImage && <img src={post.featuredImage} alt={post.title} className="w-full h-[220px] object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle)} />}` : ''}
              <Link to={\`/post/\${post.slug}\`} className="text-lg font-medium text-[${tc}] hover:text-[${p.accent}] transition-colors">{post.title}</Link>
              ${s.showExcerpt ? `<p className="text-sm text-[${p.textMuted}]">{post.excerpt}</p>` : ''}
              ${s.showDate || s.showAuthor || s.showCategory ? this.postMeta(s, ctx) : ''}
            </article>`
      : `            <article key={post.id} className="flex flex-col md:flex-row md:items-baseline gap-2 md:gap-4 py-4">
              <Link to={\`/post/\${post.slug}\`} className="flex-1 text-lg text-[${tc}] hover:text-[${p.accent}] transition-colors">{post.title}</Link>
              ${s.showDate || s.showAuthor || s.showCategory ? this.postMeta(s, ctx, true) : ''}
            </article>`;

    return `      {/* Post List */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${s.title ? `<h2 className="${t.h2} font-normal text-[${tc}] mb-8">${s.title}</h2>` : ''}
          <div className="${gridClass}"${this.buildSectionGapStyleAttr(s)}>
            {posts.map(post => (
${postCard}
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between gap-4 text-sm text-[${p.textMuted}]">
              <button
                type="button"
                onClick={() => updatePage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="border border-black/15 px-4 py-2 ${t.buttonRadius} transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                type="button"
                onClick={() => updatePage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="border border-black/15 px-4 py-2 ${t.buttonRadius} transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </section>`;
  }

  private postMeta(s: PostListSection, ctx: RenderCtx, inline = false): string {
    const { p } = ctx;
    const parts: string[] = [];
    if (s.showDate)
      parts.push(
        `<time className="whitespace-nowrap">{new Date(post.date).toLocaleDateString()}</time>`,
      );
    if (s.showAuthor) parts.push(`<span>by {post.author}</span>`);
    if (s.showCategory)
      parts.push(`{post.categories[0] && <span>{post.categories[0]}</span>}`);
    const flex = inline
      ? 'flex items-center gap-2 whitespace-nowrap shrink-0'
      : 'flex flex-wrap gap-2 mt-1';
    return `<div className="text-sm text-[${p.textMuted}] ${flex}">${parts.join('\n              ')}</div>`;
  }

  private renderCardGrid(
    s: CardGridSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
  ): string {
    const { p, t, l } = ctx;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const cardRadius = this.cardRadiusClass(ctx);
    const cardStylePreset = this.pickBlockStyle(ctx, 'group', 'column');
    const cardStyle = this.buildBlockStyleAttr(
      cardStylePreset,
      { padding: l.cardPadding },
      true,
    );
    const colClass = this.responsiveGridColumnsClass(s.columns, s.columnWidths);
    const cards = s.cards
      .map(
        (
          c,
        ) => `          <div className="flex flex-col gap-3 ${cardRadius}"${cardStyle}>
            <h3 className="font-semibold text-[${tc}]">${c.heading}</h3>
            <p className="text-[${p.textMuted}]">${c.body}</p>
          </div>`,
      )
      .join('\n');

    return `      {/* Card Grid */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${s.title ? `<h2 className="${t.h2} font-normal text-[${tc}] mb-4">${s.title}</h2>` : ''}
          ${s.subtitle ? `<p className="text-[${p.textMuted}] mb-8">${s.subtitle}</p>` : ''}
          <div className="grid ${colClass} gap-6"${this.buildSectionGapStyleAttr(s)}>
${cards}
          </div>
        </div>
      </section>`;
  }

  private renderMediaText(
    s: MediaTextSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
  ): string {
    const { p, t, l } = ctx;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const imageRadius =
      this.imageRadiusClass(ctx) ||
      this.cardRadiusClass(ctx) ||
      'rounded-[24px]';
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const headingStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'heading')?.typography,
      s.headingStyle,
    );
    const bodyStyle = this.buildTypographyStyleAttr(
      this.pickBlockStyle(ctx, 'paragraph')?.typography,
      s.bodyStyle,
    );
    const layoutClass =
      s.columnWidths?.length === 2
        ? `grid grid-cols-1 ${this.responsiveGridColumnsClass(2, s.columnWidths, 'md')} gap-8 items-center`
        : 'flex flex-col md:flex-row gap-8 items-center';
    const imgFirst = s.imagePosition === 'left';
    const itemWrapper = s.columnWidths?.length === 2 ? 'min-w-0' : 'flex-1';
    const imgEl = `<div className="${itemWrapper}"><img src="${s.imageSrc}" alt="${s.imageAlt}" className="w-full h-auto object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle)} /></div>`;
    const textEl = `<div className="${itemWrapper} flex flex-col gap-4">
            ${s.heading ? `<h2 className="${t.h3} font-[600] text-[${tc}]"${headingStyle}>${s.heading}</h2>` : ''}
            ${s.body ? `<p className="text-[${tc}]"${bodyStyle}>${s.body}</p>` : ''}
            ${s.listItems ? `<ul className="flex flex-col gap-2">${s.listItems.map((li) => `<li className="text-[${tc}] font-medium">${li}</li>`).join('')}</ul>` : ''}
            ${s.cta ? `<Link to="${s.cta.link}" className="inline-block bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity"${this.buttonStyleAttr(ctx)}>${s.cta.text}</Link>` : ''}
          </div>`;

    return `      {/* Media + Text */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="${layoutClass}"${this.buildSectionGapStyleAttr(s)}>
            ${imgFirst ? `${imgEl}\n            ${textEl}` : `${textEl}\n            ${imgEl}`}
          </div>
        </div>
      </section>`;
  }

  private renderTestimonial(
    s: TestimonialSection,
    ctx: RenderCtx,
    py: string,
  ): string {
    const { p, t } = ctx;
    const bg = s.background ?? p.dark ?? '#111111';
    const tc = s.textColor ?? p.darkText ?? '#f9f9f9';
    const styleAttr = this.buildSectionStyleAttr(s, {
      backgroundColor: bg,
      color: tc,
    });

    return `      {/* Testimonial */}
      <section className="w-full ${py}"${styleAttr}>
        <div className="max-w-[720px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center text-center gap-8"${this.buildSectionGapStyleAttr(s)}>
            <p className="${t.h3} font-normal leading-snug">"{s.quote}"</p>
            <div className="flex flex-col items-center gap-1">
              ${s.authorAvatar ? `<img src="${s.authorAvatar}" alt="${s.authorName}" className="w-14 h-14 rounded-full object-cover mb-2" />` : ''}
              <span className="font-medium">${s.authorName}</span>
              ${s.authorTitle ? `<span className="text-sm opacity-70">${s.authorTitle}</span>` : ''}
            </div>
          </div>
        </div>
      </section>`;
  }

  private renderNewsletter(
    s: NewsletterSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
  ): string {
    const { p, t, l } = ctx;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const cardRadius = this.cardRadiusClass(ctx);
    const cardStylePreset = this.pickBlockStyle(ctx, 'group', 'column');
    const cardStyle = this.buildBlockStyleAttr(
      cardStylePreset,
      { padding: l.cardPadding, gap: s.gapStyle },
      true,
    );
    const inner =
      s.layout === 'card'
        ? `<div className="bg-[${p.surface}] ${cardRadius || 'rounded-2xl'} p-8 md:p-12 max-w-[560px] mx-auto text-center flex flex-col gap-4"${cardStyle}>`
        : `<div className="flex flex-col items-center text-center gap-4"${this.buildSectionGapStyleAttr(s)}>`;

    return `      {/* Newsletter */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${inner}
            <h2 className="${t.h2} font-normal text-[${tc}]">${s.heading}</h2>
            ${s.subheading ? `<p className="text-[${p.textMuted}]">${s.subheading}</p>` : ''}
            <button className="self-center bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity"${this.buttonStyleAttr(ctx)}>
              ${s.buttonText}
            </button>
          </div>
        </div>
      </section>`;
  }

  private renderFooter(s: FooterSection, ctx: RenderCtx): string {
    const { p, l } = ctx;
    const footerStyle = this.pickBlockStyle(ctx, 'group', 'navigation');
    const bg = s.background ?? p.surface;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildBlockStyleAttr(
      footerStyle,
      { ...this.extractSectionStyleBase(s) },
      true,
    );

    const menuCols = s.menuColumns
      .map(
        (col) => `            <div className="flex flex-col gap-3">
              <h3 className="font-semibold text-[${tc}]">${col.title}</h3>
              <nav className="flex flex-col gap-2">
                {menus.find(m => m.slug === '${col.menuSlug}')?.items
                  .filter(i => i.parentId === 0)
                  .map(item => (
                    isInternalPath(item.url) ? (
                      <Link key={item.id} to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="text-sm text-[${p.textMuted}] hover:text-[${p.accent}] transition-colors">
                        {item.title}
                      </Link>
                    ) : (
                      <a key={item.id} href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="text-sm text-[${p.textMuted}] hover:text-[${p.accent}] transition-colors">
                        {item.title}
                      </a>
                    )
                  ))}
              </nav>
            </div>`,
      )
      .join('\n');

    return `      {/* Footer */}
      <footer className="bg-[${bg}] border-t border-black/10 w-full"${sectionStyle}>
        <div className="${l.containerClass} py-12">
          <div className="grid grid-cols-1 md:grid-cols-${Math.min(4, s.menuColumns.length + 1)} gap-8"${this.buildSectionGapStyleAttr(s)}>
            <div className="flex flex-col gap-3">
              <Link to="/" className="font-bold text-[${tc}]">{siteInfo?.siteName}</Link>
              <p className="text-sm text-[${p.textMuted}]">${s.brandDescription ? s.brandDescription : '{siteInfo?.blogDescription}'}</p>
            </div>
${menuCols}
          </div>
          ${s.copyright ? `<p className="text-sm text-[${p.textMuted}] mt-8 pt-8 border-t border-black/10">${s.copyright}</p>` : ''}
        </div>
      </footer>`;
  }

  private renderPostContent(
    s: PostContentSection,
    ctx: RenderCtx,
    py: string,
  ): string {
    const { p } = ctx;
    const bg = s.background ?? p.background;
    const sectionStyle = this.buildSectionStyleAttr(s);
    return `      {/* Post Content */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${this.contentContainerClass(ctx)} px-4 sm:px-6 lg:px-8">
${this.renderPostContentInner(s, ctx)}
        </div>
      </section>`;
  }

  private renderComments(
    s: CommentsSection,
    ctx: RenderCtx,
    py: string,
  ): string {
    const { p, t } = ctx;
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const renderCommentCard = (
      commentVar: string,
    ) => `                      <div className="flex items-start gap-3">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-sm font-medium text-[${tc}]">
                          {${commentVar}.author.charAt(0).toUpperCase()}
                        </span>
                        <div className="flex-1">
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div className="text-sm font-medium text-[${tc}]">{${commentVar}.author}</div>
                            <time className="text-xs text-[${p.textMuted}]">{${commentVar}.date}</time>
                          </div>
                          <p className="mt-2 whitespace-pre-line text-sm text-[${p.textMuted}]">{${commentVar}.content}</p>
                        </div>
                      </div>`;
    const formBlock = s.showForm
      ? `
              <div className="flex flex-col gap-4 pt-6 border-t border-black/10">
                <h3 className="${t.h3} font-normal text-[${tc}]">Leave a Reply</h3>
                <form className="flex flex-col gap-3" onSubmit={handleCommentSubmit}>
                  ${s.requireName ? `<input type="text" placeholder="Name *" required value={commentAuthor} onChange={(event) => setCommentAuthor(event.target.value)} className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm" />` : ''}
                  ${s.requireEmail ? `<input type="email" placeholder="Email *" required value={commentEmail} onChange={(event) => setCommentEmail(event.target.value)} className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm" />` : ''}
                  <textarea rows={4} placeholder="Your comment..." value={commentContent} onChange={(event) => setCommentContent(event.target.value)} className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm resize-none" />
                  {commentError ? <p className="text-sm text-red-600">{commentError}</p> : null}
                  {commentSuccess ? <p className="text-sm text-green-700">{commentSuccess}</p> : null}
                  <button type="submit" disabled={submittingComment} className="self-start bg-[${p.accent}] text-[${p.accentText}] px-5 py-2 ${t.buttonRadius} hover:opacity-90 transition-opacity text-sm disabled:cursor-not-allowed disabled:opacity-60"${this.buttonStyleAttr(ctx)}>
                    {submittingComment ? 'Posting...' : 'Post Comment'}
                  </button>
                </form>
              </div>`
      : '';
    const pendingBlock = s.showForm
      ? `
              {pendingComments.length > 0 ? (
                <div className="rounded-[24px] border border-black/10 bg-black/5 p-4">
                  <p className="text-sm font-medium text-[${tc}]">
                    {pendingComments.length === 1
                      ? '1 comment is awaiting moderation.'
                      : \`\${pendingComments.length} comments are awaiting moderation.\`}
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {pendingComments.map((pendingComment) => (
                      <div key={pendingComment.id} className="rounded-[18px] bg-white/70 px-4 py-3">
                        <div className="text-sm font-medium text-[${tc}]">{pendingComment.author}</div>
                        <p className="mt-1 whitespace-pre-line text-sm text-[${p.textMuted}]">{pendingComment.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}`
      : '';
    return `      {/* Comments */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${this.contentContainerClass(ctx)} px-4 sm:px-6 lg:px-8">
          {item && (
            <div className="flex flex-col gap-6"${this.buildSectionGapStyleAttr(s)}>
              <h2 className="${t.h2} font-normal text-[${tc}]">
                {comments.length === 1 ? '1 Comment' : \`\${comments.length} Comments\`}
              </h2>
              {topLevelComments.length > 0 ? (
                <div className="flex flex-col gap-6">
                  {topLevelComments.map((comment) => (
                    <div key={comment.id} className="flex flex-col gap-4">
${renderCommentCard('comment')}
                      {repliesFor(comment.id).length > 0 ? (
                        <div className="ml-4 border-l border-black/10 pl-4 sm:ml-10 sm:pl-6">
                          <div className="flex flex-col gap-4">
                            {repliesFor(comment.id).map((reply) => (
                              <div key={reply.id} className="flex flex-col gap-2">
${renderCommentCard('reply')}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[${p.textMuted}]">No comments yet.</p>
              )}${pendingBlock}${formBlock}
            </div>
          )}
        </div>
      </section>`;
  }

  private renderPageContent(
    s: PageContentSection,
    ctx: RenderCtx,
    py: string,
  ): string {
    const { p } = ctx;
    const bg = s.background ?? p.background;
    const sectionStyle = this.buildSectionStyleAttr(s);
    return `      {/* Page Content */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${this.contentContainerClass(ctx)} px-4 sm:px-6 lg:px-8">
${this.renderPageContentInner(s, ctx)}
        </div>
      </section>`;
  }

  private renderSearch(s: SearchSection, ctx: RenderCtx, py: string): string {
    const { p, t, l } = ctx;
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);
    return `      {/* Search */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${s.title ? `<h2 className="${t.h2} font-normal text-[${tc}] mb-6">${s.title}</h2>` : ''}
          <div className="flex gap-2">
            <input type="search" placeholder="Search..." className="flex-1 border border-black/20 ${t.buttonRadius} px-4 py-2 bg-transparent text-[${tc}]" />
            <button className="bg-[${p.accent}] text-[${p.accentText}] px-4 py-2 ${t.buttonRadius} hover:opacity-90"${this.buttonStyleAttr(ctx)}>Search</button>
          </div>
          <div className="mt-8 flex flex-col gap-4"${this.buildSectionGapStyleAttr(s)}>
            {posts.map(post => (
              <Link key={post.id} to={\`/post/\${post.slug}\`} className="text-[${tc}] hover:text-[${p.accent}] transition-colors">{post.title}</Link>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between gap-4 text-sm text-[${p.textMuted}]">
              <button
                type="button"
                onClick={() => updatePage(currentPage - 1)}
                disabled={currentPage <= 1}
                className="border border-black/15 px-4 py-2 ${t.buttonRadius} transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                type="button"
                onClick={() => updatePage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="border border-black/15 px-4 py-2 ${t.buttonRadius} transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </section>`;
  }

  private renderBreadcrumb(ctx: RenderCtx): string {
    const { p, l } = ctx;
    return `      {/* Breadcrumb */}
      <nav className="w-full py-3 ${l.containerClass}">
        <ol className="flex items-center gap-2 text-sm text-[${p.textMuted}]">
          <li><Link to="/" className="hover:text-[${p.accent}] transition-colors">Home</Link></li>
          <li>/</li>
          <li className="text-[${p.text}]">{item?.title ?? 'Page'}</li>
        </ol>
      </nav>`;
  }

  private renderSidebar(s: SidebarSection, ctx: RenderCtx, py: string): string {
    const bg = s.background ?? ctx.p.background;
    const sectionStyle = this.buildSectionStyleAttr(s);

    return `      {/* Sidebar */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${ctx.l.containerClass}">
${this.renderSidebarCard(s, ctx, 10)}
        </div>
      </section>`;
  }

  private renderContentWithSidebar(
    mainSection: PostContentSection | PageContentSection,
    sidebarSection: SidebarSection,
    ctx: RenderCtx,
    sidebarLeft: boolean,
    componentName: string,
  ): string {
    const { p } = ctx;
    const bg = mainSection.background ?? p.background;
    const py = this.sectionPaddingClass(mainSection);
    const sectionStyle = this.buildSectionStyleAttr(mainSection);
    const mainContent =
      mainSection.type === 'post-content'
        ? this.renderPostContentInner(mainSection, ctx)
        : this.renderPageContentInner(mainSection, ctx);
    const sidebarCard = this.renderSidebarCard(sidebarSection, ctx, 8);
    const gridStyle = this.buildStyleAttr({
      gridTemplateColumns: sidebarLeft
        ? `${ctx.l.sidebarWidth ?? '320px'} minmax(0,1fr)`
        : `minmax(0,1fr) ${ctx.l.sidebarWidth ?? '320px'}`,
      gap: mainSection.gapStyle ?? sidebarSection.gapStyle,
    });
    const mainAttrs = this.buildSectionTrackingAttrs(
      mainSection,
      componentName,
    );
    const sidebarAttrs = this.buildSectionTrackingAttrs(
      sidebarSection,
      componentName,
    );

    return `      {/* Main Content With Sidebar */}
      <section${mainAttrs} className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${ctx.l.containerClass}">
          <div className="grid grid-cols-1 gap-8 lg:items-start lg:grid-cols-[1fr]"${gridStyle}>
            ${sidebarLeft ? `<aside${sidebarAttrs} className="min-w-0">${sidebarCard.trim()}</aside>` : `<div className="min-w-0"><div className="${this.contentContainerClass(ctx)}">${mainContent.trim()}</div></div>`}
            ${sidebarLeft ? `<div className="min-w-0"><div className="${this.contentContainerClass(ctx)}">${mainContent.trim()}</div></div>` : `<aside${sidebarAttrs} className="min-w-0">${sidebarCard.trim()}</aside>`}
          </div>
        </div>
      </section>`;
  }

  private renderPostContentInner(
    s: PostContentSection,
    ctx: RenderCtx,
  ): string {
    const { p, t } = ctx;
    const tc = s.textColor ?? p.text;
    const hasMeta = s.showDate || s.showAuthor || s.showCategories;
    const metaParts: string[] = [];
    if (s.showDate)
      metaParts.push(`<time>{new Date(item.date).toLocaleDateString()}</time>`);
    if (s.showAuthor) metaParts.push(`<span>by {item.author}</span>`);
    if (s.showCategories)
      metaParts.push(
        `{item.categories[0] && <span>{item.categories[0]}</span>}`,
      );
    const metaBlock = hasMeta
      ? `<div className="flex flex-wrap gap-3 text-sm text-[${p.textMuted}]">\n                ${metaParts.join('\n                ')}\n              </div>`
      : '';

    return `          {item && (
            <article className="flex flex-col gap-6"${this.buildSectionGapStyleAttr(s)}>
              ${s.showTitle ? `<h1 className="${t.h1} font-normal text-[${tc}]">{item.title}</h1>` : ''}
              ${metaBlock}
              <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: item.content }} />
            </article>
          )}`;
  }

  private renderPageContentInner(
    s: PageContentSection,
    ctx: RenderCtx,
  ): string {
    const { p, t } = ctx;
    const tc = s.textColor ?? p.text;
    return `          {item && (
            <article className="flex flex-col gap-6"${this.buildSectionGapStyleAttr(s)}>
              ${s.showTitle ? `<h1 className="${t.h1} font-normal text-[${tc}]">{item.title}</h1>` : ''}
              <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: item.content }} />
            </article>
          )}`;
  }

  private renderSidebarCard(
    s: SidebarSection,
    ctx: RenderCtx,
    maxItemsOverride?: number,
  ): string {
    const { p, t, l } = ctx;
    const cardStylePreset = this.pickBlockStyle(ctx, 'group', 'column');
    const radius = this.cardRadiusClass(ctx) || 'rounded-2xl';
    const paddingStyle = this.buildBlockStyleAttr(
      cardStylePreset,
      { padding: l.cardPadding, gap: s.gapStyle },
      true,
    );
    const titleBlock = s.title
      ? `            <h3 className="${t.h3} font-normal text-[${p.text}]">${s.title}</h3>\n`
      : '';
    const maxItems = maxItemsOverride ?? s.maxItems ?? 6;
    const menuSlug = s.menuSlug ? `'${s.menuSlug}'` : 'undefined';

    const siteInfoBlock = s.showSiteInfo
      ? `            <div className="flex flex-col gap-2">
              <div className="font-semibold text-[${p.text}]">{siteInfo?.siteName}</div>
              {siteInfo?.blogDescription && (
                <p className="text-sm text-[${p.textMuted}]">{siteInfo.blogDescription}</p>
              )}
            </div>
`
      : '';

    const menuBlock = s.menuSlug
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]">Navigation</div>
              <nav className="flex flex-col gap-2">
                {(menus.find(m => m.slug === ${menuSlug}) ?? menus[0])?.items
                  ?.filter(item => item.parentId === 0)
                  ?.slice(0, ${maxItems})
                  ?.map(item => (
                    <Link key={item.id} to={item.url} className="text-sm text-[${p.text}] hover:text-[${p.accent}] transition-colors">
                      {item.title}
                    </Link>
                  ))}
              </nav>
            </div>
`
      : '';

    const pagesBlock = s.showPages
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]">Pages</div>
              <nav className="flex flex-col gap-2">
                {pages.slice(0, ${maxItems}).map(page => (
                  <Link key={page.id} to={\`/page/\${page.slug}\`} className="text-sm text-[${p.text}] hover:text-[${p.accent}] transition-colors">
                    {page.title}
                  </Link>
                ))}
              </nav>
            </div>
`
      : '';

    const postsBlock = s.showPosts
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]">Latest Posts</div>
              <div className="flex flex-col gap-3">
                {posts.slice(0, ${maxItems}).map(post => (
                  <Link key={post.id} to={\`/post/\${post.slug}\`} className="text-sm text-[${p.text}] hover:text-[${p.accent}] transition-colors">
                    {post.title}
                  </Link>
                ))}
              </div>
            </div>
`
      : '';

    return `          <div className="bg-[${p.surface}] border border-black/10 ${radius} flex flex-col gap-6"${paddingStyle}>
${titleBlock}${siteInfoBlock}${menuBlock}${pagesBlock}${postsBlock}          </div>`;
  }

  private extractSectionStyleBase(
    section: SectionPlan,
  ): Record<string, string | number | undefined> {
    return {
      padding: section.paddingStyle,
      margin: section.marginStyle,
    };
  }

  private renderBlockFaithfulNodes(
    nodes: WpNode[],
    ctx: RenderCtx,
    state: BlockFaithfulRenderState,
    depth: number,
  ): string {
    return nodes
      .map((node) => {
        const markup = this.renderBlockFaithfulNode(node, ctx, state, depth);
        return depth === 3
          ? this.annotateBlockFaithfulMarkup(node, markup, state.componentName)
          : markup;
      })
      .filter(Boolean)
      .join('\n');
  }

  private annotateBlockFaithfulMarkup(
    node: WpNode,
    markup: string,
    componentName: string,
  ): string {
    if (!node.sourceRef?.sourceNodeId || !markup) return markup;

    const attrs = [
      ['data-vp-source-node', node.sourceRef.sourceNodeId],
      ['data-vp-template', node.sourceRef.templateName],
      ['data-vp-source-file', node.sourceRef.sourceFile],
      ['data-vp-section-key', node.block.replace(/^core\//, '')],
      ['data-vp-component', componentName],
      ['data-vp-section-component', componentName],
    ]
      .filter(([, value]) => !!value)
      .map(
        ([name, value]) =>
          ` ${name}="${String(value).replace(/"/g, '&quot;')}"`,
      )
      .join('');

    return markup.replace(
      /(<(?:section|header|footer|main|article|aside|nav|div|ul|li|p|h1|h2|h3|h4|h5|h6|form|span|img|a|Link)\b)(?![^>]*\bdata-vp-source-node=)/,
      `$1${attrs}`,
    );
  }

  private renderBlockFaithfulNode(
    node: WpNode,
    ctx: RenderCtx,
    state: BlockFaithfulRenderState,
    depth: number,
  ): string {
    const block = node.block.replace(/^core\//, '');
    const indent = '  '.repeat(depth);
    const childIndent = '  '.repeat(depth + 1);
    const children = node.children?.length
      ? this.renderBlockFaithfulNodes(node.children, ctx, state, depth + 1)
      : '';

    if (block === 'template-part') return children;

    switch (block) {
      case 'group': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'group'),
          this.buildWpLayoutStyle(node),
        );
        return `${indent}<div className="w-full"${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'columns': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'columns', 'group'),
          this.buildWpColumnsStyle(node),
        );
        return `${indent}<div className="w-full min-w-0"${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'column': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'column', 'group'),
        );
        return `${indent}<div className="min-w-0"${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'navigation':
        return this.renderBlockFaithfulNavigation(node, ctx, state, depth);
      case 'navigation-link': {
        const href = node.href?.trim() ?? '';
        const hasUsableHref = href.length > 0 && href !== '#';
        const nestedChildren =
          node.children?.length && node.children.some((child) => child.block)
            ? `\n${this.renderBlockFaithfulNavigationChildren(node.children, ctx, state, depth + 1, true)}`
            : '';
        return `${indent}<li className="relative">
${
  hasUsableHref
    ? `${childIndent}{isInternalPath(${JSON.stringify(href)}) ? (
${childIndent}  <Link to={toAppPath(${JSON.stringify(href)})} className="transition-opacity hover:opacity-75"${this.buildWpNodeStyleAttr(node)}>
${childIndent}    ${node.text ?? href}
${childIndent}  </Link>
${childIndent}) : (
${childIndent}  <a href="${href}" className="transition-opacity hover:opacity-75"${this.buildWpNodeStyleAttr(node)}>
${childIndent}    ${node.text ?? href}
${childIndent}  </a>
${childIndent})}`
    : `${childIndent}<span className="transition-opacity"${this.buildWpNodeStyleAttr(node)}>
${childIndent}  ${node.text ?? ''}
${childIndent}</span>`
}${nestedChildren}
${indent}</li>`;
      }
      case 'site-title':
        return `${indent}<Link to="/" className="font-semibold transition-opacity hover:opacity-75"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'site-title', 'heading'))}>
${childIndent}{siteInfo?.siteName}
${indent}</Link>`;
      case 'site-tagline':
        return `${indent}<p className="text-sm"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'site-tagline', 'paragraph'))}>
${childIndent}{siteInfo?.blogDescription}
${indent}</p>`;
      case 'site-logo': {
        const width = node.params?.width
          ? this.normalizeCssLength(String(node.params.width))
          : undefined;
        const logoSrcExpr = node.src
          ? JSON.stringify(node.src)
          : 'siteInfo?.logoUrl ?? null';
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'site-logo', 'image'),
          width ? { width, maxWidth: '100%' } : {},
        );
        return `${indent}{${logoSrcExpr} ? (
${childIndent}<Link to="/" className="inline-flex items-center"${styleAttr}>
${childIndent}  <img src={${logoSrcExpr}} alt={siteInfo?.siteName ?? 'Site logo'} className="h-auto w-full object-contain" />
${childIndent}</Link>
${indent}) : null}`;
      }
      case 'heading': {
        const level = Math.min(Math.max(node.level ?? 2, 1), 6);
        const tag = `h${level}`;
        if (node.html && !node.text) {
          return `${indent}<${tag}${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'heading'))} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.html)} }} />`;
        }
        return `${indent}<${tag}${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'heading'))}>
${childIndent}${node.text ?? ''}
${indent}</${tag}>`;
      }
      case 'paragraph': {
        if (node.html && !node.text) {
          return `${indent}<div${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'paragraph'))} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.html)} }} />`;
        }
        return `${indent}<p${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'paragraph'))}>
${childIndent}${node.text ?? ''}
${indent}</p>`;
      }
      case 'buttons': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'buttons'),
          {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: node.gap ?? '0.75rem',
          },
        );
        return `${indent}<div${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'button': {
        const href = node.href?.trim() ?? '';
        const hasUsableHref = href.length > 0 && href !== '#';
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'button'),
        );
        return hasUsableHref
          ? `${indent}{isInternalPath(${JSON.stringify(href)}) ? (
${childIndent}<Link to={toAppPath(${JSON.stringify(href)})} className="inline-flex items-center justify-center no-underline transition-opacity hover:opacity-90"${styleAttr}>
${childIndent}  ${node.text ?? href}
${childIndent}</Link>
${indent}) : (
${childIndent}<a href="${href}" className="inline-flex items-center justify-center no-underline transition-opacity hover:opacity-90"${styleAttr}>
${childIndent}  ${node.text ?? href}
${childIndent}</a>
${indent})}`
          : `${indent}<span className="inline-flex items-center justify-center no-underline"${styleAttr}>
${childIndent}${node.text ?? ''}
${indent}</span>`;
      }
      case 'image': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'image', 'gallery'),
          {
            width: node.width ? `${node.width}px` : undefined,
            height: node.height ? `${node.height}px` : undefined,
          },
        );
        return `${indent}<img src="${node.src ?? ''}" alt="${node.alt ?? ''}" className="h-auto max-w-full object-contain"${styleAttr} />`;
      }
      case 'search': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'search'),
          {
            display: 'flex',
            alignItems: 'center',
            gap: node.gap ?? '0.5rem',
          },
        );
        return `${indent}<form role="search"${styleAttr}>
${childIndent}<input type="search" placeholder="Search..." className="min-w-0 flex-1 border border-black/20 bg-transparent px-3 py-2" />
${childIndent}<button type="submit" className="border border-black/20 px-4 py-2">Search</button>
${indent}</form>`;
      }
      case 'social-links': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'social-links'),
          {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: node.gap ?? '0.75rem',
          },
        );
        return `${indent}<div${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'social-link': {
        const service = String(node.params?.service ?? node.text ?? 'Social');
        const href = String(node.params?.url ?? node.href ?? '').trim();
        return href && href !== '#'
          ? `${indent}<a href="${href}" className="transition-opacity hover:opacity-75"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'social-link'))}>
${childIndent}${service}
${indent}</a>`
          : `${indent}<span className="transition-opacity"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'social-link'))}>
${childIndent}${service}
${indent}</span>`;
      }
      case 'separator':
        return `${indent}<hr className="w-full border-0 border-t border-current/20"${this.buildWpNodeStyleAttr(node)} />`;
      case 'spacer': {
        const height = this.normalizeCssLength(
          String(
            node.params?.height ??
              node.params?.style?.spacing?.height ??
              '2rem',
          ),
        );
        return `${indent}<div aria-hidden="true"${this.buildWpNodeStyleAttr(node, undefined, { height })} />`;
      }
      default: {
        if (children) {
          return `${indent}<div${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, block))}>
${children}
${indent}</div>`;
        }
        if (node.html) {
          return `${indent}<div${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, block))} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.html)} }} />`;
        }
        if (node.text) {
          return `${indent}<span${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, block))}>${node.text}</span>`;
        }
        return '';
      }
    }
  }

  private renderBlockFaithfulNavigation(
    node: WpNode,
    ctx: RenderCtx,
    state: BlockFaithfulRenderState,
    depth: number,
  ): string {
    const indent = '  '.repeat(depth);
    const menuIndex = state.navIndex++;
    const isVertical =
      node.params?.layout?.orientation === 'vertical' ||
      state.componentKind === 'footer';
    const hintTitles = this.extractNavigationHintTitles(node);
    const menuVar = `resolveNavigationMenu(${JSON.stringify(
      hintTitles,
    )}, ${menuIndex}, ${state.componentKind === 'footer' ? 'true' : 'false'})`;
    const listClass = isVertical
      ? 'flex flex-col gap-2'
      : 'flex flex-wrap items-center gap-4';
    const fallbackMarkup = this.renderBlockFaithfulNavigationChildren(
      node.children ?? [],
      ctx,
      state,
      depth + 1,
      isVertical,
    );
    return `${indent}<nav${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'navigation'), this.buildWpLayoutStyle(node))}>
${indent}  {${menuVar} ? (
${indent}    <ul className="${listClass}">
${indent}      {renderMenuItems(${menuVar}.items, 0, ${isVertical ? 'true' : 'false'})}
${indent}    </ul>
${indent}  ) : (
${fallbackMarkup}
${indent}  )}
${indent}</nav>`;
  }

  private renderBlockFaithfulNavigationChildren(
    nodes: WpNode[],
    ctx: RenderCtx,
    state: BlockFaithfulRenderState,
    depth: number,
    isVertical: boolean,
  ): string {
    const indent = '  '.repeat(depth);
    const listClass = isVertical
      ? 'flex flex-col gap-2'
      : 'flex flex-wrap items-center gap-4';
    const items = nodes
      .map((child) =>
        this.renderBlockFaithfulNode(child, ctx, state, depth + 1),
      )
      .filter(Boolean)
      .join('\n');
    if (!items) return `${indent}null`;
    return `${indent}<ul className="${listClass}">
${items}
${indent}</ul>`;
  }

  private extractNavigationHintTitles(node: WpNode): string[] {
    const titles: string[] = [];
    const visit = (current: WpNode) => {
      const block = current.block.replace(/^core\//, '');
      if (block === 'navigation-link' && current.text) {
        titles.push(current.text);
      }
      for (const child of current.children ?? []) visit(child);
    };
    for (const child of node.children ?? []) visit(child);
    return titles;
  }

  private buildWpNodeStyleAttr(
    node: WpNode,
    preset?: BlockStyleToken,
    extra: Record<string, string | number | undefined> = {},
  ): string {
    return this.buildStyleAttr({
      ...this.blockStyleToStyleMap(preset),
      ...this.wpNodeToStyleMap(node),
      ...extra,
    });
  }

  private blockStyleToStyleMap(
    style?: BlockStyleToken,
  ): Record<string, string | number | undefined> {
    const styleMap: Record<string, string | number | undefined> = {};
    if (style?.color?.background)
      styleMap.backgroundColor = style.color.background;
    if (style?.color?.text) styleMap.color = style.color.text;
    if (style?.typography?.fontSize)
      styleMap.fontSize = style.typography.fontSize;
    if (style?.typography?.fontFamily)
      styleMap.fontFamily = style.typography.fontFamily;
    if (style?.typography?.fontWeight)
      styleMap.fontWeight = style.typography.fontWeight;
    if (style?.typography?.letterSpacing)
      styleMap.letterSpacing = style.typography.letterSpacing;
    if (style?.typography?.lineHeight)
      styleMap.lineHeight = style.typography.lineHeight;
    if (style?.typography?.textTransform)
      styleMap.textTransform = style.typography.textTransform;
    if (style?.border?.radius) styleMap.borderRadius = style.border.radius;
    if (style?.border?.width) styleMap.borderWidth = style.border.width;
    if (style?.border?.style) styleMap.borderStyle = style.border.style;
    if (style?.border?.color) styleMap.borderColor = style.border.color;
    if (style?.spacing?.padding) styleMap.padding = style.spacing.padding;
    if (style?.spacing?.margin) styleMap.margin = style.spacing.margin;
    if (style?.spacing?.gap) styleMap.gap = style.spacing.gap;
    return styleMap;
  }

  private wpNodeToStyleMap(
    node: WpNode,
  ): Record<string, string | number | undefined> {
    return {
      ...(node.bgColor ? { backgroundColor: node.bgColor } : {}),
      ...(node.textColor ? { color: node.textColor } : {}),
      ...(node.padding ? { padding: this.boxSpacingToCss(node.padding) } : {}),
      ...(node.margin ? { margin: this.boxSpacingToCss(node.margin) } : {}),
      ...(node.gap ? { gap: node.gap } : {}),
      ...(node.borderRadius ? { borderRadius: node.borderRadius } : {}),
      ...(node.minHeight ? { minHeight: node.minHeight } : {}),
      ...(node.typography?.fontSize
        ? { fontSize: node.typography.fontSize }
        : {}),
      ...(node.typography?.fontFamily
        ? { fontFamily: node.typography.fontFamily }
        : {}),
      ...(node.typography?.fontWeight
        ? { fontWeight: node.typography.fontWeight }
        : {}),
      ...(node.typography?.letterSpacing
        ? { letterSpacing: node.typography.letterSpacing }
        : {}),
      ...(node.typography?.lineHeight
        ? { lineHeight: node.typography.lineHeight }
        : {}),
      ...(node.typography?.textTransform
        ? { textTransform: node.typography.textTransform }
        : {}),
    };
  }

  private buildWpLayoutStyle(
    node: WpNode,
  ): Record<string, string | number | undefined> {
    const layout = node.params?.layout as Record<string, any> | undefined;
    if (!layout) return {};
    const style: Record<string, string | number | undefined> = {};
    if (layout.type === 'flex') {
      style.display = 'flex';
      style.flexDirection =
        layout.orientation === 'vertical' ? 'column' : 'row';
      if (layout.justifyContent)
        style.justifyContent = String(layout.justifyContent);
      if (layout.verticalAlignment)
        style.alignItems = String(layout.verticalAlignment);
      if (layout.flexWrap === false || layout.flexWrap === 'nowrap') {
        style.flexWrap = 'nowrap';
      } else {
        style.flexWrap = 'wrap';
      }
    }
    return style;
  }

  private buildWpColumnsStyle(
    node: WpNode,
  ): Record<string, string | number | undefined> {
    const cols =
      node.children?.filter(
        (child) => child.block === 'column' || child.block === 'core/column',
      ) ?? [];
    const widths = cols
      .map((col) => this.normalizeCssLength(col.columnWidth))
      .filter((value): value is string => !!value);
    return {
      display: 'grid',
      gridTemplateColumns:
        widths.length === cols.length && widths.length > 0
          ? widths.join(' ')
          : `repeat(${Math.max(cols.length, 1)}, minmax(0, 1fr))`,
      alignItems: 'start',
    };
  }

  private boxSpacingToCss(box: NonNullable<WpNode['padding']>): string {
    const { top = '0', right = top, bottom = top, left = right } = box;
    if (top === right && top === bottom && top === left) return top;
    if (top === bottom && right === left) return `${top} ${right}`;
    return `${top} ${right} ${bottom} ${left}`;
  }

  private normalizeCssLength(value?: string): string | undefined {
    if (!value) return undefined;
    const normalized = value.trim();
    if (!normalized) return undefined;
    return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
  }
}

// ── Shared TypeScript interfaces injected at top of every component ─────────

const SHARED_INTERFACES = [
  SITE_INFO_INTERFACE,
  COMMENT_INTERFACE,
  COMMENT_SUBMISSION_INTERFACE,
  POST_INTERFACE,
  PAGE_INTERFACE,
  MENU_ITEM_INTERFACE,
  MENU_INTERFACE,
].join('\n\n');
