import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { basename, dirname, extname, join, resolve } from 'path';
import {
  ProfolioFseRepoAnalysisStrategy,
  TwentyTwentyFourRepoAnalysisStrategy,
  type ThemeRepoAnalysisManifestPatch,
  type ThemeRepoAnalysisStrategy,
} from './strategies/theme-repo-analysis.strategy.js';

// Module-level constants — shared by bucketFiles() and categorizeAssets()
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
]);
const FONT_EXTS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.ogv']);
const RUNTIME_DIR_PREFIXES = [
  'inc/',
  'src/',
  'app/',
  'class/',
  'classes/',
  'includes/',
];

// ─── Internal registry types ──────────────────────────────────────────────────
interface KnownPluginDef {
  type:
    | 'ecommerce'
    | 'page-builder'
    | 'seo'
    | 'form'
    | 'multilang'
    | 'membership'
    | 'lms'
    | 'events'
    | 'booking'
    | 'security'
    | 'performance'
    | 'utility';
  hasTemplates: boolean;
  templateDir?: string;
  keyRoutes: string[];
  notes: string[];
}

interface KnownThemeDef {
  vendor: string;
  usesPageBuilder: boolean;
  pageBuilderSlug?: string;
  notes: string[];
}

// ─── Known plugins registry ───────────────────────────────────────────────────
const KNOWN_PLUGINS: Record<string, KnownPluginDef> = {
  'easy-digital-downloads': {
    type: 'ecommerce',
    hasTemplates: true,
    templateDir: 'templates',
    keyRoutes: ['downloads', 'checkout', 'purchase-confirmation'],
    notes: ['EDD uses /downloads/ as the main shop archive.'],
  },
  // Page builders — content stored in DB, not theme template files
  elementor: {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Elementor stores layouts in DB as post meta — PHP template files are minimal stubs.',
    ],
  },
  'elementor-pro': {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Elementor Pro Theme Builder stores header/footer in DB, not theme files.',
    ],
  },
  js_composer: {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: ['WPBakery stores layouts as shortcodes in DB post_content.'],
  },
  'beaver-builder-plugin': {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Beaver Builder stores layouts in DB — page templates are empty wrappers.',
    ],
  },
  'ultimate-addons-for-gutenberg': {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Spectra / Ultimate Addons for Gutenberg stores interactive blocks as uagb/* block markup in WordPress content and templates.',
      'Pay attention to Spectra widgets like modal, slider, carousel, tabs, and accordion when reconstructing the frontend.',
    ],
  },
  spectra: {
    type: 'page-builder',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Spectra blocks are typically serialized as uagb/* Gutenberg blocks instead of traditional PHP template layouts.',
      'Look for interactive UI patterns such as modal, slider, carousel, tabs, and accordion in source block markup.',
    ],
  },
  // SEO — no frontend templates
  'wordpress-seo': {
    type: 'seo',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'all-in-one-seo-pack': {
    type: 'seo',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'rank-math': {
    type: 'seo',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  // Forms
  'contact-form-7': {
    type: 'form',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  gravityforms: {
    type: 'form',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'ninja-forms': {
    type: 'form',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'wpforms-lite': {
    type: 'form',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  // Multilingual — affects URL routing
  'wpml-multilingual-cms': {
    type: 'multilang',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'WPML adds language prefixes to URLs (/en/, /fr/) — routing must account for this.',
    ],
  },
  polylang: {
    type: 'multilang',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Polylang adds language prefixes to URLs — routing must account for this.',
    ],
  },
  'paid-memberships-pro': {
    type: 'membership',
    hasTemplates: true,
    templateDir: 'pages',
    keyRoutes: ['membership-account', 'membership-checkout'],
    notes: [],
  },
  // LMS
  learnpress: {
    type: 'lms',
    hasTemplates: true,
    templateDir: 'templates',
    keyRoutes: ['courses', 'course', 'lesson', 'quiz'],
    notes: [],
  },
  'sfwd-lms': {
    type: 'lms',
    hasTemplates: true,
    templateDir: 'templates',
    keyRoutes: ['courses', 'course', 'lesson', 'topic', 'quiz'],
    notes: ['LearnDash — slug is sfwd-lms.'],
  },
  tutor: {
    type: 'lms',
    hasTemplates: true,
    templateDir: 'templates',
    keyRoutes: ['courses', 'course', 'lesson'],
    notes: [],
  },
  // Events
  'the-events-calendar': {
    type: 'events',
    hasTemplates: true,
    templateDir: 'src/views',
    keyRoutes: ['events', 'event'],
    notes: [],
  },
  wpamelia: {
    type: 'booking',
    hasTemplates: false,
    keyRoutes: [],
    notes: [
      'Amelia renders via shortcodes/blocks — no traditional PHP templates.',
    ],
  },
  // Utility — no frontend impact
  wordfence: {
    type: 'security',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  akismet: { type: 'utility', hasTemplates: false, keyRoutes: [], notes: [] },
  updraftplus: {
    type: 'utility',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'w3-total-cache': {
    type: 'performance',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'wp-super-cache': {
    type: 'performance',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
  'wp-rocket': {
    type: 'performance',
    hasTemplates: false,
    keyRoutes: [],
    notes: [],
  },
};

// ─── Known themes registry ────────────────────────────────────────────────────
const KNOWN_THEMES: Record<string, KnownThemeDef> = {
  twentytwentyfour: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  'profolio-fse': {
    vendor: 'themegrovewp',
    usesPageBuilder: false,
    notes: [],
  },
};

export interface RepoAnalyzeResult {
  themeDir: string;
  fileTree: string[];
  totalFiles: number;
  themeCount: number;
  pluginCount: number;
  themeInventoryFiles: number;
  pluginFiles: number;
  themeManifest: RepoThemeManifest;
}

export interface RepoThemeManifest {
  themeTypeHints: RepoThemeTypeHints;
  filesByRole: RepoFileBuckets;
  themeJsonSummary: RepoThemeJsonSummary;
  styleSources: RepoStyleSources;
  runtimeHints: RepoRuntimeHints;
  structureHints: RepoStructureHints;
  assetManifest: RepoAssetManifest;
  themes: RepoThemeInventoryManifest[];
  plugins: RepoPluginManifest[];
  resolvedSource?: RepoResolvedSourceSummary;
  uagbSummary?: RepoUagbDetectionSummary;
  interactiveContracts?: RepoInteractiveContractsSummary;
  sourceOfTruth: RepoSourceOfTruth;
}

export interface RepoThemeInventoryManifest {
  slug: string;
  relativeDir: string;
  totalFiles: number;
  isKnown: boolean;
  vendor?: string;
  detectedKind: RepoThemeTypeHints['detectedThemeKind'];
  hasThemeJson: boolean;
  hasTemplatesDir: boolean;
  hasFunctionsPhp: boolean;
  usesPageBuilder: boolean;
  pageBuilderSlug?: string;
  themeNotes: string[];
}

export interface RepoPluginManifest {
  slug: string;
  relativeDir: string;
  /** Absolute filesystem path to the plugin directory root. */
  absoluteDir: string;
  totalFiles: number;
  isKnown: boolean;
  pluginType?: KnownPluginDef['type'];
  keyRoutes: string[];
  pluginNotes: string[];
  hasTemplatesDir: boolean;
  hasAssetsDir: boolean;
  hasPhpFiles: boolean;
  entryPhpFiles: string[];
  layoutFiles: string[];
  runtimeFiles: string[];
  assetFiles: string[];
}

export interface RepoResolvedThemeSource {
  slug: string;
  presentInRepo: boolean;
  relativeDir?: string;
  detectedKind?: RepoThemeTypeHints['detectedThemeKind'];
  vendor?: string;
  usesPageBuilder: boolean;
  pageBuilderSlug?: string;
}

export interface RepoResolvedPluginSource {
  slug: string;
  presentInRepo: boolean;
  relativeDir?: string;
  active: boolean;
  runtimeDetected: boolean;
  pluginType?: KnownPluginDef['type'];
  hasTemplatesDir: boolean;
  keyRoutes: string[];
  notes: string[];
}

export interface RepoResolvedSourceSummary {
  activeTheme: RepoResolvedThemeSource;
  parentTheme?: RepoResolvedThemeSource;
  themeChain: RepoResolvedThemeSource[];
  activePlugins: RepoResolvedPluginSource[];
  repoOnlyPlugins: RepoResolvedPluginSource[];
  runtimeOnlyPlugins: RepoResolvedPluginSource[];
  notes: string[];
}

export interface RepoUagbDbUsage {
  id?: number;
  slug: string;
  title?: string;
  blockTypes: string[];
  source: 'db';
  entityType: 'page' | 'template' | 'part';
  isHome?: boolean;
}

export interface RepoUagbDetectionSummary {
  detected: boolean;
  mergedBlockTypes: string[];
  mergedPluginSlugs: string[];
  source: {
    files: RepoFileBlockUsage[];
    blockTypes: string[];
  };
  db: {
    detectedPluginSlugs: string[];
    blockTypes: string[];
    pages: RepoUagbDbUsage[];
    templates: RepoUagbDbUsage[];
    parts: RepoUagbDbUsage[];
  };
  effective: {
    activePluginSlugs: string[];
  };
}

export interface RepoInteractiveWidgetContract {
  blockType: string;
  runtime: 'swiper' | 'tabs-dom' | 'modal-dom' | 'accordion-dom';
  attrKeys: string[];
  scriptFiles: string[];
  styleFiles: string[];
  appearance?: RepoInteractiveAppearanceSignature;
  defaults?: RepoInteractiveWidgetDefaults;
  notes: string[];
}

export interface RepoInteractiveAppearanceSignature {
  wrapperClasses: string[];
  itemClasses: string[];
  activeClasses: string[];
  variantClasses: string[];
  behaviorClasses: string[];
  alignmentClasses: string[];
  styleCues: string[];
}

export interface RepoInteractiveWidgetDefaults {
  width?: string;
  height?: string;
  maxWidth?: string;
  overlayColor?: string;
  background?: string;
  textColor?: string;
  contentPadding?: string;
  slideHeight?: string;
  activeTab?: number;
  variant?: string;
  layout?: string;
  tabAlign?: string;
  iconPosition?: string;
  arrowBackground?: string;
  arrowColor?: string;
  dotsColor?: string;
  autoplay?: boolean;
  autoplaySpeed?: number;
  loop?: boolean;
  effect?: string;
  showDots?: boolean;
  showArrows?: boolean;
  vertical?: boolean;
  transitionSpeed?: number;
  pauseOn?: string;
  allowMultiple?: boolean;
  defaultOpenItems?: number[];
  enableToggle?: boolean;
}

export interface RepoSpectraInteractiveContracts {
  detected: boolean;
  pluginSlug: string;
  widgets: Partial<
    Record<
      'slider' | 'tabs' | 'modal' | 'accordion',
      RepoInteractiveWidgetContract
    >
  >;
}

