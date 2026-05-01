import {
  buildRepoRouteHints,
  inferDeterministicRouteContract,
} from './route-contract.util.js';

describe('inferDeterministicRouteContract', () => {
  it('keeps the default page template as a singular page detail route', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'page',
      componentName: 'Page',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/page/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('treats custom non-page templates as static pages by default', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'template-about',
      componentName: 'TemplateAbout',
      type: 'page',
      dataNeeds: ['page-detail'],
    });

    expect(contract.route).toBe('/template-about');
    expect(contract.isDetail).toBe(false);
    expect(contract.requiredDataNeeds).toEqual([]);
    expect(contract.disallowedDetailDataNeeds).toContain('page-detail');
  });

  it('keeps single templates as post detail routes', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'single',
      componentName: 'Single',
      type: 'page',
      dataNeeds: ['post-detail'],
    });

    expect(contract.route).toBe('/post/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['post-detail']);
  });

  it('promotes custom templates with page-content structure into page detail routes', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'template-about',
      componentName: 'TemplateAbout',
      type: 'page',
      dataNeeds: [],
      draftBlockTree: [
        {
          kind: 'page-content',
          blockName: 'core/post-content',
        },
      ],
      planningSourceSummary: 'Template renders canonical page content block.',
    });

    expect(contract.route).toBe('/template-about/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });

  it('treats template-part sources as partials even with unusual names', () => {
    const contract = inferDeterministicRouteContract({
      templateName: 'masthead-alt',
      componentName: 'MastheadAlt',
      type: 'page',
      planningSourceFile: 'parts/masthead-alt.html',
      planningSourceSummary: 'Theme template part used as shared chrome.',
    });

    expect(contract.type).toBe('partial');
    expect(contract.route).toBeNull();
    expect(contract.isDetail).toBe(false);
  });

  it('uses theme.json templatePartAreas as direct partial evidence', () => {
    const repoRouteHints = buildRepoRouteHints('masthead-alt', {
      themeJsonSummary: {
        templatePartAreas: [
          { name: 'masthead-alt', title: 'Masthead', area: 'header' },
        ],
      },
      structureHints: {
        entrySourceChains: [],
      },
    } as any);

    const contract = inferDeterministicRouteContract({
      templateName: 'masthead-alt',
      componentName: 'MastheadAlt',
      type: 'page',
      repoRouteHints,
    });

    expect(contract.type).toBe('partial');
    expect(contract.route).toBeNull();
  });

  it('uses repo entry source chains as page-detail evidence', () => {
    const repoRouteHints = buildRepoRouteHints('about-story', {
      themeJsonSummary: {
        templatePartAreas: [],
      },
      structureHints: {
        entrySourceChains: [
          {
            entryFile: 'templates/about-story.html',
            routeHint: '/about-story',
            chainFiles: ['templates/about-story.html'],
            composedSource: '',
            assetFiles: [],
            runtimeFiles: [],
            blockTypes: ['core/post-content'],
            headingTexts: [],
            notes: ['canonical page content block'],
          },
        ],
      },
    } as any);

    const contract = inferDeterministicRouteContract({
      templateName: 'about-story',
      componentName: 'AboutStory',
      type: 'page',
      repoRouteHints,
    });

    expect(contract.route).toBe('/about-story/:slug');
    expect(contract.isDetail).toBe(true);
    expect(contract.requiredDataNeeds).toEqual(['page-detail']);
  });
});
