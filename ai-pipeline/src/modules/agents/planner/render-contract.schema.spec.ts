import {
  isDeterministicFallbackEligibleForRenderContract,
  shouldPreferDeterministicGenerationForRenderContract,
} from './render-contract.schema.js';

describe('render contract deterministic policy', () => {
  it('prefers deterministic-first only for strict block-tree contracts', () => {
    expect(
      shouldPreferDeterministicGenerationForRenderContract({
        version: 1,
        sourceModel: { kind: 'block-tree', blockTree: [] },
        structure: {
          renderMode: 'block-tree',
          sharedChrome: {},
          subtreeBindings: [],
        },
        preserveRules: {
          requireFullNodeCoverage: true,
          preserveClassNames: true,
          preserveSpacing: true,
          preserveTypography: true,
          preserveColors: true,
          preserveAlignWideFull: true,
        },
      }),
    ).toBe(true);

    expect(
      shouldPreferDeterministicGenerationForRenderContract({
        version: 1,
        sourceModel: { kind: 'block-tree', blockTree: [] },
        structure: {
          renderMode: 'hybrid',
          sharedChrome: {},
          subtreeBindings: [],
        },
        preserveRules: {
          requireFullNodeCoverage: true,
          preserveClassNames: true,
          preserveSpacing: true,
          preserveTypography: true,
          preserveColors: true,
          preserveAlignWideFull: true,
        },
      }),
    ).toBe(false);
  });

  it('keeps hybrid contracts eligible for deterministic fallback', () => {
    expect(
      isDeterministicFallbackEligibleForRenderContract({
        version: 1,
        sourceModel: { kind: 'block-tree', blockTree: [] },
        structure: {
          renderMode: 'hybrid',
          sharedChrome: {},
          subtreeBindings: [],
        },
        preserveRules: {
          requireFullNodeCoverage: true,
          preserveClassNames: true,
          preserveSpacing: true,
          preserveTypography: true,
          preserveColors: true,
          preserveAlignWideFull: true,
        },
      }),
    ).toBe(true);
  });
});
