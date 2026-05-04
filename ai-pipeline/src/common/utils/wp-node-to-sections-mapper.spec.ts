import { wpBlocksToJson } from './wp-block-to-json.js';
import { mapWpNodesToDraftSections } from './wp-node-to-sections-mapper.js';

describe('mapWpNodesToDraftSections', () => {
  it('maps grouped core/details FAQ markup into one accordion section', () => {
    const markup = `
<!-- wp:group {"metadata":{"name":"FAQ"},"layout":{"type":"constrained"}} -->
<div class="wp-block-group">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:heading {"textAlign":"center"} -->
    <h2 class="wp-block-heading has-text-align-center">Frequently Asked Questions</h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:details {"showContent":true} -->
      <details open><summary>Question one</summary><!-- wp:paragraph -->
      <p>Answer one</p>
      <!-- /wp:paragraph --></details>
      <!-- /wp:details -->
    </div>
    <!-- /wp:group -->

    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:details -->
      <details><summary>Question two</summary><!-- wp:paragraph -->
      <p>Answer two</p>
      <!-- /wp:paragraph --></details>
      <!-- /wp:details -->
    </div>
    <!-- /wp:group -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);
    const accordionSection = sections.find(
      (section) => section.type === 'accordion',
    );

    expect(accordionSection).toBeDefined();
    expect(accordionSection).toMatchObject({
      type: 'accordion',
      title: 'Frequently Asked Questions',
      items: [
        { heading: 'Question one', body: 'Answer one' },
        { heading: 'Question two', body: 'Answer two' },
      ],
    });
  });

  it('preserves PHP-backed FAQ summary and body text when mapping accordion sections', () => {
    const markup = `
<?php
/**
 * Title: FAQ
 */
?>
<!-- wp:group {"metadata":{"name":"FAQ"},"layout":{"type":"constrained"}} -->
<div class="wp-block-group">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:heading {"textAlign":"center"} -->
    <h2 class="wp-block-heading has-text-align-center"><?php echo esc_html__( 'Frequently Asked Questions', 'demo' ); ?></h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:details {"showContent":true} -->
      <details open><summary><?php echo esc_html__( 'Question one', 'demo' ); ?></summary><!-- wp:paragraph {"placeholder":"Type / to add a hidden block"} -->
      <p><?php echo esc_html__( 'Answer one', 'demo' ); ?></p>
      <!-- /wp:paragraph --></details>
      <!-- /wp:details -->
    </div>
    <!-- /wp:group -->

    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:details -->
      <details><summary><?php echo esc_html__( 'Question two', 'demo' ); ?></summary><!-- wp:paragraph {"placeholder":"Type / to add a hidden block"} -->
      <p><?php echo esc_html__( 'Answer two', 'demo' ); ?></p>
      <!-- /wp:paragraph --></details>
      <!-- /wp:details -->
    </div>
    <!-- /wp:group -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);
    const accordionSection = sections.find(
      (section) => section.type === 'accordion',
    );

    expect(accordionSection).toBeDefined();
    expect(accordionSection).toMatchObject({
      type: 'accordion',
      title: 'Frequently Asked Questions',
      items: [
        { heading: 'Question one', body: 'Answer one' },
        { heading: 'Question two', body: 'Answer two' },
      ],
    });
  });
});