export interface RepoInteractiveContractsSummary {
  spectra?: RepoSpectraInteractiveContracts;
}

export interface RepoThemeTypeHints {
  detectedThemeKind: 'block' | 'classic' | 'hybrid' | 'unknown';
  hasThemeJson: boolean;
  hasTemplatesDir: boolean;
  hasPartsDir: boolean;
  hasPatternsDir: boolean;
  hasFunctionsPhp: boolean;
  hasStyleCss: boolean;
  hasTemplatePartsPhp: boolean;
  themeSlug: string;
  themeVendor?: string;
  usesPageBuilder: boolean;
  pageBuilderSlug?: string;
  themeVendorNotes: string[];
}

export interface RepoFileBuckets {
  templates: string[];
  templateParts: string[];
  patterns: string[];
  phpTemplates: string[];
  phpRuntime: string[];
  styles: string[];
  scripts: string[];
  configFiles: string[];
  screenshots: string[];
  assets: string[];
  misc: string[];
}

export interface RepoThemeJsonSummary {
  exists: boolean;
  version: number | null;
  customTemplateCount: number;
  templatePartAreaCount: number;
  paletteCount: number;
  gradientCount: number;
  duotoneCount: number;
  fontFamilyCount: number;
  fontSizeCount: number;
  spacingSizeCount: number;
  hasLayoutSettings: boolean;
  hasStyleVariations: boolean;
  /** Area assignments for each registered template part (e.g. header, footer) */
  templatePartAreas: { name: string; title: string; area: string }[];
  /** Actual palette color entries from theme.json settings.color.palette */
  paletteColors: { slug: string; color: string; name?: string }[];
  /** Custom template names and their supported post types */
  customTemplateNames: { name: string; title?: string; postTypes?: string[] }[];
  /** Style variation names registered in the theme */
  styleVariationNames: string[];
}

export interface RepoStyleSources {
  rootCssFiles: string[];
  assetCssFiles: string[];
  editorStyleFiles: string[];
  enqueuedStyleHandles: string[];
  discoveredFontFamilies: string[];
}

export interface RepoRuntimeHints {
  registeredMenus: string[];
  registeredSidebars: string[];
  themeSupports: string[];
  enqueuedStyleHandles: string[];
  enqueuedScriptHandles: string[];
  enqueuedStyleFiles: string[];
  enqueuedScriptFiles: string[];
  requiredPhpFiles: string[];
  imageSizes: string[];
  editorStyleFiles: string[];
}

export interface RepoPatternMeta {
  slug: string;
  title: string;
  categories: string[];
  keywords: string[];
  /** File path relative to theme root */
  file: string;
}

export interface RepoFileBlockUsage {
  file: string;
  blockTypes: string[];
}

export interface RepoSourceFileAnalysis {
  file: string;
  kind: 'template' | 'template-part' | 'pattern' | 'php-template';
  blockTypes: string[];
  headingTexts: string[];
  templatePartSlugs: string[];
  templatePartFiles: string[];
  patternSlugs: string[];
  patternFiles: string[];
  referencedAssetPaths: string[];
  referencedRuntimeFiles: string[];
  customClasses: string[];
}

export interface RepoEntrySourceChain {
  entryFile: string;
  routeHint: string;
  chainFiles: string[];
  composedSource: string;
  assetFiles: string[];
  runtimeFiles: string[];
  blockTypes: string[];
  headingTexts: string[];
  notes: string[];
}

export interface RepoStructureHints {
  templatePartRefs: string[];
  patternRefs: string[];
  blockTypes: string[];
  uagbUsages: RepoFileBlockUsage[];
  referencedAssetPaths: string[];
  containsNavigation: boolean;
  containsSearch: boolean;
  containsComments: boolean;
  containsQueryLoop: boolean;
  /** Parsed metadata from PHP header comments in patterns/ files */
  patternMeta: RepoPatternMeta[];
  fileAnalyses: RepoSourceFileAnalysis[];
  entrySourceChains: RepoEntrySourceChain[];
}

export interface RepoAssetManifest {
  images: string[];
  fonts: string[];
  svg: string[];
  video: string[];
  css: string[];
  js: string[];
  other: string[];
}

export interface RepoSourceOfTruth {
  layoutFiles: string[];
  styleFiles: string[];
  runtimeFiles: string[];
  priorityDirectories: string[];
  themeDirectories: string[];
  pluginDirectories: string[];
  pluginLayoutFiles: string[];
  notes: string[];
}

@Injectable()
export class RepoAnalyzerService {
  private readonly logger = new Logger(RepoAnalyzerService.name);
  private readonly themeStrategies: ThemeRepoAnalysisStrategy[] = [
    new TwentyTwentyFourRepoAnalysisStrategy(),
    new ProfolioFseRepoAnalysisStrategy(),
  ];

  async analyze(themeDir: string): Promise<RepoAnalyzeResult> {
    this.logger.log(`Analyzing repo: ${themeDir}`);
    const fileTree = await this.walk(themeDir);
    const themeManifest = await this.buildManifest(themeDir, fileTree);
    const themeInventoryFiles = themeManifest.themes.reduce(
      (sum, theme) => sum + theme.totalFiles,
      0,
    );
    const pluginFiles = themeManifest.plugins.reduce(
      (sum, plugin) => sum + plugin.totalFiles,
      0,
    );

    return {
      themeDir,
      fileTree,
      totalFiles: fileTree.length,
      themeCount: themeManifest.themes.length,
      pluginCount: themeManifest.plugins.length,
      themeInventoryFiles,
      pluginFiles,
      themeManifest,
    };
  }

  private async buildManifest(
    themeDir: string,
    fileTree: string[],
  ): Promise<RepoThemeManifest> {
    const themeSlug = basename(themeDir).trim().toLowerCase();
    const strategy = this.themeStrategies.find((candidate) =>
      candidate.supports(themeSlug),
    );
    if (!strategy) {
      this.logger.warn(
        `No specialized repo analysis strategy registered for theme "${themeSlug}". Falling back to generic FSE analysis.`,
      );
      return this.patchManifest(
        await this.buildGenericFseManifest(themeDir, fileTree, themeSlug),
        {
          sourceOfTruthNotes: [
            `Theme strategy: "${themeSlug}" is using the generic FSE repo-analysis profile.`,
          ],
          themeVendorNotes: [
            'Theme profile: generic FSE fallback profile applied because no specialized repo-analysis strategy was registered.',
          ],
        },
      );
    }
    return strategy.buildManifest(
      {
        themeDir,
        fileTree,
        themeSlug,
      },
      {
        buildGenericFseManifest: (nextThemeDir, nextFileTree, nextThemeSlug) =>
          this.buildGenericFseManifest(
            nextThemeDir,
            nextFileTree,
            nextThemeSlug,
          ),
        patchManifest: (manifest, patch) => this.patchManifest(manifest, patch),
      },
    );
  }

  private async buildGenericFseManifest(
    themeDir: string,
    fileTree: string[],
    themeSlug: string,
  ): Promise<RepoThemeManifest> {
    const filesByRole = this.bucketFiles(fileTree);
    const themeTypeHints = this.detectThemeTypeHints(
      fileTree,
      filesByRole,
      themeSlug,
    );

    const [functionsPhp, themeJsonRaw, structureHints] = await Promise.all([
      this.readOptionalText(themeDir, 'functions.php'),
      this.readOptionalText(themeDir, 'theme.json'),
      this.extractStructureHints(themeDir, filesByRole),
    ]);

    const runtimeHints = this.extractFunctionsPhpHints(functionsPhp);
    const themeJsonSummary = this.extractThemeJsonSummary(themeJsonRaw);
    const assetManifest = this.categorizeAssets(fileTree);
    const themes = await this.discoverThemeInventories(themeDir);
    const plugins = await this.discoverPluginManifests(themeDir);
    const interactiveContracts =
      await this.extractInteractiveContracts(plugins);
    const styleSources = await this.extractStyleSources(
      themeDir,
      filesByRole,
      runtimeHints,
    );
    const sourceOfTruth = this.buildSourceOfTruth(
      themeTypeHints,
      filesByRole,
      runtimeHints,
      styleSources,
      themeJsonSummary,
      themes,
      plugins,
    );

    return {
      themeTypeHints,
      filesByRole,
      themeJsonSummary,
      styleSources,
      runtimeHints,
      structureHints,
      assetManifest,
      themes,
      plugins,
      ...(interactiveContracts ? { interactiveContracts } : {}),
      sourceOfTruth,
    };
  }

  private patchManifest(
    manifest: RepoThemeManifest,
    patch: ThemeRepoAnalysisManifestPatch,
  ): RepoThemeManifest {
    const mergeUnique = (values: string[] = [], additions: string[] = []) => [
      ...new Set([...values, ...additions]),
    ];
    const mergePrioritized = (
      preferred?: string[],
      fallback: string[] = [],
      limit = 40,
    ) =>
      (preferred?.length
        ? [...new Set([...preferred, ...fallback])]
        : [...fallback]
      ).slice(0, limit);

    return {
      ...manifest,
      themeTypeHints: {
        ...manifest.themeTypeHints,
        themeVendorNotes: mergeUnique(
          manifest.themeTypeHints.themeVendorNotes,
          patch.themeVendorNotes,
        ),
      },
      sourceOfTruth: {
        ...manifest.sourceOfTruth,
        priorityDirectories: patch.priorityDirectories?.length
          ? mergeUnique(
              patch.priorityDirectories,
              manifest.sourceOfTruth.priorityDirectories,
            )
          : manifest.sourceOfTruth.priorityDirectories,
        layoutFiles: mergePrioritized(
          patch.layoutFiles,
          manifest.sourceOfTruth.layoutFiles,
        ),
        styleFiles: mergePrioritized(
          patch.styleFiles,
          manifest.sourceOfTruth.styleFiles,
        ),
        runtimeFiles: mergePrioritized(
          patch.runtimeFiles,
          manifest.sourceOfTruth.runtimeFiles,
        ),
        notes: mergeUnique(
          manifest.sourceOfTruth.notes,
          patch.sourceOfTruthNotes,
        ),
      },
    };
  }

