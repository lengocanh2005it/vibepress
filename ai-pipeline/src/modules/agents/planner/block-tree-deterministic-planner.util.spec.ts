import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import {
  buildBlockTreeDrivenVisualPlanForComponent,
  shouldShortCircuitBlockTreeVisualPlan,
} from './block-tree-deterministic-planner.util.js';
import type { ComponentVisualPlan } from '../react-generator/visual-plan.schema.js';

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
        { kind: 'categories' },
        { kind: 'recent-posts' },
      ],
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
});
