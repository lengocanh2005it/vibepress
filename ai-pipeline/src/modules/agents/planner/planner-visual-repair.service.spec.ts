import { PlannerVisualRepairService } from './planner-visual-repair.service.js';
import type { ComponentVisualPlan } from '../react-generator/visual-plan.schema.js';

describe('PlannerVisualRepairService', () => {
  const service = new PlannerVisualRepairService();

  it('does not reject semantically merged visual sections for merge-friendly drafts', () => {
    const visualPlan: ComponentVisualPlan = {
      componentName: 'TemplateAbout',
      dataNeeds: [],
      palette: {
        background: '#ffffff',
        surface: '#f5f5f5',
        text: '#111111',
        textMuted: '#666666',
        accent: '#000000',
        accentText: '#ffffff',
        dark: '#000000',
        darkText: '#ffffff',
      },
      typography: {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded',
      },
      layout: {
        containerClass: 'max-w-6xl mx-auto w-full',
        blockGap: 'gap-12',
        cardPadding: '24px',
        cardRadius: '24px',
        imageRadius: '24px',
        includes: [],
      },
      sections: [
        { type: 'cover', imageSrc: 'theme-asset:/hero.jpg', dimRatio: 0 },
        { type: 'hero', layout: 'centered', heading: 'About us' },
        {
          type: 'card-grid',
          columns: 3,
          cards: [
            { heading: 'One', body: 'Body one' },
            { heading: 'Two', body: 'Body two' },
            { heading: 'Three', body: 'Body three' },
          ],
        },
        { type: 'hero', layout: 'left', heading: 'Closing section' },
      ],
    };

    const issues = service.assessAcceptedVisualPlanQuality(visualPlan, {
      planningSource: {
        source: 'mock',
        sourceAnalysis: '',
        sourceBackedAuxiliaryLabels: [],
      },
      draftSections: [
        { type: 'cover', imageSrc: 'theme-asset:/hero.jpg', dimRatio: 0 },
        { type: 'hero', layout: 'centered', heading: 'About us' },
        { type: 'hero', layout: 'left', heading: 'Story' },
        { type: 'hero', layout: 'left', heading: 'Mission' },
        { type: 'hero', layout: 'left', heading: 'Vision' },
        {
          type: 'card-grid',
          columns: 3,
          cards: [
            { heading: 'One', body: 'Body one' },
            { heading: 'Two', body: 'Body two' },
            { heading: 'Three', body: 'Body three' },
          ],
        },
        { type: 'hero', layout: 'left', heading: 'Closing section' },
      ],
      detectedCustomClassNames: [],
      sourceBackedAuxiliaryLabels: [],
      sourceWidgetHints: [],
      allowedImageSrcs: ['theme-asset:/hero.jpg'],
      visualContract: {
        componentType: 'page',
        route: '/about',
        isDetail: false,
        dataNeeds: [],
        stripLayoutChrome: true,
      },
    });

    expect(issues).not.toContainEqual(
      expect.stringContaining('section coverage'),
    );
  });

  it('allows source-backed icon grids whose cards intentionally have no body text', () => {
    const visualPlan: ComponentVisualPlan = {
      componentName: 'FrontPage',
      dataNeeds: [],
      palette: {
        background: '#ffffff',
        surface: '#f5f5f5',
        text: '#111111',
        textMuted: '#666666',
        accent: '#000000',
        accentText: '#ffffff',
        dark: '#000000',
        darkText: '#ffffff',
      },
      typography: {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded',
      },
      layout: {
        containerClass: 'max-w-6xl mx-auto w-full',
        blockGap: 'gap-12',
        cardPadding: '24px',
        cardRadius: '24px',
        imageRadius: '24px',
        includes: [],
      },
      sections: [
        {
          type: 'card-grid',
          title: 'Skills and Tools',
          columns: 4,
          sourceRef: {
            sourceNodeId: 'front-page::group::skills',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 5,
          },
          cards: [
            {
              heading: 'Figma',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
            },
            {
              heading: 'Photoshop',
              body: '',
              imageSrc: 'theme-asset:/assets/images/photoshop.png',
            },
          ],
        },
      ],
    };

    const issues = service.assessAcceptedVisualPlanQuality(visualPlan, {
      planningSource: {
        source: 'mock',
        sourceAnalysis: '',
        sourceBackedAuxiliaryLabels: [],
      },
      draftSections: [
        {
          type: 'card-grid',
          title: 'Skills and Tools',
          columns: 4,
          sourceRef: {
            sourceNodeId: 'front-page::group::skills',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 5,
          },
          cards: [
            {
              heading: 'UI/UX Design',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
            },
            {
              heading: 'Graphic Design',
              body: '',
              imageSrc: 'theme-asset:/assets/images/photoshop.png',
            },
          ],
        },
      ],
      detectedCustomClassNames: [],
      sourceBackedAuxiliaryLabels: [],
      sourceWidgetHints: [],
      allowedImageSrcs: [
        'theme-asset:/assets/images/figma.png',
        'theme-asset:/assets/images/photoshop.png',
      ],
      visualContract: {
        componentType: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        stripLayoutChrome: true,
      },
    });

    expect(issues).not.toContainEqual(expect.stringContaining('weak card'));
  });

  it('matches repaired card-grids by source identity instead of raw order', () => {
    const visualPlan: ComponentVisualPlan = {
      componentName: 'FrontPage',
      dataNeeds: [],
      palette: {
        background: '#ffffff',
        surface: '#f5f5f5',
        text: '#111111',
        textMuted: '#666666',
        accent: '#000000',
        accentText: '#ffffff',
        dark: '#000000',
        darkText: '#ffffff',
      },
      typography: {
        headingFamily: 'inherit',
        bodyFamily: 'inherit',
        h1: 'text-4xl',
        h2: 'text-3xl',
        h3: 'text-2xl',
        body: 'text-base',
        small: 'text-sm',
        buttonRadius: 'rounded',
      },
      layout: {
        containerClass: 'max-w-6xl mx-auto w-full',
        blockGap: 'gap-12',
        cardPadding: '24px',
        cardRadius: '24px',
        imageRadius: '24px',
        includes: [],
      },
      sections: [
        {
          type: 'card-grid',
          title: 'Skills and Tools',
          columns: 4,
          sourceRef: {
            sourceNodeId: 'front-page::group::skills',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 5,
          },
          cards: [
            {
              heading: 'Figma',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
            },
          ],
        },
        {
          type: 'card-grid',
          title: 'My Services',
          columns: 2,
          sourceRef: {
            sourceNodeId: 'front-page::group::services',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 4,
          },
          cards: [
            {
              heading: 'UI/UX Design',
              body: 'Service body',
              imageSrc: 'theme-asset:/assets/images/projects-1.jpg',
            },
          ],
        },
      ],
    };

    const issues = service.assessAcceptedVisualPlanQuality(visualPlan, {
      planningSource: {
        source: 'mock',
        sourceAnalysis: '',
        sourceBackedAuxiliaryLabels: [],
      },
      draftSections: [
        {
          type: 'card-grid',
          title: 'My Services',
          columns: 2,
          sourceRef: {
            sourceNodeId: 'front-page::group::services',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 4,
          },
          cards: [
            {
              heading: 'UI/UX Design',
              body: 'Service body',
              imageSrc: 'theme-asset:/assets/images/projects-1.jpg',
            },
          ],
        },
        {
          type: 'card-grid',
          title: 'Skills and Tools',
          columns: 4,
          sourceRef: {
            sourceNodeId: 'front-page::group::skills',
            templateName: 'front-page',
            sourceFile: 'patterns/front-page.php',
            topLevelIndex: 5,
          },
          cards: [
            {
              heading: 'UI/UX Design',
              body: '',
              imageSrc: 'theme-asset:/assets/images/figma.png',
            },
          ],
        },
      ],
      detectedCustomClassNames: [],
      sourceBackedAuxiliaryLabels: [],
      sourceWidgetHints: [],
      allowedImageSrcs: [
        'theme-asset:/assets/images/projects-1.jpg',
        'theme-asset:/assets/images/figma.png',
      ],
      visualContract: {
        componentType: 'page',
        route: '/',
        isDetail: false,
        dataNeeds: [],
        stripLayoutChrome: true,
      },
    });

    expect(issues).not.toContainEqual(expect.stringContaining('weak card'));
  });
});
