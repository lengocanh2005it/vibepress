import { Injectable, Logger } from '@nestjs/common';
import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { ThemeProfileRegistry } from './profiles/theme-profile.registry.js';
import { normalizeThemeSlug } from './profiles/theme-profile.interface.js';

interface ThemeRepoLayoutResolveInput {
  repoRoot: string;
  activeSlug?: string;
}

interface ResolvedThemeCandidate {
  path: string;
  slug: string;
  templateCount?: number;
}

@Injectable()
export class ThemeRepoLayoutResolverService {
  private readonly logger = new Logger(ThemeRepoLayoutResolverService.name);
  private readonly themeRootSegments = [
    [] as string[],
    ['themes'] as string[],
    ['wp-content', 'themes'] as string[],
  ];

  constructor(private readonly themeProfiles: ThemeProfileRegistry) {}

  async resolve(input: ThemeRepoLayoutResolveInput): Promise<string> {
    const normalizedActiveSlug = normalizeThemeSlug(input.activeSlug);
    const repoRoot = input.repoRoot;

    const directRoot = await this.resolveDirectRoot(
      repoRoot,
      normalizedActiveSlug,
    );
    if (directRoot) {
      this.logger.log(
        `Resolved theme directory via strategy "direct-theme-root": ${directRoot}`,
      );
      return directRoot;
    }

    const exactNested = await this.resolveExactNestedTheme(
      repoRoot,
      normalizedActiveSlug,
    );
    if (exactNested) {
      this.logger.log(
        `Resolved theme directory via strategy "active-theme-slug": ${exactNested}`,
      );
      return exactNested;
    }

    const discovered = await this.discoverFseThemeCandidates(repoRoot);
    if (discovered.length === 1) {
      this.logger.warn(
        `Active theme was unavailable; falling back to the only detected FSE theme folder: ${discovered[0].path}`,
      );
      return discovered[0].path;
    }

    if (normalizedActiveSlug) {
      const basenameMatch = discovered.find(
        (candidate) => candidate.slug === normalizedActiveSlug,
      );
      if (basenameMatch) {
        this.logger.log(
          `Resolved theme directory via detected candidate match: ${basenameMatch.path}`,
        );
        return basenameMatch.path;
      }
    }

    const knownProfileCandidates = discovered.filter((candidate) =>
      this.themeProfiles.isKnownFseThemeSlug(candidate.slug),
    );
    if (!normalizedActiveSlug && knownProfileCandidates.length === 1) {
      this.logger.warn(
        `No active theme slug was available; falling back to the only known FSE profile match: ${knownProfileCandidates[0].path}`,
      );
      return knownProfileCandidates[0].path;
    }

    // Generic FSE fallback: when activeSlug is missing or unresolved and multiple
    // candidates exist, pick the one with the most templates/ files. This avoids a
    // hard crash for repos that contain multiple themes when the DB is unavailable.
    if (discovered.length > 0) {
      const withCounts = await Promise.all(
        discovered.map(async (candidate) => {
          let templateCount = 0;
          try {
            const files = await readdir(join(candidate.path, 'templates'));
            templateCount = files.filter((f) => f.endsWith('.html')).length;
          } catch {
            // templates/ unreadable — count stays 0
          }
          return { ...candidate, templateCount };
        }),
      );
      withCounts.sort((a, b) => b.templateCount - a.templateCount);
      const best = withCounts[0];
      const candidateList = withCounts
        .map((c) => `${c.slug}(${c.templateCount})`)
        .join(', ');
      this.logger.warn(
        normalizedActiveSlug
          ? `Could not match active theme slug "${normalizedActiveSlug}" to any candidate; using FSE theme with most templates: ${best.path}. Candidates: ${candidateList}`
          : `No active theme slug available; using FSE theme with most templates: ${best.path}. Candidates: ${candidateList}`,
      );
      return best.path;
    }

    throw new Error(
      normalizedActiveSlug
        ? `Could not resolve active FSE theme "${normalizedActiveSlug}" inside "${repoRoot}". No FSE theme candidates detected.`
        : `Could not resolve an FSE theme directory inside "${repoRoot}". No FSE theme candidates detected.`,
    );
  }

  private async resolveDirectRoot(
    repoRoot: string,
    activeSlug?: string,
  ): Promise<string | null> {
    if (!(await this.looksLikeFseThemeDir(repoRoot))) return null;

    const rootSlug = normalizeThemeSlug(basename(repoRoot));
    if (!activeSlug || activeSlug === rootSlug) return repoRoot;
    return null;
  }

  private async resolveExactNestedTheme(
    repoRoot: string,
    activeSlug?: string,
  ): Promise<string | null> {
    if (!activeSlug) return null;

    for (const segments of this.themeRootSegments.slice(1)) {
      const candidate = join(repoRoot, ...segments, activeSlug);
      if (await this.looksLikeFseThemeDir(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async discoverFseThemeCandidates(
    repoRoot: string,
  ): Promise<ResolvedThemeCandidate[]> {
    const results = new Map<string, ResolvedThemeCandidate>();

    for (const segments of this.themeRootSegments.slice(1)) {
      const themeRoot = join(repoRoot, ...segments);
      let entryNames: string[] = [];
      try {
        entryNames = await readdir(themeRoot, { encoding: 'utf8' });
      } catch {
        continue;
      }

      for (const entryName of entryNames) {
        const candidatePath = join(themeRoot, entryName);
        try {
          const entryStat = await stat(candidatePath);
          if (!entryStat.isDirectory()) continue;
        } catch {
          continue;
        }
        if (!(await this.looksLikeFseThemeDir(candidatePath))) continue;

        const slug = normalizeThemeSlug(entryName);
        results.set(candidatePath, {
          path: candidatePath,
          slug,
        });
      }
    }

    return [...results.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private async looksLikeFseThemeDir(dir: string): Promise<boolean> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
      if (!names.has('theme.json') || !names.has('templates')) {
        return false;
      }

      const templatesEntry = entries.find(
        (entry) => entry.name.toLowerCase() === 'templates',
      );
      if (!templatesEntry?.isDirectory()) return false;

      await stat(join(dir, 'theme.json'));
      return true;
    } catch {
      return false;
    }
  }
}
