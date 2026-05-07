import {
  buildPlanningSourceCandidates,
  normalizePlanningTemplateIdentifier,
} from './planning-source-policy.util.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';

describe('planning-source-policy util', () => {
  it('normalizes html and templates/ prefixed page templates', () => {
    expect(
      normalizePlanningTemplateIdentifier('templates/template-about.html'),
    ).toBe('template-about');
    expect(normalizePlanningTemplateIdentifier('template-services.php')).toBe(
      'template-services',
    );
  });

  it('ignores unscoped db template candidates for profolio fixed-slug pages', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/template-about.html',
            routeHint: 'page',
            chainFiles: ['templates/template-about.html'],
            composedSource: '<!-- template about -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['About'],
            notes: [],
          },
        ],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 12,
          slug: 'sample-page',
          title: 'About Us',
          content: '<!-- page content -->',
          template: '',
        },
      ],
      posts: [],
      dbTemplates: [
        {
          id: 1,
          postType: 'wp_template',
          title: 'Template About',
          slug: 'template-about',
          canonicalSlug: 'template-about',
          themeSlug: null,
          sourceEntityKey: 'template-about',
          content: '<!-- db template -->',
          area: null,
          status: 'publish',
          modified: '',
          blockTypes: [],
        },
      ],
      readingSettings: {
        showOnFront: 'page',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
        frontPageRoute: null,
        postsPageRoute: null,
        routes: [
          {
            pageId: 12,
            slug: 'sample-page',
            title: 'About Us',
            routePath: '/sample-page',
            template: '',
            templateCandidates: ['template-about', 'page'],
            matchedDbTemplateSlugs: ['template-about'],
            pageBlockTypes: ['core/group'],
            isFrontPage: false,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'single-page',
        type: 'page',
        route: '/sample-page',
        dataNeeds: ['page-detail'],
        fixedSlug: 'sample-page',
        fixedPageId: 12,
      },
      templateSource: '<!-- fallback template -->',
      sourceMap: new Map<string, string>([
        ['template-about', '<!-- template about from source map -->'],
      ]),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => [],
    });

    expect(
      candidates.some(
        (candidate) => candidate.label === 'db:wp_template:template-about',
      ),
    ).toBe(false);
  });

  it('keeps profolio-scoped db template candidates when the db template is theme-trusted', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/template-about.html',
            routeHint: 'page',
            chainFiles: ['templates/template-about.html'],
            composedSource: '<!-- template about -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['About'],
            notes: [],
          },
        ],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 12,
          slug: 'sample-page',
          title: 'About Us',
          content: '<!-- page content -->',
          template: '',
        },
      ],
      posts: [],
      dbTemplates: [
        {
          id: 1,
          postType: 'wp_template',
          title: 'Template About',
          slug: 'template-about',
          canonicalSlug: 'template-about',
          themeSlug: 'profolio-fse',
          sourceEntityKey: 'profolio-fse//template-about',
          content: '<!-- wp:pattern {"slug":"profolio-fse/about-page"} /-->',
          area: null,
          status: 'publish',
          modified: '',
          blockTypes: ['core/pattern'],
        },
      ],
      readingSettings: {
        showOnFront: 'page',
        pageOnFrontId: null,
        pageForPostsId: null,
      },
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
        frontPageRoute: null,
        postsPageRoute: null,
        routes: [
          {
            pageId: 12,
            slug: 'sample-page',
            title: 'About Us',
            routePath: '/sample-page',
            template: '',
            templateCandidates: ['template-about', 'page'],
            matchedDbTemplateSlugs: ['template-about'],
            pageBlockTypes: ['core/group'],
            isFrontPage: false,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'single-page',
        type: 'page',
        route: '/sample-page',
        dataNeeds: ['page-detail'],
        fixedSlug: 'sample-page',
        fixedPageId: 12,
      },
      templateSource: '<!-- fallback template -->',
      sourceMap: new Map<string, string>([
        ['template-about', '<!-- template about from source map -->'],
      ]),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => [],
    });

    expect(
      candidates.some(
        (candidate) => candidate.label === 'db:wp_template:template-about',
      ),
    ).toBe(true);
  });

  it('keeps repo archetype candidates alongside db candidates for profolio bound pages', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/template-about.html',
            routeHint: 'page',
            chainFiles: ['templates/template-about.html'],
            composedSource: '<!-- template about -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['About'],
            notes: [],
          },
          {
            entryFile: 'templates/page.html',
            routeHint: 'page',
            chainFiles: ['templates/page.html'],
            composedSource: '<!-- generic page -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['Page'],
            notes: [],
          },
        ],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 12,
          slug: 'sample-page',
          title: 'About Us',
          content:
            '<!-- wp:paragraph --><p>About body</p><!-- /wp:paragraph -->',
          template: '',
        },
      ],
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
        routes: [
          {
            pageId: 12,
            slug: 'sample-page',
            title: 'About Us',
            routePath: '/sample-page',
            template: '',
            templateCandidates: ['page'],
            matchedDbTemplateSlugs: [],
            pageBlockTypes: ['core/paragraph'],
            isFrontPage: false,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'page',
        type: 'page',
        route: '/sample-page',
        dataNeeds: ['page-detail'],
        fixedSlug: 'sample-page',
        fixedPageId: 12,
      },
      templateSource: '<!-- fallback template -->',
      sourceMap: new Map<string, string>([
        ['template-about', '<!-- template about from source map -->'],
        ['page', '<!-- page from source map -->'],
      ]),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => [],
    });

    expect(
      candidates.some(
        (candidate) => candidate.label === 'db:bound-page:sample-page',
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (candidate) =>
          candidate.label === 'repo:template-about' ||
          candidate.label === 'repo-chain:templates/template-about.html' ||
          candidate.label === 'repo-archetype:template-about',
      ),
    ).toBe(true);
  });

  it('prefers profolio repo archetype chains over thin template wrappers', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/template-about.html',
            routeHint: 'page',
            chainFiles: [
              'templates/template-about.html',
              'patterns/template-about.php',
            ],
            composedSource:
              '<!-- wp:group --><div><h2>About Layout</h2></div><!-- /wp:group -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['About Layout'],
            notes: ['Nested pattern expansion: profolio-fse/about-page'],
          },
        ],
      },
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'template-about',
            entryFile: 'templates/template-about.html',
            routeHint: 'page',
            chainFiles: [
              'templates/template-about.html',
              'patterns/template-about.php',
            ],
            patternSlugs: ['profolio-fse/about-page'],
            templatePartSlugs: ['header', 'footer'],
            blockTypes: ['core/group'],
            headingTexts: ['About Layout'],
            customClasses: [],
            assetFiles: [],
            notes: ['Nested pattern expansion: profolio-fse/about-page'],
          },
        ],
        behaviorSignals: [],
        notes: [],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 9,
          slug: 'home',
          title: 'Home',
          content:
            '<!-- wp:heading --><h2>Real homepage from DB</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Actual page content should outrank the theme demo.</p><!-- /wp:paragraph -->',
          template: '',
        },
      ],
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
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'template-about',
        type: 'page',
        route: '/template-about',
        dataNeeds: ['pages'],
      },
      templateSource:
        '<!-- wp:template-part {"slug":"header","tagName":"header"} /--><!-- wp:pattern {"slug":"profolio-fse/about-page"} /--><!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => [],
    });

    expect(candidates[0]?.label).toBe('repo-archetype:template-about');
    expect(
      candidates.some((candidate) => candidate.label === 'repo:template-about'),
    ).toBe(false);
  });

  it('drops repo front-page root candidates when runtime says posts own home', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: ['templates/front-page.html'],
            composedSource: '<!-- front page -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['Front'],
            notes: [],
          },
          {
            entryFile: 'templates/home.html',
            routeHint: 'home',
            chainFiles: ['templates/home.html'],
            composedSource: '<!-- home -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/query'],
            headingTexts: ['Home'],
            notes: [],
          },
          {
            entryFile: 'templates/index.html',
            routeHint: 'blog',
            chainFiles: ['templates/index.html'],
            composedSource: '<!-- index -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/query'],
            headingTexts: ['Index'],
            notes: [],
          },
        ],
      },
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'front-page',
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: ['templates/front-page.html'],
            patternSlugs: [],
            templatePartSlugs: [],
            blockTypes: ['core/group'],
            headingTexts: ['Front'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
          {
            routeFamily: 'home',
            entryFile: 'templates/home.html',
            routeHint: 'home',
            chainFiles: ['templates/home.html'],
            patternSlugs: [],
            templatePartSlugs: [],
            blockTypes: ['core/query'],
            headingTexts: ['Home'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
          {
            routeFamily: 'page',
            entryFile: 'templates/index.html',
            routeHint: 'blog',
            chainFiles: ['templates/index.html'],
            patternSlugs: [],
            templatePartSlugs: [],
            blockTypes: ['core/query'],
            headingTexts: ['Index'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
        ],
        behaviorSignals: [],
        notes: [],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 9,
          slug: 'home',
          title: 'Home',
          content:
            '<!-- wp:heading --><h2>Real homepage from DB</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Actual page content should outrank the theme demo.</p><!-- /wp:paragraph -->',
          template: '',
        },
      ],
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
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'index',
        type: 'page',
        route: '/',
        dataNeeds: ['posts'],
      },
      templateSource: '<!-- index wrapper -->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => [],
    });

    expect(
      candidates.some((candidate) =>
        /front-page/i.test(candidate.label + ':' + candidate.templateName),
      ),
    ).toBe(false);
  });

  it('prefers DB page content as primary while keeping repo archetype evidence for profolio page families', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/template-services.html',
            routeHint: 'page',
            chainFiles: [
              'templates/template-services.html',
              'patterns/template-services.php',
            ],
            composedSource:
              '<!-- wp:group --><div><h2>Services Layout</h2></div><!-- /wp:group -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['Services Layout'],
            notes: [],
          },
        ],
      },
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'template-services',
            entryFile: 'templates/template-services.html',
            routeHint: 'page',
            chainFiles: [
              'templates/template-services.html',
              'patterns/template-services.php',
            ],
            patternSlugs: ['profolio-fse/services-page'],
            templatePartSlugs: ['header', 'footer'],
            blockTypes: ['core/group'],
            headingTexts: ['Services Layout'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
        ],
        behaviorSignals: [],
        notes: [],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 14,
          slug: 'title1',
          title: 'Title1',
          content:
            '<!-- wp:paragraph --><p>Our payment automation API platform streamlines business technology workflows.</p><!-- /wp:paragraph -->',
          template: '',
        },
      ],
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
        routes: [
          {
            pageId: 14,
            slug: 'title1',
            title: 'Title1',
            routePath: '/title1',
            template: '',
            templateCandidates: ['template-services', 'page'],
            matchedDbTemplateSlugs: [],
            pageBlockTypes: ['core/paragraph'],
            isFrontPage: false,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'template-services',
        type: 'page',
        route: '/template-services',
        dataNeeds: ['pages'],
      },
      templateSource:
        '<!-- wp:template-part {"slug":"header"} /--><!-- wp:pattern {"slug":"profolio-fse/services-page"} /--><!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => content.pages,
      findRepresentativePostsForTemplate: () => [],
    });

    expect(candidates[0]?.label).toBe('db:page:title1');
    expect(
      candidates.some(
        (candidate) => candidate.label === 'repo-archetype:template-services',
      ),
    ).toBe(true);
  });

  it('demotes profolio repo archetype below rich DB content for root front-page planning', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: [
              'templates/front-page.html',
              'patterns/front-page.php',
            ],
            composedSource:
              '<!-- wp:group --><div><h2>Theme Demo Front Page</h2></div><!-- /wp:group -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['Theme Demo Front Page'],
            notes: [],
          },
        ],
      },
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'front-page',
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: [
              'templates/front-page.html',
              'patterns/front-page.php',
            ],
            patternSlugs: ['profolio-fse/front-page'],
            templatePartSlugs: ['header', 'footer'],
            blockTypes: ['core/group'],
            headingTexts: ['Theme Demo Front Page'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
        ],
        behaviorSignals: [],
        notes: [],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 9,
          slug: 'home',
          title: 'Home',
          content:
            '<!-- wp:heading --><h2>Real homepage from DB</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Actual page content should outrank the theme demo.</p><!-- /wp:paragraph -->',
          template: '',
        },
      ],
      posts: [],
      dbTemplates: [],
      readingSettings: {
        showOnFront: 'page',
        pageOnFrontId: 9,
        pageForPostsId: null,
      },
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
        frontPageRoute: '/',
        postsPageRoute: null,
        routes: [
          {
            pageId: 9,
            slug: 'home',
            title: 'Home',
            routePath: '/',
            template: '',
            templateCandidates: ['front-page', 'page'],
            matchedDbTemplateSlugs: [],
            pageBlockTypes: ['core/heading', 'core/paragraph'],
            isFrontPage: true,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        dataNeeds: [],
      },
      templateSource:
        '<!-- wp:template-part {"slug":"header"} /--><!-- wp:pattern {"slug":"profolio-fse/front-page"} /--><!-- wp:template-part {"slug":"footer"} /-->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => content.pages,
      findRepresentativePostsForTemplate: () => [],
    });

    expect(candidates[0]?.label).toBe('db:page-on-front:home');
    expect(
      candidates.some(
        (candidate) => candidate.label === 'repo-archetype:front-page',
      ),
    ).toBe(true);
  });

  it('does not let profolio DB pattern shells suppress repo archetype evidence', () => {
    const repoManifest = {
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: [
              'templates/front-page.html',
              'patterns/front-page.php',
              'patterns/banner.php',
              'patterns/projects.php',
            ],
            composedSource:
              '<!-- wp:group --><div><h2>Welcome To My Profile</h2><p>Theme portfolio source body.</p></div><!-- /wp:group --><!-- wp:group --><div><h2>Some Of My Projects</h2><p>Project cards.</p></div><!-- /wp:group -->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/group'],
            headingTexts: ['Welcome To My Profile', 'Some Of My Projects'],
            notes: [],
          },
        ],
      },
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'front-page',
            entryFile: 'templates/front-page.html',
            routeHint: 'home',
            chainFiles: [
              'templates/front-page.html',
              'patterns/front-page.php',
              'patterns/banner.php',
              'patterns/projects.php',
            ],
            patternSlugs: ['profolio-fse/front-page'],
            templatePartSlugs: ['header', 'footer'],
            blockTypes: ['core/group'],
            headingTexts: ['Welcome To My Profile', 'Some Of My Projects'],
            customClasses: [],
            assetFiles: [],
            notes: [],
          },
        ],
        behaviorSignals: [],
        notes: [],
      },
    } as unknown as RepoThemeManifest;

    const content = {
      pages: [
        {
          id: 9,
          slug: 'home',
          title: 'Home',
          content: '<!-- wp:pattern {"slug":"profolio-fse/front-page"} /-->',
          template: '',
        },
      ],
      posts: [],
      dbTemplates: [
        {
          id: 1,
          postType: 'wp_template',
          canonicalSlug: 'front-page',
          slug: 'front-page',
          themeSlug: 'profolio-fse',
          content: '<!-- wp:pattern {"slug":"profolio-fse/front-page"} /-->',
        },
      ],
      readingSettings: {
        showOnFront: 'page',
        pageOnFrontId: 9,
        pageForPostsId: null,
      },
      themeResolvedContent: {
        themeSlug: 'profolio-fse',
        frontPageRoute: '/',
        postsPageRoute: null,
        routes: [
          {
            pageId: 9,
            slug: 'home',
            title: 'Home',
            routePath: '/',
            template: '',
            templateCandidates: ['front-page', 'page'],
            matchedDbTemplateSlugs: ['front-page'],
            pageBlockTypes: ['core/pattern'],
            isFrontPage: true,
            isPostsPage: false,
          },
        ],
        templateRecords: [],
        navigationRecords: [],
        notes: [],
      },
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        dataNeeds: [],
      },
      templateSource:
        '<!-- wp:template-part {"slug":"header"} /--><!-- wp:pattern {"slug":"profolio-fse/front-page"} /--><!-- wp:template-part {"slug":"footer"} /-->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => content.pages,
      findRepresentativePostsForTemplate: () => [],
    });

    expect(candidates[0]?.label).toBe('repo-archetype:front-page');
    expect(candidates.some((candidate) => candidate.label.startsWith('db:')))
      .toBe(true);
  });

  it('does not let representative DB posts override profolio generic single-post layout planning', () => {
    const repoManifest = {
      themeDeepAnalysis: {
        themeSlug: 'profolio-fse',
        routeSources: [
          {
            routeFamily: 'single',
            entryFile: 'templates/single.html',
            sectionBlueprint: ['cover', 'post-content', 'sidebar'],
          },
        ],
      },
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/single.html',
            routeHint: 'single',
            chainFiles: [
              'templates/single.html',
              'patterns/single-post.php',
            ],
            composedSource:
              '<!-- wp:pattern {"slug":"profolio-fse/single-post"} /-->',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/pattern', 'core/post-content'],
            headingTexts: [],
            notes: ['Nested pattern expansion: profolio-fse/single-post'],
          },
        ],
      },
      themeTypeHints: {
        themeSlug: 'profolio-fse',
      },
    } as unknown as RepoThemeManifest;
    const content = {
      pages: [],
      posts: [
        {
          id: 43,
          slug: 'abcdef',
          title: 'Cach tich hop API cua CASSO',
          content: `
<!-- wp:paragraph --><p>Long representative post body.</p><!-- /wp:paragraph -->
<!-- wp:image {"id":81} --><figure><img src="/uploads/casso.png" /></figure><!-- /wp:image -->
<!-- wp:list --><ul><li>Step one</li><li>Step two</li></ul><!-- /wp:list -->
`,
        },
      ],
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
    } as unknown as DbContentResult;

    const candidates = buildPlanningSourceCandidates({
      componentPlan: {
        templateName: 'single',
        type: 'page',
        route: '/post/:slug',
        dataNeeds: ['post-detail', 'posts'],
      },
      templateSource:
        '<!-- wp:template-part {"slug":"header"} /--><!-- wp:pattern {"slug":"profolio-fse/single-post"} /--><!-- wp:template-part {"slug":"footer"} /-->',
      sourceMap: new Map<string, string>(),
      content,
      repoManifest,
      findRepoEntrySourceChain: (templateName, manifest) =>
        manifest?.structureHints.entrySourceChains.find(
          (entry) => entry.entryFile === `templates/${templateName}.html`,
        ),
      inferSourceFile: (templateName) => `templates/${templateName}.html`,
      findRepresentativePagesForTemplate: () => [],
      findRepresentativePostsForTemplate: () => content.posts,
    });

    expect(candidates[0]?.label).toBe('repo-archetype:single');
    expect(candidates.some((candidate) => candidate.label === 'db:post:abcdef'))
      .toBe(false);
  });
});
