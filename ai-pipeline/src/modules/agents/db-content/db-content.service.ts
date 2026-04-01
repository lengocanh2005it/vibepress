import { Injectable, Logger } from '@nestjs/common';
import {
  WpQueryService,
  WpPost,
  WpPage,
  WpMenu,
  WpSiteInfo,
  WpTaxonomy,
} from '../../sql/wp-query.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export interface DbContentResult {
  siteInfo: WpSiteInfo;
  posts: WpPost[];
  pages: WpPage[];
  menus: WpMenu[];
  /** All public taxonomies (categories, tags, custom) with their terms */
  taxonomies: WpTaxonomy[];
}

@Injectable()
export class DbContentService {
  private readonly logger = new Logger(DbContentService.name);

  constructor(private readonly wpQuery: WpQueryService) {}

  async extract(creds: WpDbCredentials): Promise<DbContentResult> {
    this.logger.log(`Extracting WP content from DB: ${creds.dbName}`);

    const [siteInfo, posts, pages, menus, taxonomies] = await Promise.all([
      this.wpQuery.getSiteInfo(creds),
      this.wpQuery.getPosts(creds),
      this.wpQuery.getPages(creds),
      this.wpQuery.getMenus(creds),
      this.wpQuery.getTaxonomies(creds),
    ]);

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus, ` +
      `${taxonomies.length} taxonomies (${taxonomies.map((t) => `${t.taxonomy}:${t.terms.length}`).join(', ')})`,
    );

    return { siteInfo, posts, pages, menus, taxonomies };
  }
}
