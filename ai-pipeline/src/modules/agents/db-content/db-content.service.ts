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
  WpMediaAttachment,
  WpGlobalStyleTokens,
} from '../../sql/wp-query.service.js';
import type {
  DetectedPlugin,
  PluginDiscoverySummary,
} from '../plugin-discovery/plugin-discovery.service.js';
import { PluginDiscoveryService } from '../plugin-discovery/plugin-discovery.service.js';
import { parseDbConnectionString } from '../../../common/utils/db-connection-parser.js';
import { buildCanonicalPagePath } from '../../../common/utils/wp-page-path.util.js';

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
  /** Parsed design tokens extracted from the active wp_global_styles record */
  parsedGlobalStyles: WpGlobalStyleTokens | null;
  customCssEntries: WpCustomCssEntry[];
  readingSettings: WpReadingSettings;
  /** All public taxonomies (categories, tags, custom) with their terms */
  taxonomies: WpTaxonomy[];
  /** All media library attachments (images, PDFs, etc.) up to 500 most recent */
  mediaAttachments: WpMediaAttachment[];
  plugins: WpPluginInfo[];
  /** Non-built-in post types registered by plugins, with counts and associated taxonomies */
  customPostTypes: WpCustomPostType[];
  capabilities: WpSiteCapabilities;
  detectedPlugins: DetectedPlugin[];
  discovery: PluginDiscoverySummary;
  themeResolvedContent?: DbThemeResolvedContentSummary;
}

export interface DbThemeResolvedRouteSummary {
  pageId: number;
  slug: string;
  title: string;
  routePath: string;
  template: string;
  templateCandidates: string[];
  matchedDbTemplateSlugs: string[];
  pageBlockTypes: string[];
  isFrontPage: boolean;
  isPostsPage: boolean;
}

export interface DbThemeResolvedTemplateSummary {
  id: number;
  postType: 'wp_template' | 'wp_template_part';
  canonicalSlug: string;
  title: string;
  area: string | null;
  status: string;
  blockTypes: string[];
}

export interface DbThemeResolvedNavigationSummary {
  kind: 'menu' | 'db-navigation';
  slug: string;
  title: string;
  location: string | null;
  itemTitles: string[];
  itemUrls: string[];
}

