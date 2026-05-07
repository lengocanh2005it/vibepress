import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';

describe('CodeReviewerService section assembly policy', () => {
  const service = new CodeReviewerService(
    {} as never,
    {} as never,
    {} as never,
    new CodeGeneratorService(),
    new FrameGeneratorService(),
  );

  it('hydrates deterministic fallback sections when the visual plan is empty', () => {
    const merged = (
      service as unknown as {
        mergeDeterministicFallbackSections: (
          visualPlan: any,
          fallbackSections: any[],
        ) => { sections: any[] };
      }
    ).mergeDeterministicFallbackSections(
      {
        componentName: 'Sidebar',
        dataNeeds: ['posts'],
        renderMode: 'block-centric',
        sections: [],
        blockTree: [{ kind: 'group', children: [] }],
      },
      [
        {
          type: 'sidebar',
          widgets: [{ kind: 'search' }],
          sourceRef: { sourceNodeId: 'sidebar::group::0' },
        },
      ],
    );

    expect(merged.sections).toHaveLength(1);
    expect(merged.sections[0]?.type).toBe('sidebar');
  });

  it('appends missing deterministic fallback sections without duplicating existing ones', () => {
    const merged = (
      service as unknown as {
        mergeDeterministicFallbackSections: (
          visualPlan: any,
          fallbackSections: any[],
        ) => { sections: any[] };
      }
    ).mergeDeterministicFallbackSections(
      {
        componentName: 'Single',
        dataNeeds: ['postDetail'],
        renderMode: 'hybrid',
        sections: [
          {
            type: 'post-content',
            sourceRef: { sourceNodeId: 'single::post-content::1.0' },
          },
        ],
      },
      [
        {
          type: 'post-content',
          sourceRef: { sourceNodeId: 'single::post-content::1.0' },
        },
        {
          type: 'sidebar',
          sourceRef: { sourceNodeId: 'single::group::4' },
        },
      ],
    );

    expect(merged.sections).toHaveLength(2);
    expect(
      merged.sections.filter((section) => section.type === 'post-content'),
    ).toHaveLength(1);
    expect(merged.sections.some((section) => section.type === 'sidebar')).toBe(
      true,
    );
  });

  it('prefers section assembly for hybrid non-detail pages with source-backed sections', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Shop',
              sourceRef: { sourceNodeId: 'archive-product::group::1.0' },
            },
            {
              type: 'card-grid',
              cards: [{ heading: 'Let', body: 'Short body' }],
              sourceRef: { sourceNodeId: 'archive-product::group::1.1' },
            },
            {
              type: 'post-list',
              layout: 'grid-3',
              showDate: true,
              showAuthor: false,
              showCategory: false,
              showExcerpt: true,
              showFeaturedImage: true,
              sourceRef: { sourceNodeId: 'archive-product::query::1.2' },
            },
          ],
        },
      },
      'ArchiveProduct',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('section assembly');
  });

  it('keeps page-content wrapper pages on full-file generation', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        type: 'page',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'section-centric',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'About',
            },
            {
              type: 'page-content',
              bodyPresentation: 'wordpress-blocks',
            },
          ],
        },
      },
      'Page',
    );

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('page-content wrapper');
  });

  it('prefers section assembly for complex homepage block-tree plans', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
            {
              type: 'media-text',
              heading: 'Story',
              body: 'Body',
              imageSrc: '/assets/story.jpg',
              imageAlt: 'Story',
              sourceRef: { sourceNodeId: 'front-page::group::1.1' },
            },
            {
              type: 'card-grid',
              columns: 3,
              cards: [{ heading: 'A', body: 'B' }],
              sourceRef: { sourceNodeId: 'front-page::group::1.2' },
            },
            {
              type: 'testimonial',
              quote: 'Quote',
              authorName: 'Author',
              sourceRef: { sourceNodeId: 'front-page::group::1.3' },
            },
          ],
        },
      },
      'FrontPage',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('section assembly');
  });

  it('always pins Home to section assembly when sections exist', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'home',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'all-content',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'home::group::1.0' },
            },
          ],
        },
      },
      'Home',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('pinned to section assembly');
  });

  it('always pins template landing components to section assembly when present', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'template-about',
        type: 'page',
        route: '/about',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'media-text',
              heading: 'About',
              body: 'Body',
              imageSrc: '/assets/about.jpg',
              sourceRef: { sourceNodeId: 'template-about::group::1.0' },
            },
          ],
        },
      },
      'TemplateAbout',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('pinned to section assembly');
  });

  it('does not use section assembly for profolio-fse FrontPage because source-cluster composition owns it', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
          repoManifest?: any,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'media-text',
              heading: 'Welcome',
              body: 'Body',
              imageSrc: '/assets/hero.jpg',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
          ],
        },
      },
      'FrontPage',
      {
        themeTypeHints: {
          themeSlug: 'profolio-fse',
        },
      },
    );

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('source-cluster child component');
  });

  it('does not prefer deterministic-first for complex homepage/page templates', () => {
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        renderContract: {
          structure: { renderMode: 'hybrid' },
        },
        visualPlan: {
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
            {
              type: 'media-text',
              heading: 'Story',
              body: 'Body',
              imageSrc: '/assets/story.jpg',
              imageAlt: 'Story',
              sourceRef: { sourceNodeId: 'front-page::group::1.1' },
            },
            {
              type: 'card-grid',
              columns: 3,
              cards: [{ heading: 'A', body: 'B' }],
              sourceRef: { sourceNodeId: 'front-page::group::1.2' },
            },
            {
              type: 'testimonial',
              quote: 'Quote',
              authorName: 'Author',
              sourceRef: { sourceNodeId: 'front-page::group::1.3' },
            },
          ],
        },
      },
      'FrontPage',
    );

    expect(preferDeterministic).toBe(false);
  });

  it('does not prefer deterministic-first for profolio-fse FrontPage source-faithful plans', () => {
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
          repoManifest?: any,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        renderContract: {
          structure: { renderMode: 'hybrid' },
        },
        visualPlan: {
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'media-text',
              heading: 'About Me',
              body: 'Body',
              imageSrc: '/assets/about.jpg',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
          ],
        },
      },
      'FrontPage',
      {
        themeTypeHints: {
          themeSlug: 'profolio-fse',
        },
      },
    );

    expect(preferDeterministic).toBe(false);
  });

  it('does not treat profolio-fse FrontPage canonical block-tree plans as strict deterministic authority', () => {
    const strict = (
      service as unknown as {
        isStrictDeterministicAuthority: (componentPlan: any) => boolean;
      }
    ).isStrictDeterministicAuthority({
      componentName: 'FrontPage',
      templateName: 'front-page',
      type: 'page',
      route: '/',
      isDetail: false,
      dataNeeds: [],
      planningSourceReason: 'block-tree deterministic visual plan path',
      renderContract: {
        structure: { renderMode: 'block-tree' },
      },
      visualPlan: {
        renderMode: 'block-centric',
        renderAuthority: 'deterministic-pixel',
        blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
        layout: {
          contentLayout: 'single-column',
          sidebarScope: 'none',
        },
        sections: [
          {
            type: 'media-text',
            heading: 'About Me',
            body: 'Body',
            imageSrc: '/assets/about.jpg',
            sourceRef: { sourceNodeId: 'front-page::group::1.0' },
          },
        ],
      },
    });

    expect(strict).toBe(false);
  });

  it('hard-locks profolio transactional block-tree pages for deterministic structure', () => {
    const strict = (
      service as unknown as {
        isStrictDeterministicAuthority: (componentPlan: any) => boolean;
      }
    ).isStrictDeterministicAuthority({
      componentName: 'Cart',
      templateName: 'cart',
      type: 'page',
      route: '/cart',
      isDetail: false,
      dataNeeds: ['products'],
      planningSourceReason: 'block-tree deterministic visual plan path',
      renderContract: {
        structure: { renderMode: 'block-tree' },
      },
      visualPlan: {
        componentName: 'Cart',
        renderMode: 'block-centric',
        renderAuthority: 'deterministic-structure',
        dataNeeds: ['pageDetail'],
        blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
        layout: {
          contentLayout: 'single-column',
          sidebarScope: 'none',
        },
        sections: [],
      },
    });

    expect(strict).toBe(true);
  });

  it('hard-locks profolio single post detail block-tree pages for deterministic structure', () => {
    const componentPlan = {
      componentName: 'Single',
      templateName: 'single',
      type: 'page',
      route: '/post/:slug',
      isDetail: true,
      dataNeeds: ['postDetail', 'posts', 'comments'],
      planningSourceReason: 'block-tree deterministic visual plan path',
      renderContract: {
        structure: { renderMode: 'block-tree' },
      },
      visualPlan: {
        componentName: 'Single',
        renderMode: 'block-centric',
        renderAuthority: 'deterministic-structure',
        dataNeeds: ['postDetail', 'posts', 'comments'],
        blockTree: [
          { kind: 'group', blockName: 'core/group', children: [] },
          { kind: 'post-content', blockName: 'core/post-content' },
          { kind: 'sidebar', blockName: 'core/template-part' },
        ],
        layout: {
          contentLayout: 'with-sidebar',
          sidebarScope: 'all-content',
        },
        sections: [
          { type: 'cover', heading: 'Post' },
          { type: 'post-content' },
          { type: 'sidebar', widgets: [] },
        ],
      },
    };

    const strict = (
      service as unknown as {
        isStrictDeterministicAuthority: (componentPlan: any) => boolean;
      }
    ).isStrictDeterministicAuthority(componentPlan);
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
          repoManifest?: any,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(componentPlan, 'Single', {
      themeTypeHints: { themeSlug: 'profolio-fse' },
    });

    expect(strict).toBe(true);
    expect(preferDeterministic).toBe(true);
  });

  it('uses deterministic section rendering for post-list and cover assembly sections', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn(() => undefined),
      checkInlineSectionFidelity: jest.fn(() => undefined),
    } as never;
    const deterministicService = new CodeReviewerService(
      {} as never,
      {} as never,
      validator,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    );
    const generateWithRetrySpy = jest.spyOn(
      deterministicService as any,
      'generateWithRetry',
    );
    const baseVisualPlan = {
      componentName: 'Index',
      dataNeeds: ['posts'],
      palette: {
        background: '#ffffff',
        surface: '#f5f5f5',
        text: '#111111',
        textMuted: '#666666',
        accent: '#2f4138',
        accentText: '#ffffff',
      },
      typography: {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded-full',
      },
      layout: {
        containerClass: 'max-w-[1200px] mx-auto w-full',
        contentContainerClass: 'max-w-[800px] mx-auto w-full',
        blockGap: 'gap-8',
        includes: [],
      },
      sections: [] as any[],
    };
    const baseContent = {
      posts: [],
      pages: [],
      products: [],
      menus: [],
      comments: [],
      siteInfo: {},
    };

    const postListResult = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'Index',
      section: {
        type: 'post-list',
        title: 'Posts',
        layout: 'grid-3',
        showDate: true,
        showAuthor: false,
        showCategory: false,
        showExcerpt: true,
        showFeaturedImage: true,
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: 'posts, loading, error',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: baseContent as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          ...baseVisualPlan,
          sections: [
            {
              type: 'post-list',
              title: 'Posts',
              layout: 'grid-3',
              showDate: true,
              showAuthor: false,
              showCategory: false,
              showExcerpt: true,
              showFeaturedImage: true,
            },
          ],
        },
      },
    });

    const coverResult = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'Archive',
      section: {
        type: 'cover',
        imageSrc: 'theme-asset:/assets/images/banner.jpg',
        background: '#F4F4F4',
        dimRatio: 50,
        minHeight: '360px',
        heading: 'Archive',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: 'posts, loading, error',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: baseContent as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          ...baseVisualPlan,
          componentName: 'Archive',
          sections: [
            {
              type: 'cover',
              imageSrc: 'theme-asset:/assets/images/banner.jpg',
              background: '#F4F4F4',
              dimRatio: 50,
              minHeight: '360px',
              heading: 'Archive',
            },
          ],
        },
      },
    });

    expect(postListResult.isValid).toBe(true);
    expect(postListResult.attemptsUsed).toBe(0);
    expect(postListResult.code).toContain('Posts');
    expect(coverResult.isValid).toBe(true);
    expect(coverResult.attemptsUsed).toBe(0);
    expect(coverResult.code).toContain('Archive');
    expect(coverResult.code).toContain('#F4F4F4');
    expect(generateWithRetrySpy).not.toHaveBeenCalled();
  });

  it('wraps deterministic sidebar inline output instead of falling back to AI', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn(() => undefined),
      checkInlineSectionFidelity: jest.fn(() => undefined),
    } as never;
    const deterministicService = new CodeReviewerService(
      {} as never,
      {} as never,
      validator,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    );
    const generateWithRetrySpy = jest.spyOn(
      deterministicService as any,
      'generateWithRetry',
    );
    jest
      .spyOn(
        (deterministicService as any).codeGenerator,
        'generateDeterministicInlineSection',
      )
      .mockReturnValue('<aside>Search</aside>\n<aside>Tags</aside>');

    const result = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'Archive',
      section: {
        type: 'sidebar',
        widgets: [
          { kind: 'search', title: 'Search' },
          { kind: 'tags', title: 'Tags' },
        ],
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: 'posts, loading, error',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: { posts: [] } as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          componentName: 'Archive',
          dataNeeds: ['posts'],
          palette: {},
          typography: {},
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'sidebar',
              widgets: [
                { kind: 'search', title: 'Search' },
                { kind: 'tags', title: 'Tags' },
              ],
            },
          ],
        },
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
    expect(result.code).toContain('data-inline-section="sidebar"');
    expect(result.code).toContain('<aside>Search</aside>');
    expect(result.code).toContain('<aside>Tags</aside>');
    expect(generateWithRetrySpy).not.toHaveBeenCalled();
  });

  it('accepts deterministic sidebar category widgets without misreading Map generics as JSX', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn(() => undefined),
      checkInlineSectionFidelity: jest.fn(() => undefined),
    } as never;
    const deterministicService = new CodeReviewerService(
      {} as never,
      {} as never,
      validator,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    );
    const generateWithRetrySpy = jest.spyOn(
      deterministicService as any,
      'generateWithRetry',
    );

    const result = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'Archive',
      section: {
        type: 'sidebar',
        title: 'Categories',
        widgets: [{ kind: 'categories' }],
        background: '#F4F4F4',
        paddingStyle: '1rem min(1.5rem, 2vw)',
        maxItems: 6,
      },
      sectionIndex: 0,
      totalSections: 6,
      availableVariables: 'posts, loading, error',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: { posts: [] } as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          componentName: 'Archive',
          dataNeeds: ['posts'],
          palette: {
            background: '#ffffff',
            surface: '#f7f7f7',
            text: '#111111',
            textMuted: '#666666',
            accent: '#2f4138',
            accentText: '#ffffff',
          },
          typography: {
            h3: 'text-2xl',
            buttonRadius: 'rounded-full',
          },
          layout: {
            containerClass: 'max-w-[1200px] mx-auto w-full',
            cardPadding: '1.5rem',
          },
          sections: [
            {
              type: 'sidebar',
              title: 'Categories',
              widgets: [{ kind: 'categories' }],
              background: '#F4F4F4',
              paddingStyle: '1rem min(1.5rem, 2vw)',
              maxItems: 6,
            },
          ],
        },
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
    expect(result.code).toContain('Categories');
    expect(result.code).toContain('const categoryMap = new Map();');
    expect(result.code).not.toContain('new Map<string');
    expect(generateWithRetrySpy).not.toHaveBeenCalled();
  });

  it('accepts inline sections containing TypeScript generics inside JSX expressions', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn(() => undefined),
      checkInlineSectionFidelity: jest.fn(() => undefined),
    } as never;
    const deterministicService = new CodeReviewerService(
      {} as never,
      {} as never,
      validator,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    );
    const generateWithRetrySpy = jest.spyOn(
      deterministicService as any,
      'generateWithRetry',
    );
    jest.spyOn(
      (deterministicService as any).codeGenerator,
      'generateDeterministicInlineSection',
    ).mockReturnValue(`<section>
        {(() => {
          const tagMap = new Map<string, number>();
          return Array.from(tagMap.entries()).map(([tag]) => <span key={tag}>{tag}</span>);
        })()}
      </section>`);

    const result = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'Archive',
      section: {
        type: 'sidebar',
        title: 'Tags',
        widgets: [{ kind: 'tags' }],
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: 'posts, loading, error',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: { posts: [] } as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          componentName: 'Archive',
          dataNeeds: ['posts'],
          palette: {},
          typography: {},
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'sidebar',
              title: 'Tags',
              widgets: [{ kind: 'tags' }],
            },
          ],
        },
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
    expect(result.code).toContain('new Map<string, number>()');
    expect(generateWithRetrySpy).not.toHaveBeenCalled();
  });

  it('uses deterministic section rendering for testimonials with source avatars', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn(() => undefined),
      checkInlineSectionFidelity: jest.fn(() => undefined),
    } as never;
    const deterministicService = new CodeReviewerService(
      {} as never,
      {} as never,
      validator,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    );
    const generateWithRetrySpy = jest.spyOn(
      deterministicService as any,
      'generateWithRetry',
    );

    const result = await (
      deterministicService as any
    ).generateInlineSectionForAssembly({
      componentName: 'TemplateAbout',
      section: {
        type: 'testimonial',
        quote: 'Great work.',
        authorName: 'Jane Doe',
        authorTitle: 'Founder',
        authorAvatar: 'theme-asset:/assets/images/projects-1.jpg',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: '',
      modelName: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      componentPlan: {
        type: 'page',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          componentName: 'TemplateAbout',
          dataNeeds: [],
          palette: {
            dark: '#111111',
            darkText: '#ffffff',
          },
          typography: {
            h3: 'text-2xl',
          },
          layout: {
            containerClass: 'max-w-[1200px] mx-auto w-full',
            contentContainerClass: 'max-w-[760px] mx-auto w-full',
          },
          sections: [
            {
              type: 'testimonial',
              quote: 'Great work.',
              authorName: 'Jane Doe',
              authorTitle: 'Founder',
              authorAvatar: 'theme-asset:/assets/images/projects-1.jpg',
            },
          ],
        },
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
    expect(result.code).toContain(
      'resolveAsset("theme-asset:/assets/images/projects-1.jpg")',
    );
    expect(result.code).toContain('Jane Doe');
    expect(generateWithRetrySpy).not.toHaveBeenCalled();
  });

  it('strips profolio footer partial leakage from page-level AI output', () => {
    const cleaned = (
      service as unknown as {
        postProcessFullFileCandidate: (
          code: string,
          componentName: string,
          policy: 'plan-guided-full-file' | 'direct-ai-full-file',
          componentPlan?: any,
        ) => string;
      }
    ).postProcessFullFileCandidate(
      `export default function Cart(){return (<main><section><div className="checkout-shell">Checkout body</div></section><section><div className="pg-footer-center-row"><h2>Let's Work Together</h2><p className="profolio-fse-scroll-top" /></div></section></main>);}`,
      'Cart',
      'plan-guided-full-file',
      {
        type: 'page',
        route: '/cart',
        isDetail: false,
        dataNeeds: ['products'],
      },
    );

    expect(cleaned).toContain('Checkout body');
    expect(cleaned).not.toContain('pg-footer-center-row');
    expect(cleaned).not.toContain("Let's Work Together");
  });

  it('treats template-driven PagePage variants with rich block-tree markers as AI-first', () => {
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(
      {
        templateName: 'template-about',
        type: 'page',
        route: '/about',
        isDetail: true,
        dataNeeds: ['pageDetail'],
        renderContract: {
          structure: { renderMode: 'hybrid' },
        },
        visualPlan: {
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          blockTree: [
            {
              kind: 'group',
              blockName: 'core/group',
              sourceRef: { sourceNodeId: 'template-about::group::1' },
              customClassNames: ['r-pad'],
              children: [
                {
                  kind: 'columns',
                  blockName: 'core/columns',
                  sourceRef: { sourceNodeId: 'template-about::columns::1.1' },
                  children: [
                    {
                      kind: 'column',
                      blockName: 'core/column',
                      sourceRef: {
                        sourceNodeId: 'template-about::column::1.1.1',
                      },
                      children: [
                        {
                          kind: 'image',
                          blockName: 'core/image',
                          sourceRef: {
                            sourceNodeId: 'template-about::image::1.1.1.1',
                          },
                          src: 'theme-asset:/assets/images/figma.png',
                          customClassNames: ['wow', 'animate__fadeInUp'],
                        },
                        {
                          kind: 'group',
                          blockName: 'uagb/container',
                          sourceRef: {
                            sourceNodeId: 'template-about::uagb::1.1.1.2',
                          },
                          customClassNames: ['uagb-section__wrap'],
                          children: [
                            {
                              kind: 'heading',
                              blockName: 'core/heading',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::heading::1.1.1.2.1',
                              },
                              text: 'About',
                            },
                            {
                              kind: 'image',
                              blockName: 'core/image',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::image::1.1.1.2.2',
                              },
                              src: 'theme-asset:/assets/images/wordpress.png',
                            },
                            {
                              kind: 'image',
                              blockName: 'core/image',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::image::1.1.1.2.3',
                              },
                              src: 'theme-asset:/assets/images/illustrator.png',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          sections: [
            {
              type: 'hero',
              heading: 'About',
              sourceRef: { sourceNodeId: 'template-about::group::1' },
            },
            {
              type: 'page-content',
              bodyPresentation: 'wordpress-blocks',
              sourceRef: { sourceNodeId: 'template-about::content::1.2' },
            },
          ],
        },
      },
      'PagePageAbout',
    );

    expect(preferDeterministic).toBe(false);
  });
});

describe('CodeReviewerService inline section generation policy', () => {
  it('normalizes parenthesized inline JSX output before validation', () => {
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new FrameGeneratorService(),
    );

    const normalized = (
      service as unknown as {
        normalizeInlineSectionOutput: (code: string) => string;
        validateInlineSectionOutput: (code: string) => string | undefined;
      }
    ).normalizeInlineSectionOutput(`
      return (
        <section className="hero">
          <div>Content</div>
        </section>
      );
    `);

    expect(normalized).toBe(
      '<section className="hero">\n          <div>Content</div>\n        </section>',
    );
    expect(
      (
        service as unknown as {
          validateInlineSectionOutput: (code: string) => string | undefined;
        }
      ).validateInlineSectionOutput(normalized),
    ).toBeUndefined();
  });

  it('wraps sibling inline section nodes in a fragment before validation', () => {
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new FrameGeneratorService(),
    );

    const normalized = (
      service as unknown as {
        normalizeInlineSectionOutput: (code: string) => string;
        validateInlineSectionOutput: (code: string) => string | undefined;
      }
    ).normalizeInlineSectionOutput(`
      <div className="eyebrow">About Me</div>
      <div className="content">Welcome To My Profile</div>
    `);

    expect(normalized).toBe(
      '<><div className="eyebrow">About Me</div>\n      <div className="content">Welcome To My Profile</div></>',
    );
    expect(
      (
        service as unknown as {
          validateInlineSectionOutput: (code: string) => string | undefined;
        }
      ).validateInlineSectionOutput(normalized),
    ).toBeUndefined();
  });

  it('does not use deterministic inline assembly for rich media-text sections', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn().mockReturnValue(undefined),
      checkInlineSectionFidelity: jest.fn().mockReturnValue(undefined),
    };
    const codeGenerator = {
      generateDeterministicInlineSection: jest
        .fn()
        .mockReturnValue('<section><div>deterministic</div></section>'),
    };
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      validator as never,
      codeGenerator as never,
      new FrameGeneratorService(),
    );

    const result = await (
      service as unknown as {
        generateInlineSectionForAssembly: (input: any) => Promise<any>;
      }
    ).generateInlineSectionForAssembly({
      componentName: 'FrontPage',
      section: {
        type: 'media-text',
        heading: 'About',
        body: 'Body',
        imageSrc: 'theme-asset:/assets/images/about.jpg',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: '',
      modelName: 'test-model',
      systemPrompt: 'test-system',
      content: {},
      componentPlan: {
        visualPlan: {
          sections: [{ type: 'media-text' }],
        },
      },
      maxAttempts: 0,
    });

    expect(
      codeGenerator.generateDeterministicInlineSection,
    ).not.toHaveBeenCalled();
    expect(result.isValid).toBe(false);
    expect(result.attemptsUsed).toBe(0);
  });

  it('still uses deterministic inline assembly for low-risk post-content sections', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn().mockReturnValue(undefined),
      checkInlineSectionFidelity: jest.fn().mockReturnValue(undefined),
    };
    const codeGenerator = {
      generateDeterministicInlineSection: jest
        .fn()
        .mockReturnValue('<section><article>Body</article></section>'),
    };
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      validator as never,
      codeGenerator as never,
      new FrameGeneratorService(),
    );

    const result = await (
      service as unknown as {
        generateInlineSectionForAssembly: (input: any) => Promise<any>;
      }
    ).generateInlineSectionForAssembly({
      componentName: 'Single',
      section: {
        type: 'post-content',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: '',
      modelName: 'test-model',
      systemPrompt: 'test-system',
      content: {},
      componentPlan: {
        visualPlan: {
          sections: [{ type: 'post-content' }],
        },
      },
      maxAttempts: 0,
    });

    expect(
      codeGenerator.generateDeterministicInlineSection,
    ).toHaveBeenCalledTimes(1);
    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
  });
});

