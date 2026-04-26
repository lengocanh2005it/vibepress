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
  author: string;
  authorSlug: string;
  categories: string[];
  categorySlugs: string[];
  tags: string[];
  featuredImage: string | null;
}

export interface WpPage {
  id: number;
  title: string;
  content: string;
  slug: string;
  parentId: number;
  menuOrder: number;
  template: string;
  featuredImage: string | null;
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
  target: string | null;
}

export interface WpSiteInfo {
  siteUrl: string;
  siteName: string;
  blogDescription: string;
  logoUrl: string | null;
  adminEmail: string;
  language: string;
  activeTheme: string;
  templateTheme: string;
  tablePrefix: string;
}

export interface WpThemeRuntimeConfig {
  stylesheet: string;
  template: string;
}

export interface WpDbTemplate {
  id: number;
  postType: 'wp_template' | 'wp_template_part';
  title: string;
  slug: string;
  canonicalSlug: string;
  themeSlug: string | null;
  area: string | null;
  sourceEntityKey: string;
  content: string;
  status: string;
  modified: string;
  blockTypes: string[];
}

export interface WpDbNavigation {
  id: number;
  title: string;
  slug: string;
  content: string;
  status: string;
  modified: string;
  location: string | null;
  items: WpMenuItem[];
  blockTypes: string[];
}

export interface WpResolvedReadingPageRef {
  id: number;
  slug: string;
  title: string;
  template: string;
}

export interface WpDbGlobalStyle {
  id: number;
  title: string;
  slug: string;
  content: string;
  status: string;
  modified: string;
}

export interface WpCustomCssEntry {
  id: number;
  title: string;
  slug: string;
  content: string;
  status: string;
  modified: string;
}

