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
