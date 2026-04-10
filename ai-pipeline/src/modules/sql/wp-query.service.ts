import { Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';
import { parseDbConnectionString } from '../../common/utils/db-connection-parser.js';

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
  /** WordPress theme location slug (e.g. "primary", "footer-about"). null when not assigned. */
  location: string | null;
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
  logoUrl: string | null;
  adminEmail: string;
  language: string;
  tablePrefix: string;
}

export interface WpThemeRuntimeConfig {
  stylesheet: string;
  template: string;
}

export interface WpPluginInfo {
  slug: string;
  pluginFile: string;
  active: boolean;
  source: 'active_plugins' | 'heuristic';
}

export interface WpSiteCapabilities {
  activePluginSlugs: string[];
}

export interface WpMetaKeyUsage {
  metaKey: string;
  count: number;
}

export interface WpShortcodeUsage {
  shortcode: string;
  count: number;
}

export interface WpBlockTypeUsage {
  blockType: string;
  count: number;
}

export interface WpElementorDocument {
  postId: number;
  postType: string;
  slug: string;
  title: string;
  widgetTypes: string[];
}

export interface WpCustomPostType {
  postType: string;
  count: number;
  /** Taxonomy slugs associated with this post type, e.g. ['product_cat', 'product_tag'] */
  taxonomies: string[];
}

export interface WpRuntimeFeatures {
  plugins: WpPluginInfo[];
  metaKeys: WpMetaKeyUsage[];
  shortcodes: WpShortcodeUsage[];
  blockTypes: WpBlockTypeUsage[];
  optionKeys: string[];
  elementorDocuments: WpElementorDocument[];
  customPostTypes: WpCustomPostType[];
  capabilities: WpSiteCapabilities;
}

export interface WpTaxonomyTerm {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;
  parentId: number;
}

export interface WpTaxonomy {
  /** taxonomy slug, e.g. 'category', 'post_tag', or any custom taxonomy */
  taxonomy: string;
  terms: WpTaxonomyTerm[];
}

@Injectable()
export class WpQueryService {
  private readonly logger = new Logger(WpQueryService.name);

  constructor() {}

