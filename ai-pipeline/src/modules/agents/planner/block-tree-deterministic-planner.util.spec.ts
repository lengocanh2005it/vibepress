import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import {
  buildBlockTreeDrivenVisualPlanForComponent,
  shouldUseAiVisualPlanningForProfolioSurface,
  shouldShortCircuitBlockTreeVisualPlan,
} from './block-tree-deterministic-planner.util.js';
import {
  getVisualPlanRenderAuthority,
  type ComponentVisualPlan,
} from '../react-generator/visual-plan.schema.js';

describe('block-tree deterministic listing shells', () => {
  const componentPlan = {
    templateName: 'blog-right-sidebar',
    componentName: 'BlogRightSidebar',
    type: 'page' as const,
    route: '/blog-right-sidebar',
    dataNeeds: ['posts'],
    isDetail: false,
  };

  const draftBlockTree: BlockNode[] = [
    {
      kind: 'cover',
      blockName: 'cover',
      sourceRef: {
        sourceNodeId: 'blog-right-sidebar::cover::2',
        templateName: 'blog-right-sidebar',
        sourceFile: 'templates/blog-right-sidebar.html',
        topLevelIndex: 2,
        blockName: 'cover',
      },
    },
    {
      kind: 'columns',
      blockName: 'columns',
      sourceRef: {
        sourceNodeId: 'blog-right-sidebar::columns::3.0',
        templateName: 'blog-right-sidebar',
        sourceFile: 'templates/blog-right-sidebar.html',
        topLevelIndex: 3,
        blockName: 'columns',
      },
      children: [
        {
          kind: 'column',
          blockName: 'column',
          sourceRef: {
            sourceNodeId: 'blog-right-sidebar::column::3.0.0',
            templateName: 'blog-right-sidebar',
            sourceFile: 'templates/blog-right-sidebar.html',
            topLevelIndex: 3,
            parentSourceNodeId: 'blog-right-sidebar::columns::3.0',
            blockName: 'column',
          },
          children: [
            {
              kind: 'query',
              blockName: 'query',
              sourceRef: {
                sourceNodeId: 'blog-right-sidebar::query::3.0.0.0',
                templateName: 'blog-right-sidebar',
                sourceFile: 'templates/blog-right-sidebar.html',
                topLevelIndex: 3,
                parentSourceNodeId: 'blog-right-sidebar::column::3.0.0',
                blockName: 'query',
              },
            },
          ],
        },
        {
          kind: 'column',
          blockName: 'column',
          columnWidth: '320px',
          sourceRef: {
            sourceNodeId: 'blog-right-sidebar::column::3.0.1',
            templateName: 'blog-right-sidebar',
            sourceFile: 'templates/blog-right-sidebar.html',
            topLevelIndex: 3,
            parentSourceNodeId: 'blog-right-sidebar::columns::3.0',
            blockName: 'column',
          },
          children: [
            {
              kind: 'template-part',
              blockName: 'template-part',
              templatePartSlug: 'sidebar',
              sourceRef: {
                sourceNodeId: 'blog-right-sidebar::template-part::3.0.1.0',
                templateName: 'blog-right-sidebar',
                sourceFile: 'templates/blog-right-sidebar.html',
                topLevelIndex: 3,
                parentSourceNodeId: 'blog-right-sidebar::column::3.0.1',
                blockName: 'template-part',
              },
              children: [
                {
                  kind: 'search',
                  blockName: 'search',
                },
                {
                  kind: 'latest-posts',
                  blockName: 'latest-posts',
                },
                {
                  kind: 'categories',
                  blockName: 'categories',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const draftSections: ComponentVisualPlan['sections'] = [
    {
      type: 'cover',
      imageSrc: 'theme-asset:/assets/images/banner.jpg',
      dimRatio: 80,
      minHeight: '250px',
      sourceRef: {
        sourceNodeId: 'blog-right-sidebar::cover::2',
        templateName: 'blog-right-sidebar',
        sourceFile: 'templates/blog-right-sidebar.html',
        topLevelIndex: 2,
        blockName: 'cover',
      },
    },
    {
      type: 'post-list',
      layout: 'list',
      showDate: true,
      showAuthor: true,
      showCategory: false,
      showExcerpt: true,
      showFeaturedImage: true,
      sourceRef: {
        sourceNodeId: 'blog-right-sidebar::query::3.0.0.0',
        templateName: 'blog-right-sidebar',
        sourceFile: 'templates/blog-right-sidebar.html',
        topLevelIndex: 3,
        parentSourceNodeId: 'blog-right-sidebar::column::3.0.0',
        blockName: 'query',
      },
    },
  ];

  const baseInput = {
    componentPlan,
    draftSections,
    draftBlockTree,
    content: {
      menus: [],
      pages: [],
      posts: [],
    } as any,
    tokens: undefined,
    globalPalette: {
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111',
      textMuted: '#666666',
      accent: '#000000',
      accentText: '#ffffff',
      dark: '#000000',
      darkText: '#ffffff',
    },
    globalTypography: {
      headingFamily: 'inherit',
      bodyFamily: 'inherit',
      h1: 'text-4xl',
      h2: 'text-3xl',
      h3: 'text-2xl',
      body: 'text-base',
      small: 'text-sm',
      buttonRadius: 'rounded',
    },
    deriveComponentLayout: () => ({
      containerClass: 'max-w-6xl mx-auto w-full',
      blockGap: 'gap-12',
      includes: [],
    }),
    buildRichBoundPageDetailSections: () => undefined,
    buildBoundPageContentFallbackSection: () => ({
      type: 'page-content' as const,
      showTitle: true,
    }),
  };

  it('short-circuits custom blog listing templates with a real sidebar shell', () => {
    expect(
      shouldShortCircuitBlockTreeVisualPlan(componentPlan, draftBlockTree),
    ).toBe(true);
  });

  it('builds a deterministic listing visual plan with sidebar layout', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent(baseInput);

    expect(plan).toBeDefined();
    expect(plan?.sections.map((section) => section.type)).toEqual([
      'cover',
      'post-list',
      'sidebar',
    ]);
    expect(plan?.layout.contentLayout).toBe('sidebar-right');
    expect(plan?.layout.sidebarScope).toBe('all-content');
  });

  it('synthesizes the lead cover from block-tree evidence when draft sections omit it', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...baseInput,
      draftSections: [
        {
          type: 'post-list',
          layout: 'list',
          showDate: true,
          showAuthor: true,
          showCategory: false,
          showExcerpt: true,
          showFeaturedImage: true,
          sourceRef: {
            sourceNodeId: 'blog-right-sidebar::query::3.0.0.0',
            templateName: 'blog-right-sidebar',
            sourceFile: 'templates/blog-right-sidebar.html',
            topLevelIndex: 3,
            parentSourceNodeId: 'blog-right-sidebar::column::3.0.0',
            blockName: 'query',
          },
        },
      ] as ComponentVisualPlan['sections'],
      draftBlockTree: [
        {
          ...draftBlockTree[0],
          src: 'theme-asset:/assets/images/banner.jpg',
          attrs: { dimRatio: 80 },
          minHeight: '250px',
          overlayColor: '#000',
          textAlign: 'center',
          children: [
            {
              kind: 'heading',
              blockName: 'heading',
              text: 'News',
              sourceRef: {
                sourceNodeId: 'blog-right-sidebar::heading::2.0',
                templateName: 'blog-right-sidebar',
                sourceFile: 'templates/blog-right-sidebar.html',
                topLevelIndex: 2,
                parentSourceNodeId: 'blog-right-sidebar::cover::2',
                blockName: 'heading',
              },
            },
          ],
        },
        draftBlockTree[1],
      ] as BlockNode[],
    });

    expect(plan?.sections[0]).toMatchObject({
      type: 'cover',
      heading: 'News',
      imageSrc: 'theme-asset:/assets/images/banner.jpg',
    });
  });

  it('uses standalone sticky-sidebar content when the sidebar template-part shell is empty', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...baseInput,
      draftBlockTree: [
        draftBlockTree[0],
        {
          kind: 'columns',
          blockName: 'columns',
          children: [
            {
              kind: 'column',
              blockName: 'column',
              children: [
                {
                  kind: 'query',
                  blockName: 'query',
                  sourceRef: {
                    sourceNodeId: 'blog-right-sidebar::query::3.0.0.0',
                    templateName: 'blog-right-sidebar',
                    sourceFile: 'templates/blog-right-sidebar.html',
                    topLevelIndex: 3,
                    parentSourceNodeId: 'blog-right-sidebar::column::3.0.0',
                    blockName: 'query',
                  },
                },
              ],
            },
            {
              kind: 'column',
              blockName: 'column',
              columnWidth: '320px',
              sourceRef: {
                sourceNodeId: 'blog-right-sidebar::column::3.0.1',
                templateName: 'blog-right-sidebar',
                sourceFile: 'templates/blog-right-sidebar.html',
                topLevelIndex: 3,
                parentSourceNodeId: 'blog-right-sidebar::columns::3.0',
                blockName: 'column',
              },
              children: [
                {
                  kind: 'template-part',
                  blockName: 'template-part',
                  templatePartSlug: 'sidebar',
                },
              ],
            },
          ],
        },
        {
          kind: 'group',
          blockName: 'group',
          customClassNames: ['sticky-sidebar'],
          children: [
            {
              kind: 'group',
              blockName: 'group',
              children: [{ kind: 'search', blockName: 'search' }],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Latest Posts' },
                { kind: 'latest-posts', blockName: 'latest-posts' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Categories' },
                { kind: 'categories', blockName: 'categories' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Tags' },
                { kind: 'tag-cloud', blockName: 'tag-cloud' },
              ],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections.map((section) => section.type)).toEqual([
      'cover',
      'post-list',
      'sidebar',
    ]);
    expect(plan?.sections[2]).toMatchObject({
      type: 'sidebar',
      widgets: [
        { kind: 'search' },
        { kind: 'recent-posts', title: 'Latest Posts' },
        { kind: 'categories', title: 'Categories' },
        { kind: 'tags', title: 'Tags' },
      ],
    });
  });
});

describe('block-tree deterministic shared partials', () => {
  const sharedBaseInput = {
    content: {
      menus: [],
      pages: [],
      posts: [],
    } as any,
    tokens: undefined,
    globalPalette: {
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111',
      textMuted: '#666666',
      accent: '#000000',
      accentText: '#ffffff',
      dark: '#000000',
      darkText: '#ffffff',
    },
    globalTypography: {
      headingFamily: 'inherit',
      bodyFamily: 'inherit',
      h1: 'text-4xl',
      h2: 'text-3xl',
      h3: 'text-2xl',
      body: 'text-base',
      small: 'text-sm',
      buttonRadius: 'rounded',
    },
    deriveComponentLayout: () => ({
      containerClass: 'max-w-6xl mx-auto w-full',
      blockGap: 'gap-12',
      includes: [],
    }),
    buildRichBoundPageDetailSections: () => undefined,
    buildBoundPageContentFallbackSection: () => ({
      type: 'page-content' as const,
      showTitle: true,
    }),
  };

  it('keeps search widgets inside deterministic sidebar partial sections', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'sidebar',
        componentName: 'Sidebar',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['posts'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          children: [
            { kind: 'search', blockName: 'search' },
            { kind: 'latest-posts', blockName: 'latest-posts' },
            { kind: 'categories', blockName: 'categories' },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toHaveLength(1);
    expect(plan?.sections[0]).toMatchObject({
      type: 'sidebar',
      widgets: [
        { kind: 'search' },
        { kind: 'recent-posts' },
        { kind: 'categories' },
      ],
    });
  });

  it('pixel-locks deterministic sidebar partials when tag-cloud is the only remaining rich widget kind', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'sidebar',
        componentName: 'Sidebar',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['posts'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          customClassNames: ['sticky-sidebar'],
          children: [
            {
              kind: 'group',
              blockName: 'group',
              children: [{ kind: 'search', blockName: 'search' }],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Tags' },
                { kind: 'tag-cloud', blockName: 'tag-cloud' },
              ],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.renderMode).toBe('block-centric');
    expect(getVisualPlanRenderAuthority(plan)).toBe('deterministic-pixel');
    expect(plan?.lockPolicy?.bypassAiGeneration).toBe(true);
    expect(plan?.lockPolicy?.reason).not.toContain('unsupported block kind');
  });

  it('derives header logo/title visibility and CTA from the shared partial block tree', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'header',
        componentName: 'Header',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['site-info', 'menus'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          domId: 'sticky-header',
          children: [
            {
              kind: 'site-title',
              blockName: 'site-title',
            },
            {
              kind: 'navigation',
              blockName: 'navigation',
              menuOrientation: 'horizontal',
              overlayMenu: 'mobile',
              isResponsive: true,
            },
            {
              kind: 'button',
              blockName: 'button',
              text: 'Get Started',
              href: '#',
              bgColor: '#F5B731',
              padding: {
                top: '10px',
                right: '20px',
                bottom: '10px',
                left: '20px',
              },
              customClassNames: ['is-style-fill'],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toHaveLength(1);
    expect(plan?.sections[0]).toMatchObject({
      type: 'navbar',
      sticky: true,
      domId: 'sticky-header',
      showSiteLogo: false,
      showSiteTitle: true,
      cta: {
        text: 'Get Started',
        link: '#',
        style: 'button',
      },
      ctaStyle: {
        background: '#F5B731',
        padding: '10px 20px',
      },
    });
  });

  it('preserves explicit site logo width in deterministic header partial sections', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'header',
        componentName: 'Header',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['site-info', 'menus'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          children: [
            {
              kind: 'site-logo',
              blockName: 'site-logo',
              width: 60,
            },
            {
              kind: 'site-title',
              blockName: 'site-title',
            },
            {
              kind: 'navigation',
              blockName: 'navigation',
              menuOrientation: 'horizontal',
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toHaveLength(1);
    expect(plan?.sections[0]).toMatchObject({
      type: 'navbar',
      showSiteLogo: true,
      showSiteTitle: true,
      logoWidth: '60px',
    });
  });

  it('keeps static footer images in deterministic footer partial sections', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          children: [
            {
              kind: 'columns',
              blockName: 'columns',
              children: [
                { kind: 'column', blockName: 'column', columnWidth: '45%' },
              ],
            },
            {
              kind: 'image',
              blockName: 'image',
              src: 'theme-asset:/assets/images/arrow-up.png',
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toHaveLength(1);
    expect(plan?.sections[0]).toMatchObject({
      type: 'footer',
      supplementalImages: [
        {
          src: 'theme-asset:/assets/images/arrow-up.png',
        },
      ],
    });
  });

  it('keeps profolio-fse scroll-top hook classes in deterministic footer partial sections', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
      },
      draftSections: [
        {
          type: 'footer',
          menuColumns: [],
        },
      ],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          children: [
            {
              kind: 'paragraph',
              blockName: 'paragraph',
              customClassNames: ['profolio-fse-scroll-top'],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections[0]).toMatchObject({
      type: 'footer',
      scrollTopTriggerClassNames: ['profolio-fse-scroll-top'],
    });
  });

  it('keeps marketing-heavy footers on the deterministic block-tree path', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...sharedBaseInput,
      componentPlan: {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'group',
          blockName: 'group',
          children: [
            {
              kind: 'heading',
              blockName: 'heading',
              text: "Let's Work Together",
            },
            {
              kind: 'paragraph',
              blockName: 'paragraph',
              text: 'Marketing footer intro',
            },
            {
              kind: 'social-links',
              blockName: 'social-links',
              children: [
                {
                  kind: 'social-link',
                  blockName: 'social-link',
                  href: '#',
                  text: 'Facebook',
                },
              ],
            },
            {
              kind: 'button',
              blockName: 'button',
              text: 'Contact',
              href: '#',
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.renderMode).toBe('block-centric');
    expect(plan?.sections[0]).toMatchObject({
      type: 'footer',
    });
  });
});

describe('block-tree canonical profolio pages', () => {
  const profolioBaseInput = {
    content: {
      menus: [],
      pages: [],
      posts: [],
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
      },
    } as any,
    tokens: undefined,
    globalPalette: {
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111',
      textMuted: '#666666',
      accent: '#000000',
      accentText: '#ffffff',
      dark: '#000000',
      darkText: '#ffffff',
    },
    globalTypography: {
      headingFamily: 'inherit',
      bodyFamily: 'inherit',
      h1: 'text-4xl',
      h2: 'text-3xl',
      h3: 'text-2xl',
      body: 'text-base',
      small: 'text-sm',
      buttonRadius: 'rounded',
    },
    deriveComponentLayout: () => ({
      containerClass: 'max-w-6xl mx-auto w-full',
      blockGap: 'gap-12',
      includes: [],
    }),
    buildRichBoundPageDetailSections: () => undefined,
    buildBoundPageContentFallbackSection: () => ({
      type: 'page-content' as const,
      showTitle: true,
    }),
  };

  it('routes only profolio marketing templates through locked AI visual planning', () => {
    for (const componentPlan of [
      {
        templateName: 'front-page',
        componentName: 'FrontPage',
        type: 'page' as const,
        route: '/',
        dataNeeds: [],
        isDetail: false,
      },
      {
        templateName: 'template-services',
        componentName: 'TemplateServices',
        type: 'page' as const,
        route: '/template-services',
        dataNeeds: ['posts'],
        isDetail: false,
      },
      {
        templateName: 'template-about',
        componentName: 'TemplateAbout',
        type: 'page' as const,
        route: '/template-about',
        dataNeeds: [],
        isDetail: false,
      },
      {
        templateName: 'template-contact',
        componentName: 'TemplateContact',
        type: 'page' as const,
        route: '/template-contact',
        dataNeeds: [],
        isDetail: false,
      },
    ]) {
      expect(
        shouldUseAiVisualPlanningForProfolioSurface({
          componentPlan,
          content: profolioBaseInput.content,
        }),
      ).toBe(true);
    }

    for (const componentPlan of [
      {
        templateName: 'blog-left-sidebar',
        componentName: 'BlogLeftSidebar',
        type: 'page' as const,
        route: '/blog-left-sidebar',
        dataNeeds: ['posts'],
        isDetail: false,
      },
      {
        templateName: 'search',
        componentName: 'Search',
        type: 'page' as const,
        route: '/search',
        dataNeeds: ['posts'],
        isDetail: false,
      },
      {
        templateName: 'archive-product',
        componentName: 'ArchiveProduct',
        type: 'page' as const,
        route: '/products',
        dataNeeds: ['products'],
        isDetail: false,
      },
    ]) {
      expect(
        shouldUseAiVisualPlanningForProfolioSurface({
          componentPlan,
          content: profolioBaseInput.content,
        }),
      ).toBe(false);
    }
  });

  it('keeps profolio chrome, commerce, and detail templates on deterministic planning', () => {
    for (const componentPlan of [
      {
        templateName: 'header',
        componentName: 'Header',
        type: 'partial' as const,
        route: null,
        dataNeeds: ['menus', 'site-info'],
        isDetail: false,
      },
      {
        templateName: 'checkout',
        componentName: 'Checkout',
        type: 'page' as const,
        route: '/checkout',
        dataNeeds: [],
        isDetail: false,
      },
      {
        templateName: 'single-product',
        componentName: 'SingleProduct',
        type: 'page' as const,
        route: '/product/:slug',
        dataNeeds: ['product-detail'],
        isDetail: true,
      },
    ]) {
      expect(
        shouldUseAiVisualPlanningForProfolioSurface({
          componentPlan,
          content: profolioBaseInput.content,
        }),
      ).toBe(false);
    }
  });

  it('declares profolio FrontPage as an AI-locked visual-plan surface before block-tree generation', () => {
    expect(
      shouldUseAiVisualPlanningForProfolioSurface({
        componentPlan: {
          templateName: 'front-page',
          componentName: 'FrontPage',
          type: 'page' as const,
          route: '/',
          dataNeeds: [],
          isDetail: false,
        },
        content: profolioBaseInput.content,
      }),
    ).toBe(true);
  });

  it('locks profolio Archive to block-centric rendering when query blocks are supported', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...profolioBaseInput,
      componentPlan: {
        templateName: 'archive',
        componentName: 'Archive',
        type: 'page' as const,
        route: '/archive',
        dataNeeds: ['posts'],
        isDetail: false,
      },
      draftSections: [
        {
          type: 'post-list',
          resource: 'posts',
          title: 'Latest Posts',
        },
      ] as ComponentVisualPlan['sections'],
      draftBlockTree: [
        {
          kind: 'query',
          blockName: 'query',
          children: [
            {
              kind: 'post-template',
              blockName: 'post-template',
              customClassNames: ['products-block-post-template'],
              children: [
                { kind: 'post-title', blockName: 'post-title' },
                { kind: 'post-excerpt', blockName: 'post-excerpt' },
              ],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.renderMode).toBe('block-centric');
    expect(getVisualPlanRenderAuthority(plan)).toBe('deterministic-pixel');
    expect(plan?.lockPolicy?.bypassAiGeneration).toBe(true);
    expect(plan?.sections).toEqual([
      expect.objectContaining({
        type: 'post-list',
        title: 'Latest Posts',
        customClassNames: ['products-block-post-template'],
      }),
    ]);
  });

  it('carries post-template custom classes into fallback post-list sections', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...profolioBaseInput,
      componentPlan: {
        templateName: 'archive-product',
        componentName: 'ArchiveProduct',
        type: 'page' as const,
        route: '/shop',
        dataNeeds: ['products'],
        isDetail: false,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'query',
          blockName: 'query',
          children: [
            {
              kind: 'post-template',
              blockName: 'post-template',
              customClassNames: [
                'products-block-post-template',
                ' products-block-post-template ',
              ],
              children: [
                {
                  kind: 'product-image',
                  blockName: 'woocommerce/product-image',
                },
                {
                  kind: 'product-price',
                  blockName: 'woocommerce/product-price',
                },
              ],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toEqual([
      expect.objectContaining({
        type: 'post-list',
        resource: 'products',
        customClassNames: ['products-block-post-template'],
      }),
    ]);
  });
});

describe('block-tree deterministic post detail terms', () => {
  const detailBaseInput = {
    content: {
      menus: [],
      pages: [],
      posts: [],
    } as any,
    tokens: undefined,
    globalPalette: {
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111',
      textMuted: '#666666',
      accent: '#000000',
      accentText: '#ffffff',
      dark: '#000000',
      darkText: '#ffffff',
    },
    globalTypography: {
      headingFamily: 'inherit',
      bodyFamily: 'inherit',
      h1: 'text-4xl',
      h2: 'text-3xl',
      h3: 'text-2xl',
      body: 'text-base',
      small: 'text-sm',
      buttonRadius: 'rounded',
    },
    deriveComponentLayout: () => ({
      containerClass: 'max-w-6xl mx-auto w-full',
      blockGap: 'gap-12',
      includes: [],
    }),
    buildRichBoundPageDetailSections: () => undefined,
    buildBoundPageContentFallbackSection: () => ({
      type: 'page-content' as const,
      showTitle: true,
    }),
  };

  it('preserves separate product category and tag term blocks without folding categories into post-content', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...detailBaseInput,
      componentPlan: {
        templateName: 'single',
        componentName: 'SingleProductLike',
        type: 'page' as const,
        route: '/single-product-like',
        dataNeeds: ['post-detail'],
        isDetail: true,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'post-title',
          blockName: 'post-title',
        },
        {
          kind: 'post-content',
          blockName: 'post-content',
        },
        {
          kind: 'post-terms',
          blockName: 'post-terms',
          attrs: {
            term: 'product_cat',
            prefix: 'Category: ',
          },
        },
        {
          kind: 'post-terms',
          blockName: 'post-terms',
          attrs: {
            term: 'product_tag',
            prefix: 'Tags: ',
          },
        },
      ] as BlockNode[],
    });

    expect(plan?.sections).toMatchObject([
      {
        type: 'post-title',
      },
      {
        type: 'post-content',
        showCategories: false,
      },
      {
        type: 'post-terms',
        taxonomy: 'category',
      },
      {
        type: 'post-terms',
        taxonomy: 'post_tag',
      },
    ]);
  });

  it('short-circuits Woo single-product templates and preserves related products as a products post-list', () => {
    const componentPlan = {
      templateName: 'single-product',
      componentName: 'SingleProduct',
      type: 'page' as const,
      route: '/product/:slug',
      dataNeeds: ['product-detail', 'products'],
      isDetail: true,
    };

    const draftSections: ComponentVisualPlan['sections'] = [
      {
        type: 'cover',
        imageSrc: 'theme-asset:/assets/images/banner.jpg',
        dimRatio: 90,
        minHeight: '232px',
        contentAlign: 'center',
        sourceRef: {
          sourceNodeId: 'single-product::cover::0',
          templateName: 'single-product',
          sourceFile: 'patterns/single-product.php',
          topLevelIndex: 0,
          blockName: 'cover',
        },
      },
      {
        type: 'breadcrumb',
        sourceRef: {
          sourceNodeId: 'single-product::breadcrumbs::0.2.0',
          templateName: 'single-product',
          sourceFile: 'patterns/single-product.php',
          topLevelIndex: 0,
          parentSourceNodeId: 'single-product::group::0.2',
          blockName: 'woocommerce/breadcrumbs',
        },
      },
      {
        type: 'post-list',
        resource: 'products',
        title: 'Related Products',
        layout: 'grid-3',
        showDate: false,
        showAuthor: false,
        showCategory: false,
        showExcerpt: false,
        showFeaturedImage: true,
        showPrice: true,
        showButton: true,
        sourceRef: {
          sourceNodeId: 'single-product::query::1.1.2.0',
          templateName: 'single-product',
          sourceFile: 'patterns/single-product.php',
          topLevelIndex: 1,
          parentSourceNodeId: 'single-product::related-products::1.1.2',
          blockName: 'query',
        },
      },
    ];

    const draftBlockTree: BlockNode[] = [
      {
        kind: 'cover',
        blockName: 'cover',
        sourceRef: {
          sourceNodeId: 'single-product::cover::0',
          templateName: 'single-product',
          sourceFile: 'patterns/single-product.php',
          topLevelIndex: 0,
          blockName: 'cover',
        },
        children: [
          {
            kind: 'breadcrumbs',
            blockName: 'woocommerce/breadcrumbs',
            sourceRef: {
              sourceNodeId: 'single-product::breadcrumbs::0.2.0',
              templateName: 'single-product',
              sourceFile: 'patterns/single-product.php',
              topLevelIndex: 0,
              parentSourceNodeId: 'single-product::group::0.2',
              blockName: 'woocommerce/breadcrumbs',
            },
          },
        ],
      },
      {
        kind: 'group',
        blockName: 'group',
        children: [
          {
            kind: 'columns',
            blockName: 'columns',
            children: [
              {
                kind: 'column',
                blockName: 'column',
                children: [
                  {
                    kind: 'product-image-gallery',
                    blockName: 'woocommerce/product-image-gallery',
                  },
                ],
              },
              {
                kind: 'column',
                blockName: 'column',
                children: [
                  {
                    kind: 'post-title',
                    blockName: 'post-title',
                  },
                  {
                    kind: 'post-excerpt',
                    blockName: 'post-excerpt',
                  },
                  {
                    kind: 'product-meta',
                    blockName: 'woocommerce/product-meta',
                    children: [
                      {
                        kind: 'post-terms',
                        blockName: 'post-terms',
                        attrs: {
                          term: 'product_cat',
                          prefix: 'Category: ',
                        },
                      },
                      {
                        kind: 'post-terms',
                        blockName: 'post-terms',
                        attrs: {
                          term: 'product_tag',
                          prefix: 'Tags: ',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            kind: 'product-details',
            blockName: 'woocommerce/product-details',
          },
          {
            kind: 'related-products',
            blockName: 'woocommerce/related-products',
            children: [
              {
                kind: 'query',
                blockName: 'query',
                sourceRef: {
                  sourceNodeId: 'single-product::query::1.1.2.0',
                  templateName: 'single-product',
                  sourceFile: 'patterns/single-product.php',
                  topLevelIndex: 1,
                  parentSourceNodeId: 'single-product::related-products::1.1.2',
                  blockName: 'query',
                },
              },
            ],
          },
        ],
      },
    ];

    expect(
      shouldShortCircuitBlockTreeVisualPlan(componentPlan, draftBlockTree),
    ).toBe(true);

    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...detailBaseInput,
      componentPlan,
      draftSections,
      draftBlockTree,
    });

    expect(plan?.sections).toMatchObject([
      { type: 'cover' },
      { type: 'breadcrumb' },
      { type: 'post-title' },
      { type: 'post-content', showTitle: false },
      { type: 'post-terms', taxonomy: 'category' },
      { type: 'post-terms', taxonomy: 'post_tag' },
      {
        type: 'post-list',
        resource: 'products',
        title: 'Related Products',
        showFeaturedImage: true,
        showPrice: true,
        showButton: true,
      },
    ]);
  });

  it('promotes standalone sticky-sidebar widgets into the deterministic single-post plan', () => {
    const plan = buildBlockTreeDrivenVisualPlanForComponent({
      ...detailBaseInput,
      componentPlan: {
        templateName: 'single',
        componentName: 'Single',
        type: 'page' as const,
        route: '/post/:slug',
        dataNeeds: ['post-detail'],
        isDetail: true,
      },
      draftSections: [],
      draftBlockTree: [
        {
          kind: 'cover',
          blockName: 'cover',
          src: 'theme-asset:/assets/images/banner.jpg',
          children: [{ kind: 'post-title', blockName: 'post-title' }],
        },
        {
          kind: 'group',
          blockName: 'group',
          children: [{ kind: 'post-content', blockName: 'post-content' }],
        },
        {
          kind: 'group',
          blockName: 'group',
          customClassNames: ['sticky-sidebar'],
          children: [
            {
              kind: 'group',
              blockName: 'group',
              children: [{ kind: 'search', blockName: 'search' }],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Latest Posts' },
                { kind: 'latest-posts', blockName: 'latest-posts' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Categories' },
                { kind: 'categories', blockName: 'categories' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Tags' },
                { kind: 'tag-cloud', blockName: 'tag-cloud' },
              ],
            },
          ],
        },
      ] as BlockNode[],
    });

    expect(plan?.sections.map((section) => section.type)).toEqual([
      'post-title',
      'post-content',
      'sidebar',
    ]);
    expect(plan?.sections[2]).toMatchObject({
      type: 'sidebar',
      widgets: [
        { kind: 'search' },
        { kind: 'recent-posts', title: 'Latest Posts' },
        { kind: 'categories', title: 'Categories' },
        { kind: 'tags', title: 'Tags' },
      ],
    });
    expect(plan?.layout.contentLayout).toBe('sidebar-right');
    expect(plan?.layout.sidebarScope).toBe('all-content');
  });
});
