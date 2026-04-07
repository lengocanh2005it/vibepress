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
  PRODUCT_INTERFACE,
  SITE_INFO_INTERFACE,
} from './api-contract.js';

const PADDING_MAP = {
  none: '',
  sm: 'py-8',
  md: 'py-12 lg:py-16',
  lg: 'py-16 lg:py-24',
  xl: 'py-24 lg:py-32',
};
const PARTIAL_PATTERNS =
  /^(Header|Footer|Sidebar|Nav|Navigation|Searchform|Comments|Comment|PostMeta|Post-Meta|Widget|Breadcrumb|Pagination|Loop|ContentNone|NoResults|Functions)/i;

interface RenderCtx {
  p: ColorPalette;
  t: TypographyTokens;
  l: LayoutTokens;
  b?: Record<string, BlockStyleToken>;
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
    if (routerParts.length > 0) {
      lines.push(
        `import { ${routerParts.join(', ')} } from 'react-router-dom';`,
      );
    }
    // Import shared partial components (Header, Footer, etc.) from layout plan
    const currentFolder = PARTIAL_PATTERNS.test(plan.componentName)
      ? 'components'
      : 'pages';
    for (const name of plan.layout.includes) {
      const targetFolder = PARTIAL_PATTERNS.test(name) ? 'components' : 'pages';
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
    if (dataNeeds.includes('posts'))
      lines.push(`  const [posts, setPosts] = useState<Post[]>([]);`);
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
      fetches.push(`fetch('/api/posts')`);
      setters.push(`setPosts(await res${fetches.length - 1}.json());`);
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
      padding: ctx.l.rootPadding,
    });

    return `  return (
    <div className="bg-[${palette.background}] text-[${palette.text}] flex flex-col ${ctx.l.blockGap}"${rootStyle}>
${sectionJsx}
    </div>
  );
};

export default ${componentName};`;
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
          ),
        );
        continue;
      }
      parts.push(this.renderSection(section, ctx));
    }

    return parts.join('\n\n');
  }

  // ── Section dispatcher ────────────────────────────────────────────────────

  private renderSection(section: SectionPlan, ctx: RenderCtx): string {
    const bg = section.background ?? ctx.p.background;
    const tc = section.textColor ?? ctx.p.text;
    const py = PADDING_MAP[section.padding ?? 'lg'];

    switch (section.type) {
      case 'navbar':
        return this.renderNavbar(section, ctx);
      case 'hero':
        return this.renderHero(section, ctx, py);
      case 'cover':
        return this.renderCover(section, ctx);
      case 'post-list':
        return this.renderPostList(section, ctx, bg, tc, py);
      case 'card-grid':
        return this.renderCardGrid(section, ctx, bg, tc, py);
      case 'media-text':
        return this.renderMediaText(section, ctx, bg, tc, py);
      case 'testimonial':
        return this.renderTestimonial(section, ctx, py);
      case 'newsletter':
        return this.renderNewsletter(section, ctx, bg, tc, py);
      case 'footer':
        return this.renderFooter(section, ctx);
      case 'post-content':
        return this.renderPostContent(section, ctx, py);
      case 'page-content':
        return this.renderPageContent(section, ctx, py);
      case 'comments':
        return this.renderComments(section, ctx, py);
      case 'search':
        return this.renderSearch(section, ctx, py);
      case 'breadcrumb':
        return this.renderBreadcrumb(ctx);
      case 'sidebar':
        return this.renderSidebar(section, ctx, py);
    }
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
    if (style?.border?.radius) styleMap.borderRadius = style.border.radius;
    if (style?.border?.width) styleMap.borderWidth = style.border.width;
    if (style?.border?.style) styleMap.borderStyle = style.border.style;
    if (style?.border?.color) styleMap.borderColor = style.border.color;
    if (style?.spacing?.padding) styleMap.padding = style.spacing.padding;
    if (style?.spacing?.margin) styleMap.margin = style.spacing.margin;
    if (style?.spacing?.gap) styleMap.gap = style.spacing.gap;
    return this.buildStyleAttr(styleMap);
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
          <div className="flex items-center justify-between py-4">
            <Link to="/" className="font-bold text-[${tc}]">{siteInfo?.siteName}</Link>
            <nav className="hidden md:flex items-center gap-6">
              {menus.find(m => m.slug === '${s.menuSlug}')?.items
                .filter(i => i.parentId === 0)
                .map(item => (
                  <Link key={item.id} to={item.url} className="text-[${tc}] hover:text-[${p.accent}] transition-colors">
                    {item.title}
                  </Link>
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
          <div className="flex flex-col md:flex-row gap-8 items-center">
            <div className="flex-1 flex flex-col gap-4">
              <h1 className="${t.h1} font-normal text-[${tc}]">${s.heading}</h1>
              ${s.subheading ? `<p className="text-lg text-[${p.textMuted}]">${s.subheading}</p>` : ''}
              ${cta}
            </div>${image}
          </div>
        </div>
      </section>`;
    }

    return `      {/* Hero */}
      <section className="bg-[${bg}] ${py}"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex flex-col ${isCenter ? 'items-center text-center' : 'items-start'} gap-6 max-w-[640px] ${isCenter ? 'mx-auto' : ''}">
            <h1 className="${t.h1} font-normal text-[${tc}]">${s.heading}</h1>
            ${s.subheading ? `<p className="text-lg text-[${p.textMuted}]">${s.subheading}</p>` : ''}
            ${cta}
          </div>${image}
        </div>
      </section>`;
  }

  private renderCover(s: CoverSection, ctx: RenderCtx): string {
    const { p, t } = ctx;
    const tc = s.textColor ?? '#ffffff';
    const imageRadius = this.imageRadiusClass(ctx);
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
        <div className="relative z-10 w-full flex flex-col ${align} gap-4 px-4 sm:px-6 lg:px-8 py-16">
          ${s.heading ? `<h1 className="${t.h1} font-normal text-[${tc}]">${s.heading}</h1>` : ''}
          ${s.subheading ? `<p className="text-lg text-white/80">${s.subheading}</p>` : ''}
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
          <div className="${gridClass}">
            {posts.map(post => (
${postCard}
            ))}
          </div>
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
    const colClass = `grid-cols-1 sm:grid-cols-2 ${s.columns >= 3 ? 'lg:grid-cols-3' : ''} ${s.columns === 4 ? 'xl:grid-cols-4' : ''}`;
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
          <div className="grid ${colClass} gap-6">
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
    const imageRadius = this.imageRadiusClass(ctx);
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const imgFirst = s.imagePosition === 'left';
    const imgEl = `<div className="flex-1"><img src="${s.imageSrc}" alt="${s.imageAlt}" className="w-full h-auto object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle)} /></div>`;
    const textEl = `<div className="flex-1 flex flex-col gap-4">
            ${s.heading ? `<h2 className="${t.h3} font-normal text-[${tc}]">${s.heading}</h2>` : ''}
            ${s.body ? `<p className="text-[${p.textMuted}]">${s.body}</p>` : ''}
            ${s.listItems ? `<ul className="flex flex-col gap-2">${s.listItems.map((li) => `<li className="text-[${p.textMuted}]">${li}</li>`).join('')}</ul>` : ''}
            ${s.cta ? `<Link to="${s.cta.link}" className="inline-block bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity"${this.buttonStyleAttr(ctx)}>${s.cta.text}</Link>` : ''}
          </div>`;

    return `      {/* Media + Text */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex flex-col md:flex-row gap-8 items-center">
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
          <div className="flex flex-col items-center text-center gap-8">
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
      { padding: l.cardPadding },
      true,
    );
    const inner =
      s.layout === 'card'
        ? `<div className="bg-[${p.surface}] ${cardRadius || 'rounded-2xl'} p-8 md:p-12 max-w-[560px] mx-auto text-center flex flex-col gap-4"${cardStyle}>`
        : `<div className="flex flex-col items-center text-center gap-4">`;

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
                    <Link key={item.id} to={item.url} className="text-sm text-[${p.textMuted}] hover:text-[${p.accent}] transition-colors">
                      {item.title}
                    </Link>
                  ))}
              </nav>
            </div>`,
      )
      .join('\n');

    return `      {/* Footer */}
      <footer className="bg-[${bg}] border-t border-black/10 w-full"${sectionStyle}>
        <div className="${l.containerClass} py-12">
          <div className="grid grid-cols-1 md:grid-cols-${Math.min(4, s.menuColumns.length + 1)} gap-8">
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
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
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
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
          {item && (
            <div className="flex flex-col gap-6">
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
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
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
          <div className="mt-8 flex flex-col gap-4">
            {posts.map(post => (
              <Link key={post.id} to={\`/post/\${post.slug}\`} className="text-[${tc}] hover:text-[${p.accent}] transition-colors">{post.title}</Link>
            ))}
          </div>
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
  ): string {
    const { p } = ctx;
    const bg = mainSection.background ?? p.background;
    const py = PADDING_MAP[mainSection.padding ?? 'lg'];
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
    });

    return `      {/* Main Content With Sidebar */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${ctx.l.containerClass}">
          <div className="grid grid-cols-1 gap-8 lg:items-start lg:grid-cols-[1fr]"${gridStyle}>
            ${sidebarLeft ? `<aside className="min-w-0">${sidebarCard.trim()}</aside>` : `<div className="min-w-0">${mainContent.trim()}</div>`}
            ${sidebarLeft ? `<div className="min-w-0">${mainContent.trim()}</div>` : `<aside className="min-w-0">${sidebarCard.trim()}</aside>`}
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
            <article className="flex flex-col gap-6">
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
            <article className="flex flex-col gap-6">
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
      { padding: l.cardPadding },
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
  PRODUCT_INTERFACE,
].join('\n\n');
