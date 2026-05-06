import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { collectThemeCssSources } from './theme-css-sources.js';

describe('collectThemeCssSources', () => {
  it('strips leading @charset directives from inline theme css assets', async () => {
    const themeDir = await mkdtemp(join(tmpdir(), 'vp-theme-css-'));

    try {
      await mkdir(join(themeDir, 'assets', 'css'), { recursive: true });
      await writeFile(
        join(themeDir, 'style.css'),
        '/* Theme Name: Demo */\nbody { color: #111; }\n',
        'utf-8',
      );
      await writeFile(
        join(themeDir, 'assets', 'css', 'animate.css'),
        '@charset "UTF-8";\n.animate__animated { animation-duration: 1s; }\n',
        'utf-8',
      );

      const result = await collectThemeCssSources(themeDir);

      expect(result.files).toEqual(['assets/css/animate.css', 'style.css']);
      expect(result.combinedCss).toContain('/* assets/css/animate.css */');
      expect(result.combinedCss).toContain(
        '.animate__animated { animation-duration: 1s; }',
      );
      expect(result.combinedCss).not.toContain('@charset "UTF-8";');
    } finally {
      await rm(themeDir, { recursive: true, force: true });
    }
  });
});
