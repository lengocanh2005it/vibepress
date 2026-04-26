import type { RepoThemeManifest } from '../repo-analyzer.service.js';

export interface ThemeRepoAnalysisStrategyInput {
  themeDir: string;
  fileTree: string[];
  themeSlug: string;
}

export interface ThemeRepoAnalysisManifestPatch {
  sourceOfTruthNotes?: string[];
  themeVendorNotes?: string[];
  priorityDirectories?: string[];
  layoutFiles?: string[];
  styleFiles?: string[];
  runtimeFiles?: string[];
}

export interface ThemeRepoAnalysisStrategyHelpers {
  buildGenericFseManifest(
    themeDir: string,
    fileTree: string[],
    themeSlug: string,
  ): Promise<RepoThemeManifest>;
  patchManifest(
    manifest: RepoThemeManifest,
    patch: ThemeRepoAnalysisManifestPatch,
  ): RepoThemeManifest;
}

export interface ThemeRepoAnalysisStrategy {
  readonly themeSlug: string;
  supports(themeSlug: string): boolean;
  buildManifest(
    input: ThemeRepoAnalysisStrategyInput,
    helpers: ThemeRepoAnalysisStrategyHelpers,
  ): Promise<RepoThemeManifest>;
}

interface PreferredFileOrderInput {
  exact?: string[];
  prefixes?: string[];
}

function orderFilesByPreference(
  files: string[],
  input: PreferredFileOrderInput,
): string[] {
  const uniqueFiles = Array.from(new Set(files));
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (file: string) => {
    if (!uniqueFiles.includes(file) || seen.has(file)) return;
    seen.add(file);
    ordered.push(file);
  };

  for (const file of input.exact ?? []) {
    push(file);
  }

  for (const prefix of input.prefixes ?? []) {
    for (const file of uniqueFiles) {
      if (file.startsWith(prefix)) push(file);
    }
  }

  for (const file of uniqueFiles) {
    push(file);
  }

  return ordered;
}

function buildPreferredFileList(
  baseFiles: string[],
  candidateFiles: string[],
  input: PreferredFileOrderInput,
): string[] {
  const priorityMatches = Array.from(
    new Set(
      candidateFiles.filter(
        (file) =>
          (input.exact ?? []).includes(file) ||
          (input.prefixes ?? []).some((prefix) => file.startsWith(prefix)),
      ),
    ),
  );

  return orderFilesByPreference([...priorityMatches, ...baseFiles], input);
}

abstract class BaseSupportedFseThemeRepoAnalysisStrategy implements ThemeRepoAnalysisStrategy {
  abstract readonly themeSlug: string;

  supports(themeSlug: string): boolean {
    return themeSlug === this.themeSlug;
  }

  async buildManifest(
    input: ThemeRepoAnalysisStrategyInput,
    helpers: ThemeRepoAnalysisStrategyHelpers,
  ): Promise<RepoThemeManifest> {
    const manifest = await helpers.buildGenericFseManifest(
      input.themeDir,
      input.fileTree,
      input.themeSlug,
    );
    return this.applyThemeProfile(manifest, input, helpers);
  }

  protected abstract applyThemeProfile(
    manifest: RepoThemeManifest,
    input: ThemeRepoAnalysisStrategyInput,
    helpers: ThemeRepoAnalysisStrategyHelpers,
  ): RepoThemeManifest;
}

export class TwentyTwentyFourRepoAnalysisStrategy extends BaseSupportedFseThemeRepoAnalysisStrategy {
  readonly themeSlug = 'twentytwentyfour';

