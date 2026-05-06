import {
  buildRepoRouteHints,
  inferDeterministicRouteContract,
  matchesRepoEntrySourceTemplate,
  resolveHomeHierarchy,
} from './route-contract.util.js';

describe('inferDeterministicRouteContract', () => {
  it('treats front-page as the canonical home route', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'front-page',
      componentName: 'FrontPage',
      type: 'page',
      repoRouteHints: {
        routeHint: 'home',
        chainFiles: ['templates/front-page.html'],
        blockTypes: [],
        notes: [],
      },
    });

    expect(contract.archetype).toBe('home');
    expect(contract.route).toBe('/');
    expect(contract.isDetail).toBe(false);
    expect(contract.homeTemplateBase).toBe('front-page');
    expect(contract.homeMode).toBe('front-page');
  });

  it('keeps root route on front-page while annotating posts-index home mode', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'front-page',
      componentName: 'FrontPage',
      type: 'page',
      readingSettings: {
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
    });

    expect(contract.archetype).toBe('home');
    expect(contract.route).toBe('/');
    expect(contract.homeMode).toBe('posts-index');
    expect(contract.requiredDataNeeds).toEqual([]);
  });

  it('keeps posts data need on hybrid front-page layouts with feed structure', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'front-page',
      componentName: 'FrontPage',
      type: 'page',
      dataNeeds: ['posts'],
      readingSettings: {
        showOnFront: 'page',
        pageOnFrontId: 12,
        pageForPostsId: 34,
      },
    });

    expect(contract.route).toBe('/');
    expect(contract.homeMode).toBe('hybrid-home');
    expect(contract.requiredDataNeeds).toEqual(['posts']);
  });

  it('keeps the default page template as a singular page detail route', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'page',
      componentName: 'Page',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/page/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('keeps named custom page templates on their own detail route family', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'template-about',
      componentName: 'TemplateAbout',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/template-about/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('keeps generic FSE layout templates on the canonical page detail route', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'blank',
      componentName: 'Blank',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/page/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('keeps single templates as post detail routes', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'single',
      componentName: 'Single',
      type: 'page',
      dataNeeds: ['post-detail'],
    });

    expect(contract.route).toBe('/post/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['post-detail']);
  });

  it('promotes custom templates with page-content structure into page detail routes', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'template-about',
      componentName: 'TemplateAbout',
      type: 'page',
      dataNeeds: [],
      draftBlockTree: [
        {
          kind: 'page-content',
          blockName: 'core/post-content',
        },
      ],
      planningSourceSummary: 'Template renders canonical page content block.',
    });

    expect(contract.route).toBe('/template-about/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('lets page-content structure override misleading single-like names', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'single-landing',
      componentName: 'SingleLanding',
      type: 'page',
      dataNeeds: ['post-detail'],
      draftBlockTree: [
        {
          kind: 'page-content',
          blockName: 'core/post-content',
        },
      ],
      planningSourceSummary: 'Template renders canonical page content block.',
    });

    expect(contract.archetype).toBe('single-page');
    expect(contract.route).toBe('/single-landing/:slug');
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
    expect(contract.disallowedDetailDataNeeds).toContain('post-detail');
  });

  it('treats template-part sources as partials even with unusual names', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'masthead-alt',
      componentName: 'MastheadAlt',
      type: 'page',
      planningSourceFile: 'parts/masthead-alt.html',
      planningSourceSummary: 'Theme template part used as shared chrome.',
    });

    expect(contract.type).toBe('partial');
    expect(contract.route).toBeNull();
    expect(contract.isDetail).toBe(false);
  });

  it('uses theme.json templatePartAreas as direct partial evidence', () => {
    const repoRouteHints = buildRepoRouteHints('masthead-alt', {
      themeJsonSummary: {
        templatePartAreas: [
          { name: 'masthead-alt', title: 'Masthead', area: 'header' },
        ],
      },
      structureHints: {
        entrySourceChains: [],
      },
    } as any);

    const contract = inferDeterministicRouteContract({
      templateName: 'masthead-alt',
      componentName: 'MastheadAlt',
      type: 'page',
      repoRouteHints,
    });

    expect(contract.type).toBe('partial');
    expect(contract.route).toBeNull();
  });

  it('uses repo entry source chains as page-detail evidence', () => {
    const repoRouteHints = buildRepoRouteHints('about-story', {
      themeJsonSummary: {
        templatePartAreas: [],
      },
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/about-story.html',
            routeHint: '/about-story',
            chainFiles: ['templates/about-story.html'],
            composedSource: '',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/post-content'],
            headingTexts: [],
            notes: ['canonical page content block'],
          },
        ],
      },
    } as any);

    const contract = inferDeterministicRouteContract({
      templateName: 'about-story',
      componentName: 'AboutStory',
      type: 'page',
      repoRouteHints,
    });

    expect(contract.route).toBe('/about-story/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('does not promote arbitrary query templates to archive without matching hints', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'landing-news',
      componentName: 'LandingNews',
      type: 'page',
      draftBlockTree: [
        {
          kind: 'query',
          blockName: 'core/query',
        },
      ],
    });

    expect(contract.archetype).toBe('static-page');
    expect(contract.route).toBe('/landing-news');
    expect(contract.requiredDataNeeds).toEqual([]);
  });

  it('uses repo route hints to classify query templates as posts index when evidence matches', () => {
    const repoRouteHints = buildRepoRouteHints('news-feed', {
      themeJsonSummary: {
        templatePartAreas: [],
      },
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/news-feed.html',
            routeHint: '/blog',
            chainFiles: ['templates/news-feed.html'],
            composedSource: '',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/query'],
            headingTexts: [],
            notes: ['blog posts index'],
          },
        ],
      },
    } as any);

    const contract = inferDeterministicRouteContract({
      templateName: 'news-feed',
      componentName: 'NewsFeed',
      type: 'page',
      repoRouteHints,
    });

    expect(contract.archetype).toBe('posts-index');
    expect(contract.route).toBe('/blog');
    expect(contract.requiredDataNeeds).toEqual(['posts']);
  });

  it('does not let generic blog route hints hijack custom blog sidebar templates', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'blog-left-sidebar',
      componentName: 'BlogLeftSidebar',
      type: 'page',
      draftBlockTree: [
        { kind: 'query', blockName: 'core/query' },
        { kind: 'search', blockName: 'core/search' },
      ],
      repoRouteHints: {
        entryFile: 'templates/blog-left-sidebar.html',
        routeHint: 'blog',
        chainFiles: ['templates/blog-left-sidebar.html'],
        blockTypes: ['core/query', 'core/search'],
        notes: [],
      },
    });

    expect(contract.archetype).toBe('static-page');
    expect(contract.route).toBe('/blog-left-sidebar');
  });
});

