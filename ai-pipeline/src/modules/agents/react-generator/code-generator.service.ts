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
  CtaStripSection,
  CoverSection,
  PostListSection,
  CardGridSection,
  MediaTextSection,
  TestimonialSection,
  NewsletterSection,
  FooterSection,
  PostContentSection,
  PostMetaSection,
  PageContentSection,
  CommentsSection,
  SearchSection,
  SidebarSection,
  ModalSection,
  TabsSection,
  AccordionSection,
  CarouselSection,
  DataNeed,
  SectionCta,
} from './visual-plan.schema.js';
import {
  COMMENT_INTERFACE,
  COMMENT_SUBMISSION_INTERFACE,
  FOOTER_COLUMN_INTERFACE,
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

  generateSectionAssemblyFrame(plan: ComponentVisualPlan): string {
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
    const body = this.buildSectionAssemblyBody(effectivePlan, ctx);

    return [imports, interfaces, stateAndFetch, body]
      .filter(Boolean)
      .join('\n\n');
  }

  assembleSectionedComponent(frame: string, sectionJsx: string[]): string {
    let assembled = frame;
    for (let index = 0; index < sectionJsx.length; index++) {
      assembled = assembled.replace(
        this.buildSectionAssemblyPlaceholder(index),
        sectionJsx[index]?.trim() || '',
      );
    }
    return assembled;
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
    const needsFooterLinks =
      effectiveDataNeeds.includes('footerLinks') ||
      /^footer/i.test(componentName);
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
    if (needsMenus && renderState.componentKind === 'header') {
      lines.push(
        `  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);`,
      );
    }
    if (needsFooterLinks) {
      lines.push(
        `  const [footerColumns, setFooterColumns] = useState<FooterColumn[]>([]);`,
      );
    }
    if (needsSiteInfo || needsMenus || needsFooterLinks) {
      lines.push('');
      lines.push('  useEffect(() => {');
      lines.push('    (async () => {');
      if (needsSiteInfo && needsFooterLinks && !needsMenus) {
        lines.push(
          '      const [siteInfoRes, footerLinksRes] = await Promise.all([',
        );
        lines.push("        fetch('/api/site-info'),");
        lines.push("        fetch('/api/footer-links'),");
        lines.push('      ]);');
        lines.push(
          '      const footerLinksData = await footerLinksRes.json();',
        );
        lines.push('      setSiteInfo(await siteInfoRes.json());');
        lines.push(
          '      setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);',
        );
      } else if (
        needsSiteInfo &&
        needsMenus &&
        renderState.componentKind === 'footer'
      ) {
        lines.push(
          '      const [siteInfoRes, menusRes, footerLinksRes] = await Promise.all([',
        );
        lines.push("        fetch('/api/site-info'),");
        lines.push("        fetch('/api/menus'),");
        lines.push("        fetch('/api/footer-links'),");
        lines.push('      ]);');
        lines.push(
          '      const footerLinksData = await footerLinksRes.json();',
        );
        lines.push('      setSiteInfo(await siteInfoRes.json());');
        lines.push('      setMenus(await menusRes.json());');
        lines.push(
          '      setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);',
        );
      } else if (needsSiteInfo && needsMenus) {
        lines.push('      const [siteInfoRes, menusRes] = await Promise.all([');
        lines.push("        fetch('/api/site-info'),");
        lines.push("        fetch('/api/menus'),");
        lines.push('      ]);');
        lines.push('      setSiteInfo(await siteInfoRes.json());');
        lines.push('      setMenus(await menusRes.json());');
      } else if (needsSiteInfo) {
        lines.push("      const siteInfoRes = await fetch('/api/site-info');");
        lines.push('      setSiteInfo(await siteInfoRes.json());');
      } else if (needsFooterLinks && !needsMenus) {
        lines.push(
          "      const footerLinksRes = await fetch('/api/footer-links');",
        );
        lines.push(
          '      const footerLinksData = await footerLinksRes.json();',
        );
        lines.push(
          '      setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);',
        );
      } else if (renderState.componentKind === 'footer') {
        lines.push(
          '      const [menusRes, footerLinksRes] = await Promise.all([',
        );
        lines.push("        fetch('/api/menus'),");
        lines.push("        fetch('/api/footer-links'),");
        lines.push('      ]);');
        lines.push(
          '      const footerLinksData = await footerLinksRes.json();',
        );
        lines.push('      setMenus(await menusRes.json());');
        lines.push(
          '      setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);',
        );
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
      if (renderState.componentKind === 'footer') {
        lines.push(
          '  const displayFooterColumns = footerNavigationMenus.length === 0 ? footerColumns.filter((column) => Array.isArray(column.links) && column.links.length > 0) : [];',
        );
      }
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
        `              <Link to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.opacityLinkClass()}">`,
      );
      lines.push('                {item.title}');
      lines.push('              </Link>');
      lines.push('            ) : (');
      lines.push(
        `              <a href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.opacityLinkClass()}">`,
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
    const rootClass =
      renderState.componentKind === 'header'
        ? 'wp-site-blocks w-full relative'
        : 'wp-site-blocks w-full';
    lines.push(`    <${rootTag} className="${rootClass}">`);
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
          needs.add('footerLinks');
          break;
        case 'post-list':
        case 'search':
          needs.add('posts');
          break;
        case 'post-content':
        case 'comments':
          needs.add('postDetail');
          break;
        case 'post-meta':
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
    const reactHooks = ['useState', 'useEffect'];
    if (plan.sections.some((section) => section.type === 'carousel')) {
      reactHooks.push('useRef');
    }
    const lines: string[] = [
      `import React, { ${reactHooks.join(', ')} } from 'react';`,
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
        'post-content',
        'post-meta',
        'search',
        'sidebar',
        'hero',
        'cover',
      ].includes(s.type),
    );
  }

  private needsParams(plan: ComponentVisualPlan): boolean {
    if (plan.pageBinding?.slug) return false;
    return (
      plan.dataNeeds.includes('postDetail') ||
      plan.dataNeeds.includes('pageDetail')
    );
  }

  private needsPagination(plan: ComponentVisualPlan): boolean {
    if (!plan.dataNeeds.includes('posts')) return false;
    return /^(archive|index|search|blog)/i.test(plan.componentName);
  }

  // ── State + fetch ─────────────────────────────────────────────────────────

  private buildStateAndFetch(plan: ComponentVisualPlan): string {
    const { dataNeeds, componentName } = plan;
    const fixedSlug = plan.pageBinding?.slug;
    const needsPostsPagination = this.needsPagination(plan);
    const hasPostMetaSection = plan.sections.some(
      (section) => section.type === 'post-meta',
    );
    const modalSections = plan.sections.flatMap((section, index) =>
      section.type === 'modal'
        ? [
            {
              section,
              stateKey: this.buildInteractiveSectionStateKey(section, index),
            },
          ]
        : [],
    );
    const hasModalSections = plan.sections.some(
      (section) => section.type === 'modal',
    );
    const carouselSections = plan.sections.flatMap((section, index) =>
      section.type === 'carousel'
        ? [
            {
              section,
              stateKey: this.buildInteractiveSectionStateKey(section, index),
            },
          ]
        : [],
    );
    const hasCarouselSections = carouselSections.length > 0;
    const hasTabsSections = plan.sections.some(
      (section) => section.type === 'tabs',
    );
    const hasAccordionSections = plan.sections.some(
      (section) => section.type === 'accordion',
    );
    const commentsSection =
      plan.sections.find(
        (section): section is CommentsSection => section.type === 'comments',
      ) ?? null;
    const needsComments = !!commentsSection && dataNeeds.includes('postDetail');
    const supportsCommentForm = needsComments && commentsSection.showForm;
    const lines: string[] = [];

    if (hasPostMetaSection) {
      lines.push(`interface ${componentName}Props {`);
      lines.push(`  item?: Post | Page | null;`);
      lines.push(`  post?: Post | null;`);
      lines.push(`  className?: string;`);
      lines.push(`}`);
      lines.push('');
      lines.push(
        `const ${componentName}: React.FC<${componentName}Props> = ({ item, post, className }) => {`,
      );
      lines.push(
        `  const metaSource: Post | null = post ?? (item && 'date' in item ? (item as Post) : null);`,
      );
    } else {
      lines.push(`const ${componentName}: React.FC = () => {`);
    }

    // State
    if (dataNeeds.includes('siteInfo'))
      lines.push(
        `  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);`,
      );
    if (dataNeeds.includes('footerLinks'))
      lines.push(
        `  const [footerColumns, setFooterColumns] = useState<FooterColumn[]>([]);`,
      );
    if (dataNeeds.includes('posts')) {
      if (needsPostsPagination) {
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
      lines.push(`  const [posts, setPosts] = useState<Post[]>([]);`);
    }
    if (dataNeeds.includes('pages'))
      lines.push(`  const [pages, setPages] = useState<Page[]>([]);`);
    if (dataNeeds.includes('menus'))
      lines.push(`  const [menus, setMenus] = useState<Menu[]>([]);`);
    if (plan.sections.some((s) => s.type === 'navbar'))
      lines.push(
        `  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);`,
      );
    if (hasModalSections) {
      lines.push(
        `  const [openModals, setOpenModals] = useState<Record<string, boolean>>({});`,
      );
      lines.push(
        `  const modalEscEnabled: Record<string, boolean> = ${JSON.stringify(
          Object.fromEntries(
            modalSections.map(({ section, stateKey }) => [
              stateKey,
              section.closeOnEsc !== false,
            ]),
          ),
        )};`,
      );
    }
    if (hasCarouselSections) {
      lines.push(
        `  const [activeCarousels, setActiveCarousels] = useState<Record<string, number>>({});`,
      );
      lines.push(
        `  const [hoveredCarousels, setHoveredCarousels] = useState<Record<string, boolean>>({});`,
      );
      lines.push(
        `  const carouselDragState = useRef<Record<string, { pointerId: number; startX: number; deltaX: number } | null>>({});`,
      );
      lines.push(
        `  const beginCarouselDrag = (key: string, pointerId: number, clientX: number) => {`,
      );
      lines.push(
        `    carouselDragState.current[key] = { pointerId, startX: clientX, deltaX: 0 };`,
      );
      lines.push(
        `    setHoveredCarousels((prev) => ({ ...prev, [key]: true }));`,
      );
      lines.push(`  };`);
      lines.push(
        `  const updateCarouselDrag = (key: string, pointerId: number, clientX: number) => {`,
      );
      lines.push(`    const drag = carouselDragState.current[key];`);
      lines.push(`    if (!drag || drag.pointerId !== pointerId) return;`);
      lines.push(`    drag.deltaX = clientX - drag.startX;`);
      lines.push(`  };`);
      lines.push(
        `  const finishCarouselDrag = (key: string, pointerId: number, onSwipeLeft: () => void, onSwipeRight: () => void) => {`,
      );
      lines.push(`    const drag = carouselDragState.current[key];`);
      lines.push(`    if (!drag || drag.pointerId !== pointerId) return;`);
      lines.push(`    const deltaX = drag.deltaX;`);
      lines.push(`    carouselDragState.current[key] = null;`);
      lines.push(
        `    setHoveredCarousels((prev) => ({ ...prev, [key]: false }));`,
      );
      lines.push(`    if (Math.abs(deltaX) < 48) return;`);
      lines.push(`    if (deltaX < 0) onSwipeLeft();`);
      lines.push(`    else onSwipeRight();`);
      lines.push(`  };`);
      lines.push(
        `  const cancelCarouselDrag = (key: string, pointerId?: number) => {`,
      );
      lines.push(`    const drag = carouselDragState.current[key];`);
      lines.push(`    if (!drag) return;`);
      lines.push(
        `    if (typeof pointerId === 'number' && drag.pointerId !== pointerId) return;`,
      );
      lines.push(`    carouselDragState.current[key] = null;`);
      lines.push(
        `    setHoveredCarousels((prev) => ({ ...prev, [key]: false }));`,
      );
      lines.push(`  };`);
      lines.push(
        `  const isCarouselInteractiveTarget = (target: EventTarget | null) => {`,
      );
      lines.push(`    if (!(target instanceof Element)) return false;`);
      lines.push(
        `    return !!target.closest('a, button, input, textarea, select, option, [role="button"], [data-carousel-control="true"]');`,
      );
      lines.push(`  };`);
    }
    if (hasTabsSections) {
      lines.push(
        `  const [activeTabs, setActiveTabs] = useState<Record<string, number>>({});`,
      );
    }
    if (hasAccordionSections) {
      lines.push(
        `  const [openAccordions, setOpenAccordions] = useState<Record<string, number[]>>({});`,
      );
    }
    if (dataNeeds.includes('postDetail')) {
      lines.push(`  const [item, setItem] = useState<Post | null>(null);`);
      if (fixedSlug) {
        lines.push(`  const slug = ${JSON.stringify(fixedSlug)};`);
      } else {
        lines.push(`  const { slug } = useParams<{ slug: string }>();`);
      }
    } else if (dataNeeds.includes('pageDetail')) {
      lines.push(`  const [item, setItem] = useState<Page | null>(null);`);
      if (fixedSlug) {
        lines.push(`  const slug = ${JSON.stringify(fixedSlug)};`);
      } else {
        lines.push(`  const { slug } = useParams<{ slug: string }>();`);
      }
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
    lines.push(`  const [loading, setLoading] = useState(${dataNeeds.length > 0});`);
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

    if (hasModalSections) {
      lines.push(`  useEffect(() => {`);
      lines.push(
        `    const openKeys = Object.entries(openModals).filter((entry) => entry[1]).map((entry) => entry[0]);`,
      );
      lines.push(`    if (typeof document !== 'undefined') {`);
      lines.push(
        `      document.body.style.overflow = openKeys.length > 0 ? 'hidden' : '';`,
      );
      lines.push(
        `      document.body.classList.toggle('hide-scroll', openKeys.length > 0);`,
      );
      lines.push(`    }`);
      lines.push(`    const handleKeyDown = (event: KeyboardEvent) => {`);
      lines.push(`      if (event.key !== 'Escape') return;`);
      lines.push(
        `      const closableKeys = openKeys.filter((key) => modalEscEnabled[key] !== false);`,
      );
      lines.push(`      if (closableKeys.length === 0) return;`);
      lines.push(`      setOpenModals((prev) => {`);
      lines.push(`        const next = { ...prev };`);
      lines.push(
        `        closableKeys.forEach((key) => { next[key] = false; });`,
      );
      lines.push(`        return next;`);
      lines.push(`      });`);
      lines.push(`    };`);
      lines.push(`    if (typeof window !== 'undefined') {`);
      lines.push(`      window.addEventListener('keydown', handleKeyDown);`);
      lines.push(`    }`);
      lines.push(`    return () => {`);
      lines.push(`      if (typeof document !== 'undefined') {`);
      lines.push(`        document.body.style.overflow = '';`);
      lines.push(`        document.body.classList.remove('hide-scroll');`);
      lines.push(`      }`);
      lines.push(`      if (typeof window !== 'undefined') {`);
      lines.push(
        `        window.removeEventListener('keydown', handleKeyDown);`,
      );
      lines.push(`      }`);
      lines.push(`    };`);
      lines.push(`  }, [openModals, modalEscEnabled]);`);
      lines.push('');
    }

    for (const { section, stateKey } of carouselSections) {
      if (!section.autoplay || section.slides.length <= 1) continue;
      const defaultIndex = 0;
      const speed = Math.max(600, section.autoplaySpeed ?? 3000);
      const loop = section.loop !== false;
      const pauseOnInteraction =
        section.pauseOn === 'hover' || section.pauseOn === 'click';
      lines.push(`  useEffect(() => {`);
      if (pauseOnInteraction) {
        lines.push(
          `    if (hoveredCarousels[${JSON.stringify(stateKey)}]) return;`,
        );
      }
      lines.push(`    const timer = window.setInterval(() => {`);
      lines.push(`      setActiveCarousels((prev) => {`);
      lines.push(
        `        const current = prev[${JSON.stringify(stateKey)}] ?? ${defaultIndex};`,
      );
      lines.push(
        `        if (current >= ${section.slides.length - 1}) return ${loop ? `{ ...prev, [${JSON.stringify(stateKey)}]: 0 }` : 'prev'};`,
      );
      lines.push(
        `        return { ...prev, [${JSON.stringify(stateKey)}]: current + 1 };`,
      );
      lines.push(`      });`);
      lines.push(`    }, ${speed});`);
      lines.push(`    return () => window.clearInterval(timer);`);
      lines.push(
        `  }, [activeCarousels[${JSON.stringify(stateKey)}], hoveredCarousels[${JSON.stringify(stateKey)}]]);`,
      );
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
      if (needsPostsPagination) {
        fetches.push(
          `fetch(\`/api/posts?page=\${currentPage}&perPage=\${perPage}\`)`,
        );
        setters.push(
          `const postsData = await res${fetches.length - 1}.json(); setPosts(Array.isArray(postsData) ? postsData : []); setTotalPages(Number(res${fetches.length - 1}.headers.get('X-WP-TotalPages') ?? '1'));`,
        );
      } else {
        fetches.push(`fetch('/api/posts')`);
        setters.push(
          `const postsData = await res${fetches.length - 1}.json(); setPosts(Array.isArray(postsData) ? postsData : []);`,
        );
      }
    }
    if (dataNeeds.includes('pages')) {
      fetches.push(`fetch('/api/pages')`);
      setters.push(`setPages(await res${fetches.length - 1}.json());`);
    }
    if (dataNeeds.includes('menus')) {
      fetches.push(`fetch('/api/menus')`);
      setters.push(`setMenus(await res${fetches.length - 1}.json());`);
    }
    if (dataNeeds.includes('footerLinks')) {
      fetches.push(`fetch('/api/footer-links')`);
      setters.push(
        `const footerLinksData = await res${fetches.length - 1}.json(); setFooterColumns(Array.isArray(footerLinksData) ? footerLinksData : []);`,
      );
    }
    if (dataNeeds.includes('postDetail')) {
      lines.push(
        `        if (!slug) throw new Error('Post slug is required');`,
      );
      lines.push(
        fixedSlug
          ? `        const detailRes = await fetch(${JSON.stringify(`/api/posts/${fixedSlug}`)});`
          : `        const detailRes = await fetch(\`/api/posts/\${slug}\`);`,
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
        fixedSlug
          ? `        const detailRes = await fetch(${JSON.stringify(`/api/pages/${fixedSlug}`)});`
          : `        const detailRes = await fetch(\`/api/pages/\${slug}\`);`,
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
    } else if (dataNeeds.includes('posts') && needsPostsPagination) {
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
      `  const resolveAsset = (src: string) => src.startsWith('/assets/') ? \`\${import.meta.env.BASE_URL}assets/\${src.slice('/assets/'.length)}\` : src;`,
    );
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
    const { componentName, palette } = plan;
    const sectionJsx = this.buildSections(plan, ctx);

    return `  return (
    <div className="wp-site-blocks bg-[${palette.background}] text-[${palette.text}] flex flex-col ${ctx.l.blockGap}">
${sectionJsx}
    </div>
  );
};

export default ${componentName};`;
  }

  private buildSectionAssemblyBody(
    plan: ComponentVisualPlan,
    ctx: RenderCtx,
  ): string {
    const { componentName, palette, sections } = plan;
    const placeholders = sections
      .map((_, index) => `      ${this.buildSectionAssemblyPlaceholder(index)}`)
      .join('\n\n');

    return `  return (
    <div className="wp-site-blocks bg-[${palette.background}] text-[${palette.text}] flex flex-col ${ctx.l.blockGap}">
${placeholders}
    </div>
  );
};

export default ${componentName};`;
  }

  private buildSectionAssemblyPlaceholder(index: number): string {
    return `__VP_SECTION_${index + 1}__`;
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

    for (let index = 0; index < plan.sections.length; index++) {
      const section = plan.sections[index];
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
      parts.push(this.renderSection(section, ctx, plan.componentName, index));
    }

    return parts.join('\n\n');
  }

  // ── Section dispatcher ────────────────────────────────────────────────────

  private renderSection(
    section: SectionPlan,
    ctx: RenderCtx,
    componentName: string,
    sectionIndex: number,
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
      case 'cta-strip':
        markup = this.renderCtaStrip(section, ctx, py);
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
      case 'post-meta':
        markup = this.renderPostMeta(section, ctx, bg, py);
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
      case 'modal':
        markup = this.renderModal(section, ctx, bg, tc, py, sectionIndex);
        break;
      case 'tabs':
        markup = this.renderTabs(section, ctx, bg, tc, py, sectionIndex);
        break;
      case 'accordion':
        markup = this.renderAccordion(section, ctx, bg, tc, py, sectionIndex);
        break;
      case 'carousel':
        markup = this.renderCarousel(section, ctx, bg, tc, py, sectionIndex);
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
      margin: this.normalizeSectionMarginStyle(section.marginStyle),
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
    const withCustomClasses = this.applySectionCustomClasses(
      markup,
      section.customClassNames,
    );
    const trackingAttrs = this.buildSectionTrackingAttrs(
      section,
      componentName,
    );
    if (!trackingAttrs) return withCustomClasses;

    return withCustomClasses.replace(
      /(<(?:section|header|footer|main|article|aside|nav|div)\b)(?![^>]*\bdata-vp-section-key=)/,
      `$1${trackingAttrs}`,
    );
  }

  private applySectionCustomClasses(
    markup: string,
    customClassNames?: string[],
  ): string {
    const normalized = [
      ...new Set(
        (customClassNames ?? [])
          .map((className) => className.trim())
          .filter(Boolean),
      ),
    ];
    if (normalized.length === 0) return markup;

    if (/\bclassName="[^"]*"/.test(markup)) {
      return markup.replace(
        /\bclassName="([^"]*)"/,
        (_match, existingClasses: string) =>
          `className="${this.appendUniqueClasses(
            existingClasses,
            normalized.join(' '),
          )}"`,
      );
    }

    return markup.replace(
      /(<(?:section|header|footer|main|article|aside|nav|div)\b)/,
      `$1 className="${normalized.join(' ')}"`,
    );
  }

  private buildSectionTrackingAttrs(
    section: SectionPlan,
    componentName: string,
  ): string {
    const sectionKey = section.sectionKey ?? section.type;
    if (!sectionKey && !section.sourceRef?.sourceNodeId) return '';

    const attrs = [
      ['data-vp-source-node', section.sourceRef?.sourceNodeId],
      ['data-vp-template', section.sourceRef?.templateName],
      ['data-vp-source-file', section.sourceRef?.sourceFile],
      ['data-vp-section-key', sectionKey],
      ['data-vp-component', componentName],
      [
        'data-vp-section-component',
        this.buildTrackedSectionComponentName(componentName, sectionKey),
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
      ctx,
    );
  }

  private textLinkClass(color: string, accent: string, extra = ''): string {
    return [
      extra,
      `text-[${color}]`,
      'transition-colors',
      'underline-offset-4',
      `hover:text-[${accent}]`,
      'hover:underline',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private appendUniqueClasses(existing: string, addition: string): string {
    return [...new Set(`${existing} ${addition}`.split(/\s+/).filter(Boolean))]
      .join(' ')
      .trim();
  }

  private appendOptionalCustomClasses(
    baseClassName: string,
    customClassNames?: string[],
  ): string {
    const extra = [
      ...new Set((customClassNames ?? []).map((entry) => entry.trim())),
    ]
      .filter(Boolean)
      .join(' ');
    return extra
      ? this.appendUniqueClasses(baseClassName, extra)
      : baseClassName;
  }

  private buildInteractiveCtaClassName(
    baseClassName: string,
    cta?: SectionCta,
  ): string {
    return this.appendOptionalCustomClasses(
      baseClassName,
      cta?.customClassNames,
    );
  }

  private resolveSectionCtas(section: {
    cta?: SectionCta;
    ctas?: SectionCta[];
  }): SectionCta[] {
    const raw =
      Array.isArray(section.ctas) && section.ctas.length > 0
        ? section.ctas
        : section.cta
          ? [section.cta]
          : [];
    const seen = new Set<string>();
    return raw.filter((cta) => {
      if (!cta?.text?.trim()) return false;
      const key = `${cta.text}\u0000${cta.link}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private renderButtonCtaGroup(
    ctas: SectionCta[],
    ctx: RenderCtx,
    options?: { align?: 'start' | 'center' | 'end' },
  ): string {
    if (ctas.length === 0) return '';
    const { p, t } = ctx;
    const justifyClass =
      options?.align === 'center'
        ? 'justify-center'
        : options?.align === 'end'
          ? 'justify-end'
          : 'justify-start';
    const buttonStyle = this.buttonStyleAttr(ctx);
    const links = ctas
      .map(
        (cta) =>
          `<Link to="${cta.link}" className="${this.buildInteractiveCtaClassName(
            `inline-flex items-center justify-center bg-[${p.accent}] text-[${p.accentText}] px-6 py-3 ${t.buttonRadius} hover:opacity-90 transition-opacity`,
            cta,
          )}"${buttonStyle}>${cta.text}</Link>`,
      )
      .join('');
    return `\n            <div className="flex flex-wrap items-center ${justifyClass} gap-4">${links}</div>`;
  }

  private renderInteractiveAnchorCtaGroup(
    ctas: SectionCta[],
    ctx: RenderCtx,
    options?: { align?: 'start' | 'center' | 'end'; baseClassName?: string },
  ): string {
    if (ctas.length === 0) return '';
    const justifyClass =
      options?.align === 'center'
        ? 'justify-center'
        : options?.align === 'end'
          ? 'justify-end'
          : 'justify-start';
    const baseClassName =
      options?.baseClassName ??
      `inline-flex items-center justify-center ${ctx.t.buttonRadius} px-5 py-3 font-medium transition-opacity hover:opacity-90`;
    const links = ctas
      .map(
        (cta) =>
          `\n                  <a href={${JSON.stringify(cta.link)}} className="${this.buildInteractiveCtaClassName(baseClassName, cta)}" style={{ background: '${ctx.p.accent}', color: '${ctx.p.accentText}' }}>\n                    {${JSON.stringify(cta.text)}}\n                  </a>`,
      )
      .join('');
    return `\n                  <div className="flex flex-wrap items-center ${justifyClass} gap-4">${links}\n                  </div>`;
  }

  private opacityLinkClass(extra = ''): string {
    return [
      extra,
      'transition-opacity',
      'underline-offset-4',
      'hover:opacity-75',
      'hover:underline',
    ]
      .filter(Boolean)
      .join(' ');
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
    ctx?: RenderCtx,
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
    if (style?.typography?.fontFamily) {
      const fontFamily = this.normalizeRedundantFontFamily(
        style.typography.fontFamily,
        ctx,
      );
      if (fontFamily) styleMap.fontFamily = fontFamily;
    }
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
    ctx: RenderCtx,
    ...styles: Array<BlockStyleToken['typography'] | undefined>
  ): string {
    const styleMap: Record<string, string | number | undefined> = {};
    for (const style of styles) {
      if (!style) continue;
      if (style.fontSize) styleMap.fontSize = style.fontSize;
      if (style.fontFamily) {
        const fontFamily = this.normalizeRedundantFontFamily(
          style.fontFamily,
          ctx,
        );
        if (fontFamily) styleMap.fontFamily = fontFamily;
      }
      if (style.fontWeight) styleMap.fontWeight = style.fontWeight;
      if (style.letterSpacing) styleMap.letterSpacing = style.letterSpacing;
      if (style.lineHeight) styleMap.lineHeight = style.lineHeight;
      if (style.textTransform) styleMap.textTransform = style.textTransform;
    }
    return this.buildStyleAttr(styleMap);
  }

  private mergeBlockStyleTokens(
    ...styles: Array<BlockStyleToken | undefined>
  ): BlockStyleToken | undefined {
    const merged: BlockStyleToken = {};

    for (const style of styles) {
      if (!style) continue;
      if (style.color) {
        merged.color = { ...(merged.color ?? {}), ...style.color };
      }
      if (style.typography) {
        merged.typography = {
          ...(merged.typography ?? {}),
          ...style.typography,
        };
      }
      if (style.border) {
        merged.border = { ...(merged.border ?? {}), ...style.border };
      }
      if (style.spacing) {
        merged.spacing = { ...(merged.spacing ?? {}), ...style.spacing };
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private buildTextTokenStyleAttr(
    ctx: RenderCtx,
    options: {
      baseColor?: string;
      typography?: BlockStyleToken['typography'];
    } = {},
    ...styles: Array<BlockStyleToken | undefined>
  ): string {
    const merged = this.mergeBlockStyleTokens(...styles);
    const styleMap: Record<string, string | number | undefined> = {};

    if (options.baseColor) styleMap.color = options.baseColor;
    if (merged?.color?.text) styleMap.color = merged.color.text;

    const typography = [merged?.typography, options.typography].filter(
      Boolean,
    ) as Array<NonNullable<BlockStyleToken['typography']>>;

    for (const style of typography) {
      if (style.fontSize) styleMap.fontSize = style.fontSize;
      if (style.fontFamily) {
        const fontFamily = this.normalizeRedundantFontFamily(
          style.fontFamily,
          ctx,
        );
        if (fontFamily) styleMap.fontFamily = fontFamily;
      }
      if (style.fontWeight) styleMap.fontWeight = style.fontWeight;
      if (style.letterSpacing) styleMap.letterSpacing = style.letterSpacing;
      if (style.lineHeight) styleMap.lineHeight = style.lineHeight;
      if (style.textTransform) styleMap.textTransform = style.textTransform;
    }

    return this.buildStyleAttr(styleMap);
  }

  private buildMergedBlockStyleAttr(
    ctx: RenderCtx,
    base: Record<string, string | number | undefined> = {},
    preferStyle = false,
    ...styles: Array<BlockStyleToken | undefined>
  ): string {
    return this.buildBlockStyleAttr(
      this.mergeBlockStyleTokens(...styles),
      base,
      preferStyle,
      ctx,
    );
  }

  private normalizeRedundantFontFamily(
    value: string | undefined,
    ctx?: RenderCtx,
  ): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.toLowerCase() === 'inherit') return undefined;
    if (!ctx) return trimmed;
    const normalized = this.normalizeFontFamilyKey(trimmed);
    const defaultFonts = [ctx.t.bodyFamily, ctx.t.headingFamily]
      .map((font) => this.normalizeFontFamilyKey(font))
      .filter(Boolean);
    return defaultFonts.includes(normalized) ? undefined : trimmed;
  }

  private normalizeFontFamilyKey(value: string | undefined): string {
    return (value ?? '')
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
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

  private resolveNavigationOverlayMode(input: {
    overlayMenu?: 'always' | 'mobile' | 'never';
    orientation?: 'horizontal' | 'vertical';
    isResponsive?: boolean;
    componentKind?: 'header' | 'footer' | 'page';
  }): 'always' | 'mobile' | 'never' {
    if (input.overlayMenu) return input.overlayMenu;
    if (input.isResponsive === false) return 'never';
    if (input.orientation === 'vertical' || input.componentKind === 'footer') {
      return 'never';
    }
    return 'mobile';
  }

  private isNavigationResponsive(input: {
    overlayMode: 'always' | 'mobile' | 'never';
    orientation?: 'horizontal' | 'vertical';
    isResponsive?: boolean;
  }): boolean {
    if (input.orientation === 'vertical') return false;
    if (input.overlayMode === 'never') return false;
    return input.isResponsive !== false;
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
      ctx,
    );
    const buttonStyle = this.buttonStyleAttr(ctx);
    const brandStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'site-title', 'heading'),
    );
    const navLinkStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      navStyle,
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const overlayMode = this.resolveNavigationOverlayMode({
      overlayMenu: s.overlayMenu,
      orientation: s.orientation,
      isResponsive: s.isResponsive,
      componentKind: 'header',
    });
    const isResponsiveNav = this.isNavigationResponsive({
      overlayMode,
      orientation: s.orientation,
      isResponsive: s.isResponsive,
    });
    const desktopNavClass =
      overlayMode === 'always'
        ? 'hidden'
        : isResponsiveNav
          ? 'hidden md:flex items-center gap-6'
          : `flex items-center gap-6 ${s.orientation === 'vertical' ? 'flex-col items-start' : ''}`.trim();
    const mobileButtonClass =
      overlayMode === 'always'
        ? 'flex flex-col gap-[5px] p-2'
        : isResponsiveNav
          ? 'md:hidden flex flex-col gap-[5px] p-2'
          : '';
    const mobilePanelClass =
      overlayMode === 'always'
        ? 'flex flex-col gap-1 pb-4 border-t border-black/10'
        : 'md:hidden flex flex-col gap-1 pb-4 border-t border-black/10';
    const showSiteLogo = s.showSiteLogo !== false;
    const showSiteTitle = s.showSiteTitle !== false;
    const logoStyle = this.buildMergedBlockStyleAttr(
      ctx,
      {
        width: s.logoWidth,
        maxWidth: '100%',
      },
      false,
      this.pickBlockStyle(ctx, 'site-logo'),
      this.pickBlockStyle(ctx, 'image'),
    );
    const brandMarkup =
      showSiteLogo || showSiteTitle
        ? `<Link to="/" className="flex items-center gap-3 text-[${tc}]">
              ${showSiteLogo ? `{siteInfo?.logoUrl ? <img src={siteInfo.logoUrl} alt={siteInfo?.siteName ?? 'Site logo'} className="h-auto object-contain"${logoStyle} /> : null}` : ''}
              ${showSiteTitle ? `<span className="font-bold text-[${tc}]"${brandStyle}>{siteInfo?.siteName}</span>` : ''}
              ${showSiteLogo && !showSiteTitle ? '<span className="sr-only">{siteInfo?.siteName}</span>' : ''}
            </Link>`
        : `<Link to="/" className="font-bold text-[${tc}]"${brandStyle}>{siteInfo?.siteName}</Link>`;
    const cta = s.cta
      ? s.cta.style === 'button'
        ? `\n            <Link to="${s.cta.link}" className="${this.appendOptionalCustomClasses(`bg-[${p.accent}] text-[${p.accentText}] px-4 py-2 ${t.buttonRadius} hover:opacity-90 transition-opacity`, s.cta.customClassNames)}"${buttonStyle}>${s.cta.text}</Link>`
        : `\n            <Link to="${s.cta.link}" className="${this.appendOptionalCustomClasses(this.textLinkClass(tc, p.accent), s.cta.customClassNames)}"${navLinkStyle}>${s.cta.text}</Link>`
      : '';

    const navItems = `menus.find(m => m.slug === '${s.menuSlug}')?.items.filter(i => i.parentId === 0)`;
    const renderNavItem = (extraClass = '') =>
      `(isInternalPath(item.url) ? (
                    <Link key={item.id} to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.textLinkClass(tc, p.accent)}${extraClass}"${navLinkStyle}>
                      {item.title}
                    </Link>
                  ) : (
                    <a key={item.id} href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.textLinkClass(tc, p.accent)}${extraClass}"${navLinkStyle}>
                      {item.title}
                    </a>
                  ))`;

    return `      {/* Navbar */}
      <header className="${sticky}bg-[${bg}] border-b border-black/10 w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex items-center justify-between py-4"${this.buildSectionGapStyleAttr(s)}>
            ${brandMarkup}
            <nav className="${desktopNavClass}">
              {${navItems}?.map(item => (
                  ${renderNavItem()}
                ))}
            </nav>
            <div className="flex items-center gap-4">${cta}
              ${
                mobileButtonClass
                  ? `<button
                className="${mobileButtonClass} text-[${tc}]"
                aria-label="Toggle menu"
                onClick={() => setMobileMenuOpen(prev => !prev)}
              >
                {mobileMenuOpen ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                )}
              </button>`
                  : ''
              }
            </div>
          </div>
          {${mobileButtonClass ? 'mobileMenuOpen' : 'false'} && (
            <nav className="${mobilePanelClass}">
              {${navItems}?.map(item => (
                  ${renderNavItem(' block py-2 px-2')}
                ))}
            </nav>
          )}
        </div>
      </header>`;
  }

  private renderHero(s: HeroSection, ctx: RenderCtx, py: string): string {
    const { p, t, l } = ctx;
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const bg = s.background ?? p.background;
    const tc = s.textColor ?? p.text;
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc, typography: s.headingStyle },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const subheadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted, typography: s.subheadingStyle },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const sectionStyle = this.buildSectionStyleAttr(s);
    const imageRadius = this.imageRadiusClass(ctx);
    const cta = this.renderButtonCtaGroup(this.resolveSectionCtas(s), ctx, {
      align: s.layout === 'centered' ? 'center' : 'start',
    });
    const image = s.image
      ? s.image.position === 'below'
        ? `\n          <img src={resolveAsset("${s.image.src}")} alt="${s.image.alt}" className="w-full h-auto mt-8 object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle, {}, false, ctx)} />`
        : `\n          <div className="flex-1"><img src={resolveAsset("${s.image.src}")} alt="${s.image.alt}" className="w-full h-auto object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle, {}, false, ctx)} /></div>`
      : '';

    const isCenter = s.layout === 'centered';
    const isSplit = s.layout === 'split';

    if (isSplit && s.image) {
      return `      {/* Hero */}
      <section className="bg-[${bg}] ${py}"${sectionStyle}>
        <div className="${l.containerClass}">
          <div className="flex flex-col md:flex-row gap-8 items-center"${this.buildSectionGapStyleAttr(s)}>
            <div className="flex-1 flex flex-col gap-4">
              ${s.heading ? `<h1 className="${t.h1} font-normal"${headingStyle}>${s.heading}</h1>` : ''}
              ${s.subheading ? `<p className="text-lg"${subheadingStyle}>${s.subheading}</p>` : ''}
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
            ${s.heading ? `<h1 className="${t.h1} font-normal"${headingStyle}>${s.heading}</h1>` : ''}
            ${s.subheading ? `<p className="text-lg"${subheadingStyle}>${s.subheading}</p>` : ''}
            ${cta}
          </div>${image}
        </div>
      </section>`;
  }

  private renderCtaStrip(
    s: CtaStripSection,
    ctx: RenderCtx,
    py: string,
  ): string {
    const bg = s.background ?? ctx.p.background;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const cta = this.renderButtonCtaGroup(this.resolveSectionCtas(s), ctx, {
      align:
        s.align === 'center' ? 'center' : s.align === 'right' ? 'end' : 'start',
    });
    return `      {/* CTA Strip */}
      <section className="bg-[${bg}] ${py}"${sectionStyle}>
        <div className="${ctx.l.containerClass}">
          <div className="flex flex-col gap-4"${this.buildSectionGapStyleAttr(s)}>
            ${cta}
          </div>
        </div>
      </section>`;
  }

  private renderCover(s: CoverSection, ctx: RenderCtx): string {
    const { p, t } = ctx;
    const tc = s.textColor ?? '#ffffff';
    const imageRadius = this.imageRadiusClass(ctx);
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc, typography: s.headingStyle },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const subheadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: '#ffffffcc', typography: s.subheadingStyle },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const bgSrcExpr = s.imageSrc.startsWith('/assets/')
      ? `\`url("\${resolveAsset("${s.imageSrc}")}")\``
      : `"url(\\"${s.imageSrc}\\")"`;
    const extraStyles = [
      `backgroundImage: ${bgSrcExpr}`,
      `backgroundSize: 'cover'`,
      `backgroundPosition: 'center'`,
      ...(s.minHeight ? [`minHeight: '${s.minHeight}'`] : []),
      ...(s.paddingStyle ? [`padding: '${s.paddingStyle}'`] : []),
      ...(s.marginStyle ? [`margin: '${s.marginStyle}'`] : []),
    ].join(', ');
    const styleAttr = ` style={{ ${extraStyles} }}`;
    const align =
      s.contentAlign === 'center'
        ? 'items-center text-center'
        : s.contentAlign === 'right'
          ? 'items-end text-right'
          : 'items-start text-left';
    const cta = this.renderButtonCtaGroup(this.resolveSectionCtas(s), ctx, {
      align:
        s.contentAlign === 'center'
          ? 'center'
          : s.contentAlign === 'right'
            ? 'end'
            : 'start',
    });

    return `      {/* Cover */}
      <section${styleAttr}
        className="relative w-full flex items-center justify-center ${imageRadius}"
      >
        <div className="absolute inset-0 bg-black" style={{ opacity: ${s.dimRatio / 100} }} />
        <div className="relative z-10 w-full flex flex-col ${align} gap-4 px-4 sm:px-6 lg:px-8 py-16"${this.buildSectionGapStyleAttr(s)}>
          ${s.heading ? `<h1 className="${t.h1} font-normal"${headingStyle}>${s.heading}</h1>` : ''}
          ${s.subheading ? `<p className="text-lg"${subheadingStyle}>${s.subheading}</p>` : ''}
          ${cta}
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
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const excerptStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const imageRadius = this.imageRadiusClass(ctx);
    const isGrid = s.layout !== 'list';
    const cols = s.layout === 'grid-3' ? 3 : 2;
    const gridClass = isGrid
      ? `grid grid-cols-1 sm:grid-cols-2 ${cols === 3 ? 'lg:grid-cols-3' : ''} gap-6`
      : 'flex flex-col divide-y divide-black/10';

    const postCard = isGrid
      ? `            <article key={post.id} className="flex flex-col gap-2"${this.buildBlockStyleAttr(cardStylePreset, { padding: l.cardPadding }, false, ctx)}>
              ${s.showFeaturedImage ? `{post.featuredImage && <img src={post.featuredImage} alt={post.title} className="w-full h-[220px] object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle, {}, false, ctx)} />}` : ''}
              <Link to={\`/post/\${post.slug}\`} className="${this.textLinkClass(tc, p.accent, 'text-lg font-medium')}"${titleStyle}>{post.title}</Link>
              ${s.showExcerpt ? `<p className="text-sm"${excerptStyle}>{post.excerpt}</p>` : ''}
              ${s.showDate || s.showAuthor || s.showCategory ? this.postMeta(s, ctx) : ''}
            </article>`
      : `            <article key={post.id} className="flex flex-col md:flex-row md:items-baseline gap-2 md:gap-4 py-4">
              <Link to={\`/post/\${post.slug}\`} className="${this.textLinkClass(tc, p.accent, 'flex-1 text-lg')}"${titleStyle}>{post.title}</Link>
              ${s.showDate || s.showAuthor || s.showCategory ? this.postMeta(s, ctx, true) : ''}
            </article>`;

    return `      {/* Post List */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${s.title ? `<h2 className="${t.h2} font-normal mb-8"${titleStyle}>${s.title}</h2>` : ''}
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
    const metaLinkClass = this.textLinkClass(p.textMuted, p.accent);
    const metaStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    if (s.showDate)
      parts.push(
        `<time className="whitespace-nowrap">{new Date(post.date).toLocaleDateString()}</time>`,
      );
    if (s.showAuthor) {
      parts.push(
        `{post.author && (post.authorSlug ? <Link to={\`/author/\${post.authorSlug}\`} className="${metaLinkClass}">by {post.author}</Link> : <span>by {post.author}</span>)}`,
      );
    }
    if (s.showCategory)
      parts.push(
        `{post.categories?.[0] && (post.categorySlugs?.[0] ? <Link to={\`/category/\${post.categorySlugs[0]}\`} className="${metaLinkClass}">{post.categories[0]}</Link> : <span>{post.categories[0]}</span>)}`,
      );
    const flex = inline
      ? 'flex items-center gap-2 whitespace-nowrap shrink-0'
      : 'flex flex-wrap gap-2 mt-1';
    return `<div className="text-sm text-[${p.textMuted}] ${flex}"${metaStyle}>${parts.join('\n              ')}</div>`;
  }

  private renderPostMeta(
    s: PostMetaSection,
    ctx: RenderCtx,
    bg: string,
    py: string,
  ): string {
    const { p, l } = ctx;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const metaStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: s.textColor ?? p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const metaLinkClass = this.textLinkClass(p.textMuted, p.accent);
    const flex =
      s.layout === 'stacked'
        ? 'flex flex-col items-start gap-2'
        : 'flex flex-wrap items-center gap-2';
    const separator = s.showSeparator === false ? '' : '<span aria-hidden="true">-</span>';
    const parts: string[] = [];

    if (s.showDate) {
      parts.push(
        `<time dateTime={metaSource.date} className="whitespace-nowrap">{new Date(metaSource.date).toLocaleDateString()}</time>`,
      );
    }
    if (s.showAuthor) {
      if (parts.length > 0 && separator) parts.push(separator);
      parts.push(
        `{metaSource.author && (metaSource.authorSlug ? <Link to={\`/author/\${metaSource.authorSlug}\`} className="${metaLinkClass}">by {metaSource.author}</Link> : <span>by {metaSource.author}</span>)}`,
      );
    }
    if (s.showCategories) {
      if (parts.length > 0 && separator) parts.push(separator);
      parts.push(
        `{metaSource.categories?.[0] && (metaSource.categorySlugs?.[0] ? <Link to={\`/category/\${metaSource.categorySlugs[0]}\`} className="${metaLinkClass}">{metaSource.categories[0]}</Link> : <span>{metaSource.categories[0]}</span>)}`,
      );
    }

    return `      {metaSource ? (
        <section className={['bg-[${bg}] ${py} w-full', className].filter(Boolean).join(' ')}${sectionStyle}>
          <div className="${l.containerClass}">
            <div className="text-sm text-[${p.textMuted}] ${flex}"${metaStyle}${this.buildSectionGapStyleAttr(s)}>
              ${parts.join('\n              ')}
            </div>
          </div>
        </section>
      ) : null}`;
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
    const classes = s.customClassNames ?? [];
    const hasCenteredIntro = classes.includes('vp-card-grid-intro-centered');
    const hasAsteriskStyle = classes.includes('is-style-asterisk');
    const cardRadius = this.cardRadiusClass(ctx);
    const cardStylePreset = this.mergeBlockStyleTokens(
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const cardStyle = this.buildBlockStyleAttr(
      cardStylePreset,
      { padding: l.cardPadding },
      true,
      ctx,
    );
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const subtitleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const cardHeadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const cardBodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const colClass = this.responsiveGridColumnsClass(s.columns, s.columnWidths);
    const cards = s.cards
      .map(
        (c) =>
          `          <div className="flex flex-col gap-3 ${cardRadius}"${cardStyle}>
            ${(c as any).imageSrc ? `<img src="${(c as any).imageSrc}" alt="${(c as any).imageAlt ?? ''}" className="w-full aspect-video object-cover ${cardRadius} mb-1" loading="lazy" />` : ''}
            ${hasAsteriskStyle ? `<span className="is-style-asterisk text-[1.5rem] leading-none select-none" aria-hidden="true">*</span>` : ''}
            ${c.heading ? `<h3 className="font-semibold"${cardHeadingStyle}>${c.heading}</h3>` : ''}
            ${c.body ? `<p${cardBodyStyle}>${c.body}</p>` : ''}
          </div>`,
      )
      .join('\n');
    const intro =
      s.title || s.subtitle
        ? `          <div className="${hasCenteredIntro ? 'mb-10 flex flex-col items-center text-center' : 'mb-8'}">
            ${s.title ? `<h2 className="${t.h2} font-normal${hasCenteredIntro ? ' text-center' : ''}"${titleStyle}>${s.title}</h2>` : ''}
            ${s.subtitle ? `<p className="${hasCenteredIntro ? 'mt-4 max-w-[620px] text-center' : 'mt-4'}"${subtitleStyle}>${s.subtitle}</p>` : ''}
          </div>`
        : '';

    return `      {/* Card Grid */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
${intro}
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
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc, typography: s.headingStyle },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const bodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc, typography: s.bodyStyle },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const listItemStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'list'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const layoutClass =
      s.columnWidths?.length === 2
        ? `grid grid-cols-1 ${this.responsiveGridColumnsClass(2, s.columnWidths, 'md')} gap-8 items-center`
        : 'flex flex-col md:flex-row gap-8 items-center';
    const imgFirst = s.imagePosition === 'left';
    const itemWrapper = s.columnWidths?.length === 2 ? 'min-w-0' : 'flex-1';
    const cta = this.renderButtonCtaGroup(this.resolveSectionCtas(s), ctx, {
      align: 'start',
    });
    const imgEl = `<div className="${itemWrapper}"><img src={resolveAsset("${s.imageSrc}")} alt="${s.imageAlt}" className="w-full h-auto object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle, {}, false, ctx)} /></div>`;
    const textEl = `<div className="${itemWrapper} flex flex-col gap-4">
            ${s.heading ? `<h2 className="${t.h3} font-[600]"${headingStyle}>${s.heading}</h2>` : ''}
            ${s.body ? `<p${bodyStyle}>${s.body}</p>` : ''}
            ${s.listItems ? `<ul className="flex flex-col gap-2">${s.listItems.map((li) => (/<[a-z]/i.test(li) ? `<li className="font-medium"${listItemStyle} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(li)} }} />` : `<li className="font-medium"${listItemStyle}>${li}</li>`)).join('')}</ul>` : ''}
            ${cta}
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
    const quoteStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'pullquote'),
      this.pickBlockStyle(ctx, 'quote'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const authorStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const authorTitleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const styleAttr = this.buildSectionStyleAttr(s, {
      backgroundColor: bg,
      color: tc,
    });

    const align =
      s.contentAlign === 'right'
        ? 'items-end text-right'
        : s.contentAlign === 'left'
          ? 'items-start text-left'
          : 'items-center text-center';
    const containerAlign =
      s.contentAlign === 'right'
        ? 'ml-auto'
        : s.contentAlign === 'left'
          ? ''
          : 'mx-auto';

    return `      {/* Testimonial */}
      <section className="w-full ${py}"${styleAttr}>
        <div className="max-w-[720px] ${containerAlign} px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col ${align} gap-8"${this.buildSectionGapStyleAttr(s)}>
            <p className="${t.h3} font-normal leading-snug"${quoteStyle}>"${s.quote}"</p>
            <div className="flex flex-col ${align.replace('text-right', '').replace('text-left', '').replace('text-center', '').trim()} gap-1">
              ${s.authorAvatar ? `<img src={resolveAsset("${s.authorAvatar}")} alt="${s.authorName}" className="w-14 h-14 rounded-full object-cover mb-2" />` : ''}
              <span className="font-medium"${authorStyle}>${s.authorName}</span>
              ${s.authorTitle ? `<span className="text-sm opacity-70"${authorTitleStyle}>${s.authorTitle}</span>` : ''}
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
    const cardStyle = this.buildMergedBlockStyleAttr(
      ctx,
      { padding: l.cardPadding, gap: s.gapStyle },
      true,
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const subheadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const inner =
      s.layout === 'card'
        ? `<div className="bg-[${p.surface}] ${cardRadius || 'rounded-2xl'} p-8 md:p-12 max-w-[560px] mx-auto text-center flex flex-col gap-4"${cardStyle}>`
        : `<div className="flex flex-col items-center text-center gap-4"${this.buildSectionGapStyleAttr(s)}>`;

    return `      {/* Newsletter */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${inner}
            <h2 className="${t.h2} font-normal text-[${tc}]"${headingStyle}>${s.heading}</h2>
            ${s.subheading ? `<p className="text-[${p.textMuted}]"${subheadingStyle}>${s.subheading}</p>` : ''}
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
      ctx,
    );
    const brandStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'site-title', 'heading'),
    );
    const descriptionStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline', 'paragraph'),
    );
    const columnHeadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const linkStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'navigation'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const logoStyle = this.buildMergedBlockStyleAttr(
      ctx,
      {
        width: s.logoWidth,
        maxWidth: '100%',
      },
      false,
      this.pickBlockStyle(ctx, 'site-logo'),
      this.pickBlockStyle(ctx, 'image'),
    );
    const showSiteLogo = s.showSiteLogo !== false;
    const showSiteTitle = s.showSiteTitle !== false;
    const showTagline = s.showTagline !== false;
    const brandDescriptionExpr = s.brandDescription
      ? JSON.stringify(s.brandDescription)
      : 'siteInfo?.blogDescription';
    const footerColumnsExpr =
      '(footerColumns.length > 0 ? footerColumns.filter((column) => Array.isArray(column.links) && column.links.length > 0) : fallbackFooterColumns)';
    const fallbackColumns = JSON.stringify(
      s.menuColumns.map((col) => ({ heading: col.title, links: [] })),
    );
    const outerTracks =
      s.columnWidths
        ?.map((value) => value.trim().replace(/\s+/g, ''))
        .filter(Boolean)
        .join('_') ?? '';
    const hasSpacerColumn =
      (s.columnWidths?.length ?? 0) >= 3 && s.menuColumns.length > 0;
    const outerGridClass = outerTracks
      ? `grid-cols-1 md:grid-cols-[${outerTracks}]`
      : `grid-cols-1 md:grid-cols-${hasSpacerColumn ? 3 : 2}`;
    const menuGridClass = this.responsiveGridColumnsClass(
      Math.min(Math.max(s.menuColumns.length, 1), 4),
      undefined,
      'lg',
    );
    const copyrightMarkup = s.copyright
      ? `<p className="text-sm text-[${p.textMuted}] mt-8 pt-8 border-t border-black/10"${descriptionStyle}>{${JSON.stringify(s.copyright)}}</p>`
      : '';

    return `      {/* Footer */}
      <footer className="bg-[${bg}] border-t border-black/10 w-full"${sectionStyle}>
        <div className="${l.containerClass} py-12">
          <div className="grid ${outerGridClass} items-start gap-8"${this.buildSectionGapStyleAttr(s)}>
            <div className="flex min-w-0 flex-col items-start gap-3">
              <Link to="/" className="flex flex-col items-start gap-3 text-[${tc}]">
                ${showSiteLogo ? `{siteInfo?.logoUrl ? <img src={siteInfo.logoUrl} alt={siteInfo?.siteName ?? 'Site logo'} className="h-auto object-contain"${logoStyle} /> : null}` : ''}
                ${showSiteTitle ? `<span className="font-bold text-[${tc}]"${brandStyle}>{siteInfo?.siteName}</span>` : ''}
                ${showSiteLogo && !showSiteTitle ? '<span className="sr-only">{siteInfo?.siteName}</span>' : ''}
              </Link>
              ${showTagline ? `<p className="text-sm text-[${p.textMuted}]"${descriptionStyle}>{${brandDescriptionExpr}}</p>` : ''}
            </div>
            ${hasSpacerColumn ? '<div className="hidden md:block" aria-hidden="true" />' : ''}
            <div className="min-w-0">
              <div className="grid ${menuGridClass} items-start gap-8">
                {(() => {
                  const fallbackFooterColumns = ${fallbackColumns};
                  return ${footerColumnsExpr}.map((column, columnIndex) => (
                    <div key={column.heading ?? columnIndex} className="flex min-w-0 flex-col gap-3">
                      <h3 className="font-semibold text-[${tc}]"${columnHeadingStyle}>{column.heading}</h3>
                      <nav className="flex flex-col gap-2">
                        {(column.links ?? []).map((link, linkIndex) => (
                          isInternalPath(link.url) ? (
                            <Link key={\`\${column.heading ?? columnIndex}-\${link.label}-\${linkIndex}\`} to={toAppPath(link.url)} className="${this.textLinkClass(p.textMuted, p.accent, 'text-sm')}"${linkStyle}>
                              {link.label}
                            </Link>
                          ) : (
                            <a key={\`\${column.heading ?? columnIndex}-\${link.label}-\${linkIndex}\`} href={link.url} className="${this.textLinkClass(p.textMuted, p.accent, 'text-sm')}"${linkStyle}>
                              {link.label}
                            </a>
                          )
                        ))}
                      </nav>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
          ${copyrightMarkup}
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
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const authorStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const metaStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const bodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const inputStyle = this.buildMergedBlockStyleAttr(
      ctx,
      {
        color: tc,
        backgroundColor: 'transparent',
        borderColor: 'rgb(0 0 0 / 0.2)',
        borderWidth: '1px',
        borderStyle: 'solid',
        padding: '0.625rem 0.875rem',
      },
      false,
      this.pickBlockStyle(ctx, 'search'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const moderationStyle = this.buildMergedBlockStyleAttr(
      ctx,
      { padding: '1rem' },
      false,
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const renderCommentCard = (
      commentVar: string,
    ) => `                      <div className="flex items-start gap-3">
                         <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-sm font-medium text-[${tc}]">
                           {${commentVar}.author.charAt(0).toUpperCase()}
                         </span>
                         <div className="flex-1">
                           <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <div className="text-sm font-medium text-[${tc}]"${authorStyle}>{${commentVar}.author}</div>
                            <time className="text-xs text-[${p.textMuted}]"${metaStyle}>{${commentVar}.date}</time>
                           </div>
                          <p className="mt-2 whitespace-pre-line text-sm text-[${p.textMuted}]"${bodyStyle}>{${commentVar}.content}</p>
                         </div>
                       </div>`;
    const formBlock = s.showForm
      ? `
              <div className="flex flex-col gap-4 pt-6 border-t border-black/10">
                <h3 className="${t.h3} font-normal text-[${tc}]"${headingStyle}>Leave a Reply</h3>
                <form className="flex flex-col gap-3" onSubmit={handleCommentSubmit}>
                  ${s.requireName ? `<input type="text" placeholder="Name *" required value={commentAuthor} onChange={(event) => setCommentAuthor(event.target.value)} className="${t.buttonRadius} text-sm" spellCheck={false}${inputStyle} />` : ''}
                  ${s.requireEmail ? `<input type="email" placeholder="Email *" required value={commentEmail} onChange={(event) => setCommentEmail(event.target.value)} className="${t.buttonRadius} text-sm" spellCheck={false}${inputStyle} />` : ''}
                  <textarea rows={4} placeholder="Your comment..." value={commentContent} onChange={(event) => setCommentContent(event.target.value)} className="${t.buttonRadius} text-sm resize-none"${inputStyle} />
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
                <div className="rounded-[24px] border border-black/10 bg-black/5"${moderationStyle}>
                  <p className="text-sm font-medium text-[${tc}]"${authorStyle}>
                    {pendingComments.length === 1
                      ? '1 comment is awaiting moderation.'
                      : \`\${pendingComments.length} comments are awaiting moderation.\`}
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    {pendingComments.map((pendingComment) => (
                      <div key={pendingComment.id} className="rounded-[18px] bg-white/70"${this.buildMergedBlockStyleAttr(ctx, { padding: '0.75rem 1rem' }, false, this.pickBlockStyle(ctx, 'group'), this.pickBlockStyle(ctx, 'column'))}>
                        <div className="text-sm font-medium text-[${tc}]"${authorStyle}>{pendingComment.author}</div>
                        <p className="mt-1 whitespace-pre-line text-sm text-[${p.textMuted}]"${bodyStyle}>{pendingComment.content}</p>
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
              <h2 className="${t.h2} font-normal text-[${tc}]"${headingStyle}>
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
                <p className="text-sm text-[${p.textMuted}]"${bodyStyle}>No comments yet.</p>
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
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const resultLinkStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const metaStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const searchControlStyle = this.buildMergedBlockStyleAttr(
      ctx,
      {
        color: tc,
        backgroundColor: 'transparent',
        borderColor: 'rgb(0 0 0 / 0.2)',
        borderWidth: '1px',
        borderStyle: 'solid',
        padding: '0.625rem 1rem',
      },
      false,
      this.pickBlockStyle(ctx, 'search'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    return `      {/* Search */}
      <section className="bg-[${bg}] ${py} w-full"${sectionStyle}>
        <div className="${l.containerClass}">
          ${s.title ? `<h2 className="${t.h2} font-normal text-[${tc}] mb-6"${titleStyle}>${s.title}</h2>` : ''}
          <div className="flex gap-2">
            <input type="search" placeholder="Search..." className="flex-1 ${t.buttonRadius}"${searchControlStyle} />
            <button className="bg-[${p.accent}] text-[${p.accentText}] px-4 py-2 ${t.buttonRadius} hover:opacity-90"${this.buttonStyleAttr(ctx)}>Search</button>
          </div>
          <div className="mt-8 flex flex-col gap-4"${this.buildSectionGapStyleAttr(s)}>
            {posts.map(post => (
              <Link key={post.id} to={\`/post/\${post.slug}\`} className="${this.textLinkClass(tc, p.accent)}"${resultLinkStyle}>{post.title}</Link>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between gap-4 text-sm text-[${p.textMuted}]"${metaStyle}>
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
          <li><Link to="/" className="${this.textLinkClass(p.textMuted, p.accent)}">Home</Link></li>
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
    const metaLinkClass = this.textLinkClass(p.textMuted, p.accent);
    if (s.showDate)
      metaParts.push(`<time>{new Date(item.date).toLocaleDateString()}</time>`);
    if (s.showAuthor) {
      metaParts.push(
        `{item.author && (item.authorSlug ? <Link to={\`/author/\${item.authorSlug}\`} className="${metaLinkClass}">by {item.author}</Link> : <span>by {item.author}</span>)}`,
      );
    }
    if (s.showCategories)
      metaParts.push(
        `{item.categories[0] && (item.categorySlugs[0] ? <Link to={\`/category/\${item.categorySlugs[0]}\`} className="${metaLinkClass}">{item.categories[0]}</Link> : <span>{item.categories[0]}</span>)}`,
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
    const radius = this.cardRadiusClass(ctx) || 'rounded-2xl';
    const paddingStyle = this.buildMergedBlockStyleAttr(
      ctx,
      { padding: l.cardPadding, gap: s.gapStyle },
      true,
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.text },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const brandStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.text },
      this.pickBlockStyle(ctx, 'site-title', 'heading'),
    );
    const metaStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.textMuted },
      this.pickBlockStyle(ctx, 'site-tagline'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const navLinkStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: p.text },
      this.pickBlockStyle(ctx, 'navigation'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const titleBlock = s.title
      ? `            <h3 className="${t.h3} font-normal text-[${p.text}]"${titleStyle}>${s.title}</h3>\n`
      : '';
    const maxItems = maxItemsOverride ?? s.maxItems ?? 6;
    const menuSlug = s.menuSlug ? `'${s.menuSlug}'` : 'undefined';

    const siteInfoBlock = s.showSiteInfo
      ? `            <div className="flex flex-col gap-2">
              <div className="font-semibold text-[${p.text}]"${brandStyle}>{siteInfo?.siteName}</div>
              {siteInfo?.blogDescription && (
                <p className="text-sm text-[${p.textMuted}]"${metaStyle}>{siteInfo.blogDescription}</p>
              )}
            </div>
`
      : '';

    const menuBlock = s.menuSlug
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]"${metaStyle}>Navigation</div>
              <nav className="flex flex-col gap-2">
                {(menus.find(m => m.slug === ${menuSlug}) ?? menus[0])?.items
                  ?.filter(item => item.parentId === 0)
                  ?.slice(0, ${maxItems})
                  ?.map(item => (
                    isInternalPath(item.url) ? (
                      <Link key={item.id} to={toAppPath(item.url)} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.textLinkClass(p.text, p.accent, 'text-sm')}"${navLinkStyle}>
                        {item.title}
                      </Link>
                    ) : (
                      <a key={item.id} href={item.url} target={item.target ?? undefined} rel={item.target === "_blank" ? "noopener noreferrer" : undefined} className="${this.textLinkClass(p.text, p.accent, 'text-sm')}"${navLinkStyle}>
                        {item.title}
                      </a>
                    )
                  ))}
              </nav>
            </div>
`
      : '';

    const pagesBlock = s.showPages
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]"${metaStyle}>Pages</div>
              <nav className="flex flex-col gap-2">
                {pages.slice(0, ${maxItems}).map(page => (
                  <Link key={page.id} to={\`/page/\${page.slug}\`} className="${this.textLinkClass(p.text, p.accent, 'text-sm')}"${navLinkStyle}>
                    {page.title}
                  </Link>
                ))}
              </nav>
            </div>
`
      : '';

    const postsBlock = s.showPosts
      ? `            <div className="flex flex-col gap-3">
              <div className="text-sm font-semibold uppercase tracking-[0.08em] text-[${p.textMuted}]"${metaStyle}>Latest Posts</div>
              <div className="flex flex-col gap-3">
                {posts.slice(0, ${maxItems}).map(post => (
                  <Link key={post.id} to={\`/post/\${post.slug}\`} className="${this.textLinkClass(p.text, p.accent, 'text-sm')}"${navLinkStyle}>
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
      margin: this.normalizeSectionMarginStyle(section.marginStyle),
    };
  }

  private normalizeSectionMarginStyle(
    marginStyle?: string,
  ): string | undefined {
    if (!marginStyle) return undefined;
    const normalized = marginStyle.trim();
    if (!normalized) return undefined;

    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return `${parts[0]} auto`;
    }
    if (parts.length === 2) {
      return `${parts[0]} auto`;
    }
    if (parts.length === 3) {
      return `${parts[0]} auto ${parts[2]}`;
    }
    return normalized;
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
        return `${indent}<div className="${this.mergeWpNodeClassName('w-full', node)}"${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'columns': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'columns', 'group'),
          this.buildWpColumnsStyle(node),
        );
        return `${indent}<div className="${this.mergeWpNodeClassName('w-full min-w-0', node)}"${styleAttr}>
${children}
${indent}</div>`;
      }
      case 'column': {
        const styleAttr = this.buildWpNodeStyleAttr(
          node,
          this.pickBlockStyle(ctx, 'column', 'group'),
        );
        return `${indent}<div className="${this.mergeWpNodeClassName('min-w-0', node)}"${styleAttr}>
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
 ${childIndent}  <Link to={toAppPath(${JSON.stringify(href)})} className="${this.mergeWpNodeClassName(this.opacityLinkClass(), node)}"${this.buildWpNodeStyleAttr(node)}>
${childIndent}    ${node.text ?? href}
${childIndent}  </Link>
${childIndent}) : (
 ${childIndent}  <a href="${href}" className="${this.mergeWpNodeClassName(this.opacityLinkClass(), node)}"${this.buildWpNodeStyleAttr(node)}>
${childIndent}    ${node.text ?? href}
${childIndent}  </a>
${childIndent})}`
    : `${childIndent}<a href="#" className="${this.mergeWpNodeClassName(this.opacityLinkClass(), node)}"${this.buildWpNodeStyleAttr(node)}>
${childIndent}  ${node.text ?? ''}
${childIndent}</a>`
}${nestedChildren}
${indent}</li>`;
      }
      case 'site-title':
        return `${indent}<Link to="/" className="${this.mergeWpNodeClassName(this.opacityLinkClass('font-semibold'), node)}"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'site-title', 'heading'))}>
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
 ${childIndent}<Link to="/" className="${this.mergeWpNodeClassName('inline-flex items-center', node)}"${styleAttr}>
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
 ${childIndent}<Link to={toAppPath(${JSON.stringify(href)})} className="${this.mergeWpNodeClassName('inline-flex items-center justify-center no-underline transition-opacity hover:opacity-90', node)}"${styleAttr}>
${childIndent}  ${node.text ?? href}
${childIndent}</Link>
${indent}) : (
 ${childIndent}<a href="${href}" className="${this.mergeWpNodeClassName('inline-flex items-center justify-center no-underline transition-opacity hover:opacity-90', node)}"${styleAttr}>
${childIndent}  ${node.text ?? href}
${childIndent}</a>
${indent})}`
          : `${indent}<a href="#" className="${this.mergeWpNodeClassName('inline-flex items-center justify-center no-underline transition-opacity hover:opacity-90', node)}"${styleAttr}>
${childIndent}${node.text ?? ''}
${indent}</a>`;
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
        return `${indent}<img src="${node.src ?? ''}" alt="${node.alt ?? ''}" className="${this.mergeWpNodeClassName('h-auto max-w-full object-contain', node)}"${styleAttr} />`;
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
          ? `${indent}<a href="${href}" className="${this.opacityLinkClass()}"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'social-link'))}>
${childIndent}${service}
${indent}</a>`
          : `${indent}<a href="#" className="${this.opacityLinkClass()}"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'social-link'))}>
${childIndent}${service}
${indent}</a>`;
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
    const orientation =
      node.menuOrientation ??
      (node.params?.layout?.orientation as
        | 'horizontal'
        | 'vertical'
        | undefined) ??
      (state.componentKind === 'footer' ? 'vertical' : 'horizontal');
    const isVertical =
      orientation === 'vertical' || state.componentKind === 'footer';
    const overlayMode = this.resolveNavigationOverlayMode({
      overlayMenu: node.overlayMenu,
      orientation,
      isResponsive: node.isResponsive,
      componentKind: state.componentKind,
    });
    const isResponsiveNav = this.isNavigationResponsive({
      overlayMode,
      orientation,
      isResponsive: node.isResponsive,
    });
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
    const isMobileNav =
      !isVertical &&
      state.componentKind === 'header' &&
      overlayMode !== 'never' &&
      isResponsiveNav;
    if (isMobileNav) {
      const tc = ctx.p.text;
      const desktopNavClass =
        overlayMode === 'always' ? 'hidden' : 'hidden md:flex';
      const mobileButtonClass =
        overlayMode === 'always'
          ? 'flex items-center p-2'
          : 'md:hidden flex items-center p-2';
      const mobilePanelClass =
        overlayMode === 'always'
          ? 'absolute top-full left-0 right-0 bg-[${ctx.p.surface}] border-b border-black/10 z-50'
          : 'md:hidden absolute top-full left-0 right-0 bg-[${ctx.p.surface}] border-b border-black/10 z-50';
      return `${indent}<>
${indent}  <nav className="${desktopNavClass}"${this.buildWpNodeStyleAttr(node, this.pickBlockStyle(ctx, 'navigation'), this.buildWpLayoutStyle(node))}>
${indent}    {${menuVar} ? (
${indent}      <ul className="${listClass}">
${indent}        {renderMenuItems(${menuVar}.items, 0, false)}
${indent}      </ul>
${indent}    ) : (
${fallbackMarkup}
${indent}    )}
${indent}  </nav>
${indent}  <button
${indent}    className="${mobileButtonClass} text-[${tc}]"
${indent}    aria-label="Toggle menu"
${indent}    onClick={() => setMobileMenuOpen(prev => !prev)}
${indent}  >
${indent}    {mobileMenuOpen ? (
${indent}      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
${indent}    ) : (
${indent}      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
${indent}    )}
${indent}  </button>
${indent}  {mobileMenuOpen && (
${indent}    <nav className="${mobilePanelClass}">
${indent}      <div className="${ctx.l.containerClass} py-3">
${indent}        {${menuVar} ? (
${indent}          <ul className="flex flex-col gap-1">
${indent}            {renderMenuItems(${menuVar}.items, 0, true)}
${indent}          </ul>
${indent}        ) : (
${fallbackMarkup}
${indent}        )}
${indent}      </div>
${indent}    </nav>
${indent}  )}
${indent}</>`;
    }
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

  private mergeWpNodeClassName(base: string, node: WpNode): string {
    const classes = [...base.split(/\s+/), ...(node.customClassNames ?? [])]
      .map((token) => token.trim())
      .filter(Boolean);
    return Array.from(new Set(classes)).join(' ');
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

  private buildInteractiveSectionStateKey(
    section: SectionPlan,
    sectionIndex: number,
  ): string {
    return (
      section.sectionKey ??
      section.sourceRef?.sourceNodeId ??
      `${section.type}-${sectionIndex + 1}`
    );
  }

  private renderModal(
    s: ModalSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
    sectionIndex: number,
  ): string {
    const { t } = ctx;
    const stateKey = JSON.stringify(
      this.buildInteractiveSectionStateKey(s, sectionIndex),
    );
    const sectionStyle = this.buildSectionStyleAttr(s);
    const gapStyle = this.buildSectionGapStyleAttr(s);
    const triggerText = s.triggerText || s.heading || 'Open';
    const modalTextColor = ctx.p.text;
    const modalMutedTextColor = ctx.p.textMuted || ctx.p.text;
    const overlayColor = s.overlayColor?.trim() || 'rgba(15, 23, 42, 0.72)';
    const closeOnOverlay = s.closeOnOverlay !== false;
    const closeButtonSide = (s.closeIconPosition ?? '')
      .toLowerCase()
      .includes('left')
      ? '-left-5 sm:-left-6'
      : '-right-5 sm:-right-6';
    const modalWidth =
      this.normalizeCssLength(s.width) ??
      (s.layout === 'split' && s.imageSrc ? '880px' : '500px');
    const modalHeight = this.normalizeCssLength(s.height);
    const modalShellStyle = this.buildStyleAttr({
      width: '100%',
      maxWidth: modalWidth,
      minHeight: modalHeight,
      maxHeight: modalHeight
        ? `min(${modalHeight}, calc(100vh - 2rem))`
        : 'calc(100vh - 2rem)',
    });
    const dialogBodyStyle = this.buildMergedBlockStyleAttr(
      ctx,
      { padding: s.layout === 'split' && s.imageSrc ? '1.5rem' : '1.25rem' },
      true,
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const headingTextStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: modalTextColor },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const bodyTextStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: modalMutedTextColor },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const imageStyle = this.buildBlockStyleAttr(
      this.pickBlockStyle(ctx, 'image', 'gallery'),
      {},
      false,
      ctx,
    );
    const imageRadius = this.imageRadiusClass(ctx) || 'rounded-[24px]';
    const triggerHeadingPart = s.heading
      ? `\n          <div className="max-w-2xl">\n            <h2 className="${t.h2} font-semibold" style={{ color: '${tc}' }}>{${JSON.stringify(s.heading)}}</h2>\n          </div>`
      : '';
    const headingPart = s.heading
      ? `\n                  <h3 className="${t.h2} font-semibold tracking-[-0.02em]"${headingTextStyle}>{${JSON.stringify(s.heading)}}</h3>`
      : '';
    const bodyPart = s.body
      ? `\n                  <div className="${t.body} leading-7"${bodyTextStyle} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(s.body)} }} />`
      : '';
    const ctaPart = this.renderInteractiveAnchorCtaGroup(
      this.resolveSectionCtas(s),
      ctx,
    );
    const imagePart = s.imageSrc
      ? `\n                <div className="relative overflow-hidden ${imageRadius} bg-slate-100">\n                  <img src={resolveAsset(${JSON.stringify(s.imageSrc)})} alt={${JSON.stringify(s.imageAlt ?? '')}} className="h-full min-h-[240px] w-full object-cover"${imageStyle} />\n                </div>`
      : '';
    const contentGridClass =
      s.layout === 'split' && s.imageSrc
        ? 'grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.88fr)] lg:items-center'
        : 'flex flex-col gap-6';

    return `
    <section className="w-full ${py} bg-[${bg}] text-[${tc}]"${sectionStyle}>
      <div className="${ctx.l.containerClass} px-4 sm:px-6">
        <div className="uagb-modal-wrapper flex flex-col items-start gap-4"${gapStyle}>${triggerHeadingPart}
          <button
            type="button"
            onClick={() => setOpenModals((prev) => ({ ...prev, [${stateKey}]: true }))}
            className="uagb-modal-trigger uagb-modal-button-link inline-flex items-center justify-center gap-2 ${ctx.t.buttonRadius} px-5 py-3 font-medium transition-transform transition-opacity hover:-translate-y-0.5 hover:opacity-90"
            style={{ background: '${ctx.p.accent}', color: '${ctx.p.accentText}' }}
          >
            {${JSON.stringify(triggerText)}}
          </button>
          {openModals[${stateKey}] ? (
            <div
              className="uagb-modal-popup active uagb-effect-default fixed inset-0 z-[90] flex items-center justify-center px-4 py-4 sm:py-8"
              style={{ background: '${overlayColor}' }}
              onClick={() => {
                if (${closeOnOverlay ? 'true' : 'false'}) {
                  setOpenModals((prev) => ({ ...prev, [${stateKey}]: false }));
                }
              }}
            >
              <div
                className="uagb-modal-popup-wrap relative overflow-y-auto rounded-[30px] bg-white shadow-[0_30px_80px_rgba(15,23,42,0.28)]"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={${JSON.stringify(s.heading || triggerText)}}
                ${modalShellStyle}
              >
                <button
                  type="button"
                  onClick={() => setOpenModals((prev) => ({ ...prev, [${stateKey}]: false }))}
                  className="uagb-modal-popup-close absolute -top-5 z-10 inline-flex h-10 w-10 items-center justify-center text-white transition-opacity hover:opacity-75 sm:-top-6 ${closeButtonSide}"
                  aria-label="Close modal"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
                <div className="uagb-modal-popup-content ${contentGridClass}"${dialogBodyStyle}>
                  <div className="flex flex-col gap-5">${headingPart}${bodyPart}${ctaPart}
                  </div>${imagePart}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>`;
  }

  private renderTabs(
    s: TabsSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
    sectionIndex: number,
  ): string {
    const { t } = ctx;
    const stateKeyRaw = this.buildInteractiveSectionStateKey(s, sectionIndex);
    const stateKey = JSON.stringify(stateKeyRaw);
    const domKey = stateKeyRaw.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const defaultActiveTab = Math.min(
      Math.max(s.activeTab ?? 0, 0),
      Math.max(s.tabs.length - 1, 0),
    );
    const variant = (s.variant ?? '').toLowerCase();
    const isVertical =
      variant.includes('vertical') || /(^|[^a-z])vstyle\d+/i.test(variant);
    const isStacked = /(^|[^a-z])stack\d+/i.test(variant);
    const isPillLike =
      variant.includes('pill') ||
      variant.includes('boxed') ||
      variant.includes('style-2') ||
      variant.includes('style-3') ||
      /(^|[^a-z])hstyle4|(^|[^a-z])vstyle9|(^|[^a-z])stack4/i.test(variant);
    const isDistributedTabs = /(^|[^a-z])hstyle5|(^|[^a-z])vstyle10/i.test(
      variant,
    );
    const spectraVariantClass = variant
      ? variant.startsWith('uagb-tabs__')
        ? variant
        : `uagb-tabs__${variant}${
            /-(desktop|tablet|mobile)$/i.test(variant) ? '' : '-desktop'
          }`
      : isVertical
        ? 'uagb-tabs__vstyle6-desktop'
        : 'uagb-tabs__hstyle4-desktop';
    const spectraAlignClass =
      s.tabAlign === 'center'
        ? 'uagb-tabs__align-center'
        : s.tabAlign === 'right'
          ? 'uagb-tabs__align-right'
          : 'uagb-tabs__align-left';
    const sectionStyle = this.buildSectionStyleAttr(s);
    const gapStyle = this.buildSectionGapStyleAttr(s);
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const panelStyle = this.buildMergedBlockStyleAttr(
      ctx,
      { padding: '1.5rem' },
      true,
      this.pickBlockStyle(ctx, 'group'),
      this.pickBlockStyle(ctx, 'column'),
    );
    const panelHeadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const panelBodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const imageStyle = this.buildMergedBlockStyleAttr(
      ctx,
      {},
      false,
      this.pickBlockStyle(ctx, 'image'),
      this.pickBlockStyle(ctx, 'gallery'),
    );
    const imageRadius = this.imageRadiusClass(ctx) || this.cardRadiusClass(ctx);
    const tabsLayoutClass = isVertical
      ? 'grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start'
      : isStacked
        ? 'flex flex-col gap-4'
        : 'flex flex-col gap-6';
    const tabAlignClass = isDistributedTabs
      ? 'justify-between'
      : s.tabAlign === 'center'
        ? 'justify-center'
        : s.tabAlign === 'right'
          ? 'justify-end'
          : 'justify-start';
    const tabListClass = isVertical
      ? 'flex flex-col gap-2'
      : `flex flex-wrap gap-3 ${tabAlignClass}`;
    const tabListSurfaceClass = isPillLike
      ? 'rounded-[24px] border border-black/10 bg-white/70 p-2 shadow-[0_18px_40px_rgba(15,23,42,0.06)]'
      : 'border-b border-black/10 pb-1';
    const titlePart = s.title
      ? `\n          <div className="flex flex-col gap-3">\n            <h2 className="${t.h2} font-semibold"${titleStyle}>{${JSON.stringify(s.title)}}</h2>\n          </div>`
      : '';
    const tabButtons = s.tabs
      .map(
        (tab, index) => `            <div
              key=${index}
              className={(activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                ? 'uagb-tab uagb-tabs__active'
                : 'uagb-tab'}
            >
              <button
                type="button"
                role="tab"
                id="${domKey}-tab-${index}"
                aria-selected={(activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}}
                aria-controls="${domKey}-panel-${index}"
                onClick={() => setActiveTabs((prev) => ({ ...prev, [${stateKey}]: ${index} }))}
                onKeyDown={(event) => {
                  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const current = activeTabs[${stateKey}] ?? ${defaultActiveTab};
                  let next = current;
                  if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = ${Math.max(s.tabs.length - 1, 0)};
                  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current >= ${Math.max(s.tabs.length - 1, 0)} ? 0 : current + 1;
                  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current <= 0 ? ${Math.max(s.tabs.length - 1, 0)} : current - 1;
                  setActiveTabs((prev) => ({ ...prev, [${stateKey}]: next }));
                }}
                className={(activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                  ? 'uagb-tabs-list ${isVertical ? 'flex w-full items-center justify-between' : 'inline-flex items-center justify-center'} rounded-[18px] px-4 py-3 text-left font-semibold shadow-sm'
                  : 'uagb-tabs-list ${isVertical ? 'flex w-full items-center justify-between' : 'inline-flex items-center justify-center'} rounded-[18px] px-4 py-3 text-left font-medium opacity-80 transition-all hover:opacity-100'}
                style={{
                  color: (activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                    ? '${isPillLike ? ctx.p.accentText : tc}'
                    : '${tc}',
                  background: (activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                    ? '${isPillLike ? ctx.p.accent : 'rgba(255,255,255,0.92)'}'
                    : '${isPillLike ? 'rgba(15,23,42,0.04)' : 'transparent'}',
                  borderColor: (activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                    ? '${ctx.p.accent}'
                    : 'transparent',
                  borderWidth: '${isPillLike ? '1px' : '0'}',
                }}
              >
                {${JSON.stringify(tab.label)}}
              </button>
            </div>`,
      )
      .join('\n');
    const panels = s.tabs
      .map((tab, index) => {
        const headingPart = tab.heading
          ? `\n                <h3 className="${t.h3} font-semibold"${panelHeadingStyle}>{${JSON.stringify(tab.heading)}}</h3>`
          : '';
        const bodyPart = tab.body
          ? `\n                <div className="${t.body} leading-7"${panelBodyStyle} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(tab.body)} }} />`
          : '';
        const imagePart = tab.imageSrc
          ? `\n                <img src={resolveAsset(${JSON.stringify(tab.imageSrc)})} alt={${JSON.stringify(tab.imageAlt ?? '')}} className="h-auto w-full ${imageRadius} object-cover"${imageStyle} />`
          : '';
        const ctaPart = tab.cta
          ? `\n                <a href={${JSON.stringify(tab.cta.link)}} className="${this.buildInteractiveCtaClassName(
              `inline-flex items-center justify-center ${ctx.t.buttonRadius} px-5 py-3 font-medium transition-opacity hover:opacity-90`,
              tab.cta,
            )}" style={{ background: '${ctx.p.accent}', color: '${ctx.p.accentText}' }}>\n                  {${JSON.stringify(tab.cta.text)}}\n                </a>`
          : '';
        const panelGridClass =
          tab.imageSrc && (tab.heading || tab.body || tab.cta)
            ? 'grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center'
            : 'flex flex-col gap-5';
        return `            <div
              key=${index}
              id="${domKey}-panel-${index}"
              role="tabpanel"
              aria-labelledby="${domKey}-tab-${index}"
              className={(activeTabs[${stateKey}] ?? ${defaultActiveTab}) === ${index}
                ? 'uagb-tabs__body-container uagb-tabs-body__active block'
                : 'uagb-tabs__body-container hidden'}
            >
              <div className="${panelGridClass} rounded-[28px] border border-black/10 bg-white/75 shadow-[0_24px_60px_rgba(15,23,42,0.08)]"${panelStyle}>
                <div className="flex flex-col gap-5">${headingPart}${bodyPart}${ctaPart}
                </div>${imagePart ? `\n                <div>${imagePart}\n                </div>` : ''}
              </div>
            </div>`;
      })
      .join('\n');

    return `
    <section className="w-full ${py} bg-[${bg}] text-[${tc}]"${sectionStyle}>
      <div className="${ctx.l.containerClass} px-4 sm:px-6">
        <div className="flex flex-col gap-6"${gapStyle}>${titlePart}
          <div className="uagb-tabs__wrap ${spectraVariantClass} ${tabsLayoutClass}">
            <div className="${tabListSurfaceClass}">
              <div className="uagb-tabs__panel ${spectraAlignClass} ${tabListClass}" role="tablist" aria-orientation="${isVertical ? 'vertical' : 'horizontal'}">
${tabButtons}
              </div>
            </div>
            <div className="uagb-tabs__body-wrap flex flex-col gap-4">
${panels}
            </div>
          </div>
        </div>
      </div>
    </section>`;
  }

  private renderAccordion(
    s: AccordionSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
    sectionIndex: number,
  ): string {
    const { t } = ctx;
    const stateKeyRaw = this.buildInteractiveSectionStateKey(s, sectionIndex);
    const stateKey = JSON.stringify(stateKeyRaw);
    const domKey = stateKeyRaw.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const defaultOpenItems = (s.defaultOpenItems ?? [])
      .filter((index) => index >= 0 && index < s.items.length)
      .filter((value, index, items) => items.indexOf(value) === index);
    const normalizedDefaultOpenItems = s.allowMultiple
      ? defaultOpenItems
      : defaultOpenItems.slice(0, 1);
    const defaultOpenLiteral = JSON.stringify(normalizedDefaultOpenItems);
    const openStateExpr = `openAccordions[${stateKey}] ?? ${defaultOpenLiteral}`;
    const variant = (s.variant ?? '').toLowerCase();
    const accordionLayoutClass = variant.includes('grid')
      ? 'uagb-faq-layout-grid'
      : 'uagb-faq-layout-accordion';
    const isBoxedVariant =
      variant.includes('boxed') ||
      variant.includes('card') ||
      variant.includes('style-2');
    const sectionStyle = this.buildSectionStyleAttr(s);
    const gapStyle = this.buildSectionGapStyleAttr(s);
    const titleStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const itemHeadingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'heading'),
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const itemBodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: tc },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const titlePart = s.title
      ? `\n          <h2 className="${t.h2} font-semibold"${titleStyle}>{${JSON.stringify(s.title)}}</h2>`
      : '';
    const items = s.items
      .map(
        (item, index) => `          <div
            key=${index}
            className="uagb-faq-child__outer-wrap"
          >
            <div
              id="${domKey}-item-${index}"
              className={((${openStateExpr}).includes(${index}))
                ? 'uagb-faq-item uagb-faq-item-active overflow-hidden rounded-[24px] border p-1 shadow-[0_20px_44px_rgba(15,23,42,0.08)]'
                : 'uagb-faq-item overflow-hidden rounded-[24px] border p-1'}
            style={{
              background: ((${openStateExpr}).includes(${index}))
                ? '${isBoxedVariant ? 'rgba(255,255,255,0.94)' : 'rgba(255,255,255,0.76)'}'
                : 'rgba(255,255,255,0.62)',
              borderColor: ((${openStateExpr}).includes(${index})) ? '${ctx.p.accent}' : 'rgba(15,23,42,0.10)',
            }}
          >
            <button
              type="button"
              onClick={() =>
                setOpenAccordions((prev) => {
                  const current = prev[${stateKey}] ?? ${defaultOpenLiteral};
                  const isOpen = current.includes(${index});
                  if (isOpen) {
                    if (${s.enableToggle === false ? 'false' : 'true'}) {
                      return {
                        ...prev,
                        [${stateKey}]: ${s.allowMultiple ? `current.filter((value) => value !== ${index})` : '[]'},
                      };
                    }
                    return prev;
                  }
                  if (${s.allowMultiple ? 'true' : 'false'}) {
                    return {
                      ...prev,
                      [${stateKey}]: [...current, ${index}],
                    };
                  }
                  return {
                    ...prev,
                    [${stateKey}]: [${index}],
                  };
                })
              }
              aria-expanded={((${openStateExpr}).includes(${index}))}
              aria-controls="${domKey}-panel-${index}"
              className="uagb-faq-questions-button uagb-faq-questions flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
              style={{ color: '${tc}' }}
            >
              <span className="${t.h3} font-semibold pr-4"${itemHeadingStyle}>{${JSON.stringify(item.heading)}}</span>
              <span
                className="uagb-faq-icon-wrap inline-flex h-10 w-10 items-center justify-center rounded-full transition-transform"
                style={{
                  background: ((${openStateExpr}).includes(${index})) ? '${ctx.p.accent}' : 'rgba(15,23,42,0.06)',
                  color: ((${openStateExpr}).includes(${index})) ? '${ctx.p.accentText}' : '${tc}',
                  transform: ((${openStateExpr}).includes(${index})) ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              >
                <span className={((${openStateExpr}).includes(${index})) ? 'uagb-icon-active' : 'uagb-icon'}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </span>
            </button>
            {((${openStateExpr}).includes(${index})) ? (
              <div id="${domKey}-panel-${index}" className="uagb-faq-content border-t border-black/10 px-5 pb-5 pt-1">
                <div className="${t.body} leading-7"${itemBodyStyle} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(item.body)} }} />
              </div>
            ) : null}
            </div>
          </div>`,
      )
      .join('\n');

    return `
    <section className="w-full ${py} bg-[${bg}] text-[${tc}]"${sectionStyle}>
      <div className="${this.contentContainerClass(ctx)} px-4 sm:px-6">
        <div className="wp-block-uagb-faq uagb-faq__wrap ${accordionLayoutClass} flex flex-col gap-4"${gapStyle}>${titlePart}
${items}
        </div>
      </div>
    </section>`;
  }

  private renderCarousel(
    s: CarouselSection,
    ctx: RenderCtx,
    bg: string,
    tc: string,
    py: string,
    sectionIndex: number,
  ): string {
    const { t, l } = ctx;
    const stateKeyRaw = this.buildInteractiveSectionStateKey(s, sectionIndex);
    const stateKey = JSON.stringify(stateKeyRaw);
    const domKey = stateKeyRaw.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const activeIndexExpr = `activeCarousels[${stateKey}] ?? 0`;
    const transitionSpeed = Math.max(250, s.transitionSpeed ?? 550);
    const effect = s.effect ?? 'slide';
    const useStackedSlides = effect === 'fade' || s.vertical === true;
    const pauseOnHover = s.pauseOn === 'hover';
    const pauseOnClick = s.pauseOn === 'click';
    const hasSlideImages = s.slides.some((slide) => !!slide.imageSrc);
    const enableSwipe = s.slides.length > 1;
    const clickPauseStatement = pauseOnClick
      ? `setHoveredCarousels((prev) => ({ ...prev, [${stateKey}]: true }));`
      : '';
    const showArrows = s.showArrows !== false && s.slides.length > 1;
    const showDots = s.showDots !== false && s.slides.length > 1;
    const sectionStyle = this.buildSectionStyleAttr(s);
    const slideSurfaceStyle = this.buildBlockStyleAttr(
      this.mergeBlockStyleTokens(
        this.pickBlockStyle(ctx, 'group'),
        this.pickBlockStyle(ctx, 'column'),
      ),
      { padding: l.cardPadding },
      true,
      ctx,
    );
    const imageStyle = this.pickBlockStyle(ctx, 'image', 'gallery');
    const imageRadius = this.imageRadiusClass(ctx) || this.cardRadiusClass(ctx);
    const headingStyle = this.buildTextTokenStyleAttr(
      ctx,
      { baseColor: hasSlideImages ? '#ffffff' : tc },
      this.pickBlockStyle(ctx, 'heading'),
    );
    const bodyStyle = this.buildTextTokenStyleAttr(
      ctx,
      {
        baseColor: hasSlideImages
          ? 'rgba(255,255,255,0.82)'
          : ctx.p.textMuted || tc,
      },
      this.pickBlockStyle(ctx, 'paragraph'),
    );
    const align =
      s.contentAlign === 'right'
        ? 'items-end text-right'
        : s.contentAlign === 'left'
          ? 'items-start text-left'
          : 'items-center text-center';
    const ctaAlign =
      s.contentAlign === 'right'
        ? 'self-end'
        : s.contentAlign === 'left'
          ? 'self-start'
          : 'self-center';
    const activeTransform =
      effect === 'flip'
        ? 'perspective(1400px) rotateY(0deg) scale(1)'
        : 'scale(1)';
    const inactiveTransform =
      effect === 'flip'
        ? 'perspective(1400px) rotateY(-14deg) scale(0.97)'
        : effect === 'coverflow'
          ? 'scale(1.04)'
          : 'scale(1.02)';

    const slides = s.slides
      .map((slide, i) => {
        const imgPart = slide.imageSrc
          ? `\n              <img src={resolveAsset(${JSON.stringify(slide.imageSrc)})} alt={${JSON.stringify(slide.imageAlt ?? '')}} className="absolute inset-0 h-full w-full object-cover ${imageRadius}"${this.buildBlockStyleAttr(imageStyle, {}, false, ctx)} />`
          : '';
        const headingPart = slide.heading
          ? `\n                  <h3 className="${t.h2} ${hasSlideImages ? 'max-w-[18ch] font-bold text-white' : 'font-bold'}"${headingStyle}>${slide.heading}</h3>`
          : '';
        const subPart = slide.subheading
          ? `\n                  <p className="${t.body} max-w-[60ch] ${hasSlideImages ? 'text-white/82' : ''}"${bodyStyle}>${slide.subheading}</p>`
          : '';
        const ctaPart = slide.cta
          ? `\n                  <a href={${JSON.stringify(slide.cta.link)}} className="${this.buildInteractiveCtaClassName(
              `inline-flex items-center justify-center ${ctx.t.buttonRadius} px-6 py-3 font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:opacity-90 ${ctaAlign}`,
              slide.cta,
            )}" data-carousel-control="true" style={{ background: '${ctx.p.accent}', color: '${ctx.p.accentText}' }}>${slide.cta.text}</a>`
          : '';
        const slideSurface = hasSlideImages
          ? `${imgPart}
              <div className="absolute inset-0 bg-gradient-to-r from-black/72 via-black/42 to-black/10" />
              <div className="relative z-10 flex h-full flex-col justify-end p-6 sm:p-10">
                <div className="flex max-w-[720px] flex-col gap-4 rounded-[28px] bg-black/20 backdrop-blur-[2px] ${align}"${slideSurfaceStyle}>${headingPart}${subPart}${ctaPart}
                </div>
              </div>`
          : `<div className="relative z-10 flex h-full flex-col items-center justify-center px-6 py-3 sm:px-10 sm:py-4">
                <div className="flex w-full max-w-[760px] flex-col gap-4 ${align}"${slideSurfaceStyle}>${headingPart}${subPart}${ctaPart}
                </div>
              </div>`;
        if (useStackedSlides) {
          return `          <article
            key={${i}}
            id="${domKey}-slide-${i}"
            aria-hidden={(${activeIndexExpr}) !== ${i}}
            className={(${activeIndexExpr}) === ${i}
              ? 'swiper-slide absolute inset-0 z-10 overflow-hidden ${imageRadius}'
              : 'swiper-slide absolute inset-0 overflow-hidden ${imageRadius} pointer-events-none'}
            style={{
              opacity: (${activeIndexExpr}) === ${i} ? 1 : 0,
              transform: (${activeIndexExpr}) === ${i} ? '${activeTransform}' : '${inactiveTransform}',
              transitionDuration: '${transitionSpeed}ms',
            }}
          >
${slideSurface}
          </article>`;
        }
        return `          <article key={${i}} id="${domKey}-slide-${i}" className="swiper-slide relative h-full w-full shrink-0 grow-0 basis-full overflow-hidden ${imageRadius}">
${slideSurface}
          </article>`;
      })
      .join('\n');

    const previousHandler = `() => {
      ${clickPauseStatement}
      setActiveCarousels((prev) => {
        const current = prev[${stateKey}] ?? 0;
        if (current <= 0) {
          return ${s.loop === false ? 'prev' : `{ ...prev, [${stateKey}]: ${Math.max(s.slides.length - 1, 0)} }`};
        }
        return { ...prev, [${stateKey}]: current - 1 };
      });
    }`;
    const nextHandler = `() => {
      ${clickPauseStatement}
      setActiveCarousels((prev) => {
        const current = prev[${stateKey}] ?? 0;
        if (current >= ${Math.max(s.slides.length - 1, 0)}) {
          return ${s.loop === false ? 'prev' : `{ ...prev, [${stateKey}]: 0 }`};
        }
        return { ...prev, [${stateKey}]: current + 1 };
      });
    }`;
    const pointerDownHandler = `(event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (isCarouselInteractiveTarget(event.target)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      beginCarouselDrag(${stateKey}, event.pointerId, event.clientX);
    }`;
    const pointerMoveHandler = `(event: React.PointerEvent<HTMLDivElement>) => {
      updateCarouselDrag(${stateKey}, event.pointerId, event.clientX);
    }`;
    const pointerUpHandler = `(event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishCarouselDrag(${stateKey}, event.pointerId, ${nextHandler}, ${previousHandler});
    }`;
    const pointerCancelHandler = `(event: React.PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cancelCarouselDrag(${stateKey}, event.pointerId);
    }`;
    const dots = showDots
      ? s.slides
          .map(
            (_, i) => `            <button
              key={${i}}
              type="button"
              aria-label="Go to slide ${i + 1}"
              onClick={() => {
                ${clickPauseStatement}
                setActiveCarousels((prev) => ({ ...prev, [${stateKey}]: ${i} }));
              }}
              data-carousel-control="true"
              className={(${activeIndexExpr}) === ${i}
                ? 'swiper-pagination-bullet swiper-pagination-bullet-active h-2.5 w-8 rounded-full transition-all duration-200 hover:scale-110 hover:opacity-100'
                : 'swiper-pagination-bullet h-2.5 w-2.5 rounded-full opacity-80 transition-all duration-200 hover:scale-110 hover:opacity-100'}
              style={{
                background: (${activeIndexExpr}) === ${i}
                  ? '${ctx.p.accent}'
                  : '${hasSlideImages ? 'rgba(255,255,255,0.5)' : 'rgba(17,17,17,0.24)'}',
              }}
            />`,
          )
          .join('\n')
      : '';

    return `
    <section className="w-full ${py} overflow-hidden bg-[${bg}] text-[${tc}]"${sectionStyle}>
      <div className="${hasSlideImages ? ctx.l.containerClass : 'max-w-[920px] mx-auto w-full'} px-4 sm:px-6">
        <div
          className="uagb-slider-container uagb-swiper relative"
          onMouseEnter={${pauseOnHover ? `() => setHoveredCarousels((prev) => ({ ...prev, [${stateKey}]: true }))` : 'undefined'}}
          onMouseLeave={${pauseOnHover ? `() => setHoveredCarousels((prev) => ({ ...prev, [${stateKey}]: false }))` : 'undefined'}}
        >
          <div
            className="${hasSlideImages ? 'swiper relative min-h-[420px] overflow-hidden rounded-[32px] bg-slate-900 shadow-[0_28px_80px_rgba(15,23,42,0.18)]' : 'swiper relative min-h-[220px] overflow-visible'}${enableSwipe ? ' select-none cursor-grab active:cursor-grabbing' : ''}"
            style={${enableSwipe ? `{ touchAction: 'pan-y' }` : 'undefined'}}
            onPointerDown={${enableSwipe ? pointerDownHandler : 'undefined'}}
            onPointerMove={${enableSwipe ? pointerMoveHandler : 'undefined'}}
            onPointerUp={${enableSwipe ? pointerUpHandler : 'undefined'}}
            onPointerCancel={${enableSwipe ? pointerCancelHandler : 'undefined'}}
          >
            ${
              useStackedSlides
                ? slides
                : `<div
              className="swiper-wrapper flex h-full transition-transform ease-out"
              style={{
                transform: 'translateX(-' + ((${activeIndexExpr}) * 100) + '%)',
                transitionDuration: '${transitionSpeed}ms',
              }}
            >
${slides}
            </div>`
            }
          </div>
          ${
            showArrows
              ? `<div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 flex -translate-y-1/2 items-center justify-between px-3 sm:px-5">
            <button
              type="button"
              aria-label="Previous slide"
              data-carousel-control="true"
              onClick={${previousHandler}}
              className="swiper-button-prev pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 hover:opacity-90 hover:-translate-y-0.5 ${hasSlideImages ? 'border border-white/20 bg-black/35 text-white backdrop-blur-sm' : 'border border-black/10 bg-white/95 text-[#111111] shadow-[0_10px_24px_rgba(15,23,42,0.12)]'}"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Next slide"
              data-carousel-control="true"
              onClick={${nextHandler}}
              className="swiper-button-next pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 hover:opacity-90 hover:-translate-y-0.5 ${hasSlideImages ? 'border border-white/20 bg-black/35 text-white backdrop-blur-sm' : 'border border-black/10 bg-white/95 text-[#111111] shadow-[0_10px_24px_rgba(15,23,42,0.12)]'}"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>`
              : ''
          }
          ${
            showDots
              ? `<div className="swiper-pagination swiper-pagination-bullets absolute inset-x-0 bottom-5 z-20 flex items-center justify-center gap-2">
${dots}
          </div>`
              : ''
          }
        </div>
      </div>
    </section>`;
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
  FOOTER_COLUMN_INTERFACE,
].join('\n\n');
