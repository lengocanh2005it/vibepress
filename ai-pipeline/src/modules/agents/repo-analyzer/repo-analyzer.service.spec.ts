import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoAnalyzerService } from './repo-analyzer.service.js';

describe('RepoAnalyzerService profolio-fse deep analysis', () => {
  let workspaceDir: string;
  let themeDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'repo-analyzer-profolio-'));
    themeDir = join(workspaceDir, 'themes', 'profolio-fse');

    await mkdir(join(themeDir, 'templates'), { recursive: true });
    await mkdir(join(themeDir, 'parts'), { recursive: true });
    await mkdir(join(themeDir, 'patterns'), { recursive: true });
    await mkdir(join(themeDir, 'assets', 'js'), { recursive: true });

    await writeFile(
      join(themeDir, 'theme.json'),
      JSON.stringify({ version: 2, settings: { color: { palette: [] } } }),
    );
    await writeFile(
      join(themeDir, 'functions.php'),
      [
        '<?php',
        "wp_enqueue_style('animatecss', get_template_directory_uri() . '/assets/css/animate.css');",
        "wp_enqueue_script('wow-script', get_template_directory_uri() . '/assets/js/wow.js', array('jquery'));",
        "wp_enqueue_script('jquery-sticky', get_template_directory_uri() . '/assets/js/jquery-sticky.js', array('jquery'));",
        "wp_enqueue_script('profolio-fse-main-script', get_template_directory_uri() . '/assets/js/script.js', array('jquery'), '1.0.0', true);",
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'style.css'),
      [
        '#sticky-header { z-index: 999 !important; }',
        '.wp-block-navigation a::after { content: ""; width: 0%; background: var(--wp--preset--color--white); }',
        '.wp-block-navigation-item.current-menu-item a::after { width: 100%; }',
        '.profolio-fse-scroll-top { display: none; }',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'parts', 'header.html'),
      '<!-- wp:pattern {"slug":"profolio-fse/header"} /-->',
    );
    await writeFile(
      join(themeDir, 'parts', 'footer.html'),
      '<!-- wp:pattern {"slug":"profolio-fse/footer"} /-->',
    );
    await writeFile(
      join(themeDir, 'templates', 'front-page.html'),
      [
        '<!-- wp:template-part {"slug":"header","tagName":"header"} /-->',
        '<!-- wp:pattern {"slug":"profolio-fse/front-page"} /-->',
        '<!-- wp:template-part {"slug":"footer","tagName":"footer"} /-->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'patterns', 'header.php'),
      [
        '<?php /** Title: Header */ ?>',
        '<!-- wp:group {"tagName":"header"} -->',
        '<header id="sticky-header" class="wp-block-group"><!-- wp:navigation {"textColor":"white"} /--></header>',
        '<!-- /wp:group -->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'patterns', 'footer.php'),
      [
        '<?php /** Title: Footer */ ?>',
        '<!-- wp:paragraph {"className":"profolio-fse-scroll-top"} -->',
        '<p class="profolio-fse-scroll-top"></p>',
        '<!-- /wp:paragraph -->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'patterns', 'front-page.php'),
      [
        '<?php',
        '/**',
        ' * Title: Front Page',
        ' * Slug: profolio-fse/front-page',
        ' */',
        '?>',
        '<!-- wp:pattern {"slug":"profolio-fse/banner"} /-->',
        '<!-- wp:pattern {"slug":"profolio-fse/services"} /-->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'patterns', 'banner.php'),
      [
        '<?php',
        '/**',
        ' * Title: Banner',
        ' * Slug: profolio-fse/banner',
        ' */',
        '?>',
        '<!-- wp:columns -->',
        '<div class="wp-block-columns"><!-- wp:column {"className":"wow animate__animated animate__fadeInUp cover-inner"} -->',
        '<div class="wp-block-column wow animate__animated animate__fadeInUp cover-inner"><!-- wp:heading --><h2>Welcome To My Profile</h2><!-- /wp:heading --></div>',
        '<!-- /wp:column --></div>',
        '<!-- /wp:columns -->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'patterns', 'services.php'),
      [
        '<?php',
        '/**',
        ' * Title: Services',
        ' * Slug: profolio-fse/services',
        ' */',
        '?>',
        '<!-- wp:group {"className":"wow animate__animated animate__zoomIn"} -->',
        '<div class="wp-block-group wow animate__animated animate__zoomIn"><!-- wp:heading --><h2>Some Of My Projects</h2><!-- /wp:heading --></div>',
        '<!-- /wp:group -->',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'assets', 'js', 'script.js'),
      [
        '(function ($) {',
        '  $(document).ready(function(){',
        '    $("#sticky-header").sticky({topSpacing:0});',
        "    $(window).scroll(function(){ if ($(this).scrollTop() > 100) { $('.profolio-fse-scroll-top').fadeIn(); } else { $('.profolio-fse-scroll-top').fadeOut(); } });",
        "    $('.profolio-fse-scroll-top').click(function(){ $('html, body').animate({ scrollTop: 0 }, 'slow'); });",
        "    wow = new WOW({ boxClass: 'wow', animateClass: 'animated', offset: 0, mobile: true, live: true });",
        '    wow.init();',
        '  });',
        '})(jQuery);',
      ].join('\n'),
    );
    await writeFile(
      join(themeDir, 'assets', 'js', 'jquery-sticky.js'),
      "var defaults = { className: 'is-sticky', wrapperClassName: 'sticky-wrapper' };",
    );
    await writeFile(
      join(themeDir, 'assets', 'js', 'wow.js'),
      "var defaults = { boxClass: 'wow', animateClass: 'animated', offset: 0, mobile: true, live: true };",
    );
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('resolves profolio-specific route chains and behavior signals', async () => {
    const service = new RepoAnalyzerService();
    const result = await service.analyze(themeDir);
    const deep = result.themeManifest.themeDeepAnalysis;

    expect(deep?.themeSlug).toBe('profolio-fse');
    expect(
      deep?.routeSources.find((entry) => entry.routeFamily === 'front-page'),
    ).toMatchObject({
      entryFile: 'templates/front-page.html',
      chainFiles: expect.arrayContaining([
        'templates/front-page.html',
        'patterns/front-page.php',
        'patterns/banner.php',
        'patterns/services.php',
        'parts/header.html',
        'parts/footer.html',
      ]),
      patternSlugs: expect.arrayContaining([
        'profolio-fse/front-page',
        'profolio-fse/banner',
        'profolio-fse/services',
      ]),
      customClasses: expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
      ]),
    });
    expect(deep?.behaviorSignals.map((signal) => signal.key)).toEqual(
      expect.arrayContaining([
        'sticky-header',
        'scroll-reveal',
        'nav-underline-active',
        'scroll-top',
      ]),
    );
  });
});
