import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';

describe('CodeReviewerService section assembly policy', () => {
  const service = new CodeReviewerService(
    {} as never,
    {} as never,
    {} as never,
    new CodeGeneratorService(),
    new FrameGeneratorService(),
  );

  it('prefers section assembly for hybrid non-detail pages with source-backed sections', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        type: 'page',
        isDetail: false,
        dataNeeds: ['posts'],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Shop',
              sourceRef: { sourceNodeId: 'archive-product::group::1.0' },
            },
            {
              type: 'card-grid',
              cards: [{ heading: 'Let', body: 'Short body' }],
              sourceRef: { sourceNodeId: 'archive-product::group::1.1' },
            },
            {
              type: 'post-list',
              layout: 'grid-3',
              showDate: true,
              showAuthor: false,
              showCategory: false,
              showExcerpt: true,
              showFeaturedImage: true,
              sourceRef: { sourceNodeId: 'archive-product::query::1.2' },
            },
          ],
        },
      },
      'ArchiveProduct',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('section assembly');
  });

  it('keeps page-content wrapper pages on full-file generation', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        type: 'page',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'section-centric',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'About',
            },
            {
              type: 'page-content',
              bodyPresentation: 'wordpress-blocks',
            },
          ],
        },
      },
      'Page',
    );

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('page-content wrapper');
  });

  it('prefers section assembly for complex homepage block-tree plans', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
            {
              type: 'media-text',
              heading: 'Story',
              body: 'Body',
              imageSrc: '/assets/story.jpg',
              imageAlt: 'Story',
              sourceRef: { sourceNodeId: 'front-page::group::1.1' },
            },
            {
              type: 'card-grid',
              columns: 3,
              cards: [{ heading: 'A', body: 'B' }],
              sourceRef: { sourceNodeId: 'front-page::group::1.2' },
            },
            {
              type: 'testimonial',
              quote: 'Quote',
              authorName: 'Author',
              sourceRef: { sourceNodeId: 'front-page::group::1.3' },
            },
          ],
        },
      },
      'FrontPage',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('section assembly');
  });

  it('always pins Home to section assembly when sections exist', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'home',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'all-content',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'home::group::1.0' },
            },
          ],
        },
      },
      'Home',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('pinned to section assembly');
  });

  it('always pins template landing components to section assembly when present', () => {
    const decision = (
      service as unknown as {
        getSectionLevelAssemblyDecision: (
          componentPlan: any,
          componentName: string,
        ) => { enabled: boolean; reason: string };
      }
    ).getSectionLevelAssemblyDecision(
      {
        templateName: 'template-about',
        type: 'page',
        route: '/about',
        isDetail: false,
        dataNeeds: [],
        visualPlan: {
          renderMode: 'hybrid',
          blockTree: [{ kind: 'group', blockName: 'core/group', children: [] }],
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'media-text',
              heading: 'About',
              body: 'Body',
              imageSrc: '/assets/about.jpg',
              sourceRef: { sourceNodeId: 'template-about::group::1.0' },
            },
          ],
        },
      },
      'TemplateAbout',
    );

    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('pinned to section assembly');
  });

  it('does not prefer deterministic-first for complex homepage/page templates', () => {
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(
      {
        templateName: 'front-page',
        type: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        renderContract: {
          structure: { renderMode: 'hybrid' },
        },
        visualPlan: {
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          sections: [
            {
              type: 'hero',
              heading: 'Welcome',
              sourceRef: { sourceNodeId: 'front-page::group::1.0' },
            },
            {
              type: 'media-text',
              heading: 'Story',
              body: 'Body',
              imageSrc: '/assets/story.jpg',
              imageAlt: 'Story',
              sourceRef: { sourceNodeId: 'front-page::group::1.1' },
            },
            {
              type: 'card-grid',
              columns: 3,
              cards: [{ heading: 'A', body: 'B' }],
              sourceRef: { sourceNodeId: 'front-page::group::1.2' },
            },
            {
              type: 'testimonial',
              quote: 'Quote',
              authorName: 'Author',
              sourceRef: { sourceNodeId: 'front-page::group::1.3' },
            },
          ],
        },
      },
      'FrontPage',
    );

    expect(preferDeterministic).toBe(false);
  });

  it('treats template-driven PagePage variants with rich block-tree markers as AI-first', () => {
    const preferDeterministic = (
      service as unknown as {
        shouldPreferDeterministicPlan: (
          componentPlan: any,
          componentName: string,
        ) => boolean;
      }
    ).shouldPreferDeterministicPlan(
      {
        templateName: 'template-about',
        type: 'page',
        route: '/about',
        isDetail: true,
        dataNeeds: ['pageDetail'],
        renderContract: {
          structure: { renderMode: 'hybrid' },
        },
        visualPlan: {
          renderMode: 'hybrid',
          renderAuthority: 'deterministic-structure',
          layout: {
            contentLayout: 'single-column',
            sidebarScope: 'none',
          },
          blockTree: [
            {
              kind: 'group',
              blockName: 'core/group',
              sourceRef: { sourceNodeId: 'template-about::group::1' },
              customClassNames: ['r-pad'],
              children: [
                {
                  kind: 'columns',
                  blockName: 'core/columns',
                  sourceRef: { sourceNodeId: 'template-about::columns::1.1' },
                  children: [
                    {
                      kind: 'column',
                      blockName: 'core/column',
                      sourceRef: {
                        sourceNodeId: 'template-about::column::1.1.1',
                      },
                      children: [
                        {
                          kind: 'image',
                          blockName: 'core/image',
                          sourceRef: {
                            sourceNodeId: 'template-about::image::1.1.1.1',
                          },
                          src: 'theme-asset:/assets/images/figma.png',
                          customClassNames: ['wow', 'animate__fadeInUp'],
                        },
                        {
                          kind: 'group',
                          blockName: 'uagb/container',
                          sourceRef: {
                            sourceNodeId: 'template-about::uagb::1.1.1.2',
                          },
                          customClassNames: ['uagb-section__wrap'],
                          children: [
                            {
                              kind: 'heading',
                              blockName: 'core/heading',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::heading::1.1.1.2.1',
                              },
                              text: 'About',
                            },
                            {
                              kind: 'image',
                              blockName: 'core/image',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::image::1.1.1.2.2',
                              },
                              src: 'theme-asset:/assets/images/wordpress.png',
                            },
                            {
                              kind: 'image',
                              blockName: 'core/image',
                              sourceRef: {
                                sourceNodeId:
                                  'template-about::image::1.1.1.2.3',
                              },
                              src: 'theme-asset:/assets/images/illustrator.png',
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
          sections: [
            {
              type: 'hero',
              heading: 'About',
              sourceRef: { sourceNodeId: 'template-about::group::1' },
            },
            {
              type: 'page-content',
              bodyPresentation: 'wordpress-blocks',
              sourceRef: { sourceNodeId: 'template-about::content::1.2' },
            },
          ],
        },
      },
      'PagePageAbout',
    );

    expect(preferDeterministic).toBe(false);
  });
});

describe('CodeReviewerService inline section generation policy', () => {
  it('does not use deterministic inline assembly for rich media-text sections', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn().mockReturnValue(undefined),
      checkInlineSectionFidelity: jest.fn().mockReturnValue(undefined),
    };
    const codeGenerator = {
      generateDeterministicInlineSection: jest
        .fn()
        .mockReturnValue('<section><div>deterministic</div></section>'),
    };
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      validator as never,
      codeGenerator as never,
      new FrameGeneratorService(),
    );

    const result = await (
      service as unknown as {
        generateInlineSectionForAssembly: (input: any) => Promise<any>;
      }
    ).generateInlineSectionForAssembly({
      componentName: 'FrontPage',
      section: {
        type: 'media-text',
        heading: 'About',
        body: 'Body',
        imageSrc: 'theme-asset:/assets/images/about.jpg',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: '',
      modelName: 'test-model',
      systemPrompt: 'test-system',
      content: {},
      componentPlan: {
        visualPlan: {
          sections: [{ type: 'media-text' }],
        },
      },
      maxAttempts: 0,
    });

    expect(
      codeGenerator.generateDeterministicInlineSection,
    ).not.toHaveBeenCalled();
    expect(result.isValid).toBe(false);
    expect(result.attemptsUsed).toBe(0);
  });

  it('still uses deterministic inline assembly for low-risk post-content sections', async () => {
    const validator = {
      checkInlineSectionSyntax: jest.fn().mockReturnValue(undefined),
      checkInlineSectionFidelity: jest.fn().mockReturnValue(undefined),
    };
    const codeGenerator = {
      generateDeterministicInlineSection: jest
        .fn()
        .mockReturnValue('<section><article>Body</article></section>'),
    };
    const service = new CodeReviewerService(
      {} as never,
      {} as never,
      validator as never,
      codeGenerator as never,
      new FrameGeneratorService(),
    );

    const result = await (
      service as unknown as {
        generateInlineSectionForAssembly: (input: any) => Promise<any>;
      }
    ).generateInlineSectionForAssembly({
      componentName: 'Single',
      section: {
        type: 'post-content',
      },
      sectionIndex: 0,
      totalSections: 1,
      availableVariables: '',
      modelName: 'test-model',
      systemPrompt: 'test-system',
      content: {},
      componentPlan: {
        visualPlan: {
          sections: [{ type: 'post-content' }],
        },
      },
      maxAttempts: 0,
    });

    expect(
      codeGenerator.generateDeterministicInlineSection,
    ).toHaveBeenCalledTimes(1);
    expect(result.isValid).toBe(true);
    expect(result.attemptsUsed).toBe(0);
  });
});