  protected applyThemeProfile(
    manifest: RepoThemeManifest,
    _input: ThemeRepoAnalysisStrategyInput,
    helpers: ThemeRepoAnalysisStrategyHelpers,
  ): RepoThemeManifest {
    return helpers.patchManifest(manifest, {
      priorityDirectories: ['templates', 'parts', 'patterns', 'assets'],
      layoutFiles: orderFilesByPreference(manifest.sourceOfTruth.layoutFiles, {
        exact: [
          'templates/home.html',
          'templates/page.html',
          'templates/single.html',
          'templates/index.html',
          'parts/header.html',
          'parts/footer.html',
          'parts/sidebar.html',
          'parts/post-meta.html',
        ],
        prefixes: [
          'templates/page-',
          'templates/single-',
          'patterns/page-home-',
          'patterns/template-home-',
          'patterns/page-',
          'patterns/template-single-',
          'patterns/hidden-post-',
          'patterns/hidden-sidebar',
          'patterns/footer',
        ],
      }),
      styleFiles: orderFilesByPreference(manifest.sourceOfTruth.styleFiles, {
        exact: ['theme.json', 'style.css', 'assets/css/button-outline.css'],
      }),
      runtimeFiles: orderFilesByPreference(
        manifest.sourceOfTruth.runtimeFiles,
        {
          exact: ['functions.php'],
        },
      ),
      sourceOfTruthNotes: [
        'Theme strategy: Twenty Twenty-Four is treated as the canonical baseline WordPress block theme; prefer templates/ + parts/ before inventing alternate layout structure.',
        'For Twenty Twenty-Four, page/post fidelity comes from the shared shell in templates/ and parts/, while home and variant layouts are frequently delegated to full-page patterns.',
      ],
      themeVendorNotes: [
        'Theme profile: use Twenty Twenty-Four as the strict reference implementation for WordPress block-template composition.',
      ],
    });
  }
}

export class ProfolioFseRepoAnalysisStrategy extends BaseSupportedFseThemeRepoAnalysisStrategy {
  readonly themeSlug = 'profolio-fse';

  protected applyThemeProfile(
    manifest: RepoThemeManifest,
    input: ThemeRepoAnalysisStrategyInput,
    helpers: ThemeRepoAnalysisStrategyHelpers,
  ): RepoThemeManifest {
    const runtimePreference: PreferredFileOrderInput = {
      exact: [
        'functions.php',
        'class/admin-info.php',
        'inc/theme-info.php',
        'inc/theme-notice.php',
        'inc/tgm-plugin/tgmpa-hook.php',
        'inc/tgm-plugin/class-tgm-plugin-activation.php',
        'assets/js/script.js',
        'assets/js/jquery-sticky.js',
        'assets/js/wow.js',
      ],
      prefixes: ['class/', 'inc/', 'assets/js/'],
    };

    return helpers.patchManifest(manifest, {
      priorityDirectories: [
        'templates',
        'patterns',
        'parts',
        'assets',
        'inc',
        'class',
      ],
      layoutFiles: orderFilesByPreference(manifest.sourceOfTruth.layoutFiles, {
        exact: [
          'templates/front-page.html',
          'patterns/front-page.php',
          'templates/page.html',
          'patterns/single-page.php',
          'templates/single.html',
          'patterns/single-post.php',
          'templates/template-about.html',
          'patterns/template-about.php',
          'templates/template-contact.html',
          'patterns/template-contact.php',
          'templates/template-services.html',
          'patterns/template-services.php',
          'parts/header.html',
          'parts/footer.html',
          'patterns/header.php',
          'patterns/footer.php',
        ],
        prefixes: [
          'patterns/banner',
          'patterns/projects',
          'patterns/services',
          'patterns/experience',
          'patterns/skills',
          'patterns/testimonials',
          'patterns/contact',
          'templates/blog-',
          'patterns/blog-',
          'parts/',
        ],
      }),
      styleFiles: orderFilesByPreference(manifest.sourceOfTruth.styleFiles, {
        exact: [
          'theme.json',
          'style.css',
          'assets/font-awesome/css/all.css',
          'assets/css/animate.css',
        ],
        prefixes: ['assets/css/', 'assets/font-awesome/css/'],
      }),
      runtimeFiles: buildPreferredFileList(
        manifest.sourceOfTruth.runtimeFiles,
        [...input.fileTree, ...manifest.filesByRole.scripts],
        runtimePreference,
      ),
      sourceOfTruthNotes: [
        'Theme strategy: Profolio FSE often expresses page composition through reusable patterns; inspect patterns/ and pattern references before simplifying the layout to a generic page shell.',
        'For Profolio FSE, many templates are thin wrappers; inspect the paired pattern files to recover the real section order for front page, page, and single post/page routes.',
      ],
      themeVendorNotes: [
        'Theme profile: prioritize portfolio/landing-style block patterns when reconstructing home and marketing-oriented pages.',
      ],
    });
  }
}