  private bucketFiles(fileTree: string[]): RepoFileBuckets {
    const templates = fileTree.filter((file) =>
      this.matchesDirAndExt(file, 'templates', ['.html', '.php']),
    );
    const templateParts = fileTree.filter(
      (file) =>
        this.matchesDirAndExt(file, 'parts', ['.html', '.php']) ||
        this.matchesDirAndExt(file, 'template-parts', ['.php']),
    );
    const patterns = fileTree.filter((file) =>
      this.matchesDirAndExt(file, 'patterns', ['.php', '.html']),
    );
    const phpFiles = fileTree.filter((file) => extname(file) === '.php');
    const phpTemplates = phpFiles.filter((file) =>
      this.isPhpTemplateFile(file),
    );
    const phpRuntime = phpFiles.filter(
      (file) =>
        !phpTemplates.includes(file) &&
        (file === 'functions.php' ||
          RUNTIME_DIR_PREFIXES.some((prefix) => file.startsWith(prefix))),
    );
    const styles = fileTree.filter((file) => STYLE_EXTS.has(extname(file)));
    const scripts = fileTree.filter((file) => SCRIPT_EXTS.has(extname(file)));
    const configFiles = fileTree.filter((file) =>
      ['theme.json', 'style.css', 'functions.php', 'screenshot.png'].includes(
        file,
      ),
    );
    const screenshots = fileTree.filter((file) =>
      /^screenshot\.(png|jpg|jpeg|webp)$/i.test(file),
    );
    const assets = fileTree.filter(
      (file) =>
        file.startsWith('assets/') ||
        file.startsWith('images/') ||
        file.startsWith('fonts/') ||
        file.startsWith('dist/') ||
        file.startsWith('build/'),
    );

    const claimed = new Set([
      ...templates,
      ...templateParts,
      ...patterns,
      ...phpTemplates,
      ...phpRuntime,
      ...styles,
      ...scripts,
      ...configFiles,
      ...screenshots,
      ...assets,
    ]);

    return {
      templates,
      templateParts,
      patterns,
      phpTemplates,
      phpRuntime,
      styles,
      scripts,
      configFiles,
      screenshots,
      assets,
      misc: fileTree.filter((file) => !claimed.has(file)),
    };
  }

  private detectThemeTypeHints(
    fileTree: string[],
    filesByRole: RepoFileBuckets,
    themeSlug: string,
  ): RepoThemeTypeHints {
    const hasThemeJson = fileTree.includes('theme.json');
    const hasTemplatesDir = filesByRole.templates.length > 0;
    const hasPartsDir = fileTree.some((file) => file.startsWith('parts/'));
    const hasPatternsDir = fileTree.some((file) =>
      file.startsWith('patterns/'),
    );
    const hasFunctionsPhp = fileTree.includes('functions.php');
    const hasStyleCss = fileTree.includes('style.css');
    const hasTemplatePartsPhp = filesByRole.templateParts.some((file) =>
      file.startsWith('template-parts/'),
    );
    let detectedThemeKind: RepoThemeTypeHints['detectedThemeKind'] = 'unknown';
    if (hasThemeJson && hasTemplatesDir) {
      detectedThemeKind = hasTemplatePartsPhp ? 'hybrid' : 'block';
    } else if (filesByRole.phpTemplates.length > 0 || hasFunctionsPhp) {
      detectedThemeKind = 'classic';
    }

    const knownTheme = KNOWN_THEMES[themeSlug];

    return {
      detectedThemeKind,
      hasThemeJson,
      hasTemplatesDir,
      hasPartsDir,
      hasPatternsDir,
      hasFunctionsPhp,
      hasStyleCss,
      hasTemplatePartsPhp,
      themeSlug,
      themeVendor: knownTheme?.vendor,
      usesPageBuilder: knownTheme?.usesPageBuilder ?? false,
      pageBuilderSlug: knownTheme?.pageBuilderSlug,
      themeVendorNotes: knownTheme?.notes ?? [],
    };
  }

  private extractThemeJsonSummary(raw: string | null): RepoThemeJsonSummary {
    const empty: RepoThemeJsonSummary = {
      exists: false,
      version: null,
      customTemplateCount: 0,
      templatePartAreaCount: 0,
      paletteCount: 0,
      gradientCount: 0,
      duotoneCount: 0,
      fontFamilyCount: 0,
      fontSizeCount: 0,
      spacingSizeCount: 0,
      hasLayoutSettings: false,
      hasStyleVariations: false,
      templatePartAreas: [],
      paletteColors: [],
      customTemplateNames: [],
      styleVariationNames: [],
    };

    if (!raw) return empty;

    try {
      const parsed = JSON.parse(raw) as Record<string, any>;
      const settings = parsed.settings ?? {};
      const color = settings.color ?? {};
      const typography = settings.typography ?? {};
      const spacing = settings.spacing ?? {};

      const rawCustomTemplates: any[] = Array.isArray(parsed.customTemplates)
        ? parsed.customTemplates
        : [];
      const rawTemplateParts: any[] = Array.isArray(parsed.templateParts)
        ? parsed.templateParts
        : [];
      const rawStyleVariations: any[] = Array.isArray(parsed.styles?.variations)
        ? parsed.styles.variations
        : [];
      const rawPalette: any[] = Array.isArray(color.palette)
        ? color.palette
        : [];

      const templatePartAreas = rawTemplateParts
        .filter((p) => p && typeof p.name === 'string')
        .map((p) => ({
          name: p.name as string,
          title: typeof p.title === 'string' ? p.title : p.name,
          area: typeof p.area === 'string' ? p.area : 'uncategorized',
        }));

      const paletteColors = rawPalette
        .filter(
          (c) => c && typeof c.slug === 'string' && typeof c.color === 'string',
        )
        .map((c) => ({
          slug: c.slug as string,
          color: c.color as string,
          ...(typeof c.name === 'string' ? { name: c.name } : {}),
        }));

      const customTemplateNames = rawCustomTemplates
        .filter((t) => t && typeof t.name === 'string')
        .map((t) => ({
          name: t.name as string,
          ...(typeof t.title === 'string' ? { title: t.title } : {}),
          ...(Array.isArray(t.postTypes)
            ? { postTypes: t.postTypes as string[] }
            : {}),
        }));

      const styleVariationNames = rawStyleVariations
        .map((v) =>
          typeof v?.title === 'string'
            ? v.title
            : typeof v?.name === 'string'
              ? v.name
              : null,
        )
        .filter((n): n is string => n !== null);

      return {
        exists: true,
        version: typeof parsed.version === 'number' ? parsed.version : null,
        customTemplateCount: rawCustomTemplates.length,
        templatePartAreaCount: rawTemplateParts.length,
        paletteCount: rawPalette.length,
        gradientCount: Array.isArray(color.gradients)
          ? color.gradients.length
          : 0,
        duotoneCount: Array.isArray(color.duotone) ? color.duotone.length : 0,
        fontFamilyCount: Array.isArray(typography.fontFamilies)
          ? typography.fontFamilies.length
          : 0,
        fontSizeCount: Array.isArray(typography.fontSizes)
          ? typography.fontSizes.length
          : 0,
        spacingSizeCount: Array.isArray(spacing.spacingSizes)
          ? spacing.spacingSizes.length
          : 0,
        hasLayoutSettings: Boolean(settings.layout || parsed.styles?.spacing),
        hasStyleVariations: rawStyleVariations.length > 0,
        templatePartAreas,
        paletteColors,
        customTemplateNames,
        styleVariationNames,
      };
    } catch {
      return { ...empty, exists: true };
    }
  }

