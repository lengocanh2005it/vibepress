import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  copyFile,
  readdir,
} from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { basename, extname } from 'path';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { ReactGenerateResult } from '../react-generator/react-generator.service.js';
import type {
  ThemeInteractionState,
  ThemeTokens,
} from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import { isPartialComponentName } from '../shared/component-kind.util.js';
import { AssetDownloaderService } from './asset-downloader.service.js';
import { ValidatorService } from '../validator/validator.service.js';
import type {
  WpDbGlobalStyle,
  WpCustomCssEntry,
  WpPage,
  WpPost,
  WpSiteInfo,
} from '../../sql/wp-query.service.js';
import {
  buildUiSourceMapForProject,
  writeUiSourceMapArtifacts,
} from '../../edit-request/ui-source-map.util.js';

export interface PreviewRouteEntry {
  route: string;
  componentName: string;
}

export interface PreviewBuilderResult {
  jobId: string;
  previewDir: string;
  frontendDir: string;
  entryPath: string;
  previewUrl: string;
  apiBaseUrl: string;
  routeEntries: PreviewRouteEntry[];
  uiSourceMapPath?: string;
  frontendPid?: number;
  serverPid?: number;
}

const TEMPLATE_DIR = resolve('templates/react-preview');
const SERVER_TEMPLATE_DIR = resolve('templates/express-server');
const DEP_CACHE_ROOT = resolve('temp/cache/template-deps');

@Injectable()
export class PreviewBuilderService {
  private readonly logger = new Logger(PreviewBuilderService.name);

  constructor(
    private readonly configService: ConfigService,
    private assetDownloader: AssetDownloaderService,
    private readonly validator: ValidatorService,
  ) {}