export interface WpReadingSettings {
  showOnFront: 'posts' | 'page';
  pageOnFrontId: number | null;
  pageForPostsId: number | null;
  pageOnFront: WpResolvedReadingPageRef | null;
  pageForPosts: WpResolvedReadingPageRef | null;
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
        `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
                u.display_name AS author_name,
                u.user_nicename AS author_slug,
                img.guid AS featured_image,
                ${this.taxonomyNamesSubquery(prefix, 'category')} AS categories,
                ${this.taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
                ${this.taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
         FROM \`${prefix}posts\` p
         LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
         LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
         LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
         WHERE p.post_type = 'post' AND p.post_status = 'publish'`,
      );
      return rows.map((row) => this.mapPost(row));
    } finally {
      await conn.end();
    }
  }

  async getPages(connectionString: string): Promise<WpPage[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.post_parent, p.menu_order,
                COALESCE(pm.meta_value, '') AS template,
                img.guid AS featured_image
         FROM \`${prefix}posts\` p
         LEFT JOIN \`${prefix}postmeta\` pm
            ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
         LEFT JOIN \`${prefix}postmeta\` thumb
           ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
         LEFT JOIN \`${prefix}posts\` img
           ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
         WHERE p.post_type = 'page' AND p.post_status = 'publish'
         ORDER BY p.menu_order`,
      );
      return rows.map((row) => this.mapPage(row));
    } finally {
      await conn.end();
    }
  }

  async getMenus(connectionString: string): Promise<WpMenu[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [[siteUrlRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'siteurl' LIMIT 1`,
      );
      const siteUrl = (siteUrlRow?.option_value as string | undefined) ?? null;

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
                  object_meta.meta_value AS object_type,
                  parent_meta.meta_value AS parent_id,
                  target_meta.meta_value AS target
           FROM \`${prefix}posts\` p
           INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
           INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
           LEFT JOIN \`${prefix}postmeta\` url_meta ON url_meta.post_id = p.ID AND url_meta.meta_key = '_menu_item_url'
           LEFT JOIN \`${prefix}postmeta\` object_meta ON object_meta.post_id = p.ID AND object_meta.meta_key = '_menu_item_object'
           LEFT JOIN \`${prefix}postmeta\` parent_meta ON parent_meta.post_id = p.ID AND parent_meta.meta_key = '_menu_item_menu_item_parent'
           LEFT JOIN \`${prefix}postmeta\` target_meta ON target_meta.post_id = p.ID AND target_meta.meta_key = '_menu_item_target'
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
            url: this.normalizeMenuUrl(
              item.url ?? '',
              siteUrl,
              item.object_type ?? null,
            ),
            order: item.menu_order,
            parentId: parseInt(item.parent_id ?? '0', 10),
            target: item.target?.trim() ? item.target : null,
          })),
        });
      }

      const [wpNavPosts] = await conn.query<any[]>(
        `SELECT p.ID, p.post_title, p.post_content, p.post_name
         FROM \`${prefix}posts\` p
         WHERE p.post_type = 'wp_navigation' AND p.post_status = 'publish'
         ORDER BY p.post_modified DESC, p.ID DESC`,
      );
      for (const navPost of wpNavPosts) {
        const items = parseNavigationBlockItems(
          String(navPost.post_content ?? ''),
          siteUrl,
        );
        if (items.length === 0) continue;
        // FSE block themes use wp_navigation posts as the authoritative nav source.
        // If a wp_navigation post exists with items, demote any classic menu that
        // was heuristically assigned 'primary' (no real WP location assignment).
        const existingPrimary = result.find((m) => m.location === 'primary');
        if (existingPrimary && !locationMap.size) {
          // locationMap is empty → no real WP nav_menu_locations configured →
          // the classic menu's 'primary' was a heuristic guess. Demote it.
          existingPrimary.location = null;
        }
        result.push({
          name: String(navPost.post_title || navPost.post_name || 'Primary'),
          slug: String(navPost.post_name ?? 'primary'),
          location: result.some((menu) => menu.location === 'primary')
            ? null
            : 'primary',
          items,
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

      if (result.length === 0) {
        const [pages] = await conn.query<any[]>(
          `SELECT ID, post_title, post_name, menu_order
           FROM \`${prefix}posts\`
           WHERE post_type = 'page' AND post_status = 'publish'
           ORDER BY menu_order, ID`,
        );
        if (pages.length > 0) {
          result.push({
            name: 'Primary',
            slug: 'primary',
            location: 'primary',
            items: pages.map((page, index) => ({
              id: Number(page.ID),
              title: String(page.post_title ?? ''),
              url: `/page/${page.post_name}`,
              order: Number(page.menu_order ?? index),
              parentId: 0,
              target: null,
            })),
          });
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
        'stylesheet',
        'template',
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
        logoUrl: await this.resolveSiteLogoUrl(
          conn,
          prefix,
          opts['siteurl'] ?? '',
        ),
        adminEmail: opts['admin_email'] ?? '',
        language: opts['WPLANG'] ?? 'en',
        activeTheme: opts['stylesheet'] ?? '',
        templateTheme: opts['template'] ?? '',
        tablePrefix: prefix,
      };
    } finally {
      await conn.end();
    }
  }

  async getDbTemplates(connectionString: string): Promise<WpDbTemplate[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT p.ID, p.post_type, p.post_title, p.post_name, p.post_content, p.post_status, p.post_modified,
                area_terms.slug AS area_slug
         FROM \`${prefix}posts\` p
         LEFT JOIN \`${prefix}term_relationships\` tr_area ON tr_area.object_id = p.ID
         LEFT JOIN \`${prefix}term_taxonomy\` tt_area
           ON tt_area.term_taxonomy_id = tr_area.term_taxonomy_id
          AND tt_area.taxonomy = 'wp_template_part_area'
         LEFT JOIN \`${prefix}terms\` area_terms ON area_terms.term_id = tt_area.term_id
         WHERE post_type IN ('wp_template', 'wp_template_part')
           AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
         ORDER BY p.post_modified DESC, p.ID DESC`,
      );

      return rows.map((row) => {
        const slugInfo = this.parseDbTemplateSlug(String(row.post_name ?? ''));
        const content = String(row.post_content ?? '');
        return {
          id: Number(row.ID),
          postType: String(row.post_type) as 'wp_template' | 'wp_template_part',
          title: String(row.post_title ?? ''),
          slug: String(row.post_name ?? ''),
          canonicalSlug: slugInfo.canonicalSlug,
          themeSlug: slugInfo.themeSlug,
          area:
            row.post_type === 'wp_template_part'
              ? String(row.area_slug ?? '').trim() || null
              : null,
          sourceEntityKey: slugInfo.sourceEntityKey,
          content,
          status: String(row.post_status ?? ''),
          modified: String(row.post_modified ?? ''),
          blockTypes: this.extractBlockTypes(content),
        };
      });
    } finally {
      await conn.end();
    }
  }

  async getDbNavigations(connectionString: string): Promise<WpDbNavigation[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [[siteUrlRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'siteurl' LIMIT 1`,
      );
      const siteUrl = (siteUrlRow?.option_value as string | undefined) ?? null;

      const [rows] = await conn.query<any[]>(
        `SELECT ID, post_title, post_name, post_content, post_status, post_modified
         FROM \`${prefix}posts\`
         WHERE post_type = 'wp_navigation'
           AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
         ORDER BY post_modified DESC, ID DESC`,
      );

      const navigations = rows.map((row) => {
        const content = String(row.post_content ?? '');
        return {
          id: Number(row.ID),
          title: String(row.post_title ?? ''),
          slug: String(row.post_name ?? ''),
          content,
          status: String(row.post_status ?? ''),
          modified: String(row.post_modified ?? ''),
          location: null as string | null,
          items: parseNavigationBlockItems(content, siteUrl),
          blockTypes: this.extractBlockTypes(content),
        };
      });

      if (navigations.length > 0) {
        const primaryCandidate =
          navigations.find((navigation) =>
            /^(primary|main|header|navigation|nav|top|menu)/i.test(
              navigation.slug,
            ),
          ) ??
          navigations.reduce((best, current) =>
            current.items.length > best.items.length ? current : best,
          );
        primaryCandidate.location = 'primary';
      }

      return navigations;
    } finally {
      await conn.end();
    }
  }

  async getDbGlobalStyles(
    connectionString: string,
  ): Promise<WpDbGlobalStyle[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT ID, post_title, post_name, post_content, post_status, post_modified
         FROM \`${prefix}posts\`
         WHERE post_type = 'wp_global_styles'
           AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
         ORDER BY post_modified DESC, ID DESC`,
      );

      return rows.map((row) => ({
        id: Number(row.ID),
        title: String(row.post_title ?? ''),
        slug: String(row.post_name ?? ''),
        content: String(row.post_content ?? ''),
        status: String(row.post_status ?? ''),
        modified: String(row.post_modified ?? ''),
      }));
    } finally {
      await conn.end();
    }
  }

  async getCustomCssEntries(
    connectionString: string,
  ): Promise<WpCustomCssEntry[]> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT ID, post_title, post_name, post_content, post_status, post_modified
         FROM \`${prefix}posts\`
         WHERE post_type = 'custom_css'
           AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
         ORDER BY post_modified DESC, ID DESC`,
      );

      return rows.map((row) => ({
        id: Number(row.ID),
        title: String(row.post_title ?? ''),
        slug: String(row.post_name ?? ''),
        content: String(row.post_content ?? ''),
        status: String(row.post_status ?? ''),
        modified: String(row.post_modified ?? ''),
      }));
    } finally {
      await conn.end();
    }
  }

  async getReadingSettings(
    connectionString: string,
  ): Promise<WpReadingSettings> {
    const conn = await this.createConnection(connectionString);
    try {
      const prefix = await this.getTablePrefix(conn);
      const [rows] = await conn.query<any[]>(
        `SELECT option_name, option_value
         FROM \`${prefix}options\`
         WHERE option_name IN ('show_on_front', 'page_on_front', 'page_for_posts')`,
      );

      const options = new Map<string, string>();
      for (const row of rows) {
        options.set(String(row.option_name), String(row.option_value ?? ''));
      }

      const showOnFront =
        options.get('show_on_front') === 'page' ? 'page' : 'posts';
      const pageOnFrontId = Number(options.get('page_on_front') ?? 0) || null;
      const pageForPostsId = Number(options.get('page_for_posts') ?? 0) || null;

      return {
        showOnFront,
        pageOnFrontId,
        pageForPostsId,
        pageOnFront: null,
        pageForPosts: null,
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
            OR option_name LIKE 'wpseo_%'
            OR option_name LIKE 'uagb_%'
            OR option_name LIKE 'spectra_%'`,
      );

      const optionMap = new Map<string, string>();
      for (const row of optionRows) {
        optionMap.set(row.option_name, row.option_value ?? '');
      }

      const activePluginFiles = this.parseSerializedPhpStringArray(
        optionMap.get('active_plugins') ?? '',
      );
      const plugins = activePluginFiles.map<WpPluginInfo>((pluginFile) => ({
        slug: this.normalizePluginSlug(pluginFile.split('/')[0] || pluginFile),
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
    siteUrl: string,
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
      if (!logoUrl?.trim()) return null;
      return siteUrl
        ? this.rebaseToSiteOrigin(logoUrl.trim(), siteUrl)
        : logoUrl.trim();
    } catch {
      return null;
    }
  }

  private async resolveSiteLogoOptionUrl(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
    siteUrl: string,
  ): Promise<string | null> {
    try {
      const [[siteLogoRow]] = await conn.query<any[]>(
        `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'site_logo' LIMIT 1`,
      );
      const logoId = Number(siteLogoRow?.option_value ?? 0);
      if (!Number.isFinite(logoId) || logoId <= 0) return null;
      return this.resolveAttachmentUrlById(conn, prefix, logoId, siteUrl);
    } catch {
      return null;
    }
  }

  private async resolveSiteLogoUrl(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
    siteUrl: string,
  ): Promise<string | null> {
    const siteLogoOptionUrl = await this.resolveSiteLogoOptionUrl(
      conn,
      prefix,
      siteUrl,
    );
    if (siteLogoOptionUrl) {
      this.logger.log('Resolved site logo from wp_options.site_logo');
      return siteLogoOptionUrl;
    }

    const customLogoUrl = await this.resolveCustomLogoUrl(
      conn,
      prefix,
      siteUrl,
    );
    if (customLogoUrl) return customLogoUrl;

    const fallbackLogoUrl = await this.resolveLogoUrlFromTemplateMarkup(
      conn,
      prefix,
      siteUrl,
    );
    if (fallbackLogoUrl) {
      this.logger.log('Resolved site logo from DB template markup fallback');
    }
    return fallbackLogoUrl;
  }

  private async resolveLogoUrlFromTemplateMarkup(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
    siteUrl: string,
  ): Promise<string | null> {
    try {
      const [rows] = await conn.query<any[]>(
        `SELECT ID, post_name, post_type, post_content
         FROM \`${prefix}posts\`
         WHERE post_type IN ('wp_template_part', 'wp_template')
           AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
           AND (
             post_name LIKE '%header%'
             OR post_name LIKE '%logo%'
             OR post_content LIKE '%wp:site-logo%'
             OR post_content LIKE '%/wp-content/uploads/%'
             OR post_content LIKE '%<img%'
           )
         ORDER BY
           CASE WHEN post_type = 'wp_template_part' THEN 0 ELSE 1 END,
           CASE WHEN post_name LIKE '%header%' THEN 0 ELSE 1 END,
           ID DESC
         LIMIT 20`,
      );

      for (const row of rows) {
        const markup = String(row.post_content ?? '');
        const resolved = await this.extractLogoUrlFromMarkup(
          conn,
          prefix,
          markup,
          siteUrl,
        );
        if (resolved) return resolved;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async extractLogoUrlFromMarkup(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
    markup: string,
    siteUrl: string,
  ): Promise<string | null> {
    if (!markup.trim()) return null;

    const siteLogoBlockPattern =
      /<!--\s*wp:site-logo(?:\s+(\{[\s\S]*?\}))?[\s/]*-->/gi;
    for (const match of markup.matchAll(siteLogoBlockPattern)) {
      const attrs = this.tryParseBlockAttrs(match[1]);
      const attrUrl = this.normalizeLogoCandidateUrl(
        typeof attrs?.url === 'string' ? attrs.url : null,
        siteUrl,
      );
      if (attrUrl) return attrUrl;

      const attrId = Number(attrs?.id ?? 0);
      if (Number.isFinite(attrId) && attrId > 0) {
        const attachmentUrl = await this.resolveAttachmentUrlById(
          conn,
          prefix,
          attrId,
          siteUrl,
        );
        if (attachmentUrl) return attachmentUrl;
      }
    }

    const imagePattern = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
    for (const match of markup.matchAll(imagePattern)) {
      const src = this.normalizeLogoCandidateUrl(match[1], siteUrl);
      if (src) return src;
    }

    const uploadUrlPattern =
      /(?:https?:\/\/[^\s"'<>]+)?\/wp-content\/uploads\/[^\s"'<>]+/gi;
    for (const match of markup.matchAll(uploadUrlPattern)) {
      const src = this.normalizeLogoCandidateUrl(match[0], siteUrl);
      if (src) return src;
    }

    const attachmentIdPattern =
      /(?:wp-image-|\"id\"\s*:\s*|data-id=")(\d{1,12})/gi;
    for (const match of markup.matchAll(attachmentIdPattern)) {
      const attachmentId = Number(match[1] ?? 0);
      if (!Number.isFinite(attachmentId) || attachmentId <= 0) continue;
      const attachmentUrl = await this.resolveAttachmentUrlById(
        conn,
        prefix,
        attachmentId,
        siteUrl,
      );
      if (attachmentUrl) return attachmentUrl;
    }

    return null;
  }

  private tryParseBlockAttrs(
    raw: string | null | undefined,
  ): Record<string, any> | null {
    if (!raw?.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Rebase an attachment guid URL to the siteUrl origin.
   * This fixes the common WordPress migration issue where guid values
   * still reference the old host (e.g. localhost:8000) even after the
   * site has been moved to a different URL.
   */
  private rebaseToSiteOrigin(url: string, siteUrl: string): string {
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

  private normalizeLogoCandidateUrl(
    raw: string | null | undefined,
    siteUrl: string,
  ): string | null {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;

    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return siteUrl
          ? this.rebaseToSiteOrigin(trimmed, siteUrl)
          : new URL(trimmed).toString();
      }
      if (siteUrl) {
        if (trimmed.startsWith('/')) {
          return new URL(trimmed, siteUrl).toString();
        }
        if (trimmed.includes('wp-content/uploads/')) {
          return new URL(
            trimmed.startsWith('wp-content/')
              ? `/${trimmed}`
              : `/wp-content/uploads/${trimmed.split('wp-content/uploads/')[1] ?? ''}`,
            siteUrl,
          ).toString();
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async resolveAttachmentUrlById(
    conn: Awaited<ReturnType<typeof createConnection>>,
    prefix: string,
    attachmentId: number,
    siteUrl: string,
  ): Promise<string | null> {
    try {
      const [[attachmentRow]] = await conn.query<any[]>(
        `SELECT guid
         FROM \`${prefix}posts\`
         WHERE ID = ? AND post_type = 'attachment'
         LIMIT 1`,
        [attachmentId],
      );
      return this.normalizeLogoCandidateUrl(
        attachmentRow?.guid as string | undefined,
        siteUrl,
      );
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
      author: row.author_name ?? '',
      authorSlug: row.author_slug ?? '',
      categories: this.splitTermList(row.categories),
      categorySlugs: this.splitTermList(row.category_slugs),
      tags: this.splitTermList(row.tags),
      featuredImage: row.featured_image ?? null,
    };
  }

  private mapPage(row: any): WpPage {
    return {
      id: row.ID,
      title: row.post_title,
      content: row.post_content,
      slug: row.post_name,
      parentId: Number(row.post_parent ?? 0),
      menuOrder: row.menu_order,
      template: row.template,
      featuredImage: row.featured_image ?? null,
    };
  }

  private splitTermList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    return String(raw)
      .split(', ')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseDbTemplateSlug(rawSlug: string): {
    canonicalSlug: string;
    themeSlug: string | null;
    sourceEntityKey: string;
  } {
    const trimmed = String(rawSlug ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (!trimmed) {
      return {
        canonicalSlug: '',
        themeSlug: null,
        sourceEntityKey: '',
      };
    }

    const [themePrefix, canonical] = trimmed.includes('//')
      ? trimmed.split('//', 2)
      : [null, trimmed];
    const canonicalSlug = String(canonical ?? '').trim();
    const themeSlug = themePrefix ? String(themePrefix).trim() || null : null;

    return {
      canonicalSlug,
      themeSlug,
      sourceEntityKey: (themeSlug
        ? `${themeSlug}//${canonicalSlug}`
        : canonicalSlug
      ).toLowerCase(),
    };
  }

  private extractBlockTypes(content: string): string[] {
    return this.collectUsage(
      [content],
      /<!--\s*wp:([a-z0-9-]+\/[a-z0-9-]+|[a-z0-9-]+)\b/gi,
    ).map(([blockType]) => blockType);
  }

  private taxonomyNamesSubquery(prefix: string, taxonomy: string): string {
    return `(SELECT GROUP_CONCAT(DISTINCT t.name ORDER BY t.name SEPARATOR ', ')
             FROM \`${prefix}term_relationships\` tr2
             INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
             INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
             WHERE tt2.taxonomy = '${taxonomy}' AND tr2.object_id = p.ID)`;
  }

  private taxonomySlugsSubquery(prefix: string, taxonomy: string): string {
    return `(SELECT GROUP_CONCAT(DISTINCT t.slug ORDER BY t.slug SEPARATOR ', ')
             FROM \`${prefix}term_relationships\` tr2
             INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
             INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
             WHERE tt2.taxonomy = '${taxonomy}' AND tr2.object_id = p.ID)`;
  }

  private normalizeMenuUrl(
    raw: string,
    siteUrl?: string | null,
    objectType?: string | null,
  ): string {
    if (!raw) return '';
    const trimmed = raw.trim();
    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        if (siteUrl) {
          try {
            const site = new URL(siteUrl);
            if (url.origin !== site.origin) return trimmed;
          } catch {
            // invalid site URL — fall back to pathname rewrite
          }
        }
        raw = `${url.pathname}${url.search}${url.hash}`;
      } else {
        raw = trimmed;
      }
    } catch {
      raw = trimmed;
    }

    raw = raw.replace(/^\/pages\//, '/page/').replace(/^\/posts\//, '/post/');
    if (
      raw &&
      !raw.startsWith('/') &&
      !raw.startsWith('#') &&
      !raw.startsWith('http://') &&
      !raw.startsWith('https://') &&
      !raw.startsWith('mailto:')
    ) {
      raw = '/' + raw;
    }
    return rewriteCanonicalMenuDetailPath(raw, objectType);
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

  private normalizePluginSlug(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'spectra') {
      return 'ultimate-addons-for-gutenberg';
    }
    return normalized;
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

function parseNavigationBlockItems(
  content: string,
  siteUrl?: string | null,
): WpMenuItem[] {
  const items: WpMenuItem[] = [];
  // Match the opening of a navigation-link block comment, then extract the
  // full JSON attrs by walking balanced braces (attributes may contain nested
  // objects like {"metadata":{"bindings":{...}}} that break a [^}]* pattern).
  const blockStart = /<!--\s*wp:navigation-link\s+/g;
  let order = 0;
  let startMatch: RegExpExecArray | null;

  while ((startMatch = blockStart.exec(content)) !== null) {
    const jsonStart = startMatch.index + startMatch[0].length;
    if (content[jsonStart] !== '{') continue;

    // Walk balanced braces to find the end of the JSON object
    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (depth !== 0) continue; // unbalanced — skip

    const jsonStr = content.slice(jsonStart, jsonEnd);
    try {
      const attrs = JSON.parse(jsonStr) as {
        label?: string;
        url?: string;
        id?: number;
        type?: string;
        opensInNewTab?: boolean;
      };
      const url = normalizeNavigationMenuUrl(
        attrs.url ?? '',
        siteUrl,
        attrs.type,
      );
      if (!attrs.label || !url) continue;

      items.push({
        id: attrs.id ?? 0,
        title: attrs.label,
        url,
        order: order++,
        parentId: 0,
        target: attrs.opensInNewTab ? '_blank' : null,
      });
    } catch {
      // Skip malformed block attrs.
    }
  }

  return items;
}

function normalizeNavigationMenuUrl(
  raw: string,
  siteUrl?: string | null,
  objectType?: string | null,
): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      if (siteUrl) {
        try {
          const site = new URL(siteUrl);
          if (url.origin !== site.origin) return trimmed;
        } catch {
          // Invalid site URL — fall back to pathname rewrite.
        }
      }
      raw = `${url.pathname}${url.search}${url.hash}`;
    } else {
      raw = trimmed;
    }
  } catch {
    raw = trimmed;
  }

  return rewriteCanonicalMenuDetailPath(
    raw.replace(/^\/pages\//, '/page/').replace(/^\/posts\//, '/post/'),
    objectType,
  );
}

function rewriteCanonicalMenuDetailPath(
  raw: string,
  objectType?: string | null,
): string {
  const normalizedObjectType = String(objectType ?? '')
    .trim()
    .toLowerCase();
  if (normalizedObjectType !== 'page' && normalizedObjectType !== 'post') {
    return raw;
  }

  try {
    const parsed = new URL(raw, 'http://vp.local');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const slug = segments.at(-1);
    if (!slug) return raw;

    const detailPrefix = normalizedObjectType === 'page' ? '/page/' : '/post/';
    return `${detailPrefix}${slug}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}
