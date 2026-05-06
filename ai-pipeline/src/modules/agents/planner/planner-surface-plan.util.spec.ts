import type {
  ComponentVisualPlan,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';
import type { PlannerSurfacePlan } from './planner-surface-plan.schema.js';
import {
  buildSurfacePlanRegressionSnapshot,
  collectSurfacePlanRequiredLiterals,
  resolvePlannerSectionBlueprint,
  resolveSurfacePlanLegacySections,
} from './planner-surface-plan.util.js';

function buildSurfacePlan(): PlannerSurfacePlan {
  const legacySections: SectionPlan[] = [
    {
      type: 'hero',
      layout: 'centered',
      heading: 'Welcome to Studio North',
      subheading: 'Thoughtful product design for modern teams.',
      cta: { text: 'Book a call', link: '/contact' },
      debugKey: 'hero-opening',
    } as SectionPlan,
    {
      type: 'card-grid',
      title: 'Services',
      columns: 3,
      cards: [
        {
          heading: 'Product Strategy',
          body: 'Roadmaps grounded in user evidence.',
        },
      ],
      debugKey: 'services-grid',
    } as SectionPlan,
  ];

  return {
    kind: 'standard-page',
    componentName: 'FrontPage',
    templateName: 'front-page',
    contract: {
      route: '/',
      dataNeeds: ['siteInfo', 'pages'],
      isDetail: false,
      componentType: 'page',
      sharedChromeOwnership: 'self',
    },
    authority: {
      level: 'guided',
      reason:
        'Preserve route-owned evidence and grouping while allowing composition changes.',
      allowSectionTypeSubstitution: true,
      allowReorderWithinGroups: false,
      allowWrapperRecomposition: true,
      preserveExactBlockStructure: false,
    },
    pageIntent: {
      kind: 'homepage-brand',
      confidence: 0.86,
    },
    sourceEvidence: {
      planningSourceLabel: 'db:front-page',
      planningSourceFile: 'templates/front-page.html',
      primaryHeadings: ['Welcome to Studio North', 'Services'],
      primaryImages: ['/wp-content/uploads/hero.jpg'],
      paragraphSnippets: [
        'Thoughtful product design for modern teams.',
        'Roadmaps grounded in user evidence.',
      ],
      navigationLabels: ['Home', 'Services', 'Work', 'Contact'],
      customClassNames: ['wp-block-group', 'alignfull'],
      contentClusters: [
        {
          id: 'hero-opening',
          kind: 'opening',
          importance: 'high',
          textEvidence: ['Welcome to Studio North'],
          ctaEvidence: [
            'Book a call',
            '/contact',
            'https://example.com/ignore-me',
          ],
        },
        {
          id: 'services-grid',
          kind: 'feature-list',
          importance: 'high',
          textEvidence: ['Services', 'Roadmaps grounded in user evidence.'],
        },
      ],
      wrapperFacts: [
        {
          id: 'stack-root',
          kind: 'stack',
          importance: 'high',
          hints: ['Preserve top-to-bottom page flow.'],
        },
      ],
      widgets: [{ kind: 'navigation', required: true }],
      representativeBindings: [
        { kind: 'page', id: 11, slug: 'home', title: 'Home' },
      ],
      evidenceNotes: ['Representative DB front page exists.'],
    },
    designEvidence: {
      importantClassNames: ['wp-block-group', 'alignfull'],
      spacingRhythm: {
        density: 'balanced',
        rhythmHints: ['Preserve a visually distinct opening block.'],
      },
      visualToneHints: ['Brand-first opening.'],
      tokens: {},
    },
    compositionHints: {
      macroOrder: ['hero-opening', 'services-grid'],
      preferredGrouping: [['hero-opening'], ['services-grid']],
      keepAdjacentClusterPairs: [['hero-opening', 'services-grid']],
      mayCollapseClusters: [],
      mayExpandClusters: ['services-grid'],
    },
    acceptance: {
      mustKeep: [
        'Preserve source heading: "Welcome to Studio North"',
        'Preserve source widget: navigation',
      ],
      mustNotInvent: [
        'Do not invent extra shared chrome inside the page body.',
      ],
      mayRecompose: [
        'Section taxonomy may change if the same source-backed evidence survives.',
      ],
    },
    debug: {
      legacyDraftSections: legacySections,
    },
  };
}

describe('planner-surface-plan util', () => {
  it('prefers visual plan sections over legacy surface-plan sections', () => {
    const surfacePlan = buildSurfacePlan();
    const visualPlan = {
      sections: [
        {
          type: 'cover',
          imageSrc: '/wp-content/uploads/cover.jpg',
          dimRatio: 0.4,
          minHeight: '480px',
          heading: 'Approved cover',
        } as SectionPlan,
      ],
    } as Pick<ComponentVisualPlan, 'sections'>;

    const resolved = resolvePlannerSectionBlueprint({
      visualPlan,
      surfacePlan,
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.type).toBe('cover');
  });

  it('falls back to legacy surface-plan sections when visual plan is absent', () => {
    const surfacePlan = buildSurfacePlan();

    const resolved = resolvePlannerSectionBlueprint({
      visualPlan: undefined,
      surfacePlan,
    });

    expect(resolveSurfacePlanLegacySections(surfacePlan)).toHaveLength(2);
    expect(resolved.map((section) => section.type)).toEqual([
      'hero',
      'card-grid',
    ]);
  });

  it('collects stable source literals while filtering urls and route placeholders', () => {
    const surfacePlan = buildSurfacePlan();

    const literals = collectSurfacePlanRequiredLiterals(surfacePlan);

    expect(literals).toContain('Welcome to Studio North');
    expect(literals).toContain('Services');
    expect(literals).toContain('Book a call');
    expect(literals).toContain('Home');
    expect(literals).not.toContain('/contact');
    expect(literals).not.toContain('https://example.com/ignore-me');
  });

  it('filters shared footer/copyright literals when shared chrome is layout-owned', () => {
    const surfacePlan = buildSurfacePlan();
    surfacePlan.contract.sharedChromeOwnership = 'layout';
    surfacePlan.sourceEvidence.primaryHeadings = [
      ...surfacePlan.sourceEvidence.primaryHeadings,
      'Themegrove.com',
      '©Copyright All Right Reserved',
    ];
    surfacePlan.sourceEvidence.contentClusters.unshift({
      id: 'footer-cta',
      kind: 'cta',
      importance: 'high',
      textEvidence: ['Developed By', 'Themegrove.com'],
      ctaEvidence: ['©Copyright All Right Reserved'],
    });

    const literals = collectSurfacePlanRequiredLiterals(surfacePlan);

    expect(literals).not.toContain('Themegrove.com');
    expect(literals).not.toContain('©Copyright All Right Reserved');
    expect(literals).not.toContain('Developed By');
    expect(literals).toContain('Welcome to Studio North');
  });

  it('filters low-signal Woo checkout scaffold headings from required literals', () => {
    const surfacePlan = buildSurfacePlan();
    surfacePlan.componentName = 'Checkout';
    surfacePlan.templateName = 'checkout';
    surfacePlan.contract.route = '/checkout';
    surfacePlan.sourceEvidence.sourceFacts = {
      hasQuery: false,
      hasSidebarTemplatePart: false,
      hasSearch: false,
      hasPostContent: false,
      hasPageList: false,
      hasComments: false,
      hasNavigation: false,
      hasWooCart: false,
      hasWooCheckout: true,
    };
    surfacePlan.sourceEvidence.primaryHeadings = [
      'Checkout',
      'Checkout Fields',
      'Order Summary',
    ];
    surfacePlan.sourceEvidence.contentClusters.unshift({
      id: 'checkout-fields',
      kind: 'prose',
      importance: 'high',
      textEvidence: ['Checkout Fields', 'Order Summary'],
    });

    const literals = collectSurfacePlanRequiredLiterals(surfacePlan);

    expect(literals).toContain('Checkout');
    expect(literals).not.toContain('Checkout Fields');
    expect(literals).not.toContain('Order Summary');
  });

  it('builds a regression snapshot from stable surface-plan facts', () => {
    const surfacePlan = buildSurfacePlan();

    expect(buildSurfacePlanRegressionSnapshot(surfacePlan)).toEqual({
      kind: 'standard-page',
      authority: 'guided',
      pageIntent: 'homepage-brand',
      mustKeep: [
        'Preserve source heading: "Welcome to Studio North"',
        'Preserve source widget: navigation',
      ],
      mustNotInvent: [
        'Do not invent extra shared chrome inside the page body.',
      ],
      mayRecompose: [
        'Section taxonomy may change if the same source-backed evidence survives.',
      ],
      clusterKinds: ['opening:high', 'feature-list:high'],
      widgetKinds: ['navigation:required'],
      headingCount: 2,
      navigationLabelCount: 4,
      debugSectionKeys: ['hero-opening', 'services-grid'],
      representativeBindings: ['page:home'],
      planningSourceLabel: 'db:front-page',
    });
  });
});
