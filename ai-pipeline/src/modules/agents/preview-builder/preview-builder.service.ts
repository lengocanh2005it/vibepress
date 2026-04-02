import { Injectable, Logger } from '@nestjs/common';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { ReactGenerateResult } from '../react-generator/react-generator.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';
import { AssetDownloaderService } from './asset-downloader.service.js';
import { ValidatorService } from '../validator/validator.service.js';

export interface PreviewBuilderResult {
  jobId: string;
  previewDir: string;
  entryPath: string;
  previewUrl: string;
  frontendPid?: number;
  serverPid?: number;
}

const TEMPLATE_DIR = resolve('templates/react-preview');
const SERVER_TEMPLATE_DIR = resolve('templates/express-server');
const DEP_CACHE_ROOT = resolve('temp/cache/template-deps');

const PARTIAL_PATTERNS =
  /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)/i;

@Injectable()
export class PreviewBuilderService {
  private readonly logger = new Logger(PreviewBuilderService.name);

  constructor(
    private assetDownloader: AssetDownloaderService,
    private readonly validator: ValidatorService,
  ) {}

  async build(input: {
    jobId: string;
    components: ReactGenerateResult;
    dbCreds: WpDbCredentials;
    themeDir?: string;
    tokens?: ThemeTokens;
    plan?: PlanResult;
    outputDir?: string;
  }): Promise<PreviewBuilderResult> {
    const { jobId, components, dbCreds, themeDir, tokens, plan } = input;
    const rootDir = input.outputDir ?? join('./temp/generated', jobId);
    const frontendDir = join(rootDir, 'frontend');
    const srcDir = join(frontendDir, 'src');
    const componentsDir = join(srcDir, 'components');
    const pagesDir = join(srcDir, 'pages');

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

    // 3. Write generated components từ AI (code in memory)
    // Relink WordPress image URLs từ /wp-content/uploads/ sang local /assets/images/
    for (const comp of components.components) {
      const isPartial = PARTIAL_PATTERNS.test(comp.name) || comp.isSubComponent;
      const targetDir = isPartial ? componentsDir : pagesDir;

      // Match WordPress URLs (http://localhost/wp-content/uploads/... hoặc https://domain.com/wp-content/uploads/...)
      const wpUploadPattern =
        /https?:\/\/[^"'\s]+\/wp-content\/uploads\/([^"'\s]+\.(jpg|jpeg|png|gif|webp))/gi;
      comp.code = comp.code.replace(wpUploadPattern, (match, fileName) => {
        this.logger.log(`Relinked WP image: ${fileName}`);
        return `/assets/images/${fileName}`;
      });

      await writeFile(join(targetDir, `${comp.name}.tsx`), comp.code, 'utf-8');
    }

    // 3b. Copy đúng các asset mà component generated đang reference.
    // Điều này tránh case assets/ có tồn tại nhưng thiếu các ảnh con mà JSX dùng.
    if (themeDir) {
      await this.copyReferencedThemeAssets(
        themeDir,
        join(frontendDir, 'public'),
        components.components,
      );
    }

    // 3. Generate App.tsx với routes từ components
    const allComponents = components.components;

    // Sub-components (isSubComponent=true) are assembled inside their parent.
    // They must NOT become standalone routes.
    const routeableComponents = allComponents.filter((c) => !c.isSubComponent);

    // Partials: không tạo route (header, footer, sidebar, nav, meta, search form, comments, widgets...)
    const pageComponents = routeableComponents.filter(
      (c) => !PARTIAL_PATTERNS.test(c.name),
    );

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

    const routeImports = allComponents
      .map((c) => {
        const folder =
          PARTIAL_PATTERNS.test(c.name) || c.isSubComponent
            ? 'components'
            : 'pages';
        return `import ${c.name} from './${folder}/${c.name}';`;
      })
      .join('\n');

    // Tạo routes chỉ cho page components, tránh duplicate paths
    const usedPaths = new Set<string>();
    const routeLines: string[] = [];

    for (const c of pageComponents) {
      const path =
        planRouteMap.get(c.name) ??
        FALLBACK_ROUTE_MAP[c.name] ??
        `/${c.name.toLowerCase()}`;
      if (usedPaths.has(path)) continue;
      usedPaths.add(path);
      routeLines.push(
        `        <Route path="${path}" element={<${c.name} />} />`,
      );
    }

    // Đảm bảo luôn có route "/" — dùng component đầu tiên nếu chưa có
    if (!usedPaths.has('/') && pageComponents.length > 0) {
      routeLines.unshift(
        `        <Route path="/" element={<${pageComponents[0].name} />} />`,
      );
    }

    const routes = routeLines.join('\n');
    const smokeRoutes = this.buildSmokeRoutes([...usedPaths]);

    await writeFile(
      join(srcDir, 'App.tsx'),
      `import { Routes, Route } from 'react-router-dom';
${routeImports}

export default function App() {
  return (
    <Routes>
${routes}
    </Routes>
  );
}
`,
    );

    // 4. Generate tailwind.config.js + inject Google Fonts từ theme tokens
    if (tokens) {
      await this.applyThemeTokens(frontendDir, tokens);
    }

    // 5. Generate .env cho từng folder
    const apiPort = this.pickApiPort(jobId);
    const vitePort = this.pickVitePort(jobId);
    const serverDir = join(rootDir, 'server');

    // frontend/.env — chỉ cần biết API chạy ở đâu
    await writeFile(
      join(frontendDir, '.env'),
      `VITE_PORT=${vitePort}\nVITE_API_PORT=${apiPort}\nVITE_API_BASE=http://localhost:${apiPort}/api\n`,
    );

    // server/.env — DB credentials + port
    await writeFile(
      join(rootDir, 'server', '.env'),
      `API_PORT=${apiPort}\nDB_HOST=${dbCreds.host}\nDB_PORT=${dbCreds.port}\nDB_NAME=${dbCreds.dbName}\nDB_USER=${dbCreds.user}\nDB_PASSWORD=${dbCreds.password}\n`,
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
    await this.validator.assertPreviewRuntime(previewUrl, smokeRoutes);
    this.logger.log(`Preview ready at: ${previewUrl}`);
    return {
      jobId,
      previewDir: rootDir,
      entryPath: join(srcDir, 'main.tsx'),
      previewUrl,
      frontendPid: frontendProc.pid,
      serverPid: serverProc.pid,
    };
  }

  private async applyThemeTokens(
    frontendDir: string,
    tokens: ThemeTokens,
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

    // 3. Inject font-family into index.css so components inherit without inline styles
    const bodyFont = tokens.defaults?.fontFamily;
    const headingFont = tokens.defaults?.headingFontFamily;
    const cssLines: string[] = [];
    if (bodyFont) cssLines.push(`body { font-family: ${bodyFont}; }`);
    if (headingFont) {
      cssLines.push(`h1, h2, h3, h4, h5, h6 { font-family: ${headingFont}; }`);
    }
    if (cssLines.length > 0) {
      const cssPath = join(frontendDir, 'src', 'index.css');
      const existingCss = await readFile(cssPath, 'utf-8');
      await writeFile(
        cssPath,
        existingCss.trimEnd() + '\n\n' + cssLines.join('\n') + '\n',
      );
    }
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
    const hash = jobId.replace(/-/g, '').slice(0, 6);
    return 3200 + (parseInt(hash, 16) % 800);
  }

  private pickVitePort(jobId: string): number {
    const hash = jobId.replace(/-/g, '').slice(6, 12);
    return 5200 + (parseInt(hash, 16) % 800);
  }

  private async copyReferencedThemeAssets(
    themeDir: string,
    publicDir: string,
    components: ReactGenerateResult['components'],
  ): Promise<void> {
    const assetPaths = this.collectReferencedAssetPaths(components);
    if (assetPaths.length === 0) return;

    let copied = 0;
    for (const assetPath of assetPaths) {
      const relativePath = assetPath.replace(/^\/+/, '');
      const sourcePath = join(themeDir, relativePath);
      const destPath = join(publicDir, relativePath);

      try {
        const info = await stat(sourcePath);
        if (!info.isFile()) continue;
        await mkdir(dirname(destPath), { recursive: true });
        await cp(sourcePath, destPath, { force: true });
        copied++;
        this.logger.log(`Successfully copied asset: ${relativePath}`);
      } catch (err) {
        this.logger.warn(
          `Failed to copy asset from ${sourcePath}: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    }

    if (copied > 0) {
      this.logger.log(`Copied ${copied} referenced theme assets to preview`);
    }
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
