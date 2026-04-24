import { Injectable, Logger } from '@nestjs/common';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type {
  RepoPluginManifest,
  RepoResolvedPluginSource,
  RepoResolvedSourceSummary,
  RepoResolvedThemeSource,
  RepoThemeInventoryManifest,
  RepoThemeManifest,
} from '../repo-analyzer/repo-analyzer.service.js';
import { WpQueryService } from '../../sql/wp-query.service.js';

@Injectable()
export class SourceResolverService {
  private readonly logger = new Logger(SourceResolverService.name);

  constructor(private readonly wpQuery: WpQueryService) {}

  async resolve(input: {
    manifest: RepoThemeManifest;
    dbConnectionString: string;
    content: Pick<DbContentResult, 'capabilities' | 'detectedPlugins'>;
  }): Promise<RepoResolvedSourceSummary> {
    const { manifest, dbConnectionString, content } = input;
    const themeRuntime =
      await this.wpQuery.getThemeRuntimeConfig(dbConnectionString);
    const activeThemeSlug =
      themeRuntime.stylesheet || manifest.themeTypeHints.themeSlug;
    const parentThemeSlug =
      themeRuntime.template && themeRuntime.template !== activeThemeSlug
        ? themeRuntime.template
        : undefined;

    const activeTheme = this.resolveThemeSource(
      manifest.themes,
      activeThemeSlug,
      {
        fallbackToCurrentManifest: manifest,
      },
    );
    const parentTheme = parentThemeSlug
      ? this.resolveThemeSource(manifest.themes, parentThemeSlug)
      : undefined;
    const themeChain = [activeTheme, parentTheme].filter(
      (theme): theme is RepoResolvedThemeSource =>
        !!theme && theme.slug.trim().length > 0,
    );

    const activePluginSlugs = new Set(
      content.capabilities.activePluginSlugs.map((slug) =>
        this.normalizeSlug(slug),
      ),
    );
    const runtimeDetectedSlugs = new Set(
      content.detectedPlugins.map((plugin) => this.normalizeSlug(plugin.slug)),
    );
    const repoPluginMap = new Map(
      manifest.plugins.map((plugin) => [
        this.normalizeSlug(plugin.slug),
        plugin,
      ]),
    );

    const runtimePluginSlugs = new Set<string>([
      ...activePluginSlugs,
      ...runtimeDetectedSlugs,
    ]);

    const activePlugins = Array.from(runtimePluginSlugs)
      .sort()
      .map((slug) =>
        this.resolvePluginSource(repoPluginMap.get(slug), {
          slug,
          active: activePluginSlugs.has(slug),
          runtimeDetected: runtimeDetectedSlugs.has(slug),
        }),
      );

    const repoOnlyPlugins = manifest.plugins
      .filter(
        (plugin) => !runtimePluginSlugs.has(this.normalizeSlug(plugin.slug)),
      )
      .map((plugin) =>
        this.resolvePluginSource(plugin, {
          slug: plugin.slug,
          active: false,
          runtimeDetected: false,
        }),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));

    const runtimeOnlyPlugins = activePlugins.filter(
      (plugin) => !plugin.presentInRepo,
    );
    const notes = this.buildNotes({
      activeTheme,
      parentTheme,
      activePlugins,
      repoOnlyPlugins,
      runtimeOnlyPlugins,
    });

    this.logger.log(
      `Resolved source graph: activeTheme=${activeTheme.slug}${parentTheme ? `, parentTheme=${parentTheme.slug}` : ''}, activePlugins=${activePlugins.length}, repoOnlyPlugins=${repoOnlyPlugins.length}, runtimeOnlyPlugins=${runtimeOnlyPlugins.length}`,
    );

