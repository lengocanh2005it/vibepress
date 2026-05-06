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

  it('maps Woo product term aliases on post-terms blocks', () => {
    const markup = `
<!-- wp:post-terms {"term":"product_cat","prefix":"Category: "} /-->
<!-- wp:post-terms {"term":"product_tag","prefix":"Tags: "} /-->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);
    const categoryTerms = sections.find(
      (section) =>
        section.type === 'post-terms' && section.taxonomy === 'category',
    );
    const tagTerms = sections.find(
      (section) =>
        section.type === 'post-terms' && section.taxonomy === 'post_tag',
    );

    expect(categoryTerms).toMatchObject({
      type: 'post-terms',
      taxonomy: 'category',
      prefix: 'Category:',
    });
    expect(tagTerms).toMatchObject({
      type: 'post-terms',
      taxonomy: 'post_tag',
      prefix: 'Tags:',
    });
  });

  it('avoids blog-meta defaults for Woo related products queries', () => {
    const markup = `
<!-- wp:group -->
<div class="wp-block-group">
  <!-- wp:query {"namespace":"woocommerce/related-products"} -->
  <div class="wp-block-query">
    <!-- wp:post-template {"className":"products-block-post-template","layout":{"type":"grid","columnCount":"4"},"__woocommerceNamespace":"woocommerce/product-query/product-template"} -->
    <!-- wp:woocommerce/product-image {"isDescendentOfQueryLoop":true} /-->
    <!-- wp:post-title {"level":3} /-->
    <!-- wp:woocommerce/product-price {"isDescendentOfQueryLoop":true} /-->
    <!-- wp:woocommerce/product-button {"isDescendentOfQueryLoop":true} /-->
    <!-- /wp:post-template -->
  </div>
  <!-- /wp:query -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);
    const postList = sections.find((section) => section.type === 'post-list');

    expect(postList).toMatchObject({
      type: 'post-list',
      layout: 'grid-3',
      showDate: false,
      showAuthor: false,
      showCategory: false,
      showExcerpt: false,
      showFeaturedImage: true,
    });
  });

  it('collapses repeated testimonial group cards into one card-grid section', () => {
    const markup = `
<!-- wp:group -->
<div class="wp-block-group">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:paragraph -->
    <p>Testimonials</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading -->
    <h2>What My Clients Say About Me</h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group {"layout":{"type":"grid","minimumColumnWidth":"21rem"}} -->
  <div class="wp-block-group">
    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:paragraph -->
      <p>☆☆☆☆☆</p>
      <!-- /wp:paragraph -->
      <!-- wp:paragraph -->
      <p><em>"Quote one from client"</em></p>
      <!-- /wp:paragraph -->
      <!-- wp:group -->
      <div class="wp-block-group">
        <!-- wp:image -->
        <figure class="wp-block-image"><img src="/avatar-1.jpg" alt="Sarah Jenkins" /></figure>
        <!-- /wp:image -->
        <!-- wp:group -->
        <div class="wp-block-group">
          <!-- wp:paragraph -->
          <p>Sarah Jenkins</p>
          <!-- /wp:paragraph -->
          <!-- wp:paragraph -->
          <p>CEO at TechFlow</p>
          <!-- /wp:paragraph -->
        </div>
        <!-- /wp:group -->
      </div>
      <!-- /wp:group -->
    </div>
    <!-- /wp:group -->

    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:paragraph -->
      <p>☆☆☆☆☆</p>
      <!-- /wp:paragraph -->
      <!-- wp:paragraph -->
      <p><strong>"Quote two from client"</strong></p>
      <!-- /wp:paragraph -->
      <!-- wp:group -->
      <div class="wp-block-group">
        <!-- wp:image -->
        <figure class="wp-block-image"><img src="/avatar-2.jpg" alt="David Chen" /></figure>
        <!-- /wp:image -->
        <!-- wp:group -->
        <div class="wp-block-group">
          <!-- wp:paragraph -->
          <p>David Chen</p>
          <!-- /wp:paragraph -->
          <!-- wp:paragraph -->
          <p>Founder at TechFlow</p>
          <!-- /wp:paragraph -->
        </div>
        <!-- /wp:group -->
      </div>
      <!-- /wp:group -->
    </div>
    <!-- /wp:group -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'card-grid',
      title: 'What My Clients Say About Me',
      subtitle: 'Testimonials',
      columns: 2,
      cards: [
        {
          heading: 'Sarah Jenkins',
          body: 'Quote one from client',
          imageSrc: '/avatar-1.jpg',
        },
        {
          heading: 'David Chen',
          body: 'Quote two from client',
          imageSrc: '/avatar-2.jpg',
        },
      ],
    });
  });

  it('collapses repeated icon/text skill groups into one card-grid section', () => {
    const markup = `
<!-- wp:group -->
<div class="wp-block-group">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:paragraph -->
    <p>Skills</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading -->
    <h2>Skills and Tools</h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group {"layout":{"type":"grid"}} -->
  <div class="wp-block-group">
    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:image -->
      <figure class="wp-block-image"><img src="/figma.png" alt="Figma" /></figure>
      <!-- /wp:image -->
      <!-- wp:paragraph -->
      <p>UI/UX Design</p>
      <!-- /wp:paragraph -->
    </div>
    <!-- /wp:group -->

    <!-- wp:group -->
    <div class="wp-block-group">
      <!-- wp:image -->
      <figure class="wp-block-image"><img src="/photoshop.png" alt="Photoshop" /></figure>
      <!-- /wp:image -->
      <!-- wp:paragraph -->
      <p>Graphic Design</p>
      <!-- /wp:paragraph -->
    </div>
    <!-- /wp:group -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'card-grid',
      title: 'Skills and Tools',
      subtitle: 'Skills',
      columns: 2,
      cards: [
        {
          heading: 'UI/UX Design',
          body: '',
          imageSrc: '/figma.png',
        },
        {
          heading: 'Graphic Design',
          body: '',
          imageSrc: '/photoshop.png',
        },
      ],
    });
  });

  it('preserves short eyebrow paragraphs as media-text subtitles instead of flattening them into body', () => {
    const markup = `
<!-- wp:columns -->
<div class="wp-block-columns">
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:heading -->
    <h2>Welcome To My Profile I am Julia Henderson</h2>
    <!-- /wp:heading -->
    <!-- wp:paragraph {"style":{"typography":{"fontWeight":"700","textTransform":"uppercase","letterSpacing":"1px"}}} -->
    <p>About Me</p>
    <!-- /wp:paragraph -->
    <!-- wp:paragraph -->
    <p>Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur per libero consectetuer id elit neque condimentum parturient.</p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:image -->
    <figure class="wp-block-image"><img src="/banner-image.png" alt="Julia Henderson" /></figure>
    <!-- /wp:image -->
  </div>
  <!-- /wp:column -->
</div>
<!-- /wp:columns -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'media-text',
      imageSrc: '/banner-image.png',
      heading: 'Welcome To My Profile I am Julia Henderson',
      subtitle: 'About Me',
      body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur per libero consectetuer id elit neque condimentum parturient.',
      subtitleStyle: {
        fontWeight: '700',
        letterSpacing: '1px',
        textTransform: 'uppercase',
      },
    });
  });

  it('preserves rich heading markup and cover-backed image frames in media-text columns', () => {
    const markup = `
<!-- wp:columns -->
<div class="wp-block-columns">
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:paragraph {"style":{"typography":{"fontWeight":"700","textTransform":"uppercase","letterSpacing":"1px"}}} -->
    <p>About Me</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading {"level":1} -->
    <h1>Welcome To My Profile <br>I am <mark style="background-color:rgba(0,0,0,0)" class="has-inline-color has-secondary-color">Julia Henderson</mark></h1>
    <!-- /wp:heading -->
    <!-- wp:paragraph -->
    <p>Mattis pellentesque ex phasellus amet nulla aliquam commodo.</p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
  <!-- wp:column -->
  <div class="wp-block-column">
    <!-- wp:cover {"overlayColor":"secondary","minHeight":550,"className":"r-cover","style":{"border":{"radius":{"topLeft":"50%","topRight":"50%","bottomLeft":"0px","bottomRight":"0px"}},"spacing":{"padding":{"top":"0","right":"0","bottom":"0","left":"0"}}}} -->
    <div class="wp-block-cover r-cover" style="border-top-left-radius:50%;border-top-right-radius:50%;border-bottom-left-radius:0px;border-bottom-right-radius:0px;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0;min-height:550px">
      <span aria-hidden="true" class="wp-block-cover__background has-secondary-background-color has-background-dim-100 has-background-dim"></span>
      <div class="wp-block-cover__inner-container">
        <!-- wp:image -->
        <figure class="wp-block-image is-resized"><img src="/banner-image.png" alt="Julia Henderson" /></figure>
        <!-- /wp:image -->
      </div>
    </div>
    <!-- /wp:cover -->
  </div>
  <!-- /wp:column -->
</div>
<!-- /wp:columns -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'media-text',
      imageSrc: '/banner-image.png',
      imageFit: 'contain',
      imageFrameMinHeight: '550px',
      imageRadius: '50% 50% 0px 0px',
      imageFrameCustomClassNames: ['r-cover'],
      subtitle: 'About Me',
    });
    expect((sections[0] as { heading?: string }).heading).toContain('<br>');
    expect((sections[0] as { heading?: string }).heading).toContain(
      'Julia Henderson',
    );
  });
});
