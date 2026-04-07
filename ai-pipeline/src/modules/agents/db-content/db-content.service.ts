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
} from '../../sql/wp-query.service.js';
import type {
  DetectedPlugin,
  PluginDiscoverySummary,
} from '../plugin-discovery/plugin-discovery.service.js';
import { PluginDiscoveryService } from '../plugin-discovery/plugin-discovery.service.js';
import { parseDbConnectionString } from '../../../common/utils/db-connection-parser.js';

export interface DbContentResult {
  siteInfo: WpSiteInfo;
  posts: WpPost[];
  pages: WpPage[];
  menus: WpMenu[];
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

    const [siteInfo, posts, pages, menus, taxonomies, runtimeFeatures] =
      await Promise.all([
        this.wpQuery.getSiteInfo(connectionString),
        this.wpQuery.getPosts(connectionString),
        this.wpQuery.getPages(connectionString),
        this.wpQuery.getMenus(connectionString),
        this.wpQuery.getTaxonomies(connectionString),
        this.wpQuery.getRuntimeFeatures(connectionString),
      ]);
    const discovery = await this.pluginDiscovery.discover({
      siteInfo,
      runtimeFeatures,
    });

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus, ` +
        `${taxonomies.length} taxonomies (${taxonomies.map((t) => `${t.taxonomy}:${t.terms.length}`).join(', ')})` +
        `${discovery.detectedPlugins.length > 0 ? `, detected plugins: ${discovery.detectedPlugins.map((plugin) => plugin.slug).join(', ')}` : ''}`,
    );

    return {
      siteInfo,
      posts,
      pages,
      menus,
      taxonomies,
      plugins: runtimeFeatures.plugins,
      customPostTypes: runtimeFeatures.customPostTypes,
      capabilities: runtimeFeatures.capabilities,
      detectedPlugins: discovery.detectedPlugins,
      discovery: discovery.summary,
    };
  }
}