export interface DbThemeResolvedContentSummary {
  themeSlug: string;
  frontPageRoute: string | null;
  postsPageRoute: string | null;
  routes: DbThemeResolvedRouteSummary[];
  templateRecords: DbThemeResolvedTemplateSummary[];
  navigationRecords: DbThemeResolvedNavigationSummary[];
  notes: string[];
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
      rawDbTemplates,
      rawDbGlobalStyles,
      customCssEntries,
      readingSettings,
      taxonomies,
      runtimeFeatures,
      mediaAttachments,
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
      this.wpQuery.getMediaAttachments(connectionString),
    ]);
    const activeThemeChain = this.collectActiveThemeChain(siteInfo);
    const dbTemplates = this.filterThemeScopedRows(
      rawDbTemplates,
      activeThemeChain,
    );
    const dbGlobalStyles = this.filterThemeScopedRows(
      rawDbGlobalStyles,
      activeThemeChain,
    );
    const enrichedReadingSettings = this.materializeReadingSettings(
      readingSettings,
      pages,
    );
    const parsedGlobalStyles = this.resolveParsedGlobalStyles(dbGlobalStyles);
    const themeResolvedContent = this.buildThemeResolvedContent({
      siteInfo,
      pages,
      menus,
      dbNavigations,
      dbTemplates,
      readingSettings: enrichedReadingSettings,
    });

    const discovery = await this.pluginDiscovery.discover({
      siteInfo,
      runtimeFeatures,
    });

    if (
      dbTemplates.length !== rawDbTemplates.length ||
      dbGlobalStyles.length !== rawDbGlobalStyles.length
    ) {
      this.logger.log(
        `Filtered theme-scoped DB artifacts to active theme chain [${activeThemeChain.join(', ') || '(none)'}]: templates ${rawDbTemplates.length} -> ${dbTemplates.length}, globalStyles ${rawDbGlobalStyles.length} -> ${dbGlobalStyles.length}`,
      );
    }

    this.logger.log(
      `Extracted: ${posts.length} posts, ${pages.length} pages, ${menus.length} menus, ${dbNavigations.length} db navigations, ` +
        `${dbTemplates.length} db templates, ${dbGlobalStyles.length} db global styles, ${customCssEntries.length} custom css entries, ` +
        `${taxonomies.length} taxonomies (${taxonomies.map((t) => `${t.taxonomy}:${t.terms.length}`).join(', ')}), ` +
        `${mediaAttachments.length} media attachments` +
        `${discovery.detectedPlugins.length > 0 ? `, detected plugins: ${discovery.detectedPlugins.map((plugin) => plugin.slug).join(', ')}` : ''}`,
    );
    if (themeResolvedContent) {
      this.logger.log(
        `Theme-resolved content (${themeResolvedContent.themeSlug}): routes=${themeResolvedContent.routes.length}, templates=${themeResolvedContent.templateRecords.length}, navSources=${themeResolvedContent.navigationRecords.length}`,
      );
    }

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
      parsedGlobalStyles,
      customCssEntries,
      readingSettings: enrichedReadingSettings,
      taxonomies,
      mediaAttachments,
      plugins: runtimeFeatures.plugins,
      customPostTypes: runtimeFeatures.customPostTypes,
      capabilities: runtimeFeatures.capabilities,
      detectedPlugins: discovery.detectedPlugins,
      discovery: discovery.summary,
      ...(themeResolvedContent ? { themeResolvedContent } : {}),
    };
  }

  private buildThemeResolvedContent(input: {
    siteInfo: WpSiteInfo;
    pages: WpPage[];
    menus: WpMenu[];
    dbNavigations: WpDbNavigation[];
    dbTemplates: WpDbTemplate[];
    readingSettings: WpReadingSettings;
  }): DbThemeResolvedContentSummary | undefined {
    const themeSlug = this.normalizeThemeSlug(
      input.siteInfo.activeTheme || input.siteInfo.templateTheme,
    );
    if (themeSlug !== 'profolio-fse') {
      return undefined;
    }

    const frontPageId = input.readingSettings.pageOnFrontId;
    const pageRecords = input.pages.map((page) => ({
      id: page.id,
      slug: page.slug,
      parentId: page.parentId,
    }));
    const routes = input.pages.map((page) => {
      const isFrontPage =
        frontPageId !== null && Number(page.id) === Number(frontPageId);
      const isPostsPage =
        input.readingSettings.pageForPostsId !== null &&
        Number(page.id) === Number(input.readingSettings.pageForPostsId);
      const routePath = buildCanonicalPagePath(
        {
          id: page.id,
          slug: page.slug,
          parentId: page.parentId,
        },
        pageRecords,
        { frontPageId },
      );
      const templateCandidates = this.buildPageTemplateCandidates({
        page,
        isFrontPage,
        isPostsPage,
      });
      const matchedDbTemplates = input.dbTemplates.filter(
        (template) =>
          template.postType === 'wp_template' &&
          templateCandidates.includes(template.canonicalSlug),
      );

      return {
        pageId: page.id,
        slug: page.slug,
        title: page.title,
        routePath,
        template: page.template,
        templateCandidates,
        matchedDbTemplateSlugs: matchedDbTemplates.map(
          (template) => template.canonicalSlug,
        ),
        pageBlockTypes: this.extractBlockTypesFromMarkup(page.content),
        isFrontPage,
        isPostsPage,
      } satisfies DbThemeResolvedRouteSummary;
    });

    const focusTemplateSlugs = new Set([
      'header',
      'footer',
      'front-page',
      'home',
      'page',
      'single',
      'archive',
      'search',
      'template-about',
      'template-contact',
      'template-services',
      'blog-left-sidebar',
      'blog-right-sidebar',
    ]);
    const templateRecords = input.dbTemplates
      .filter(
        (template) =>
          focusTemplateSlugs.has(template.canonicalSlug) ||
          (template.postType === 'wp_template_part' &&
            ['header', 'footer'].includes(
              String(template.area ?? '').toLowerCase(),
            )),
      )
      .map(
        (template) =>
          ({
            id: template.id,
            postType: template.postType,
            canonicalSlug: template.canonicalSlug,
            title: template.title,
            area: template.area,
            status: template.status,
            blockTypes: template.blockTypes,
          }) satisfies DbThemeResolvedTemplateSummary,
      );

    const navigationRecords = [
      ...input.dbNavigations.map(
        (nav) =>
          ({
            kind: 'db-navigation',
            slug: nav.slug,
            title: nav.title,
            location: nav.location,
            itemTitles: nav.items.map((item) => item.title),
            itemUrls: nav.items.map((item) => item.url),
          }) satisfies DbThemeResolvedNavigationSummary,
      ),
      ...input.menus.map(
        (menu) =>
          ({
            kind: 'menu',
            slug: menu.slug,
            title: menu.name,
            location: menu.location,
            itemTitles: menu.items.map((item) => item.title),
            itemUrls: menu.items.map((item) => item.url),
          }) satisfies DbThemeResolvedNavigationSummary,
      ),
    ];

    const frontPageRoute =
      routes.find((route) => route.isFrontPage)?.routePath ?? null;
    const postsPageRoute =
      routes.find((route) => route.isPostsPage)?.routePath ?? null;
    const templateNamedRoutes = routes.filter((route) =>
      route.templateCandidates.some((candidate) =>
        /^template-(about|contact|services)$/.test(candidate),
      ),
    );
    const chromeParts = templateRecords.filter(
      (template) =>
        template.postType === 'wp_template_part' &&
        ['header', 'footer'].includes(
          String(template.area ?? '').toLowerCase(),
        ),
    );

    const notes = [
      frontPageRoute
        ? `Resolved front page route: ${frontPageRoute}`
        : 'Resolved front page route: none',
      postsPageRoute
        ? `Resolved posts page route: ${postsPageRoute}`
        : 'Resolved posts page route: none',
      chromeParts.length > 0
        ? `Resolved shared chrome DB parts: ${chromeParts.map((part) => `${part.area}:${part.canonicalSlug}`).join(', ')}`
        : 'Resolved shared chrome DB parts: none',
    ];
    if (templateNamedRoutes.length > 0) {
      notes.push(
        `Resolved named template routes: ${templateNamedRoutes
          .map(
            (route) =>
              `${route.routePath}->${route.templateCandidates.join('/')}`,
          )
          .join(', ')}`,
      );
    }
    const primaryNav = navigationRecords.find(
      (record) => record.location === 'primary',
    );
    if (primaryNav) {
      notes.push(
        `Resolved primary navigation: ${primaryNav.title} (${primaryNav.itemUrls.slice(0, 6).join(', ')})`,
      );
    }

    return {
      themeSlug,
      frontPageRoute,
      postsPageRoute,
      routes,
      templateRecords,
      navigationRecords,
      notes,
    };
  }

  private buildPageTemplateCandidates(input: {
    page: WpPage;
    isFrontPage: boolean;
    isPostsPage: boolean;
  }): string[] {
    const candidates = new Set<string>();
    const normalizedTemplate = this.normalizePageTemplateSlug(
      input.page.template,
    );
    if (input.isFrontPage) {
      candidates.add('front-page');
      candidates.add('home');
      candidates.add('index');
    }
    if (input.isPostsPage) {
      candidates.add('home');
      candidates.add('archive');
      candidates.add('index');
    }
    if (normalizedTemplate) {
      candidates.add(normalizedTemplate);
    }
    if (candidates.size === 0) {
      candidates.add('page');
    }
    return Array.from(candidates);
  }

  private normalizePageTemplateSlug(template: string): string {
    return String(template ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^templates\//i, '')
      .replace(/\.(html|php)$/i, '');
  }

  private extractBlockTypesFromMarkup(content: string): string[] {
    if (!content?.trim()) return [];
    return Array.from(
      new Set(
        Array.from(
          content.matchAll(/<!--\s*wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)\b/gi),
        )
          .map((match) =>
            String(match[1] ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ).sort();
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

  private resolveParsedGlobalStyles(
    dbGlobalStyles: WpDbGlobalStyle[],
  ): WpGlobalStyleTokens | null {
    const preferred =
      dbGlobalStyles.find((entry) =>
        ['publish', 'private'].includes(entry.status),
      ) ?? dbGlobalStyles[0];
    if (!preferred?.content?.trim()) {
      return null;
    }

    return WpQueryService.parseGlobalStylesContent(preferred.content);
  }

  private collectActiveThemeChain(siteInfo: WpSiteInfo): string[] {
    return [...new Set([siteInfo.activeTheme, siteInfo.templateTheme])]
      .map((entry) => this.normalizeThemeSlug(entry))
      .filter((entry): entry is string => entry.length > 0);
  }

  private filterThemeScopedRows<T extends { themeSlug?: string | null }>(
    rows: T[],
    activeThemeChain: string[],
  ): T[] {
    if (activeThemeChain.length === 0) {
      return rows;
    }
    const activeSet = new Set(activeThemeChain);
    return rows.filter((row) => {
      const themeSlug = this.normalizeThemeSlug(row.themeSlug);
      return !themeSlug || activeSet.has(themeSlug);
    });
  }

  private normalizeThemeSlug(value?: string | null): string {
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }
}
