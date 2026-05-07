import { ReactGeneratorService } from './react-generator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';

describe('ReactGeneratorService shared partial renderer policy', () => {
  const service = new ReactGeneratorService(
    {} as never,
    {} as never,
    {} as never,
    new CodeGeneratorService(),
    new CodeReviewerService(
      {} as never,
      {} as never,
      {} as never,
      new CodeGeneratorService(),
      new FrameGeneratorService(),
    ),
    {} as never,
  );

  const shouldUseBlockFaithfulSharedPartial = (
    componentName: string,
    componentPlan: any,
    nodes: any[],
  ) =>
    (
      service as unknown as {
        shouldUseBlockFaithfulSharedPartial: (
          componentName: string,
          componentPlan: any,
          nodes: any[],
        ) => boolean;
      }
    ).shouldUseBlockFaithfulSharedPartial(componentName, componentPlan, nodes);

  it('keeps Header on block-faithful deterministic path even when deterministic-authority is locked', () => {
    const result = shouldUseBlockFaithfulSharedPartial(
      'Header',
      {
        type: 'partial',
        visualPlan: {
          deterministicAuthority: true,
        },
      },
      [{ block: 'core/group', kind: 'group', children: [] }],
    );

    expect(result).toBe(true);
  });

  it('keeps Footer on block-faithful deterministic path when deterministic-authority is locked', () => {
    const result = shouldUseBlockFaithfulSharedPartial(
      'Footer',
      {
        type: 'partial',
        visualPlan: {
          deterministicAuthority: true,
        },
      },
      [{ block: 'core/group', kind: 'group', children: [] }],
    );

    expect(result).toBe(true);
  });

  it('still allows Footer block-faithful rendering when deterministic-authority is not locked', () => {
    const result = shouldUseBlockFaithfulSharedPartial(
      'Footer',
      {
        type: 'partial',
        visualPlan: {
          deterministicAuthority: false,
        },
      },
      [{ block: 'core/group', kind: 'group', children: [] }],
    );

    expect(result).toBe(true);
  });

  it('does not infer footerLinks for block-faithful CTA footers without navigation evidence', () => {
    const needs = (
      service as unknown as {
        inferBlockFaithfulDataNeeds: (
          componentName: string,
          componentPlan: any,
          nodes: any[],
        ) => string[];
      }
    ).inferBlockFaithfulDataNeeds('Footer', { dataNeeds: [] }, [
      {
        block: 'core/group',
        children: [
          { block: 'core/heading', text: "Let's Work Together" },
          { block: 'core/social-links', children: [] },
          { block: 'core/paragraph', text: 'Copyright' },
        ],
      },
    ]);

    expect(needs).toEqual([]);
  });

  it('infers footerLinks for block-faithful footers with navigation evidence', () => {
    const needs = (
      service as unknown as {
        inferBlockFaithfulDataNeeds: (
          componentName: string,
          componentPlan: any,
          nodes: any[],
        ) => string[];
      }
    ).inferBlockFaithfulDataNeeds('Footer', { dataNeeds: [] }, [
      { block: 'core/navigation', children: [] },
    ]);

    expect(needs).toEqual(['footerLinks']);
  });
});