    return {
      activeTheme,
      ...(parentTheme ? { parentTheme } : {}),
      themeChain,
      activePlugins,
      repoOnlyPlugins,
      runtimeOnlyPlugins,
      notes,
    };
  }

  private resolveThemeSource(
    themes: RepoThemeInventoryManifest[],
    slug: string,
    options?: { fallbackToCurrentManifest?: RepoThemeManifest },
  ): RepoResolvedThemeSource {
    const normalized = this.normalizeSlug(slug);
    const match = themes.find(
      (theme) => this.normalizeSlug(theme.slug) === normalized,
    );
    if (match) {
      return {
        slug: match.slug,
        presentInRepo: true,
        relativeDir: match.relativeDir,
        detectedKind: match.detectedKind,
        vendor: match.vendor,
        usesPageBuilder: match.usesPageBuilder,
        ...(match.pageBuilderSlug
          ? { pageBuilderSlug: match.pageBuilderSlug }
          : {}),
      };
    }

    const fallback = options?.fallbackToCurrentManifest;
    if (
      fallback &&
      this.normalizeSlug(fallback.themeTypeHints.themeSlug) === normalized
    ) {
      return {
        slug: fallback.themeTypeHints.themeSlug,
        presentInRepo: true,
        usesPageBuilder: fallback.themeTypeHints.usesPageBuilder,
        detectedKind: fallback.themeTypeHints.detectedThemeKind,
        vendor: fallback.themeTypeHints.themeVendor,
        ...(fallback.themeTypeHints.pageBuilderSlug
          ? { pageBuilderSlug: fallback.themeTypeHints.pageBuilderSlug }
          : {}),
      };
    }

    return {
      slug,
      presentInRepo: false,
      usesPageBuilder: false,
    };
  }

  private resolvePluginSource(
    plugin: RepoPluginManifest | undefined,
    runtime: {
      slug: string;
      active: boolean;
      runtimeDetected: boolean;
    },
  ): RepoResolvedPluginSource {
    return {
      slug: runtime.slug,
      presentInRepo: !!plugin,
      ...(plugin?.relativeDir ? { relativeDir: plugin.relativeDir } : {}),
      active: runtime.active,
      runtimeDetected: runtime.runtimeDetected,
      pluginType: plugin?.pluginType,
      hasTemplatesDir: plugin?.hasTemplatesDir ?? false,
      keyRoutes: plugin?.keyRoutes ?? [],
      notes: plugin?.pluginNotes ?? [],
    };
  }

  private buildNotes(input: {
    activeTheme: RepoResolvedThemeSource;
    parentTheme?: RepoResolvedThemeSource;
    activePlugins: RepoResolvedPluginSource[];
    repoOnlyPlugins: RepoResolvedPluginSource[];
    runtimeOnlyPlugins: RepoResolvedPluginSource[];
  }): string[] {
    const notes: string[] = [];
    const {
      activeTheme,
      parentTheme,
      activePlugins,
      repoOnlyPlugins,
      runtimeOnlyPlugins,
    } = input;

    if (!activeTheme.presentInRepo) {
      notes.push(
        `Active theme "${activeTheme.slug}" is not present in the repo inventory. Theme template fidelity will be limited until that source is added.`,
      );
    }
    if (parentTheme && !parentTheme.presentInRepo) {
      notes.push(
        `Parent theme "${parentTheme.slug}" is active in WordPress but missing from the repo. Child-theme overrides may not be enough to reconstruct full layout inheritance.`,
      );
    }
    if (activeTheme.usesPageBuilder) {
      const builder = activeTheme.pageBuilderSlug ?? 'an external page builder';
      notes.push(
        `The active theme "${activeTheme.slug}" depends on ${builder}; page structure may live primarily in DB/runtime content rather than theme templates.`,
      );
    }
    if (
      activePlugins.some(
        (plugin) =>
          this.normalizeSlug(plugin.slug) === 'ultimate-addons-for-gutenberg',
      )
    ) {
      notes.push(
        'Effective source includes Spectra / UAGB. Treat repo plugin files, DB block usage, and uagb/* markup as one canonical interactive source family.',
      );
    }

    return notes;
  }

  private normalizeSlug(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'spectra') {
      return 'ultimate-addons-for-gutenberg';
    }
    return normalized;
  }
}
