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

  it('normalizes border radius objects and duplicate css units from block params', () => {
    const markup = `
<!-- wp:group {"style":{"border":{"radius":{"topLeft":"40px","topRight":"40px","bottomRight":"40px","bottomLeft":"40px"}},"spacing":{"padding":{"top":"80pxpx","bottom":"autopx"}}}} -->
<div class="wp-block-group"></div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);

    expect(nodes[0]?.borderRadius).toBe('40px');
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
});
