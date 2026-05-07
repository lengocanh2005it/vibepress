import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { SectionPlan } from '../react-generator/visual-plan.schema.js';
import type { BlockTreePlannerComponentPlan } from './block-tree-deterministic-planner.util.js';

export interface DeterministicRenderAuthorityAssessment {
  renderAuthority: 'deterministic-structure' | 'deterministic-pixel';
  reason: string;
  unsupportedBlockKinds: string[];
}

const PIXEL_LOCKED_SHARED_PARTIAL_RE =
  /^(header|footer|navigation|nav|sidebar|postmeta)$/i;

const PIXEL_SUPPORTED_BLOCK_KINDS = new Set<string>([
  'group',
  'columns',
  'column',
  'navigation',
  'navigation-link',
  'site-title',
  'site-tagline',
  'site-logo',
  'heading',
  'paragraph',
  'buttons',
  'button',
  'image',
  'cover',
  'media-text',
  'details',
  'search',
  'social-links',
  'social-link',
  'avatar',
  'post-author-biography',
  'post-content',
  'post-featured-image',
  'post-title',
  'post-excerpt',
  'post-author',
  'categories',
  'tag-cloud',
  'latest-posts',
  'query',
  'post-template',
  'query-title',
  'query-pagination',
  'query-pagination-previous',
  'query-pagination-numbers',
  'query-pagination-next',
  'query-no-results',
  'post-date',
  'post-author-name',
  'post-terms',
  'post-comments-form',
  'template-part',
  'separator',
  'spacer',
]);

export function assessDeterministicRenderAuthority(input: {
  componentPlan: BlockTreePlannerComponentPlan;
  draftBlockTree: BlockNode[];
  draftSections?: SectionPlan[];
  canUseCanonicalBlockTreePageRenderer?: boolean;
}): DeterministicRenderAuthorityAssessment {
  const unsupportedBlockKinds = collectUnsupportedPixelBlockKinds(
    input.draftBlockTree,
  );

  if (
    isPixelLockedSharedPartial(input.componentPlan) &&
    unsupportedBlockKinds.length === 0
  ) {
    return {
      renderAuthority: 'deterministic-pixel',
      reason: `Planner resolved ${input.componentPlan.componentName} from a fully supported WordPress shared-partial block tree; downstream must replay the layout/styling exactly and never hand structure back to AI.`,
      unsupportedBlockKinds,
    };
  }

  if (
    input.componentPlan.type === 'page' &&
    input.canUseCanonicalBlockTreePageRenderer &&
    unsupportedBlockKinds.length === 0
  ) {
    return {
      renderAuthority: 'deterministic-pixel',
      reason: `Planner resolved ${input.componentPlan.componentName} from a fully supported WordPress page block tree; downstream must render the canonical block tree directly and keep section fallback as compatibility-only metadata.`,
      unsupportedBlockKinds,
    };
  }

  if (input.componentPlan.type === 'page') {
    return {
      renderAuthority: 'deterministic-structure',
      reason:
        unsupportedBlockKinds.length > 0
          ? `Planner preserved ${input.componentPlan.componentName} on the deterministic block-tree path, but it cannot be pixel-locked because the tree still contains unsupported block kind(s): ${unsupportedBlockKinds.join(', ')}.`
          : `Planner preserved ${input.componentPlan.componentName} on the deterministic block-tree path, but page templates remain deterministic-structure until they can be rendered end-to-end from blockTree in block-centric mode rather than hybrid section mode.`,
      unsupportedBlockKinds,
    };
  }

  return {
    renderAuthority: 'deterministic-structure',
    reason:
      unsupportedBlockKinds.length > 0
        ? `Planner preserved ${input.componentPlan.componentName} on the deterministic block-tree path, but it cannot be pixel-locked because the tree still contains unsupported block kind(s): ${unsupportedBlockKinds.join(', ')}.`
        : `Planner preserved ${input.componentPlan.componentName} on the deterministic block-tree path, but this partial is outside the current pixel-locked shared-partial allowlist.`,
    unsupportedBlockKinds,
  };
}

function isPixelLockedSharedPartial(
  componentPlan: BlockTreePlannerComponentPlan,
): boolean {
  return (
    componentPlan.type === 'partial' &&
    PIXEL_LOCKED_SHARED_PARTIAL_RE.test(componentPlan.componentName)
  );
}

function collectUnsupportedPixelBlockKinds(blockTree: BlockNode[]): string[] {
  const unsupported = new Set<string>();
  const visit = (nodes: BlockNode[]) => {
    for (const node of nodes) {
      if (!PIXEL_SUPPORTED_BLOCK_KINDS.has(node.kind)) {
        unsupported.add(node.kind);
      }
      if (node.children?.length) visit(node.children);
    }
  };
  visit(blockTree);
  return [...unsupported].sort((a, b) => a.localeCompare(b));
}
