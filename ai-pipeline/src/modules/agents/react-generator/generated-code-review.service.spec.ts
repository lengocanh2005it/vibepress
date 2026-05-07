import { GeneratedCodeReviewService } from './generated-code-review.service.js';
import type { GeneratedComponent } from './react-generator.service.js';
import type { ComponentVisualPlan } from './visual-plan.schema.js';

describe('GeneratedCodeReviewService', () => {
  it('reviews source child components with their own visual plan and treats source omissions as blocking', async () => {
    const chat = jest.fn(async ({ userPrompt }: { userPrompt: string }) => {
      const isChild = userPrompt.includes(
        'componentName: FrontPageProjects',
      );
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
    const childPrompt = chat.mock.calls
      .map(([arg]) => arg.userPrompt as string)
      .find((prompt) => prompt.includes('componentName: FrontPageProjects'));

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
});