describe('CodeReviewerService theme-asset postprocess', () => {
  const service = new CodeReviewerService(
    {} as never,
    {} as never,
    {} as never,
    new CodeGeneratorService(),
    new FrameGeneratorService(),
  );

  it('normalizes raw theme-asset URLs into resolveAsset calls', () => {
    const processed = (
      service as unknown as {
        postProcessCode: (code: string) => string;
      }
    ).postProcessCode(`
      import React from 'react';

      export default function FrontPage() {
        return (
          <section style={{ backgroundImage: "url('theme-asset:/assets/images/banner.jpg')" }}>
            <img src="theme-asset:/assets/images/banner-image.png" alt="" />
          </section>
        );
      }
    `);

    expect(processed).toContain('const resolveAsset = (src: string) => {');
    expect(processed).toContain(
      'backgroundImage: `url("${resolveAsset("theme-asset:/assets/images/banner.jpg")}")`',
    );
    expect(processed).toContain(
      'src={resolveAsset("theme-asset:/assets/images/banner-image.png")}',
    );
  });

  it('normalizes common sans-serif typos in generated inline styles', () => {
    const processed = (
      service as unknown as {
        postProcessCode: (code: string) => string;
      }
    ).postProcessCode(`
      import React from 'react';

      export default function FrontPage() {
        return <h1 style={{ fontFamily: "League Spartan, san-serif" }}>Hello</h1>;
      }
    `);

    expect(processed).toContain('League Spartan, sans-serif');
    expect(processed).not.toContain('san-serif');
  });
});
