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
  WpCommerceInfo,
  WpCustomPostType,
} from '../../sql/wp-query.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import type {
  DetectedPlugin,
  PluginDiscoverySummary,
} from '../plugin-discovery/plugin-discovery.service.js';
import { PluginDiscoveryService } from '../plugin-discovery/plugin-discovery.service.js';

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
  commerce: WpCommerceInfo;
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

  async extract(creds: WpDbCredentials): Promise<DbContentResult> {
    this.logger.log(`Extracting WP content from DB: ${creds.dbName}`);

    const [siteInfo, posts, pages, menus, taxonomies, runtimeFeatures] =
      await Promise.all([
        this.wpQuery.getSiteInfo(creds),
        this.wpQuery.getPosts(creds),
        this.wpQuery.getPages(creds),
        this.wpQuery.getMenus(creds),
        this.wpQuery.getTaxonomies(creds),
        this.wpQuery.getRuntimeFeatures(creds),
      ]);
    const discovery = await this.pluginDiscovery.discover({
      siteInfo,
      runtimeFeatures,
    });

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus, ` +
        `${taxonomies.length} taxonomies (${taxonomies.map((t) => `${t.taxonomy}:${t.terms.length}`).join(', ')})` +
        `${runtimeFeatures.capabilities.wooCommerce ? `, WooCommerce (${runtimeFeatures.commerce.productsCount} products)` : ''}` +
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
      commerce: runtimeFeatures.commerce,
      detectedPlugins: discovery.detectedPlugins,
      discovery: discovery.summary,
    };
  }
}