describe('ReactGeneratorService source-faithful page policy', () => {
  it('uses the built-in RuntimePage scaffold without marking it deterministic', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      {} as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'RuntimePage',
      rawSource: '',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan: {
        componentName: 'RuntimePage',
        templateName: 'runtime-page',
        type: 'page',
        route: '/page/:slug',
        dataNeeds: ['page-detail'],
        runtimeRenderer: 'runtime-page',
      },
    });

    expect(codeGenerator.generate).not.toHaveBeenCalled();
    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      name: 'RuntimePage',
      generationMode: 'ai',
      runtimeRenderer: 'runtime-page',
    });
    expect(result[0].code).toContain('export default function RuntimePage');
  });

  it('routes profolio-fse FrontPage through the normal AI generation path', async () => {
    const codeGenerator = {
      generate: jest.fn(
        () => 'export default function FrontPage(){return <main />;}',
      ),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(async () => ({
        component: {
          name: 'FrontPage',
          filePath: '',
          code: 'export default function FrontPage(){return <main data-section-assembled />;}',
          requiredCustomClassNames: ['wow'],
        },
        generationMode: 'ai',
        rawResponse:
          'export default function FrontPage(){return <main data-section-assembled />;}',
      })),
    } as unknown as CodeReviewerService;
    const styleResolver = {
      resolve: jest.fn(() => [
        {
          block: 'core/group',
          kind: 'group',
          customClassNames: ['wow'],
          children: [],
        },
      ]),
    };
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      styleResolver as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const componentPlan = {
      componentName: 'FrontPage',
      templateName: 'front-page',
      type: 'page',
      route: '/',
      dataNeeds: ['page'],
      visualPlan: {
        componentName: 'FrontPage',
        renderMode: 'block-centric',
        renderAuthority: 'deterministic-pixel',
        dataNeeds: ['page'],
        palette: {},
        typography: {},
        layout: {},
        sections: [
          {
            type: 'media-text',
            heading:
              'Welcome To My Profile <br>I am <mark>Julia Henderson</mark>',
            subtitle: 'About Me',
            body: 'Intro body',
            cta: { text: 'View my Work', link: '#' },
            imageSrc: 'theme-asset:/assets/images/banner-image.png',
            imageAlt: '',
            imagePosition: 'right',
            customClassNames: ['profolio-fse-banner-wrapper'],
          },
          {
            type: 'card-grid',
            title: 'Skills and Tools',
            subtitle: 'Skills',
            columns: 4,
            cards: [],
          },
        ],
        blockTree: [{ blockName: 'core/group' }],
      },
    } as any;
    const repoManifest = {
      themeTypeHints: {
        themeSlug: 'profolio-fse',
      },
    } as RepoThemeManifest;

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'FrontPage',
      rawSource:
        '<!-- wp:group {"className":"wow"} --><div class="wp-block-group wow"></div><!-- /wp:group -->',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan,
      repoManifest,
    });

    expect(codeGenerator.generate).not.toHaveBeenCalled();
    expect(codeReviewer.reviewComponent).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'FrontPage',
      route: '/',
      generationMode: 'ai',
      requiredCustomClassNames: ['wow'],
    });
    expect(result[0].code).toContain('data-section-assembled');
  });

  it('routes profolio-fse Footer through block-faithful partial rendering', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(
        () =>
          'export default function Footer(){return <footer data-block-faithful />;}',
      ),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      {
        resolve: jest.fn(() => [
          {
            block: 'core/group',
            kind: 'group',
            children: [],
          },
        ]),
      } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'Footer',
      rawSource:
        '<!-- wp:paragraph {"className":"profolio-fse-scroll-top"} --><p class="profolio-fse-scroll-top"></p><!-- /wp:paragraph -->',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan: {
        componentName: 'Footer',
        templateName: 'footer',
        type: 'partial',
        route: null,
        dataNeeds: [],
        visualPlan: {
          componentName: 'Footer',
          renderMode: 'block-centric',
          renderAuthority: 'deterministic-pixel',
          dataNeeds: [],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [
            {
              type: 'footer',
              menuColumns: [],
              scrollTopTriggerClassNames: ['profolio-fse-scroll-top'],
              supplementalImages: [
                { src: 'theme-asset:/assets/images/arrow-up.png' },
              ],
            },
          ],
          blockTree: [{ blockName: 'core/group' } as never],
        },
      },
      repoManifest: {
        themeTypeHints: {
          themeSlug: 'profolio-fse',
        },
      } as RepoThemeManifest,
    });

    expect(codeGenerator.generateBlockFaithfulPartial).toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      name: 'Footer',
      generationMode: 'deterministic',
    });
    expect(result[0].code).toContain('data-block-faithful');
  });

  it('routes profolio-fse block-tree listing templates through deterministic full-file generation', async () => {
    const codeGenerator = {
      generate: jest.fn(
        () => 'export default function ArchiveProduct(){return <main />;}',
      ),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      {
        resolve: jest.fn(() => [
          {
            block: 'core/query',
            kind: 'query',
            children: [],
          },
        ]),
      } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'ArchiveProduct',
      rawSource:
        '<!-- wp:query --><div class="wp-block-query"></div><!-- /wp:query -->',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan: {
        componentName: 'ArchiveProduct',
        templateName: 'archive-product',
        type: 'page',
        route: '/products',
        dataNeeds: ['products'],
        planningSourceReason: 'block-tree deterministic visual plan path',
        renderContract: {
          structure: { renderMode: 'block-tree' },
        },
        visualPlan: {
          componentName: 'ArchiveProduct',
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          dataNeeds: ['products'],
          palette: {},
          typography: {},
          layout: {},
          sections: [
            { type: 'post-list', resource: 'products', layout: 'grid-3' },
          ],
          blockTree: [{ blockName: 'core/query' }],
        },
      },
      repoManifest: {
        themeTypeHints: {
          themeSlug: 'profolio-fse',
        },
      } as RepoThemeManifest,
    });

    expect(codeGenerator.generate).toHaveBeenCalledTimes(1);
    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      name: 'ArchiveProduct',
      generationMode: 'deterministic',
      dataNeeds: ['products'],
    });
  });

  it('lets the fixer repair profolio-fse FrontPage instead of rebuilding deterministic source-faithful output', async () => {
    const codeGenerator = {
      generate: jest.fn(
        () =>
          'export default function FrontPage(){return <main data-fixed />;}',
      ),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      selfFix: jest.fn(
        async () =>
          'export default function FrontPage(){return <main data-ai-fixed />;}',
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      {} as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const plan = [
      {
        componentName: 'Header',
        templateName: 'header',
        type: 'partial',
        route: null,
      },
      {
        componentName: 'Footer',
        templateName: 'footer',
        type: 'partial',
        route: null,
      },
      {
        componentName: 'FrontPage',
        templateName: 'front-page',
        type: 'page',
        route: '/',
        dataNeeds: ['page'],
        isDetail: false,
        planningSourceReason: 'block-tree deterministic visual plan path',
        visualPlan: {
          componentName: 'FrontPage',
          renderMode: 'block-centric',
          renderAuthority: 'deterministic-pixel',
          dataNeeds: ['page'],
          palette: {},
          typography: {},
          layout: {},
          sections: [
            { type: 'navbar' },
            { type: 'media-text', heading: 'Welcome', body: 'Body' },
            { type: 'footer', menuColumns: [] },
          ],
          blockTree: [{ blockName: 'core/group' }],
          lockPolicy: { bypassAiGeneration: true, reason: 'strict' },
        },
        renderContract: {
          structure: { renderMode: 'block-tree' },
        },
      },
    ] as any;

    const fixed = await service.fixComponent({
      component: {
        name: 'FrontPage',
        filePath: '',
        code: 'export default function FrontPage(){return null;}',
        generationMode: 'deterministic',
        visualPlan: plan[2].visualPlan,
        renderContract: plan[2].renderContract,
      },
      plan,
      feedback: 'validator failed',
    });

    expect(codeGenerator.generate).not.toHaveBeenCalled();
    expect(codeReviewer.selfFix).toHaveBeenCalledTimes(1);
    expect(fixed.code).toContain('data-ai-fixed');
    expect(fixed.generationMode).toBe('deterministic');
  });

  it('lets AI fix generic block-tree pages when they are not source-faithful protected pages', async () => {
    const codeReviewer = {
      selfFix: jest.fn(
        async () =>
          'export default function Cart(){return <main data-ai-fixed />;}',
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      {} as never,
      new CodeGeneratorService(),
      codeReviewer,
      {} as never,
    );

    const fixed = await service.fixComponent({
      component: {
        name: 'Cart',
        filePath: '',
        code: 'export default function Cart(){return null;}',
        generationMode: 'deterministic',
        visualPlan: {
          componentName: 'Cart',
          renderMode: 'block-centric',
          renderAuthority: 'deterministic-structure',
          dataNeeds: ['pageDetail'],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [],
          blockTree: [{ blockName: 'core/group' } as never],
        },
        renderContract: {
          structure: { renderMode: 'block-tree' },
        } as never,
      },
      plan: [
        {
          componentName: 'Cart',
          templateName: 'cart',
          type: 'page',
          route: '/cart',
          dataNeeds: ['products'],
          isDetail: false,
          visualPlan: {
            componentName: 'Cart',
            renderMode: 'block-centric',
            renderAuthority: 'deterministic-structure',
            dataNeeds: ['pageDetail'],
            palette: {} as never,
            typography: {} as never,
            layout: {} as never,
            sections: [],
            blockTree: [{ blockName: 'core/group' } as never],
          },
          renderContract: {
            structure: { renderMode: 'block-tree' },
          } as never,
        },
      ] as any,
      feedback: 'validator failed',
    });

    expect((codeReviewer as any).selfFix).toHaveBeenCalledTimes(1);
    expect(fixed.code).toContain('data-ai-fixed');
    expect(fixed.generationMode).toBe('deterministic');
  });

  it('syncs attached visual plan contract back to planner-approved data needs and fixed slug', () => {
    const service = new ReactGeneratorService(
      {} as never,
      {} as never,
      {} as never,
      new CodeGeneratorService(),
      new CodeReviewerService(
        {} as never,
        {} as never,
        {} as never,
        new CodeGeneratorService(),
        new FrameGeneratorService(),
      ),
      {} as never,
    );

    const attached = (
      service as unknown as {
        attachPlanContext: (component: any, componentPlan: any) => any;
      }
    ).attachPlanContext(
      {
        name: 'TemplateAbout',
        filePath: '',
        code: 'export default function TemplateAbout(){return null;}',
        visualPlan: {
          componentName: 'TemplateAbout',
          dataNeeds: ['posts'],
          palette: {} as never,
          typography: {} as never,
          layout: {} as never,
          sections: [],
        },
      },
      {
        componentName: 'TemplateAbout',
        route: '/page/about',
        fixedSlug: 'about',
        fixedTitle: 'About',
        fixedPageId: 12,
        dataNeeds: ['page-detail'],
      },
    );

    expect(attached.visualPlan.dataNeeds).toEqual(['pageDetail']);
    expect(attached.visualPlan.pageBinding).toMatchObject({
      slug: 'about',
      title: 'About',
      id: 12,
      route: '/page/about',
    });
  });
});
