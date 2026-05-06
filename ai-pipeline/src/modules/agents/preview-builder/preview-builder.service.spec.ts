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
});
