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

  it('treats custom non-page templates as static pages by default', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'template-about',
      componentName: 'TemplateAbout',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/template-about');
    expect(contract.isDetail).toBe(false);
    expect(contract.requiredDataNeeds).toEqual([]);
    expect(contract.disallowedDetailDataNeeds).toContain('page-detail');
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
});

describe('resolveHomeHierarchy', () => {
  it('collapses implicit home into index when front-page already owns root', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'home', 'index', 'header'],
    });

    expect(resolution.redundantBases).toEqual(['home']);
    expect(resolution.routeByBase['front-page']).toBe('/');
    expect(resolution.routeByBase['index']).toBe('/blog');
    expect(resolution.orderedTemplateNames).toEqual([
      'front-page',
      'index',
      'header',
    ]);
  });

  it('keeps explicit home and demotes index to /index', () => {
    const resolution = resolveHomeHierarchy({
      templateNames: ['front-page', 'home', 'index'],
      explicitTemplateNames: ['home'],
    });

    expect(resolution.redundantBases).toEqual([]);
    expect(resolution.routeByBase['front-page']).toBe('/');
    expect(resolution.routeByBase['home']).toBe('/blog');
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
