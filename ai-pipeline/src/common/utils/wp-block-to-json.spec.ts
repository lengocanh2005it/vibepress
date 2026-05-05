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
});
