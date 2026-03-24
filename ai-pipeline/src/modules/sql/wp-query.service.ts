import { Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';

export interface WpPost {
  id: number;
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  type: string;
  status: string;
}

export interface WpPage {
  id: number;
  title: string;
  content: string;
  slug: string;
  menuOrder: number;
  template: string;
}

export interface WpMenu {
  name: string;
  slug: string;
  items: WpMenuItem[];
}

export interface WpMenuItem {
  id: number;
  title: string;
  url: string;
  order: number;
  parentId: number;
}

export interface WpSiteInfo {
  siteUrl: string;
  siteName: string;
  blogDescription: string;
  adminEmail: string;
  language: string;
  tablePrefix: string;
}

@Injectable()
export class WpQueryService {
  private readonly logger = new Logger(WpQueryService.name);

  constructor() {}

  async getPosts(creds: WpDbCredentials): Promise<WpPost[]> {
    const conn = await this.createConnection(creds);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT ID, post_title, post_content, post_excerpt, post_name, post_type, post_status
         FROM \`${prefix}posts\`
         WHERE post_type = 'post' AND post_status = 'publish'`,
      );
      return rows.map(this.mapPost);
    } finally {
      await conn.end();
    }
  }

  async getPages(creds: WpDbCredentials): Promise<WpPage[]> {
    const conn = await this.createConnection(creds);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.menu_order,
                COALESCE(pm.meta_value, '') AS template
         FROM \`${prefix}posts\` p
         LEFT JOIN \`${prefix}postmeta\` pm
           ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
         WHERE p.post_type = 'page' AND p.post_status = 'publish'
         ORDER BY p.menu_order`,
      );
      return rows.map(this.mapPage);
    } finally {
      await conn.end();
    }
  }

  async getMenus(creds: WpDbCredentials): Promise<WpMenu[]> {
    const conn = await this.createConnection(creds);
    try {
      const prefix = await this.getTablePrefix(conn);

      // Lấy tất cả nav_menu terms
      const [menus] = await conn.query<any[]>(
        `SELECT t.term_id, t.name, t.slug
         FROM \`${prefix}terms\` t
         INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
         WHERE tt.taxonomy = 'nav_menu'`,
      );

      const result: WpMenu[] = [];

      for (const menu of menus) {
        const [items] = await conn.query<any[]>(
          `SELECT p.ID, p.post_title, p.menu_order,
                  url_meta.meta_value AS url,
                  parent_meta.meta_value AS parent_id
           FROM \`${prefix}posts\` p
           INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
           INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           LEFT JOIN \`${prefix}postmeta\` url_meta ON url_meta.post_id = p.ID AND url_meta.meta_key = '_menu_item_url'
           LEFT JOIN \`${prefix}postmeta\` parent_meta ON parent_meta.post_id = p.ID AND parent_meta.meta_key = '_menu_item_menu_item_parent'
           WHERE tt.term_id = ? AND p.post_type = 'nav_menu_item' AND p.post_status = 'publish'
           ORDER BY p.menu_order`,
          [menu.term_id],
        );

        result.push({
          name: menu.name,
          slug: menu.slug,
          items: items.map((item) => ({
            id: item.ID,
            title: item.post_title,
            url: item.url ?? '',
            order: item.menu_order,
            parentId: parseInt(item.parent_id ?? '0', 10),
          })),
        });
      }

      return result;
    } finally {
      await conn.end();
    }
  }

  async getActiveTheme(creds: WpDbCredentials): Promise<string> {
    const conn = await this.createConnection(creds);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'stylesheet' LIMIT 1`,
      );
      return rows[0]?.option_value ?? '';
    } finally {
      await conn.end();
    }
  }

  async getSiteInfo(creds: WpDbCredentials): Promise<WpSiteInfo> {
    const conn = await this.createConnection(creds);
    try {
      const prefix = await this.getTablePrefix(conn);
      const keys = [
        'siteurl',
        'blogname',
        'blogdescription',
        'admin_email',
        'WPLANG',
      ];
      const [rows] = await conn.query<any[]>(
        `SELECT option_name, option_value FROM \`${prefix}options\`
         WHERE option_name IN (${keys.map(() => '?').join(',')})`,
        keys,
      );
      const opts: Record<string, string> = {};
      for (const row of rows) opts[row.option_name] = row.option_value;

      return {
        siteUrl: opts['siteurl'] ?? '',
        siteName: opts['blogname'] ?? '',
        blogDescription: opts['blogdescription'] ?? '',
        adminEmail: opts['admin_email'] ?? '',
        language: opts['WPLANG'] ?? 'en',
        tablePrefix: prefix,
      };
    } finally {
      await conn.end();
    }
  }

  // Tự detect table prefix từ information_schema
  private async getTablePrefix(
    conn: Awaited<ReturnType<typeof createConnection>>,
  ): Promise<string> {
    const [rows] = await conn.query<any[]>(
      `SELECT table_name AS tableName FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name LIKE '%options' LIMIT 1`,
    );
    if (!rows.length) return 'wp_';
    const tableName: string = rows[0].tableName;
    return tableName.replace(/options$/, '');
  }

  private async createConnection(creds: WpDbCredentials) {
    return createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.dbName,
    });
  }

  private mapPost(row: any): WpPost {
    return {
      id: row.ID,
      title: row.post_title,
      content: row.post_content,
      excerpt: row.post_excerpt,
      slug: row.post_name,
      type: row.post_type,
      status: row.post_status,
    };
  }

  private mapPage(row: any): WpPage {
    return {
      id: row.ID,
      title: row.post_title,
      content: row.post_content,
      slug: row.post_name,
      menuOrder: row.menu_order,
      template: row.template,
    };
  }
}
