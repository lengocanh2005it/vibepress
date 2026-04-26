import { Injectable, Logger } from '@nestjs/common';
import {
  WpQueryService,
  WpPost,
  WpPage,
  WpMenu,
  WpSiteInfo,
  WpTaxonomy,
  WpPluginInfo,
  WpSiteCapabilities,
  WpCustomPostType,
  WpDbTemplate,
  WpDbNavigation,
  WpDbGlobalStyle,
  WpCustomCssEntry,
  WpReadingSettings,
  WpResolvedReadingPageRef,
} from '../../sql/wp-query.service.js';
import type {
  DetectedPlugin,
  PluginDiscoverySummary,
} from '../plugin-discovery/plugin-discovery.service.js';
import { PluginDiscoveryService } from '../plugin-discovery/plugin-discovery.service.js';
import { parseDbConnectionString } from '../../../common/utils/db-connection-parser.js';

function rebaseToSiteOrigin(url: string, siteUrl: string): string {
  try {
    const parsed = new URL(url);
    const site = new URL(siteUrl);
    if (parsed.origin !== site.origin) {
      parsed.protocol = site.protocol;
      parsed.hostname = site.hostname;
      parsed.port = site.port;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface DbContentResult {
  siteInfo: WpSiteInfo;
  posts: WpPost[];
  pages: WpPage[];
  menus: WpMenu[];
  dbNavigations: WpDbNavigation[];
  dbTemplates: WpDbTemplate[];
  dbGlobalStyles: WpDbGlobalStyle[];
  customCssEntries: WpCustomCssEntry[];
  readingSettings: WpReadingSettings;
  /** All public taxonomies (categories, tags, custom) with their terms */
  taxonomies: WpTaxonomy[];
  plugins: WpPluginInfo[];
  /** Non-built-in post types registered by plugins, with counts and associated taxonomies */
  customPostTypes: WpCustomPostType[];
  capabilities: WpSiteCapabilities;
  detectedPlugins: DetectedPlugin[];
  discovery: PluginDiscoverySummary;
}

@Injectable()
export class DbContentService {
  private readonly logger = new Logger(DbContentService.name);

  constructor(
    private readonly wpQuery: WpQueryService,
    private readonly pluginDiscovery: PluginDiscoveryService,
  ) {}

  async extract(connectionString: string): Promise<DbContentResult> {
    const { database } = parseDbConnectionString(connectionString);
    this.logger.log(`Extracting WP content from DB: ${database}`);

    const [
      siteInfo,
      posts,
      pages,
      menus,
      dbNavigations,
      dbTemplates,
      dbGlobalStyles,
      customCssEntries,
      readingSettings,
      taxonomies,
      runtimeFeatures,
    ] = await Promise.all([
      this.wpQuery.getSiteInfo(connectionString),
      this.wpQuery.getPosts(connectionString),
      this.wpQuery.getPages(connectionString),
      this.wpQuery.getMenus(connectionString),
      this.wpQuery.getDbNavigations(connectionString),
      this.wpQuery.getDbTemplates(connectionString),
      this.wpQuery.getDbGlobalStyles(connectionString),
      this.wpQuery.getCustomCssEntries(connectionString),
      this.wpQuery.getReadingSettings(connectionString),
      this.wpQuery.getTaxonomies(connectionString),
      this.wpQuery.getRuntimeFeatures(connectionString),
    ]);
    const enrichedReadingSettings = this.materializeReadingSettings(
      readingSettings,
      pages,
    );

    const discovery = await this.pluginDiscovery.discover({
      siteInfo,
      runtimeFeatures,
    });

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus, ${dbNavigations.length} db navigations, ` +
        `${dbTemplates.length} db templates, ${dbGlobalStyles.length} db global styles, ${customCssEntries.length} custom css entries, ` +
        `${taxonomies.length} taxonomies (${taxonomies.map((t) => `${t.taxonomy}:${t.terms.length}`).join(', ')})` +
        `${discovery.detectedPlugins.length > 0 ? `, detected plugins: ${discovery.detectedPlugins.map((plugin) => plugin.slug).join(', ')}` : ''}`,
    );

    // Normalize featured image URLs — guid values can still reference the old
    // host (e.g. localhost:8000) when a DB was migrated without search-replace.
    const siteUrl = siteInfo.siteUrl;
    if (siteUrl) {
      for (const post of posts) {
        if (post.featuredImage)
          post.featuredImage = rebaseToSiteOrigin(post.featuredImage, siteUrl);
      }
      for (const page of pages) {
        if (page.featuredImage)
          page.featuredImage = rebaseToSiteOrigin(page.featuredImage, siteUrl);
      }
    }

    return {
      siteInfo,
      posts,
      pages,
      menus,
      dbNavigations,
      dbTemplates,
      dbGlobalStyles,
      customCssEntries,
      readingSettings: enrichedReadingSettings,
      taxonomies,
      plugins: runtimeFeatures.plugins,
      customPostTypes: runtimeFeatures.customPostTypes,
      capabilities: runtimeFeatures.capabilities,
      detectedPlugins: discovery.detectedPlugins,
      discovery: discovery.summary,
    };
  }

  private materializeReadingSettings(
    readingSettings: WpReadingSettings,
    pages: WpPage[],
  ): WpReadingSettings {
    const resolvePageRef = (
      pageId: number | null,
    ): WpResolvedReadingPageRef | null => {
      if (pageId === null) return null;
      const page = pages.find((entry) => Number(entry.id) === Number(pageId));
      if (!page) return null;
      return {
        id: page.id,
        slug: page.slug,
        title: page.title,
        template: page.template,
      };
    };

    return {
      ...readingSettings,
      pageOnFront: resolvePageRef(readingSettings.pageOnFrontId),
      pageForPosts: resolvePageRef(readingSettings.pageForPostsId),
    };
  }
}