  private extractFunctionsPhpHints(raw: string | null): RepoRuntimeHints {
    const content = raw ?? '';
    const registeredMenus = new Set<string>();
    const registeredSidebars = new Set<string>();
    const themeSupports = new Set<string>();
    const enqueuedStyleHandles = new Set<string>();
    const enqueuedScriptHandles = new Set<string>();
    const enqueuedStyleFiles = new Set<string>();
    const enqueuedScriptFiles = new Set<string>();
    const requiredPhpFiles = new Set<string>();
    const imageSizes = new Set<string>();
    const editorStyleFiles = new Set<string>();

    for (const match of content.matchAll(
      /register_nav_menu\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      registeredMenus.add(match[1]);
    }

    for (const call of content.matchAll(
      /register_nav_menus\s*\(([\s\S]{0,4000}?)\)\s*;/g,
    )) {
      for (const item of call[1].matchAll(/['"]([^'"]+)['"]\s*=>/g)) {
        registeredMenus.add(item[1]);
      }
    }

    for (const match of content.matchAll(
      /register_sidebar\s*\(([\s\S]{0,2000}?)\)\s*;/g,
    )) {
      const body = match[1];
      const idMatch = body.match(/['"]id['"]\s*=>\s*['"]([^'"]+)['"]/);
      const nameMatch = body.match(/['"]name['"]\s*=>\s*['"]([^'"]+)['"]/);
      if (idMatch?.[1]) registeredSidebars.add(idMatch[1]);
      else if (nameMatch?.[1]) registeredSidebars.add(nameMatch[1]);
    }

    for (const match of content.matchAll(
      /add_theme_support\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      themeSupports.add(match[1]);
    }

    for (const match of content.matchAll(
      /wp_enqueue_style\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      enqueuedStyleHandles.add(match[1]);
    }

    for (const match of content.matchAll(
      /wp_enqueue_style\s*\(\s*['"][^'"]+['"]\s*,[\s\S]{0,600}?['"]\/?([^'"]+\.(?:css|scss|sass|less))['"]/g,
    )) {
      enqueuedStyleFiles.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /wp_enqueue_script\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      enqueuedScriptHandles.add(match[1]);
    }

    for (const match of content.matchAll(
      /wp_enqueue_script\s*\(\s*['"][^'"]+['"]\s*,[\s\S]{0,600}?['"]\/?([^'"]+\.(?:js|mjs|cjs|ts))['"]/g,
    )) {
      enqueuedScriptFiles.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /(?:require|include)(?:_once)?\s*(?:\(\s*)?(?:get_template_directory|get_parent_theme_file_path|get_theme_file_path)\s*\([^)]*\)\s*\.\s*['"]\/?([^'"]+\.php)['"]/g,
    )) {
      requiredPhpFiles.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /(?:require|include)(?:_once)?\s*(?:\(\s*)?(?:get_parent_theme_file_path|get_theme_file_path)\s*\(\s*['"]\/?([^'"]+\.php)['"]\s*\)/g,
    )) {
      requiredPhpFiles.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /add_image_size\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      imageSizes.add(match[1]);
    }

    for (const match of content.matchAll(
      /add_editor_style\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      editorStyleFiles.add(match[1]);
    }

    return {
      registeredMenus: Array.from(registeredMenus).sort(),
      registeredSidebars: Array.from(registeredSidebars).sort(),
      themeSupports: Array.from(themeSupports).sort(),
      enqueuedStyleHandles: Array.from(enqueuedStyleHandles).sort(),
      enqueuedScriptHandles: Array.from(enqueuedScriptHandles).sort(),
      enqueuedStyleFiles: Array.from(enqueuedStyleFiles).sort(),
      enqueuedScriptFiles: Array.from(enqueuedScriptFiles).sort(),
      requiredPhpFiles: Array.from(requiredPhpFiles).sort(),
      imageSizes: Array.from(imageSizes).sort(),
      editorStyleFiles: Array.from(editorStyleFiles).sort(),
    };
  }

  private async extractStructureHints(
    themeDir: string,
    filesByRole: RepoFileBuckets,
  ): Promise<RepoStructureHints> {
    const themeSlug = basename(themeDir).trim().toLowerCase();
    const candidates = Array.from(
      new Set([
        ...filesByRole.templates,
        ...filesByRole.templateParts,
        ...filesByRole.patterns,
        ...filesByRole.phpTemplates.slice(0, 40),
      ]),
    );
    const contents = await Promise.all(
      candidates.map(async (file) => ({
        file,
        content: await this.readOptionalText(themeDir, file),
      })),
    );

    const templatePartRefs = new Set<string>();
    const patternRefs = new Set<string>();
    const blockTypes = new Set<string>();
    const referencedAssetPaths = new Set<string>();
    const patternMeta: RepoPatternMeta[] = [];
    const uagbUsages: RepoFileBlockUsage[] = [];
    const patternSlugToFile = new Map<string, string>();
    const fileAnalyses: RepoSourceFileAnalysis[] = [];

    for (const { file, content } of contents) {
      if (!content) continue;
      const fileBlockTypes = new Set<string>();
      const fileTemplatePartSlugs = new Set<string>();
      const filePatternSlugs = new Set<string>();
      const fileAssetPaths = new Set<string>();
      const fileRuntimeRefs = new Set<string>();

      for (const match of content.matchAll(
        /<!--\s+wp:template-part\s+(\{[\s\S]*?\})\s*\/?-->/g,
      )) {
        const slugMatch = match[1].match(/"slug"\s*:\s*"([^"]+)"/);
        if (slugMatch?.[1]) {
          templatePartRefs.add(slugMatch[1]);
          fileTemplatePartSlugs.add(slugMatch[1]);
        }
      }

      for (const match of content.matchAll(
        /get_template_part\s*\(\s*['"]([^'"]+)['"]/g,
      )) {
        templatePartRefs.add(match[1]);
        fileTemplatePartSlugs.add(match[1]);
      }

      for (const match of content.matchAll(
        /<!--\s+wp:pattern\s+(\{[\s\S]*?\})\s*\/?-->/g,
      )) {
        const slugMatch = match[1].match(/"slug"\s*:\s*"([^"]+)"/);
        if (slugMatch?.[1]) {
          patternRefs.add(slugMatch[1]);
          filePatternSlugs.add(slugMatch[1]);
        }
      }

      for (const match of content.matchAll(
        /<!--\s+wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)/gi,
      )) {
        const blockType = match[1].toLowerCase();
        blockTypes.add(blockType);
        fileBlockTypes.add(blockType);
      }

      for (const match of content.matchAll(
        /(?:src|href)=["']([^"']+\.(?:css|js|png|jpe?g|svg|webp|woff2?|ttf|otf|mp4|webm))["']/gi,
      )) {
        const normalized = this.normalizeRepoRelativePath(match[1]);
        referencedAssetPaths.add(normalized);
        fileAssetPaths.add(normalized);
      }

      for (const match of content.matchAll(
        /url\((['"]?)([^'")]+\.(?:css|js|png|jpe?g|svg|webp|woff2?|ttf|otf))\1\)/gi,
      )) {
        const normalized = this.normalizeRepoRelativePath(match[2]);
        referencedAssetPaths.add(normalized);
        fileAssetPaths.add(normalized);
      }

      for (const assetPath of this.extractPhpAssetPaths(content)) {
        referencedAssetPaths.add(assetPath);
        fileAssetPaths.add(assetPath);
      }

      for (const runtimeFile of this.extractRuntimePhpRefs(content)) {
        fileRuntimeRefs.add(runtimeFile);
      }

      // Parse PHP header comments in patterns/ files
      // e.g. * Title: Hero Section \n * Slug: theme/hero \n * Categories: featured, banner
      if (file.startsWith('patterns/') && file.endsWith('.php')) {
        const meta = this.parsePatternPhpHeader(file, content);
        if (meta) {
          patternMeta.push(meta);
          patternSlugToFile.set(meta.slug, file);
        }
      }

      const normalizedFileBlockTypes = Array.from(fileBlockTypes)
        .filter((blockType) => blockType.startsWith('uagb/'))
        .sort();
      if (normalizedFileBlockTypes.length > 0) {
        uagbUsages.push({
          file,
          blockTypes: normalizedFileBlockTypes,
        });
      }

      const resolvedPatternFiles = this.resolvePatternFiles(
        Array.from(filePatternSlugs),
        filesByRole,
        patternSlugToFile,
        themeSlug,
      );
      const resolvedTemplatePartFiles = this.resolveTemplatePartFiles(
        Array.from(fileTemplatePartSlugs),
        filesByRole,
      );

      fileAnalyses.push({
        file,
        kind: this.inferSourceFileKind(file),
        blockTypes: Array.from(fileBlockTypes).sort(),
        headingTexts: this.extractHeadingTextsFromRepoSource(content),
        templatePartSlugs: Array.from(fileTemplatePartSlugs).sort(),
        templatePartFiles: resolvedTemplatePartFiles,
        patternSlugs: Array.from(filePatternSlugs).sort(),
        patternFiles: resolvedPatternFiles,
        referencedAssetPaths: Array.from(fileAssetPaths).sort(),
        referencedRuntimeFiles: Array.from(fileRuntimeRefs).sort(),
        customClasses: this.extractCustomClassesFromRepoSource(content),
      });
    }

    const normalizedBlockTypes = Array.from(blockTypes).sort();
    const contentByFile = new Map(
      contents
        .filter(
          (entry): entry is { file: string; content: string } =>
            !!entry.content,
        )
        .map((entry) => [entry.file, entry.content] as const),
    );
    const entrySourceChains = this.buildEntrySourceChains(
      fileAnalyses,
      contentByFile,
    );

    return {
      templatePartRefs: Array.from(templatePartRefs).sort(),
      patternRefs: Array.from(patternRefs).sort(),
      blockTypes: normalizedBlockTypes,
      uagbUsages: uagbUsages.sort((a, b) => a.file.localeCompare(b.file)),
      referencedAssetPaths: Array.from(referencedAssetPaths).sort(),
      containsNavigation: normalizedBlockTypes.some((block) =>
        block.includes('navigation'),
      ),
      containsSearch: normalizedBlockTypes.some((block) =>
        block.includes('search'),
      ),
      containsComments: normalizedBlockTypes.some((block) =>
        block.includes('comment'),
      ),
      containsQueryLoop: normalizedBlockTypes.some((block) =>
        ['query', 'query-loop', 'core/query'].includes(block),
      ),
      patternMeta,
      fileAnalyses: fileAnalyses.sort((a, b) => a.file.localeCompare(b.file)),
      entrySourceChains,
    };
  }

  /** Extract Title / Slug / Categories / Keywords from a PHP pattern file's docblock header. */
  private parsePatternPhpHeader(
    file: string,
    content: string,
  ): RepoPatternMeta | null {
    const headerMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (!headerMatch) return null;
    const block = headerMatch[1];

    const get = (key: string): string | null => {
      const m = block.match(new RegExp(`\\*\\s+${key}:\\s*(.+)`, 'i'));
      return m ? m[1].trim() : null;
    };
    const getList = (key: string): string[] => {
      const val = get(key);
      return val
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    };

    const title = get('Title');
    const slug = get('Slug');
    if (!title && !slug) return null;

    return {
      file,
      title: title ?? slug ?? file,
      slug: slug ?? file.replace(/^patterns\//, '').replace(/\.php$/, ''),
      categories: getList('Categories'),
      keywords: getList('Keywords'),
    };
  }

  private inferSourceFileKind(file: string): RepoSourceFileAnalysis['kind'] {
    if (file.startsWith('templates/')) return 'template';
    if (file.startsWith('parts/') || file.startsWith('template-parts/')) {
      return 'template-part';
    }
    if (file.startsWith('patterns/')) return 'pattern';
    return 'php-template';
  }

  private normalizeRepoRelativePath(value: string): string {
    const normalized = String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^['"]|['"]$/g, '')
      .replace(/^\.?\//, '')
      .replace(/^\//, '');

    const repoLikePath =
      normalized.match(
        /((?:assets|images|fonts|dist|build|inc|class|templates|parts|patterns|template-parts)\/.+)$/i,
      )?.[1] ?? normalized;

    return repoLikePath.replace(/^\/+/, '');
  }

  private extractPhpAssetPaths(content: string): string[] {
    const refs = new Set<string>();

    for (const match of content.matchAll(
      /(?:get_template_directory_uri|get_parent_theme_file_uri|get_theme_file_uri)\s*\([^)]*\)\s*\.\s*['"]\/?([^'"]+\.(?:css|js|png|jpe?g|svg|webp|woff2?|ttf|otf|mp4|webm))['"]/g,
    )) {
      refs.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /((?:assets|images|fonts|dist|build)\/[^"' )]+\.(?:css|js|png|jpe?g|svg|webp|woff2?|ttf|otf|mp4|webm))/gi,
    )) {
      refs.add(this.normalizeRepoRelativePath(match[1]));
    }

    return Array.from(refs).sort();
  }

  private extractRuntimePhpRefs(content: string): string[] {
    const refs = new Set<string>();

    for (const match of content.matchAll(
      /(?:require|include)(?:_once)?\s*(?:\(\s*)?(?:get_template_directory|get_parent_theme_file_path|get_theme_file_path)\s*\([^)]*\)\s*\.\s*['"]\/?([^'"]+\.php)['"]/g,
    )) {
      refs.add(this.normalizeRepoRelativePath(match[1]));
    }

    for (const match of content.matchAll(
      /(?:require|include)(?:_once)?\s*(?:\(\s*)?(?:get_parent_theme_file_path|get_theme_file_path)\s*\(\s*['"]\/?([^'"]+\.php)['"]\s*\)/g,
    )) {
      refs.add(this.normalizeRepoRelativePath(match[1]));
    }

    return Array.from(refs).sort();
  }

  private resolvePatternFiles(
    slugs: string[],
    filesByRole: RepoFileBuckets,
    patternSlugToFile: Map<string, string>,
    themeSlug: string,
  ): string[] {
    const files = new Set<string>();

    for (const slug of slugs) {
      const normalizedSlug = String(slug ?? '').trim();
      if (!normalizedSlug) continue;

      const direct = patternSlugToFile.get(normalizedSlug);
      if (direct) {
        files.add(direct);
        continue;
      }

      const slugTail = normalizedSlug.includes('/')
        ? normalizedSlug.split('/').slice(1).join('/')
        : normalizedSlug;

      for (const candidate of [
        normalizedSlug,
        slugTail,
        normalizedSlug.replace(`${themeSlug}/`, ''),
      ]) {
        const fileCandidate = `patterns/${candidate}.php`;
        if (filesByRole.patterns.includes(fileCandidate))
          files.add(fileCandidate);
        const htmlCandidate = `patterns/${candidate}.html`;
        if (filesByRole.patterns.includes(htmlCandidate))
          files.add(htmlCandidate);
      }
    }

    return Array.from(files);
  }

  private resolveTemplatePartFiles(
    slugs: string[],
    filesByRole: RepoFileBuckets,
  ): string[] {
    const files = new Set<string>();

    for (const slug of slugs) {
      const normalizedSlug = this.normalizeRepoRelativePath(slug)
        .replace(/^parts\//, '')
        .replace(/^template-parts\//, '')
        .replace(/\.(php|html)$/i, '');

      for (const candidate of [
        `parts/${normalizedSlug}.html`,
        `parts/${normalizedSlug}.php`,
        `template-parts/${normalizedSlug}.php`,
      ]) {
        if (filesByRole.templateParts.includes(candidate)) files.add(candidate);
      }
    }

    return Array.from(files);
  }

  private extractHeadingTextsFromRepoSource(content: string): string[] {
    const texts = new Set<string>();
    const push = (value: string | undefined) => {
      const normalized = String(value ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.length >= 3) texts.add(normalized);
    };

    for (const match of content.matchAll(
      /<!--\s+wp:heading(?:\s+\{[\s\S]*?\})?\s*-->\s*<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    )) {
      push(match[1]);
    }

    for (const match of content.matchAll(
      /esc_html__\(\s*'([^']+)'|esc_html__\(\s*"([^"]+)"/g,
    )) {
      push(match[1] ?? match[2]);
    }

    return Array.from(texts).slice(0, 8);
  }

  private extractCustomClassesFromRepoSource(content: string): string[] {
    const classes = new Set<string>();
    const collect = (raw: string) => {
      for (const token of raw
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (token.length >= 2) classes.add(token);
      }
    };

    for (const match of content.matchAll(/"className"\s*:\s*"([^"]+)"/g)) {
      collect(match[1]);
    }
    for (const match of content.matchAll(/class="([^"]+)"/g)) {
      collect(match[1]);
    }

    return Array.from(classes).sort().slice(0, 20);
  }

  private buildEntrySourceChains(
    fileAnalyses: RepoSourceFileAnalysis[],
    contentByFile: Map<string, string>,
  ): RepoEntrySourceChain[] {
    const byFile = new Map(fileAnalyses.map((entry) => [entry.file, entry]));
    const entryFiles = fileAnalyses.filter((entry) =>
      this.isEntrySourceFile(entry.file, entry.kind),
    );

    return entryFiles
      .map((entry) => {
        const chainFiles: string[] = [];
        const assetFiles = new Set<string>();
        const runtimeFiles = new Set<string>();
        const blockTypes = new Set<string>();
        const headingTexts = new Set<string>();
        const seen = new Set<string>();
        const composedParts: string[] = [];

        const visit = (file: string) => {
          if (seen.has(file)) return;
          seen.add(file);
          chainFiles.push(file);
          const analysis = byFile.get(file);
          const content = contentByFile.get(file);
          if (content) {
            composedParts.push(
              this.wrapRepoChainContent(file, analysis?.kind, content),
            );
          }
          if (!analysis) return;

          for (const asset of analysis.referencedAssetPaths)
            assetFiles.add(asset);
          for (const runtime of analysis.referencedRuntimeFiles) {
            runtimeFiles.add(runtime);
          }
          for (const blockType of analysis.blockTypes)
            blockTypes.add(blockType);
          for (const heading of analysis.headingTexts)
            headingTexts.add(heading);

          for (const dependency of [
            ...analysis.templatePartFiles,
            ...analysis.patternFiles,
          ]) {
            visit(dependency);
          }
        };

        visit(entry.file);

        const notes: string[] = [];
        if (
          blockTypes.has('core/post-content') ||
          blockTypes.has('post-content')
        ) {
          notes.push('contains post-content placeholder');
        }
        if (
          blockTypes.has('core/query') ||
          blockTypes.has('query') ||
          blockTypes.has('query-loop')
        ) {
          notes.push('contains query loop');
        }
        if (
          chainFiles.some((file) =>
            /parts\/header|patterns\/header/i.test(file),
          )
        ) {
          notes.push('uses header source');
        }
        if (
          chainFiles.some((file) =>
            /parts\/footer|patterns\/footer/i.test(file),
          )
        ) {
          notes.push('uses footer source');
        }

        return {
          entryFile: entry.file,
          routeHint: this.inferEntryRouteHint(entry.file),
          chainFiles,
          composedSource: composedParts.join('\n\n'),
          assetFiles: Array.from(assetFiles).sort(),
          runtimeFiles: Array.from(runtimeFiles).sort(),
          blockTypes: Array.from(blockTypes).sort(),
          headingTexts: Array.from(headingTexts).slice(0, 8),
          notes,
        };
      })
      .sort((a, b) => a.entryFile.localeCompare(b.entryFile));
  }

  private wrapRepoChainContent(
    file: string,
    kind: RepoSourceFileAnalysis['kind'] | undefined,
    content: string,
  ): string {
    if (kind === 'template-part') {
      return `<!-- vibepress:part:start ${file} -->\n${content}\n<!-- vibepress:part:end ${file} -->`;
    }
    if (kind === 'php-template') {
      return `{/* WP: include start → ${file} */}\n${content}\n{/* WP: include end → ${file} */}`;
    }
    return content;
  }

  private isEntrySourceFile(
    file: string,
    kind: RepoSourceFileAnalysis['kind'],
  ): boolean {
    if (kind === 'template') return true;
    if (kind !== 'pattern') return false;

    const name = basename(file)
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
    return (
      /^(front-page|home|index|page|single|archive|search|404)$/.test(name) ||
      /^(template-|page-|single-|blog-)/.test(name)
    );
  }

  private inferEntryRouteHint(file: string): string {
    const name = basename(file)
      .replace(/\.(php|html)$/i, '')
      .toLowerCase();
    if (['front-page', 'home', 'index'].includes(name)) return 'home';
    if (name === 'page' || name.startsWith('page-')) return 'page';
    if (name === 'single' || name.startsWith('single-')) return 'single';
    if (name.startsWith('template-')) return name.replace(/^template-/, '');
    if (name.startsWith('blog-')) return 'blog';
    return name;
  }

  private categorizeAssets(fileTree: string[]): RepoAssetManifest {
    const images: string[] = [];
    const fonts: string[] = [];
    const svg: string[] = [];
    const video: string[] = [];
    const css: string[] = [];
    const js: string[] = [];
    const other: string[] = [];

    for (const file of fileTree) {
      const ext = extname(file).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        images.push(file);
      } else if (ext === '.svg') {
        svg.push(file);
      } else if (FONT_EXTS.has(ext)) {
        fonts.push(file);
      } else if (VIDEO_EXTS.has(ext)) {
        video.push(file);
      } else if (STYLE_EXTS.has(ext)) {
        css.push(file);
      } else if (SCRIPT_EXTS.has(ext)) {
        js.push(file);
      } else if (
        file.startsWith('assets/') ||
        file.startsWith('images/') ||
        file.startsWith('fonts/')
      ) {
        other.push(file);
      }
    }

    return { images, fonts, svg, video, css, js, other };
  }

  private async extractStyleSources(
    themeDir: string,
    filesByRole: RepoFileBuckets,
    runtimeHints: RepoRuntimeHints,
  ): Promise<RepoStyleSources> {
    const rootCssFiles = filesByRole.styles.filter(
      (file) => !file.includes('/'),
    );
    const assetCssFiles = filesByRole.styles.filter((file) =>
      file.includes('/'),
    );
    const discoveredFontFamilies = new Set<string>();
    const cssCandidates = Array.from(
      new Set([...rootCssFiles, ...assetCssFiles.slice(0, 20)]),
    );

    const cssContents = await Promise.all(
      cssCandidates.map((file) => this.readOptionalText(themeDir, file)),
    );
    for (const content of cssContents) {
      if (!content) continue;
      for (const match of content.matchAll(/font-family\s*:\s*([^;{}]+)/gi)) {
        const families = match[1]
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(
            (item) =>
              item.length > 0 &&
              ![
                'inherit',
                'initial',
                'unset',
                'serif',
                'sans-serif',
                'monospace',
              ].includes(item.toLowerCase()),
          );
        for (const family of families) discoveredFontFamilies.add(family);
      }
    }

    return {
      rootCssFiles,
      assetCssFiles,
      editorStyleFiles: runtimeHints.editorStyleFiles,
      enqueuedStyleHandles: runtimeHints.enqueuedStyleHandles,
      discoveredFontFamilies: Array.from(discoveredFontFamilies).sort(),
    };
  }

  private buildSourceOfTruth(
    themeTypeHints: RepoThemeTypeHints,
    filesByRole: RepoFileBuckets,
    runtimeHints: RepoRuntimeHints,
    styleSources: RepoStyleSources,
    themeJsonSummary: RepoThemeJsonSummary,
    themes: RepoThemeInventoryManifest[],
    plugins: RepoPluginManifest[],
  ): RepoSourceOfTruth {
    const layoutFiles =
      themeTypeHints.detectedThemeKind === 'block' ||
      themeTypeHints.detectedThemeKind === 'hybrid'
        ? [
            ...filesByRole.templates,
            ...filesByRole.templateParts,
            ...filesByRole.patterns,
          ]
        : [...filesByRole.phpTemplates, ...filesByRole.templateParts];
    const styleFiles = Array.from(
      new Set([
        ...(themeTypeHints.hasThemeJson ? ['theme.json'] : []),
        ...styleSources.rootCssFiles,
        ...styleSources.assetCssFiles,
        ...styleSources.editorStyleFiles,
        ...runtimeHints.enqueuedStyleFiles,
      ]),
    );
    const runtimeFiles = Array.from(
      new Set([
        ...(themeTypeHints.hasFunctionsPhp ? ['functions.php'] : []),
        ...filesByRole.phpRuntime,
        ...runtimeHints.requiredPhpFiles,
        ...runtimeHints.enqueuedScriptFiles,
      ]),
    );
    const priorityDirectories = [
      ...(themeTypeHints.hasTemplatesDir ? ['templates'] : []),
      ...(themeTypeHints.hasPartsDir ? ['parts'] : []),
      ...(filesByRole.templateParts.some((file) =>
        file.startsWith('template-parts/'),
      )
        ? ['template-parts']
        : []),
      ...(themeTypeHints.hasPatternsDir ? ['patterns'] : []),
      ...(filesByRole.assets.length > 0 ? ['assets'] : []),
    ];
    const themeDirectories = themes.map((theme) => theme.relativeDir);
    const pluginDirectories = plugins.map((plugin) => plugin.relativeDir);
    const pluginLayoutFiles = plugins.flatMap((plugin) =>
      plugin.layoutFiles.map((file) => `${plugin.relativeDir}/${file}`),
    );
    const notes: string[] = [];

    if (
      themeTypeHints.detectedThemeKind === 'block' ||
      themeTypeHints.detectedThemeKind === 'hybrid'
    ) {
      notes.push(
        'Prefer templates/, parts/, and patterns/ as the layout source of truth before inferring structure from theme.json.',
      );
    } else if (filesByRole.phpTemplates.length > 0) {
      notes.push(
        'Prefer classic PHP templates and template-parts/ for layout fidelity; treat theme.json as supporting design tokens only.',
      );
    }

    if (themeJsonSummary.exists) {
      notes.push(
        `theme.json exposes ${themeJsonSummary.paletteCount} palette color(s), ${themeJsonSummary.fontSizeCount} font size(s), and ${themeJsonSummary.spacingSizeCount} spacing preset(s).`,
      );
    }

    if (styleSources.discoveredFontFamilies.length > 0) {
      notes.push(
        `CSS references ${styleSources.discoveredFontFamilies.length} font family candidate(s).`,
      );
    }
    if (runtimeHints.requiredPhpFiles.length > 0) {
      notes.push(
        `functions.php links ${runtimeHints.requiredPhpFiles.length} runtime PHP include(s): ${runtimeHints.requiredPhpFiles.slice(0, 6).join(', ')}${runtimeHints.requiredPhpFiles.length > 6 ? ' ...' : ''}.`,
      );
    }
    if (
      runtimeHints.enqueuedStyleFiles.length > 0 ||
      runtimeHints.enqueuedScriptFiles.length > 0
    ) {
      notes.push(
        `functions.php enqueues ${runtimeHints.enqueuedStyleFiles.length} stylesheet file(s) and ${runtimeHints.enqueuedScriptFiles.length} script file(s).`,
      );
    }

    return {
      layoutFiles: layoutFiles.slice(0, 40),
      styleFiles: styleFiles.slice(0, 40),
      runtimeFiles: runtimeFiles.slice(0, 40),
      priorityDirectories,
      themeDirectories: themeDirectories.slice(0, 20),
      pluginDirectories: pluginDirectories.slice(0, 20),
      pluginLayoutFiles: pluginLayoutFiles.slice(0, 40),
      notes,
    };
  }

  private async discoverThemeInventories(
    themeDir: string,
  ): Promise<RepoThemeInventoryManifest[]> {
    const themeRoots = await this.resolveThemeRoots(themeDir);
    const manifests: RepoThemeInventoryManifest[] = [];

    for (const themeRoot of themeRoots) {
      const entries = await this.readDirEntries(themeRoot);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const slug = entry.name;
        const fullDir = join(themeRoot, slug);
        const fileTree = await this.walk(fullDir);
        const filesByRole = this.bucketFiles(fileTree);
        const hints = this.detectThemeTypeHints(fileTree, filesByRole, slug);
        const known = KNOWN_THEMES[slug];

        manifests.push({
          slug,
          relativeDir: this.describeThemeRelativeDir(themeRoot, slug),
          totalFiles: fileTree.length,
          isKnown: !!known,
          vendor: known?.vendor,
          detectedKind: hints.detectedThemeKind,
          hasThemeJson: hints.hasThemeJson,
          hasTemplatesDir: hints.hasTemplatesDir,
          hasFunctionsPhp: hints.hasFunctionsPhp,
          usesPageBuilder: hints.usesPageBuilder,
          pageBuilderSlug: hints.pageBuilderSlug,
          themeNotes: hints.themeVendorNotes,
        });
      }
    }

    return manifests.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private async discoverPluginManifests(
    themeDir: string,
  ): Promise<RepoPluginManifest[]> {
    const pluginRoots = await this.resolvePluginRoots(themeDir);
    const manifests: RepoPluginManifest[] = [];

    for (const pluginRoot of pluginRoots) {
      const entries = await this.readDirEntries(pluginRoot);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const slug = entry.name;
        const known = KNOWN_PLUGINS[slug];

        // Known non-template plugins: skip full file walk, build lightweight manifest
        if (known && !known.hasTemplates) {
          manifests.push(
            this.buildLightweightPluginManifest(pluginRoot, slug, known),
          );
          continue;
        }

        const pluginDir = join(pluginRoot, slug);
        const fileTree = await this.walk(pluginDir);
        if (fileTree.length === 0) continue;

        manifests.push(
          this.buildPluginManifest(pluginRoot, slug, fileTree, known),
        );
      }
    }

    return manifests.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private async extractInteractiveContracts(
    plugins: RepoPluginManifest[],
  ): Promise<RepoInteractiveContractsSummary | undefined> {
    const spectraPlugin = plugins.find(
      (plugin) =>
        this.normalizePluginSlug(plugin.slug) ===
        'ultimate-addons-for-gutenberg',
    );
    if (!spectraPlugin) return undefined;

    const spectraContracts = await this.extractSpectraContracts(spectraPlugin);
    if (!spectraContracts) return undefined;

    return {
      spectra: spectraContracts,
    };
  }

  private async extractSpectraContracts(
    plugin: RepoPluginManifest,
  ): Promise<RepoSpectraInteractiveContracts | undefined> {
    const widgetConfigs: Array<{
      key: 'slider' | 'tabs' | 'modal' | 'accordion';
      blockType: string;
      runtime: 'swiper' | 'tabs-dom' | 'modal-dom' | 'accordion-dom';
      attrPath: string;
      scriptPaths: string[];
      stylePaths: string[];
      preferredAttrKeys: string[];
      notes: string[];
      appearance: {
        wrapperClasses: string[];
        itemClasses: string[];
        activeClasses: string[];
        variantPattern: RegExp;
        behaviorPattern: RegExp;
        alignmentClasses: string[];
        styleCueDetectors: Array<{
          pattern: RegExp;
          cue: string;
        }>;
      };
    }> = [
      {
        key: 'slider' as const,
        blockType: 'uagb/slider',
        runtime: 'swiper' as const,
        attrPath: 'includes/blocks/slider/attributes.php',
        scriptPaths: ['includes/blocks/slider/frontend.js.php'],
        stylePaths: [
          'includes/blocks/slider/frontend.css.php',
          'assets/css/blocks/slider.css',
        ],
        preferredAttrKeys: [
          'autoplay',
          'autoplaySpeed',
          'infiniteLoop',
          'transitionEffect',
          'transitionSpeed',
          'displayDots',
          'displayArrows',
          'pauseOn',
          'verticalMode',
        ],
        notes: [
          'Spectra slider uses Swiper-style runtime options and dynamic per-block CSS.',
        ],
        appearance: {
          wrapperClasses: [
            'uagb-slider-container',
            'uagb-swiper',
            'swiper-wrapper',
          ],
          itemClasses: [
            'swiper-button-prev',
            'swiper-button-next',
            'swiper-pagination',
            'swiper-pagination-bullet',
          ],
          activeClasses: ['swiper-button-disabled'],
          variantPattern: /swiper-[a-z-]+|uagb-slider-container|uagb-swiper/g,
          behaviorPattern: /swiper-pagination-bullets|swiper-notification/g,
          alignmentClasses: [],
          styleCueDetectors: [
            {
              pattern: /overflow:hidden/,
              cue: 'masked slider viewport with slides clipped inside one frame',
            },
            {
              pattern: /swiper-button-prev|swiper-button-next/,
              cue: 'inner arrow controls are part of the default slider chrome',
            },
            {
              pattern: /swiper-pagination-bullet/,
              cue: 'dot pagination bullets appear inside the slider frame',
            },
            {
              pattern:
                /background:#efefef|background-color'\s*=>\s*\$attr\['arrowBgColor'\]/,
              cue: 'arrow buttons use a filled surface instead of plain text links',
            },
          ],
        },
      },
      {
        key: 'tabs' as const,
        blockType: 'uagb/tabs',
        runtime: 'tabs-dom' as const,
        attrPath: 'includes/blocks/tabs/attributes.php',
        scriptPaths: [
          'includes/blocks/tabs/frontend.js.php',
          'assets/js/tabs.js',
        ],
        stylePaths: [
          'includes/blocks/tabs/frontend.css.php',
          'assets/css/blocks/tabs.css',
        ],
        preferredAttrKeys: [
          'tabActive',
          'tabActiveFrontend',
          'tabsStyleD',
          'tabAlign',
          'iconPosition',
          'tabTitlePaddingUnit',
          'tabBodyPaddingUnit',
        ],
        notes: [
          'Spectra tabs has explicit active-tab state, style variants, and keyboard navigation.',
        ],
        appearance: {
          wrapperClasses: [
            'uagb-tabs__wrap',
            'uagb-tabs__panel',
            'uagb-tabs__body-wrap',
          ],
          itemClasses: [
            'uagb-tab',
            'uagb-tabs-list',
            'uagb-tabs__body-container',
          ],
          activeClasses: ['uagb-tabs__active', 'uagb-tabs-body__active'],
          variantPattern:
            /uagb-tabs__(?:hstyle|vstyle|stack)\d+-(?:desktop|tablet|mobile)/g,
          behaviorPattern:
            /uagb-tabs__icon-position-(?:left|right|top|bottom)|uagb-inner-tab-\d+/g,
          alignmentClasses: [
            'uagb-tabs__align-left',
            'uagb-tabs__align-center',
            'uagb-tabs__align-right',
          ],
          styleCueDetectors: [
            {
              pattern: /uagb-tabs__active|uagb-tabs-body__active/,
              cue: 'active tab state is mirrored in both the tab button and matching body panel',
            },
            {
              pattern:
                /uagb-tabs__hstyle4|uagb-tabs__vstyle9|border-radius'\s*=>\s*'30px'/,
              cue: 'rounded pill-style tabs are part of the Spectra variant family',
            },
            {
              pattern: /uagb-tabs__hstyle5|uagb-tabs__vstyle10/,
              cue: 'some variants distribute tabs across the row instead of using a simple underline list',
            },
            {
              pattern:
                /uagb-tabs__vstyle6|uagb-tabs__vstyle7|uagb-tabs__vstyle8|uagb-tabs__vstyle9|uagb-tabs__vstyle10/,
              cue: 'vertical variants use a left-side tab rail with body content on the right',
            },
            {
              pattern: /ArrowRight|ArrowLeft|aria-selected/,
              cue: 'keyboard arrow navigation and ARIA-selected state are part of the default tabs behavior',
            },
          ],
        },
      },
      {
        key: 'modal' as const,
        blockType: 'uagb/modal',
        runtime: 'modal-dom' as const,
        attrPath: 'includes/blocks/modal/attributes.php',
        scriptPaths: [
          'includes/blocks/modal/frontend.js.php',
          'assets/js/modal.js',
        ],
        stylePaths: [
          'includes/blocks/modal/frontend.css.php',
          'assets/css/blocks/modal.css',
        ],
        preferredAttrKeys: [
          'btnText',
          'modalWidth',
          'modalWidthType',
          'modalHeight',
          'modalHeightType',
          'overlayColor',
          'closeIconPosition',
          'iconSize',
        ],
        notes: [
          'Spectra modal supports overlay behavior, ESC close, scroll locking, and dynamic sizing.',
        ],
        appearance: {
          wrapperClasses: [
            'uagb-modal-popup',
            'uagb-modal-popup-wrap',
            'uagb-modal-popup-content',
          ],
          itemClasses: [
            'uagb-modal-trigger',
            'uagb-modal-popup-close',
            'uagb-spectra-button-wrapper',
          ],
          activeClasses: ['active'],
          variantPattern: /uagb-effect-[a-z0-9-]+/g,
          behaviorPattern:
            /hide-scroll|overlayclick|escpress|uagb-modal-button-link/g,
          alignmentClasses: [],
          styleCueDetectors: [
            {
              pattern: /position:fixed|display:flex;visibility:visible/,
              cue: 'modal opens as a fixed centered overlay over the whole viewport',
            },
            {
              pattern: /hide-scroll/,
              cue: 'opening the modal locks body scrolling until every modal is closed',
            },
            {
              pattern: /uagb-modal-popup-close|closeIconPosition/,
              cue: 'the dialog includes an explicit close button with configurable position',
            },
            {
              pattern:
                /overlayColor|background'\s*=>\s*\$attr\['overlayColor'\]/,
              cue: 'overlay color is controlled by block settings and should not default to a generic backdrop',
            },
          ],
        },
      },
      {
        key: 'accordion' as const,
        blockType: 'uagb/faq',
        runtime: 'accordion-dom' as const,
        attrPath: 'includes/blocks/faq/attributes.php',
        scriptPaths: [
          'includes/blocks/faq/frontend.js.php',
          'assets/js/faq.js',
        ],
        stylePaths: [
          'includes/blocks/faq/frontend.css.php',
          'assets/css/blocks/faq.css',
        ],
        preferredAttrKeys: [
          'layout',
          'inactiveOtherItems',
          'expandFirstItem',
          'enableToggle',
          'enableSchemaSupport',
        ],
        notes: [
          'Spectra FAQ/accordion exposes multi-open, default-open, and toggle behavior through block attrs.',
        ],
        appearance: {
          wrapperClasses: [
            'wp-block-uagb-faq',
            'uagb-faq__wrap',
            'uagb-faq-child__outer-wrap',
          ],
          itemClasses: [
            'uagb-faq-item',
            'uagb-faq-questions-button',
            'uagb-faq-content',
            'uagb-faq-icon-wrap',
          ],
          activeClasses: ['uagb-faq-item-active'],
          variantPattern:
            /uagb-faq-layout-[a-z-]+|uagb-faq-icon-row(?:-reverse)?/g,
          behaviorPattern:
            /uagb-faq-expand-first-true|uagb-faq-inactive-other-false|data-faqtoggle/g,
          alignmentClasses: [],
          styleCueDetectors: [
            {
              pattern: /slideUp|slideDown/,
              cue: 'accordion answers animate open and closed with height transitions',
            },
            {
              pattern: /uagb-faq-item-active/,
              cue: 'active accordion items get their own visual state instead of a plain text toggle',
            },
            {
              pattern: /uagb-faq-questions-button|uagb-faq-icon-wrap/,
              cue: 'question row and icon chrome are part of the default Spectra FAQ surface',
            },
          ],
        },
      },
    ];

    const widgets: RepoSpectraInteractiveContracts['widgets'] = {};

    for (const config of widgetConfigs) {
      const sourcePaths = [...config.scriptPaths, ...config.stylePaths];
      const [attrRaw, ...assetSources] = await Promise.all([
        this.readOptionalPluginText(plugin.absoluteDir, config.attrPath),
        ...sourcePaths.map((relativePath) =>
          this.readOptionalPluginText(plugin.absoluteDir, relativePath),
        ),
      ]);
      const scriptRaw = assetSources.slice(0, config.scriptPaths.length);
      const styleRaw = assetSources.slice(config.scriptPaths.length);

      if (
        !attrRaw &&
        scriptRaw.every((source) => !source) &&
        styleRaw.every((source) => !source)
      ) {
        continue;
      }

      const attrKeys = this.extractPhpArrayKeys(attrRaw);
      const defaults =
        config.key === 'modal'
          ? this.extractSpectraModalDefaults(styleRaw)
          : config.key === 'slider'
            ? this.extractSpectraSliderDefaults(attrRaw, styleRaw)
            : config.key === 'tabs'
              ? this.extractSpectraTabsDefaults(attrRaw)
              : config.key === 'accordion'
                ? this.extractSpectraAccordionDefaults(attrRaw)
                : undefined;
      widgets[config.key] = {
        blockType: config.blockType,
        runtime: config.runtime,
        attrKeys: config.preferredAttrKeys.filter((key) =>
          attrKeys.includes(key),
        ),
        scriptFiles: config.scriptPaths.filter(
          (_, index) => !!scriptRaw[index],
        ),
        styleFiles: config.stylePaths.filter((_, index) => !!styleRaw[index]),
        appearance: this.extractInteractiveAppearanceSignature({
          combinedSources: [attrRaw, ...scriptRaw, ...styleRaw],
          wrapperClasses: config.appearance.wrapperClasses,
          itemClasses: config.appearance.itemClasses,
          activeClasses: config.appearance.activeClasses,
          variantPattern: config.appearance.variantPattern,
          behaviorPattern: config.appearance.behaviorPattern,
          alignmentClasses: config.appearance.alignmentClasses,
          styleCueDetectors: config.appearance.styleCueDetectors,
        }),
        ...(defaults ? { defaults } : {}),
        notes: config.notes,
      };
    }

    if (Object.keys(widgets).length === 0) return undefined;

    return {
      detected: true,
      pluginSlug: plugin.slug,
      widgets,
    };
  }

  private buildLightweightPluginManifest(
    pluginRoot: string,
    slug: string,
    known: KnownPluginDef,
  ): RepoPluginManifest {
    return {
      slug,
      relativeDir: this.describePluginRelativeDir(pluginRoot, slug),
      absoluteDir: join(pluginRoot, slug),
      totalFiles: 0,
      isKnown: true,
      pluginType: known.type,
      keyRoutes: known.keyRoutes,
      pluginNotes: known.notes,
      hasTemplatesDir: false,
      hasAssetsDir: false,
      hasPhpFiles: false,
      entryPhpFiles: [],
      layoutFiles: [],
      runtimeFiles: [],
      assetFiles: [],
    };
  }

  private buildPluginManifest(
    pluginRoot: string,
    slug: string,
    fileTree: string[],
    known?: KnownPluginDef,
  ): RepoPluginManifest {
    const filesByRole = this.bucketFiles(fileTree);
    const assetManifest = this.categorizeAssets(fileTree);
    const relativeDir = this.describePluginRelativeDir(pluginRoot, slug);
    const entryPhpFiles = fileTree
      .filter((file) => !file.includes('/') && file.endsWith('.php'))
      .slice(0, 8);
    const layoutFiles = Array.from(
      new Set([
        ...filesByRole.templates,
        ...filesByRole.templateParts,
        ...filesByRole.patterns,
        ...filesByRole.phpTemplates.filter(
          (file) => /^templates?\//i.test(file) || /^views?\//i.test(file),
        ),
      ]),
    ).slice(0, 20);
    const runtimeFiles = Array.from(
      new Set([...entryPhpFiles, ...filesByRole.phpRuntime]),
    ).slice(0, 20);
    const assetFiles = Array.from(
      new Set([
        ...assetManifest.css,
        ...assetManifest.js,
        ...assetManifest.images,
        ...assetManifest.svg,
        ...assetManifest.fonts,
        ...assetManifest.video,
      ]),
    ).slice(0, 20);

    return {
      slug,
      relativeDir,
      absoluteDir: join(pluginRoot, slug),
      totalFiles: fileTree.length,
      isKnown: !!known,
      pluginType: known?.type,
      keyRoutes: known?.keyRoutes ?? [],
      pluginNotes: known?.notes ?? [],
      hasTemplatesDir: fileTree.some(
        (file) => /^templates?\//i.test(file) || /^views?\//i.test(file),
      ),
      hasAssetsDir: fileTree.some(
        (file) =>
          file.startsWith('assets/') ||
          file.startsWith('build/') ||
          file.startsWith('dist/') ||
          file.startsWith('images/') ||
          file.startsWith('css/') ||
          file.startsWith('js/'),
      ),
      hasPhpFiles: fileTree.some((file) => file.endsWith('.php')),
      entryPhpFiles,
      layoutFiles,
      runtimeFiles,
      assetFiles,
    };
  }

  private normalizePluginSlug(value: string): string {
    const normalized = value.trim().toLowerCase();
    return normalized === 'spectra'
      ? 'ultimate-addons-for-gutenberg'
      : normalized;
  }

  private extractInteractiveAppearanceSignature(input: {
    combinedSources: Array<string | null>;
    wrapperClasses: string[];
    itemClasses: string[];
    activeClasses: string[];
    variantPattern: RegExp;
    behaviorPattern: RegExp;
    alignmentClasses: string[];
    styleCueDetectors: Array<{
      pattern: RegExp;
      cue: string;
    }>;
  }): RepoInteractiveAppearanceSignature | undefined {
    const raw = input.combinedSources.filter(Boolean).join('\n');
    if (!raw.trim()) return undefined;

    const collectExact = (tokens: string[]) =>
      tokens.filter((token) => raw.includes(token));
    const collectPattern = (pattern: RegExp) =>
      Array.from(
        new Set(
          Array.from(raw.matchAll(pattern))
            .map((match) => match[0]?.trim())
            .filter((value): value is string => !!value),
        ),
      ).sort();

    const wrapperClasses = collectExact(input.wrapperClasses);
    const itemClasses = collectExact(input.itemClasses);
    const activeClasses = collectExact(input.activeClasses);
    const variantClasses = collectPattern(input.variantPattern);
    const behaviorClasses = collectPattern(input.behaviorPattern);
    const alignmentClasses = collectExact(input.alignmentClasses);
    const styleCues = input.styleCueDetectors
      .filter((detector) => detector.pattern.test(raw))
      .map((detector) => detector.cue);

    if (
      wrapperClasses.length === 0 &&
      itemClasses.length === 0 &&
      activeClasses.length === 0 &&
      variantClasses.length === 0 &&
      behaviorClasses.length === 0 &&
      alignmentClasses.length === 0 &&
      styleCues.length === 0
    ) {
      return undefined;
    }

    return {
      wrapperClasses,
      itemClasses,
      activeClasses,
      variantClasses,
      behaviorClasses,
      alignmentClasses,
      styleCues,
    };
  }

  private async resolvePluginRoots(themeDir: string): Promise<string[]> {
    const candidates = new Set<string>();
    let current = resolve(themeDir);

    for (let i = 0; i < 5; i++) {
      candidates.add(join(current, 'plugins'));
      candidates.add(join(current, 'wp-content', 'plugins'));

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    const roots: string[] = [];
    for (const candidate of candidates) {
      const entries = await this.readDirEntries(candidate);
      if (entries.some((entry) => entry.isDirectory())) {
        roots.push(candidate);
      }
    }

    return roots.sort((a, b) => a.localeCompare(b));
  }

  private async resolveThemeRoots(themeDir: string): Promise<string[]> {
    const candidates = new Set<string>();
    let current = resolve(themeDir);

    for (let i = 0; i < 5; i++) {
      candidates.add(join(current, 'themes'));
      candidates.add(join(current, 'wp-content', 'themes'));

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    const roots: string[] = [];
    for (const candidate of candidates) {
      const entries = await this.readDirEntries(candidate);
      if (entries.some((entry) => entry.isDirectory())) {
        roots.push(candidate);
      }
    }

    return roots.sort((a, b) => a.localeCompare(b));
  }

  private describeThemeRelativeDir(themeRoot: string, slug: string): string {
    const parentName = basename(dirname(themeRoot));
    return parentName === 'wp-content'
      ? `wp-content/themes/${slug}`
      : `themes/${slug}`;
  }

  private describePluginRelativeDir(pluginRoot: string, slug: string): string {
    const parentName = basename(dirname(pluginRoot));
    return parentName === 'wp-content'
      ? `wp-content/plugins/${slug}`
      : `plugins/${slug}`;
  }

  private async readDirEntries(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private isPhpTemplateFile(file: string): boolean {
    if (file === 'functions.php') return false;
    if (RUNTIME_DIR_PREFIXES.some((prefix) => file.startsWith(prefix)))
      return false;
    if (file.startsWith('patterns/')) return true;
    if (file.startsWith('template-parts/')) return true;
    if (!file.includes('/')) return true;
    return /(templates?|parts?)\/.+\.php$/i.test(file);
  }

  private matchesDirAndExt(
    file: string,
    dirName: string,
    extensions: string[],
  ): boolean {
    return file.startsWith(`${dirName}/`) && extensions.includes(extname(file));
  }

  private async readOptionalText(
    themeDir: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      return await readFile(join(themeDir, relativePath), 'utf-8');
    } catch {
      return null;
    }
  }

  private async readOptionalPluginText(
    pluginDir: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      return await readFile(join(pluginDir, relativePath), 'utf-8');
    } catch {
      return null;
    }
  }

  private extractPhpArrayKeys(raw: string | null): string[] {
    if (!raw) return [];
    return Array.from(
      new Set(
        Array.from(raw.matchAll(/'([A-Za-z0-9_]+)'\s*=>/g))
          .map((match) => match[1]?.trim())
          .filter((value): value is string => !!value),
      ),
    ).sort();
  }

  private extractSpectraModalDefaults(
    styleSources: Array<string | null>,
  ): RepoInteractiveWidgetDefaults | undefined {
    const raw = styleSources.filter(Boolean).join('\n');
    if (!raw.trim()) return undefined;

    const width = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-wrap',
      'width',
    );
    const height = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-wrap',
      'height',
    );
    const maxWidth = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-wrap',
      'max-width',
    );
    const overlayColor = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup.active',
      'background',
    );
    const background = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-wrap',
      'background',
    );
    const textColor = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-wrap',
      'color',
    );
    const contentPadding = this.extractCssPropertyValue(
      raw,
      '.uagb-modal-popup .uagb-modal-popup-content',
      'padding',
    );

    const defaults: RepoInteractiveWidgetDefaults = {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(maxWidth ? { maxWidth } : {}),
      ...(overlayColor ? { overlayColor } : {}),
      ...(background ? { background } : {}),
      ...(textColor ? { textColor } : {}),
      ...(contentPadding ? { contentPadding } : {}),
    };

    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private extractSpectraSliderDefaults(
    attrRaw: string | null,
    styleSources: Array<string | null>,
  ): RepoInteractiveWidgetDefaults | undefined {
    const raw = styleSources.filter(Boolean).join('\n');
    const hasStyle = raw.trim().length > 0;
    const hasAttrs = (attrRaw ?? '').trim().length > 0;
    if (!hasStyle && !hasAttrs) return undefined;

    const arrowBackground =
      (hasStyle
        ? (this.extractCssPropertyValue(
            raw,
            '.uagb-slider-container .swiper-button-prev,.uagb-slider-container .swiper-button-next',
            'background',
          ) ??
          this.extractCssPropertyValue(
            raw,
            '.uagb-slider-container .swiper-button-next,.uagb-slider-container .swiper-button-prev',
            'background',
          ))
        : undefined) ?? this.extractPhpScalarDefault(attrRaw, 'arrowBgColor');
    const arrowColor = this.extractPhpScalarDefault(attrRaw, 'arrowColor');
    const dotsColor =
      this.extractPhpScalarDefault(attrRaw, 'arrowColor') ?? arrowColor;
    const slideHeight = this.extractPhpDimensionDefault(
      attrRaw,
      'minHeight',
      'px',
    );
    const autoplay = this.extractPhpBooleanDefault(attrRaw, 'autoplay');
    const autoplaySpeed = this.extractPhpNumberDefault(
      attrRaw,
      'autoplaySpeed',
    );
    const loop = this.extractPhpBooleanDefault(attrRaw, 'infiniteLoop');
    const effect = this.extractPhpScalarDefault(attrRaw, 'transitionEffect');
    const showDots = this.extractPhpBooleanDefault(attrRaw, 'displayDots');
    const showArrows = this.extractPhpBooleanDefault(attrRaw, 'displayArrows');
    const vertical = this.extractPhpBooleanDefault(attrRaw, 'verticalMode');
    const transitionSpeed = this.extractPhpNumberDefault(
      attrRaw,
      'transitionSpeed',
    );
    const pauseOn = this.extractPhpScalarDefault(attrRaw, 'pauseOn');

    const defaults: RepoInteractiveWidgetDefaults = {
      ...(slideHeight ? { slideHeight } : {}),
      ...(arrowBackground ? { arrowBackground } : {}),
      ...(arrowColor ? { arrowColor } : {}),
      ...(dotsColor ? { dotsColor } : {}),
      ...(typeof autoplay === 'boolean' ? { autoplay } : {}),
      ...(typeof autoplaySpeed === 'number' ? { autoplaySpeed } : {}),
      ...(typeof loop === 'boolean' ? { loop } : {}),
      ...(effect ? { effect } : {}),
      ...(typeof showDots === 'boolean' ? { showDots } : {}),
      ...(typeof showArrows === 'boolean' ? { showArrows } : {}),
      ...(typeof vertical === 'boolean' ? { vertical } : {}),
      ...(typeof transitionSpeed === 'number' ? { transitionSpeed } : {}),
      ...(pauseOn ? { pauseOn } : {}),
    };

    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private extractSpectraTabsDefaults(
    attrRaw: string | null,
  ): RepoInteractiveWidgetDefaults | undefined {
    if (!(attrRaw ?? '').trim()) return undefined;

    const activeTab =
      this.extractPhpNumberDefault(attrRaw, 'tabActiveFrontend') ??
      this.extractPhpNumberDefault(attrRaw, 'tabActive');
    const variant = this.extractPhpScalarDefault(attrRaw, 'tabsStyleD');
    const tabAlign = this.extractPhpScalarDefault(attrRaw, 'tabAlign');
    const iconPosition = this.extractPhpScalarDefault(attrRaw, 'iconPosition');

    const defaults: RepoInteractiveWidgetDefaults = {
      ...(typeof activeTab === 'number' ? { activeTab } : {}),
      ...(variant ? { variant } : {}),
      ...(tabAlign ? { tabAlign } : {}),
      ...(iconPosition ? { iconPosition } : {}),
    };

    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private extractSpectraAccordionDefaults(
    attrRaw: string | null,
  ): RepoInteractiveWidgetDefaults | undefined {
    if (!(attrRaw ?? '').trim()) return undefined;

    const layout = this.extractPhpScalarDefault(attrRaw, 'layout');
    const inactiveOtherItems = this.extractPhpBooleanDefault(
      attrRaw,
      'inactiveOtherItems',
    );
    const expandFirstItem = this.extractPhpBooleanDefault(
      attrRaw,
      'expandFirstItem',
    );
    const enableToggle = this.extractPhpBooleanDefault(attrRaw, 'enableToggle');
    const allowMultiple =
      typeof inactiveOtherItems === 'boolean' ? !inactiveOtherItems : undefined;
    const defaultOpenItems =
      expandFirstItem === true
        ? [0]
        : expandFirstItem === false
          ? []
          : undefined;

    const defaults: RepoInteractiveWidgetDefaults = {
      ...(layout ? { layout } : {}),
      ...(typeof allowMultiple === 'boolean' ? { allowMultiple } : {}),
      ...(defaultOpenItems ? { defaultOpenItems } : {}),
      ...(typeof enableToggle === 'boolean' ? { enableToggle } : {}),
    };

    return Object.keys(defaults).length > 0 ? defaults : undefined;
  }

  private extractPhpScalarDefault(
    raw: string | null,
    key: string,
  ): string | undefined {
    if (!raw) return undefined;
    const match = raw.match(
      new RegExp(`'${this.escapeRegExp(key)}'\\s*=>\\s*'([^']*)'`, 'i'),
    );
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  }

  private extractPhpNumberDefault(
    raw: string | null,
    key: string,
  ): number | undefined {
    if (!raw) return undefined;
    const match = raw.match(
      new RegExp(
        `'${this.escapeRegExp(key)}'\\s*=>\\s*(-?\\d+(?:\\.\\d+)?)`,
        'i',
      ),
    );
    const value = match?.[1];
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private extractPhpBooleanDefault(
    raw: string | null,
    key: string,
  ): boolean | undefined {
    if (!raw) return undefined;
    const match = raw.match(
      new RegExp(`'${this.escapeRegExp(key)}'\\s*=>\\s*(true|false)`, 'i'),
    );
    const value = match?.[1]?.toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  private extractPhpDimensionDefault(
    raw: string | null,
    key: string,
    unit: string,
  ): string | undefined {
    const value = this.extractPhpNumberDefault(raw, key);
    if (typeof value !== 'number') return undefined;
    return `${value}${unit}`;
  }

  private extractCssPropertyValue(
    raw: string,
    selector: string,
    property: string,
  ): string | undefined {
    if (!raw.trim()) return undefined;
    const match = raw.match(
      new RegExp(
        `${this.escapeRegExp(selector)}\\s*\\{[^{}]*?${this.escapeRegExp(property)}\\s*:\\s*([^;}{]+)`,
        'i',
      ),
    );
    const value = match?.[1]?.trim();
    if (!value) return undefined;
    return value.replace(/\s*!important$/i, '').trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async walk(dir: string, base = dir): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walk(full, base)));
        continue;
      }

      const relative = full
        .slice(base.length)
        .replace(/^[/\\]/, '')
        .replace(/\\/g, '/');

      if (relative.length > 0) results.push(relative);
    }

    return results;
  }
}