  async getPosts(connectionString: string): Promise<WpPost[]> {
    const conn = await this.createConnection(connectionString);
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

  async getPages(connectionString: string): Promise<WpPage[]> {
    const conn = await this.createConnection(connectionString);
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

  async getMenus(connectionString: string): Promise<WpMenu[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);

      // Lấy tất cả nav_menu terms
      const [menus] = await conn.query<any[]>(
        `SELECT t.term_id, t.name, t.slug
         FROM \`${prefix}terms\` t
         INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
         WHERE tt.taxonomy = 'nav_menu'`,
      );

      // Build termId → location map from WordPress theme_mods
      const locationMap = await this.queryNavMenuLocations(conn, prefix);

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
          location: locationMap.get(menu.term_id) ?? null,
          items: items.map((item) => ({
            id: item.ID,
            title: item.post_title,
            url: item.url ?? '',
            order: item.menu_order,
            parentId: parseInt(item.parent_id ?? '0', 10),
          })),
        });
      }

      // Heuristic fallback: if no location assignments found, infer primary nav
      // by matching slug patterns, then by item count (largest menu = main nav).
      if (result.length > 0 && result.every((m) => !m.location)) {
        const primaryBySlug = result.find((m) =>
          /^(primary|main|header|navigation|nav|top|menu)/i.test(m.slug),
        );
        const primaryBySize = result.reduce((a, b) =>
          a.items.length >= b.items.length ? a : b,
        );
        const primary = primaryBySlug ?? primaryBySize;
        for (const m of result) {
          if (m === primary) m.location = 'primary';
        }
      }

      return result;
    } finally {
      await conn.end();
    }
  }

  /**
   * Read nav_menu_locations from WordPress theme_mods option.
   * Returns a Map of { termId → locationSlug }.
   * Returns an empty Map if the option is missing or unparseable.
   */
  private async queryNavMenuLocations(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
  ): Promise<Map<number, string>> {
    try {
      // Get active stylesheet to find the right theme_mods option
      const [[stylesheetRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'stylesheet' LIMIT 1`,
      );
      const stylesheet = stylesheetRow?.option_value as string | undefined;
      if (!stylesheet) return new Map();

      const [[modsRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = ? LIMIT 1`,
        [`theme_mods_${stylesheet}`],
      );
      const serialized = modsRow?.option_value as string | undefined;
      if (!serialized) return new Map();

      // Parse PHP serialized array to extract nav_menu_locations
      const parsed = phpUnserializeSimple(serialized);
      const locations = parsed?.nav_menu_locations as
        | Record<string, number>
        | undefined;
      if (!locations || typeof locations !== 'object') return new Map();

      // Invert: { locationSlug → termId } → Map<termId, locationSlug>
      const map = new Map<number, string>();
      for (const [locationSlug, termId] of Object.entries(locations)) {
        if (termId) map.set(Number(termId), locationSlug);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Get all public taxonomies and their terms.
   * Includes built-in taxonomies (category, post_tag) and any custom ones registered by plugins/themes.
   * Only fetches taxonomies that have at least one published post attached.
   */
  async getTaxonomies(connectionString: string): Promise<WpTaxonomy[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);

      // Fetch all distinct taxonomy slugs that have published posts
      const [taxRows] = await conn.query<any[]>(
        `SELECT DISTINCT tt.taxonomy
         FROM \`${prefix}term_taxonomy\` tt
         INNER JOIN \`${prefix}term_relationships\` tr ON tr.term_taxonomy_id = tt.term_taxonomy_id
         INNER JOIN \`${prefix}posts\` p ON p.ID = tr.object_id
         WHERE p.post_status = 'publish'
           AND tt.taxonomy NOT IN ('nav_menu', 'link_category', 'post_format')
         ORDER BY tt.taxonomy`,
      );

      const result: WpTaxonomy[] = [];

      for (const { taxonomy } of taxRows) {
        const [termRows] = await conn.query<any[]>(
          `SELECT t.term_id, t.name, t.slug, t.term_group,
                  tt.description, tt.count, tt.parent
           FROM \`${prefix}terms\` t
           INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
           WHERE tt.taxonomy = ? AND tt.count > 0
           ORDER BY tt.count DESC, t.name ASC`,
          [taxonomy],
        );

        if (termRows.length === 0) continue;

        result.push({
          taxonomy,
          terms: termRows.map((row) => ({
            id: row.term_id,
            name: row.name,
            slug: row.slug,
            description: row.description ?? '',
            count: row.count,
            parentId: row.parent ?? 0,
          })),
        });
      }

      this.logger.log(
        `Extracted ${result.length} taxonomies: ${result.map((t) => `${t.taxonomy}(${t.terms.length})`).join(', ')}`,
      );

      return result;
    } finally {
      await conn.end();
    }
  }

  async getActiveTheme(connectionString: string): Promise<string> {
    const runtime = await this.getThemeRuntimeConfig(connectionString);
    return runtime.stylesheet;
  }

  async getThemeRuntimeConfig(
    connectionString: string,
  ): Promise<WpThemeRuntimeConfig> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT option_name, option_value FROM \`${prefix}options\`
         WHERE option_name IN ('stylesheet', 'template')`,
      );
      const optionMap = new Map<string, string>();
      for (const row of rows) {
        optionMap.set(String(row.option_name), String(row.option_value ?? ''));
      }
      return {
        stylesheet: optionMap.get('stylesheet') ?? '',
        template: optionMap.get('template') ?? '',
      };
    } finally {
      await conn.end();
    }
  }

  async getSiteInfo(connectionString: string): Promise<WpSiteInfo> {
    const conn = await this.createConnection(connectionString);
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
        logoUrl: await this.resolveCustomLogoUrl(conn, prefix),
        adminEmail: opts['admin_email'] ?? '',
        language: opts['WPLANG'] ?? 'en',
        tablePrefix: prefix,
      };
    } finally {
      await conn.end();
    }
  }

  async getRuntimeFeatures(
    connectionString: string,
  ): Promise<WpRuntimeFeatures> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [optionRows] = await conn.query<any[]>(
        `SELECT option_name, option_value FROM \`${prefix}options\`
         WHERE option_name IN ('active_plugins')
            OR option_name LIKE 'elementor_%'
            OR option_name LIKE 'acf_%'
            OR option_name LIKE 'wpseo_%'`,
      );

      const optionMap = new Map<string, string>();
      for (const row of optionRows) {
        optionMap.set(row.option_name, row.option_value ?? '');
      }

      const activePluginFiles = this.parseSerializedPhpStringArray(
        optionMap.get('active_plugins') ?? '',
      );
      const plugins = activePluginFiles.map<WpPluginInfo>((pluginFile) => ({
        slug: pluginFile.split('/')[0] || pluginFile,
        pluginFile,
        active: true,
        source: 'active_plugins',
      }));
      const optionKeys = optionRows
        .map((row) => String(row.option_name))
        .filter((name) => name !== 'active_plugins')
        .sort();

      const explicitMetaKeys = ['_elementor_data', '_elementor_css'];
      const metaLikeClauses = [
        'meta_key LIKE ?',
        'meta_key LIKE ?',
        'meta_key LIKE ?',
      ].join(' OR ');
      const [metaKeyRows] = await conn.query<any[]>(
        `SELECT meta_key, COUNT(*) AS cnt
         FROM \`${prefix}postmeta\`
         WHERE meta_key IN (${explicitMetaKeys.map(() => '?').join(',')})
            OR ${metaLikeClauses}
         GROUP BY meta_key
         ORDER BY cnt DESC, meta_key ASC`,
        [...explicitMetaKeys, 'elementor_%', 'acf_%', '_acf_%'],
      );
      const metaKeys: WpMetaKeyUsage[] = metaKeyRows.map((row) => ({
        metaKey: String(row.meta_key),
        count: Number(row.cnt),
      }));

      const [shortcodeRows] = await conn.query<any[]>(
        `SELECT post_content
         FROM \`${prefix}posts\`
         WHERE post_status IN ('publish', 'private')
           AND post_content LIKE '%[%'`,
      );
      const [blockRows] = await conn.query<any[]>(
        `SELECT post_content
         FROM \`${prefix}posts\`
         WHERE post_status IN ('publish', 'private')
           AND post_content LIKE '%<!-- wp:%'`,
      );
      const [elementorRows] = await conn.query<any[]>(
        `SELECT p.ID, p.post_type, p.post_name, p.post_title, pm.meta_value
         FROM \`${prefix}posts\` p
         INNER JOIN \`${prefix}postmeta\` pm
           ON pm.post_id = p.ID AND pm.meta_key = '_elementor_data'
         WHERE p.post_status IN ('publish', 'private')`,
      );

      const shortcodes = this.collectUsage(
        shortcodeRows.map((row) => String(row.post_content ?? '')),
        /\[([a-z0-9_-]+)/gi,
      ).map(([shortcode, count]) => ({ shortcode, count }));
      const blockTypes = this.collectUsage(
        blockRows.map((row) => String(row.post_content ?? '')),
        /<!--\s*wp:([a-z0-9/-]+)/gi,
      ).map(([blockType, count]) => ({ blockType, count }));
      const elementorDocuments: WpElementorDocument[] = elementorRows.map(
        (row) => ({
          postId: Number(row.ID),
          postType: String(row.post_type),
          slug: String(row.post_name ?? ''),
          title: String(row.post_title ?? ''),
          widgetTypes: this.extractElementorWidgetTypes(
            String(row.meta_value ?? ''),
          ),
        }),
      );

      const activePluginSlugs = Array.from(
        new Set(plugins.map((plugin) => plugin.slug).filter(Boolean)),
      ).sort();

      // Detect custom post types registered by plugins (excludes all WP built-ins)
      const BUILTIN_POST_TYPES = [
        'post',
        'page',
        'attachment',
        'revision',
        'nav_menu_item',
        'custom_css',
        'customize_changeset',
        'oembed_cache',
        'user_request',
        'wp_block',
        'wp_template',
        'wp_template_part',
        'wp_global_styles',
        'wp_navigation',
        'wp_font_face',
        'wp_font_family',
      ];
      const ph = BUILTIN_POST_TYPES.map(() => '?').join(',');
      const [cptCountRows] = await conn.query<any[]>(
        `SELECT post_type, COUNT(*) AS cnt
         FROM \`${prefix}posts\`
         WHERE post_status IN ('publish', 'private')
           AND post_type NOT IN (${ph})
         GROUP BY post_type
         ORDER BY cnt DESC`,
        BUILTIN_POST_TYPES,
      );
      const [cptTaxRows] = await conn.query<any[]>(
        `SELECT DISTINCT p.post_type, tt.taxonomy
         FROM \`${prefix}posts\` p
         INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
         INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         WHERE p.post_status IN ('publish', 'private')
           AND p.post_type NOT IN (${ph})
           AND tt.taxonomy NOT IN ('nav_menu', 'link_category', 'post_format')`,
        BUILTIN_POST_TYPES,
      );
      const cptTaxMap = new Map<string, string[]>();
      for (const row of cptTaxRows) {
        const arr = cptTaxMap.get(row.post_type) ?? [];
        arr.push(row.taxonomy);
        cptTaxMap.set(row.post_type, arr);
      }
      const customPostTypes: WpCustomPostType[] = cptCountRows.map((row) => ({
        postType: String(row.post_type),
        count: Number(row.cnt),
        taxonomies: cptTaxMap.get(row.post_type) ?? [],
      }));

      return {
        plugins,
        metaKeys,
        shortcodes,
        blockTypes,
        optionKeys,
        elementorDocuments,
        customPostTypes,
        capabilities: {
          activePluginSlugs,
        },
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

  private async createConnection(connectionString: string) {
    const creds = parseDbConnectionString(connectionString);
    return createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.database,
    });
  }

  private async resolveCustomLogoUrl(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
  ): Promise<string | null> {
    try {
      const [[stylesheetRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'stylesheet' LIMIT 1`,
      );
      const stylesheet = stylesheetRow?.option_value as string | undefined;
      if (!stylesheet) return null;

      const [[modsRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = ? LIMIT 1`,
        [`theme_mods_${stylesheet}`],
      );
      const serialized = modsRow?.option_value as string | undefined;
      if (!serialized) return null;

      const parsed = phpUnserializeSimple(serialized);
      const customLogoId = Number(parsed?.custom_logo ?? 0);
      if (!Number.isFinite(customLogoId) || customLogoId <= 0) return null;

      const [[logoRow]] = await conn.query<any[]>(
        `SELECT guid
         FROM \`${prefix}posts\`
         WHERE ID = ? AND post_type = 'attachment'
         LIMIT 1`,
        [customLogoId],
      );
      const logoUrl = logoRow?.guid as string | undefined;
      return logoUrl?.trim() ? logoUrl : null;
    } catch {
      return null;
    }
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

  private parseSerializedPhpStringArray(serialized: string): string[] {
    if (!serialized) return [];
    const result: string[] = [];
    const regex = /s:\d+:"([^"]+)";/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(serialized)) !== null) {
      result.push(match[1]);
    }
    return result;
  }

  private collectUsage(
    contents: string[],
    pattern: RegExp,
  ): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const content of contents) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const key = String(match[1] ?? '')
          .trim()
          .toLowerCase();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }

  private extractElementorWidgetTypes(raw: string): string[] {
    if (!raw) return [];

    let parsed: unknown = raw;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return [];
      }
    }

    const widgetTypes = new Set<string>();
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }

      const record = node as Record<string, unknown>;
      const widgetType = record['widgetType'];
      if (typeof widgetType === 'string' && widgetType) {
        widgetTypes.add(widgetType);
      }

      for (const value of Object.values(record)) {
        visit(value);
      }
    };

    visit(parsed);
    return [...widgetTypes].sort();
  }
}

