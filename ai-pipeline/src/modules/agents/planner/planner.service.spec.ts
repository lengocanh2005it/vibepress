import { ConfigService } from '@nestjs/config';
import { PlannerService } from './planner.service.js';
import type { PlanResult } from './planner.service.js';

describe('PlannerService shared chrome visual plans', () => {
  const service = new PlannerService(
    { getModel: () => 'test-model' } as any,
    { get: () => undefined } as ConfigService,
    {} as any,
    {} as any,
    { scopeRequestToComponent: () => undefined } as any,
    {} as any,
    {
      prefersBlockTreeSharedChrome: (themeSlug?: string | null) =>
        themeSlug === 'profolio-fse',
    } as any,
  );

  it('precomputes deterministic visual plans for shared chrome partials before full visual planning', async () => {
    const theme = {
      type: 'fse',
      templates: [],
      parts: [
        {
          name: 'footer',
          html: '<!-- wp:group --><div></div><!-- /wp:group -->',
        },
      ],
      tokens: undefined,
    } as any;

    const content = {
      menus: [],
      posts: [],
      pages: [],
    } as any;

    const plan: PlanResult = [
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
        description: 'Shared footer partial',
      },
      {
        templateName: 'index',
        componentName: 'Index',
        type: 'page',
        route: '/',
        dataNeeds: ['posts'],
        isDetail: false,
        description: 'Blog index page',
      },
    ];
    const visualizedFooter = {
      ...plan[0],
      visualPlan: {
        componentName: 'Footer',
        renderMode: 'block-centric',
        sections: [{ type: 'footer' }],
      },
    };
    const generateVisualPlanSpy = jest
      .spyOn<any, any>(service as any, 'generateVisualPlanForComponent')
      .mockResolvedValue(visualizedFooter);

    const reviewed = await service.attachSharedChromePartialVisualPlans(
      theme,
      content,
      plan,
      'test-model',
    );

    expect(reviewed[0].visualPlan).toBeDefined();
    expect(reviewed[0].visualPlan?.renderMode).toBe('block-centric');
    expect(reviewed[0].visualPlan?.sections[0]?.type).toBe('footer');
    expect(reviewed[1].visualPlan).toBeUndefined();
    expect(generateVisualPlanSpy).toHaveBeenCalledTimes(1);
    expect(generateVisualPlanSpy.mock.calls[0][0]).toMatchObject({
      componentName: 'Footer',
      type: 'partial',
    });
  });

  it('skips legacy semantic footer stubs when profolio-fse already has draft block-tree chrome', () => {
    const visualPlan = (
      service as any
    ).buildDeterministicVisualPlanForComponent(
      {
        templateName: 'footer',
        componentName: 'Footer',
        type: 'partial',
        route: null,
        dataNeeds: ['site-info', 'footer-links'],
        isDetail: false,
        description: 'Shared footer partial',
        draftBlockTree: [
          {
            kind: 'group',
            blockName: 'group',
          },
        ],
      },
      {
        siteInfo: {
          activeTheme: 'profolio-fse',
        },
        menus: [],
        posts: [],
        pages: [],
      },
      undefined,
      {
        background: '#fff',
        surface: '#fff',
        text: '#111',
        textMuted: '#666',
        accent: '#000',
        accentText: '#fff',
        dark: '#000',
        darkText: '#fff',
      },
      {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded',
      },
      [],
    );

    expect(visualPlan).toBeUndefined();
  });
});
