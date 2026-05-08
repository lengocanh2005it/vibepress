import { CodeGeneratorService } from './code-generator.service.js';
import type { ComponentVisualPlan } from './visual-plan.schema.js';

describe('CodeGeneratorService', () => {
  const service = new CodeGeneratorService();

  const basePlan = {
    componentName: 'Fixture',
    dataNeeds: [],
    palette: {
      background: '#ffffff',
      surface: '#f5f5f5',
      text: '#111111',
      textMuted: '#666666',
      accent: '#2f4138',
      accentText: '#ffffff',
      dark: '#111111',
      darkText: '#ffffff',
    },
    typography: {
      headingFamily: 'inherit',
      bodyFamily: 'inherit',
      h1: 'text-[2.5rem] leading-tight',
      h2: 'text-[2rem] leading-snug',
      h3: 'text-[1.5rem] leading-snug',
      body: 'text-[1rem]',
      small: 'text-sm',
      buttonRadius: 'rounded-full',
    },
    layout: {
      containerClass: 'max-w-[1200px] mx-auto w-full',
      contentContainerClass: 'max-w-[800px] mx-auto w-full',
      blockGap: 'gap-8',
      includes: [],
    },
  } satisfies Omit<ComponentVisualPlan, 'sections'>;

  it('preserves theme asset cover backgrounds in hybrid block-tree output', () => {
    const plan = {
      ...basePlan,
      componentName: 'Index',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'cover',
          src: 'theme-asset:/assets/images/banner.jpg',
          overlayColor: '#000000',
          attrs: { dimRatio: 90 },
          minHeight: '420px',
          children: [
            {
              kind: 'paragraph',
              text: 'Inside banner',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'resolveAsset("theme-asset:/assets/images/banner.jpg")',
    );
    expect(code).toContain('backgroundImage: `url("${resolveAsset(');
    expect(code).toContain(
      'className="wp-block-cover__background has-background-dim"',
    );
    expect(code).toContain('opacity: 0.9');
  });

  it('renders detail-bound cover headings from the runtime item title', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      dataNeeds: ['postDetail'],
      sections: [
        {
          type: 'cover',
          imageSrc: 'theme-asset:/assets/images/banner.jpg',
          dimRatio: 90,
          minHeight: '232px',
          contentAlign: 'center',
          headingBinding: 'detail-title',
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('{item?.title}');
    expect(code).toContain('opacity: 0.9');
  });

  it('keeps unitless button line-height unitless', () => {
    const plan = {
      ...basePlan,
      componentName: 'FrontPage',
      blockStyles: {
        button: {
          typography: {
            lineHeight: '1.15',
          },
        },
      },
      sections: [
        {
          type: 'hero',
          heading: 'Welcome',
          cta: { text: 'Get Started', link: '#' },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("lineHeight: '1.15'");
    expect(code).not.toContain("lineHeight: '1.15px'");
  });

  it('unwraps paragraph block html before rendering inside paragraph wrappers', () => {
    const plan = {
      ...basePlan,
      componentName: 'RuntimeLikePage',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'paragraph',
          html: '<p><strong>About</strong> content</p>',
          sourceRef: { sourceNodeId: 'page::paragraph::1' },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'renderRichTextChildren("<strong>About</strong> content", "page::paragraph::1")',
    );
    expect(code).not.toContain(
      'renderRichTextChildren("<p><strong>About</strong> content</p>"',
    );
  });

  it('preserves WordPress image border styles inside rich text markup', () => {
    const plan = {
      ...basePlan,
      componentName: 'RuntimeLikePage',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'paragraph',
          html: '<p><img src="/uploads/team.jpg" alt="" style="border-top-left-radius:50%;border-top-right-radius:50%;border-bottom-left-radius:0;border-bottom-right-radius:0;aspect-ratio:1.6;object-fit:cover;width:100%" /></p>',
          sourceRef: { sourceNodeId: 'page::paragraph::image' },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("'borderTopLeftRadius'");
    expect(code).toContain("'borderTopRightRadius'");
    expect(code).toContain("'aspectRatio'");
    expect(code).toContain("'objectFit'");
    expect(code).toContain('style,');
  });

  it('falls back to block-tree rendering when deterministic partial sections are empty', () => {
    const plan = {
      ...basePlan,
      componentName: 'Sidebar',
      dataNeeds: ['posts'],
      renderMode: 'block-centric',
      sections: [],
      blockTree: [
        {
          kind: 'group',
          children: [
            {
              kind: 'search',
              sourceRef: { sourceNodeId: 'sidebar::search::0.0.0' },
            },
            {
              kind: 'heading',
              text: 'Latest Posts',
              level: 4,
            },
            {
              kind: 'latest-posts',
              sourceRef: { sourceNodeId: 'sidebar::latest-posts::0.1.1' },
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('<form role="search"');
    expect(code).toContain('Latest Posts');
    expect(code).toContain('posts.slice(0, 5)');
  });

  it('renders WooCommerce checkout block trees as checkout UI instead of raw block labels', () => {
    const plan = {
      ...basePlan,
      componentName: 'Checkout',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'group',
          children: [
            {
              kind: 'checkout',
              blockName: 'woocommerce/checkout',
              children: [
                {
                  kind: 'checkout-fields-block',
                  blockName: 'woocommerce/checkout-fields-block',
                },
                {
                  kind: 'checkout-totals-block',
                  blockName: 'woocommerce/checkout-totals-block',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('woocommerce-checkout');
    expect(code).toContain('Contact information');
    expect(code).toContain('Order summary');
    expect(code).not.toContain('Checkout Fields');
  });

  it('renders WooCommerce cart block trees as cart UI instead of empty wrappers', () => {
    const plan = {
      ...basePlan,
      componentName: 'Cart',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'cart',
          blockName: 'woocommerce/cart',
          children: [
            {
              kind: 'cart-items-block',
              blockName: 'woocommerce/cart-items-block',
            },
            {
              kind: 'cart-totals-block',
              blockName: 'woocommerce/cart-totals-block',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('woocommerce-cart');
    expect(code).toContain('Cart totals');
    expect(code).toContain('Proceed to checkout');
  });

  it('preserves WooCommerce cart source literals in deterministic cart output', () => {
    const plan = {
      ...basePlan,
      componentName: 'Cart',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'cart',
          blockName: 'woocommerce/cart',
          children: [
            {
              kind: 'filled-cart-block',
              children: [
                {
                  kind: 'cart-cross-sells-block',
                  children: [
                    {
                      kind: 'heading',
                      text: 'You may be interested in…',
                      level: 2,
                    },
                    {
                      kind: 'cart-cross-sells-products-block',
                    },
                  ],
                },
              ],
            },
            {
              kind: 'empty-cart-block',
              children: [
                {
                  kind: 'heading',
                  text: 'Your cart is currently empty!',
                  level: 2,
                },
                {
                  kind: 'heading',
                  text: 'New in store',
                  level: 2,
                },
                {
                  kind: 'product-new',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('You may be interested in…');
    expect(code).toContain('Your cart is currently empty!');
    expect(code).toContain('New in store');
    expect(code).toContain("fetch('/api/post-types/product/posts')");
    expect(code).toContain('import { Link }');
  });

  it('preserves source column widths when hybrid sidebar sections replace column children', () => {
    const plan = {
      ...basePlan,
      componentName: 'BlogLeftSidebar',
      dataNeeds: ['posts'],
      renderMode: 'hybrid',
      sections: [
        {
          type: 'sidebar',
          debugKey: 'latest-posts',
          widgets: [{ kind: 'recent-posts', title: 'Latest Posts' }],
        },
        {
          type: 'post-list',
          resource: 'posts',
        },
      ],
      blockTree: [
        {
          kind: 'columns',
          children: [
            {
              kind: 'column',
              columnWidth: '30%',
              children: [
                {
                  kind: 'template-part',
                  templatePartSlug: 'sidebar',
                },
              ],
            },
            {
              kind: 'column',
              columnWidth: '70%',
              children: [
                {
                  kind: 'query',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("gridTemplateColumns: '30% 70%'");
    expect(code).toContain("flex: '0 0 30%'");
    expect(code).toContain("flex: '0 0 70%'");
  });

  it('composes shared Sidebar partial into the right column for deterministic detail pages', () => {
    const plan = {
      ...basePlan,
      componentName: 'SinglePost',
      dataNeeds: ['postDetail'],
      layout: {
        ...basePlan.layout,
        contentLayout: 'sidebar-right',
        sidebarScope: 'all-content',
        sidebarWidth: '33.33%',
        includes: ['Sidebar'],
      },
      sections: [
        {
          type: 'post-content',
          showTitle: false,
        },
        {
          type: 'sidebar',
          widgets: [{ kind: 'recent-posts', title: 'Latest Posts' }],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("import Sidebar from '../components/Sidebar';");
    expect(code).toContain('<aside className="min-w-0"><Sidebar /></aside>');
    expect(code).not.toContain('Latest Posts');
  });

  it('mounts shared Sidebar in hybrid template-part placeholders and suppresses duplicated standalone sidebar blocks', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      dataNeeds: ['postDetail'],
      renderMode: 'hybrid',
      layout: {
        ...basePlan.layout,
        contentLayout: 'sidebar-right',
        sidebarScope: 'all-content',
        sidebarWidth: '33.33%',
        includes: ['Sidebar'],
      },
      sections: [
        {
          type: 'post-content',
          showTitle: false,
          sourceRef: { sourceNodeId: 'single::post-content::1.0.0.1' },
        },
        {
          type: 'sidebar',
          widgets: [{ kind: 'recent-posts', title: 'Latest Posts' }],
          customClassNames: ['sticky-sidebar'],
          sourceRef: { sourceNodeId: 'single::group::2' },
        },
      ],
      blockTree: [
        {
          kind: 'group',
          children: [
            {
              kind: 'columns',
              children: [
                {
                  kind: 'column',
                  columnWidth: '66.66%',
                  children: [
                    {
                      kind: 'post-content',
                      sourceRef: {
                        sourceNodeId: 'single::post-content::1.0.0.1',
                      },
                    },
                  ],
                },
                {
                  kind: 'column',
                  columnWidth: '33.33%',
                  children: [
                    {
                      kind: 'template-part',
                      sourceRef: {
                        sourceNodeId: 'single::template-part::1.0.1.0',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          kind: 'group',
          customClassNames: ['sticky-sidebar'],
          sourceRef: { sourceNodeId: 'single::group::2' },
          children: [{ kind: 'search' }, { kind: 'latest-posts' }],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("import Sidebar from '../components/Sidebar';");
    expect(code).toContain('<Sidebar />');
    expect(code).toContain("gridTemplateColumns: '66.66% 33.33%'");
    expect(code).not.toContain('className="sticky-sidebar"');
    expect(code).not.toContain('Latest Posts');
  });

  it('uses shared Sidebar when sidebar is represented only by layout includes and block tree placeholders', () => {
    const plan = {
      ...basePlan,
      componentName: 'SinglePost',
      dataNeeds: ['postDetail', 'posts'],
      renderMode: 'block-centric',
      layout: {
        ...basePlan.layout,
        contentLayout: 'sidebar-right',
        sidebarScope: 'all-content',
        sidebarWidth: '33.33%',
        includes: ['Sidebar'],
      },
      sections: [
        {
          type: 'post-content',
          showTitle: false,
          sourceRef: { sourceNodeId: 'single::post-content::1.0.0.1' },
        },
      ],
      blockTree: [
        {
          kind: 'group',
          children: [
            {
              kind: 'columns',
              children: [
                {
                  kind: 'column',
                  columnWidth: '66.66%',
                  children: [
                    {
                      kind: 'post-content',
                      sourceRef: {
                        sourceNodeId: 'single::post-content::1.0.0.1',
                      },
                    },
                  ],
                },
                {
                  kind: 'column',
                  columnWidth: '33.33%',
                  children: [
                    {
                      kind: 'template-part',
                      sourceRef: {
                        sourceNodeId: 'single::template-part::1.0.1.0',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          kind: 'group',
          customClassNames: ['sticky-sidebar'],
          sourceRef: { sourceNodeId: 'single::group::2' },
          children: [{ kind: 'search' }, { kind: 'latest-posts' }],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("import Sidebar from '../components/Sidebar';");
    expect(code).toContain('<Sidebar />');
    expect(code).toContain("gridTemplateColumns: '66.66% 33.33%'");
    expect(code).not.toContain('className="sticky-sidebar"');
    expect(code).not.toContain('posts.slice(0, 5)');
  });

  it('preserves source search descendants instead of collapsing wrapper sections in hybrid output', () => {
    const plan = {
      ...basePlan,
      componentName: 'Error404',
      renderMode: 'hybrid',
      sections: [
        {
          type: 'card-grid',
          columns: 1,
          cards: [
            { heading: '404: Page Not Disco-vered', body: 'Missing page.' },
          ],
          sourceRef: { sourceNodeId: '404::group::0' },
        },
      ],
      blockTree: [
        {
          kind: 'group',
          sourceRef: { sourceNodeId: '404::group::0' },
          children: [
            { kind: 'heading', text: '404: Page Not Disco-vered', level: 2 },
            { kind: 'paragraph', text: 'Missing page.' },
            {
              kind: 'search',
              sourceRef: { sourceNodeId: '404::search::0.0.0.0.2' },
            },
            { kind: 'button', text: 'Go to home page', href: '/' },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('<form role="search"');
    expect(code).toContain('Go to home page');
  });

  it('preserves source-backed card-grid descendants instead of collapsing rich project grids in hybrid output', () => {
    const plan = {
      ...basePlan,
      componentName: 'TemplateAbout',
      renderMode: 'hybrid',
      sections: [
        {
          type: 'card-grid',
          title: 'Some Of My Projects',
          subtitle: 'My Projects',
          columns: 4,
          cards: [
            {
              heading: 'Testimonial',
              body: 'Fallback card body',
              imageSrc: 'theme-asset:/assets/images/arrow-up.png',
            },
          ],
          sourceRef: { sourceNodeId: 'template-about::group::0' },
        },
      ],
      blockTree: [
        {
          kind: 'group',
          sourceRef: { sourceNodeId: 'template-about::group::0' },
          children: [
            {
              kind: 'heading',
              text: 'Some Of My Projects',
              level: 2,
              sourceRef: { sourceNodeId: 'template-about::heading::0.0' },
            },
            {
              kind: 'group',
              sourceRef: { sourceNodeId: 'template-about::group::0.1' },
              children: [
                {
                  kind: 'cover',
                  src: 'theme-asset:/assets/images/projects-2.jpg',
                  sourceRef: { sourceNodeId: 'template-about::cover::0.1.0' },
                  children: [
                    {
                      kind: 'group',
                      bgColor: '#F5B731',
                      padding: {
                        top: '5px',
                        right: '10px',
                        bottom: '5px',
                        left: '10px',
                      },
                      children: [
                        {
                          kind: 'image',
                          src: 'theme-asset:/assets/images/arrow-up.png',
                          width: 20,
                        },
                      ],
                    },
                  ],
                },
                {
                  kind: 'heading',
                  text: 'AI Based Social Networks',
                  level: 3,
                  sourceRef: { sourceNodeId: 'template-about::heading::0.1.1' },
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'resolveAsset("theme-asset:/assets/images/projects-2.jpg")',
    );
    expect(code).toContain(
      'resolveAsset("theme-asset:/assets/images/arrow-up.png")',
    );
    expect(code).toContain('width: 20');
    expect(code).toContain("padding: '5px 10px'");
    expect(code).toContain('AI Based Social Networks');
  });

  it('renders tag bindings for inferred trailing block-tree post-terms nodes', () => {
    const plan = {
      ...basePlan,
      componentName: 'SingleProduct',
      dataNeeds: ['productDetail'],
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'post-terms',
          sourceRef: {
            sourceNodeId: 'single-product::post-terms::1.1.0.1.5.0.2',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('item?.tags');
    expect(code).not.toContain('className="post-content"{styleAttr}');
    expect(code).not.toContain('className="post-excerpt"{styleAttr}');
  });

  it('uses planned post-terms taxonomy for block-centric post-terms nodes', () => {
    const plan = {
      ...basePlan,
      componentName: 'SingleProduct',
      dataNeeds: ['productDetail'],
      renderMode: 'block-centric',
      sections: [
        {
          type: 'post-content',
          showTitle: false,
          showAuthor: false,
          showDate: false,
          showCategories: false,
        },
        {
          type: 'post-terms',
          taxonomy: 'post_tag',
          layout: 'inline',
          debugKey: 'post-terms-0',
          sourceRef: {
            sourceNodeId: 'single-product::post-terms::0',
          },
        },
      ],
      blockTree: [
        {
          kind: 'post-terms',
          sourceRef: {
            sourceNodeId: 'single-product::post-terms::0',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('item?.tags');
    expect(code).not.toContain('item?.categories');
  });

  it('renders WooCommerce product query block-tree nodes from products, not posts', () => {
    const plan = {
      ...basePlan,
      componentName: 'SingleProduct',
      dataNeeds: ['productDetail', 'products'],
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'query',
          blockName: 'core/query',
          children: [
            {
              kind: 'post-template',
              blockName: 'core/post-template',
              customClassNames: ['products-block-post-template'],
              children: [
                {
                  kind: 'product-image',
                  blockName: 'woocommerce/product-image',
                },
                {
                  kind: 'product-price',
                  blockName: 'woocommerce/product-price',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'const [products, setProducts] = useState<Product[]>([]);',
    );
    expect(code).toContain('products.slice(0, 5).map((product)');
    expect(code).toContain("'/product/' + product.slug");
    expect(code).toContain('products-block-post-template');
    expect(code).not.toContain('posts.slice(0, 5).map((post)');
  });

  it('renders supported archive block trees with post templates and sidebar partials', () => {
    const plan = {
      ...basePlan,
      componentName: 'Archive',
      dataNeeds: ['posts'],
      renderMode: 'block-centric',
      sections: [],
      blockTree: [
        {
          kind: 'cover',
          src: 'theme-asset:/assets/images/banner.jpg',
          children: [{ kind: 'query-title', blockName: 'query-title' }],
        },
        {
          kind: 'columns',
          blockName: 'columns',
          children: [
            {
              kind: 'column',
              blockName: 'column',
              columnWidth: '70%',
              children: [
                {
                  kind: 'query',
                  blockName: 'query',
                  children: [
                    {
                      kind: 'post-template',
                      blockName: 'post-template',
                      customClassNames: ['wp-block-post-template'],
                      attrs: {
                        layout: { type: 'grid', minimumColumnWidth: '20rem' },
                      },
                      children: [
                        {
                          kind: 'post-featured-image',
                          blockName: 'post-featured-image',
                        },
                        {
                          kind: 'post-title',
                          blockName: 'post-title',
                          attrs: { isLink: true },
                          level: 2,
                        },
                        { kind: 'post-excerpt', blockName: 'post-excerpt' },
                      ],
                    },
                    { kind: 'query-pagination', blockName: 'query-pagination' },
                  ],
                },
              ],
            },
            {
              kind: 'column',
              blockName: 'column',
              columnWidth: '30%',
              children: [
                {
                  kind: 'template-part',
                  blockName: 'template-part',
                  templatePartSlug: 'sidebar',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("import Sidebar from '../components/Sidebar';");
    expect(code).toContain('<Sidebar />');
    expect(code).toContain('posts.map((post) => {');
    expect(code).toContain('repeat(auto-fit, minmax(20rem, 1fr))');
    expect(code).toContain(
      "<Link to={(item?.type === 'product' ? '/product/' : '/post/') + (item?.slug ?? '')}>",
    );
    expect(code).not.toContain('min(6.5rem, 8vw)');
  });

  it('renders CTA text for search sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'NotFound',
      sections: [
        {
          type: 'search',
          title: '404: Page Not Disco-vered',
          cta: {
            text: 'Go to home page',
            link: '#',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('Go to home page');
    expect(code).toContain('<form role="search"');
    expect(code).not.toContain('/api/posts');
  });

  it('does not infer pageDetail from non-detail transactional prose blocks', () => {
    const plan = {
      ...basePlan,
      componentName: 'Cart',
      dataNeeds: ['products'],
      sections: [
        {
          type: 'prose-block',
          shellVariant: 'wide',
          sourceSegments: [
            {
              type: 'heading',
              text: 'Your cart is currently empty!',
              level: 2,
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).not.toContain('useParams');
    expect(code).not.toContain('/api/pages/${slug}');
    expect(code).toContain('/api/post-types/product/posts');
  });

  it('renders CTA text for card-grid sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'NotFound',
      sections: [
        {
          type: 'card-grid',
          title: '404: Page Not Disco-vered',
          columns: 1,
          cards: [
            {
              heading: '404: Page Not Disco-vered',
              body: 'Missing page.',
            },
          ],
          cta: {
            text: 'Go to home page',
            link: '/',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('Go to home page');
    expect(code).toContain('to="/"');
  });

  it('renders media-text subtitles before the main heading/body copy', () => {
    const plan = {
      ...basePlan,
      componentName: 'FrontPage',
      sections: [
        {
          type: 'media-text',
          imageSrc: 'theme-asset:/assets/images/banner-image.png',
          imageAlt: 'Julia Henderson',
          imagePosition: 'right',
          subtitle: 'About Me',
          heading: 'Welcome To My Profile I am Julia Henderson',
          body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo.',
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('>About Me</p>');
    expect(code).toContain('>Welcome To My Profile I am Julia Henderson</h2>');
    expect(code.indexOf('>About Me</p>')).toBeLessThan(
      code.indexOf('>Welcome To My Profile I am Julia Henderson</h2>'),
    );
  });

  it('renders rich media-text headings and cover-backed image frames', () => {
    const plan = {
      ...basePlan,
      componentName: 'FrontPage',
      sections: [
        {
          type: 'media-text',
          imageSrc: 'theme-asset:/assets/images/banner-image.png',
          imageAlt: 'Julia Henderson',
          imagePosition: 'right',
          imageFit: 'contain',
          imageHeightStyle: '500px',
          imageRadius: '50% 50% 0px 0px',
          imageFrameBackgroundSrc: 'theme-asset:/assets/images/banner.jpg',
          imageFrameBackgroundPosition: '49% 37%',
          imageFrameBackground: '#F5B731',
          imageFrameMinHeight: '550px',
          imageFramePaddingStyle: '0px',
          imageFrameBorderStyle: '10px solid #2F4138',
          imageFrameCustomClassNames: ['r-cover'],
          customClassNames: ['profolio-fse-banner-wrapper', 'alignfull'],
          paddingStyle: '40px 40px 40px 40px',
          border: { radius: '8px' },
          subtitle: 'About Me',
          heading:
            'Welcome To My Profile <br>I am <mark style="background-color:transparent;color:#F5B731">Julia Henderson</mark>',
          body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo.',
          stats: [
            { value: '150+', label: 'Total Projects' },
            { value: '120+', label: 'Total Testimonials' },
            { value: '11k+', label: "User's Request" },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'className="flex-1 flex items-end justify-center overflow-hidden relative r-cover"',
    );
    expect(code).toContain('profolio-fse-banner-wrapper alignfull');
    expect(code).toContain(
      'backgroundImage: `url("${resolveAsset("theme-asset:/assets/images/banner.jpg")}")`',
    );
    expect(code).toContain("backgroundPosition: '49% 37%'");
    expect(code).toContain("backgroundColor: '#F5B731'");
    expect(code).toContain(
      '<span aria-hidden="true" className="pointer-events-none absolute inset-0 z-0"',
    );
    expect(code).toContain('className="max-w-full object-cover relative z-10"');
    expect(code).toContain("objectFit: 'contain'");
    expect(code).toContain("minHeight: '550px'");
    expect(code).toContain("padding: '0px'");
    expect(code).toContain("border: '10px solid #2F4138'");
    expect(code).toContain("padding: '40px 40px 40px 40px'");
    expect(code).toContain("borderRadius: '8px'");
    expect(code).toContain("height: '500px'");
    expect(code).toContain('150+');
    expect(code).toContain('Total Projects');
    expect(code).toContain("User's Request");
    expect(code).toContain('wp-block-group flex flex-wrap justify-start');
    expect(code).toContain(
      'renderRichTextChildren("Welcome To My Profile <br>I am <mark',
    );
    expect(code).toContain('const parseRichTextStyle = ');
    expect(code).toContain('if (style) props.style = style;');
  });

  it('resolves theme asset images inside card-grid sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'FrontPage',
      sections: [
        {
          type: 'card-grid',
          columns: 3,
          customClassNames: ['vp-skills-row'],
          cardStyle: {
            background: '#fef8ea',
            padding: '40px 20px',
            borderRadius: '10px',
            imageWidthStyle: '80px',
          },
          cards: [
            {
              heading: 'Figma',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
              customClassNames: [
                'wow',
                'animate__animated',
                'animate__fadeInUp',
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'src={resolveAsset("theme-asset:/assets/images/figma.png")}',
    );
    expect(code).toContain('wow animate__animated animate__fadeInUp');
    expect(code).toContain('lg:grid-cols-5');
    expect(code).toContain("width: '80px'");
    expect(code).toContain('h-auto object-contain mx-auto');
    expect(code).not.toContain('w-full aspect-video object-cover');
  });

  it('renders featured images for list post-list sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'BlogLeftSidebar',
      dataNeeds: ['posts'],
      sections: [
        {
          type: 'post-list',
          layout: 'list',
          showDate: true,
          showAuthor: false,
          showCategory: false,
          showExcerpt: true,
          showFeaturedImage: true,
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'post.featuredImage && <Link to={`/post/${post.slug}`} className="block"><img',
    );
  });

  it('applies source post-list featured image radius exactly', () => {
    const plan = {
      ...basePlan,
      componentName: 'Archive',
      dataNeeds: ['posts'],
      sections: [
        {
          type: 'post-list',
          layout: 'grid-3',
          showDate: false,
          showAuthor: false,
          showCategory: false,
          showExcerpt: true,
          showFeaturedImage: true,
          imageRadius: '50% 50% 0px 0px',
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('rounded-[50%_50%_0px_0px]');
    expect(code).toContain("borderRadius: '50% 50% 0px 0px'");
  });

  it('renders page content through structured rich-text nodes instead of dangerouslySetInnerHTML', () => {
    const plan = {
      ...basePlan,
      componentName: 'SamplePage',
      dataNeeds: ['page'],
      sections: [
        {
          type: 'page-content',
          showTitle: true,
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      '{renderRichTextChildren(item.content, "page-content")}',
    );
    expect(code).not.toContain(
      'dangerouslySetInnerHTML={{ __html: item.content }}',
    );
  });

  it('renders post content through structured rich-text nodes instead of dangerouslySetInnerHTML', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      dataNeeds: ['postDetail'],
      sections: [
        {
          type: 'post-content',
          showTitle: true,
          showAuthor: true,
          showDate: true,
          showCategories: true,
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      '{renderRichTextChildren(item.content, "post-content")}',
    );
    expect(code).not.toContain(
      'dangerouslySetInnerHTML={{ __html: item.content }}',
    );
  });

  it('renders block-tree single post content and comments through validator-approved contracts', () => {
    const plan = {
      ...basePlan,
      componentName: 'SinglePost',
      renderMode: 'block-centric',
      dataNeeds: ['postDetail', 'comments'],
      sections: [
        {
          type: 'post-content',
          showTitle: false,
          showAuthor: false,
          showDate: false,
          showCategories: false,
        },
        {
          type: 'comments',
          showForm: true,
          requireName: true,
          requireEmail: true,
        },
      ],
      blockTree: [
        {
          kind: 'group',
          children: [{ kind: 'post-content' }, { kind: 'post-comments-form' }],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'renderRichTextChildren(item.content, "post-content")',
    );
    expect(code).toContain('className="post-content prose max-w-none');
    expect(code).toContain('comment.content');
    expect(code).toContain('id="commentform"');
    expect(code).toContain('onSubmit={handleCommentSubmit}');
    expect(code).toContain('id="author" name="author"');
    expect(code).toContain('id="email" name="email"');
    expect(code).toContain('type="submit"');
  });

  it('keeps single post sidebar widgets inside the all-content two-column shell', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      dataNeeds: ['postDetail', 'comments', 'posts'],
      layout: {
        ...basePlan.layout,
        contentLayout: 'sidebar-right',
        sidebarScope: 'all-content',
      },
      sections: [
        {
          type: 'post-title',
          level: 1,
        },
        {
          type: 'post-content',
          showTitle: false,
          showAuthor: false,
          showDate: false,
          showCategories: false,
        },
        {
          type: 'comments',
          showForm: true,
          requireName: true,
          requireEmail: true,
        },
        {
          type: 'sidebar',
          customClassNames: ['sticky-sidebar'],
          widgetLayout: 'stacked-cards',
          widgets: [
            {
              kind: 'search',
              buttonUseIcon: true,
              buttonPosition: 'button-inside',
              cardStyle: {
                background: '#F4F4F4',
                padding: '1rem 20px',
                borderRadius: '10px',
              },
            },
            {
              kind: 'recent-posts',
              title: 'Latest Posts',
              titleLevel: 4,
              maxItems: 5,
              displayFeaturedImage: true,
              featuredImageAlign: 'left',
              featuredImageSizeWidth: 75,
              featuredImageSizeHeight: 75,
              bodyStyle: {
                fontSize: '18px',
                fontWeight: '600',
              },
              cardStyle: {
                background: '#F4F4F4',
                padding: '1rem 20px',
                borderRadius: '10px',
              },
            },
            { kind: 'categories', title: 'Categories' },
            { kind: 'tags', title: 'Tags' },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('Full Main Column With Sidebar');
    expect(code).toContain('<aside className="min-w-0">');
    expect(code).toContain('className="flex flex-col gap-6 sticky-sidebar"');
    expect(code).toContain('aria-label="Search"');
    expect(code).toContain('placeholder="Search"');
    expect(code).toContain('<svg viewBox="0 0 24 24"');
    expect(code).toContain('Latest Posts');
    expect(code).toContain(
      'renderRichTextChildren(post.excerpt ?? \'\', "sidebar-post-excerpt")',
    );
    expect(code).toContain("marginTop: 'var(--wp--preset--spacing--30)'");
    expect(code).toContain(
      '<span aria-hidden="true" className="shrink-0 text-[#666666]">&gt;</span>',
    );
    expect(code).toContain(
      "const fontSize = (0.95 + ratio * 0.45).toFixed(2) + 'rem';",
    );
    expect(code).not.toContain('{/* Sidebar */}');
  });

  it('renders profolio archive cards with linked media, meta icons, and read more buttons', () => {
    const plan = {
      ...basePlan,
      componentName: 'Archive',
      dataNeeds: ['posts'],
      sections: [
        {
          type: 'post-list',
          layout: 'grid-2',
          showDate: true,
          showAuthor: true,
          showCategory: false,
          showExcerpt: true,
          showFeaturedImage: true,
          authorIcon: 'user',
          dateIcon: 'calendar',
          showReadMore: true,
          readMoreLabel: 'Read More',
          cardStyle: {
            border: '1px solid #e0e0e0',
            borderRadius: '10px',
          },
          contentPaddingStyle:
            'var(--wp--preset--spacing--10) var(--wp--preset--spacing--10) var(--wp--preset--spacing--20) var(--wp--preset--spacing--10)',
          readMoreButtonStyle: {
            background: '#2f4138',
            color: '#ffffff',
            borderRadius: '8px',
            padding: '0.75rem 1.25rem',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      '<Link to={`/post/${post.slug}`} className="block"><img',
    );
    expect(code).toContain("border: '1px solid #e0e0e0'");
    expect(code).toContain("borderRadius: '10px'");
    expect(code).toContain(
      "padding: 'var(--wp--preset--spacing--10) var(--wp--preset--spacing--10) var(--wp--preset--spacing--20) var(--wp--preset--spacing--10)'",
    );
    expect(code).toContain('{post.author}</Link>');
    expect(code).not.toContain('by {post.author}');
    expect(code).toContain('Read More');
    expect(code).toContain('fill="currentColor"');
    expect(code).toContain('<path d="M8 2v4"></path>');
  });

  it('renders rich text sections through explicit JSX wrappers instead of dangerouslySetInnerHTML', () => {
    const plan = {
      ...basePlan,
      componentName: 'TemplateServices',
      sections: [
        {
          type: 'media-text',
          subtitle: '<strong>About</strong> Me',
          heading: 'Welcome <mark>Julia</mark>',
          body: '<em>Structured</em> body copy',
          listItems: ['<a href="/contact">Contact</a>'],
        },
        {
          type: 'tabs',
          tabs: [
            {
              label: 'Overview',
              body: '<strong>Tabbed</strong> content',
            },
          ],
        },
        {
          type: 'accordion',
          items: [
            {
              title: 'FAQ',
              body: '<em>Accordion</em> answer',
            },
          ],
        },
        {
          type: 'modal',
          triggerText: 'Open',
          body: '<strong>Modal</strong> body',
        },
        {
          type: 'prose-block',
          sourceSegments: [
            {
              kind: 'paragraph',
              html: '<strong>Paragraph</strong> text',
            },
            {
              kind: 'html',
              html: '<div><em>HTML</em> block</div>',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      '{renderRichTextChildren("<strong>About</strong> Me", "media-text-subtitle")}',
    );
    expect(code).toContain(
      '{renderRichTextChildren("<strong>Tabbed</strong> content",',
    );
    expect(code).toContain(
      '{renderRichTextChildren("<em>Accordion</em> answer",',
    );
    expect(code).toContain(
      '{renderRichTextChildren("<strong>Modal</strong> body", "modal-body")}',
    );
    expect(code).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders search widgets inside sidebar sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'BlogRightSidebar',
      sections: [
        {
          type: 'sidebar',
          widgets: [
            {
              kind: 'search',
              title: 'Search',
              placeholder: 'Search posts...',
              buttonLabel: 'Find',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('<form role="search"');
    expect(code).toContain('action="/search" method="get"');
    expect(code).toContain('name="s"');
    expect(code).toContain('Search posts...');
    expect(code).toContain('>Find</button>');
  });

  it('wires search pages to query-backed post fetching', () => {
    const plan = {
      ...basePlan,
      componentName: 'Search',
      dataNeeds: ['posts'],
      sections: [
        {
          type: 'search',
          title: 'Search Results',
          obligation: { required: ['posts'] },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      "const searchTerm = searchParams.get('q') ?? searchParams.get('s') ?? '';",
    );
    expect(code).toContain('&search=${encodeURIComponent(searchTerm)}');
    expect(code).toContain('}, [currentPage, searchTerm]);');
  });

  it('declares shared pagination state only once when posts and products are both needed', () => {
    const plan = {
      ...basePlan,
      componentName: 'ArchiveProduct',
      dataNeeds: ['posts', 'products'],
      sections: [
        {
          type: 'post-list',
          resource: 'products',
          layout: 'grid-3',
          maxItems: 9,
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code.match(/const \[searchParams, setSearchParams\]/g)).toHaveLength(
      1,
    );
    expect(code.match(/const currentPage =/g)).toHaveLength(1);
    expect(code.match(/const \[totalPages, setTotalPages\]/g)).toHaveLength(1);
  });

  it('does not infer posts for product query block trees', () => {
    const plan = {
      ...basePlan,
      componentName: 'ArchiveProduct',
      dataNeeds: ['products'],
      renderMode: 'hybrid',
      sections: [
        {
          type: 'post-list',
          resource: 'products',
          layout: 'grid-3',
          showFeaturedImage: true,
          customClassNames: ['products-block-post-template'],
        },
      ],
      blockTree: [
        {
          kind: 'query',
          blockName: 'query',
          children: [
            {
              kind: 'post-template',
              blockName: 'post-template',
              customClassNames: ['products-block-post-template'],
              children: [
                {
                  kind: 'product-image',
                  blockName: 'woocommerce/product-image',
                },
                {
                  kind: 'product-price',
                  blockName: 'woocommerce/product-price',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('/api/post-types/product/posts');
    expect(code).toContain('products-block-post-template');
    expect(code).not.toContain('/api/posts?page=');
    expect(code).not.toContain('const [posts, setPosts]');
  });

  it('renders tag widgets inside sidebar sections as archive links', () => {
    const plan = {
      ...basePlan,
      componentName: 'BlogRightSidebar',
      sections: [
        {
          type: 'sidebar',
          widgets: [
            {
              kind: 'tags',
              title: 'Tags',
              showCounts: true,
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("to={'/tag/' + slug}");
    expect(code).toContain("tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')");
    expect(code).toContain('Tags');
  });

  it('renders block-centric sidebars from the preserved block tree instead of the semantic sidebar abstraction', () => {
    const plan = {
      ...basePlan,
      componentName: 'Sidebar',
      dataNeeds: ['posts'],
      renderMode: 'block-centric',
      sections: [
        {
          type: 'sidebar',
          widgets: [
            { kind: 'search' },
            { kind: 'recent-posts', title: 'Latest Posts' },
            { kind: 'categories', title: 'Categories' },
            { kind: 'tags', title: 'Tags' },
          ],
        },
      ],
      blockTree: [
        {
          kind: 'group',
          blockName: 'group',
          customClassNames: ['sticky-sidebar'],
          children: [
            {
              kind: 'group',
              blockName: 'group',
              children: [{ kind: 'search', blockName: 'search' }],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Latest Posts' },
                { kind: 'latest-posts', blockName: 'latest-posts' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Categories' },
                { kind: 'categories', blockName: 'categories' },
              ],
            },
            {
              kind: 'group',
              blockName: 'group',
              children: [
                { kind: 'heading', blockName: 'heading', text: 'Tags' },
                { kind: 'tag-cloud', blockName: 'tag-cloud' },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('sticky-sidebar');
    expect(code).toContain('<form role="search"');
    expect(code).toContain('Latest Posts');
    expect(code).toContain('Categories');
    expect(code).toContain('Tags');
    expect(code).toContain("to={'/tag/' + slug}");
  });

  it('does not fetch shared chrome data for block-tree content widgets on page components', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'group',
          children: [
            {
              kind: 'heading',
              text: 'Latest Posts',
              level: 2,
            },
            {
              kind: 'latest-posts',
            },
            {
              kind: 'heading',
              text: 'Categories',
              level: 2,
            },
            {
              kind: 'categories',
            },
            {
              kind: 'avatar',
            },
            {
              kind: 'navigation',
              children: [
                {
                  kind: 'navigation-link',
                  text: 'About',
                  href: '/about',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("fetch('/api/posts')");
    expect(code).not.toContain("fetch('/api/site-info')");
    expect(code).not.toContain("fetch('/api/menus')");
    expect(code).toContain('Latest Posts');
    expect(code).toContain('Categories');
  });

  it('renders block-tree avatars without a siteInfo fallback', () => {
    const plan = {
      ...basePlan,
      componentName: 'Single',
      renderMode: 'hybrid',
      sections: [],
      blockTree: [
        {
          kind: 'avatar',
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("posts.find((post) => post.author)?.author ?? '?'");
    expect(code).not.toContain('siteInfo?.siteName');
  });

  it('sources deterministic navbar links from the primary menu fallback chain', () => {
    const plan = {
      ...basePlan,
      componentName: 'Header',
      sections: [
        {
          type: 'navbar',
          menuSlug: 'main-menu',
          showSiteLogo: true,
          showSiteTitle: true,
          orientation: 'horizontal',
          isResponsive: true,
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain("menu.location === 'primary'");
    expect(code).toContain("menu.slug === 'primary'");
    expect(code).toContain("menu.slug === 'main-menu'");
    expect(code).toContain('wp-block-navigation');
    expect(code).toContain('wp-block-navigation__container');
    expect(code).toContain('wp-block-navigation-item');
    expect(code).toContain('wp-block-navigation-item__content');
    expect(code).toContain('useLocation');
    expect(code).toContain('current-menu-item current_page_item');
  });

  it('renders block-centric headers from the preserved block tree instead of the semantic navbar abstraction', () => {
    const plan = {
      ...basePlan,
      componentName: 'Header',
      dataNeeds: ['siteInfo', 'menus'],
      renderMode: 'block-centric',
      sections: [
        {
          type: 'navbar',
          menuSlug: 'primary',
          showSiteLogo: false,
          showSiteTitle: true,
          orientation: 'horizontal',
          isResponsive: true,
        },
      ],
      blockTree: [
        {
          kind: 'group',
          blockName: 'group',
          domId: 'sticky-header',
          sourceRef: { sourceNodeId: 'header::group::0' },
          attrs: { layout: { type: 'constrained' } },
          padding: {
            top: '20px',
            right: '20px',
            bottom: '20px',
            left: '20px',
          },
          customClassNames: ['wp-block-group', 'has-primary-background-color'],
          children: [
            {
              kind: 'group',
              blockName: 'group',
              sourceRef: {
                sourceNodeId: 'header::group::0.0',
                parentSourceNodeId: 'header::group::0',
              },
              attrs: {
                layout: {
                  type: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                },
              },
              children: [
                {
                  kind: 'site-title',
                  blockName: 'site-title',
                },
                {
                  kind: 'navigation',
                  blockName: 'navigation',
                  menuOrientation: 'horizontal',
                  overlayMenu: 'mobile',
                  isResponsive: true,
                },
                {
                  kind: 'buttons',
                  blockName: 'buttons',
                  customClassNames: ['header-btn'],
                  children: [
                    {
                      kind: 'button',
                      blockName: 'button',
                      text: 'Get Started',
                      href: '#',
                      bgColor: '#F5B731',
                      padding: {
                        top: '10px',
                        right: '20px',
                        bottom: '10px',
                        left: '20px',
                      },
                      typography: {
                        lineHeight: '1.15',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('id="sticky-header"');
    expect(code).toContain("position: 'sticky'");
    expect(code).toContain('top: 0');
    expect(code).toContain('zIndex: 50');
    expect(code).toContain('has-primary-background-color');
    expect(code).toContain('header-btn');
    expect(code).toContain('Get Started');
    expect(code).toContain('wp-block-button__link');
    expect(code).toContain('wp-element-button');
    expect(code).toContain('whitespace-nowrap');
    expect(code).toContain("paddingTop: '10px'");
    expect(code).toContain("paddingRight: '20px'");
    expect(code).toContain("lineHeight: '1.15'");
    expect(code).toContain("borderColor: '#F5B731'");
    expect(code).not.toContain("lineHeight: '1.15px'");
    expect(code).toContain("display: 'grid'");
    expect(code).toContain("gridTemplateColumns: 'auto minmax(0, 1fr) auto'");
    expect(code).toContain("flexWrap: 'nowrap'");
    expect(code).toContain("maxWidth: '1200px'");
    expect(code).toContain("paddingLeft: '0'");
    expect(code).toContain('<Link to="/"');
  });

  it('renders source-style responsive navigation dialog for block-faithful headers', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Header',
      nodes: [
        {
          block: 'navigation',
          params: {
            icon: 'menu',
            overlayBackgroundColor: 'white-text-color',
          },
          menuOrientation: 'horizontal',
          overlayMenu: 'mobile',
          isResponsive: true,
        },
      ],
      dataNeeds: ['menus'],
      palette: basePlan.palette,
      typography: basePlan.typography,
      layout: basePlan.layout,
    });

    expect(code).not.toContain('bg-[${ctx.p.surface}]');
    expect(code).toContain(
      'wp-block-navigation__responsive-container-open md:hidden mx-auto',
    );
    expect(code).toContain(
      'wp-block-navigation__responsive-container is-menu-open has-modal-open md:hidden',
    );
    expect(code).toContain('role="dialog" aria-modal="true"');
    expect(code).toContain(
      "backgroundColor: 'var(--wp--preset--color--white-text-color, #fff)'",
    );
    expect(code).toContain("color: '#000'");
    expect(code).toContain("position: 'fixed'");
    expect(code).toContain('inset: 0');
  });

  it('does not add fallback text underlines to header navigation links', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Header',
      nodes: [
        {
          block: 'navigation',
          menuOrientation: 'horizontal',
          overlayMenu: 'mobile',
          isResponsive: true,
        },
      ],
      dataNeeds: ['menus'],
      palette: basePlan.palette,
      typography: basePlan.typography,
      layout: basePlan.layout,
    });

    expect(code).toContain('wp-block-navigation-item__content');
    expect(code).toContain('useLocation');
    expect(code).toContain('current-menu-item current_page_item');
    expect(code).toContain('vp-generated-link no-underline');
    expect(code).not.toContain('hover:underline');
    expect(code).not.toContain('hover:opacity-75');
    expect(code).not.toContain('transition-opacity');
  });

  it('emits asset and app-path helpers for deterministic footer sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'Footer',
      sections: [
        {
          type: 'footer',
          menuColumns: [],
          supplementalImages: [
            {
              src: 'theme-asset:/assets/images/arrow-up.png',
              alt: 'Back to top',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('const resolveAsset = (src: string) => {');
    expect(code).toContain('const toAppPath = (url?: string) => {');
    expect(code).toContain('const isInternalPath = (url?: string) => {');
  });

  it('renders supplemental footer images from deterministic footer sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'Footer',
      dataNeeds: ['siteInfo', 'footerLinks'],
      renderMode: 'block-centric',
      blockStyles: {
        gallery: {
          spacing: {
            margin: '0 0 min(6.5rem, 8vw) 0',
          },
        },
      },
      sections: [
        {
          type: 'footer',
          menuColumns: [],
          supplementalImages: [
            {
              src: 'theme-asset:/assets/images/arrow-up.png',
              alt: 'Back to top',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'resolveAsset("theme-asset:/assets/images/arrow-up.png")',
    );
    expect(code).toContain('Back to top');
  });

  it('renders block-centric footers from the preserved block tree instead of the semantic footer abstraction', () => {
    const plan = {
      ...basePlan,
      componentName: 'Footer',
      dataNeeds: ['siteInfo', 'footerLinks'],
      renderMode: 'block-centric',
      sections: [
        {
          type: 'footer',
          menuColumns: [],
        },
      ],
      blockTree: [
        {
          kind: 'group',
          blockName: 'group',
          customClassNames: ['pg-footer-center-row'],
          bgColor: 'base-2',
          children: [
            {
              kind: 'columns',
              blockName: 'columns',
              padding: {
                top: '80px',
                bottom: '80px',
              },
              children: [
                {
                  kind: 'column',
                  blockName: 'column',
                  columnWidth: '45%',
                  gap: 'var(--wp--preset--spacing--10)',
                  children: [
                    {
                      kind: 'heading',
                      blockName: 'heading',
                      text: "Let's Work Together",
                    },
                    {
                      kind: 'social-links',
                      blockName: 'social-links',
                      children: [
                        {
                          kind: 'social-link',
                          blockName: 'social-link',
                          text: 'Facebook',
                          attrs: { service: 'facebook', url: '#' },
                        },
                        {
                          kind: 'social-link',
                          blockName: 'social-link',
                          text: 'X',
                          attrs: { service: 'x', url: '#' },
                        },
                      ],
                    },
                  ],
                },
                {
                  kind: 'column',
                  blockName: 'column',
                  gap: 'var(--wp--preset--spacing--10)',
                  children: [
                    {
                      kind: 'image',
                      blockName: 'image',
                      src: 'theme-asset:/assets/images/arrow-up.png',
                      customClassNames: ['is-resized'],
                    },
                  ],
                },
              ],
            },
            {
              kind: 'buttons',
              blockName: 'buttons',
              children: [
                {
                  kind: 'button',
                  blockName: 'button',
                  text: 'Contact',
                  href: '#',
                },
              ],
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('pg-footer-center-row');
    expect(code).toContain('wp-block-group');
    expect(code).toContain('wp-block-columns');
    expect(code).toContain('wp-block-column');
    expect(code).toContain("display: 'flex'");
    expect(code).toContain("flexDirection: 'column'");
    expect(code).toContain("gap: 'var(--wp--preset--spacing--10)'");
    expect(code).toContain('has-base-2-background-color');
    expect(code).not.toContain("backgroundColor: 'base-2'");
    expect(code).toContain("Let's Work Together");
    expect(code).toContain('<ul className="wp-block-social-links');
    expect(code).toContain('wp-social-link-facebook');
    expect(code).toContain('fab fa-facebook-f');
    expect(code).toContain('wp-social-link-x');
    expect(code).toContain('wp-social-link-svg wp-social-link-svg-x');
    expect(code).not.toContain('fab fa-x-twitter');
    expect(code).toContain('wp-block-social-link-label sr-only');
    expect(code).toContain("paddingTop: '80px'");
    expect(code).toContain("paddingBottom: '80px'");
    expect(code).not.toContain("padding: '80px'");
    expect(code).toContain(
      '<figure className="wp-block-image size-full is-resized"',
    );
    expect(code).toContain(
      'resolveAsset("theme-asset:/assets/images/arrow-up.png")',
    );
    expect(code).toContain("width: '39px'");
    expect(code).toContain("height: 'auto'");
    expect(code).not.toContain('min(6.5rem, 8vw)');
    expect(code).toContain('Contact');
  });

  it('renders scroll-top hook markup for deterministic footer sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'Footer',
      sections: [
        {
          type: 'footer',
          menuColumns: [],
          scrollTopTriggerClassNames: ['profolio-fse-scroll-top'],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('<p className="profolio-fse-scroll-top" />');
  });

  it('does not fetch footer-links for block-faithful CTA footers that do not declare footerLinks', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Footer',
      nodes: [
        {
          block: 'group',
          children: [
            {
              block: 'heading',
              text: "Let's Work Together",
            },
            {
              block: 'paragraph',
              text: 'CTA footer body',
            },
          ],
        },
      ],
      dataNeeds: [],
      palette: basePlan.palette,
      typography: basePlan.typography,
      layout: basePlan.layout,
    });

    expect(code).not.toContain("fetch('/api/footer-links')");
    expect(code).not.toContain('footerColumns');
    expect(code).toContain("Let's Work Together");
  });

  it('emits rich-text helpers for block-faithful partials with preserved HTML', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Footer',
      nodes: [
        {
          block: 'paragraph',
          html: '<p>Developed By <a href="#">Themegrove.com</a></p>',
        },
      ],
      dataNeeds: [],
      palette: basePlan.palette,
      typography: basePlan.typography,
      layout: basePlan.layout,
    });

    expect(code).toContain('const renderRichTextChildren = ');
    expect(code).toContain(
      'renderRichTextChildren("Developed By <a href=\\"#\\">Themegrove.com</a>"',
    );
    expect(code).toContain("React.createElement(\n        'a'");
    expect(code).not.toContain('Developed By Themegrove.com');
  });

  it('preserves WordPress wrapper ids in block-faithful partial rendering', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Header',
      nodes: [
        {
          block: 'group',
          domId: 'sticky-header',
          children: [
            {
              block: 'paragraph',
              text: 'Header content',
            },
          ],
        },
      ],
      dataNeeds: [],
    });

    expect(code).toContain('<div id="sticky-header"');
  });

  it('constrains profolio-style header flex content inside the full-width header background', () => {
    const code = service.generateBlockFaithfulPartial({
      componentName: 'Header',
      nodes: [
        {
          block: 'group',
          domId: 'sticky-header',
          padding: {
            top: '20px',
            right: '20px',
            bottom: '20px',
            left: '20px',
          },
          params: {
            layout: { type: 'constrained' },
          },
          children: [
            {
              block: 'group',
              params: {
                layout: {
                  type: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                },
              },
              children: [
                { block: 'site-title' },
                { block: 'navigation' },
                { block: 'buttons', className: 'header-btn' },
              ],
            },
          ],
        },
      ],
      dataNeeds: ['siteInfo', 'menus'],
      palette: basePlan.palette,
      typography: basePlan.typography,
      layout: basePlan.layout,
    });

    expect(code).toContain("display: 'grid'");
    expect(code).toContain("gridTemplateColumns: 'auto minmax(0, 1fr) auto'");
    expect(code).toContain("flexWrap: 'nowrap'");
    expect(code).toContain("maxWidth: '1200px'");
    expect(code).toContain("marginLeft: 'auto'");
    expect(code).toContain("marginRight: 'auto'");
    expect(code).toContain("width: '100%'");
    expect(code).toContain("paddingLeft: '0'");
    expect(code).toContain("paddingRight: '0'");
    expect(code).toContain("boxSizing: 'border-box'");
  });

  it('preserves navbar domId in semantic navbar rendering', () => {
    const plan = {
      ...basePlan,
      componentName: 'Header',
      dataNeeds: ['siteInfo', 'menus'],
      sections: [
        {
          type: 'navbar',
          sticky: true,
          domId: 'sticky-header',
          menuSlug: 'primary',
          orientation: 'horizontal',
          overlayMenu: 'mobile',
          isResponsive: true,
          cta: {
            text: 'Get Started',
            link: '#',
            style: 'button',
            customClassNames: ['is-style-fill'],
          },
          ctaStyle: {
            background: '#F5B731',
            padding: '10px 20px',
          },
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain('<header id="sticky-header"');
    expect(code).toContain('wp-block-button__link');
    expect(code).toContain('wp-element-button');
    expect(code).toContain('whitespace-nowrap');
    expect(code).toContain("padding: '10px 20px'");
  });
});
