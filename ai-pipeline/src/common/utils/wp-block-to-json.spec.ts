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
});
