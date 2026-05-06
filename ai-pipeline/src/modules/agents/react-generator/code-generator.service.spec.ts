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
          imageRadius: '50% 50% 0px 0px',
          imageFrameBackground: '#F5B731',
          imageFrameMinHeight: '550px',
          imageFrameCustomClassNames: ['r-cover'],
          subtitle: 'About Me',
          heading:
            'Welcome To My Profile <br>I am <mark style="background-color:transparent;color:#F5B731">Julia Henderson</mark>',
          body: 'Mattis pellentesque ex phasellus amet nulla aliquam commodo.',
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'className="flex-1 flex items-end justify-center overflow-hidden r-cover"',
    );
    expect(code).toContain("backgroundColor: '#F5B731'");
    expect(code).toContain("minHeight: '550px'");
    expect(code).toContain(
      'renderRichTextChildren("Welcome To My Profile <br>I am <mark',
    );
  });

  it('resolves theme asset images inside card-grid sections', () => {
    const plan = {
      ...basePlan,
      componentName: 'FrontPage',
      sections: [
        {
          type: 'card-grid',
          columns: 3,
          cards: [
            {
              heading: 'Figma',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
            },
          ],
        },
      ],
    } as ComponentVisualPlan;

    const code = service.generate(plan);

    expect(code).toContain(
      'src={resolveAsset("theme-asset:/assets/images/figma.png")}',
    );
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

    expect(code).toContain('post.featuredImage && <img');
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
    expect(code).toContain('Search posts...');
    expect(code).toContain('>Find</button>');
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
          customClassNames: ['wp-block-group', 'has-primary-background-color'],
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
    expect(code).toContain('<Link to="/"');
  });

  it('uses inline background color for responsive block-faithful mobile nav panels', () => {
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

    expect(code).not.toContain('bg-[${ctx.p.surface}]');
    expect(code).toContain("backgroundColor: '#f5f5f5'");
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
    expect(code).not.toContain('hover:underline');
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
                  href: '#',
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
    expect(code).toContain("Let's Work Together");
    expect(code).toContain('Facebook');
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
});