  async build(input: {
    jobId: string;
    components: ReactGenerateResult;
    dbCreds: WpDbCredentials;
    content?: {
      posts: WpPost[];
      pages: WpPage[];
      dbGlobalStyles?: WpDbGlobalStyle[];
      customCssEntries?: WpCustomCssEntry[];
    };
    themeDir?: string;
    siteInfo?: WpSiteInfo;
    tokens?: ThemeTokens;
    plan?: PlanResult;
    outputDir?: string;
  }): Promise<PreviewBuilderResult> {
    const {
      jobId,
      components,
      dbCreds,
      content,
      themeDir,
      siteInfo,
      tokens,
      plan,
    } = input;
    const rootDir = input.outputDir ?? join('./temp/generated', jobId);
    const frontendDir = join(rootDir, 'frontend');
    const srcDir = join(frontendDir, 'src');
    const componentsDir = join(srcDir, 'components');
    const pagesDir = join(srcDir, 'pages');
    const allComponents = components.components;
    const headerComp = allComponents.find(
      (c) => /^header/i.test(c.name) && !c.isSubComponent,
    );
    const footerComp = allComponents.find(
      (c) => /^footer/i.test(c.name) && !c.isSubComponent,
    );
    const hasSharedHeader = !!headerComp;
    const hasSharedFooter = !!footerComp;

    // 1. Copy toàn bộ template vào frontend/
    this.logger.log(`Copying template to: ${frontendDir}`);
    await cp(TEMPLATE_DIR, frontendDir, { recursive: true });
    await mkdir(componentsDir, { recursive: true });
    await mkdir(pagesDir, { recursive: true });

    // 2. Copy theme assets (images, fonts) vào public/assets/
    if (themeDir) {
      const themeAssetsDir = join(themeDir, 'assets');
      const destImagesDir = join(frontendDir, 'public', 'assets', 'images');
      const destFontsDir = join(frontendDir, 'public', 'assets', 'fonts');
      await this.assetDownloader.copyAssets(
        themeAssetsDir,
        destImagesDir,
        destFontsDir,
      );
    }

    const wpUploadAssetUrls = this.collectWordPressUploadUrls({
      components: components.components,
      content,
      siteUrl: siteInfo?.siteUrl,
    });
    if (wpUploadAssetUrls.length > 0) {
      await this.copyWordPressUploadAssetsToPublic(
        wpUploadAssetUrls,
        join(frontendDir, 'public', 'assets', 'images'),
        siteInfo?.siteUrl,
      );
    }

    const copiedLogoPublicPath = await this.copySiteLogoToPublic(
      siteInfo?.logoUrl ?? null,
      join(frontendDir, 'public', 'assets', 'images'),
    );

    // 3. Write generated components từ AI (code in memory)
    // Relink WordPress image URLs từ /wp-content/uploads/ sang local /assets/images/
    for (const comp of components.components) {
      comp.code = this.prepareGeneratedComponentCode(
        comp.code,
        tokens,
        comp.name,
      );
      const isPartial =
        isPartialComponentName(comp.name) || comp.isSubComponent;
      const targetDir = isPartial ? componentsDir : pagesDir;

      // Match WordPress URLs (http://localhost/wp-content/uploads/... hoặc https://domain.com/wp-content/uploads/...)
      const wpUploadPattern =
        /https?:\/\/[^"'\s]+\/wp-content\/uploads\/[^"'\s)]+/gi;
      comp.code = comp.code.replace(wpUploadPattern, (match) => {
        const localPath = this.toLocalWpUploadAssetPath(
          match,
          siteInfo?.siteUrl,
        );
        this.logger.log(`Relinked WP image: ${match} -> ${localPath}`);
        return localPath;
      });

      if (!isPartial && (hasSharedHeader || hasSharedFooter)) {
        comp.code = this.stripSharedLayoutSectionsFromPageCode(comp.code, {
          header: hasSharedHeader,
          footer: hasSharedFooter,
        });
      }

      await writeFile(join(targetDir, `${comp.name}.tsx`), comp.code, 'utf-8');
    }

    // 3b. Copy đúng các asset mà component generated đang reference.
    // Điều này tránh case assets/ có tồn tại nhưng thiếu các ảnh con mà JSX dùng.
    if (themeDir) {
      const { missing: missingAssets, remapped: remappedAssets } =
        await this.copyReferencedThemeAssets(
          themeDir,
          join(frontendDir, 'public'),
          components.components,
        );

      // Remap paths where the file exists under /assets/images/ but was referenced
      // as /assets/<file> (common mismatch between theme image copy and AI-generated paths).
      if (remappedAssets.size > 0) {
        for (const comp of components.components) {
          let code = comp.code;
          for (const [oldPath, newPath] of remappedAssets) {
            // Replace all variants: /assets/foo.png and assets/foo.png
            code = code.split(oldPath).join(newPath);
            const withoutLeadingSlash = oldPath.replace(/^\//, '');
            code = code.split(withoutLeadingSlash).join(newPath);
          }
          if (code === comp.code) continue;
          comp.code = code;
          const isPartial =
            isPartialComponentName(comp.name) || comp.isSubComponent;
          const targetDir = isPartial ? componentsDir : pagesDir;
          await writeFile(
            join(targetDir, `${comp.name}.tsx`),
            comp.code,
            'utf-8',
          );
        }
        this.logger.log(
          `Remapped ${remappedAssets.size} asset path(s) to /assets/images/ subdir`,
        );
      }

      if (missingAssets.size > 0) {
        for (const comp of components.components) {
          const stripped = this.stripImgTagsForMissingAssets(
            comp.code,
            missingAssets,
          );
          if (stripped === comp.code) continue;
          comp.code = stripped;
          const isPartial =
            isPartialComponentName(comp.name) || comp.isSubComponent;
          const targetDir = isPartial ? componentsDir : pagesDir;
          await writeFile(
            join(targetDir, `${comp.name}.tsx`),
            comp.code,
            'utf-8',
          );
        }
        this.logger.log(
          `Removed <img> / empty JSX for ${missingAssets.size} missing theme asset(s)`,
        );
      }
    }

    // 3. Generate App.tsx với routes từ components
    // Sub-components (isSubComponent=true) are assembled inside their parent.
    // They must NOT become standalone routes.
    const routeableComponents = allComponents.filter((c) => !c.isSubComponent);

    // Partials: không tạo route (header, footer, sidebar, nav, meta, search form, comments, widgets...)
    const pageComponents = routeableComponents.filter(
      (c) => !isPartialComponentName(c.name),
    );
    const notFoundComponent =
      pageComponents.find((c) => c.name === 'Page404') ?? null;
    const primaryPageComponents = pageComponents.filter(
      (c) => c.name !== 'Page404',
    );

    // Detect shared Header/Footer partials để tạo Layout wrapper
    const hasSharedLayout = !!(headerComp || footerComp);

    // Nếu có Header/Footer, gen Layout.tsx để wrap tất cả các trang
    if (hasSharedLayout) {
      const headerImport = headerComp
        ? `import ${headerComp.name} from './${headerComp.name}';`
        : '';
      const footerImport = footerComp
        ? `import ${footerComp.name} from './${footerComp.name}';`
        : '';
      const headerJsx = headerComp ? `      <${headerComp.name} />` : '';
      const footerJsx = footerComp ? `      <${footerComp.name} />` : '';

      // Apply theme root background/text color so Layout wrapper matches the WP site
      const rootStyleParts: string[] = [];
      if (tokens?.defaults?.bgColor)
        rootStyleParts.push(`backgroundColor: '${tokens.defaults.bgColor}'`);
      if (tokens?.defaults?.textColor)
        rootStyleParts.push(`color: '${tokens.defaults.textColor}'`);
      const rootStyle =
        rootStyleParts.length > 0
          ? ` style={{${rootStyleParts.join(', ')}}}`
          : '';

      const layoutLines = [
        `import React from 'react';`,
        headerImport,
        footerImport,
        ``,
        `export default function Layout({ children }: { children: React.ReactNode }) {`,
        `  return (`,
        `    <div className="min-h-screen flex flex-col"${rootStyle}>`,
        headerJsx,
        `      <main className="flex-1">{children}</main>`,
        footerJsx,
        `    </div>`,
        `  );`,
        `}`,
      ]
        .filter((l) => l !== '')
        .join('\n');

      await writeFile(join(componentsDir, 'Layout.tsx'), layoutLines, 'utf-8');
      this.logger.log(
        `Generated Layout.tsx with ${[headerComp?.name, footerComp?.name].filter(Boolean).join(' + ')}`,
      );
    }

    const uiSourceMapPath = await this.writeUiSourceMap({
      previewDir: rootDir,
      frontendDir,
      srcDir,
      components: components.components,
      plan,
    });

    // Build route map từ plan (primary) — fallback sang convention nếu plan thiếu
    const FALLBACK_ROUTE_MAP: Record<string, string> = {
      Home: '/',
      Index: '/',
      FrontPage: '/',
      Single: '/post/:slug',
      SingleWithSidebar: '/post/:slug',
      Page: '/page/:slug',
      PageWithSidebar: '/page/:slug',
      PageWide: '/page/:slug',
      PageNoTitle: '/page/:slug',
      Archive: '/archive',
      Category: '/category/:slug',
      Tag: '/tag/:slug',
      Author: '/author/:slug',
      Search: '/search',
      Page404: '*',
    };

    const planRouteMap = new Map<string, string>();
    if (plan) {
      for (const p of plan) {
        if (p.route) planRouteMap.set(p.componentName, p.route);
      }
    }

    // Khi có Layout, Header/Footer đã được import bởi Layout — không cần import lại trong App.tsx
    const layoutManagedNames = new Set(
      [headerComp?.name, footerComp?.name].filter(Boolean) as string[],
    );
    const routeImports = allComponents
      .filter((c) => !hasSharedLayout || !layoutManagedNames.has(c.name))
      .map((c) => {
        const folder =
          isPartialComponentName(c.name) || c.isSubComponent
            ? 'components'
            : 'pages';
        return `import ${c.name} from './${folder}/${c.name}';`;
      })
      .join('\n');

    // Tạo routes chỉ cho page components, tránh duplicate paths
    const usedPaths = new Set<string>();
    const usedPathOwners = new Map<string, string>();
    const routeLines: string[] = [];
    const routeEntries: PreviewRouteEntry[] = [];

    for (const c of primaryPageComponents) {
      const path =
        planRouteMap.get(c.name) ??
        FALLBACK_ROUTE_MAP[c.name] ??
        `/${c.name.toLowerCase()}`;
      if (usedPaths.has(path)) {
        this.logger.warn(
          `Duplicate preview route "${path}" for "${c.name}" ignored; already owned by "${usedPathOwners.get(path) ?? 'unknown'}"`,
        );
        continue;
      }
      usedPaths.add(path);
      usedPathOwners.set(path, c.name);
      routeLines.push(
        `        <Route path="${path}" element={<${c.name} />} />`,
      );
      routeEntries.push({ route: path, componentName: c.name });
    }

    // WordPress archive fallback: if Archive exists but no Author/Category/Tag,
    // register alias routes pointing to Archive (mirrors WP template hierarchy).
    const archiveComp = primaryPageComponents.find((c) => c.name === 'Archive');
    if (archiveComp) {
      const archiveAliases: Array<{ path: string }> = [
        { path: '/category/:slug' },
        { path: '/author/:slug' },
        { path: '/tag/:slug' },
      ];
      for (const alias of archiveAliases) {
        if (!usedPaths.has(alias.path)) {
          usedPaths.add(alias.path);
          usedPathOwners.set(alias.path, 'Archive');
          routeLines.push(
            `        <Route path="${alias.path}" element={<Archive />} />`,
          );
          routeEntries.push({ route: alias.path, componentName: 'Archive' });
        }
      }
    }

    // Đảm bảo luôn có route "/" — dùng component đầu tiên nếu chưa có
    if (!usedPaths.has('/') && primaryPageComponents.length > 0) {
      routeLines.unshift(
        `        <Route path="/" element={<${primaryPageComponents[0].name} />} />`,
      );
      usedPathOwners.set('/', primaryPageComponents[0].name);
      routeEntries.unshift({
        route: '/',
        componentName: primaryPageComponents[0].name,
      });
    }

    // Register the catch-all route explicitly at the end so 404 handling
    // never depends on the general page loop ordering/filtering.
    if (notFoundComponent) {
      const notFoundPath =
        planRouteMap.get(notFoundComponent.name) ??
        FALLBACK_ROUTE_MAP[notFoundComponent.name] ??
        '*';
      if (!usedPaths.has(notFoundPath)) {
        usedPaths.add(notFoundPath);
        usedPathOwners.set(notFoundPath, notFoundComponent.name);
        routeLines.push(
          `        <Route path="${notFoundPath}" element={<${notFoundComponent.name} />} />`,
        );
        routeEntries.push({
          route: notFoundPath,
          componentName: notFoundComponent.name,
        });
      }
    }

    const routes = routeLines.join('\n');
    const smokeRoutes = this.buildSmokeRoutes([...usedPaths]);

    const layoutImport = hasSharedLayout
      ? `import Layout from './components/Layout';`
      : '';
    const routesBlock = hasSharedLayout
      ? `    <Layout>\n      <Routes>\n${routes}\n      </Routes>\n    </Layout>`
      : `    <Routes>\n${routes}\n    </Routes>`;

    await writeFile(
      join(srcDir, 'App.tsx'),
      `import { Routes, Route } from 'react-router-dom';
${layoutImport}
${routeImports}

export default function App() {
  return (
${routesBlock}
  );
}
`,
    );

    // 4. Generate tailwind.config.js + inject Google Fonts từ theme tokens
    if (tokens) {
      await this.applyThemeTokens(
        frontendDir,
        tokens,
        content?.dbGlobalStyles ?? [],
        content?.customCssEntries ?? [],
      );
    }

    // 5. Generate .env cho từng folder
    const apiPort = this.pickApiPort(jobId);
    const vitePort = this.pickVitePort(jobId);
    const serverDir = join(rootDir, 'server');

    // frontend/.env — chỉ cần biết API chạy ở đâu
    await writeFile(
      join(frontendDir, '.env'),
      `VITE_PORT=${vitePort}\nVITE_API_PORT=${apiPort}\nVITE_API_BASE=/preview/${jobId}/api\nVITE_BASE=/preview/${jobId}/\n`,
    );

    // server/.env — DB credentials + port
    const previewBase = `/preview/${jobId}/`;
    await writeFile(
      join(rootDir, 'server', '.env'),
      `API_PORT=${apiPort}\nDB_HOST=${dbCreds.host}\nDB_PORT=${dbCreds.port}\nDB_NAME=${dbCreds.dbName}\nDB_USER=${dbCreds.user}\nDB_PASSWORD=${dbCreds.password}\nPREVIEW_BASE=${previewBase}\n${siteInfo?.siteUrl ? `SITE_URL=${siteInfo.siteUrl}\n` : ''}${copiedLogoPublicPath ? `SITE_LOGO_URL=${previewBase}${copiedLogoPublicPath.replace(/^\//, '')}\n` : ''}`,
    );

    // 6. Reuse cached template dependencies, install only on cache miss
    this.logger.log('Preparing dependency cache...');
    await Promise.all([
      this.attachTemplateDependencies(
        TEMPLATE_DIR,
        frontendDir,
        'react-preview',
      ),
      this.attachTemplateDependencies(
        SERVER_TEMPLATE_DIR,
        serverDir,
        'express-server',
      ),
    ]);
    await this.validator.assertPreviewBuild(frontendDir);
    this.logger.log('Starting dev servers...');
    const frontendProc = this.spawnDevServer(frontendDir);
    const serverProc = this.spawnDevServer(serverDir);

    const previewUrl = `http://localhost:${vitePort}`;
    const apiBaseUrl = `http://localhost:${apiPort}/api`;
    await this.validator.assertPreviewRuntime(previewUrl, smokeRoutes);
    this.logger.log(`Preview ready at: ${previewUrl}`);
    const publicBase = this.configService.get<string>('automation.previewPublicBaseUrl', '');
    const publicPreviewUrl = publicBase ? `${publicBase}/preview/${jobId}/` : null;
    return {
      jobId,
      previewDir: rootDir,
      frontendDir,
      entryPath: join(srcDir, 'main.tsx'),
      previewUrl: publicPreviewUrl ?? previewUrl,
      apiBaseUrl,
      routeEntries,
      uiSourceMapPath,
      frontendPid: frontendProc.pid,
      serverPid: serverProc.pid,
    };
  }

  async syncGeneratedComponents(
    previewDir: string,
    components: ReactGenerateResult['components'],
    tokens?: ThemeTokens,
  ): Promise<void> {
    const frontendDir = join(previewDir, 'frontend');
    const srcDir = join(frontendDir, 'src');
    const componentsDir = join(srcDir, 'components');
    const pagesDir = join(srcDir, 'pages');

    await mkdir(componentsDir, { recursive: true });
    await mkdir(pagesDir, { recursive: true });

    for (const comp of components) {
      const code = this.prepareGeneratedComponentCode(
        comp.code,
        tokens,
        comp.name,
      );
      comp.code = code;
      const isPartial =
        isPartialComponentName(comp.name) || comp.isSubComponent;
      const targetDir = isPartial ? componentsDir : pagesDir;
      await writeFile(join(targetDir, `${comp.name}.tsx`), code, 'utf-8');
    }

    await this.writeUiSourceMap({
      previewDir,
      frontendDir,
      srcDir,
      components,
    });
  }

  private async writeUiSourceMap(input: {
    previewDir: string;
    frontendDir: string;
    srcDir: string;
    components: ReactGenerateResult['components'];
    plan?: PlanResult;
  }): Promise<string | undefined> {
    const { previewDir, frontendDir, srcDir, components, plan } = input;
    const entries = await buildUiSourceMapForProject({
      srcDir,
      components,
      plan,
    });

    if (entries.length === 0) return undefined;
    const uiSourceMapPath = await writeUiSourceMapArtifacts({
      entries,
      previewDir,
      frontendDir,
    });
    this.logger.log(
      `Generated ui-source-map.json with ${entries.length} tracked source node entries`,
    );
    return uiSourceMapPath;
  }

  private async applyThemeTokens(
    frontendDir: string,
    tokens: ThemeTokens,
    globalStyles: WpDbGlobalStyle[] = [],
    customCssEntries: WpCustomCssEntry[] = [],
  ): Promise<void> {
    // 1. Generate tailwind.config.js với colors từ theme.json
    const colorEntries = tokens.colors
      .map((c) => `      '${c.slug}': '${c.value}',`)
      .join('\n');

    const fontEntries = tokens.fonts
      .map((f) => `      '${f.slug}': '${f.family}',`)
      .join('\n');

    await writeFile(
      join(frontendDir, 'tailwind.config.js'),
      `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
${colorEntries}
      },
      fontFamily: {
${fontEntries}
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
`,
    );

    // 2. Inject Google Fonts vào index.html
    const googleFonts = tokens.fonts
      .map((f) => f.name)
      .filter(
        (name) => !name.startsWith('System') && !name.startsWith('-apple'),
      )
      .map((name) => name.replace(/\s+/g, '+'))
      .filter((v, i, a) => a.indexOf(v) === i);

    if (googleFonts.length > 0) {
      const fontQuery = googleFonts
        .map((f) => `family=${f}:wght@400;500;600;700`)
        .join('&');
      const linkTag = `<link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?${fontQuery}&display=swap" rel="stylesheet">`;

      const indexPath = join(frontendDir, 'index.html');
      const indexHtml = await readFile(indexPath, 'utf-8');
      await writeFile(
        indexPath,
        indexHtml.replace('</head>', `    ${linkTag}\n  </head>`),
      );
    }

    // 3. Inject theme design tokens into index.css so all components inherit
    //    without relying solely on AI-generated inline styles.
    const d = tokens.defaults;
    const cssLines: string[] = [];

    const bodyProps: string[] = [];
    if (d?.bgColor) bodyProps.push(`background-color: ${d.bgColor}`);
    if (d?.textColor) bodyProps.push(`color: ${d.textColor}`);
    if (d?.fontFamily) bodyProps.push(`font-family: ${d.fontFamily}`);
    if (d?.fontSize) bodyProps.push(`font-size: ${d.fontSize}`);
    if (d?.lineHeight) bodyProps.push(`line-height: ${d.lineHeight}`);
    if (bodyProps.length > 0)
      cssLines.push(`body { ${bodyProps.join('; ')}; }`);

    const headingProps: string[] = [];
    if (d?.headingFontFamily)
      headingProps.push(`font-family: ${d.headingFontFamily}`);
    if (d?.headingColor) headingProps.push(`color: ${d.headingColor}`);
    if (headingProps.length > 0)
      cssLines.push(`h1, h2, h3, h4, h5, h6 { ${headingProps.join('; ')}; }`);

    if (d?.headings) {
      for (const [level, style] of Object.entries(d.headings)) {
        const hProps: string[] = [];
        if (style.fontSize) hProps.push(`font-size: ${style.fontSize}`);
        if (style.fontWeight) hProps.push(`font-weight: ${style.fontWeight}`);
        if (hProps.length > 0)
          cssLines.push(`${level} { ${hProps.join('; ')}; }`);
      }
    }

    if (d?.linkColor) cssLines.push(`a { color: ${d.linkColor}; }`);

    if (cssLines.length > 0) {
      const cssPath = join(frontendDir, 'src', 'index.css');
      const existingCss = await readFile(cssPath, 'utf-8');
      await writeFile(
        cssPath,
        existingCss.trimEnd() + '\n\n' + cssLines.join('\n') + '\n',
      );
    }

    await this.applyWordPressCustomCss(
      frontendDir,
      globalStyles,
      customCssEntries,
    );

    await this.applyInteractionTokens(frontendDir, tokens);
    await this.applyBlockStyleBridges(frontendDir);
  }

  private async applyWordPressCustomCss(
    frontendDir: string,
    globalStyles: WpDbGlobalStyle[],
    customCssEntries: WpCustomCssEntry[],
  ): Promise<void> {
    const chunks: string[] = [];

    for (const row of globalStyles) {
      chunks.push(...this.extractCssFragmentsFromContent(row.content));
    }
    for (const row of customCssEntries) {
      chunks.push(...this.extractCssFragmentsFromContent(row.content));
    }

    const customCss = chunks
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!customCss) return;

    const normalizedCustomCss =
      this.normalizeWordPressCustomCssSelectors(customCss);

    const cssPath = join(frontendDir, 'src', 'index.css');
    const existingCss = await readFile(cssPath, 'utf-8');
    const marker = '/* Vibepress WordPress custom CSS */';
    if (existingCss.includes(marker)) return;

    const block = `${marker}\n${normalizedCustomCss}\n`;
    await writeFile(cssPath, `${existingCss.trimEnd()}\n\n${block}`);
  }

  private normalizeWordPressCustomCssSelectors(css: string): string {
    let next = this.sanitizeWordPressCustomCss(css);

    // Additional CSS in block themes often targets WordPress runtime markup like
    // `.wp-block-button .wp-block-button__link`, but generated React pages render
    // plain `<button>` / `<a>` elements with bridge classes instead. Add
    // equivalent selectors for the generated markup without removing the
    // original WordPress selectors.
    next = next.replace(
      new RegExp(
        String.raw`\.wp-block-button\.([_a-zA-Z][\w-]*)\s+\.wp-block-button__link((?::(?:hover|focus|focus-visible|active))?)`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, .vp-generated-button.${customClass}${pseudo}, button.${customClass}${pseudo}, a.${customClass}${pseudo}`,
    );

    next = next.replace(
      new RegExp(
        String.raw`\.wp-block-button__link\.([_a-zA-Z][\w-]*)((?::(?:hover|focus|focus-visible|active))?)`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, .vp-generated-button.${customClass}${pseudo}, button.${customClass}${pseudo}, a.${customClass}${pseudo}`,
    );

    next = next.replace(
      new RegExp(
        String.raw`\.(?:wp-block-navigation-link|wp-block-post-title|wp-block-read-more|wp-block-site-title)\.([_a-zA-Z][\w-]*)\s+a((?::(?:hover|focus|focus-visible|active))?)`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, .vp-generated-link.${customClass}${pseudo}, a.${customClass}${pseudo}`,
    );

    next = next.replace(
      new RegExp(
        String.raw`\.(?:wp-block-image|wp-block-post-featured-image|blocks-gallery-item)\.([_a-zA-Z][\w-]*)\s+img((?::(?:hover|focus|focus-visible|active))?)`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, .vp-generated-image.${customClass}${pseudo}, img.${customClass}${pseudo}`,
    );

    // Pattern: .wp-block-image.class:hover img { ... }
    // WP: pseudo on the wrapper triggers styles on the img descendant.
    // React: customClass is on <img> itself, so normalise to img.class:hover { ... }.
    next = next.replace(
      new RegExp(
        String.raw`\.(?:wp-block-image|wp-block-post-featured-image|blocks-gallery-item)\.([_a-zA-Z][\w-]*)((?::(?:hover|focus|focus-visible|active))+)\s+img`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, img.${customClass}${pseudo}`,
    );

    // Pattern: .wp-block-image.class { wrapper-only styles (no img descendant) }
    // WP: styles on the <figure> wrapper (overflow:hidden, border-radius, etc.).
    // React: class is on <img>, so add a :has() rule targeting the parent as a
    // best-effort — works in all modern browsers.
    next = next.replace(
      new RegExp(
        String.raw`\.(?:wp-block-image|wp-block-post-featured-image)\.([_a-zA-Z][\w-]*)(?!(?::[\w-]+)?\s+img)(?=\s*[{,])`,
        'g',
      ),
      (match, customClass: string) =>
        `${match}, figure:has(> img.${customClass}), div:has(> img.${customClass})`,
    );

    next = next.replace(
      new RegExp(
        String.raw`\.(?:wp-block-group|wp-block-cover|wp-block-column|wp-block-media-text|wp-block-post|wp-block-query)\.([_a-zA-Z][\w-]*)((?::(?:hover|focus|focus-visible|active))?)`,
        'g',
      ),
      (match, customClass: string, pseudo: string) =>
        `${match}, .${customClass}${pseudo}, section.${customClass}${pseudo}, div.${customClass}${pseudo}, article.${customClass}${pseudo}, figure.${customClass}${pseudo}`,
    );

    return next;
  }

  private sanitizeWordPressCustomCss(css: string): string {
    const strippedAmpersand = css.replace(
      /(^|[}\n])\s*&(?=\s*[.#:[a-zA-Z])/g,
      '$1',
    );

    return strippedAmpersand
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n');
  }

  private extractCssFragmentsFromContent(raw: string): string[] {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return [];

    // wp_global_styles rows are JSON documents that may contain embedded CSS.
    // Parse JSON first so we don't accidentally append the whole JSON blob to
    // index.css just because one nested `css` string contains a selector block.
    const parsed =
      trimmed.startsWith('{') || trimmed.startsWith('[')
        ? this.parseJsonObject(trimmed)
        : null;
    if (!parsed) {
      return this.looksLikeCss(trimmed) ? [trimmed] : [];
    }

    const fragments: string[] = [];
    const visit = (value: unknown, key?: string) => {
      if (!value) return;
      if (typeof value === 'string') {
        const candidate = value.trim();
        if (!candidate) return;
        if (
          key === 'css' ||
          (key === undefined && this.looksLikeCss(candidate))
        ) {
          fragments.push(candidate);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item));
        return;
      }
      if (typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(
          value as Record<string, unknown>,
        )) {
          visit(childValue, childKey);
        }
      }
    };

    visit(parsed);
    return fragments;
  }

  private parseJsonObject(raw: string): Record<string, any> | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;

    const attempts = [
      trimmed,
      trimmed.replace(/\\"/g, '"'),
      (() => {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        return start >= 0 && end > start ? trimmed.slice(start, end + 1) : '';
      })(),
    ].filter(Boolean);

    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
      } catch {
        // Try the next candidate.
      }
    }

    return null;
  }

  private looksLikeCss(value: string): boolean {
    return /[.#:\w\-\[\]\s>,+~()"'=]+\{[^}]+\}/.test(value);
  }

  /**
   * Inject CSS bridges for WordPress core block styles that have no definition
   * in the React app (the block editor stylesheet is not loaded).
   * Only injects a rule when the generated source files actually use the class.
   */
  private async applyBlockStyleBridges(frontendDir: string): Promise<void> {
    const srcDir = join(frontendDir, 'src');
    const cssPath = join(srcDir, 'index.css');

    // Scan all .tsx files for WordPress is-style-* classes
    const collectTsx = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) files.push(...(await collectTsx(full)));
        else if (e.name.endsWith('.tsx')) files.push(full);
      }
      return files;
    };
    const tsxFiles = await collectTsx(srcDir);
    const usedClasses = new Set<string>();
    for (const file of tsxFiles) {
      const content = await readFile(file, 'utf-8');
      const matches = content.match(/is-style-[\w-]+/g) ?? [];
      for (const cls of matches) usedClasses.add(cls);
    }

    if (usedClasses.size === 0) return;

    const bridges: Record<string, string> = {
      'is-style-asterisk': `
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk::before {
  content: "";
  width: 1.5rem;
  height: 3rem;
  background: var(--wp--preset--color--contrast-2, currentColor);
  clip-path: path("M11.93.684v8.039l5.633-5.633 1.216 1.23-5.66 5.66h8.04v1.737H13.2l5.701 5.701-1.23 1.23-5.742-5.742V21h-1.737v-8.094l-5.77 5.77-1.23-1.217 5.743-5.742H.842V9.98h8.162l-5.701-5.7 1.23-1.231 5.66 5.66V.684h1.737Z");
  display: block;
}
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk:empty::before {
  content: none;
}
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk:-moz-only-whitespace::before {
  content: none;
}
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk.has-text-align-center::before,
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk.text-center::before {
  margin: 0 auto;
}
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk.has-text-align-right::before,
:is(h1, h2, h3, h4, h5, h6).is-style-asterisk.text-right::before {
  margin-left: auto;
}
.rtl :is(h1, h2, h3, h4, h5, h6).is-style-asterisk.has-text-align-left::before {
  margin-right: auto;
}`,

      'is-style-checkmark-list': `
.is-style-checkmark-list { list-style: none; padding-left: 0; }
.is-style-checkmark-list li { padding-left: 1.75em; position: relative; }
.is-style-checkmark-list li::before { content: "✓"; position: absolute; left: 0; color: currentColor; }`,

      'is-style-rounded': `
.is-style-rounded img, img.is-style-rounded { border-radius: min(1.5rem, 2vw); }`,

      'is-style-outline': `
.is-style-outline, .is-style-outline.vp-generated-button { background: transparent; border: 2px solid currentColor; }`,

      'is-style-fill': ``,
      'is-style-default': ``,
    };

    const cssBlocks: string[] = [];
    for (const cls of usedClasses) {
      const rule = bridges[cls];
      if (rule && rule.trim()) cssBlocks.push(rule.trim());
    }

    if (cssBlocks.length === 0) return;

    const existingCss = await readFile(cssPath, 'utf-8');
    const block =
      `\n/* WordPress block style bridges */\n` + cssBlocks.join('\n');
    await writeFile(cssPath, existingCss.trimEnd() + block + '\n');
  }

  private async applyInteractionTokens(
    frontendDir: string,
    tokens: ThemeTokens,
  ): Promise<void> {
    const buttonInteraction = tokens.interactions?.button;

    const renderStateRule = (
      selector: string,
      state?: ThemeInteractionState,
    ): string | null => {
      if (!state || Object.keys(state).length === 0) return null;
      const declarations = [
        state.transition ? `transition: ${state.transition};` : null,
        state.transform ? `transform: ${state.transform};` : null,
        state.boxShadow ? `box-shadow: ${state.boxShadow};` : null,
        state.opacity ? `opacity: ${state.opacity};` : null,
        state.color ? `color: ${state.color};` : null,
        state.textDecoration
          ? `text-decoration: ${state.textDecoration};`
          : null,
        state.backgroundColor
          ? `background-color: ${state.backgroundColor};`
          : null,
      ]
        .filter(Boolean)
        .join(' ');
      return declarations ? `${selector} { ${declarations} }` : null;
    };

    const renderAliasedStateRule = (
      selectors: string[],
      state?: ThemeInteractionState,
    ): string | null => {
      const selectorList = [...new Set(selectors.map((value) => value.trim()))]
        .filter(Boolean)
        .join(', ');
      if (!selectorList) return null;
      return renderStateRule(selectorList, state);
    };

    // Collect precise bridges by target for per-target CSS overrides
    const preciseBridges = tokens.interactions?.precise ?? [];
    const imagePrecise = preciseBridges.filter((b) => b.target === 'image');
    const linkPrecise = preciseBridges.filter((b) => b.target === 'link');
    const cardPrecise = preciseBridges.filter((b) => b.target === 'card');
    const otherPrecise = preciseBridges.filter(
      (b) => b.target !== 'image' && b.target !== 'link' && b.target !== 'card',
    );

    const interactionRules = [
      // Button generic bridge
      ...(buttonInteraction
        ? [
            renderStateRule('.vp-generated-button', buttonInteraction.base),
            renderStateRule(
              '.vp-generated-button:hover',
              buttonInteraction.hover,
            ),
            renderStateRule(
              '.vp-generated-button:focus, .vp-generated-button:focus-visible',
              buttonInteraction.focus,
            ),
            renderStateRule(
              '.vp-generated-button:active',
              buttonInteraction.active,
            ),
          ]
        : []),
      // Image precise bridge — scope to the extracted source class and alias it
      // onto generated <img> markup.
      // Also cover the case where the class lands on an ancestor wrapper
      // (e.g. applySectionCustomClasses puts it on the section element, not the img).
      ...imagePrecise.flatMap((bridge) => [
        renderAliasedStateRule(
          [
            `.${bridge.className}`,
            `.vp-generated-image.${bridge.className}`,
            `img.${bridge.className}`,
            `.${bridge.className} img`,
            `.${bridge.className} .vp-generated-image`,
          ],
          bridge.base,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:hover`,
            `.vp-generated-image.${bridge.className}:hover`,
            `img.${bridge.className}:hover`,
            `.${bridge.className}:hover img`,
            `.${bridge.className}:hover .vp-generated-image`,
          ],
          bridge.hover,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:focus`,
            `.${bridge.className}:focus-visible`,
            `.vp-generated-image.${bridge.className}:focus`,
            `.vp-generated-image.${bridge.className}:focus-visible`,
            `img.${bridge.className}:focus`,
            `img.${bridge.className}:focus-visible`,
          ],
          bridge.focus,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:active`,
            `.vp-generated-image.${bridge.className}:active`,
            `img.${bridge.className}:active`,
          ],
          bridge.active,
        ),
      ]),
      // Link precise bridge — scope to the extracted source class and alias it
      // onto generated <a>/<Link> markup.
      ...linkPrecise.flatMap((bridge) => [
        renderAliasedStateRule(
          [
            `.${bridge.className}`,
            `.vp-generated-link.${bridge.className}`,
            `a.${bridge.className}`,
          ],
          bridge.base,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:hover`,
            `.vp-generated-link.${bridge.className}:hover`,
            `a.${bridge.className}:hover`,
          ],
          bridge.hover,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:focus`,
            `.${bridge.className}:focus-visible`,
            `.vp-generated-link.${bridge.className}:focus`,
            `.vp-generated-link.${bridge.className}:focus-visible`,
            `a.${bridge.className}:focus`,
            `a.${bridge.className}:focus-visible`,
          ],
          bridge.focus,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:active`,
            `.vp-generated-link.${bridge.className}:active`,
            `a.${bridge.className}:active`,
          ],
          bridge.active,
        ),
      ]),
      // Card precise bridge — apply only to wrappers carrying the extracted
      // source class, while still aliasing to common React wrapper tags.
      ...cardPrecise.flatMap((bridge) => [
        renderAliasedStateRule(
          [
            `.${bridge.className}`,
            `.vp-generated-card.${bridge.className}`,
            `article.${bridge.className}`,
            `section.${bridge.className}`,
            `div.${bridge.className}`,
            `li.${bridge.className}`,
            `figure.${bridge.className}`,
          ],
          bridge.base,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:hover`,
            `.vp-generated-card.${bridge.className}:hover`,
            `article.${bridge.className}:hover`,
            `section.${bridge.className}:hover`,
            `div.${bridge.className}:hover`,
            `li.${bridge.className}:hover`,
            `figure.${bridge.className}:hover`,
          ],
          bridge.hover,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:focus`,
            `.${bridge.className}:focus-visible`,
            `.vp-generated-card.${bridge.className}:focus`,
            `.vp-generated-card.${bridge.className}:focus-visible`,
            `article.${bridge.className}:focus`,
            `article.${bridge.className}:focus-visible`,
            `section.${bridge.className}:focus`,
            `section.${bridge.className}:focus-visible`,
            `div.${bridge.className}:focus`,
            `div.${bridge.className}:focus-visible`,
            `li.${bridge.className}:focus`,
            `li.${bridge.className}:focus-visible`,
            `figure.${bridge.className}:focus`,
            `figure.${bridge.className}:focus-visible`,
          ],
          bridge.focus,
        ),
        renderAliasedStateRule(
          [
            `.${bridge.className}:active`,
            `.vp-generated-card.${bridge.className}:active`,
            `article.${bridge.className}:active`,
            `section.${bridge.className}:active`,
            `div.${bridge.className}:active`,
            `li.${bridge.className}:active`,
            `figure.${bridge.className}:active`,
          ],
          bridge.active,
        ),
      ]),
      // Remaining precise bridges (button/card target custom classes)
      ...otherPrecise.flatMap((bridge) => [
        renderStateRule(`.${bridge.className}`, bridge.base),
        renderStateRule(`.${bridge.className}:hover`, bridge.hover),
        renderStateRule(
          `.${bridge.className}:focus, .${bridge.className}:focus-visible`,
          bridge.focus,
        ),
        renderStateRule(`.${bridge.className}:active`, bridge.active),
      ]),
    ].filter(Boolean);

    if (interactionRules.length === 0) return;

    const cssPath = join(frontendDir, 'src', 'index.css');
    const existingCss = await readFile(cssPath, 'utf-8');
    const block = `/* Vibepress interaction bridge */\n${interactionRules.join('\n')}\n`;
    if (existingCss.includes('/* Vibepress interaction bridge */')) return;
    await writeFile(cssPath, `${existingCss.trimEnd()}\n\n${block}`);
  }

  private prepareGeneratedComponentCode(
    code: string,
    tokens?: ThemeTokens,
    componentName?: string,
  ): string {
    let normalized = this.decorateGeneratedInteractionClasses(code, tokens);
    normalized = this.normalizeCanonicalTextLinkHoverClasses(normalized);
    normalized = this.normalizeCanonicalPostMetaLinks(normalized);
    normalized = this.normalizeSinglePostHeroLayout(normalized, componentName);
    normalized = this.ensureReactRouterLinkImport(normalized);
    return normalized;
  }

  private decorateGeneratedInteractionClasses(
    code: string,
    tokens?: ThemeTokens,
  ): string {
    const appendClass = (value: string, extraClass: string): string => {
      const classes = value
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      if (!classes.includes(extraClass)) classes.push(extraClass);
      return classes.join(' ');
    };

    const looksLikeButtonClass = (tag: string, className: string): boolean => {
      if (tag.toLowerCase() === 'button') return true;
      return (
        /\b(bg-|inline-flex|justify-center|wp-element-button|wp-block-button__link)\b/.test(
          className,
        ) ||
        (/\bpx-/.test(className) && /\bpy-/.test(className))
      );
    };

    const cardBridgeClasses = new Set(
      (tokens?.interactions?.precise ?? [])
        .filter((bridge) => bridge.target === 'card')
        .map((bridge) => bridge.className),
    );
    const looksLikeCardWrapper = (tag: string, className: string): boolean => {
      if (!/^(article|div|section|li|figure)$/i.test(tag)) return false;
      const classes = className
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      return classes.some((token) => cardBridgeClasses.has(token));
    };

    // ── Button decoration ────────────────────────────────────────────────────
    const decorateButtonsQuoted = (source: string) =>
      source.replace(
        /<(button|a|Link)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) =>
          looksLikeButtonClass(tag, className)
            ? `<${tag}${before}className=${quote}${appendClass(className, 'vp-generated-button')}${quote}`
            : match,
      );

    const decorateButtonsTemplateLiteral = (source: string) =>
      source.replace(
        /<(button|a|Link)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) =>
          looksLikeButtonClass(tag, className)
            ? `<${tag}${before}className={\`${appendClass(className, 'vp-generated-button')}\`}`
            : match,
      );

    // ── Image decoration ─────────────────────────────────────────────────────
    // Pass 1: <img> with quoted className
    const decorateImagesQuoted = (source: string) =>
      source.replace(
        /<img\b([^>]*?)className=(["'])([^"']*)\2/g,
        (_, before: string, quote: string, className: string) =>
          `<img${before}className=${quote}${appendClass(className, 'vp-generated-image')}${quote}`,
      );

    // Pass 2: <img> with template-literal className
    const decorateImagesTemplateLiteral = (source: string) =>
      source.replace(
        /<img\b([^>]*?)className=\{`([^`]*)`\}/g,
        (_, before: string, className: string) =>
          `<img${before}className={\`${appendClass(className, 'vp-generated-image')}\`}`,
      );

    // Pass 3: <img> without any className — inject it before closing tag
    const decorateImagesNoClass = (source: string) =>
      source.replace(
        /<img\b((?:(?!className=)[^>])*)(\/?>)/g,
        (_, attrs: string, closing: string) =>
          `<img${attrs} className="vp-generated-image"${closing}`,
      );

    // ── Link decoration ──────────────────────────────────────────────────────
    // Add vp-generated-link to <a>/<Link> that are NOT button-like
    const decorateLinksQuoted = (source: string) =>
      source.replace(
        /<(a|Link)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) => {
          if (looksLikeButtonClass(tag, className)) return match;
          return `<${tag}${before}className=${quote}${appendClass(className, 'vp-generated-link')}${quote}`;
        },
      );

    const decorateLinksTemplateLiteral = (source: string) =>
      source.replace(
        /<(a|Link)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) => {
          if (looksLikeButtonClass(tag, className)) return match;
          return `<${tag}${before}className={\`${appendClass(className, 'vp-generated-link')}\`}`;
        },
      );

    // ── Card wrapper decoration ──────────────────────────────────────────────
    const decorateCardsQuoted = (source: string) =>
      source.replace(
        /<(article|div|section|li|figure)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) =>
          looksLikeCardWrapper(tag, className)
            ? `<${tag}${before}className=${quote}${appendClass(className, 'vp-generated-card')}${quote}`
            : match,
      );

    const decorateCardsTemplateLiteral = (source: string) =>
      source.replace(
        /<(article|div|section|li|figure)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) =>
          looksLikeCardWrapper(tag, className)
            ? `<${tag}${before}className={\`${appendClass(className, 'vp-generated-card')}\`}`
            : match,
      );

    // Apply decorations in order: buttons (if token exists), then images, then links
    let result = code;

    if (tokens?.interactions?.button) {
      result = decorateButtonsTemplateLiteral(decorateButtonsQuoted(result));
    }

    // Images and links always get bridge classes (CSS defaults are always written)
    result = decorateImagesNoClass(
      decorateImagesTemplateLiteral(decorateImagesQuoted(result)),
    );
    result = decorateLinksTemplateLiteral(decorateLinksQuoted(result));
    result = decorateCardsTemplateLiteral(decorateCardsQuoted(result));

    return result;
  }

  private normalizeCanonicalPostMetaLinks(code: string): string {
    const appendTextLinkClasses = (className?: string): string => {
      const classes = (className ?? '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of ['hover:underline', 'underline-offset-4']) {
        if (!classes.includes(token)) classes.push(token);
      }
      return classes.join(' ');
    };

    const isCanonicalMetaLink = (raw: string): boolean =>
      /(?:to=|href=)[^>]*\/author\//.test(raw) ||
      /(?:to=|href=)[^>]*\/category\//.test(raw);

    const decorateQuoted = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className=${quote}${appendTextLinkClasses(className)}${quote}`;
        },
      );

    const decorateTemplateLiteral = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${before}className={\`${appendTextLinkClasses(className)}\`}`;
        },
      );

    const decorateWithoutClass = (source: string) =>
      source.replace(
        /<(Link|a)\b((?:(?!className=)[^>])*)(?=>)/g,
        (match, tag: string, attrs: string) => {
          if (!isCanonicalMetaLink(match)) return match;
          return `<${tag}${attrs} className="${appendTextLinkClasses()}"`;
        },
      );

    return decorateWithoutClass(decorateTemplateLiteral(decorateQuoted(code)));
  }

