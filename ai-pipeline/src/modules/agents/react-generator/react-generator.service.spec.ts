import { ReactGeneratorService } from './react-generator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import type { PlanResult } from '../planner/planner.service.js';

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
            customClassNames: ['profolio-fse-banner-wrapper', 'alignfull'],
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

  it('can compose profolio-fse FrontPage from source-bound child components', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
      reviewSection: jest.fn(
        async ({ sectionName }: { sectionName: string }) => ({
          name: sectionName,
          filePath: '',
          code: `export default function ${sectionName}(){return <section>${sectionName}</section>;}`,
          isSubComponent: true,
        }),
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const componentPlan = {
      componentName: 'FrontPage',
      templateName: 'front-page',
      type: 'page',
      route: '/',
      dataNeeds: [],
      isDetail: false,
      description: 'Home',
      visualPlan: {
        componentName: 'FrontPage',
        renderMode: 'hybrid',
        dataNeeds: [],
        palette: {} as never,
        typography: {} as never,
        layout: {} as never,
        sections: [
          {
            type: 'media-text',
            heading: 'Hero',
            sourceRef: { sourceNodeId: 'front-page::columns::0.0' },
          },
          {
            type: 'card-grid',
            title: 'My Projects',
            sourceRef: { sourceNodeId: 'front-page::group::1.0.1' },
          },
          {
            type: 'post-list',
            title: 'Latest Work',
            sourceRef: { sourceNodeId: 'front-page::group::1.0.2' },
          },
          {
            type: 'media-text',
            heading: 'UI/UX Design',
            sourceRef: { sourceNodeId: 'front-page::columns::1.1.1.0' },
          },
          {
            type: 'media-text',
            heading: 'Lead Product and Designer and Art Director',
            sourceRef: {
              sourceNodeId: 'front-page::columns::1.2.0',
              parentSourceNodeId: 'front-page::group::1.2',
            },
            paddingStyle: '0 0px',
            presentation: {
              contentAlign: 'center',
              textAlign: 'center',
              itemsAlign: 'center',
              justify: 'center',
            },
          },
        ],
        blockTree: [
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: { sourceNodeId: 'front-page::group::0' },
            children: [
              {
                kind: 'heading',
                blockName: 'core/heading',
                sourceRef: {
                  sourceNodeId: 'front-page::heading::0.0.0.1',
                },
                html: 'Welcome To My Profile <br>I am <mark>Julia Henderson</mark>',
              },
              {
                kind: 'social-links',
                blockName: 'core/social-links',
                sourceRef: {
                  sourceNodeId: 'front-page::social-links::0.0.0.4',
                },
                children: [
                  {
                    kind: 'social-link',
                    blockName: 'core/social-link',
                    attrs: { service: 'facebook', url: '#' },
                  },
                ],
              },
              {
                kind: 'image',
                blockName: 'core/image',
                sourceRef: {
                  sourceNodeId: 'front-page::image::0.0.1.0.0.0',
                },
                src: 'theme-asset:/assets/images/banner-image.png',
              },
            ],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: { sourceNodeId: 'front-page::group::1' },
            children: [
              {
                kind: 'group',
                blockName: 'core/group',
                sourceRef: { sourceNodeId: 'front-page::group::1.0' },
                attrs: { metadata: { name: 'Projects' } },
                textAlign: 'center',
                children: [
                  {
                    kind: 'group',
                    blockName: 'core/group',
                    sourceRef: {
                      sourceNodeId: 'front-page::group::1.0.1',
                    },
                    children: [
                      {
                        kind: 'group',
                        blockName: 'core/group',
                        sourceRef: {
                          sourceNodeId: 'front-page::group::1.0.1.0',
                        },
                        children: [
                          {
                            kind: 'cover',
                            blockName: 'core/cover',
                            sourceRef: {
                              sourceNodeId: 'front-page::cover::1.0.1.0.0',
                            },
                            children: [
                              {
                                kind: 'group',
                                blockName: 'core/group',
                                sourceRef: {
                                  sourceNodeId:
                                    'front-page::group::1.0.1.0.0.0',
                                },
                                children: [
                                  {
                                    kind: 'group',
                                    blockName: 'core/group',
                                    sourceRef: {
                                      sourceNodeId:
                                        'front-page::group::1.0.1.0.0.0.0',
                                    },
                                    bgColor: '#F5B731',
                                    children: [
                                      {
                                        kind: 'image',
                                        blockName: 'core/image',
                                        sourceRef: {
                                          sourceNodeId:
                                            'front-page::image::1.0.1.0.0.0.0.0',
                                        },
                                        src: 'theme-asset:/assets/images/arrow-up.png',
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                          {
                            kind: 'heading',
                            blockName: 'core/heading',
                            sourceRef: {
                              sourceNodeId: 'front-page::heading::1.0.1.0.1',
                            },
                            text: 'Design of a mobile app develops',
                          },
                          {
                            kind: 'paragraph',
                            blockName: 'core/paragraph',
                            sourceRef: {
                              sourceNodeId: 'front-page::paragraph::1.0.1.0.2',
                            },
                            text: 'Project body',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'group',
                blockName: 'core/group',
                sourceRef: { sourceNodeId: 'front-page::group::1.1' },
                attrs: { metadata: { name: 'Services' } },
                children: [
                  {
                    kind: 'group',
                    blockName: 'core/group',
                    sourceRef: {
                      sourceNodeId: 'front-page::group::1.1.1',
                    },
                    children: [
                      {
                        kind: 'columns',
                        blockName: 'core/columns',
                        sourceRef: {
                          sourceNodeId: 'front-page::columns::1.1.1.0',
                        },
                        padding: {
                          top: '40px',
                          right: '40px',
                          bottom: '40px',
                          left: '40px',
                        },
                        children: [
                          {
                            kind: 'column',
                            blockName: 'core/column',
                            sourceRef: {
                              sourceNodeId: 'front-page::column::1.1.1.0.0',
                            },
                            children: [
                              {
                                kind: 'group',
                                blockName: 'core/group',
                                sourceRef: {
                                  sourceNodeId:
                                    'front-page::group::1.1.1.0.0.0',
                                },
                                padding: {
                                  top: '0px',
                                  right: '0px',
                                  bottom: '0px',
                                  left: '0px',
                                },
                                children: [
                                  {
                                    kind: 'heading',
                                    blockName: 'core/heading',
                                    sourceRef: {
                                      sourceNodeId:
                                        'front-page::heading::1.1.1.0.0.0.0',
                                    },
                                    text: 'UI/UX Design',
                                  },
                                ],
                              },
                            ],
                          },
                          {
                            kind: 'column',
                            blockName: 'core/column',
                            sourceRef: {
                              sourceNodeId: 'front-page::column::1.1.1.0.1',
                            },
                            children: [
                              {
                                kind: 'cover',
                                blockName: 'core/cover',
                                sourceRef: {
                                  sourceNodeId:
                                    'front-page::cover::1.1.1.0.1.0',
                                },
                                customClassNames: [
                                  'r-cover',
                                  'is-style-outline',
                                ],
                                src: 'theme-asset:/assets/images/projects-1.jpg',
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'group',
                blockName: 'core/group',
                sourceRef: { sourceNodeId: 'front-page::group::1.2' },
                attrs: { metadata: { name: 'Experience' } },
                textAlign: 'center',
                padding: {
                  top: '80px',
                  right: '20px',
                  bottom: '80px',
                  left: '20px',
                },
                margin: {
                  top: '0px',
                  bottom: '0px',
                },
                children: [
                  {
                    kind: 'columns',
                    blockName: 'core/columns',
                    sourceRef: {
                      sourceNodeId: 'front-page::columns::1.2.0',
                    },
                    textAlign: 'center',
                    children: [
                      {
                        kind: 'column',
                        blockName: 'core/column',
                        sourceRef: {
                          sourceNodeId: 'front-page::column::1.2.0.0',
                        },
                        children: [
                          {
                            kind: 'cover',
                            blockName: 'core/cover',
                            sourceRef: {
                              sourceNodeId: 'front-page::cover::1.2.0.0.0',
                            },
                            src: 'theme-asset:/assets/images/experience.jpg',
                            overlayColor: '#2F4138',
                          },
                        ],
                      },
                      {
                        kind: 'column',
                        blockName: 'core/column',
                        sourceRef: {
                          sourceNodeId: 'front-page::column::1.2.0.1',
                        },
                        customClassNames: [
                          'wow',
                          'animate__animated',
                          'animate__fadeInUp',
                          'cover-inner',
                        ],
                        children: [
                          {
                            kind: 'paragraph',
                            blockName: 'core/paragraph',
                            sourceRef: {
                              sourceNodeId: 'front-page::paragraph::1.2.0.1.0',
                            },
                            text: 'Welcome to my profile',
                          },
                          {
                            kind: 'heading',
                            blockName: 'core/heading',
                            sourceRef: {
                              sourceNodeId: 'front-page::heading::1.2.0.1.1',
                            },
                            text: 'Lead Product and Designer and Art Director',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'group',
                blockName: 'core/group',
                sourceRef: { sourceNodeId: 'front-page::group::1.3' },
                attrs: { metadata: { name: 'Skills' } },
                children: [
                  {
                    kind: 'group',
                    blockName: 'core/group',
                    sourceRef: {
                      sourceNodeId: 'front-page::group::1.3.1',
                    },
                    children: [
                      {
                        kind: 'group',
                        blockName: 'core/group',
                        sourceRef: {
                          sourceNodeId: 'front-page::group::1.3.1.0',
                        },
                        children: [
                          {
                            kind: 'image',
                            blockName: 'core/image',
                            sourceRef: {
                              sourceNodeId: 'front-page::image::1.3.1.0.0',
                            },
                            src: 'theme-asset:/assets/images/figma.png',
                          },
                        ],
                      },
                      {
                        kind: 'group',
                        blockName: 'core/group',
                        sourceRef: {
                          sourceNodeId: 'front-page::group::1.3.1.1',
                        },
                        children: [
                          {
                            kind: 'image',
                            blockName: 'core/image',
                            sourceRef: {
                              sourceNodeId: 'front-page::image::1.3.1.1.0',
                            },
                            src: 'theme-asset:/assets/images/photoshop.png',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    } as any;

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'FrontPage',
      rawSource: '',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan,
      repoManifest: {
        themeTypeHints: { themeSlug: 'profolio-fse' },
      } as RepoThemeManifest,
    });

    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(codeReviewer.reviewSection).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({
      name: 'FrontPage',
      route: '/',
      generationMode: 'deterministic',
    });
    expect(result[0].requiredCustomClassNames).not.toContain(
      'is-style-logos-only',
    );
    expect(result[0].code).toContain(
      "import FrontPageProjects from '../components/FrontPageProjects';",
    );
    expect(result[0].code).toContain("fetch('/api/posts')");
    expect(result[0].code).toContain(
      '<FrontPageProjects posts={posts} loading={loading} error={error} />',
    );
    expect(result[0].code).toContain('<FrontPageSkills />');
    const bannerInput = (codeReviewer.reviewSection as jest.Mock).mock
      .calls[0][0] as { nodesJson: string };
    expect(bannerInput.nodesJson).not.toContain('social-links');
    expect(bannerInput.nodesJson).not.toContain('facebook');
    expect(bannerInput.nodesJson).toContain(
      'style=\\"background-color:rgba(0,0,0,0);color:#F5B731\\"',
    );
    expect(bannerInput.nodesJson).toContain('profolio-fse-banner-image');
    expect(bannerInput.nodesJson).toContain('aligncenter');
    const projectsInput = (
      codeReviewer.reviewSection as jest.Mock
    ).mock.calls.find(
      ([call]) => call.sectionName === 'FrontPageProjects',
    )?.[0] as { nodesJson: string };
    expect(projectsInput.nodesJson).toContain('profolio-fse-projects-wrapper');
    expect(projectsInput.nodesJson).toContain('profolio-fse-project-card');
    expect(projectsInput.nodesJson).toContain('profolio-fse-project-arrow');
    expect(projectsInput.nodesJson).toContain('"textAlign": "left"');
    const servicesInput = (
      codeReviewer.reviewSection as jest.Mock
    ).mock.calls.find(
      ([call]) => call.sectionName === 'FrontPageServices',
    )?.[0] as { nodesJson: string };
    expect(servicesInput.nodesJson).toContain('profolio-fse-services-wrapper');
    expect(servicesInput.nodesJson).not.toContain('"alignfull"');
    expect(servicesInput.nodesJson).toContain('profolio-fse-services-stack');
    expect(servicesInput.nodesJson).toContain('profolio-fse-service-card');
    expect(servicesInput.nodesJson).toContain('profolio-fse-service-card-copy');
    expect(servicesInput.nodesJson).toContain(
      'profolio-fse-service-card-media',
    );
    expect(servicesInput.nodesJson).toContain('"top": "48px"');
    expect(servicesInput.nodesJson).toContain('"bottom": "24px"');
    const experienceInput = (
      codeReviewer.reviewSection as jest.Mock
    ).mock.calls.find(
      ([call]) => call.sectionName === 'FrontPageExperience',
    )?.[0] as { nodesJson: string; componentPlan: PlanResult[number] };
    expect(experienceInput.nodesJson).toContain(
      'profolio-fse-experience-wrapper',
    );
    expect(experienceInput.nodesJson).toContain(
      'profolio-fse-experience-image',
    );
    expect(experienceInput.nodesJson).toContain('profolio-fse-experience-copy');
    expect(experienceInput.nodesJson).toContain('"top": "80px"');
    const experienceChildPlan = experienceInput.componentPlan;
    expect(experienceChildPlan.visualPlan?.sections[0]).toMatchObject({
      paddingStyle: '80px 20px 80px 20px',
      marginStyle: '0px 0px 0px 0px',
      customClassNames: expect.arrayContaining([
        'profolio-fse-experience-wrapper',
        'alignfull',
      ]),
      presentation: {
        contentAlign: 'left',
        textAlign: 'left',
        itemsAlign: 'start',
        justify: 'start',
      },
    });
    expect(experienceInput.nodesJson).not.toContain('"overlayColor"');
    expect(experienceInput.nodesJson).toContain('"textAlign": "left"');
    const skillsInput = (
      codeReviewer.reviewSection as jest.Mock
    ).mock.calls.find(
      ([call]) => call.sectionName === 'FrontPageSkills',
    )?.[0] as { nodesJson: string };
    expect(skillsInput.nodesJson).toContain('profolio-fse-skills-wrapper');
    expect(skillsInput.nodesJson).toContain('profolio-fse-skills-grid');
    expect(skillsInput.nodesJson).toContain('profolio-fse-skill-card');
    expect(skillsInput.nodesJson).toContain('profolio-fse-skill-icon');
    expect(skillsInput.nodesJson).toContain('animate__delay-1s');
    expect(result.slice(1).every((component) => component.isSubComponent)).toBe(
      true,
    );
    expect(
      result.find((component) => component.name === 'FrontPageProjects')
        ?.visualPlan?.sections,
    ).toHaveLength(2);
    expect(
      result.find((component) => component.name === 'FrontPageServices')
        ?.visualPlan?.sections,
    ).toHaveLength(1);
    expect(
      result.find((component) => component.name === 'FrontPageProjects')
        ?.dataNeeds,
    ).toEqual(['posts']);
    expect(codeReviewer.reviewSection).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionName: 'FrontPageProjects',
        componentPlan: expect.objectContaining({
          dataNeeds: ['posts'],
          visualPlan: expect.objectContaining({ dataNeeds: ['posts'] }),
        }),
      }),
    );
  });

  it('composes profolio-fse template pages from generic source-bound child components', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
      reviewSection: jest.fn(
        async ({ sectionName }: { sectionName: string }) => ({
          name: sectionName,
          filePath: '',
          code: `export default function ${sectionName}(){return <section>${sectionName}</section>;}`,
          isSubComponent: true,
        }),
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const componentPlan = {
      componentName: 'TemplateAbout',
      templateName: 'template-about',
      type: 'page',
      route: '/about',
      dataNeeds: [],
      isDetail: false,
      description: 'About',
      visualPlan: {
        componentName: 'TemplateAbout',
        renderMode: 'hybrid',
        dataNeeds: [],
        palette: {} as never,
        typography: {} as never,
        layout: {} as never,
        sections: [
          {
            type: 'cover',
            heading: 'About Me',
            sourceRef: {
              sourceNodeId: 'template-about::cover::0.0',
              parentSourceNodeId: 'template-about::group::0',
            },
          },
          {
            type: 'media-text',
            heading: 'My Experience',
            sourceRef: {
              sourceNodeId: 'template-about::columns::1.0',
              parentSourceNodeId: 'template-about::group::1',
            },
          },
        ],
        blockTree: [
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: { sourceNodeId: 'template-about::group::0' },
            children: [
              {
                kind: 'cover',
                blockName: 'core/cover',
                sourceRef: { sourceNodeId: 'template-about::cover::0.0' },
                children: [],
              },
            ],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: { sourceNodeId: 'template-about::group::1' },
            children: [
              {
                kind: 'columns',
                blockName: 'core/columns',
                sourceRef: { sourceNodeId: 'template-about::columns::1.0' },
                children: [],
              },
            ],
          },
        ],
      },
    } as any;

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'TemplateAbout',
      rawSource: '',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan,
      repoManifest: {
        themeTypeHints: { themeSlug: 'profolio-fse' },
      } as RepoThemeManifest,
    });

    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(codeReviewer.reviewSection).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      name: 'TemplateAbout',
      route: '/about',
      generationMode: 'deterministic',
    });
    expect(result[0].code).toContain(
      "import TemplateAboutAboutMe from '../components/TemplateAboutAboutMe';",
    );
    expect(result[0].code).toContain('<TemplateAboutAboutMe />');
    expect(result.slice(1).every((component) => component.isSubComponent)).toBe(
      true,
    );
    expect(result.map((component) => component.name)).toEqual([
      'TemplateAbout',
      'TemplateAboutAboutMe',
      'TemplateAboutMyExperience',
    ]);
  });

  it('keeps profolio-fse service sections in separate child components and adds uncovered top-level blocks', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
      reviewSection: jest.fn(
        async ({ sectionName }: { sectionName: string }) => ({
          name: sectionName,
          filePath: '',
          code: `export default function ${sectionName}(){return <section>${sectionName}</section>;}`,
          isSubComponent: true,
        }),
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const componentPlan = {
      componentName: 'TemplateServices',
      templateName: 'template-services',
      type: 'page',
      route: '/services',
      dataNeeds: [],
      isDetail: false,
      description: 'Services',
      visualPlan: {
        componentName: 'TemplateServices',
        renderMode: 'hybrid',
        dataNeeds: [],
        palette: {} as never,
        typography: {} as never,
        layout: {} as never,
        sections: [
          {
            type: 'media-text',
            heading: 'UI/UX Design',
            sourceRef: {
              sourceNodeId: 'template-services::columns::0.1.0',
              parentSourceNodeId: 'template-services::group::0.1',
            },
          },
          {
            type: 'media-text',
            heading: 'Graphic Design',
            sourceRef: {
              sourceNodeId: 'template-services::columns::0.1.1',
              parentSourceNodeId: 'template-services::group::0.1',
            },
          },
          {
            type: 'media-text',
            heading: 'Product Design',
            sourceRef: {
              sourceNodeId: 'template-services::columns::0.1.2',
              parentSourceNodeId: 'template-services::group::0.1',
            },
          },
          {
            type: 'accordion',
            items: [{ heading: 'Question', body: 'Answer' }],
            sourceRef: {
              sourceNodeId: 'template-services::group::2.0',
              parentSourceNodeId: 'template-services::group::2',
            },
          },
        ],
        blockTree: [
          {
            kind: 'group',
            blockName: 'core/group',
            sourceRef: { sourceNodeId: 'template-services::group::0' },
            children: [
              {
                kind: 'group',
                blockName: 'core/group',
                sourceRef: { sourceNodeId: 'template-services::group::0.1' },
                children: [
                  {
                    kind: 'columns',
                    blockName: 'core/columns',
                    sourceRef: {
                      sourceNodeId: 'template-services::columns::0.1.0',
                    },
                    children: [],
                  },
                  {
                    kind: 'columns',
                    blockName: 'core/columns',
                    sourceRef: {
                      sourceNodeId: 'template-services::columns::0.1.1',
                    },
                    children: [],
                  },
                  {
                    kind: 'columns',
                    blockName: 'core/columns',
                    sourceRef: {
                      sourceNodeId: 'template-services::columns::0.1.2',
                    },
                    children: [],
                  },
                ],
              },
            ],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            attrs: { metadata: { name: 'FAQ' } },
            sourceRef: { sourceNodeId: 'template-services::group::1' },
            children: [
              {
                kind: 'details',
                blockName: 'core/details',
                sourceRef: {
                  sourceNodeId: 'template-services::details::1.1.0.0',
                },
                children: [],
              },
            ],
          },
        ],
      },
    } as any;

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'TemplateServices',
      rawSource: '',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan,
      repoManifest: {
        themeTypeHints: { themeSlug: 'profolio-fse' },
      } as RepoThemeManifest,
    });

    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(result.map((component) => component.name)).toEqual([
      'TemplateServices',
      'TemplateServicesUIUXDesign',
      'TemplateServicesGraphicDesign',
      'TemplateServicesProductDesign',
      'TemplateServicesFAQ',
    ]);
    expect(
      result.find(
        (component) => component.name === 'TemplateServicesUIUXDesign',
      )?.visualPlan?.sections,
    ).toHaveLength(1);
    expect(
      result.find(
        (component) => component.name === 'TemplateServicesGraphicDesign',
      )?.visualPlan?.sections,
    ).toHaveLength(1);
    expect(
      result.find((component) => component.name === 'TemplateServicesFAQ')
        ?.visualPlan?.blockTree?.[0]?.sourceRef?.sourceNodeId,
    ).toBe('template-services::group::1');
  });

  it('creates child components for uncovered profolio-fse top-level blocks', async () => {
    const codeGenerator = {
      generate: jest.fn(),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      reviewComponent: jest.fn(),
      reviewSection: jest.fn(
        async ({ sectionName }: { sectionName: string }) => ({
          name: sectionName,
          filePath: '',
          code: `export default function ${sectionName}(){return <section>${sectionName}</section>;}`,
          isSubComponent: true,
        }),
      ),
    } as unknown as CodeReviewerService;
    const service = new ReactGeneratorService(
      { getModel: jest.fn(() => 'gpt-test') } as never,
      { get: jest.fn() } as never,
      { resolve: jest.fn() } as never,
      codeGenerator,
      codeReviewer,
      {} as never,
    );

    const componentPlan = {
      componentName: 'TemplateContact',
      templateName: 'template-contact',
      type: 'page',
      route: '/contact',
      dataNeeds: [],
      isDetail: false,
      description: 'Contact',
      visualPlan: {
        componentName: 'TemplateContact',
        renderMode: 'hybrid',
        dataNeeds: [],
        palette: {} as never,
        typography: {} as never,
        layout: {} as never,
        sections: [
          {
            type: 'media-text',
            heading: "Let's Work Together",
            sourceRef: {
              sourceNodeId: 'template-contact::columns::0.0',
              parentSourceNodeId: 'template-contact::group::0',
            },
          },
        ],
        blockTree: [
          {
            kind: 'group',
            blockName: 'core/group',
            attrs: { metadata: { name: 'Contact' } },
            sourceRef: { sourceNodeId: 'template-contact::group::0' },
            children: [
              {
                kind: 'columns',
                blockName: 'core/columns',
                sourceRef: { sourceNodeId: 'template-contact::columns::0.0' },
                children: [],
              },
            ],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            attrs: { metadata: { name: 'Testimonials' } },
            sourceRef: { sourceNodeId: 'template-contact::group::1' },
            children: [],
          },
          {
            kind: 'group',
            blockName: 'core/group',
            attrs: { metadata: { name: 'Skills' } },
            sourceRef: { sourceNodeId: 'template-contact::group::2' },
            children: [],
          },
        ],
      },
    } as any;

    const result = await (
      service as unknown as {
        generateForTemplate: (input: Record<string, unknown>) => Promise<any[]>;
      }
    ).generateForTemplate({
      componentName: 'TemplateContact',
      rawSource: '',
      codeGeneratorModel: 'gpt-test',
      fixAgentModel: 'gpt-test',
      systemPrompt: 'test',
      content: {} as never,
      themeType: 'fse',
      componentPlan,
      repoManifest: {
        themeTypeHints: { themeSlug: 'profolio-fse' },
      } as RepoThemeManifest,
    });

    expect(codeReviewer.reviewComponent).not.toHaveBeenCalled();
    expect(result.map((component) => component.name)).toEqual([
      'TemplateContact',
      'TemplateContactLetsWorkTogether',
      'TemplateContactTestimonials',
      'TemplateContactSkills',
    ]);
    expect(
      result.find(
        (component) => component.name === 'TemplateContactTestimonials',
      )?.visualPlan?.sections,
    ).toHaveLength(0);
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

  it('lets AI patch protected profolio detail pages for visual section contract repairs', async () => {
    const codeGenerator = {
      generate: jest.fn(
        () =>
          'export default function SinglePost(){return <main data-deterministic />;}',
      ),
      generateBlockFaithfulPartial: jest.fn(),
    } as unknown as CodeGeneratorService;
    const codeReviewer = {
      selfFix: jest.fn(
        async () =>
          'export default function SinglePost(){return <main data-ai-fixed />;}',
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

    const visualPlan = {
      componentName: 'SinglePost',
      renderMode: 'block-centric',
      renderAuthority: 'deterministic-pixel',
      dataNeeds: ['postDetail', 'comments'],
      palette: {},
      typography: {},
      layout: {},
      sections: [
        { type: 'post-featured-image' },
        { type: 'post-title' },
        { type: 'post-content', debugKey: 'post-content-0' },
        { type: 'post-terms' },
        { type: 'comments', debugKey: 'comments-0', showForm: true },
      ],
      blockTree: [{ blockName: 'core/group' }],
      lockPolicy: { bypassAiGeneration: true, reason: 'strict' },
    } as any;
    const plan = [
      {
        componentName: 'SinglePost',
        templateName: 'single',
        type: 'page',
        route: '/post/:slug',
        dataNeeds: ['post-detail', 'comments'],
        isDetail: true,
        planningSourceReason: 'block-tree deterministic visual plan path',
        visualPlan,
        renderContract: {
          structure: { renderMode: 'block-tree' },
        },
      },
    ] as any;

    const fixed = await service.fixComponent({
      component: {
        name: 'SinglePost',
        filePath: '',
        code: 'export default function SinglePost(){return null;}',
        generationMode: 'deterministic',
        visualPlan,
        renderContract: plan[0].renderContract,
      },
      plan,
      feedback:
        'Validator contract error for component "SinglePost":\nVisual section contracts violated:\ndetail: "SinglePost" section 3 post-content must render post body through the approved structured rich-text render path\ndetail: "SinglePost" section 5 comments list is missing comment body rendering\ndetail: "SinglePost" section 5 comment form is missing the required author field\ndetail: "SinglePost" section 5 comment form is missing the required email field',
    });

    expect(codeGenerator.generate).not.toHaveBeenCalled();
    expect(codeReviewer.selfFix).toHaveBeenCalledTimes(1);
    expect((codeReviewer.selfFix as jest.Mock).mock.calls[0][2]).toContain(
      'Protected source-faithful contract repair',
    );
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
