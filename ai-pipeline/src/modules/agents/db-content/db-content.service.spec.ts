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
});
