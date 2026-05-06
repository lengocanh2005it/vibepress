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

  it('uses theme resolved template candidates for profolio fixed-slug pages', () => {
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
          content: '<!-- db template -->',
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
        dataNeeds: ['pageDetail'],
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
});
