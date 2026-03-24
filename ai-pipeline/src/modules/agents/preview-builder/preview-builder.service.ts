import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile, cp, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { ReactGenerateResult } from '../react-generator/react-generator.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';

export interface PreviewBuilderResult {
  jobId: string;
  previewDir: string;
  entryPath: string;
  frontendPid?: number;
  serverPid?: number;
}

const TEMPLATE_DIR = resolve('templates/react-preview');

const PARTIAL_PATTERNS =
  /^(header|footer|sidebar|nav|navigation|searchform|comments|comment|postmeta|post-meta|widget|breadcrumb|pagination|loop|content-none|no-results|functions)/i;

@Injectable()
export class PreviewBuilderService {
  private readonly logger = new Logger(PreviewBuilderService.name);

  async build(input: {
    jobId: string;
    components: ReactGenerateResult;
    dbCreds: WpDbCredentials;
    themeDir?: string;
    tokens?: ThemeTokens;
    outputDir?: string;
  }): Promise<PreviewBuilderResult> {
    const { jobId, components, dbCreds, themeDir, tokens } = input;
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

    // 2. Copy theme assets vào frontend/public/assets/ (ảnh tĩnh của theme)
    if (themeDir) {
      const themeAssetsDir = join(themeDir, 'assets');
      const publicAssetsDir = join(frontendDir, 'public', 'assets');
      try {
        await cp(themeAssetsDir, publicAssetsDir, { recursive: true });
        this.logger.log(`Copied theme assets to: ${publicAssetsDir}`);
      } catch {
        this.logger.warn(`No assets folder found in theme: ${themeAssetsDir}`);
      }
    }

    // 3. Write generated components từ AI (code in memory)
    for (const comp of components.components) {
      const isPartial =
        PARTIAL_PATTERNS.test(comp.name) || comp.isSubComponent;
      const targetDir = isPartial ? componentsDir : pagesDir;
      await writeFile(join(targetDir, `${comp.name}.tsx`), comp.code, 'utf-8');
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

    // Map tên component → route path
    const PAGE_ROUTE_MAP: Record<string, string> = {
      Home: '/',
      Index: '/',
      FrontPage: '/',
      Single: '/posts/:slug',
      SingleWithSidebar: '/posts/:slug',
      Page: '/pages/:slug',
      PageWithSidebar: '/pages/:slug',
      PageWide: '/pages/:slug',
      PageNoTitle: '/pages/:slug',
      Archive: '/archive',
      Category: '/category/:slug',
      Tag: '/tag/:slug',
      Author: '/author/:slug',
      Search: '/search',
      Page404: '*',
    };

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
      const path = PAGE_ROUTE_MAP[c.name] ?? `/${c.name.toLowerCase()}`;
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

    // frontend/.env — chỉ cần biết API chạy ở đâu
    await writeFile(
      join(frontendDir, '.env'),
      `VITE_API_PORT=${apiPort}\nVITE_API_BASE=http://localhost:${apiPort}/api\n`,
    );

    // server/.env — DB credentials + port
    await writeFile(
      join(rootDir, 'server', '.env'),
      `API_PORT=${apiPort}\nDB_HOST=${dbCreds.host}\nDB_PORT=${dbCreds.port}\nDB_NAME=${dbCreds.dbName}\nDB_USER=${dbCreds.user}\nDB_PASSWORD=${dbCreds.password}\n`,
    );

    // 6. npm install cho cả 2 folder song song, rồi spawn dev servers
    const serverDir = join(rootDir, 'server');
    this.logger.log('Installing dependencies...');
    await Promise.all([
      this.runNpmInstall(frontendDir),
      this.runNpmInstall(serverDir),
    ]);
    this.logger.log('Starting dev servers...');
    const frontendProc = this.spawnDevServer(frontendDir);
    const serverProc = this.spawnDevServer(serverDir);

    this.logger.log(`Preview ready at: ${rootDir}`);
    return {
      jobId,
      previewDir: rootDir,
      entryPath: join(srcDir, 'main.tsx'),
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

    if (googleFonts.length === 0) return;

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

  private runNpmInstall(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npm', ['install'], { cwd: dir, shell: true, stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install failed in ${dir} with exit code ${code}`));
      });
    });
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
}
