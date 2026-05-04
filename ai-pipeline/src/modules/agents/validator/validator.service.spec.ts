import { ConfigService } from '@nestjs/config';
import type { ComponentRenderContract } from '../planner/render-contract.schema.js';
import type { ComponentVisualPlan } from '../react-generator/visual-plan.schema.js';
import { ValidatorService } from './validator.service.js';

describe('ValidatorService render-contract coverage', () => {
  const service = new ValidatorService({} as ConfigService);

  const preserveRules: ComponentRenderContract['preserveRules'] = {
    requireFullNodeCoverage: true,
    preserveClassNames: true,
    preserveSpacing: true,
    preserveTypography: true,
    preserveColors: true,
    preserveAlignWideFull: true,
  };

  it('accepts hybrid semantic sections covering source descendants', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/banner.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::2.0.1.0',
            },
            children: [],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'semantic coverage test',
        sections: [
          {
            type: 'media-text',
            heading: 'Welcome To My Profile I am Julia Henderson',
            body: 'About Me',
            imageSrc: 'theme-asset:/assets/images/banner-image.png',
            cta: {
              text: 'View my Work',
              link: '#',
            },
            sourceRef: {
              sourceNodeId: 'front-page::columns::2.0',
            },
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const visualPlan = {
      componentName: 'FrontPage',
      sections: renderContract.fallback?.sections ?? [],
    } as ComponentVisualPlan;

    const code = `
      <section>
        <h2>Welcome To My Profile I am Julia Henderson</h2>
        <p>About Me</p>
        <a href="#">View my Work</a>
        <img src={resolveAsset("theme-asset:/assets/images/banner-image.png")} alt="" />
      </section>
    `;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage(
      code,
      renderContract,
      'FrontPage',
      visualPlan,
    );

    expect(issue).toBeNull();
  });

  it('still reports uncovered hybrid source assets', () => {
    const renderContract = {
      version: 1,
      sourceModel: {
        kind: 'block-tree',
        blockTree: [
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/banner.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::2.0.1.0',
            },
            children: [],
          },
          {
            kind: 'cover',
            blockName: 'core/cover',
            src: 'theme-asset:/assets/images/must-keep.jpg',
            sourceRef: {
              sourceNodeId: 'front-page::cover::9.0.0.0',
            },
            children: [],
          },
        ],
      },
      structure: {
        renderMode: 'hybrid',
        sharedChrome: {},
        subtreeBindings: [],
      },
      preserveRules,
      fallback: {
        reason: 'semantic coverage test',
        sections: [
          {
            type: 'media-text',
            heading: 'Welcome To My Profile I am Julia Henderson',
            body: 'About Me',
            imageSrc: 'theme-asset:/assets/images/banner-image.png',
            sourceRef: {
              sourceNodeId: 'front-page::columns::2.0',
            },
          },
        ],
      },
    } as unknown as ComponentRenderContract;

    const issue = (
      service as unknown as {
        checkRenderContractCoverage: (
          code: string,
          renderContract?: ComponentRenderContract,
          componentName?: string,
          visualPlan?: ComponentVisualPlan,
        ) => string | null;
      }
    ).checkRenderContractCoverage('<section />', renderContract, 'FrontPage');

    expect(issue).toContain('theme-asset:/assets/images/must-keep.jpg');
  });
});
