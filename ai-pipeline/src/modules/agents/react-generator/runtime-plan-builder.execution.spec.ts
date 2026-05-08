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
    expect(plan.contentBlockTree.length).toBeGreaterThan(0);
    expect(
      JSON.stringify(plan.blockTree).includes('"kind":"content-slot"'),
    ).toBe(true);
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
    expect(plan.contentBlockTree.length).toBeGreaterThan(0);
  });

  it('includes theme tokens and preserves template/content boundaries', async () => {
    await writeFile(
      join(themeDir, 'theme.json'),
      JSON.stringify({
        settings: {
          layout: { contentSize: '1200px', wideSize: '1200px' },
          color: { palette: [{ slug: 'primary', color: '#2F4138' }] },
          spacing: {
            spacingSizes: [{ slug: '40', size: 'min(4rem, 5vw)' }],
          },
          typography: {
            fontSizes: [{ slug: 'large', size: '1.85rem' }],
            fontFamilies: [{ slug: 'body', fontFamily: 'League Spartan' }],
          },
        },
        styles: {
          spacing: { blockGap: '1.2rem' },
          blocks: { 'core/paragraph': { typography: { fontSize: '1rem' } } },
        },
      }),
    );

    const plan = buildRuntimePlanFromPageRow({
      template: 'templates/template-about.html',
      is_front_page: 0,
      is_posts_page: 0,
      post_name: 'sample-page',
      post_content:
        '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:paragraph --><p>Complex body</p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->',
    });

    expect(plan.themeTokens.layout.contentSize).toBe('1200px');
    expect(plan.themeTokens.colors.palette[0].slug).toBe('primary');
    expect(plan.layoutPolicy).toMatchObject({
      themeSlug: 'profolio-fse',
      contentSize: '1200px',
      wideSize: '1200px',
    });
    expect(plan.contentBlockTree[0].kind).toBe('columns');
    expect(JSON.stringify(plan.blockTree)).toContain('"binding"');
  });

  it('preserves Gutenberg heading and paragraph alignment attrs in content block trees', () => {
    const plan = buildRuntimePlanFromPageRow({
      template: 'templates/template-about.html',
      is_front_page: 0,
      is_posts_page: 0,
      post_name: 'team',
      post_content: [
        '<!-- wp:group {"layout":{"type":"flex","orientation":"vertical","justifyContent":"center"}} -->',
        '<div class="wp-block-group">',
        '<!-- wp:heading {"textAlign":"center"} --><h2 class="has-text-align-center">Meet our team</h2><!-- /wp:heading -->',
        '<!-- wp:paragraph {"align":"center"} --><p class="has-text-align-center">Team intro</p><!-- /wp:paragraph -->',
        '</div>',
        '<!-- /wp:group -->',
      ].join('\n'),
    });

    const group = plan.contentBlockTree[0];
    const heading = group.children?.[0];
    const paragraph = group.children?.[1];

    expect(group.layout).toMatchObject({
      kind: 'flex',
      orientation: 'vertical',
      justifyContent: 'center',
    });
    expect(heading?.textAlign).toBe('center');
    expect(heading?.style?.typography?.textAlign).toBe('center');
    expect(paragraph?.textAlign).toBe('center');
    expect(paragraph?.style?.typography?.textAlign).toBe('center');
  });

  it('adds parent-derived layout context to nested content blocks', () => {
    const plan = buildRuntimePlanFromPageRow({
      template: 'templates/template-about.html',
      is_front_page: 0,
      is_posts_page: 0,
      post_name: 'image-layout-context',
      post_content: [
        '<!-- wp:columns {"align":"wide"} -->',
        '<div class="wp-block-columns alignwide">',
        '<!-- wp:column {"width":"40%"} -->',
        '<div class="wp-block-column" style="flex-basis:40%">',
        '<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="/wp-content/uploads/example.jpg" alt="Example"/></figure><!-- /wp:image -->',
        '</div>',
        '<!-- /wp:column -->',
        '</div>',
        '<!-- /wp:columns -->',
      ].join('\n'),
    });

    const image =
      plan.contentBlockTree[0].children?.[0].children?.[0];

    expect(image?.kind).toBe('image');
    expect(image?.layoutContext).toMatchObject({
      inColumns: true,
      columnsAlign: 'wide',
      inColumn: true,
      columnWidth: '40%',
    });
  });

  it('emits detailed DOM, media, width-policy, and content-slot metadata', () => {
    const plan = buildRuntimePlanFromPageRow({
      template: 'templates/template-about.html',
      is_front_page: 0,
      is_posts_page: 0,
      post_name: 'structured-media',
      post_content: [
        '<!-- wp:group {"align":"full","layout":{"type":"constrained"}} -->',
        '<div class="wp-block-group alignfull">',
        '<!-- wp:image {"id":42,"sizeSlug":"large","aspectRatio":"9/16","scale":"cover","style":{"border":{"radius":{"topLeft":"50%","topRight":"50%"}}}} -->',
        '<figure class="wp-block-image size-large" style="border-radius:50% 50% 0 0"><img src="/wp-content/uploads/team.jpg" alt="Team" width="640" height="960"/></figure>',
        '<!-- /wp:image -->',
        '</div>',
        '<!-- /wp:group -->',
      ].join('\n'),
    });

    const contentRoot = plan.contentBlockTree[0];
    const image = contentRoot.children?.[0];

    expect(plan.contentSlot).toMatchObject({
      blockName: 'core/post-content',
      bindingSource: 'page.content',
    });
    expect(contentRoot.layout).toMatchObject({
      align: 'full',
      kind: 'constrained',
      widthPolicy: 'full-bleed',
      innerWidthPolicy: 'content',
    });
    expect(contentRoot.dom).toMatchObject({
      tagName: 'div',
      classNames: expect.arrayContaining(['wp-block-group', 'alignfull']),
    });
    expect(image?.media).toMatchObject({
      id: 42,
      sizeSlug: 'large',
      aspectRatio: '9/16',
      scale: 'cover',
      width: 640,
      height: 960,
    });
    expect(image?.style?.border?.radius).toMatchObject({
      topLeft: '50%',
      topRight: '50%',
    });
  });
});
