import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile, cp, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import type { WpDbCredentials } from '@/common/types/db-credentials.type.js';
import { ReactGenerateResult } from '../react-generator/react-generator.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import type { PlanResult } from '../planner/planner.service.js';

export interface PreviewBuilderResult {
  jobId: string;
  previewDir: string;
  entryPath: string;
  previewUrl: string;
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
      const isPartial = PARTIAL_PATTERNS.test(comp.name) || comp.isSubComponent;
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

    // Build route map từ plan (primary) — fallback sang convention nếu plan thiếu
    const FALLBACK_ROUTE_MAP: Record<string, string> = {
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
      const path = planRouteMap.get(c.name) ?? FALLBACK_ROUTE_MAP[c.name] ?? `/${c.name.toLowerCase()}`;
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
    const vitePort = this.pickVitePort(jobId);

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

    const previewUrl = `http://localhost:${vitePort}`;
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

    // 2. Inject CSS variables + body font + heading sizes vào index.css
    {
      const cssPath = join(frontendDir, 'src', 'index.css');
      let cssContent = await readFile(cssPath, 'utf-8');

      // :root — inject ALL WP preset CSS variables so AI-generated components
      // can reference var(--wp--preset--color--slug) etc. without guessing hex values.
      const vars: string[] = [];

      // Layout & gap (legacy aliases + WP standard names)
      const cw = tokens.defaults?.contentWidth ?? '650px';
      const ww = tokens.defaults?.wideWidth ?? '1200px';
      const bg = tokens.defaults?.blockGap ?? '1.5rem';
      vars.push(`  --wp-content-width: ${cw};`);
      vars.push(`  --wp-wide-width: ${ww};`);
      vars.push(`  --wp-block-gap: ${bg};`);
      vars.push(`  --wp--style--global--content-size: ${cw};`);
      vars.push(`  --wp--style--global--wide-size: ${ww};`);
      vars.push(`  --wp--style--block-gap: ${bg};`);

      // Color preset variables
      for (const c of tokens.colors)
        vars.push(`  --wp--preset--color--${c.slug}: ${c.value};`);

      // Font-size preset variables
      for (const s of tokens.fontSizes)
        vars.push(`  --wp--preset--font-size--${s.slug}: ${s.size};`);

      // Font-family preset variables
      for (const f of tokens.fonts)
        vars.push(`  --wp--preset--font-family--${f.slug}: ${f.family};`);

      // Spacing preset variables
      for (const s of tokens.spacing)
        vars.push(`  --wp--preset--spacing--${s.slug}: ${s.size};`);

      cssContent = cssContent.replace(
        /:root \{[\s\S]*?\}/,
        `:root {\n${vars.join('\n')}\n}`,
      );

      // body — default font-family, font-size, color từ theme
      const bodyRules: string[] = [];
      if (tokens.defaults?.fontFamily)
        bodyRules.push(`  font-family: ${tokens.defaults.fontFamily};`);
      if (tokens.defaults?.fontSize)
        bodyRules.push(`  font-size: ${tokens.defaults.fontSize};`);
      if (tokens.defaults?.textColor)
        bodyRules.push(`  color: ${tokens.defaults.textColor};`);
      if (tokens.defaults?.bgColor)
        bodyRules.push(`  background-color: ${tokens.defaults.bgColor};`);
      if (bodyRules.length > 0)
        cssContent += `\nbody {\n${bodyRules.join('\n')}\n}\n`;

      // Global block gap — mirrors WP's --wp--style--block-gap behavior
      // .is-layout-flow uses margin-top; .is-layout-flex uses gap (handled by CSS class in index.css)
      cssContent += `\n.wp-block-group.is-layout-flow > * + *,\n.wp-block-cover__inner-container > * + * {\n  margin-top: var(--wp--style--block-gap, 1.5rem);\n}\n`;

      // Restore browser-default-like vertical spacing stripped by Tailwind Preflight.
      // WordPress themes rely on these margins; without them elements appear crammed.
      cssContent += `
/* Prose spacing — restore browser defaults removed by Tailwind Preflight */
h1, h2, h3, h4, h5, h6 {
  margin-top: 0.75em;
  margin-bottom: 0.4em;
}
p {
  margin-top: 0;
  margin-bottom: 1em;
}
ul, ol {
  margin-top: 0;
  margin-bottom: 1em;
  padding-left: 1.5em;
}
li + li {
  margin-top: 0.25em;
}
figure {
  margin: 0 0 1em;
}
`;

      // h1–h6 — heading sizes + weights từ theme tokens (chính xác hơn Tailwind generic)
      const headings = tokens.defaults?.headings;
      if (headings) {
        const headingColor = tokens.defaults?.headingColor
          ? `  color: ${tokens.defaults.headingColor};`
          : '';
        for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
          const h = headings[level];
          if (!h) continue;
          const rules: string[] = [];
          if (h.fontSize) rules.push(`  font-size: ${h.fontSize};`);
          if (h.fontWeight) rules.push(`  font-weight: ${h.fontWeight};`);
          if (headingColor) rules.push(headingColor);
          if (rules.length > 0)
            cssContent += `\n${level} {\n${rules.join('\n')}\n}\n`;
        }
      }

      await writeFile(cssPath, cssContent);
    }

    // 3. Inject Google Fonts vào index.html
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
}
