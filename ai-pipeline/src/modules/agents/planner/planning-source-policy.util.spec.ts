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
});