  private normalizeSinglePostHeroLayout(
    code: string,
    componentName?: string,
  ): string {
    if (componentName !== 'Single') return code;
    if (
      !/\{post\.title\}/.test(code) ||
      !/__html:\s*post\.content/.test(code)
    ) {
      return code;
    }

    let normalized = code.replace(
      /className="max-w-\[1280px\] mx-auto w-full px-4 sm:px-6 lg:px-8 ([^"]*?)flex flex-col gap-\[1rem\]"/,
      'className="max-w-[1280px] mx-auto w-full px-4 sm:px-6 lg:px-8 $1flex flex-col items-center text-center gap-[1rem]"',
    );

    normalized = normalized.replace(
      /className="flex flex-wrap items-center gap-\[0\.3em\] text-\[0\.9rem\]"/,
      'className="flex flex-wrap items-center justify-center gap-[0.3em] text-[0.9rem]"',
    );

    return normalized;
  }

  private normalizeCanonicalTextLinkHoverClasses(code: string): string {
    const appendTextLinkClasses = (className?: string): string => {
      const classes = (className ?? '')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of ['hover:underline', 'underline-offset-4']) {
        if (!classes.includes(token)) classes.push(token);
      }
      return classes.join(' ');
    };

    const looksLikeButtonClass = (className: string): boolean =>
      /\bbg-\[/.test(className) ||
      (/\bpx-/.test(className) && /\bpy-/.test(className)) ||
      /\bjustify-center\b/.test(className);

    const isCanonicalTextLink = (raw: string): boolean =>
      /\/(?:post|page|author|category|tag)\//.test(raw) ||
      /\bitem\.url\b/.test(raw) ||
      /\btoAppPath\(item\.url\)\b/.test(raw) ||
      /\bhref=["']https?:\/\//.test(raw);

    const decorateQuoted = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=(["'])([^"']*)\3/g,
        (
          match,
          tag: string,
          before: string,
          quote: string,
          className: string,
        ) => {
          if (!isCanonicalTextLink(match)) return match;
          if (looksLikeButtonClass(className)) return match;
          return `<${tag}${before}className=${quote}${appendTextLinkClasses(className)}${quote}`;
        },
      );

    const decorateTemplateLiteral = (source: string) =>
      source.replace(
        /<(Link|a)\b([^>]*?)className=\{`([^`]*)`\}/g,
        (match, tag: string, before: string, className: string) => {
          if (!isCanonicalTextLink(match)) return match;
          if (looksLikeButtonClass(className)) return match;
          return `<${tag}${before}className={\`${appendTextLinkClasses(className)}\`}`;
        },
      );

    return decorateTemplateLiteral(decorateQuoted(code));
  }

  private ensureReactRouterLinkImport(code: string): string {
    if (!/<Link\b/.test(code)) return code;
    if (
      /import\s*\{\s*[^}]*\bLink\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(
        code,
      )
    ) {
      return code;
    }

    if (/from\s*['"]react-router-dom['"]/.test(code)) {
      return code.replace(
        /import\s*\{\s*([^}]*)\}\s*from\s*['"]react-router-dom['"];/,
        (match, imports: string) => {
          const tokens = imports
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean);
          if (!tokens.includes('Link')) tokens.push('Link');
          return `import { ${tokens.join(', ')} } from 'react-router-dom';`;
        },
      );
    }

    const reactImportMatch = code.match(
      /^import[^\n]*from\s*['"]react['"];\n?/m,
    );
    if (!reactImportMatch || reactImportMatch.index == null) {
      return `import { Link } from 'react-router-dom';\n${code}`;
    }

    const insertAt = reactImportMatch.index + reactImportMatch[0].length;
    return `${code.slice(0, insertAt)}import { Link } from 'react-router-dom';\n${code.slice(insertAt)}`;
  }

  private runNpmInstall(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npm', ['install'], {
        cwd: dir,
        shell: true,
        stdio: 'pipe',
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`npm install failed in ${dir} with exit code ${code}`),
          );
      });
    });
  }

  private async attachTemplateDependencies(
    templateDir: string,
    runtimeDir: string,
    cacheName: string,
  ): Promise<void> {
    const cacheDir = await this.ensureTemplateDependencyCache(
      templateDir,
      cacheName,
    );
    await this.linkNodeModules(cacheDir, runtimeDir);
    await this.copyLockfileIfPresent(cacheDir, runtimeDir);
  }

  private async ensureTemplateDependencyCache(
    templateDir: string,
    cacheName: string,
  ): Promise<string> {
    const packageJson = await readFile(
      join(templateDir, 'package.json'),
      'utf-8',
    );
    const cacheKey = createHash('sha1')
      .update(packageJson)
      .digest('hex')
      .slice(0, 12);
    const cacheDir = join(DEP_CACHE_ROOT, `${cacheName}-${cacheKey}`);
    const readyMarker = join(cacheDir, '.deps-ready');

    if (await this.pathExists(readyMarker)) {
      return cacheDir;
    }

    await mkdir(DEP_CACHE_ROOT, { recursive: true });
    await rm(cacheDir, { recursive: true, force: true });
    await cp(templateDir, cacheDir, { recursive: true });

    this.logger.log(`Bootstrapping dependency cache: ${cacheName}-${cacheKey}`);
    await this.runNpmInstall(cacheDir);
    await writeFile(readyMarker, new Date().toISOString(), 'utf-8');
    return cacheDir;
  }

  private async linkNodeModules(
    cacheDir: string,
    runtimeDir: string,
  ): Promise<void> {
    const sourceNodeModules = join(cacheDir, 'node_modules');
    const targetNodeModules = join(runtimeDir, 'node_modules');

    if (!(await this.pathExists(sourceNodeModules))) {
      throw new Error(
        `Cached dependencies missing for ${cacheDir}: node_modules not found`,
      );
    }

    await rm(targetNodeModules, { recursive: true, force: true });
    await symlink(sourceNodeModules, targetNodeModules, 'junction');
  }

  private async copyLockfileIfPresent(
    cacheDir: string,
    runtimeDir: string,
  ): Promise<void> {
    const sourceLockfile = join(cacheDir, 'package-lock.json');
    if (!(await this.pathExists(sourceLockfile))) return;
    await copyFile(sourceLockfile, join(runtimeDir, 'package-lock.json'));
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async copySiteLogoToPublic(
    logoUrl: string | null | undefined,
    destImagesDir: string,
  ): Promise<string | null> {
    if (!logoUrl) return null;

    try {
      const url = new URL(logoUrl);
      const originalName = basename(url.pathname) || 'site-logo';
      const ext = extname(originalName) || '.png';
      const safeExt = /^[.][a-zA-Z0-9]+$/.test(ext) ? ext : '.png';
      const fileName = `site-logo${safeExt.toLowerCase()}`;
      const destPath = join(destImagesDir, fileName);

      await mkdir(destImagesDir, { recursive: true });
      const response = await fetch(logoUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${logoUrl}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(destPath, bytes);
      this.logger.log(`Copied site logo to preview assets: ${destPath}`);
      return `/assets/images/${fileName}`;
    } catch (error) {
      this.logger.warn(
        `Failed to copy site logo from "${logoUrl}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  private collectWordPressUploadUrls(input: {
    components: ReactGenerateResult['components'];
    content?: { posts: WpPost[]; pages: WpPage[] };
    siteUrl?: string | null;
  }): string[] {
    const urls = new Set<string>();
    const { components, content, siteUrl } = input;

    for (const component of components) {
      for (const match of component.code.matchAll(
        /https?:\/\/[^"'\s]+\/wp-content\/uploads\/[^"'\s)]+/gi,
      )) {
        const normalized = this.normalizeWpUploadUrl(match[0], siteUrl);
        if (normalized) urls.add(normalized);
      }
    }

    for (const item of [...(content?.posts ?? []), ...(content?.pages ?? [])]) {
      if (item.featuredImage) {
        const normalized = this.normalizeWpUploadUrl(
          item.featuredImage,
          siteUrl,
        );
        if (normalized) urls.add(normalized);
      }
      for (const match of String(item.content ?? '').matchAll(
        /(?:https?:\/\/[^"'\s]+)?\/wp-content\/uploads\/[^"'\s)]+/gi,
      )) {
        const normalized = this.normalizeWpUploadUrl(match[0], siteUrl);
        if (normalized) urls.add(normalized);
      }
    }

    return [...urls];
  }

  private normalizeWpUploadUrl(
    rawUrl: string | null | undefined,
    siteUrl?: string | null,
  ): string | null {
    if (!rawUrl) return null;
    const trimmed = String(rawUrl).trim();
    if (!trimmed || !/\/wp-content\/uploads\//i.test(trimmed)) return null;

    try {
      if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
      if (siteUrl) return new URL(trimmed, siteUrl).toString();
    } catch {
      // Fall back to the original string below.
    }

    return trimmed;
  }

  private buildWpUploadAssetFileName(
    rawUrl: string,
    siteUrl?: string | null,
  ): string {
    const normalized = this.normalizeWpUploadUrl(rawUrl, siteUrl) ?? rawUrl;
    let pathname = normalized;
    try {
      pathname = new URL(normalized).pathname;
    } catch {
      pathname = normalized.split(/[?#]/)[0] ?? normalized;
    }

    const originalName = basename(pathname) || 'wp-asset';
    const ext = extname(originalName) || '.jpg';
    const safeExt = /^[.][a-zA-Z0-9]+$/.test(ext) ? ext.toLowerCase() : '.jpg';
    const baseName = basename(originalName, ext)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    const safeBaseName = baseName || 'wp-asset';
    const hash = createHash('sha1')
      .update(normalized)
      .digest('hex')
      .slice(0, 12);
    return `${hash}-${safeBaseName}${safeExt}`;
  }

  private toLocalWpUploadAssetPath(
    rawUrl: string,
    siteUrl?: string | null,
  ): string {
    return `/assets/images/${this.buildWpUploadAssetFileName(rawUrl, siteUrl)}`;
  }

  private async copyWordPressUploadAssetsToPublic(
    urls: string[],
    destImagesDir: string,
    siteUrl?: string | null,
  ): Promise<void> {
    if (urls.length === 0) return;
    await mkdir(destImagesDir, { recursive: true });

    const concurrency = Math.max(
      1,
      this.configService.get<number>('preview.wpAssetCopyConcurrency') ?? 6,
    );
    let copied = 0;
    for (
      let batchStart = 0;
      batchStart < urls.length;
      batchStart += concurrency
    ) {
      const batch = urls.slice(batchStart, batchStart + concurrency);
      const copiedInBatch: number[] = await Promise.all(
        batch.map(async (url) => {
          const destPath = join(
            destImagesDir,
            this.buildWpUploadAssetFileName(url, siteUrl),
          );

          try {
            if (await this.pathExists(destPath)) {
              return 0;
            }

            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            await writeFile(destPath, bytes);
            return 1;
          } catch (error) {
            this.logger.warn(
              `Failed to copy WordPress upload asset "${url}": ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            return 0;
          }
        }),
      );
      copied += copiedInBatch.reduce((sum, value) => sum + value, 0);
    }

    if (copied > 0) {
      this.logger.log(
        `Copied ${copied}/${urls.length} WordPress upload asset(s) to preview public assets`,
      );
    }
  }

  private spawnDevServer(dir: string) {
    const proc = spawn('npm', ['run', 'dev'], {
      cwd: dir,
      shell: true,
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    this.logger.log(`Dev server started (pid=${proc.pid}) in ${dir}`);
    return proc;
  }

  private pickApiPort(jobId: string): number {
    return this.pickDeterministicPort(jobId, 'api', 3700, 200);
  }

  private pickVitePort(jobId: string): number {
    return this.pickDeterministicPort(jobId, 'vite', 5300, 200);
  }

  private pickDeterministicPort(
    jobId: string,
    salt: string,
    base: number,
    span: number,
  ): number {
    const hash = createHash('sha1').update(`${salt}:${jobId}`).digest('hex');
    const offset = parseInt(hash.slice(0, 8), 16) % span;
    return base + offset;
  }

  private stripSharedLayoutSectionsFromPageCode(
    code: string,
    options: { header: boolean; footer: boolean },
  ): string {
    let next = code;
    if (options.header) {
      next = this.stripNamedSection(next, 'Navbar', 'header');
    }
    if (options.footer) {
      next = this.stripNamedSection(next, 'Footer', 'footer');
    }
    return next;
  }

  private stripNamedSection(
    code: string,
    commentName: string,
    tagName: 'header' | 'footer',
  ): string {
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      String.raw`\s*\{\/\*\s*${commentName}\s*\*\/\}\s*<${escapedTag}\b[\s\S]*?<\/${escapedTag}>`,
      'i',
    );
    return code.replace(pattern, '\n');
  }

  private async copyReferencedThemeAssets(
    themeDir: string,
    publicDir: string,
    components: ReactGenerateResult['components'],
  ): Promise<{ missing: Set<string>; remapped: Map<string, string> }> {
    const missing = new Set<string>();
    const remapped = new Map<string, string>();
    const assetPaths = this.collectReferencedAssetPaths(components);
    if (assetPaths.length === 0) return { missing, remapped };

    let copied = 0;
    for (const assetPath of assetPaths) {
      const relativePath = assetPath.replace(/^\/+/, '');
      const sourcePath = join(themeDir, relativePath);
      const destPath = join(publicDir, relativePath);
      const canonical = assetPath.startsWith('/')
        ? assetPath
        : `/${relativePath}`;

      try {
        if (await this.pathExists(destPath)) {
          continue;
        }

        // Fallback: check if the file was already copied under /assets/images/ by the
        // bulk theme-image copy step (themeDir/assets/images/ → public/assets/images/).
        // This handles path mismatches where the AI used /assets/foo.png but the file
        // lives at /assets/images/foo.png.
        const imagesFallback = join(
          publicDir,
          'assets',
          'images',
          basename(relativePath),
        );
        if (await this.pathExists(imagesFallback)) {
          remapped.set(canonical, `/assets/images/${basename(relativePath)}`);
          this.logger.debug(
            `Asset remapped to images subdir: ${relativePath} → /assets/images/${basename(relativePath)}`,
          );
          continue;
        }

        const info = await stat(sourcePath);
        if (!info.isFile()) continue;
        await mkdir(dirname(destPath), { recursive: true });
        await cp(sourcePath, destPath, { force: true });
        copied++;
        this.logger.log(`Successfully copied asset: ${relativePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (msg.includes('ENOENT')) {
          // One more chance: the images-subdir fallback (catches errors from stat() too)
          const imagesFallback = join(
            publicDir,
            'assets',
            'images',
            basename(relativePath),
          );
          if (await this.pathExists(imagesFallback)) {
            remapped.set(canonical, `/assets/images/${basename(relativePath)}`);
            this.logger.debug(
              `Asset remapped to images subdir: ${relativePath} → /assets/images/${basename(relativePath)}`,
            );
          } else {
            missing.add(canonical);
            this.logger.debug(
              `Theme asset not found (will drop <img>): ${relativePath}`,
            );
          }
        } else {
          this.logger.warn(`Failed to copy asset from ${sourcePath}: ${msg}`);
        }
      }
    }

    if (copied > 0) {
      this.logger.log(`Copied ${copied} referenced theme assets to preview`);
    }
    return { missing, remapped };
  }

  /**
   * Remove <img> tags pointing at theme files that do not exist, and JSX fragments
   * like `{cond && }` left empty after removal.
   */
  private stripImgTagsForMissingAssets(
    code: string,
    missing: Set<string>,
  ): string {
    if (missing.size === 0) return code;
    let out = code;
    for (const path of missing) {
      const variants = new Set([
        path,
        path.startsWith('/') ? path.slice(1) : `/${path}`,
      ]);
      for (const v of variants) {
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(
          new RegExp(`<img\\s[^>]*?\\bsrc=["']${esc}["'][^>]*/>`, 'gis'),
          '',
        );
        out = out.replace(
          new RegExp(
            `<img\\s[^>]*?\\bsrc=\\{\\s*["']${esc}["']\\s*\\}[^>]*/>`,
            'gis',
          ),
          '',
        );
        out = out.replace(
          new RegExp(
            `<img\\s[^>]*?\\bsrc=\\{\\s*\`${esc}\`\\s*\\}[^>]*/>`,
            'gis',
          ),
          '',
        );
      }
    }
    // `{condition && }` left after stripping the only child (e.g. avatar img)
    out = out.replace(/\{\s*[\w.?()]+\s*&&\s*\}/g, '');
    return out;
  }

  private collectReferencedAssetPaths(
    components: ReactGenerateResult['components'],
  ): string[] {
    const assets = new Set<string>();
    const assetPattern = /\/assets\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g;

    for (const comp of components) {
      for (const match of comp.code.matchAll(assetPattern)) {
        assets.add(match[0]);
      }
    }

    return [...assets];
  }

  private buildSmokeRoutes(paths: string[]): string[] {
    const staticRoutes = paths.filter(
      (path) => path === '/' || (!path.includes(':') && path !== '*'),
    );
    return [...new Set(staticRoutes.length > 0 ? staticRoutes : ['/'])];
  }
}
