import { GeneratedCodeReviewService } from './generated-code-review.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { ComponentVisualPlan } from './visual-plan.schema.js';

describe('GeneratedCodeReviewService', () => {
  it('reviews source child components with their own visual plan and treats source omissions as blocking', async () => {
    const chat = jest.fn(async ({ userPrompt }: { userPrompt: string }) => {
      const isChild = userPrompt.includes('componentName: FrontPageProjects');
      return {
        text: JSON.stringify(
          isChild
            ? {
                pass: false,
                issues: [
                  {
                    severity: 'high',
                    message:
                      'obviously omits an important approved section: missing project cards',
                  },
                ],
                summary: 'Child dropped source-backed project content.',
              }
            : { pass: true, issues: [], summary: 'ok' },
        ),
        inputTokens: 10,
        outputTokens: 5,
      };
    });
    const service = new GeneratedCodeReviewService({
      getModel: jest.fn(() => 'gpt-test'),
      chat,
    } as never);

    const childVisualPlan: ComponentVisualPlan = {
      componentName: 'FrontPageProjects',
      palette: {} as never,
      typography: {} as never,
      layout: { includes: [] } as never,
      dataNeeds: ['posts'],
      sections: [
        {
          type: 'card-grid',
          title: 'My Projects',
          cards: [
            {
              heading: 'AI Based Social Networks',
              body: 'Design of a mobile app develops',
            },
          ],
        } as never,
      ],
      blockTree: [
        {
          kind: 'group',
          blockName: 'core/group',
          sourceRef: { sourceNodeId: 'front-page::group::projects' },
          children: [],
        },
      ] as never,
    };
    const components: GeneratedComponent[] = [
      {
        name: 'FrontPage',
        filePath: '',
        route: '/',
        type: 'page',
        generationMode: 'deterministic',
        code: `
          import FrontPageProjects from '../components/FrontPageProjects';

          export default function FrontPage() {
            return <main><FrontPageProjects posts={[]} /></main>;
          }
        `,
      },
      {
        name: 'FrontPageProjects',
        filePath: '',
        type: 'partial',
        isSubComponent: true,
        generationMode: 'ai',
        dataNeeds: ['posts'],
        visualPlan: childVisualPlan,
        code: `
          export default function FrontPageProjects() {
            return <section><h2>Projects</h2></section>;
          }
        `,
      },
    ];

    const result = await service.review({
      components,
      plan: [
        {
          componentName: 'FrontPage',
          route: '/',
          type: 'page',
          dataNeeds: [],
          isDetail: false,
          description: 'Front page',
        },
      ] as never,
      modelName: 'gpt-test',
      mode: 'blocking',
    });

    expect(chat).toHaveBeenCalledTimes(2);
    const parentPrompt = chat.mock.calls
      .map(([arg]) => arg.userPrompt as string)
      .find((prompt) => prompt.includes('componentName: FrontPage'));
    const childPrompt = chat.mock.calls
      .map(([arg]) => arg.userPrompt as string)
      .find((prompt) => prompt.includes('componentName: FrontPageProjects'));

    expect(parentPrompt).toContain(
      "import FrontPageProjects from '../components/FrontPageProjects';",
    );
    expect(parentPrompt).not.toContain('Imported generated subcomponent');
    expect(parentPrompt).not.toContain(
      'export default function FrontPageProjects',
    );
    expect(childPrompt).toContain('dataNeeds describe props supplied');
    expect(childPrompt).toContain('card-grid title="My Projects"');
    expect(childPrompt).toContain('AI Based Social Networks');
    expect(childPrompt).toContain('sourceNodeId=front-page::group::projects');
    expect(result.failures).toEqual([
      {
        componentName: 'FrontPageProjects',
        message:
          '[high] obviously omits an important approved section: missing project cards',
      },
    ]);
  });

  it('treats raw theme-asset background review findings as blocking', async () => {
    const chat = jest.fn(async () => ({
      text: JSON.stringify({
        pass: false,
        issues: [
          {
            severity: 'high',
            message:
              'Project card cover backgrounds use the raw `theme-asset:/assets/images/projects-1.jpg` string in `backgroundImage` instead of resolving it to a real asset URL. This will prevent the approved project images from rendering.',
          },
        ],
        summary: 'Raw theme asset URL.',
      }),
      inputTokens: 10,
      outputTokens: 5,
    }));
    const service = new GeneratedCodeReviewService({
      getModel: jest.fn(() => 'gpt-test'),
      chat,
    } as never);

    const result = await service.review({
      components: [
        {
          name: 'FrontPageProjects',
          filePath: '',
          type: 'partial',
          isSubComponent: true,
          generationMode: 'ai',
          code: `export default function FrontPageProjects() { return <div />; }`,
        },
      ] as GeneratedComponent[],
      plan: [] as never,
      modelName: 'gpt-test',
      mode: 'blocking',
    });

    expect(result.success).toBe(false);
    expect(result.failures[0]?.componentName).toBe('FrontPageProjects');
  });

  it('treats source-backed readiness gates and layout redesign findings as blocking', async () => {
    const chat = jest.fn(async () => ({
      text: JSON.stringify({
        pass: false,
        issues: [
          {
            severity: 'high',
            message:
              'Component adds unnecessary client-only state/useEffect gating (`isReady`) and returns `null` on first render.',
          },
          {
            severity: 'high',
            message:
              'Component materially redesigns the approved WordPress layout by introducing custom project card presentation.',
          },
          {
            severity: 'high',
            message:
              'Approved hierarchy includes an actual nested image element inside the cover, but the generated component replaces this with CSS `backgroundImage`.',
          },
        ],
        summary: 'Source-backed section was redesigned.',
      }),
      inputTokens: 10,
      outputTokens: 5,
    }));
    const service = new GeneratedCodeReviewService({
      getModel: jest.fn(() => 'gpt-test'),
      chat,
    } as never);

    const result = await service.review({
      components: [
        {
          name: 'FrontPageProjects',
          filePath: '',
          type: 'partial',
          isSubComponent: true,
          generationMode: 'ai',
          code: `export default function FrontPageProjects() { return null; }`,
        },
      ] as GeneratedComponent[],
      plan: [] as never,
      modelName: 'gpt-test',
      mode: 'blocking',
    });

    expect(result.success).toBe(false);
    expect(result.failures[0]?.componentName).toBe('FrontPageProjects');
    expect(result.failures[0]?.message).toContain(
      'unnecessary client-only state/useEffect gating',
    );
  });
});
