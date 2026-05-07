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

      await (service as any).applyThemeSourceStyles(frontendDir, themeDir, {
        themeTypeHints: { themeSlug: 'profolio-fse' },
        sourceOfTruth: {
          styleFiles: [
            'style.css',
            'assets/font-awesome/css/all.css',
            'assets/css/animate.css',
          ],
        },
      });

      const [nextCss, bundledCss] = await Promise.all([
        readFile(join(srcDir, 'index.css'), 'utf-8'),
        readFile(join(stylesDir, 'theme-source-profolio-fse.css'), 'utf-8'),
      ]);

      expect(nextCss).toContain(
        "@import './styles/theme-source-profolio-fse.css';",
      );
      expect(nextCss).not.toContain('/* Vibepress theme stylesheet CSS */');
      expect(bundledCss).toContain('/* style.css */');
      expect(bundledCss).toContain('/* assets/font-awesome/css/all.css */');
      expect(bundledCss).toContain('/* assets/css/animate.css */');
      expect(bundledCss).toContain(
        'url("/assets/font-awesome/webfonts/fa-solid-900.woff2")',
      );
      expect(bundledCss).not.toContain('@charset "UTF-8";');
      expect(bundledCss).toContain('.animate__zoomIn');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
