import { DbContentService } from './db-content.service.js';
import type {
  WpCustomCssEntry,
  WpDbGlobalStyle,
  WpDbNavigation,
  WpDbTemplate,
  WpMediaAttachment,
  WpMenu,
  WpPage,
  WpPluginInfo,
  WpPost,
  WpReadingSettings,
  WpSiteCapabilities,
  WpSiteInfo,
  WpTaxonomy,
} from '../../sql/wp-query.service.js';
import type { DetectedPlugin } from '../plugin-discovery/plugin-discovery.service.js';

describe('DbContentService theme-scoped filtering', () => {
  it('drops stale db templates and global styles that belong to a different theme', async () => {
    const siteInfo: WpSiteInfo = {
      siteUrl: 'http://localhost:8000',
      siteName: 'Demo',
      blogDescription: '',
      logoUrl: null,
      adminEmail: 'demo@example.com',
      language: 'en',
      activeTheme: 'profolio-fse',
      templateTheme: 'profolio-fse',
      tablePrefix: 'wp_',
    };

    const dbTemplates: WpDbTemplate[] = [
      {
        id: 1,
        postType: 'wp_template',
        title: 'Stale Home',
        slug: 'home',
        canonicalSlug: 'home',
        themeSlug: 'twentytwentyfour',
        area: null,
        sourceEntityKey: 'twentytwentyfour//home',
        content: '<!-- stale -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group'],
      },
      {
        id: 2,
        postType: 'wp_template_part',
        title: 'Footer',
        slug: 'footer',
        canonicalSlug: 'footer',
        themeSlug: 'profolio-fse',
        area: 'footer',
        sourceEntityKey: 'profolio-fse//footer',
        content: '<!-- active -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group'],
      },
      {
        id: 3,
        postType: 'wp_template_part',
        title: 'Legacy Shared Part',
        slug: 'legacy-shared',
        canonicalSlug: 'legacy-shared',
        themeSlug: null,
        area: null,
        sourceEntityKey: 'legacy-shared',
        content: '<!-- unscoped -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group'],
      },
    ];

    const dbGlobalStyles: WpDbGlobalStyle[] = [
      {
        id: 10,
        title: 'Old Theme Styles',
        slug: 'wp-global-styles-twentytwentyfour',
        themeSlug: 'twentytwentyfour',
        content: '{"styles":{"color":{"background":"#000000"}}}',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
      },
      {
        id: 11,
        title: 'Active Theme Styles',
        slug: 'wp-global-styles-profolio-fse',
        themeSlug: 'profolio-fse',
        content: '{"styles":{"color":{"background":"#ffffff"}}}',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
      },
    ];

    const wpQuery = {
      getSiteInfo: jest.fn().mockResolvedValue(siteInfo),
      getPosts: jest.fn().mockResolvedValue([] satisfies WpPost[]),
      getPages: jest.fn().mockResolvedValue([] satisfies WpPage[]),
      getMenus: jest.fn().mockResolvedValue([] satisfies WpMenu[]),
      getDbNavigations: jest
        .fn()
        .mockResolvedValue([] satisfies WpDbNavigation[]),
      getDbTemplates: jest.fn().mockResolvedValue(dbTemplates),
      getDbGlobalStyles: jest.fn().mockResolvedValue(dbGlobalStyles),
      getCustomCssEntries: jest
        .fn()
        .mockResolvedValue([] satisfies WpCustomCssEntry[]),
      getReadingSettings: jest.fn().mockResolvedValue({
        showOnFront: 'posts',
        pageOnFrontId: null,
        pageForPostsId: null,
        pageOnFront: null,
        pageForPosts: null,
      } satisfies WpReadingSettings),
      getTaxonomies: jest.fn().mockResolvedValue([] satisfies WpTaxonomy[]),
      getRuntimeFeatures: jest.fn().mockResolvedValue({
        plugins: [] satisfies WpPluginInfo[],
        customPostTypes: [],
        capabilities: {
          activePluginSlugs: [],
          hasWooCommerce: false,
          hasContactForm7: false,
          hasElementor: false,
          hasSpectra: false,
          usesBlockTheme: true,
        } satisfies WpSiteCapabilities,
      }),
      getMediaAttachments: jest
        .fn()
        .mockResolvedValue([] satisfies WpMediaAttachment[]),
    } as any;

    const pluginDiscovery = {
      discover: jest.fn().mockResolvedValue({
        detectedPlugins: [] satisfies DetectedPlugin[],
        summary: {
          detectedPlugins: [],
          topBlockTypes: [],
        },
      }),
    } as any;

    const service = new DbContentService(wpQuery, pluginDiscovery);

    const result = await service.extract(
      'mysql://root:pass@localhost:3306/site_wp_demo',
    );

    expect(result.dbTemplates.map((entry) => entry.id)).toEqual([2, 3]);
    expect(result.dbGlobalStyles.map((entry) => entry.id)).toEqual([11]);
    expect(result.parsedGlobalStyles).not.toBeNull();
    expect(result.dbGlobalStyles[0]?.slug).toBe(
      'wp-global-styles-profolio-fse',
    );
  });

  it('builds a profolio-fse resolved route and template bundle from DB content', async () => {
    const siteInfo: WpSiteInfo = {
      siteUrl: 'http://localhost:8000',
      siteName: 'Demo',
      blogDescription: '',
      logoUrl: null,
      adminEmail: 'demo@example.com',
      language: 'en',
      activeTheme: 'profolio-fse',
      templateTheme: 'profolio-fse',
      tablePrefix: 'wp_',
    };

    const pages: WpPage[] = [
      {
        id: 11,
        title: 'Home',
        content: '<!-- wp:group --><div></div><!-- /wp:group -->',
        slug: 'home',
        parentId: 0,
        menuOrder: 0,
        template: '',
        featuredImage: null,
      },
      {
        id: 12,
        title: 'About Us',
        content:
          '<!-- wp:group --><div></div><!-- /wp:group --><!-- wp:cover --><div></div><!-- /wp:cover -->',
        slug: 'sample-page',
        parentId: 0,
        menuOrder: 1,
        template: 'templates/template-about.html',
        featuredImage: null,
      },
      {
        id: 13,
        title: 'Services',
        content: '<!-- wp:columns --><div></div><!-- /wp:columns -->',
        slug: 'senior-swe',
        parentId: 0,
        menuOrder: 2,
        template: 'template-services.html',
        featuredImage: null,
      },
    ];

    const dbTemplates: WpDbTemplate[] = [
      {
        id: 20,
        postType: 'wp_template',
        title: 'Front Page',
        slug: 'front-page',
        canonicalSlug: 'front-page',
        themeSlug: 'profolio-fse',
        area: null,
        sourceEntityKey: 'profolio-fse//front-page',
        content: '<!-- wp:pattern {"slug":"profolio-fse/front-page"} /-->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/pattern'],
      },
      {
        id: 21,
        postType: 'wp_template',
        title: 'Template About',
        slug: 'template-about',
        canonicalSlug: 'template-about',
        themeSlug: 'profolio-fse',
        area: null,
        sourceEntityKey: 'profolio-fse//template-about',
        content: '<!-- wp:group --><div></div><!-- /wp:group -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group'],
      },
      {
        id: 22,
        postType: 'wp_template',
        title: 'Template Services',
        slug: 'template-services',
        canonicalSlug: 'template-services',
        themeSlug: 'profolio-fse',
        area: null,
        sourceEntityKey: 'profolio-fse//template-services',
        content: '<!-- wp:group --><div></div><!-- /wp:group -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group'],
      },
      {
        id: 23,
        postType: 'wp_template_part',
        title: 'Header',
        slug: 'header',
        canonicalSlug: 'header',
        themeSlug: 'profolio-fse',
        area: 'header',
        sourceEntityKey: 'profolio-fse//header',
        content:
          '<!-- wp:group --><header id="sticky-header"></header><!-- /wp:group -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/group', 'core/navigation'],
      },
      {
        id: 24,
        postType: 'wp_template_part',
        title: 'Footer',
        slug: 'footer',
        canonicalSlug: 'footer',
        themeSlug: 'profolio-fse',
        area: 'footer',
        sourceEntityKey: 'profolio-fse//footer',
        content:
          '<!-- wp:paragraph {"className":"profolio-fse-scroll-top"} --><p class="profolio-fse-scroll-top"></p><!-- /wp:paragraph -->',
        status: 'publish',
        modified: '2026-05-03 00:00:00',
        blockTypes: ['core/paragraph'],
      },
    ];

    const wpQuery = {
      getSiteInfo: jest.fn().mockResolvedValue(siteInfo),
      getPosts: jest.fn().mockResolvedValue([] satisfies WpPost[]),
      getPages: jest.fn().mockResolvedValue(pages),
      getMenus: jest.fn().mockResolvedValue([
        {
          name: 'Primary',
          slug: 'primary',
          location: 'primary',
          items: [
            {
              id: 1,
              title: 'About Us',
              url: '/sample-page',
              order: 0,
              parentId: 0,
              target: null,
            },
            {
              id: 2,
              title: 'Services',
              url: '/senior-swe',
              order: 1,
              parentId: 0,
              target: null,
            },
          ],
        },
      ] satisfies WpMenu[]),
      getDbNavigations: jest.fn().mockResolvedValue([
        {
          id: 31,
          title: 'Primary',
          slug: 'primary',
          content: '',
          status: 'publish',
          modified: '2026-05-03 00:00:00',
          location: 'primary',
          items: [
            {
              id: 1,
              title: 'About Us',
              url: '/sample-page',
              order: 0,
              parentId: 0,
              target: null,
            },
          ],
          blockTypes: ['core/navigation-link'],
        },
      ] satisfies WpDbNavigation[]),
      getDbTemplates: jest.fn().mockResolvedValue(dbTemplates),
      getDbGlobalStyles: jest
        .fn()
        .mockResolvedValue([] satisfies WpDbGlobalStyle[]),
      getCustomCssEntries: jest
        .fn()
        .mockResolvedValue([] satisfies WpCustomCssEntry[]),
      getReadingSettings: jest.fn().mockResolvedValue({
        showOnFront: 'page',
        pageOnFrontId: 11,
        pageForPostsId: null,
        pageOnFront: null,
        pageForPosts: null,
      } satisfies WpReadingSettings),
      getTaxonomies: jest.fn().mockResolvedValue([] satisfies WpTaxonomy[]),
      getRuntimeFeatures: jest.fn().mockResolvedValue({
        plugins: [] satisfies WpPluginInfo[],
        customPostTypes: [],
        capabilities: {
          activePluginSlugs: [],
        } satisfies WpSiteCapabilities,
      }),
      getMediaAttachments: jest
        .fn()
        .mockResolvedValue([] satisfies WpMediaAttachment[]),
    } as any;

    const pluginDiscovery = {
      discover: jest.fn().mockResolvedValue({
        detectedPlugins: [] satisfies DetectedPlugin[],
        summary: {
          detectedPlugins: [],
          topBlockTypes: [],
        },
      }),
    } as any;

    const service = new DbContentService(wpQuery, pluginDiscovery);
    const result = await service.extract(
      'mysql://root:pass@localhost:3306/site_wp_demo',
    );

    expect(result.themeResolvedContent?.themeSlug).toBe('profolio-fse');
    expect(result.themeResolvedContent?.frontPageRoute).toBe('/');
    expect(
      result.themeResolvedContent?.routes.find(
        (route) => route.slug === 'sample-page',
      ),
    ).toMatchObject({
      routePath: '/sample-page',
      templateCandidates: expect.arrayContaining(['template-about']),
      matchedDbTemplateSlugs: ['template-about'],
    });
    expect(
      result.themeResolvedContent?.templateRecords
        .filter((entry) => entry.postType === 'wp_template_part')
        .map((entry) => entry.canonicalSlug),
    ).toEqual(expect.arrayContaining(['header', 'footer']));
    expect(
      result.themeResolvedContent?.navigationRecords.find(
        (entry) => entry.location === 'primary' && entry.kind === 'menu',
      )?.itemUrls,
    ).toEqual(expect.arrayContaining(['/sample-page', '/senior-swe']));
  });
});
