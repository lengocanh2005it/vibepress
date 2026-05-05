import { ReactGeneratorService } from './react-generator.service.js';
import { CodeGeneratorService } from './code-generator.service.js';
import { CodeReviewerService } from './code-reviewer.service.js';
import { FrameGeneratorService } from './frame-generator.service.js';

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

  it('keeps Footer on semantic deterministic path when deterministic-authority is locked', () => {
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

    expect(result).toBe(false);
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
});
