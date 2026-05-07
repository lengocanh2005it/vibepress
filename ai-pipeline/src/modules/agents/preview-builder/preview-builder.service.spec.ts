import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PreviewBuilderService } from './preview-builder.service.js';

describe('PreviewBuilderService', () => {
  const service = new PreviewBuilderService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  it('injects generated image class before self-closing img slash', () => {
    const code = `
      export default function Demo() {
        return <img src="/avatar.jpg" alt="" style={{ borderRadius: '100%' }} />;
      }
    `;

    const normalized = (service as any).decorateGeneratedInteractionClasses(
      code,
    );

    expect(normalized).toContain(
      `<img src="/avatar.jpg" alt="" style={{ borderRadius: '100%' }} className="vp-generated-image" />`,
    );
    expect(normalized).not.toContain('/ className="vp-generated-image">');
  });

  it('does not add fallback underline classes to source-styled header navigation links', () => {
    const code = `
      import { Link } from 'react-router-dom';

      export default function Header() {
        return (
          <nav className="wp-block-navigation">
            <Link to={toAppPath(item.url)} className="wp-block-navigation-item__content vp-generated-link no-underline hover:underline underline-offset-4 transition-opacity hover:opacity-75">
              {item.title}
            </Link>
          </nav>
        );
      }
    `;

    const normalized = (service as any).prepareGeneratedComponentCode(
      code,
      undefined,
      'Header',
    );

    expect(normalized).toContain(
      'className="wp-block-navigation-item__content vp-generated-link no-underline"',
    );
    expect(normalized).not.toContain('hover:underline');
    expect(normalized).not.toContain('underline-offset-4');
    expect(normalized).not.toContain('hover:opacity-75');
  });

  it('normalizes raw theme asset literals before writing preview components', () => {
    const code = `
      export default function FrontPageProjects() {
        const projects = [
          { image: 'theme-asset:/assets/images/projects-1.jpg' },
          { image: 'theme-asset:/assets/images/projects-2.jpg' },
        ];
        return (
          <section>
            {projects.map((item) => (
              <article
                key={item.image}
                style={{ backgroundImage: \`url('\${item.image}')\` }}
              />
            ))}
            <img src="theme-asset:/assets/images/projects-3.jpg" alt="" />
          </section>
        );
      }
    `;

    const normalized = (service as any).prepareGeneratedComponentCode(
      code,
      undefined,
      'FrontPageProjects',
    );

    expect(normalized).toContain('const resolveAsset = (src: string) => {');
    expect(normalized).toContain(
      'image: resolveAsset("theme-asset:/assets/images/projects-1.jpg")',
    );
    expect(normalized).toContain(
      'image: resolveAsset("theme-asset:/assets/images/projects-2.jpg")',
    );
    expect(normalized).toContain(
      'backgroundImage: `url("${resolveAsset(item.image)}")`',
    );
    expect(normalized).toContain(
      'src={resolveAsset("theme-asset:/assets/images/projects-3.jpg")}',
    );
    expect(normalized).not.toContain(
      "image: 'theme-asset:/assets/images/projects-1.jpg'",
    );
  });

  it('keeps preview routes limited to runtime canonical routes', () => {
    const resolveRoute = (componentName: string, candidatePath: string) =>
      (service as any).resolveCanonicalPreviewRoute({
        componentName,
        candidatePath,
      });

    expect(resolveRoute('FrontPage', '/')).toBe('/');
    expect(resolveRoute('RuntimePage', '/page/:slug')).toBe('/page/:slug');
    expect(resolveRoute('Page', '/page/:slug')).toBe('/page/:slug');
    expect(resolveRoute('Single', '/post/:slug')).toBe('/post/:slug');
    expect(resolveRoute('Archive', '/archive')).toBe('/archive');
    expect(resolveRoute('Archive', '/category/:slug')).toBe('/category/:slug');
    expect(resolveRoute('Archive', '/author/:slug')).toBe('/author/:slug');
    expect(resolveRoute('Archive', '/tag/:slug')).toBe('/tag/:slug');
    expect(resolveRoute('NotFound', '*')).toBe('*');
    expect(resolveRoute('Page404', '*')).toBe('*');

    expect(resolveRoute('Index', '/blog')).toBeNull();
    expect(resolveRoute('ArchiveProduct', '/products')).toBeNull();
    expect(resolveRoute('Blank', '/blank/:slug')).toBeNull();
    expect(resolveRoute('BlogLeftSidebar', '/blog-left-sidebar')).toBeNull();
    expect(resolveRoute('Cart', '/cart')).toBeNull();
    expect(resolveRoute('Checkout', '/checkout')).toBeNull();
    expect(resolveRoute('TemplateAbout', '/template-about')).toBeNull();
    expect(resolveRoute('TemplateServices', '/template-services')).toBeNull();
  });

  it('injects WordPress global layout width variables from theme tokens', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vp-preview-builder-'));

    try {
      const frontendDir = join(rootDir, 'frontend');
      const srcDir = join(frontendDir, 'src');

      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'index.css'), '@tailwind base;\n', 'utf-8');

      await (service as any).injectWordPressBridgeClasses(frontendDir, {
        colors: [],
        fonts: [],
        fontSizes: [],
        spacing: [],
        defaults: {
          contentWidth: '1200px',
          wideWidth: '1200px',
        },
      });

      const nextCss = await readFile(join(srcDir, 'index.css'), 'utf-8');
      expect(nextCss).toContain(
        '--wp--style--global--content-size: 1200px;',
      );
      expect(nextCss).toContain('--wp--style--global--wide-size: 1200px;');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('injects theme style.css into preview css for theme-specific nav interactions', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vp-preview-builder-'));

    try {
      const frontendDir = join(rootDir, 'frontend');
      const srcDir = join(frontendDir, 'src');
      const themeDir = join(rootDir, 'theme');

      await mkdir(srcDir, { recursive: true });
      await mkdir(themeDir, { recursive: true });
      await writeFile(join(srcDir, 'index.css'), '@tailwind base;\n', 'utf-8');
      await writeFile(
        join(themeDir, 'style.css'),
        `@charset "UTF-8";
@media (min-width: 781px) {
  .wp-block-navigation a {
    position: relative;
    padding-bottom: 3px;
  }

  .wp-block-navigation a::after {
    content: "";
    width: 0%;
  }

  .wp-block-navigation a:hover::after {
    width: 100%;
  }
}
`,
        'utf-8',
      );

      await (service as any).applyThemeStylesheetCss(frontendDir, themeDir);

      const nextCss = await readFile(join(srcDir, 'index.css'), 'utf-8');
      expect(nextCss).toContain('/* Vibepress theme stylesheet CSS */');
      expect(nextCss).not.toContain('@charset "UTF-8";');
      expect(nextCss).toContain('.wp-block-navigation a::after');
      expect(nextCss).toContain('.wp-block-navigation a:hover::after');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('bundles profolio-fse source CSS into an imported stylesheet with rewritten asset URLs', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vp-preview-builder-'));

    try {
      const frontendDir = join(rootDir, 'frontend');
      const srcDir = join(frontendDir, 'src');
      const stylesDir = join(srcDir, 'styles');
      const themeDir = join(rootDir, 'profolio-fse');
      const fontCssDir = join(themeDir, 'assets', 'font-awesome', 'css');
      const animateCssDir = join(themeDir, 'assets', 'css');

      await mkdir(srcDir, { recursive: true });
      await mkdir(stylesDir, { recursive: true });
      await mkdir(fontCssDir, { recursive: true });
      await mkdir(animateCssDir, { recursive: true });
      await writeFile(
        join(srcDir, 'index.css'),
        "@import './styles/wp-block-style-bridges.css';\n@tailwind base;\n",
        'utf-8',
      );
      await writeFile(
        join(frontendDir, 'index.html'),
        '<html><head></head><body><div id="root"></div></body></html>',
        'utf-8',
      );
      await writeFile(
        join(themeDir, 'style.css'),
        `.profolio-fse-scroll-top::before { font-family: "Font Awesome 5 Free"; }`,
        'utf-8',
      );
      await writeFile(
        join(fontCssDir, 'all.css'),
        `@font-face { src: url("../webfonts/fa-solid-900.woff2") format("woff2"); }`,
        'utf-8',
      );
      await writeFile(
        join(animateCssDir, 'animate.css'),
        `@charset "UTF-8"; .animate__zoomIn { animation-name: zoomIn; }`,
        'utf-8',
      );
      await writeFile(
        join(animateCssDir, 'custom-properties.css'),
        `:root { --profolio-card-radius: 10px; } .custom-card { border-radius: var(--profolio-card-radius); }`,
        'utf-8',
      );

      await (service as any).applyThemeSourceStyles(
        frontendDir,
        themeDir,
        {
          themeTypeHints: { themeSlug: 'profolio-fse' },
          sourceOfTruth: {
            styleFiles: [
              'style.css',
              'assets/font-awesome/css/all.css',
              'assets/css/animate.css',
            ],
          },
        },
        [
          {
            name: 'FrontPage',
            filePath: '',
            code: 'export default function FrontPage(){return null;}',
            requiredSourceStyleFiles: ['assets/css/custom-properties.css'],
          },
        ],
      );

      const [nextCss, bundledCss, indexHtml] = await Promise.all([
        readFile(join(srcDir, 'index.css'), 'utf-8'),
        readFile(join(stylesDir, 'theme-source-profolio-fse.css'), 'utf-8'),
        readFile(join(frontendDir, 'index.html'), 'utf-8'),
      ]);

      expect(nextCss).toContain(
        "@import './styles/theme-source-profolio-fse.css';",
      );
      expect(nextCss).not.toContain('/* Vibepress theme stylesheet CSS */');
      expect(bundledCss).toContain('/* style.css */');
      expect(bundledCss).toContain('/* assets/font-awesome/css/all.css */');
      expect(bundledCss).toContain('/* assets/css/animate.css */');
      expect(bundledCss).toContain('/* assets/css/custom-properties.css */');
      expect(bundledCss).toContain('--profolio-card-radius: 10px;');
      expect(bundledCss).toContain(
        'url("/assets/font-awesome/webfonts/fa-solid-900.woff2")',
      );
      expect(indexHtml).toContain(
        'href="%BASE_URL%assets/font-awesome/css/all.css"',
      );
      expect(indexHtml).toContain('data-vp-theme-fontawesome="true"');
      expect(bundledCss).not.toContain('@charset "UTF-8";');
      expect(bundledCss).toContain('.animate__zoomIn');
      expect(bundledCss).toContain(
        '/* Vibepress theme source CSS overrides: profolio-fse */',
      );
      expect(bundledCss).toContain('html, body, #root {');
      expect(bundledCss).toContain('padding: 0;');
      expect(bundledCss).toContain(
        '.wp-site-blocks .profolio-fse-banner-wrapper {',
      );
      expect(bundledCss).toContain('width: 100vw;');
      expect(bundledCss).toContain('margin-left: calc(50% - 50vw);');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('emits local theme font faces with public asset URLs only when files exist', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vp-preview-builder-'));

    try {
      const themeDir = join(rootDir, 'theme');
      const fontDir = join(themeDir, 'assets', 'fonts', 'league-spartan');
      await mkdir(fontDir, { recursive: true });
      await writeFile(
        join(themeDir, 'theme.json'),
        JSON.stringify({
          settings: {
            typography: {
              fontFamilies: [
                {
                  fontFace: [
                    {
                      fontFamily: 'League Spartan',
                      fontStyle: 'normal',
                      fontWeight: '100 900',
                      src: [
                        'file:./assets/fonts/league-spartan/LeagueSpartan-VariableFont_wght.ttf',
                      ],
                    },
                  ],
                  fontFamily: 'League Spartan, sans-serif',
                  name: 'League Spartan',
                  slug: 'body',
                },
              ],
            },
          },
        }),
        'utf-8',
      );
      await writeFile(
        join(fontDir, 'LeagueSpartan-VariableFont_wght.ttf'),
        '',
        'utf-8',
      );

      const rules = await (service as any).buildLocalThemeFontFaceCss(themeDir);

      expect(rules).toEqual([
        '@font-face { font-family: "League Spartan"; src: url("/assets/fonts/league-spartan/LeagueSpartan-VariableFont_wght.ttf") format("truetype"); font-display: swap; font-style: normal; font-weight: 100 900; }',
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('skips missing local theme font faces so Google Fonts fallback can load', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'vp-preview-builder-'));

    try {
      const themeDir = join(rootDir, 'theme');
      await mkdir(themeDir, { recursive: true });
      await writeFile(
        join(themeDir, 'theme.json'),
        JSON.stringify({
          settings: {
            typography: {
              fontFamilies: [
                {
                  fontFace: [
                    {
                      fontFamily: 'League Spartan',
                      src: [
                        'file:./assets/fonts/league-spartan/LeagueSpartan-VariableFont_wght.ttf',
                      ],
                    },
                  ],
                  fontFamily: 'League Spartan, sans-serif',
                  name: 'League Spartan',
                  slug: 'body',
                },
              ],
            },
          },
        }),
        'utf-8',
      );

      const rules = await (service as any).buildLocalThemeFontFaceCss(themeDir);

      expect(rules).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
