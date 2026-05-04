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
});
