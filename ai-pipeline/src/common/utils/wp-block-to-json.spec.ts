import { wpBlocksToJson } from './wp-block-to-json.js';

describe('wpBlocksToJson PHP normalization', () => {
  it('preserves apostrophes inside translated PHP strings', () => {
    const markup = `
<!-- wp:heading -->
<h2><?php echo esc_html__( 'Let\\'s Work Together', 'demo' ); ?></h2>
<!-- /wp:heading -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.text).toBe("Let's Work Together");
  });

  it('preserves wrapper ids from WordPress block markup', () => {
    const markup = `
<!-- wp:group {"tagName":"header"} -->
<header id="sticky-header" class="wp-block-group">
  <!-- wp:paragraph -->
  <p>Hello</p>
  <!-- /wp:paragraph -->
</header>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.domId).toBe('sticky-header');
  });

  it('preserves standalone wow motion hook classes from WordPress block markup', () => {
    const markup = `
<!-- wp:group {"className":"wow animate__animated animate__fadeInUp cover-inner"} -->
<div class="wp-block-group wow animate__animated animate__fadeInUp cover-inner">
  <!-- wp:paragraph -->
  <p>About Me</p>
  <!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.customClassNames).toEqual(
      expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
      ]),
    );
  });

  it('normalizes border radius, width, color, and duplicate css units from block params', () => {
    const markup = `
<!-- wp:group {"borderColor":"primary","style":{"border":{"radius":{"topLeft":"40px","topRight":"40px","bottomRight":"40px","bottomLeft":"40px"},"width":"10"},"spacing":{"padding":{"top":"80pxpx","bottom":"autopx"}}}} -->
<div class="wp-block-group"></div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.borderRadius).toBe('40px');
    expect(nodes[0]?.borderWidth).toBe('10px');
    expect(nodes[0]?.borderColor).toBe('var(--wp--preset--color--primary)');
    expect(nodes[0]?.padding?.top).toBe('80px');
    expect(nodes[0]?.padding?.bottom).toBe('auto');
  });

  it('preserves dom ids on leaf blocks', () => {
    const markup = `
<!-- wp:paragraph -->
<p id="intro-copy">Hello world</p>
<!-- /wp:paragraph -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.domId).toBe('intro-copy');
  });

  it('merges explicit wrapper classes from params and markup on leaf blocks', () => {
    const markup = `
<!-- wp:button {"className":"header-btn"} -->
<div class="wp-block-button header-btn is-style-fill"><a class="wp-block-button__link wow animate__animated" href="#">Get Started</a></div>
<!-- /wp:button -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.customClassNames).toEqual(
      expect.arrayContaining([
        'header-btn',
        'is-style-fill',
        'wow',
        'animate__animated',
      ]),
    );
  });

  it('preserves social link service and url params for faithful footer rendering', () => {
    const markup = `
<!-- wp:social-links {"iconColor":"secondary","iconColorValue":"#F5B731","className":"is-style-logos-only"} -->
<ul class="wp-block-social-links is-style-logos-only"><!-- wp:social-link {"url":"#","service":"facebook"} /-->
<!-- wp:social-link {"url":"#","service":"instagram"} /--></ul>
<!-- /wp:social-links -->
`;

    const nodes = wpBlocksToJson(markup);
    const socialLinks = nodes[0];
    const [facebook, instagram] = socialLinks?.children ?? [];

    expect(socialLinks?.params).toMatchObject({
      iconColor: 'secondary',
      iconColorValue: '#F5B731',
    });
    expect(facebook?.params).toMatchObject({
      service: 'facebook',
      url: '#',
    });
    expect(instagram?.params).toMatchObject({
      service: 'instagram',
      url: '#',
    });
  });

  it('lifts styling from self-closing site title and navigation blocks', () => {
    const markup = `
<!-- wp:site-title {"style":{"elements":{"link":{"color":{"text":"var:preset|color|white"}}},"typography":{"fontSize":"30px"}},"textColor":"white"} /-->
<!-- wp:navigation {"textColor":"white","icon":"menu","overlayBackgroundColor":"white-text-color","style":{"spacing":{"blockGap":"40px"},"typography":{"fontWeight":"600"}}} /-->
`;

    const [siteTitle, navigation] = wpBlocksToJson(markup);

    expect(siteTitle).toMatchObject({
      block: 'site-title',
      textColor: 'white',
      typography: {
        fontSize: '30px',
      },
    });
    expect(navigation).toMatchObject({
      block: 'navigation',
      params: {
        icon: 'menu',
        overlayBackgroundColor: 'white-text-color',
      },
      textColor: 'white',
      gap: '40px',
      typography: {
        fontWeight: '600',
      },
    });
  });

  it('preserves paragraph text around inline links', () => {
    const markup = `
<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">Developed By <a href="#">Themegrove.com</a></p>
<!-- /wp:paragraph -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.text).toBeUndefined();
    expect(nodes[0]?.html).toContain('Developed By');
    expect(nodes[0]?.html).toContain('<a href="#">Themegrove.com</a>');
  });

  it('normalizes image dimensions from wp:image params and inline img styles', () => {
    const markup = `
<!-- wp:image {"width":"20px","height":"30px"} -->
<figure class="wp-block-image size-full is-resized"><img src="/assets/images/arrow-up.png" alt="" style="width:20px;height:30px"/></figure>
<!-- /wp:image -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]).toMatchObject({
      block: 'image',
      src: 'theme-asset:/assets/images/arrow-up.png',
      width: 20,
      height: 30,
    });
  });
});
