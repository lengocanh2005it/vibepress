import { Injectable } from '@nestjs/common';
import type {
  ComponentVisualPlan,
  ColorPalette,
  TypographyTokens,
  LayoutTokens,
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
  CustomSection,
  DataNeed,
} from './visual-plan.schema.js';

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

    const extraImports = this.collectCustomImports(effectivePlan);
    const needsRouter = this.needsRouter(effectivePlan);
    const needsParams = this.needsParams(effectivePlan);

    const ctx: RenderCtx = {
      p: effectivePlan.palette,
      t: effectivePlan.typography,
      l: effectivePlan.layout,
    };

    const imports = this.buildImports(
      effectivePlan,
      needsRouter,
      needsParams,
      extraImports,
    );
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
        case 'custom': {
          // Scan the raw JSX string so data vars used there are declared
          const jsx = (section as CustomSection).jsx ?? '';
          if (/\bposts\b/.test(jsx)) needs.add('posts');
          if (/\bmenus\b/.test(jsx)) needs.add('menus');
          if (/\bsiteInfo\b/.test(jsx)) needs.add('siteInfo');
          if (/\bpages\b/.test(jsx)) needs.add('pages');
          if (/\bitem\b/.test(jsx) && !needs.has('postDetail'))
            needs.add('pageDetail');
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
    extraImports: string[],
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
    for (const name of plan.layout.includes) {
      lines.push(`import ${name} from './${name}';`);
    }
    for (const imp of extraImports) {
      if (!lines.includes(imp)) lines.push(imp);
    }
    return lines.join('\n');
  }

  private collectCustomImports(plan: ComponentVisualPlan): string[] {
    return plan.sections
      .filter((s): s is CustomSection => s.type === 'custom')
      .flatMap((s) => s.imports ?? []);
  }

  private needsRouter(plan: ComponentVisualPlan): boolean {
    return plan.sections.some(
      (s) => s.type !== 'custom' || (s as CustomSection).jsx?.includes('<Link'),
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
      lines.push(`  const [pages, setPages] = useState<Post[]>([]);`);
    if (dataNeeds.includes('menus'))
      lines.push(`  const [menus, setMenus] = useState<Menu[]>([]);`);
    if (dataNeeds.includes('postDetail') || dataNeeds.includes('pageDetail')) {
      lines.push(`  const [item, setItem] = useState<Post | null>(null);`);
      lines.push(`  const { slug } = useParams<{ slug: string }>();`);
    }
    lines.push(`  const [loading, setLoading] = useState(true);`);
    lines.push(`  const [error, setError] = useState<string | null>(null);`);
    lines.push('');

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
        `        const detailRes = await fetch(\`/api/posts/\${slug}\`);`,
      );
      lines.push(
        `        if (!detailRes.ok) throw new Error('Post not found');`,
      );
      lines.push(`        setItem(await detailRes.json());`);
    }
    if (dataNeeds.includes('pageDetail')) {
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
    const sectionJsx = sections
      .map((s) => this.renderSection(s, ctx))
      .join('\n\n');
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
      case 'custom':
        return this.renderCustom(section);
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
    return this.buildStyleAttr({ padding: ctx.l.buttonPadding });
  }

  // ── Section renderers ─────────────────────────────────────────────────────

  private renderNavbar(s: NavbarSection, ctx: RenderCtx): string {
    const { p, t, l } = ctx;
    const bg = s.background ?? p.surface;
    const tc = s.textColor ?? p.text;
    const sticky = s.sticky ? 'sticky top-0 z-50 ' : '';
    const sectionStyle = this.buildSectionStyleAttr(s);
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
        ? `\n          <img src="${s.image.src}" alt="${s.image.alt}" className="w-full h-auto mt-8 object-cover ${imageRadius}" />`
        : `\n          <div className="flex-1"><img src="${s.image.src}" alt="${s.image.alt}" className="w-full h-auto object-cover ${imageRadius}" /></div>`
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
    const sectionStyle = this.buildSectionStyleAttr(s);
    const imageRadius = this.imageRadiusClass(ctx);
    const isGrid = s.layout !== 'list';
    const cols = s.layout === 'grid-3' ? 3 : 2;
    const gridClass = isGrid
      ? `grid grid-cols-1 sm:grid-cols-2 ${cols === 3 ? 'lg:grid-cols-3' : ''} gap-6`
      : 'flex flex-col divide-y divide-black/10';

    const postCard = isGrid
      ? `            <article key={post.id} className="flex flex-col gap-2">
              ${s.showFeaturedImage ? `{post.featuredImage && <img src={post.featuredImage} alt={post.title} className="w-full h-[220px] object-cover ${imageRadius}" />}` : ''}
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
    const cardStyle = this.buildStyleAttr({ padding: l.cardPadding });
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
    const imgFirst = s.imagePosition === 'left';
    const imgEl = `<div className="flex-1"><img src="${s.imageSrc}" alt="${s.imageAlt}" className="w-full h-auto object-cover ${imageRadius}" /></div>`;
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
    const cardStyle = this.buildStyleAttr({ padding: l.cardPadding });
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
    const bg = s.background ?? p.surface;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);

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
    const { p, t } = ctx;
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);
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
    return `      {/* Post Content */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
          {item && (
            <article className="flex flex-col gap-6">
              ${s.showTitle ? `<h1 className="${t.h1} font-normal text-[${tc}]">{item.title}</h1>` : ''}
              ${metaBlock}
              <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: item.content }} />
            </article>
          )}
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
    const formBlock = s.showForm
      ? `
              <div className="flex flex-col gap-4 pt-6 border-t border-black/10">
                <h3 className="${t.h3} font-normal text-[${tc}]">Leave a Reply</h3>
                <form className="flex flex-col gap-3">
                  ${s.requireName ? `<input type="text" placeholder="Name *" required className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm" />` : ''}
                  ${s.requireEmail ? `<input type="email" placeholder="Email" className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm" />` : ''}
                  <textarea rows={4} placeholder="Your comment..." className="border border-black/20 ${t.buttonRadius} px-3 py-2 bg-transparent text-[${tc}] text-sm resize-none" />
                  <button type="submit" className="self-start bg-[${p.accent}] text-[${p.accentText}] px-5 py-2 ${t.buttonRadius} hover:opacity-90 transition-opacity text-sm"${this.buttonStyleAttr(ctx)}>Post Comment</button>
                </form>
              </div>`
      : '';
    return `      {/* Comments */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
          {item && (
            <div className="flex flex-col gap-6">
              <h2 className="${t.h2} font-normal text-[${tc}]">Comments</h2>
              {(item.comments ?? []).length > 0 ? (
                <div className="flex flex-col gap-6">
                  {(item.comments ?? []).map((comment) => (
                    <div key={comment.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-3">
                        <img src={comment.author_avatar} alt={comment.author_name} className="w-9 h-9 rounded-full object-cover" />
                        <div>
                          <div className="text-sm font-medium text-[${tc}]">{comment.author_name}</div>
                          <time className="text-xs text-[${p.textMuted}]">{new Date(comment.date).toLocaleDateString()}</time>
                        </div>
                      </div>
                      <div className="text-sm text-[${p.textMuted}] pl-12" dangerouslySetInnerHTML={{ __html: comment.content }} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[${p.textMuted}]">No comments yet.</p>
              )}${formBlock}
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
    const { p, t } = ctx;
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const sectionStyle = this.buildSectionStyleAttr(s);
    return `      {/* Page Content */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="mx-auto max-w-[800px] px-4 sm:px-6 lg:px-8">
          {item && (
            <article className="flex flex-col gap-6">
              ${s.showTitle ? `<h1 className="${t.h1} font-normal text-[${tc}]">{item.title}</h1>` : ''}
              <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: item.content }} />
            </article>
          )}
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

  private renderCustom(s: CustomSection): string {
    return `      {/* ${s.description} */}
      ${s.jsx}`;
  }
}

// ── Shared TypeScript interfaces injected at top of every component ─────────

const SHARED_INTERFACES = `interface SiteInfo {
  siteName: string;
  siteUrl: string;
  blogDescription: string;
  adminEmail?: string;
  language?: string;
}

interface Comment {
  id: number;
  author_name: string;
  author_avatar: string;
  date: string;
  content: string;
}

interface Post {
  id: number;
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  type: string;
  status: string;
  date: string;
  author: string;
  categories: string[];
  featuredImage: string | null;
  comments?: Comment[];
  comment_count?: number;
}

interface MenuItem {
  id: number;
  title: string;
  url: string;
  order: number;
  parentId: number;
}

interface Menu {
  name: string;
  slug: string;
  items: MenuItem[];
}`;
