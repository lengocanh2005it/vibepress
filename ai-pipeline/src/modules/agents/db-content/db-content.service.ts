import { Injectable, Logger } from '@nestjs/common';
import {
  WpQueryService,
  WpPost,
  WpPage,
  WpMenu,
  WpSiteInfo,
} from '../../sql/wp-query.service.js';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export interface DbContentResult {
  siteInfo: WpSiteInfo;
  posts: WpPost[];
  pages: WpPage[];
  menus: WpMenu[];
}

@Injectable()
export class DbContentService {
  private readonly logger = new Logger(DbContentService.name);

  constructor(private readonly wpQuery: WpQueryService) {}

  async extract(creds: WpDbCredentials): Promise<DbContentResult> {
    this.logger.log(`Extracting WP content from DB: ${creds.dbName}`);

    const [siteInfo, posts, pages, menus] = await Promise.all([
      this.wpQuery.getSiteInfo(creds),
      this.wpQuery.getPosts(creds),
      this.wpQuery.getPages(creds),
      this.wpQuery.getMenus(creds),
    ]);

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus`,
    );

    return { siteInfo, posts, pages, menus };
  }
}