describe('resolveHomeHierarchy', () => {
  it('collapses implicit home into index when front-page already owns root', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'home', 'index', 'header'],
    });

    expect(resolution.redundantBases).toEqual(['home']);
    expect(resolution.routeByBase['front-page']).toBe('/');
    expect(resolution.routeByBase['index']).toBe('/index');
    expect(resolution.orderedTemplateNames).toEqual([
      'front-page',
      'index',
      'header',
    ]);
  });

  it('assigns root to the posts family when show_on_front=posts has no DB front-page evidence', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'index', 'header'],
      readingSettings: {
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
    });

    expect(resolution.routeByBase['front-page']).toBe('/front-page');
    expect(resolution.routeByBase['index']).toBe('/');
  });

  it('lets home/index own root when show_on_front=posts without DB front-page evidence', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'home', 'index', 'header'],
      readingSettings: {
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
      explicitTemplateNames: [],
    });

    expect(resolution.routeByBase['home']).toBeUndefined();
    expect(resolution.routeByBase['index']).toBe('/');
    expect(resolution.routeByBase['front-page']).toBe('/front-page');
    expect(resolution.orderedTemplateNames.slice(0, 3)).toEqual([
      'index',
      'front-page',
      'header',
    ]);
  });

  it('keeps DB-backed front-page eligible for root even when show_on_front=posts', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'index'],
      readingSettings: {
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
      explicitTemplateNames: ['front-page'],
    });

    expect(resolution.routeByBase['front-page']).toBe('/');
    expect(resolution.routeByBase['index']).toBe('/blog');
    expect(resolution.orderedTemplateNames.slice(0, 2)).toEqual([
      'front-page',
      'index',
    ]);
  });

  it('keeps explicit home and demotes index to /index', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'home', 'index'],
      explicitTemplateNames: ['home'],
    });

    expect(resolution.redundantBases).toEqual([]);
    expect(resolution.routeByBase['front-page']).toBe('/');
    expect(resolution.routeByBase['home']).toBe('/home');
    expect(resolution.routeByBase['index']).toBe('/index');
  });

  it('lets index own root when home is only an implicit alias', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['home', 'index'],
    });

    expect(resolution.redundantBases).toEqual(['home']);
    expect(resolution.routeByBase['index']).toBe('/');
    expect(resolution.orderedTemplateNames).toEqual(['index']);
  });
});

describe('matchesRepoEntrySourceTemplate', () => {
  it('preserves legacy front-page/home and home/index alias matches in one shared helper', () => {
    expect(
      matchesRepoEntrySourceTemplate('front-page', 'templates/home.html'),
    ).toBe(true);
    expect(matchesRepoEntrySourceTemplate('home', 'templates/index.html')).toBe(
      true,
    );
    expect(
      matchesRepoEntrySourceTemplate('front-page', 'templates/index.html'),
    ).toBe(false);
  });
});
