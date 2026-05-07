import { ConfigService } from '@nestjs/config';
import { PlannerService } from './planner.service.js';
import type { PlanResult } from './planner.service.js';

describe('PlannerService shared chrome visual plans', () => {
  const service = new PlannerService(
    { getModel: () => 'test-model' } as any,
    { get: () => undefined } as ConfigService,
    {} as any,
    {} as any,
    { scopeRequestToComponent: () => undefined } as any,
    {} as any,
    {
      prefersBlockTreeSharedChrome: (themeSlug?: string | null) =>
        themeSlug === 'profolio-fse',
    } as any,
  );

  it('precomputes deterministic visual plans for shared chrome partials before full visual planning', async () => {
    const theme = {
      type: 'fse',
      templates: [],
      parts: [
        {
          name: 'footer',
          html: '<!-- wp:group --><div></div><!-- /wp:group -->',
        },
      ],
      tokens: undefined,
    } as any;

    const content = {
      menus: [],
      posts: [],
      pages: [],
    } as any;

    const plan: PlanResult = [
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
        description: 'Shared footer partial',
      },
      {
        templateName: 'index',
        componentName: 'Index',
        type: 'page',
        route: '/',
        dataNeeds: ['posts'],
        isDetail: false,
        description: 'Blog index page',
      },
    ];
    const visualizedFooter = {
      ...plan[0],
      visualPlan: {
        componentName: 'Footer',
        renderMode: 'block-centric',
        sections: [{ type: 'footer' }],
      },
    };
    const generateVisualPlanSpy = jest
      .spyOn<any, any>(service as any, 'generateVisualPlanForComponent')
      .mockResolvedValue(visualizedFooter);

    const reviewed = await service.attachSharedChromePartialVisualPlans(
      theme,
      content,
      plan,
      'test-model',
    );

    expect(reviewed[0].visualPlan).toBeDefined();
    expect(reviewed[0].visualPlan?.renderMode).toBe('block-centric');
    expect(reviewed[0].visualPlan?.sections[0]?.type).toBe('footer');
    expect(reviewed[1].visualPlan).toBeUndefined();
    expect(generateVisualPlanSpy).toHaveBeenCalledTimes(1);
    expect(generateVisualPlanSpy.mock.calls[0][0]).toMatchObject({
      componentName: 'Footer',
      type: 'partial',
    });
  });

  it('skips legacy semantic footer stubs when profolio-fse already has draft block-tree chrome', () => {
    const visualPlan = (
      service as any
    ).buildDeterministicVisualPlanForComponent(
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
        description: 'Shared footer partial',
        draftBlockTree: [
          {
            kind: 'group',
            blockName: 'group',
          },
        ],
      },
      {
        siteInfo: {
          activeTheme: 'profolio-fse',
        },
        menus: [],
        posts: [],
        pages: [],
      },
      undefined,
      {
        background: '#fff',
        surface: '#fff',
        text: '#111',
        textMuted: '#666',
        accent: '#000',
        accentText: '#fff',
        dark: '#000',
        darkText: '#fff',
      },
      {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded',
      },
      [],
    );

    expect(visualPlan).toBeUndefined();
  });

  it('does not force footer shared-chrome data needs for profolio thin footer wrappers without source evidence', () => {
    const enriched = (service as any).enrichPlan(
      [
        {
          templateName: 'footer',
          componentName: 'Footer',
          type: 'partial',
          route: null,
          dataNeeds: [],
          isDetail: false,
          description: 'Shared footer partial',
        },
      ],
      new Map<string, string>([
        ['footer', '<!-- wp:pattern {"slug":"profolio-fse/footer"} /-->'],
      ]),
      {
        siteInfo: {
          activeTheme: 'profolio-fse',
        },
      },
    );

    expect(enriched[0]?.dataNeeds).toEqual([]);
  });

  it('merges repo archetype supplemental sources for profolio fixed page bindings', () => {
    const fusionService = new PlannerService(
      { getModel: () => 'test-model' } as any,
      { get: () => undefined } as ConfigService,
      {} as any,
      { resolve: (nodes: unknown) => nodes } as any,
      { scopeRequestToComponent: () => undefined } as any,
      {} as any,
      {
        prefersBlockTreeSharedChrome: (themeSlug?: string | null) =>
          themeSlug === 'profolio-fse',
      } as any,
    );

    const context = (
      fusionService as any
    ).buildPlanningSourceContextFromResolvedSource(
      {
        templateName: 'page',
        componentName: 'SamplePage',
        type: 'page',
        route: '/page/sample-page',
        dataNeeds: ['page-detail'],
        isDetail: true,
        description: 'Exact bound page',
        fixedSlug: 'sample-page',
        fixedPageId: 12,
      },
      {
        source:
          '<!-- wp:paragraph --><p>Bound page body</p><!-- /wp:paragraph -->',
        label: 'db:bound-page:sample-page',
        reason: 'db page binding',
        templateName: 'page',
        sourceFile: 'db:pages/sample-page',
        priority: 120,
        richness: 120,
        selectionScore: 120,
      },
      true,
      undefined,
      [
        {
          source:
            '<!-- wp:paragraph --><p>Bound page body</p><!-- /wp:paragraph -->',
          label: 'db:bound-page:sample-page',
          reason: 'db page binding',
          templateName: 'page',
          sourceFile: 'db:pages/sample-page',
          priority: 120,
          richness: 120,
          selectionScore: 120,
        },
        {
          source:
            '<!-- wp:group --><div><h2>About Layout</h2></div><!-- /wp:group -->',
          label: 'repo:template-about',
          reason: 'repo archetype',
          templateName: 'template-about',
          sourceFile: 'templates/template-about.html',
          priority: 80,
          richness: 80,
          selectionScore: 80,
        },
      ],
      {
        themeResolvedContent: {
          themeSlug: 'profolio-fse',
          frontPageRoute: null,
          postsPageRoute: null,
          routes: [],
          templateRecords: [],
          navigationRecords: [],
          notes: [],
        },
      } as any,
    );

    expect(context.supplementalSources).toBeDefined();
    expect(context.supplementalSources).toHaveLength(1);
    expect(context.supplementalSources?.[0]?.label).toBe('repo:template-about');
    expect(context.sourceAnalysis).toContain(
      'compatible supplemental sources are merged',
    );
  });

  it('does not expand default DB pages into named profolio template bindings without an explicit page template assignment', () => {
    const pages = [
      {
        id: 14,
        title: 'Title1',
        slug: 'title1',
        parentId: 0,
        menuOrder: 0,
        template: '',
        featuredImage: null,
        content:
          '<!-- wp:paragraph --><p>Our payment automation API platform streamlines business technology workflows.</p><!-- /wp:paragraph -->',
      },
    ];
    const content = {
      pages,
      posts: [],
      readingSettings: {
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
        frontPageRoute: null,
        postsPageRoute: null,
        routes: [
          {
            pageId: 14,
            slug: 'title1',
            title: 'Title1',
            routePath: '/title1',
            template: '',
            templateCandidates: ['template-services', 'page'],
            matchedDbTemplateSlugs: ['template-services'],
            pageBlockTypes: ['core/paragraph'],
            isFrontPage: false,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as any;

    const matches = (service as any).findConcretePagesForTemplate(
      {
        templateName: 'template-services',
        componentName: 'TemplateServices',
        type: 'page',
        route: '/template-services',
        dataNeeds: ['pages'],
        isDetail: false,
        description: 'Services family page',
      },
      content,
    );

    expect(matches).toHaveLength(0);
  });

  it('reassigns home-like routes to posts family when show_on_front=posts', () => {
    const normalized = (service as any).applyDeterministicRouteContracts(
      [
        {
          templateName: 'front-page',
          componentName: 'FrontPage',
          type: 'page',
          route: '/',
          dataNeeds: [],
          isDetail: false,
          description: 'Repo demo front page',
        },
        {
          templateName: 'home',
          componentName: 'Home',
          type: 'page',
          route: '/home',
          dataNeeds: ['posts'],
          isDetail: false,
          description: 'Posts home',
        },
        {
          templateName: 'index',
          componentName: 'Index',
          type: 'page',
          route: '/index',
          dataNeeds: ['posts'],
          isDetail: false,
          description: 'Posts index',
        },
      ],
      {
        pages: [],
        posts: [],
        dbTemplates: [],
        readingSettings: {
          showOnFront: 'posts',
          pageOnFrontId: null,
          pageForPostsId: null,
        },
        themeResolvedContent: {
          themeSlug: 'profolio-fse',
          frontPageRoute: null,
          postsPageRoute: null,
          routes: [],
          templateRecords: [],
          navigationRecords: [],
          notes: [],
        },
      } as any,
      undefined,
    );

    expect(
      normalized.find((item: any) => item.templateName === 'home')?.route,
    ).toBe('/home');
    expect(
      normalized.find((item: any) => item.templateName === 'index')?.route,
    ).toBe('/');
    expect(
      normalized.find((item: any) => item.templateName === 'front-page')?.route,
    ).toBe('/front-page');
  });

  it('keeps DB page primary and repo archetype supplemental for profolio semantic page families', () => {
    const fusionService = new PlannerService(
      { getModel: () => 'test-model' } as any,
      { get: () => undefined } as ConfigService,
      {} as any,
      { resolve: (nodes: unknown) => nodes } as any,
      { scopeRequestToComponent: () => undefined } as any,
      {} as any,
      {
        prefersBlockTreeSharedChrome: (themeSlug?: string | null) =>
          themeSlug === 'profolio-fse',
      } as any,
    );

    const context = (
      fusionService as any
    ).buildPlanningSourceContextFromResolvedSource(
      {
        templateName: 'template-services',
        componentName: 'TemplateServices',
        type: 'page',
        route: '/template-services',
        dataNeeds: ['pages'],
        isDetail: false,
        description: 'Services family page',
      },
      {
        source:
          '<!-- wp:paragraph --><p>Our payment automation API platform streamlines business technology workflows.</p><!-- /wp:paragraph -->',
        label: 'db:page:title1',
        reason: 'representative db page',
        templateName: 'template-services',
        sourceFile: 'db:pages/title1',
        priority: 35,
        richness: 999,
        selectionScore: 999,
      },
      true,
      undefined,
      [
        {
          source:
            '<!-- wp:paragraph --><p>Our payment automation API platform streamlines business technology workflows.</p><!-- /wp:paragraph -->',
          label: 'db:page:title1',
          reason: 'representative db page',
          templateName: 'template-services',
          sourceFile: 'db:pages/title1',
          priority: 35,
          richness: 999,
          selectionScore: 999,
        },
        {
          source:
            '<!-- wp:group --><div><h2>Services Layout</h2></div><!-- /wp:group -->',
          label: 'repo-archetype:template-services',
          reason: 'repo archetype',
          templateName: 'template-services',
          sourceFile: 'templates/template-services.html',
          priority: 80,
          richness: 80,
          selectionScore: 80,
        },
      ],
      {
        themeResolvedContent: {
          themeSlug: 'profolio-fse',
          frontPageRoute: null,
          postsPageRoute: null,
          routes: [],
          templateRecords: [],
          navigationRecords: [],
          notes: [],
        },
      } as any,
    );

    expect(context.sourceLabel).toBe('db:page:title1');
    expect(context.supplementalSources).toHaveLength(1);
    expect(context.supplementalSources?.[0]?.label).toBe(
      'repo-archetype:template-services',
    );
    expect(context.sourceAnalysis).toContain(
      'compatible supplemental sources are merged',
    );
  });
});
