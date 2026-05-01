import type { ComponentVisualPlan, SectionPlan } from './visual-plan.schema.js';
import { toVisualDataNeeds } from '../shared/visual-data-needs.util.js';

export const PAGE_COMPONENT_RICH_TEXT_RULE =
  '- `post.content` is normalized HTML and may use `dangerouslySetInnerHTML` when the approved section/render path calls for raw post HTML. `page.content` is also normalized HTML, but page components should render it through `renderRichTextChildren` or equivalent structured JSX instead of `dangerouslySetInnerHTML`.';

export const FIXED_PAGE_DETAIL_EXACT_FETCH_RULE =
  '- Fixed page-detail rule: fetch the exact page record for the approved slug. If the approved visual plan keeps the page as one `page-content` body wrapper, preserve that wrapper. If the approved visual plan already decomposes the source-backed page into rich sections such as `cover`, `media-text`, `card-grid`, `tabs`, `accordion`, `carousel`, or `modal`, render those approved sections directly instead of collapsing everything back into one narrow prose wrapper.';

export const FIXED_PAGE_DETAIL_NO_DSIH_RULE =
  '- Page components must NOT use `dangerouslySetInnerHTML`. Convert approved page HTML/rich text into structured JSX nodes instead of dumping raw HTML strings.';

export const FIXED_PAGE_DETAIL_NARROW_SHELL_RULE =
  '- Do NOT redesign a fixed page-detail into a centered feature article shell with classes such as `max-w-[620px]`, `max-w-2xl`, `max-w-3xl`, or broad `mx-auto` wrappers unless that exact narrow shell is clearly source-backed in the approved layout.';

export const FIXED_PAGE_DETAIL_LAYOUT_PRESERVE_RULE =
  '- Preserve the surrounding template shell/layout rhythm from the approved source. Replace the long-form body with `page.content`, but do NOT invent a new hero-centered article wrapper, oversized centered title block, or optional featured-image treatment unless the source layout already proves those elements.';

export const BLOCK_TREE_STRUCTURAL_SOURCE_HEADER =
  '## WordPress block hierarchy — STRUCTURAL SOURCE OF TRUTH';

export const BLOCK_TREE_STRUCTURE_RULE =
  'When `blockTree` is present, it owns structure: wrapper order, group nesting, columns/column ownership, template-part boundaries, and source-backed shell spacing. Use `sections[]` to supply behavior/data contract inside that preserved structure.';

export const BLOCK_TREE_NO_FLATTEN_RULE =
  'Do NOT flatten `group` / `columns` / `column` / `template-part` shells into a generic section stack. Do NOT merge, split, reorder, or delete block wrappers unless the source/data grounding above proves the wrapper is impossible.';

export const HYBRID_DETAIL_NO_CANONICAL_BODY_RULE =
  'Do NOT render canonical `item.content`, `page.content`, or `post.content` body output unless an approved `page-content` or `post-content` section explicitly exists in `sections[]`. For decomposed rich detail plans, render only the approved source-backed sections inside the preserved blockTree shell.';

export const FIXED_PAGE_DETAIL_DUPLICATE_MODE_REVIEW_MESSAGE =
  'Fixed page-detail component renders canonical `page.content`/`item.content` body output while also rendering decomposed source-backed sections. Use exactly one mode: canonical page body OR the approved decomposed sections, never both.';

export const FIXED_PAGE_DETAIL_CANONICAL_BODY_REQUIRED_REVIEW_MESSAGE =
  'Fixed page-detail component does not render the fetched `page.content`/`item.content` body through the approved rich-text render path. The canonical page body must be rendered instead of replacing the page with bespoke static sections.';

export const FIXED_PAGE_DETAIL_NARROW_SHELL_REVIEW_MESSAGE =
  'Fixed page-detail component wraps the canonical page body in a narrow centered article shell (for example `max-w-[620px] mx-auto` with hero-like centered title treatment) instead of preserving the approved source/template layout shell.';

export function hasCanonicalBodySection(
  sections: ReadonlyArray<SectionPlan>,
): boolean {
  return sections.some(
    (section) =>
      section.type === 'page-content' || section.type === 'post-content',
  );
}

export function isHybridDetailPlanWithoutCanonicalBody(input: {
  visualPlan?: ComponentVisualPlan;
  dataNeeds?: string[];
  isDetail?: boolean;
}): boolean {
  if (!input.visualPlan) return false;

  const visualPlan = input.visualPlan;
  const hasBlockTree = (visualPlan.blockTree?.length ?? 0) > 0;
  if (!hasBlockTree || visualPlan.renderMode === 'section-centric') {
    return false;
  }

  const normalizedNeeds = new Set(toVisualDataNeeds(input.dataNeeds));
  const isHybridDetailRoute =
    input.isDetail &&
    (normalizedNeeds.has('pageDetail') || normalizedNeeds.has('postDetail'));
  if (!isHybridDetailRoute) return false;

  return !hasCanonicalBodySection(visualPlan.sections);
}

export function buildFixedPageDetailPromptLines(): string[] {
  return [
    FIXED_PAGE_DETAIL_EXACT_FETCH_RULE,
    FIXED_PAGE_DETAIL_NO_DSIH_RULE,
    FIXED_PAGE_DETAIL_NARROW_SHELL_RULE,
    FIXED_PAGE_DETAIL_LAYOUT_PRESERVE_RULE,
    HYBRID_DETAIL_NO_CANONICAL_BODY_RULE,
  ];
}

export function buildBlockTreeStructuralPromptLines(
  visualPlan: ComponentVisualPlan,
): string[] {
  const lines = [
    '',
    BLOCK_TREE_STRUCTURAL_SOURCE_HEADER,
    `Render mode: ${visualPlan.renderMode ?? 'hybrid'}; preserve the WordPress wrapper/column/template-part hierarchy from \`blockTree\`.`,
    BLOCK_TREE_STRUCTURE_RULE,
    BLOCK_TREE_NO_FLATTEN_RULE,
  ];

  if (
    visualPlan.renderMode !== 'section-centric' &&
    !hasCanonicalBodySection(visualPlan.sections)
  ) {
    lines.push(HYBRID_DETAIL_NO_CANONICAL_BODY_RULE);
  }

  return lines;
}

export function buildClassicDetailContentHint(input: {
  isSingle: boolean;
  isPage: boolean;
}): string {
  if (input.isSingle) {
    return '- `{/* WP: post.content (HTML) */}` -> render `post?.content` with `dangerouslySetInnerHTML={{ __html: post?.content ?? "" }}` (NO fetch array)';
  }
  if (input.isPage) {
    return '- `{/* WP: post.content (HTML) */}` -> render `page?.content` through `renderRichTextChildren(page?.content ?? "", "page-content")` or equivalent structured JSX page-content renderer (NO fetch array)';
  }
  return '- `{/* WP: post.content (HTML) */}` -> render content ONLY from the endpoint(s) explicitly approved in the component plan. ⛔ NEVER fetch a full list and pick `pages[0]` or `posts[0]`.';
}
