import { wpBlocksToJson } from './wp-block-to-json.js';
import { mapWpNodesToDraftSections } from './wp-node-to-sections-mapper.js';

describe('mapWpNodesToDraftSections', () => {
  it('maps profolio-fse pattern references into source-backed page section skeletons', () => {
    const markup = `
<!-- wp:pattern {"slug":"profolio-fse/banner"} /-->
<!-- wp:group {"tagName":"main"} -->
<main class="wp-block-group">
  <!-- wp:pattern {"slug":"profolio-fse/projects"} /-->
  <!-- wp:pattern {"slug":"profolio-fse/services"} /-->
  <!-- wp:pattern {"slug":"profolio-fse/experience"} /-->
  <!-- wp:pattern {"slug":"profolio-fse/skills"} /-->
</main>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections.map((section) => section.debugKey)).toEqual([
      'banner',
      'projects',
      'my-services',
      'ui-ux-design',
      'graphic-design',
      'product-design',
      'experience',
      'skills',
    ]);
    expect(sections.map((section) => section.type)).toEqual([
      'media-text',
      'card-grid',
      'hero',
      'media-text',
      'media-text',
      'media-text',
      'media-text',
      'card-grid',
    ]);
    expect(sections[0]).toMatchObject({
      type: 'media-text',
      debugKey: 'banner',
      paddingStyle: '80px 20px 0px 20px',
      marginStyle: '0px 0px',
      gapStyle: 'var(--wp--preset--spacing--40)',
      imageSrc: 'theme-asset:/assets/images/banner-image.png',
      imageFrameBackgroundSrc: 'theme-asset:/assets/images/banner.jpg',
      imageFrameBackground: '#F5B731',
      imageFrameBackgroundPosition: '49% 37%',
      imageFrameMinHeight: '550px',
      imageFramePaddingStyle: '0px',
      imageHeightStyle: '500px',
      imageFit: 'contain',
      imageCustomClassNames: ['aligncenter', 'is-resized'],
      imageRadius: '50% 50% 0px 0px',
      columnWidths: ['50%', '50%'],
      background: '#2F4138',
      textColor: '#fff',
      heading:
        'Welcome To My Profile <br>I am <mark style="background-color:rgba(0,0,0,0);color:#F5B731" class="has-inline-color has-secondary-color">Julia Henderson</mark>',
      cta: { text: 'View my Work', link: '#' },
      ctaStyle: {
        background: '#F5B731',
        color: '#f2f2f2',
      },
      customClassNames: expect.arrayContaining([
        'profolio-fse-banner-wrapper',
        'alignfull',
      ]),
    });
    expect(sections[1]).toMatchObject({
      type: 'card-grid',
      debugKey: 'projects',
      customClassNames: expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
        'profolio-fse-projects-wrapper',
        'alignfull',
        'vp-card-grid-intro-centered',
      ]),
      cards: expect.arrayContaining([
        expect.objectContaining({
          heading: 'Design of a mobile app develops',
          customClassNames: expect.arrayContaining([
            'wow',
            'animate__animated',
            'animate__fadeInUp',
            'profolio-fse-project-card',
          ]),
          headingCustomClassNames: ['profolio-fse-project-card-title'],
          bodyCustomClassNames: ['profolio-fse-project-card-body'],
        }),
        expect.objectContaining({
          heading: 'Web Traffic Management',
          imageSrc: 'theme-asset:/assets/images/projects-1.jpg',
        }),
      ]),
    });
    expect(sections[3]).toMatchObject({
      type: 'media-text',
      debugKey: 'ui-ux-design',
      imagePosition: 'right',
      background: '#2F4138',
      textColor: '#fff',
      paddingStyle: '40px 40px 40px 40px',
      gapStyle: '40px 40px',
      border: { radius: '8px' },
      imageFrameMinHeight: '380px',
      imageFrameBackgroundSrc: 'theme-asset:/assets/images/projects-1.jpg',
      ctaStyle: expect.objectContaining({
        background: '#F5B731',
        color: '#f2f2f2',
      }),
      customClassNames: expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
        'profolio-fse-service-card',
      ]),
      marginStyle: '0px 0px 24px 0px',
    });
    expect(sections[4]).toMatchObject({
      type: 'media-text',
      debugKey: 'graphic-design',
      imagePosition: 'right',
      background: '#f1f5f9',
      paddingStyle: '48px 40px 40px 40px',
      marginStyle: '0px 0px 24px 0px',
      imageFrameBackgroundSrc: 'theme-asset:/assets/images/projects-2.jpg',
    });
    expect(sections[5]).toMatchObject({
      type: 'media-text',
      debugKey: 'product-design',
      imagePosition: 'right',
      background: '#f1f5f9',
      paddingStyle: '48px 40px 40px 40px',
      marginStyle: '0px 0px 24px 0px',
      imageFrameBackgroundSrc: 'theme-asset:/assets/images/projects-3.jpg',
    });
    expect(sections[6]).toMatchObject({
      type: 'media-text',
      debugKey: 'experience',
      subtitle: 'Welcome to my profile',
      heading: 'Lead Product and Designer and Art Director',
      background: '#F5B731',
      textColor: '#2F4138',
      imageFrameBorderStyle: '10px solid #2F4138',
      imageFrameCustomClassNames: expect.arrayContaining([
        'profolio-fse-experience-image',
      ]),
      customClassNames: expect.arrayContaining([
        'profolio-fse-experience-wrapper',
        'alignfull',
      ]),
      subtitleCustomClassNames: ['profolio-fse-experience-copy'],
      headingCustomClassNames: ['profolio-fse-experience-copy'],
      bodyCustomClassNames: ['profolio-fse-experience-copy'],
      stats: [
        { value: '150+', label: 'Total Projects' },
        { value: '120+', label: 'Total Testimonials' },
        { value: '11k+', label: "User's Request" },
      ],
    });
    expect(sections[7]).toMatchObject({
      type: 'card-grid',
      debugKey: 'skills',
      title: 'Skills and Tools',
      customClassNames: expect.arrayContaining([
        'vp-skills-row',
        'profolio-fse-skills-wrapper',
        'alignfull',
      ]),
      cardStyle: {
        background: '#fef8ea',
        padding: '40px 20px 40px 20px',
        borderRadius: '10px',
        imageWidthStyle: '80px',
      },
      cards: [
        expect.objectContaining({
          heading: 'UI/UX Deisgn',
          customClassNames: expect.arrayContaining([
            'wow',
            'animate__animated',
            'animate__zoomIn',
            'profolio-fse-skill-card',
          ]),
          imageCustomClassNames: expect.arrayContaining([
            'aligncenter',
            'is-resized',
            'profolio-fse-skill-icon',
          ]),
        }),
        expect.objectContaining({
          heading: 'Graphic Deisgn',
          customClassNames: expect.arrayContaining(['animate__delay-1s']),
        }),
        expect.objectContaining({
          heading: 'Illustrator',
          customClassNames: expect.not.arrayContaining(['animate__delay-1s']),
        }),
        expect.objectContaining({
          heading: 'After Effects',
          customClassNames: expect.arrayContaining(['animate__delay-1s']),
        }),
        expect.objectContaining({
          heading: 'Wordpress',
          customClassNames: expect.not.arrayContaining(['animate__delay-1s']),
        }),
      ],
    });
  });

  it('maps profolio-fse page template pattern references without dropping nested sections', () => {
    const markup = `
<!-- wp:pattern {"slug":"profolio-fse/services"} /-->
<!-- wp:pattern {"slug":"profolio-fse/faq"} /-->
<!-- wp:pattern {"slug":"profolio-fse/articles"} /-->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections.map((section) => section.debugKey)).toEqual([
      'my-services',
      'ui-ux-design',
      'graphic-design',
      'product-design',
      'faq',
      'articles',
    ]);
    expect(
      sections.find((section) => section.type === 'accordion'),
    ).toMatchObject({
      type: 'accordion',
      title: 'Frequently Asked Questions',
    });
    expect(
      sections.find((section) => section.type === 'post-list'),
    ).toMatchObject({
      type: 'post-list',
      title: 'Recent Blog Posts',
      layout: 'grid-3',
    });
  });

  it('maps profolio-fse single-post pattern to a canonical post-detail skeleton', () => {
    const markup = `
<!-- wp:pattern {"slug":"profolio-fse/single-post"} /-->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections.map((section) => section.debugKey)).toEqual([
      'single-post-cover',
      'single-post-featured-image',
      'single-post-content',
      'single-post-categories',
      'single-post-tags',
      'single-post-comment-form',
      'sidebar-search',
      'latest-posts',
      'categories',
      'tags',
    ]);
    expect(sections.map((section) => section.type)).toEqual([
      'cover',
      'post-featured-image',
      'post-content',
      'post-terms',
      'post-terms',
      'comments',
      'search',
      'sidebar',
      'sidebar',
      'sidebar',
    ]);
  });

  it('maps sidebar widget groups to sidebar sections instead of hero headings', () => {
    const markup = `
<!-- wp:group {"className":"sticky-sidebar","style":{"color":{"background":"#F4F4F4"},"spacing":{"padding":{"top":"1rem","right":"min(1.5rem, 2vw)","bottom":"1rem","left":"min(1.5rem, 2vw)"}}}} -->
<div class="wp-block-group sticky-sidebar">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:search {"label":"Search","showLabel":false,"placeholder":"Search"} /-->
  </div>
  <!-- /wp:group -->

  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">Latest Posts</h3>
    <!-- /wp:heading -->
    <!-- wp:latest-posts {"postsToShow":5} /-->
  </div>
  <!-- /wp:group -->

  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">Categories</h3>
    <!-- /wp:heading -->
    <!-- wp:categories {"showPostCounts":true} /-->
  </div>
  <!-- /wp:group -->

  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:heading {"level":3} -->
    <h3 class="wp-block-heading">Tags</h3>
    <!-- /wp:heading -->
    <!-- wp:tag-cloud /-->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections.map((section) => section.type)).toEqual([
      'search',
      'sidebar',
      'sidebar',
      'sidebar',
    ]);
    expect(sections.filter((section) => section.type === 'hero')).toHaveLength(
      0,
    );
    expect(sections[1]).toMatchObject({
      type: 'sidebar',
      title: 'Latest Posts',
      widgets: [{ kind: 'recent-posts', title: 'Latest Posts' }],
      maxItems: 5,
    });
    expect(sections[2]).toMatchObject({
      type: 'sidebar',
      title: 'Categories',
      widgets: [{ kind: 'categories', title: 'Categories', showCounts: true }],
    });
    expect(sections[3]).toMatchObject({
      type: 'sidebar',
      title: 'Tags',
      widgets: [{ kind: 'tags', title: 'Tags' }],
    });
  });

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

  it('maps columns that wrap a query loop as a post-list instead of a static card-grid', () => {
    const markup = `
<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:query {"query":{"perPage":4,"postType":"post","inherit":true},"layout":{"type":"default"}} -->
<div class="wp-block-query"><!-- wp:post-template {"style":{"spacing":{"blockGap":"40px"}},"layout":{"type":"grid","minimumColumnWidth":"20rem"}} -->
<!-- wp:group {"style":{"border":{"radius":"10px","color":"#e0e0e0","width":"1px"}}} -->
<div class="wp-block-group"><!-- wp:post-featured-image {"isLink":true,"style":{"border":{"radius":"10px"}}} /-->
<!-- wp:group -->
<div class="wp-block-group"><!-- wp:post-author {"showAvatar":false} /-->
<!-- wp:post-date /-->
<!-- wp:post-title {"isLink":true} /-->
<!-- wp:post-excerpt {"moreText":"Read More","excerptLength":16} /--></div>
<!-- /wp:group --></div>
<!-- /wp:group -->
<!-- /wp:post-template -->
<!-- wp:query-no-results -->
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">No posts found</p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results --></div>
<!-- /wp:query --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections.some((section) => section.type === 'card-grid')).toBe(
      false,
    );
    expect(
      sections.find((section) => section.type === 'post-list'),
    ).toMatchObject({
      type: 'post-list',
      layout: 'grid-3',
      showAuthor: true,
      showDate: true,
      showExcerpt: true,
      showFeaturedImage: true,
      imageRadius: '10px',
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
    <!-- wp:cover {"url":"/banner-bg.jpg","overlayColor":"secondary","minHeight":550,"className":"r-cover","style":{"border":{"radius":{"topLeft":"50%","topRight":"50%","bottomLeft":"0px","bottomRight":"0px"}},"spacing":{"padding":{"top":"0","right":"0","bottom":"0","left":"0"}}}} -->
    <div class="wp-block-cover r-cover" style="border-top-left-radius:50%;border-top-right-radius:50%;border-bottom-left-radius:0px;border-bottom-right-radius:0px;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0;min-height:550px">
      <img class="wp-block-cover__image-background" alt="" src="/banner-bg.jpg" />
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
      imageFrameBackgroundSrc: '/banner-bg.jpg',
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

  it('preserves wow scroll-reveal classes on profolio-style intro groups', () => {
    const markup = `
<!-- wp:group {"className":"wow animate__animated animate__fadeInUp cover-inner"} -->
<div class="wp-block-group wow animate__animated animate__fadeInUp cover-inner">
  <!-- wp:paragraph -->
  <p>My Projects</p>
  <!-- /wp:paragraph -->
  <!-- wp:heading -->
  <h2>Some Of My Projects</h2>
  <!-- /wp:heading -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections[0]).toMatchObject({
      type: 'hero',
      customClassNames: expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
      ]),
    });
  });

  it('maps profolio contact columns with a cover-backed location panel into media-text', () => {
    const markup = `
<!-- wp:columns {"verticalAlignment":"center"} -->
<div class="wp-block-columns are-vertically-aligned-center">
  <!-- wp:column {"verticalAlignment":"center","className":"wow animate__animated animate__fadeInUp cover-inner"} -->
  <div class="wp-block-column is-vertically-aligned-center wow animate__animated animate__fadeInUp cover-inner">
    <!-- wp:paragraph {"style":{"typography":{"fontWeight":"700","textTransform":"uppercase","letterSpacing":"1px"}}} -->
    <p>Get in touch</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading {"level":1} -->
    <h1>Let's Work Together</h1>
    <!-- /wp:heading -->
    <!-- wp:paragraph -->
    <p>Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur per libero consectetuer id elit.</p>
    <!-- /wp:paragraph -->
  </div>
  <!-- /wp:column -->
  <!-- wp:column {"verticalAlignment":"center"} -->
  <div class="wp-block-column is-vertically-aligned-center">
    <!-- wp:cover {"url":"/projects-3.jpg","dimRatio":40,"overlayColor":"base","minHeight":620,"contentPosition":"bottom left","className":"r-cover","style":{"border":{"radius":{"topLeft":"10px","topRight":"10px","bottomLeft":"10px","bottomRight":"10px"}},"spacing":{"padding":{"top":"20px","bottom":"20px","left":"20px","right":"20px"}}}} -->
    <div class="wp-block-cover has-custom-content-position is-position-bottom-left r-cover" style="border-top-left-radius:10px;border-top-right-radius:10px;border-bottom-left-radius:10px;border-bottom-right-radius:10px;padding-top:20px;padding-right:20px;padding-bottom:20px;padding-left:20px;min-height:620px">
      <img class="wp-block-cover__image-background" alt="" src="/projects-3.jpg" data-object-fit="cover"/>
      <span aria-hidden="true" class="wp-block-cover__background has-base-background-color has-background-dim-40 has-background-dim"></span>
      <div class="wp-block-cover__inner-container">
        <!-- wp:paragraph {"align":"center","fontSize":"large"} -->
        <p class="has-text-align-center has-large-font-size">New York, USA</p>
        <!-- /wp:paragraph -->
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
      imageSrc: '/projects-3.jpg',
      imagePosition: 'right',
      imageFrameMinHeight: '620px',
      subtitle: 'Get in touch',
      heading: "Let's Work Together",
      body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur per libero consectetuer id elit.',
    });
    expect(
      (sections[0] as { imageFrameCustomClassNames?: string[] })
        .imageFrameCustomClassNames,
    ).toEqual(expect.arrayContaining(['r-cover', 'is-position-bottom-left']));
  });

  it('merges profolio article intros into the following post-list section', () => {
    const markup = `
<!-- wp:group {"metadata":{"name":"Articles"},"className":"r-pad"} -->
<div class="wp-block-group r-pad">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:paragraph -->
    <p>Insights and articles</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading -->
    <h2>Recent Blog Posts</h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group {"className":"wow animate__animated animate__fadeInUp cover-inner"} -->
  <div class="wp-block-group wow animate__animated animate__fadeInUp cover-inner">
    <!-- wp:query {"query":{"perPage":3,"postType":"post","order":"desc","orderBy":"date","inherit":false}} -->
    <div class="wp-block-query">
      <!-- wp:post-template {"layout":{"type":"grid","columnCount":3}} -->
      <!-- wp:post-featured-image /-->
      <!-- wp:group {"backgroundColor":"contrast"} -->
      <div class="wp-block-group has-contrast-background-color has-background">
        <!-- wp:post-date /-->
        <!-- wp:post-title {"isLink":true} /-->
        <!-- wp:post-excerpt {"moreText":"Read More","excerptLength":16} /-->
      </div>
      <!-- /wp:group -->
      <!-- /wp:post-template -->
    </div>
    <!-- /wp:query -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'post-list',
      title: 'Recent Blog Posts',
      layout: 'grid-3',
      showDate: true,
      showExcerpt: true,
      showFeaturedImage: true,
      customClassNames: expect.arrayContaining([
        'wow',
        'animate__animated',
        'animate__fadeInUp',
        'cover-inner',
      ]),
    });
  });

  it('maps profolio services pattern into one intro hero plus repeated media-text service rows', () => {
    const markup = `
<!-- wp:group {"metadata":{"name":"Services"},"className":"r-pad"} -->
<div class="wp-block-group r-pad">
  <!-- wp:group -->
  <div class="wp-block-group">
    <!-- wp:paragraph -->
    <p>Services</p>
    <!-- /wp:paragraph -->
    <!-- wp:heading -->
    <h2>My Services</h2>
    <!-- /wp:heading -->
  </div>
  <!-- /wp:group -->

  <!-- wp:group {"className":"wow animate__animated animate__fadeInUp cover-inner"} -->
  <div class="wp-block-group wow animate__animated animate__fadeInUp cover-inner">
    <!-- wp:columns {"backgroundColor":"primary"} -->
    <div class="wp-block-columns has-primary-background-color has-background">
      <!-- wp:column -->
      <div class="wp-block-column">
        <!-- wp:heading -->
        <h2>UI/UX Design</h2>
        <!-- /wp:heading -->
        <!-- wp:paragraph -->
        <p>Class aptent taciti sociosqu ad litora torquent per conubia nostra.</p>
        <!-- /wp:paragraph -->
      </div>
      <!-- /wp:column -->
      <!-- wp:column -->
      <div class="wp-block-column">
        <!-- wp:cover {"url":"/projects-1.jpg","minHeight":380,"className":"r-cover"} -->
        <div class="wp-block-cover r-cover" style="min-height:380px">
          <img class="wp-block-cover__image-background" alt="" src="/projects-1.jpg" data-object-fit="cover"/>
          <div class="wp-block-cover__inner-container"></div>
        </div>
        <!-- /wp:cover -->
      </div>
      <!-- /wp:column -->
    </div>
    <!-- /wp:columns -->

    <!-- wp:columns -->
    <div class="wp-block-columns">
      <!-- wp:column -->
      <div class="wp-block-column">
        <!-- wp:heading -->
        <h2>Graphic Design</h2>
        <!-- /wp:heading -->
        <!-- wp:paragraph -->
        <p>Vestibulum ante ipsum primis in faucibus orci luctus et ultrices.</p>
        <!-- /wp:paragraph -->
      </div>
      <!-- /wp:column -->
      <!-- wp:column -->
      <div class="wp-block-column">
        <!-- wp:cover {"url":"/projects-2.jpg","minHeight":380,"className":"r-cover"} -->
        <div class="wp-block-cover r-cover" style="min-height:380px">
          <img class="wp-block-cover__image-background" alt="" src="/projects-2.jpg" data-object-fit="cover"/>
          <div class="wp-block-cover__inner-container"></div>
        </div>
        <!-- /wp:cover -->
      </div>
      <!-- /wp:column -->
    </div>
    <!-- /wp:columns -->
  </div>
  <!-- /wp:group -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({
      type: 'hero',
      heading: 'My Services',
      subheading: 'Services',
    });
    expect(sections[1]).toMatchObject({
      type: 'media-text',
      heading: 'UI/UX Design',
      imageSrc: '/projects-1.jpg',
      imagePosition: 'right',
    });
    expect(sections[2]).toMatchObject({
      type: 'media-text',
      heading: 'Graphic Design',
      imageSrc: '/projects-2.jpg',
      imagePosition: 'right',
    });
  });

  it('maps profolio experience pattern into a left-image media-text section', () => {
    const markup = `
<!-- wp:group {"metadata":{"name":"Experience"},"className":"r-pad","backgroundColor":"secondary"} -->
<div class="wp-block-group r-pad has-secondary-background-color has-background">
  <!-- wp:columns {"verticalAlignment":"center"} -->
  <div class="wp-block-columns are-vertically-aligned-center">
    <!-- wp:column {"verticalAlignment":"center"} -->
    <div class="wp-block-column is-vertically-aligned-center">
      <!-- wp:cover {"url":"/experience.jpg","minHeight":500,"contentPosition":"bottom center","className":"r-cover","focalPoint":{"x":0.49,"y":0.37},"borderColor":"primary","style":{"border":{"radius":{"topLeft":"10px","topRight":"10px","bottomLeft":"10px","bottomRight":"10px"},"width":"10px"},"spacing":{"padding":{"top":"0","right":"0","bottom":"0","left":"0"}}}} -->
      <div class="wp-block-cover is-position-bottom-center r-cover" style="border-width:10px;border-radius:10px;min-height:500px">
        <img class="wp-block-cover__image-background" alt="portrait" src="/experience.jpg" data-object-fit="cover"/>
        <div class="wp-block-cover__inner-container"></div>
      </div>
      <!-- /wp:cover -->
    </div>
    <!-- /wp:column -->
    <!-- wp:column {"verticalAlignment":"center","className":"wow animate__animated animate__fadeInUp cover-inner"} -->
    <div class="wp-block-column is-vertically-aligned-center wow animate__animated animate__fadeInUp cover-inner">
      <!-- wp:paragraph -->
      <p>Welcome to my profile</p>
      <!-- /wp:paragraph -->
      <!-- wp:heading {"level":1} -->
      <h1>Lead Product and Designer and Art Director</h1>
      <!-- /wp:heading -->
      <!-- wp:paragraph -->
      <p>Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur.</p>
      <!-- /wp:paragraph -->
      <!-- wp:group {"layout":{"type":"flex","justifyContent":"left"}} -->
      <div class="wp-block-group">
        <!-- wp:group -->
        <div class="wp-block-group">
          <!-- wp:heading -->
          <h2>150+</h2>
          <!-- /wp:heading -->
          <!-- wp:paragraph -->
          <p>Total Projects</p>
          <!-- /wp:paragraph -->
        </div>
        <!-- /wp:group -->
        <!-- wp:group -->
        <div class="wp-block-group">
          <!-- wp:heading -->
          <h2>120+</h2>
          <!-- /wp:heading -->
          <!-- wp:paragraph -->
          <p>Total Testimonials</p>
          <!-- /wp:paragraph -->
        </div>
        <!-- /wp:group -->
        <!-- wp:group -->
        <div class="wp-block-group">
          <!-- wp:heading -->
          <h2>11k+</h2>
          <!-- /wp:heading -->
          <!-- wp:paragraph -->
          <p>User's Request</p>
          <!-- /wp:paragraph -->
        </div>
        <!-- /wp:group -->
      </div>
      <!-- /wp:group -->
    </div>
    <!-- /wp:column -->
  </div>
  <!-- /wp:columns -->
</div>
<!-- /wp:group -->
`;

    const nodes = wpBlocksToJson(markup);
    const sections = mapWpNodesToDraftSections(nodes);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      type: 'media-text',
      imageSrc: '/experience.jpg',
      imagePosition: 'left',
      subtitle: 'Welcome to my profile',
      heading: 'Lead Product and Designer and Art Director',
      body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo eu posuere in sit efficitur.',
      imageRadius: '10px',
      imageFrameBackgroundSrc: '/experience.jpg',
      imageFrameBackgroundPosition: '49% 37%',
      imageFrameMinHeight: '500px',
      imageFramePaddingStyle: '0px',
      imageFrameBorderStyle: '10px solid var(--wp--preset--color--primary)',
      stats: [
        { value: '150+', label: 'Total Projects' },
        { value: '120+', label: 'Total Testimonials' },
        { value: '11k+', label: "User's Request" },
      ],
    });
    expect((sections[0] as { body?: string }).body).not.toContain(
      'Total Projects',
    );
  });
});