/**
 * Minimal PHP unserialize for WordPress theme_mods arrays.
 * Handles nested associative arrays, strings, and integers — enough to
 * extract nav_menu_locations without an external dependency.
 *
 * Returns null on any parse error.
 */
function phpUnserializeSimple(input: string): Record<string, any> | null {
  let pos = 0;

  function readValue(): any {
    const type = input[pos];
    pos += 2; // skip "X:"
    if (type === 'i') {
      const end = input.indexOf(';', pos);
      const n = parseInt(input.slice(pos, end), 10);
      pos = end + 1;
      return n;
    }
    if (type === 's') {
      const lenEnd = input.indexOf(':', pos);
      const len = parseInt(input.slice(pos, lenEnd), 10);
      pos = lenEnd + 2; // skip ':'+"
      const str = input.slice(pos, pos + len);
      pos += len + 2; // skip '"' + ';'
      return str;
    }
    if (type === 'a') {
      const countEnd = input.indexOf(':', pos);
      const count = parseInt(input.slice(pos, countEnd), 10);
      pos = countEnd + 2; // skip ':{'
      const obj: Record<string, any> = {};
      for (let i = 0; i < count; i++) {
        const key = readValue();
        const val = readValue();
        obj[String(key)] = val;
      }
      pos += 1; // skip '}'
      return obj;
    }
    if (type === 'b') {
      const end = input.indexOf(';', pos);
      const b = input.slice(pos, end) === '1';
      pos = end + 1;
      return b;
    }
    if (type === 'N') {
      pos -= 1; // 'N;' has no value part
      return null;
    }
    return undefined;
  }

  try {
    return readValue() as Record<string, any>;
  } catch {
    return null;
  }
}
