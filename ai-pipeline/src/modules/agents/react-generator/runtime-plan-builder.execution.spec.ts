import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRuntimePlanFromPageRow } from '../../../../templates/express-server/runtime/runtime-plan-builder.js';

describe('runtime-plan-builder execution', () => {
  const originalThemeDir = process.env.THEME_DIR;
  let themeDir: string;

  beforeEach(async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-plan-builder-'));
    themeDir = join(workspaceDir, 'profolio-fse');
    await mkdir(join(themeDir, 'templates'), { recursive: true });

    await writeFile(
      join(themeDir, 'templates', 'front-page.html'),
      [
        '<!-- wp:group -->',
        '<div class="wp-block-group"><!-- wp:heading --><h1>Front</h1><!-- /wp:heading --><!-- wp:post-content /--></div>',
        '<!-- /wp:group -->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'templates', 'template-about.html'),
      [
        '<!-- wp:group -->',
        '<div class="wp-block-group"><!-- wp:heading --><h1>About</h1><!-- /wp:heading --><!-- wp:post-content /--></div>',
        '<!-- /wp:group -->',
      ].join('\n'),
    );

    process.env.THEME_DIR = themeDir;
  });

  afterEach(async () => {
    process.env.THEME_DIR = originalThemeDir;
    await rm(themeDir, { recursive: true, force: true });
  });

  it('treats the real front page as profolio front-page even when _wp_page_template is empty', () => {
    const plan = buildRuntimePlanFromPageRow({
      template: '',
      is_front_page: 1,
      is_posts_page: 0,
      post_name: 'home',
      post_content: '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',
    });

    expect(plan.layoutFamily).toBe('profolio-fse-front-page');
    expect(plan.source.template).toBe('front-page');
    expect(plan.blockTree.length).toBeGreaterThan(0);
  });

  it('normalizes templates/template-about.html to the profolio about layout family', () => {
    const plan = buildRuntimePlanFromPageRow({
      template: 'templates/template-about.html',
      is_front_page: 0,
      is_posts_page: 0,
      post_name: 'sample-page',
      post_content:
        '<!-- wp:paragraph --><p>About body</p><!-- /wp:paragraph -->',
    });

    expect(plan.layoutFamily).toBe('profolio-fse-about-page');
    expect(plan.source.template).toBe('template-about');
    expect(plan.blockTree.length).toBeGreaterThan(0);
  });
});
