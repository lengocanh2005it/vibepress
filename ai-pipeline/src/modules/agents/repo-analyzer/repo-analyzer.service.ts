import { Injectable, Logger } from '@nestjs/common';
import { readFile, readdir } from 'fs/promises';
import { basename, dirname, extname, join, resolve } from 'path';

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
const RUNTIME_DIR_PREFIXES = ['inc/', 'src/', 'app/', 'classes/', 'includes/'];

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
  // WordPress default block themes
  twentytwentyfour: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  twentytwentythree: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  twentytwentytwo: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  // WordPress default classic themes
  twentytwentyone: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  twentytwenty: { vendor: 'wordpress', usesPageBuilder: false, notes: [] },
  // Popular multipurpose (classic/hybrid)
  astra: { vendor: 'brainstorm-force', usesPageBuilder: false, notes: [] },
  generatepress: { vendor: 'tom-usborne', usesPageBuilder: false, notes: [] },
  oceanwp: { vendor: 'oceanwp', usesPageBuilder: false, notes: [] },
  kadence: { vendor: 'kadence-wp', usesPageBuilder: false, notes: [] },
  blocksy: { vendor: 'creativethemes', usesPageBuilder: false, notes: [] },
  'hello-elementor': {
    vendor: 'elementor',
    usesPageBuilder: true,
    pageBuilderSlug: 'elementor',
    notes: [
      'Hello Elementor is a minimal wrapper — all layouts are built in Elementor and stored in DB.',
    ],
  },
  // Page-builder-dependent themes
  divi: {
    vendor: 'elegant-themes',
    usesPageBuilder: true,
    pageBuilderSlug: 'divi',
    notes: [
      'Divi stores page layouts as serialized meta in DB — PHP template files are mostly empty wrappers.',
    ],
  },
  extra: {
    vendor: 'elegant-themes',
    usesPageBuilder: true,
    pageBuilderSlug: 'divi',
    notes: [
      'Extra (Elegant Themes) uses Divi Builder — layouts are in DB, not template files.',
    ],
  },
  avada: {
    vendor: 'theme-fusion',
    usesPageBuilder: true,
    pageBuilderSlug: 'fusion-builder',
    notes: [
      'Avada/Fusion Builder stores layouts in DB — actual page structure is not in theme template files.',
    ],
  },
  betheme: { vendor: 'muffinthemes', usesPageBuilder: false, notes: [] },
  enfold: { vendor: 'kriesi', usesPageBuilder: false, notes: [] },
  salient: { vendor: 'themenectar', usesPageBuilder: false, notes: [] },
  bridge: { vendor: 'qode', usesPageBuilder: false, notes: [] },
  flatsome: { vendor: 'ux-themes', usesPageBuilder: false, notes: [] },
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
    const themeSlug = basename(themeDir);
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
      /wp_enqueue_script\s*\(\s*['"]([^'"]+)['"]/g,
    )) {
      enqueuedScriptHandles.add(match[1]);
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
      imageSizes: Array.from(imageSizes).sort(),
      editorStyleFiles: Array.from(editorStyleFiles).sort(),
    };
  }

  private async extractStructureHints(
    themeDir: string,
    filesByRole: RepoFileBuckets,
  ): Promise<RepoStructureHints> {
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

    for (const { file, content } of contents) {
      if (!content) continue;
      const fileBlockTypes = new Set<string>();

      for (const match of content.matchAll(
        /<!--\s+wp:template-part\s+(\{[\s\S]*?\})\s*\/?-->/g,
      )) {
        const slugMatch = match[1].match(/"slug"\s*:\s*"([^"]+)"/);
        if (slugMatch?.[1]) templatePartRefs.add(slugMatch[1]);
      }

      for (const match of content.matchAll(
        /get_template_part\s*\(\s*['"]([^'"]+)['"]/g,
      )) {
        templatePartRefs.add(match[1]);
      }

      for (const match of content.matchAll(
        /<!--\s+wp:pattern\s+(\{[\s\S]*?\})\s*\/?-->/g,
      )) {
        const slugMatch = match[1].match(/"slug"\s*:\s*"([^"]+)"/);
        if (slugMatch?.[1]) patternRefs.add(slugMatch[1]);
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
        referencedAssetPaths.add(match[1]);
      }

      for (const match of content.matchAll(
        /url\((['"]?)([^'")]+\.(?:css|js|png|jpe?g|svg|webp|woff2?|ttf|otf))\1\)/gi,
      )) {
        referencedAssetPaths.add(match[2]);
      }

      // Parse PHP header comments in patterns/ files
      // e.g. * Title: Hero Section \n * Slug: theme/hero \n * Categories: featured, banner
      if (file.startsWith('patterns/') && file.endsWith('.php')) {
        const meta = this.parsePatternPhpHeader(file, content);
        if (meta) patternMeta.push(meta);
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
    }

    const normalizedBlockTypes = Array.from(blockTypes).sort();

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
      ]),
    );
    const runtimeFiles = Array.from(
      new Set([
        ...(themeTypeHints.hasFunctionsPhp ? ['functions.php'] : []),
        ...filesByRole.phpRuntime,
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
    const widgetConfigs = [
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
