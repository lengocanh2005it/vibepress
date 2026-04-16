import { readFileSync } from 'fs';
import { join } from 'path';
import {
  stripTags,
  wpBlocksToJsonWithSourceRefs,
} from '../../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../../common/utils/wp-block-to-json.js';
import type {
  ThemeTokens,
  ThemeInteractionState,
  ThemeInteractionStyle,
  ThemeInteractionTokens,
} from '../../../agents/block-parser/block-parser.service.js';
import type { RepoThemeManifest } from '../../repo-analyzer/repo-analyzer.service.js';
import { buildRepoManifestContextNote } from '../../repo-analyzer/repo-manifest-context.js';
import { WpMenu, WpSiteInfo } from '../../../sql/wp-query.service.js';
import { DbContentResult } from '../../db-content/db-content.service.js';
import type {
  ComponentVisualPlan,
  SectionPlan,
  SourceLayoutHint,
} from '../visual-plan.schema.js';
import {
  extractAuxiliaryLabelsFromSections,
  formatInventedAuxiliarySectionLabels,
  mergeAuxiliaryLabels,
} from '../auxiliary-section.guard.js';
import {
  API_CONTRACT_SOURCE_PATH,
  COMMENT_FIELDS,
  FOOTER_COLUMN_INTERFACE,
  MENU_FIELDS,
  MENU_ITEM_FIELDS,
  PAGE_FRONTEND_FIELDS,
  POST_FIELDS,
  SITE_INFO_FIELDS,
} from '../api-contract.js';

export function extractTexts(nodes: WpNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.href && node.text) {
      result.push(`[button] ${node.text}`);
    } else if (node.text) {
      result.push(node.text);
    } else if (node.html) {
      const htmlSnippet = compactHtmlSnippet(node.html);
      if (htmlSnippet) {
        result.push(`[html] ${htmlSnippet}`);
      } else {
        const plain = stripTags(node.html).replace(/\s+/g, ' ').trim();
        if (plain.length > 0) result.push(plain);
      }
    }
    if (node.children) result.push(...extractTexts(node.children));
  }
  return result.filter((t) => t.trim().length > 0);
}

function formatContractFields(fields: readonly string[]): string {
  return fields.join(', ');
}

const TEMPLATE = readFileSync(
  join(
    process.cwd(),
    'src/modules/agents/react-generator/prompts/component.prompt.md',
  ),
  'utf-8',
);

const SINGLE_TEMPLATES = new Set([
  'Single',
  'SingleWithSidebar',
  'SingleNarrow',
  'SingleFull',
]);

const PAGE_TEMPLATES = new Set([
  'Page',
  'PageWithSidebar',
  'PageWide',
  'PageNoTitle',
  'PageFull',
]);

const DATA_NEED_ALIASES: Record<string, string> = {
  'site-info': 'siteInfo',
  'footer-links': 'footerLinks',
  'post-detail': 'postDetail',
  'page-detail': 'pageDetail',
};

const MAX_TEMPLATE_TEXT_ITEMS = 24;
const MAX_STATIC_IMAGE_HINTS = 16;
const MAX_SAMPLE_ITEMS = 3;
const MAX_TAXONOMY_TERMS = 5;
const MAX_RETRY_ERROR_CHARS = 700;
const MAX_PLAN_TEXT_CHARS = 320;
const MAX_TEMPLATE_HTML_SNIPPET_CHARS = 420;

export interface ComponentPromptContext {
  description?: string;
  dataNeeds?: string[];
  route?: string | null;
  isDetail?: boolean;
  type?: 'page' | 'partial';
  requiredCustomClassNames?: string[];
  sourceBackedAuxiliaryLabels?: string[];
  visualPlan?: ComponentVisualPlan;
}

function compactPlanText(
  value?: string | null,
  maxChars: number = MAX_PLAN_TEXT_CHARS,
): string | null {
  if (!value) return null;
  const cleaned = stripTags(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactHtmlSnippet(
  value?: string | null,
  maxChars: number = MAX_TEMPLATE_HTML_SNIPPET_CHARS,
): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (!/<[a-z][^>]*>/i.test(cleaned)) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function pushPlanTextPart(
  parts: string[],
  key: string,
  value?: string | null,
  maxChars?: number,
): void {
  const compact = compactPlanText(value, maxChars);
  if (compact) {
    parts.push(`${key}=${JSON.stringify(compact)}`);
  }
}

function pushPlanListPart(
  parts: string[],
  key: string,
  values?: readonly (string | null | undefined)[],
  options?: { maxItems?: number; maxChars?: number },
): void {
  if (!values?.length) return;
  const maxItems = options?.maxItems ?? 8;
  const normalized = values
    .map((value) => compactPlanText(value, options?.maxChars))
    .filter((value): value is string => Boolean(value));
  if (normalized.length === 0) return;
  const sliced = normalized.slice(0, maxItems);
  parts.push(`${key}=${JSON.stringify(sliced)}`);
  if (normalized.length > maxItems) {
    parts.push(`${key}Count=${normalized.length}`);
  }
}

function pushTypographyStyleParts(
  parts: string[],
  key: string,
  style?: {
    fontSize?: string;
    fontFamily?: string;
    fontWeight?: string;
    letterSpacing?: string;
    lineHeight?: string;
    textTransform?: string;
  },
): void {
  if (!style) return;
  if (style.fontSize)
    parts.push(`${key}FontSize=${JSON.stringify(style.fontSize)}`);
  if (style.fontFamily)
    parts.push(`${key}FontFamily=${JSON.stringify(style.fontFamily)}`);
  if (style.fontWeight)
    parts.push(`${key}FontWeight=${JSON.stringify(style.fontWeight)}`);
  if (style.letterSpacing)
    parts.push(`${key}LetterSpacing=${JSON.stringify(style.letterSpacing)}`);
  if (style.lineHeight)
    parts.push(`${key}LineHeight=${JSON.stringify(style.lineHeight)}`);
  if (style.textTransform)
    parts.push(`${key}TextTransform=${JSON.stringify(style.textTransform)}`);
}

function deriveSourceClusterKey(sourceNodeId?: string | null): string | null {
  if (!sourceNodeId) return null;
  const parts = sourceNodeId.split('::');
  if (parts.length < 3) return null;
  const path = parts[2]?.trim();
  if (!path) return null;
  const pathParts = path.split('.');
  if (pathParts.length <= 1) return `${parts[0]}::${path}`;
  return `${parts[0]}::${pathParts.slice(0, -1).join('.')}`;
}

function collectContiguousSourceClusters(
  visualPlan?: ComponentVisualPlan,
): Array<{
  clusterKey: string;
  startIndex: number;
  endIndex: number;
  sectionTypes: string[];
  sectionKeys: string[];
}> {
  if (!visualPlan?.sections?.length) return [];
  const groups: Array<{
    clusterKey: string;
    startIndex: number;
    endIndex: number;
    sectionTypes: string[];
    sectionKeys: string[];
  }> = [];

  let current: {
    clusterKey: string;
    startIndex: number;
    endIndex: number;
    sectionTypes: string[];
    sectionKeys: string[];
  } | null = null;

  for (let index = 0; index < visualPlan.sections.length; index += 1) {
    const section = visualPlan.sections[index];
    const clusterKey = deriveSourceClusterKey(section.sourceRef?.sourceNodeId);
    if (!clusterKey) {
      current = null;
      continue;
    }

    const sectionKey =
      section.sectionKey ?? `${section.type}${index === 0 ? '' : `-${index}`}`;

    if (current && current.clusterKey === clusterKey) {
      current.endIndex = index;
      current.sectionTypes.push(section.type);
      current.sectionKeys.push(sectionKey);
      continue;
    }

    if (current && current.endIndex > current.startIndex) {
      groups.push(current);
    }

    current = {
      clusterKey,
      startIndex: index,
      endIndex: index,
      sectionTypes: [section.type],
      sectionKeys: [sectionKey],
    };
  }

  if (current && current.endIndex > current.startIndex) {
    groups.push(current);
  }

  return groups;
}

function shouldIncludeRepoManifestContext(
  componentName?: string,
  plan?: ComponentPromptContext,
): boolean {
  if (!plan?.visualPlan) return false;
  if (/header|footer|nav/i.test(componentName ?? '')) return true;
  if (plan.dataNeeds?.includes('menus')) return true;
  return plan.visualPlan.sections.some((section) =>
    ['navbar', 'footer', 'sidebar'].includes(section.type),
  );
}

function buildAllowedEndpointsNote(input: {
  dataNeeds: string[];
  route?: string | null;
  visualPlan?: ComponentVisualPlan;
  componentName?: string;
}): string {
  const lines = ['## Allowed runtime data for this component'];
  const allowed = new Set<string>();
  const routeHasParams = /:[A-Za-z_]/.test(input.route ?? '');
  const isArchiveAlias = isArchiveAliasComponent(
    input.componentName,
    input.route,
  );

  if (input.dataNeeds.includes('siteInfo')) allowed.add('GET /api/site-info');
  if (input.dataNeeds.includes('menus')) allowed.add('GET /api/menus');
  if (input.dataNeeds.includes('footerLinks'))
    allowed.add('GET /api/footer-links');
  if (input.dataNeeds.includes('posts')) allowed.add('GET /api/posts');
  if (input.dataNeeds.includes('pages')) allowed.add('GET /api/pages');
  if (input.dataNeeds.includes('postDetail') && routeHasParams)
    allowed.add('GET /api/posts/${slug}');
  if (input.dataNeeds.includes('pageDetail') && routeHasParams)
    allowed.add('GET /api/pages/${slug}');
  if (input.dataNeeds.includes('comments') && routeHasParams) {
    allowed.add('GET /api/comments?slug=${slug}');
    allowed.add(
      'GET /api/comments/submissions?slug=${slug}&clientToken=${token}',
    );
    allowed.add('POST /api/comments');
  }
  if (input.dataNeeds.includes('categoryDetail')) {
    allowed.add('GET /api/taxonomies/category');
    allowed.add('GET /api/taxonomies/category/${slug}/posts');
  }
  if (input.dataNeeds.includes('authorDetail')) {
    allowed.add('GET /api/posts?author=${slug}');
  }
  if (isArchiveAlias) {
    allowed.add('GET /api/posts?page=${currentPage}&perPage=${perPage}');
    allowed.add(
      'GET /api/posts?author=${slug}&page=${currentPage}&perPage=${perPage}',
    );
    allowed.add('GET /api/taxonomies/category');
    allowed.add(
      'GET /api/taxonomies/category/${slug}/posts?page=${currentPage}&perPage=${perPage}',
    );
    allowed.add('GET /api/taxonomies/post_tag');
    allowed.add(
      'GET /api/taxonomies/post_tag/${slug}/posts?page=${currentPage}&perPage=${perPage}',
    );
  }

  const sidebarSection = input.visualPlan?.sections?.find(
    (section) => section.type === 'sidebar',
  );
  if (sidebarSection?.type === 'sidebar') {
    if (sidebarSection.showPages) allowed.add('GET /api/pages');
    if (sidebarSection.showPosts) allowed.add('GET /api/posts');
    if (sidebarSection.showSiteInfo) allowed.add('GET /api/site-info');
    if (sidebarSection.menuSlug) allowed.add('GET /api/menus');
  }

  if (allowed.size === 0) {
    lines.push(
      '- No runtime fetch is allowed unless the template source or approved plan explicitly requires it.',
    );
  } else {
    for (const endpoint of allowed) lines.push(`- ${endpoint}`);
  }

  lines.push(
    '⛔ Do NOT call any endpoint not listed above. Do NOT add helper fetches "for convenience".',
  );
  return lines.join('\n');
}

function buildForbiddenBehaviorNote(input: {
  type?: 'page' | 'partial';
  dataNeeds: string[];
  route?: string | null;
}): string {
  const lines = ['## Forbidden behavior'];
  const routeHasParams = /:[A-Za-z_]/.test(input.route ?? '');
  const isPageDetail = input.dataNeeds.includes('pageDetail');
  const isPostDetail = input.dataNeeds.includes('postDetail');

  if (input.type === 'page') {
    lines.push(
      '- Do NOT render shared site chrome (`<header>`, navigation bar, `<footer>`, site logo/title, footer columns) inside this page component.',
    );
    lines.push(
      '- Do NOT fetch `/api/site-info`, `/api/menus`, or `/api/footer-links` just to rebuild shared layout chrome inside a page component.',
    );
    lines.push(
      `- Do NOT append trailing utility/footer/sidebar-like sections with exact headings such as ${formatInventedAuxiliarySectionLabels()} unless that exact label is already source-backed or explicitly approved in the visual plan.`,
    );
  }
  if (!input.dataNeeds.includes('postDetail')) {
    lines.push('- Do NOT fetch `/api/posts/${slug}` in this component.');
  }
  if (!input.dataNeeds.includes('pageDetail')) {
    lines.push('- Do NOT fetch `/api/pages/${slug}` in this component.');
  }
  if (!input.dataNeeds.includes('posts')) {
    lines.push(
      '- Do NOT fetch `/api/posts` unless the approved plan explicitly allows a list/sidebar widget.',
    );
  }
  if (!input.dataNeeds.includes('pages')) {
    lines.push(
      '- Do NOT fetch `/api/pages` unless the approved plan explicitly allows page navigation/sidebar content.',
    );
  }
  if (!input.dataNeeds.includes('footerLinks')) {
    lines.push(
      '- Do NOT fetch `/api/footer-links` unless the approved contract explicitly marks this component as a footer partial.',
    );
  }
  if (!routeHasParams) {
    lines.push('- Do NOT import or call `useParams` for this route.');
  }
  lines.push(
    '- Do NOT guess internal routes that are absent from the approved frontend/app contract. If a real route is unavailable but the UI should stay clickable, use a temporary placeholder anchor like `href="#"` instead of inventing a path.',
  );
  lines.push(
    '- Do NOT assume `/author/${slug}` exists. Use the real author archive route only when it is explicitly approved; otherwise you may keep the author clickable temporarily with `href="#"`.',
  );
  lines.push(
    '- Do NOT invent hero sections, widgets, promos, author bios, utility links, or filler content not present in the source template or approved visual plan.',
  );
  if (isPageDetail || isPostDetail) {
    lines.push(
      `- For ${isPageDetail ? '`pageDetail`' : '`postDetail`'} routes, the HTML body from \`${isPageDetail ? 'page.content' : 'post.content'}\` is the canonical long-form content. Do NOT restate, summarize, rebuild, or continue that body as extra hardcoded sections outside \`dangerouslySetInnerHTML\`.`,
    );
    lines.push(
      '- If that HTML body can contain interactive WordPress/plugin markup such as Spectra/UAGB tabs (`.wp-block-uagb-tabs`), do NOT leave it as inert HTML. Render the body through a small client-side content hydrator/wrapper that preserves the original HTML but restores tab interaction and hides inactive panels correctly.',
    );
    lines.push(
      '- WordPress/Spectra tab fidelity: preserve the original tab interaction cues. Default tab labels may remain underlined like the source, but on hover/focus they must drop the underline, and keyboard focus must show a visible tab outline/border instead of looking like plain body text.',
    );
    lines.push(
      '- Do NOT append footer-style link columns such as "About", "Privacy", "Social", "Resources", or "Useful Links" after the main content unless those exact blocks are already inside the HTML body being rendered.',
    );
    lines.push(
      '- Do NOT duplicate content that already appears in the fetched HTML body. If the body contains columns/cards/lists/images, render the body once and stop; do not recreate those blocks as separate React sections.',
    );
  }
  lines.push(
    '- Do NOT fetch a full list and pick index 0 as a substitute for a slug-detail endpoint.',
  );
  return lines.join('\n');
}

function normalizeDataNeeds(dataNeeds?: string[]): string[] {
  if (!dataNeeds || dataNeeds.length === 0) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of dataNeeds) {
    const normalized = DATA_NEED_ALIASES[value] ?? value;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function isArchiveAliasComponent(
  componentName?: string,
  route?: string | null,
): boolean {
  const normalizedName = (componentName ?? '').trim().toLowerCase();
  return (
    normalizedName === 'archive' ||
    route === '/archive' ||
    route === '/category/:slug' ||
    route === '/author/:slug' ||
    route === '/tag/:slug'
  );
}

function hasAnyDataNeed(dataNeeds: string[], ...candidates: string[]): boolean {
  return candidates.some((candidate) => dataNeeds.includes(candidate));
}

function buildScopedApiContractNote(input: {
  dataNeeds: string[];
  route?: string | null;
  componentName?: string;
}): string {
  const lines = [
    `## Canonical API contract — relevant subset from \`${API_CONTRACT_SOURCE_PATH}\``,
  ];
  const endpoints = new Set<string>();
  const entityLines: string[] = [];
  const routeHasParams = /:[A-Za-z_]/.test(input.route ?? '');
  const needs = input.dataNeeds;
  const isArchiveAlias = isArchiveAliasComponent(
    input.componentName,
    input.route,
  );

  if (needs.includes('siteInfo')) {
    endpoints.add('GET /api/site-info -> SiteInfo');
    entityLines.push(`- SiteInfo: ${formatContractFields(SITE_INFO_FIELDS)}`);
  }
  if (hasAnyDataNeed(needs, 'posts', 'postDetail', 'authorDetail')) {
    endpoints.add('GET /api/posts -> Post[]');
    entityLines.push(`- Post: ${formatContractFields(POST_FIELDS)}`);
  }
  if (needs.includes('postDetail') && routeHasParams) {
    endpoints.add('GET /api/posts/${slug} -> Post');
  }
  if (hasAnyDataNeed(needs, 'pages', 'pageDetail')) {
    endpoints.add('GET /api/pages -> Page[]');
    entityLines.push(`- Page: ${formatContractFields(PAGE_FRONTEND_FIELDS)}`);
  }
  if (needs.includes('pageDetail') && routeHasParams) {
    endpoints.add('GET /api/pages/${slug} -> Page');
  }
  if (needs.includes('menus')) {
    endpoints.add('GET /api/menus -> Menu[]');
    entityLines.push(`- Menu: ${formatContractFields(MENU_FIELDS)}`);
    entityLines.push(`- MenuItem: ${formatContractFields(MENU_ITEM_FIELDS)}`);
  }
  if (needs.includes('footerLinks')) {
    endpoints.add('GET /api/footer-links -> FooterColumn[]');
    entityLines.push(`- FooterColumn: ${FOOTER_COLUMN_INTERFACE}`);
  }
  if (needs.includes('comments')) {
    endpoints.add('GET /api/comments?slug=${slug} -> Comment[]');
    endpoints.add(
      'GET /api/comments/submissions?slug=${slug}&clientToken=${token} -> CommentSubmission[]',
    );
    endpoints.add('POST /api/comments');
    entityLines.push(`- Comment: ${formatContractFields(COMMENT_FIELDS)}`);
  }
  if (needs.includes('categoryDetail')) {
    endpoints.add('GET /api/taxonomies/category -> Term[]');
    endpoints.add('GET /api/taxonomies/category/${slug}/posts -> Post[]');
  }
  if (isArchiveAlias) {
    endpoints.add('GET /api/posts?author=${slug} -> Post[]');
    endpoints.add('GET /api/taxonomies/category -> Term[]');
    endpoints.add('GET /api/taxonomies/category/${slug}/posts -> Post[]');
    endpoints.add('GET /api/taxonomies/post_tag -> Term[]');
    endpoints.add('GET /api/taxonomies/post_tag/${slug}/posts -> Post[]');
  }

  if (endpoints.size > 0) {
    lines.push('### Endpoints');
    for (const endpoint of endpoints) lines.push(`- ${endpoint}`);
  }

  if (entityLines.length > 0) {
    lines.push('');
    lines.push('### Entity fields');
    lines.push(...entityLines);
  }

  lines.push('');
  lines.push('### Non-negotiable constraints');
  lines.push(
    '- Use flat REST fields only. Do NOT invent `.node`, `.nodes`, `.edges`, or `.rendered` wrappers.',
  );
  lines.push(
    '- Pages must NOT use post-only fields such as `author`, `categories`, `tags`, `date`, `excerpt`, or `comments`.',
  );
  lines.push(
    '- `post.content` and `page.content` are normalized HTML strings ready for `dangerouslySetInnerHTML`.',
  );
  lines.push(
    '- In ordinary post meta/listings, author names should link to `/author/${post.authorSlug}` when that route is approved and `post.authorSlug` exists. Plain-text `post.author` is only acceptable when it is the actual page/article/archive title or heading (for example an `h1`).',
  );
  lines.push(
    '- If the contract/known routes approve `/category/:slug`, category labels in post meta/listings must link to that route using `post.categorySlugs[index]` alongside `post.categories[index]` when the slug exists. Do NOT guess a slug from display text; if the slug is unavailable, render plain text instead of any fake link.',
  );
  lines.push(
    '- CRITICAL: in post cards, archive rows, search results, recent-post lists, bylines, and any non-heading meta UI, do NOT render bare `<span>{post.author}</span>`, `<span>{post.categories[0]}</span>`, or `post.categories?.map((cat, i) => <span>{cat}</span>)` when the matching `post.authorSlug` or `post.categorySlugs[i]` exists. Those labels must be `<Link>` archive links. Only keep plain text when the label itself is the real heading/title content.',
  );
  lines.push(
    '- Post titles, recent-post titles, search results, and page-list/sidebar titles must link to their canonical detail routes (`/post/${post.slug}` or `/page/${page.slug}`) when those routes are part of the approved app contract.',
  );
  lines.push(
    '- Visible text links for post titles, author/category archive links inside meta rows, menus, footer lists, sidebar lists, breadcrumbs, and social/footer text links must underline on hover (for example `hover:underline underline-offset-4`). CTA buttons and logo/brand links (the `<Link to="/">` wrapping the site logo + site name in the header) are exempt — do NOT add `hover:underline` to logo links.',
  );
  lines.push(
    '- Use `menu.items[].target` for external anchors; when it is `_blank`, also set `rel="noopener noreferrer"`.',
  );
  if (isArchiveAlias) {
    lines.push(
      '- Archive fallback contract: this component must handle `/archive`, `/category/:slug`, `/author/:slug`, and `/tag/:slug` by reading `location.pathname` plus the optional `slug` param.',
    );
    lines.push(
      '- For `/category/:slug`, fetch `GET /api/taxonomies/category/${slug}/posts` and render a primary heading beginning with the literal text `Category:` followed by the term label.',
    );
    lines.push(
      '- For `/author/:slug`, fetch `GET /api/posts?author=${slug}` and render a primary heading beginning with the literal text `Author:`.',
    );
    lines.push(
      '- For `/tag/:slug`, fetch `GET /api/taxonomies/post_tag/${slug}/posts` and render a primary heading beginning with the literal text `Tag:`.',
    );
    lines.push(
      '- Only the plain `/archive` fallback may use a generic `Archive` title.',
    );
  }

  return lines.join('\n');
}

export function buildMenusNote(menus: WpMenu[]): string {
  if (!menus || menus.length === 0) return '';
  const lines = ['## Available menus — fetch at runtime via GET /api/menus'];
  for (const m of menus) {
    const preview = m.items
      .slice(0, 4)
      .map((i) => i.title)
      .join(', ');
    const suffix = m.items.length > 4 ? ` +${m.items.length - 4} more` : '';
    lines.push(
      `- slug: \`${m.slug}\` | "${m.name}" | ${m.items.length} items: ${preview}${suffix}`,
    );
  }
  lines.push(
    "→ Select menus by `location` first. Use `menus.find(m => m.location === 'primary') ?? menus.find(m => m.slug === 'primary') ?? menus[0]` only as a primary-nav fallback. Do NOT guess content menus by arbitrary slugs such as `about` or `resources`.",
  );
  lines.push(
    "→ If the approved visual plan names a specific header/navigation `menuSlug`, you MUST select that menu first via `menus.find(m => m.location === '<menuSlug>') ?? menus.find(m => m.slug === '<menuSlug>')` before any generic `primary` fallback.",
  );
  return lines.join('\n');
}

export function buildThemeTokensNote(tokens?: ThemeTokens): string {
  if (
    !tokens ||
    (tokens.fonts.length === 0 &&
      tokens.fontSizes.length === 0 &&
      tokens.colors.length === 0 &&
      tokens.spacing.length === 0 &&
      (tokens.gradients?.length ?? 0) === 0 &&
      (tokens.shadows?.length ?? 0) === 0 &&
      !tokens.defaults)
  )
    return '';

  const lines: string[] = [
    '## Theme design tokens — use these Tailwind classes',
  ];

  if (tokens.defaults) {
    const d = tokens.defaults;
    lines.push(
      '**Default colors** — apply these when a block has NO explicit `bgColor`/`textColor` attribute:',
    );
    if (d.bgColor) lines.push(`- Page/root background: \`bg-[${d.bgColor}]\``);
    if (d.textColor)
      lines.push(`- Body text (default): \`text-[${d.textColor}]\``);
    if (d.headingColor)
      lines.push(`- All headings (h1–h6): \`text-[${d.headingColor}]\``);
    if (d.linkColor) lines.push(`- Links (\`<a>\`): \`text-[${d.linkColor}]\``);
    if (d.captionColor)
      lines.push(`- Captions / secondary text: \`text-[${d.captionColor}]\``);
    if (d.buttonBgColor)
      lines.push(`- Button background: \`bg-[${d.buttonBgColor}]\``);
    if (d.buttonTextColor)
      lines.push(`- Button text: \`text-[${d.buttonTextColor}]\``);
    if (d.fontSize) lines.push(`- Default font size: \`text-[${d.fontSize}]\``);
    if (d.fontFamily)
      lines.push(
        `- Default font family: use \`style={{fontFamily:"${d.fontFamily}"}}\` on root wrapper`,
      );
    if (d.lineHeight)
      lines.push(
        `- Default line height: use \`style={{lineHeight:"${d.lineHeight}"}}\` on root wrapper`,
      );
    if (d.letterSpacing)
      lines.push(
        `- Default letter spacing: use \`style={{letterSpacing:"${d.letterSpacing}"}}\` on root wrapper`,
      );
    if (d.textTransform)
      lines.push(
        `- Default text transform: \`${d.textTransform}\` on body text`,
      );
    if (d.buttonBoxShadow)
      lines.push(
        `- Button box shadow: use \`style={{boxShadow:"${d.buttonBoxShadow}"}}\` on buttons`,
      );
    if (d.contentWidth)
      lines.push(
        `- Content max-width: \`max-w-[${d.contentWidth}]\` on long-form content wrappers only (article/page body, comments, prose). Do NOT use this as the full-page or full-section container by default.`,
      );
    if (d.wideWidth)
      lines.push(
        `- Wide content max-width: \`max-w-[${d.wideWidth}]\` on wide/full-width blocks`,
      );
    if (d.buttonBorderRadius)
      lines.push(
        `- Button border radius: \`rounded-[${d.buttonBorderRadius}]\``,
      );
    if (d.buttonPadding)
      lines.push(
        `- Button padding: use \`style={{padding:"${d.buttonPadding}"}}\``,
      );
    if (d.blockGap)
      lines.push(
        `- Default block gap: \`${d.blockGap}\` — apply it where the WordPress source actually shows sibling block spacing. Use it on inner flex/grid containers with no explicit gap, but do NOT blindly force one global root \`gap-[${d.blockGap}]\` between every tracked top-level section when that would split a single contiguous source group into separate visual bands.`,
      );
    if (d.rootPadding)
      lines.push(
        `- Theme root/site padding exists: \`${d.rootPadding}\`. Treat this as a site-shell hint only. Do NOT apply it to every generated component root or page wrapper.`,
      );
    if (d.headings && Object.keys(d.headings).length > 0) {
      lines.push(
        '**Heading typography** — apply per heading level (in addition to heading color above):',
      );
      for (const [level, style] of Object.entries(d.headings)) {
        const parts: string[] = [];
        if (style.fontSize) parts.push(`size: \`text-[${style.fontSize}]\``);
        if (style.fontWeight)
          parts.push(`weight: \`font-[${style.fontWeight}]\``);
        if (parts.length > 0)
          lines.push(`- \`<${level}>\`: ${parts.join(', ')}`);
      }
    }
  }

  if (tokens.fonts.length > 0) {
    lines.push(
      '**Font families** — use `style={{fontFamily:"..."}}` (Tailwind arbitrary font-family is unreliable):',
    );
    for (const f of tokens.fonts) {
      lines.push(`- slug \`${f.slug}\` → \`${f.family}\` (${f.name})`);
    }
  }

  if (tokens.fontSizes.length > 0) {
    lines.push(
      '**Font sizes** — when a block has a `fontSize` slug, use Tailwind arbitrary value `text-[size]`:',
    );
    for (const s of tokens.fontSizes) {
      lines.push(`- slug \`${s.slug}\` → \`text-[${s.size}]\``);
    }
  }

  if (tokens.colors.length > 0) {
    lines.push(
      '**Colors** — `bgColor`/`textColor`/`overlayColor` fields extracted from the template source are already resolved to hex. Apply them directly:',
    );
    lines.push(
      '- `bgColor` → prefer `bg-[#hex]`; use `style={{backgroundColor:"#hex"}}` only when the value is dynamic',
    );
    lines.push(
      '- `textColor` → prefer `text-[#hex]`; use `style={{color:"#hex"}}` only when the value is dynamic',
    );
    lines.push('- Palette values available from the theme tokens:');
    for (const c of tokens.colors) {
      lines.push(`  - slug \`${c.slug}\` → \`${c.value}\``);
    }
  }

  if (tokens.gradients && tokens.gradients.length > 0) {
    lines.push(
      '**Gradients** — use `style={{background:"<value>"}}` for gradient backgrounds:',
    );
    for (const g of tokens.gradients) {
      lines.push(`- slug \`${g.slug}\` → \`${g.value}\``);
    }
  }

  if (tokens.shadows && tokens.shadows.length > 0) {
    lines.push('**Shadows** — use `style={{boxShadow:"<value>"}}`:');
    for (const s of tokens.shadows) {
      lines.push(`- slug \`${s.slug}\` → \`${s.value}\``);
    }
  }

  if (tokens.spacing.length > 0) {
    lines.push(
      '**Spacing** — when template uses `var:preset|spacing|N` or `var(--wp--preset--spacing--N)`, use Tailwind arbitrary value `p-[size]` / `py-[size]` / `px-[size]` / `gap-[size]`:',
    );
    for (const s of tokens.spacing) {
      lines.push(`- slug \`${s.slug}\` → \`${s.size}\``);
    }
  }

  if (tokens.interactions) {
    const interactionLines = buildInteractionTokensLines(tokens.interactions);
    if (interactionLines.length > 0) {
      lines.push(...interactionLines);
    }
  }

  if (tokens.blockStyles && Object.keys(tokens.blockStyles).length > 0) {
    lines.push(
      '**Per-block-type styles** — apply these to ALL elements of that block type unless the block has an explicit override:',
    );
    for (const [blockType, style] of Object.entries(tokens.blockStyles)) {
      const parts: string[] = [];
      if (style.color?.text) parts.push(`text \`text-[${style.color.text}]\``);
      if (style.color?.background)
        parts.push(`bg \`bg-[${style.color.background}]\``);
      if (style.typography?.fontSize)
        parts.push(`size \`text-[${style.typography.fontSize}]\``);
      if (style.typography?.fontFamily)
        parts.push(
          `font \`style={{fontFamily:"${style.typography.fontFamily}"}}\``,
        );
      if (style.typography?.fontWeight)
        parts.push(`weight \`font-[${style.typography.fontWeight}]\``);
      if (style.typography?.letterSpacing)
        parts.push(`tracking \`tracking-[${style.typography.letterSpacing}]\``);
      if (style.typography?.lineHeight)
        parts.push(`leading \`leading-[${style.typography.lineHeight}]\``);
      if (style.typography?.textTransform)
        parts.push(`text-transform \`${style.typography.textTransform}\``);
      if (style.shadow)
        parts.push(`box-shadow \`style={{boxShadow:"${style.shadow}"}}\``);
      if (style.border?.radius)
        parts.push(`rounded \`rounded-[${style.border.radius}]\``);
      if (style.border?.width)
        parts.push(`border-width \`border-[${style.border.width}]\``);
      if (style.border?.style)
        parts.push(`border-style \`${style.border.style}\``);
      if (style.border?.color)
        parts.push(`border-color \`border-[${style.border.color}]\``);
      if (style.spacing?.gap) parts.push(`gap \`gap-[${style.spacing.gap}]\``);
      if (style.spacing?.padding)
        parts.push(`padding \`style={{padding:"${style.spacing.padding}"}}\``);
      if (style.spacing?.margin)
        parts.push(`margin \`style={{margin:"${style.spacing.margin}"}}\``);
      if (parts.length > 0)
        lines.push(`- \`${blockType}\`: ${parts.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function buildInteractionStateProps(state: ThemeInteractionState): string[] {
  const parts: string[] = [];
  if (state.transition)
    parts.push(`transition: \`style={{transition:"${state.transition}"}}\``);
  if (state.transform)
    parts.push(`transform: \`style={{transform:"${state.transform}"}}\``);
  if (state.backgroundColor)
    parts.push(
      `bg: \`hover:bg-[${state.backgroundColor}]\` or \`style={{backgroundColor:"${state.backgroundColor}"}}\``,
    );
  if (state.color)
    parts.push(
      `color: \`hover:text-[${state.color}]\` or \`style={{color:"${state.color}"}}\``,
    );
  if (state.opacity)
    parts.push(`opacity: \`hover:opacity-[${state.opacity}]\``);
  if (state.boxShadow)
    parts.push(`shadow: \`style={{boxShadow:"${state.boxShadow}"}}\``);
  if (state.textDecoration)
    parts.push(`text-decoration: \`${state.textDecoration}\``);
  return parts;
}

function buildInteractionStyleLines(
  label: string,
  style: ThemeInteractionStyle,
): string[] {
  const lines: string[] = [];
  if (style.base) {
    const parts = buildInteractionStateProps(style.base);
    if (parts.length > 0) lines.push(`  - base: ${parts.join(', ')}`);
  }
  if (style.hover) {
    const parts = buildInteractionStateProps(style.hover);
    if (parts.length > 0) lines.push(`  - hover: ${parts.join(', ')}`);
  }
  if (style.focus) {
    const parts = buildInteractionStateProps(style.focus);
    if (parts.length > 0) lines.push(`  - focus: ${parts.join(', ')}`);
  }
  if (style.active) {
    const parts = buildInteractionStateProps(style.active);
    if (parts.length > 0) lines.push(`  - active: ${parts.join(', ')}`);
  }
  if (lines.length === 0) return [];
  return [`- **${label}**:`, ...lines];
}

function buildInteractionTokensLines(
  interactions: ThemeInteractionTokens,
): string[] {
  const lines: string[] = [];

  if (interactions.button) {
    const styleLines = buildInteractionStyleLines(
      'button',
      interactions.button,
    );
    if (styleLines.length > 0) lines.push(...styleLines);
  }

  if (interactions.precise && interactions.precise.length > 0) {
    const cardBridges = interactions.precise.filter((b) => b.target === 'card');
    const otherBridges = interactions.precise.filter(
      (b) => b.target !== 'card',
    );

    if (cardBridges.length > 0) {
      lines.push(
        '**Card interaction bridges** — for each bridge below, place the EXACT class name on the outermost wrapper element of every repeating card/item (not a child). The CSS for these classes is pre-generated; do NOT re-implement via Tailwind `hover:` or `onMouseEnter`:',
      );
      for (const bridge of cardBridges) {
        const styleLines = buildInteractionStyleLines(
          `card (.${bridge.className})`,
          bridge,
        );
        if (styleLines.length > 0) lines.push(...styleLines);
      }
    }

    for (const bridge of otherBridges) {
      const styleLines = buildInteractionStyleLines(
        `${bridge.target} (.${bridge.className})`,
        bridge,
      );
      if (styleLines.length > 0) lines.push(...styleLines);
    }
  }

  if (lines.length === 0) return [];

  return [
    '**Interaction styles from theme** — apply these hover/focus/active states to matching elements. Use Tailwind `hover:` variants when the value maps cleanly; otherwise use inline `style` with `onMouseEnter`/`onMouseLeave` state:',
    ...lines,
    '  ↳ Always add the `base` transition FIRST on the element className/style so hover changes animate smoothly.',
  ];
}

function buildTemplateTextsNote(templateSource: string): string {
  const toBulletList = (texts: string[], title: string): string => {
    const unique = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
    if (unique.length === 0) return '';
    const lines = unique.slice(0, MAX_TEMPLATE_TEXT_ITEMS).map((t) => `- ${t}`);
    if (unique.length > MAX_TEMPLATE_TEXT_ITEMS) {
      lines.push(`- ... and ${unique.length - MAX_TEMPLATE_TEXT_ITEMS} more`);
    }
    return `${title}\n${lines.join('\n')}\n`;
  };

  try {
    const nodes: WpNode[] = JSON.parse(templateSource);
    return toBulletList(
      extractTexts(nodes),
      '## Static source-backed text / HTML snippets — preserve EXACT wording and structure',
    );
  } catch {
    // Raw block markup: parse it back into nodes so lists/inline HTML survive.
    try {
      if (templateSource.includes('<!-- wp:')) {
        const nodes = wpBlocksToJsonWithSourceRefs({
          markup: templateSource,
          templateName: 'prompt-source',
          sourceFile: 'prompt-source.html',
        });
        return toBulletList(
          extractTexts(nodes),
          '## Static source-backed text / HTML snippets — preserve EXACT wording and structure',
        );
      }
    } catch {
      // Fall back to generic HTML stripping below.
    }

    // Classic PHP theme: templateSource is HTML with {/* WP: ... */} hints.
    // Extract any visible static text that survived PHP stripping.
    const stripped = templateSource
      .replace(/\{\/\*\s*WP:[^*]*\*\/\}/g, '') // remove WP hint comments
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    const plain = stripTags(stripped).replace(/\s+/g, ' ').trim();
    if (!plain) return '';
    const texts = plain
      .split(/\s{3,}/)
      .map((t) => t.trim())
      .filter((t) => t.length > 3 && t.length < 400);
    return toBulletList(
      texts,
      '## Static text extracted from classic PHP template — preserve EXACT wording',
    );
  }
}

function buildSourceFidelityNote(templateSource: string): string {
  const lines = ['## Source fidelity — CRITICAL'];
  lines.push(
    '- Treat the provided template source at the end of this prompt as the canonical WordPress source. The approved visual plan only constrains/labels it; the source still wins for exact content structure.',
  );
  lines.push(
    '- Preserve HTML semantics from the source exactly when present: real lists stay `<ul>/<ol>/<li>`, emphasized text stays `<strong>/<b>/<em>`, line breaks stay line breaks, and inline links stay links.',
  );
  lines.push(
    '- Do NOT flatten structured source into generic paragraphs. If the source shows a list, button group, accordion body, slider copy, or multi-line rich text, reproduce that structure in React.',
  );
  lines.push(
    '- Use source-backed colors, spacing, classes, images, and block ordering before guessing. If the source proves a value or structure, do not replace it with a prettier approximation.',
  );

  if (templateSource.includes('<!-- wp:')) {
    lines.push(
      '- This source is raw WordPress block markup. Read the real block HTML/comments carefully and preserve nested group/columns/media structure instead of collapsing it into a simpler layout.',
    );
  }

  return lines.join('\n');
}

/**
 * Injects explicit rules when the template is a classic PHP theme
 * (identified by {/* WP: ... *\/} hint comments instead of a JSON block tree).
 */
function buildClassicThemeNote(
  templateSource: string,
  isSingle: boolean,
  isPage: boolean,
  isPageComponent: boolean = false,
): string {
  if (!templateSource.includes('{/* WP:')) return '';

  const contentHint =
    isSingle || isPage
      ? `- \`{/* WP: post.content (HTML) */}\` → render \`${isSingle ? 'post' : 'page'}?.content\` with \`dangerouslySetInnerHTML={{ __html: ${isSingle ? 'post' : 'page'}?.content ?? '' }}\` (NO fetch array). If the HTML may include interactive plugin blocks such as Spectra/UAGB tabs, wrap it in a small content hydrator so \`.wp-block-uagb-tabs\` behaves like real tabs instead of a static list. Preserve WordPress tab states too: tab labels may be underlined by default, but hover/focus should remove that underline and keyboard focus should show a clear tab border/outline.`
      : `- \`{/* WP: post.content (HTML) */}\` → render content ONLY from the endpoint(s) explicitly approved in the component plan. ⛔ NEVER fetch a full list and pick \`pages[0]\` or \`posts[0]\`.`;

  const loopHint =
    isSingle || isPage
      ? `- \`{/* WP: loop start */}\` → (Single view) Render the specific \`${isSingle ? 'post' : 'page'}\` properties. NO loop / array map.`
      : `- \`{/* WP: loop start */}\` → fetch \`GET /api/posts?page=<n>&perPage=<n>\` (or the appropriate archive variant) and map over results. Paginated responses still return \`Post[]\`; page metadata comes from response headers.`;

  // For PAGE components, the shared Layout wrapper handles Header/Footer chrome.
  // Suppress those hints so the AI does not fetch site-info/menus or render site chrome.
  const headerHint = isPageComponent
    ? `- \`{/* WP: <Header /> */}\` → ⛔ SKIP entirely — this is a PAGE component; the shared Layout wrapper renders the site header. Do NOT fetch site-info or menus for it.`
    : `- \`{/* WP: <Header /> */}\` → render the visible brand as ONE home link (\`<Link to="/" className="flex items-center ...">{siteInfo.logoUrl && <img ... />}<span>{siteInfo.siteName}</span></Link>\`) + fetch \`GET /api/menus\` and render ALL returned nav items. Preserve any logo sizing that comes from the source block/template; otherwise use a reasonable visible fallback and do NOT arbitrarily shrink or enlarge it.`;
  const footerHint = isPageComponent
    ? `- \`{/* WP: <Footer /> */}\` → ⛔ SKIP entirely — this is a PAGE component; the shared Layout wrapper renders the site footer. Do NOT fetch site-info or footer-links for it.`
    : `- \`{/* WP: <Footer /> */}\` → if you render a visible site brand, keep logo + title inside ONE home link (\`<Link to="/" className="flex items-center ...">{siteInfo.logoUrl && <img ... />}<span>{siteInfo.siteName}</span></Link>\`) + fetch \`GET /api/footer-links\` for footer columns. Preserve any footer logo sizing that comes from the source block/template, even when it is small like \`20\`. Only use a generic visible fallback when the source does not specify size.`;

  return `## CLASSIC PHP THEME — MANDATORY RULES
This template source is from a **classic PHP theme** (identified by \`{/* WP: ... */}\` hint comments, NOT a JSON block tree).

### What each hint means — follow exactly:
${headerHint}
- \`{/* WP: <Navigation /> */}\` → fetch \`GET /api/menus\` and render ALL items — **NEVER write \`{/* No menus available */}\`**
${contentHint}
${loopHint}
- \`{/* WP: post.title */}\` → render title from fetched data
- \`{/* WP: post.excerpt */}\` → render excerpt from fetched data
${footerHint}

### ⛔ ABSOLUTE PROHIBITIONS for classic PHP themes:
1. **NEVER invent hero headings** like "Discover Your Next Adventure", "Build Something Amazing", etc. — these are FABRICATIONS
2. **NEVER write \`{/* No menus available */}\`** — if you fetch \`GET /api/menus\` and it returns items, you MUST render them
3. **NEVER hardcode paragraph text** like "Explore the world through our curated collection..." — all body text comes from API
4. **NO static hero section** unless the static text explicitly appears in the template source (after PHP stripping) in the \`## Static text\` list above
`;
}

// ── Data Grounding ─────────────────────────────────────────────────────────

export function buildDataGroundingNote(
  content: DbContentResult,
  options?: { dataNeeds?: string[] },
): string {
  const { siteInfo, posts, pages, menus, taxonomies } = content;
  const parts: string[] = [];
  const dataNeeds = options?.dataNeeds ?? [];
  const wantsSiteInfo = dataNeeds.includes('siteInfo');
  const wantsPosts = hasAnyDataNeed(
    dataNeeds,
    'posts',
    'postDetail',
    'comments',
    'authorDetail',
  );
  const wantsPages = hasAnyDataNeed(dataNeeds, 'pages', 'pageDetail');
  const wantsMenus = dataNeeds.includes('menus');
  const wantsFooterLinks = dataNeeds.includes('footerLinks');
  const wantsComments = dataNeeds.includes('comments');
  const wantsTaxonomies = hasAnyDataNeed(
    dataNeeds,
    'posts',
    'postDetail',
    'categoryDetail',
  );

  parts.push(
    `## ACTUAL DATA from this site — grounded to ${API_CONTRACT_SOURCE_PATH}`,
  );
  parts.push('');
  parts.push(
    '> Only use fields shown below. Any field not listed here does NOT exist.',
  );
  parts.push(`> Posts have: ${formatContractFields(POST_FIELDS)}.`);
  parts.push(`> Pages have: ${formatContractFields(PAGE_FRONTEND_FIELDS)}.`);
  parts.push(
    '> ⛔ Pages do NOT have: excerpt, date, author, categories, tags, comments.',
  );
  parts.push(
    '> ⛔ NEVER render siteName more than once per component — one element only.',
  );
  parts.push(
    '> If shared chrome renders `siteInfo.logoUrl` and/or `siteInfo.siteName`, the visible brand must navigate home as a single clickable cluster. Prefer one `<Link to="/">` that wraps both logo and title.',
    '> Shared chrome logo sizing is source-driven per block/partial. Preserve explicit width/height from the parsed WordPress source when available.',
    '> Only when the source does not specify logo size should you fall back to a generic visible size such as `h-auto max-h-[72px] max-w-[240px] object-contain`.',
  );
  parts.push('');

  if (wantsSiteInfo) {
    parts.push('### Site info (GET /api/site-info)');
    parts.push(
      `${SITE_INFO_FIELDS[1]}: "${siteInfo.siteName}" | ${SITE_INFO_FIELDS[0]}: "${siteInfo.siteUrl}" | ${SITE_INFO_FIELDS[2]}: "${siteInfo.blogDescription}" | ${SITE_INFO_FIELDS[3]}: "${siteInfo.logoUrl ?? '(none)'}"`,
    );
    parts.push('');
  }

  if (wantsPosts) {
    const postSample = posts.slice(0, MAX_SAMPLE_ITEMS);
    parts.push(
      `### Posts — ${posts.length} total (GET /api/posts)` +
        (posts.length === 0 ? ' — NONE, do NOT invent posts' : ''),
    );
    for (const p of postSample) {
      parts.push(`- id:${p.id} slug:"${p.slug}" title:"${p.title}"`);
    }
    if (posts.length > MAX_SAMPLE_ITEMS) {
      parts.push(`- ... and ${posts.length - MAX_SAMPLE_ITEMS} more`);
    }
    if (posts.length === 0) parts.push('- (empty)');
    parts.push('');
  }

  if (wantsPages) {
    const pageSample = pages.slice(0, MAX_SAMPLE_ITEMS);
    parts.push(
      `### Pages — ${pages.length} total (GET /api/pages)` +
        (pages.length === 0 ? ' — NONE, do NOT invent pages' : ''),
    );
    for (const p of pageSample) {
      parts.push(`- id:${p.id} slug:"${p.slug}" title:"${p.title}"`);
    }
    if (pages.length > MAX_SAMPLE_ITEMS) {
      parts.push(`- ... and ${pages.length - MAX_SAMPLE_ITEMS} more`);
    }
    if (pages.length === 0) parts.push('- (empty)');
    parts.push('');
  }

  if (wantsMenus) {
    parts.push(
      `### Menus — ${menus.length} total (GET /api/menus)` +
        (menus.length === 0 ? ' — NONE, do NOT invent nav links' : ''),
    );
    parts.push(
      `> Menu fields: ${formatContractFields(MENU_FIELDS)} | MenuItem fields: ${formatContractFields(MENU_ITEM_FIELDS)}.`,
    );
    parts.push(
      '> IMPORTANT: `item.url` from `/api/menus` is already the canonical app path for internal links. Use `<Link to={item.url}>` directly. NEVER prepend `/page`, `/post`, or any extra route segment to `item.url`.',
    );
    parts.push(
      '> Menu, footer, and sidebar text links should visibly underline on hover (`hover:underline underline-offset-4`) to preserve expected WordPress-style navigation behavior. The logo/brand link (the `<Link to="/">` that wraps the site logo image and site name) is NOT a text link — do NOT add `hover:underline` to it.',
    );
    for (const m of menus) {
      const itemPreview = m.items
        .slice(0, MAX_SAMPLE_ITEMS)
        .map((item) => item.title)
        .join(', ');
      const extra =
        m.items.length > MAX_SAMPLE_ITEMS
          ? ` +${m.items.length - MAX_SAMPLE_ITEMS} more`
          : '';
      parts.push(
        `- menu slug:"${m.slug}" location:"${m.location ?? 'null'}" name:"${m.name}" — items: ${itemPreview || '(empty)'}${extra}`,
      );
    }
    if (menus.length === 0) parts.push('- (empty)');
    parts.push('');
  }

  if (wantsFooterLinks) {
    parts.push('### Footer links (GET /api/footer-links)');
    parts.push(
      '- FooterColumn shape: `{ heading: string; links: { label: string; url: string }[] }`.',
    );
    parts.push(
      '- Use footer link columns from this endpoint for Footer partials. Do NOT substitute `/api/menus`.',
    );
    parts.push('');
  }

  if (wantsComments) {
    parts.push(
      `### Comments contract (GET /api/comments) — fields: ${formatContractFields(COMMENT_FIELDS)}`,
    );
    parts.push(
      'Use `comment.author` and `comment.content` directly; moderation polling uses `/api/comments/submissions`.',
    );
    parts.push('');
  }

  if (wantsTaxonomies && taxonomies && taxonomies.length > 0) {
    parts.push(
      `### Taxonomies — ${taxonomies.length} type(s) (GET /api/taxonomies)`,
    );
    parts.push(
      '> Use taxonomy slugs for archive routes only when those routes are explicitly approved.',
    );
    for (const tax of taxonomies) {
      const termPreview = tax.terms
        .slice(0, MAX_TAXONOMY_TERMS)
        .map((t) => `"${t.slug}"(${t.count})`)
        .join(', ');
      const suffix =
        tax.terms.length > MAX_TAXONOMY_TERMS
          ? ` +${tax.terms.length - MAX_TAXONOMY_TERMS} more`
          : '';
      parts.push(
        `- taxonomy:"${tax.taxonomy}" — ${tax.terms.length} terms: ${termPreview}${suffix}`,
      );
    }
  }

  return parts.join('\n');
}

export function buildPlanContextNote(
  plan?: {
    description?: string;
    dataNeeds?: string[];
    route?: string | null;
    type?: 'page' | 'partial';
    requiredCustomClassNames?: string[];
    sourceBackedAuxiliaryLabels?: string[];
    visualPlan?: ComponentVisualPlan;
  },
  componentName?: string,
): string {
  if (!plan) return '';
  const lines: string[] = ['## Component plan'];
  const normalizedDataNeeds = normalizeDataNeeds(plan.dataNeeds);
  const isArchiveAlias = isArchiveAliasComponent(componentName, plan.route);
  if (plan.description) lines.push(`Purpose: ${plan.description}`);
  if (plan.route) {
    lines.push(`Route: \`${plan.route}\``);
    lines.push(
      /:[A-Za-z_]/.test(plan.route)
        ? 'Route contract: only read the URL params declared in this route.'
        : 'Route contract: this route has no URL params, so do NOT import or call `useParams`.',
    );
  }
  if (normalizedDataNeeds.length > 0)
    lines.push(`Data needed: ${normalizedDataNeeds.join(', ')}`);
  lines.push('');
  lines.push(
    buildAllowedEndpointsNote({
      dataNeeds: normalizedDataNeeds,
      route: plan.route,
      visualPlan: plan.visualPlan,
      componentName,
    }),
  );
  lines.push('');
  lines.push(
    buildForbiddenBehaviorNote({
      type: plan.type,
      dataNeeds: normalizedDataNeeds,
      route: plan.route,
    }),
  );
  const routeHasParams = /:[A-Za-z_]/.test(plan.route ?? '');
  if (normalizedDataNeeds.includes('postDetail')) {
    lines.push(
      routeHasParams
        ? 'Detail data contract: fetch the specific post with `/api/posts/${slug}` and render that record, not the full posts list.'
        : 'Data contract: this component does not own a slug route. Do NOT fabricate post detail by fetching `/api/posts` and picking an item by index, title, or guesswork.',
    );
  }
  if (normalizedDataNeeds.includes('pageDetail')) {
    lines.push(
      routeHasParams
        ? 'Detail data contract: fetch the specific page with `/api/pages/${slug}` and render that record, not the full pages list.'
        : 'Data contract: this component does not own a slug route. Do NOT fabricate page detail by fetching `/api/pages` and picking an item by index, title, or guesswork.',
    );
    lines.push(
      '⛔ API endpoint contract: `/api/pages/${slug}` is mandatory for the main record. Do NOT replace it with `/api/pages` + index lookup.',
    );
    lines.push(
      '⛔ Page Detail Contract: a page has NO `author`, `categories`, `tags`, `date`, `excerpt`, or `comments`. Use page fields from the approved contract only.',
    );
    lines.push(
      '⛔ If you declare `interface Page`, it must match the approved Page contract exactly. Do NOT use `Post` type for pages.',
    );
    lines.push(
      '⛔ In ANY output, do not reference post-only page fields.' +
        '\n- Reject and rewrite if you detect: `page.author`, `page.categories`, `page.tags`, `page.date`, `page.excerpt`, `page.comments`.' +
        '\n- `page.featuredImage`, `page.parentId`, `page.menuOrder`, and `page.template` are allowed when the design actually needs them.' +
        '\n- If you need post-only metadata, use `Post` type in `postDetail` components, not `Page`.' +
        '\n- Page detail type must match the canonical Page interface from the API contract.',
    );
  }
  // Detect "NoTitle" naming convention — explicit contract to omit the title
  const isNoTitle =
    /no.?title/i.test(componentName ?? '') ||
    /without.{0,20}title|no.{0,10}title|omit.{0,10}title/i.test(
      plan?.description ?? '',
    );
  if (isNoTitle) {
    lines.push(
      '⛔ NoTitle contract: Do NOT render the page or post title in any heading element. ' +
        'No `<h1>{item.title}</h1>`, no `<h1>{page.title}</h1>`, no `{post.title}` as a heading. ' +
        'This template explicitly omits the title — render only the body content.',
    );
  }
  if (normalizedDataNeeds.includes('comments')) {
    lines.push(
      'Comments data contract: fetch `GET /api/comments?slug=${slug}` (use the post slug from `useParams`) inside the same `useEffect` as the post detail fetch. ' +
        'Comment fields: `id, author, date, content, parentId (0 = top-level), userId`. ' +
        'Render top-level comments first (`comment.parentId === 0`), then indent replies. ' +
        'Show a count (e.g. "3 Comments") and an empty state ("No comments yet") when the array is empty. ' +
        'If the approved comments section includes a reply form, create controlled form state, generate/store a stable `clientToken` in `localStorage`, submit with `POST /api/comments`, show an awaiting-moderation notice, and poll `GET /api/comments/submissions?slug=${slug}&clientToken=${clientToken}` until a submission becomes approved; only then should you refetch `GET /api/comments` so the public list updates. ' +
        'Do NOT use `comment.author_name` or `comment.author_avatar`; use `comment.author` and render a text/avatar fallback from initials if needed.',
    );
  }
  if (isArchiveAlias) {
    lines.push(
      'Archive alias contract: although the canonical plan route may be `/archive`, this component is also mounted at `/category/:slug`, `/author/:slug`, and `/tag/:slug` in the app router.',
    );
    lines.push(
      'Archive alias contract: for this component, DO import/use `useLocation` and `useParams<{ slug?: string }>()` to detect the active archive variant. Ignore the generic no-params rule for plain `/archive`.',
    );
    lines.push(
      'Heading contract: `/category/:slug` must render a primary heading that begins with the literal prefix `Category:` and the resolved term label, for example `Category: Uncategorized`.',
    );
    lines.push(
      'Heading contract: `/author/:slug` must render a primary heading that begins with `Author:`. `/tag/:slug` must render a primary heading that begins with `Tag:`.',
    );
    lines.push(
      'Fetch contract: `/category/:slug` -> `/api/taxonomies/category/${slug}/posts`; `/author/:slug` -> `/api/posts?author=${slug}`; `/tag/:slug` -> `/api/taxonomies/post_tag/${slug}/posts`; plain `/archive` may use `/api/posts`.',
    );
    lines.push(
      'Do NOT render a generic `Archive` heading on category/author/tag alias routes.',
    );
  }
  if (
    !normalizedDataNeeds.includes('postDetail') &&
    !normalizedDataNeeds.includes('pageDetail')
  ) {
    lines.push(
      'Data contract: do NOT fetch slug-based detail endpoints unless the plan explicitly requires detail data.',
    );
  }
  if (plan.type === 'page') {
    const allowedAuxiliaryLabels = mergeAuxiliaryLabels(
      plan.sourceBackedAuxiliaryLabels,
      extractAuxiliaryLabelsFromSections(plan.visualPlan?.sections),
    );
    lines.push('');
    lines.push('Auxiliary-section contract:');
    lines.push(
      `- Invalid invented auxiliary headings by default: ${formatInventedAuxiliarySectionLabels()}.`,
    );
    lines.push(
      allowedAuxiliaryLabels.length > 0
        ? `- Exact auxiliary labels allowed for this component because they are source-backed or already approved: ${allowedAuxiliaryLabels
            .map((label) => `\`${label}\``)
            .join(', ')}.`
        : '- No source-backed auxiliary labels were detected for this component. Treat those banned labels as invalid.',
    );
    lines.push(
      '- If the page is sparse, stop after the approved/source-backed content. Do NOT add generic About/Resources/Privacy-style filler sections at the end.',
    );
  }

  lines.push('');
  lines.push('## Fidelity goal');
  lines.push(
    '- This is a migration, not a redesign. Match the original WordPress structure and visual weight as closely as possible.',
  );
  lines.push(
    '- Preserve block order, wrapper hierarchy, spacing density, and section widths from the source template.',
  );
  lines.push(
    '- Keep sparse templates sparse. Do NOT modernize, center, enlarge, or decorate sections unless the source template already does that.',
  );
  lines.push(
    '- Typography fidelity matters: do NOT upscale headings, body copy, buttons, or menu text beyond the source template and theme tokens. If the source is modest WordPress typography, keep it modest.',
  );
  lines.push(
    '- Avoid oversized display classes like `text-[4rem]`, `text-[5rem]`, giant centered hero copy, or overly narrow text wrappers unless the approved visual plan explicitly requires that scale.',
  );
  lines.push(
    '- Preserve alignment fidelity from the source/approved plan. If a heading, intro block, meta row, or article title cluster is centered in WordPress, keep it centered in React instead of defaulting to `text-left`.',
  );
  lines.push(
    '- For single/detail article layouts, keep the title/meta cluster and the prose body in the SAME readable content column. Center the column on the page if needed, but keep the title and meta left-aligned within that column unless the source explicitly centers them. Concretely: a wrapper like `max-w-[620px] mx-auto w-full` is acceptable, but do NOT add `text-center`, `items-center`, or `justify-center` to the inner title/meta cluster when the source body column is left-aligned.',
  );
  lines.push(
    '- Preserve WordPress date/time display strings from the API as-is. Render `post.date`, `comment.date`, and similar runtime date fields directly unless the source explicitly provides a different formatted field. Do NOT wrap them in `new Date(...)`, `toLocaleDateString()`, `toLocaleString()`, or `Intl.DateTimeFormat(...)`.',
  );
  lines.push(
    '- Card-grid and repeated column copy must not collapse to browser-default sizing. If the theme body token is larger than 1rem (for example `text-[1.05rem]`), apply that scale or the source block typography to card body text instead of leaving it at the default browser size.',
  );
  lines.push(
    '- Use semantic HTML that matches the role of the original content (`<main>`, `<section>`, `<article>`, `<aside>`, `<nav>`).',
  );
  if (plan.requiredCustomClassNames?.length) {
    lines.push(
      `- Preserve these exact source custom classes in JSX \`className\` output whenever you render the corresponding source-backed elements: ${formatClassList(plan.requiredCustomClassNames)}.`,
    );
    lines.push(
      '- Do NOT rename, omit, hash, or replace those custom classes with new invented ones. Keep them alongside Tailwind utility classes.',
    );
  }

  return lines.join('\n');
}

function extractStaticImageSources(templateSource: string): string[] {
  const result = new Set<string>();
  const collectFromParsedNode = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const node = value as {
      src?: string;
      imageSrc?: string;
      children?: unknown[];
    };
    if (typeof node.src === 'string' && node.src.trim()) {
      result.add(node.src.trim());
    }
    if (typeof node.imageSrc === 'string' && node.imageSrc.trim()) {
      result.add(node.imageSrc.trim());
    }
    if (Array.isArray(node.children))
      node.children.forEach(collectFromParsedNode);
  };

  try {
    const parsed = JSON.parse(templateSource);
    if (Array.isArray(parsed)) parsed.forEach(collectFromParsedNode);
    else collectFromParsedNode(parsed);
  } catch {
    try {
      if (templateSource.includes('<!-- wp:')) {
        const nodes = wpBlocksToJsonWithSourceRefs({
          markup: templateSource,
          templateName: 'prompt-source',
          sourceFile: 'prompt-source.html',
        });
        nodes.forEach(collectFromParsedNode);
      }
    } catch {
      // Fall back to regex extraction below.
    }
    for (const match of templateSource.matchAll(
      /(?:src|imageSrc)="([^"]+)"/g,
    )) {
      if (match[1]) result.add(match[1].trim());
    }
    for (const match of templateSource.matchAll(/"src":"([^"]+)"/g)) {
      if (match[1]) result.add(match[1].trim());
    }
  }

  return [...result];
}

function buildImageSourcesNote(templateSource: string): string {
  const sources = extractStaticImageSources(templateSource);
  const lines = ['## Static image sources in this template'];

  if (sources.length === 0) {
    lines.push('- None. Do NOT invent images, avatars, or placeholders.');
  } else {
    for (const src of sources.slice(0, MAX_STATIC_IMAGE_HINTS)) {
      lines.push(`- ${src}`);
    }
    if (sources.length > MAX_STATIC_IMAGE_HINTS) {
      lines.push(`- ... and ${sources.length - MAX_STATIC_IMAGE_HINTS} more`);
    }
    lines.push('Use only these exact sources for static images and avatars.');
  }

  lines.push(
    '⛔ If a testimonial/person/media block has no image source in the template, omit the image/avatar entirely.',
  );
  lines.push(
    'For local paths (`/assets/...` or `/assets/images/...`): copy the path EXACTLY into your JSX `src` attribute.',
  );
  lines.push(
    'For full `http://` / `https://` URLs: use the EXACT full URL in your JSX `src` — do NOT shorten to just `/assets/filename`. These URLs are automatically relinked to local paths after generation.',
  );
  lines.push(
    'For important screenshot/product/composite images from the template source, preserve the full asset by default: prefer `w-full h-auto object-contain` (optionally with a max-height) instead of fixed-height `object-cover` cropping, unless the source itself is intentionally cropped.',
  );
  lines.push(
    'When a media-text/photo section in the source has a framed or rounded image, preserve that rounded treatment in React. Do not flatten it to a sharp-corner image unless the source is clearly square-edged.',
  );
  lines.push(
    'Preserve emphasis from the source: if a media-text heading or key list lines read as bold/strong in the template, keep them visually strong in JSX instead of downgrading everything to regular muted text.',
  );
  lines.push(
    'When a list item string contains HTML tags (e.g. `<strong>`, `<em>`, `<a>`), render it with `dangerouslySetInnerHTML={{ __html: item }}` on the `<li>` element instead of outputting the string as plain text. Example: `<li dangerouslySetInnerHTML={{ __html: "Trạng thái <strong>Đã thanh toán</strong>" }} />`.',
  );

  return lines.join('\n');
}

function buildCompactSectionSummary(
  visualPlan: ComponentVisualPlan,
  componentName?: string,
): string[] {
  return visualPlan.sections.map((section, index) => {
    const parts = [`- section ${index + 1}: type=${section.type}`];

    if (section.sectionKey) parts.push(`sectionKey=${section.sectionKey}`);
    if (section.sourceRef?.sourceNodeId) {
      parts.push(`sourceNodeId=${section.sourceRef.sourceNodeId}`);
    }

    switch (section.type) {
      case 'navbar':
        parts.push(`menuSlug=${section.menuSlug}`);
        parts.push(`sticky=${section.sticky}`);
        pushPlanTextPart(parts, 'ctaText', section.cta?.text);
        pushPlanTextPart(parts, 'ctaLink', section.cta?.link);
        pushPlanTextPart(parts, 'ctaStyle', section.cta?.style);
        break;
      case 'hero':
        parts.push(`layout=${section.layout}`);
        pushPlanTextPart(parts, 'heading', section.heading);
        pushPlanTextPart(parts, 'subheading', section.subheading);
        pushTypographyStyleParts(parts, 'headingStyle', section.headingStyle);
        pushTypographyStyleParts(
          parts,
          'subheadingStyle',
          section.subheadingStyle,
        );
        pushPlanTextPart(parts, 'ctaText', section.cta?.text);
        pushPlanTextPart(parts, 'ctaLink', section.cta?.link);
        pushPlanTextPart(parts, 'imageSrc', section.image?.src);
        pushPlanTextPart(parts, 'imageAlt', section.image?.alt);
        pushPlanTextPart(parts, 'imagePosition', section.image?.position);
        break;
      case 'sidebar':
        pushPlanTextPart(parts, 'title', section.title);
        parts.push(`showPages=${section.showPages}`);
        parts.push(`showPosts=${section.showPosts}`);
        parts.push(`showSiteInfo=${section.showSiteInfo}`);
        if (section.menuSlug) parts.push(`menuSlug=${section.menuSlug}`);
        if (section.maxItems) parts.push(`maxItems=${section.maxItems}`);
        break;
      case 'post-list':
        pushPlanTextPart(parts, 'title', section.title);
        parts.push(`layout=${section.layout}`);
        parts.push(`showDate=${section.showDate}`);
        parts.push(`showAuthor=${section.showAuthor}`);
        parts.push(`showCategory=${section.showCategory}`);
        parts.push(`showExcerpt=${section.showExcerpt}`);
        parts.push(`showFeaturedImage=${section.showFeaturedImage}`);
        break;
      case 'post-content':
        parts.push(`showTitle=${section.showTitle}`);
        parts.push(`showAuthor=${section.showAuthor}`);
        parts.push(`showDate=${section.showDate}`);
        parts.push(`showCategories=${section.showCategories}`);
        break;
      case 'page-content':
        parts.push(`showTitle=${section.showTitle}`);
        break;
      case 'cover':
        parts.push(`contentAlign=${section.contentAlign}`);
        parts.push(`minHeight=${section.minHeight}`);
        parts.push(`dimRatio=${section.dimRatio}`);
        pushPlanTextPart(parts, 'heading', section.heading);
        pushPlanTextPart(parts, 'subheading', section.subheading);
        pushTypographyStyleParts(parts, 'headingStyle', section.headingStyle);
        pushTypographyStyleParts(
          parts,
          'subheadingStyle',
          section.subheadingStyle,
        );
        pushPlanTextPart(parts, 'imageSrc', section.imageSrc);
        pushPlanTextPart(parts, 'ctaText', section.cta?.text);
        pushPlanTextPart(parts, 'ctaLink', section.cta?.link);
        break;
      case 'card-grid':
        pushPlanTextPart(parts, 'title', section.title);
        pushPlanTextPart(parts, 'subtitle', section.subtitle);
        parts.push(`columns=${section.columns}`);
        parts.push(`cardCount=${section.cards.length}`);
        section.cards.forEach((card, cardIndex) => {
          pushPlanTextPart(
            parts,
            `card${cardIndex + 1}Heading`,
            card.heading,
            140,
          );
          pushPlanTextPart(parts, `card${cardIndex + 1}Body`, card.body, 180);
        });
        break;
      case 'media-text':
        parts.push(`imagePosition=${section.imagePosition}`);
        pushPlanTextPart(parts, 'heading', section.heading);
        pushPlanTextPart(parts, 'body', section.body, 240);
        pushTypographyStyleParts(parts, 'headingStyle', section.headingStyle);
        pushTypographyStyleParts(parts, 'bodyStyle', section.bodyStyle);
        pushPlanTextPart(parts, 'imageSrc', section.imageSrc);
        pushPlanTextPart(parts, 'imageAlt', section.imageAlt);
        pushPlanListPart(parts, 'listItems', section.listItems, {
          maxItems: 10,
          maxChars: 160,
        });
        pushPlanTextPart(parts, 'ctaText', section.cta?.text);
        pushPlanTextPart(parts, 'ctaLink', section.cta?.link);
        break;
      case 'testimonial':
        pushPlanTextPart(parts, 'quote', section.quote, 240);
        pushPlanTextPart(parts, 'authorName', section.authorName);
        pushPlanTextPart(parts, 'authorTitle', section.authorTitle);
        pushPlanTextPart(parts, 'authorAvatar', section.authorAvatar);
        break;
      case 'newsletter':
        pushPlanTextPart(parts, 'heading', section.heading);
        pushPlanTextPart(parts, 'subheading', section.subheading);
        pushPlanTextPart(parts, 'buttonText', section.buttonText);
        parts.push(`layout=${section.layout}`);
        break;
      case 'footer':
        pushPlanTextPart(
          parts,
          'brandDescription',
          section.brandDescription,
          220,
        );
        pushPlanListPart(
          parts,
          'menuColumns',
          section.menuColumns.map(
            (column) => `${column.title || 'Untitled'} -> ${column.menuSlug}`,
          ),
        );
        pushPlanTextPart(parts, 'copyright', section.copyright);
        break;
      case 'search':
        pushPlanTextPart(parts, 'title', section.title);
        break;
      case 'comments':
        parts.push(`showForm=${section.showForm}`);
        parts.push(`requireName=${section.requireName}`);
        parts.push(`requireEmail=${section.requireEmail}`);
        break;
      case 'tabs':
        parts.push(`tabCount=${section.tabs.length}`);
        section.tabs.forEach((tab, tabIndex) => {
          pushPlanTextPart(parts, `tab${tabIndex + 1}Label`, tab.label);
          pushPlanTextPart(
            parts,
            `tab${tabIndex + 1}Content`,
            tab.content,
            180,
          );
        });
        break;
      case 'slider':
        parts.push(`slideCount=${section.slides.length}`);
        if (typeof section.autoplay === 'boolean') {
          parts.push(`autoplay=${section.autoplay}`);
        }
        section.slides.forEach((slide, slideIndex) => {
          pushPlanTextPart(
            parts,
            `slide${slideIndex + 1}Heading`,
            slide.heading,
          );
          pushPlanTextPart(
            parts,
            `slide${slideIndex + 1}Description`,
            slide.description,
            180,
          );
          pushPlanTextPart(
            parts,
            `slide${slideIndex + 1}CtaText`,
            slide.cta?.text,
          );
          pushPlanTextPart(
            parts,
            `slide${slideIndex + 1}CtaLink`,
            slide.cta?.link,
          );
        });
        break;
      case 'modal':
        pushPlanTextPart(parts, 'triggerText', section.triggerText);
        pushPlanTextPart(parts, 'heading', section.heading);
        pushPlanTextPart(parts, 'description', section.description, 220);
        pushPlanTextPart(parts, 'ctaText', section.cta?.text);
        pushPlanTextPart(parts, 'ctaLink', section.cta?.link);
        break;
      case 'accordion':
        parts.push(`itemCount=${section.items.length}`);
        section.items.forEach((item, itemIndex) => {
          pushPlanTextPart(parts, `item${itemIndex + 1}Title`, item.title);
          pushPlanTextPart(
            parts,
            `item${itemIndex + 1}Content`,
            item.content,
            180,
          );
        });
        break;
      case 'button-group':
        parts.push(`align=${section.align}`);
        section.buttons.forEach((button, buttonIndex) => {
          pushPlanTextPart(parts, `button${buttonIndex + 1}Text`, button.text);
          pushPlanTextPart(parts, `button${buttonIndex + 1}Link`, button.link);
        });
        break;
      default:
        break;
    }
    if (section.customClassNames?.length) {
      parts.push(
        `customClassNames=${formatClassList(section.customClassNames)}`,
      );
    }
    if (section.textAlign) {
      parts.push(`textAlign=${section.textAlign}`);
    }
    if (section.contentWidth) {
      parts.push(`contentWidth=${JSON.stringify(section.contentWidth)}`);
    }
    if (section.paddingStyle) {
      parts.push(`paddingStyle=${JSON.stringify(section.paddingStyle)}`);
    }
    if (section.gapStyle) {
      parts.push(`gapStyle=${JSON.stringify(section.gapStyle)}`);
    }
    if (section.marginStyle) {
      parts.push(`marginStyle=${JSON.stringify(section.marginStyle)}`);
    }
    if (section.sourceLayout) {
      parts.push(`sourceLayout=${formatSourceLayout(section.sourceLayout)}`);
    }

    if (componentName && section.sectionKey) {
      parts.push(
        `sectionComponent=${buildTrackedSectionComponentName(componentName, section.sectionKey)}`,
      );
    }

    return parts.join(' | ');
  });
}

export function buildVisualPlanContextNote(
  visualPlan?: ComponentVisualPlan,
  componentName?: string,
): string {
  if (!visualPlan) return '';

  const lines: string[] = [
    '## Approved visual plan from previous stage',
    'Treat this plan as the primary code generation blueprint.',
    'Preserve section order, required data dependencies, and the overall layout unless the template/data grounding above proves a field is impossible.',
    'Do NOT reinterpret this into a prettier or more modern layout. Preserve the original WordPress look and structure.',
  ];

  if (visualPlan.dataNeeds.length > 0) {
    lines.push(`Declared data needs: ${visualPlan.dataNeeds.join(', ')}`);
  }
  const requiredCustomClassNames = [
    ...new Set(
      visualPlan.sections.flatMap((section) => section.customClassNames ?? []),
    ),
  ];
  if (requiredCustomClassNames.length > 0) {
    lines.push(
      `Required custom classes from the source: ${formatClassList(requiredCustomClassNames)}.`,
    );
    lines.push(
      'Preserve these exact classes in the rendered JSX for the corresponding source-backed elements. Keep them as literal class tokens inside `className`.',
    );
    lines.push(
      'If a source-backed custom class comes from a Spectra/UAGB button, keep that exact class on the actual clickable `<button>`, `<a>`, or `<Link>` element whenever possible, not only on a surrounding wrapper. Those plugin classes may carry the real hover background/text/border interaction and must not be replaced by generic WordPress button styling alone.',
    );
    lines.push(
      'When a heading element carries the `is-style-asterisk` class and the section or its container uses centered alignment (`textAlign=center` / `text-center`), you MUST also add `text-center` directly on that heading element (e.g. `className="... text-center is-style-asterisk"`). The asterisk CSS uses a direct-child combinator so the heading must have `text-center` on itself to center the asterisk icon — inheriting it from a parent wrapper is NOT sufficient.',
    );
  }
  if (
    visualPlan.sections.some(
      (section) => section.textAlign || section.contentWidth,
    )
  ) {
    lines.push(
      'Preserve exact section-level alignment and constrained content widths from the approved plan. When a section says `textAlign=center`, apply real centered text classes to the actual heading/body elements, not just an outer wrapper. When a section says `textAlign=left`, do NOT sneak in `text-center`, `items-center`, or `justify-center` on the section intro/title/meta cluster. When a section says `contentWidth="620px"` (or similar), keep the readable inner text wrapper constrained to that exact max width instead of stretching it across the full section.',
    );
  }
  if (
    visualPlan.sections.some(
      (section) => section.paddingStyle || section.gapStyle,
    )
  ) {
    lines.push(
      'Preserve source-backed section spacing from the approved plan. When a section provides `paddingStyle` or `gapStyle`, keep that breathing room in the rendered JSX instead of collapsing the stack into a tight generic card.',
    );
    lines.push(
      'For centered `hero`/`newsletter` sections with heading + body/subheading + CTA, use real vertical spacing on the actual content stack (`flex flex-col` with `gap-*` / `space-y-*` or explicit margins). Do NOT fake spacing with empty spacer divs like `<div className="h-[1rem]" />`, and do NOT leave the button glued directly under the paragraph.',
    );
  }
  const navbarMenuSlugs = [
    ...new Set(
      visualPlan.sections
        .filter(
          (section): section is Extract<SectionPlan, { type: 'navbar' }> =>
            section.type === 'navbar' && !!section.menuSlug?.trim(),
        )
        .map((section) => section.menuSlug.trim()),
    ),
  ];
  if (navbarMenuSlugs.length > 0) {
    lines.push(
      `Header/navigation menu contract: the approved navbar must prefer these menu slug(s) before any generic fallback: ${navbarMenuSlugs
        .map((slug) => `\`${slug}\``)
        .join(
          ', ',
        )}. Select with \`menus.find(m => m.location === slug) ?? menus.find(m => m.slug === slug)\` first, then fall back to \`primary\` only if no approved slug matches.`,
    );
  }

  // Strict section whitelist — prevents AI from inventing extra sections
  if (visualPlan.sections?.length > 0) {
    const sectionTypes = visualPlan.sections
      .map((s) => `"${s.type}"`)
      .join(', ');
    lines.push('');
    lines.push(
      `⛔ STRICT SECTION CONTRACT: Generate ONLY these section types in this exact order: ${sectionTypes}.`,
    );
    lines.push(
      '⛔ Do NOT add newsletter, testimonial, hero, cover, card-grid, pricing, features, call-to-action, or ANY other section type not listed above — even if you think it would improve the design.',
    );
    lines.push(
      '⛔ If you are tempted to add a section that is not in the list above, STOP and omit it entirely.',
    );
    lines.push(
      '⛔ CONTENT FIDELITY: When the approved plan below includes concrete headings, card text, body copy, list items, CTA labels, image sources, or image alts, render that exact approved content instead of inventing substitute marketing copy or shortening the section.',
    );
    lines.push(
      '⛔ For every `card-grid`, render ALL approved cards in the SAME order with the SAME headings/body text unless the source data above proves a specific card is impossible.',
    );
    lines.push(
      '⛔ For `hero`, `cover`, `media-text`, `testimonial`, and `newsletter`, preserve the approved heading/body/image/CTA pairing for that exact section. Do NOT swap content between sections.',
    );
    lines.push(
      '⛔ When the approved plan includes `headingStyle`, `subheadingStyle`, or `bodyStyle` fields such as `lineHeight`, `fontWeight`, `fontFamily`, or `fontSize`, apply them to the matching JSX text elements. Do NOT fall back to generic root typography when the plan provides explicit text styling.',
    );
    lines.push(
      '⛔ For centered `hero`/`newsletter` sections that contain heading + subheading/body + CTA, preserve the original vertical rhythm from the source-backed plan. Use a real text/CTA stack with non-trivial spacing (`gap-*`, `space-y-*`, or explicit margins on the text/button wrappers). Do NOT compress the CTA directly against the paragraph, and do NOT substitute that spacing with empty spacer divs.',
    );
    lines.push(
      '⛔ For `cover` with `dimRatio=0` and no heading/subheading/cta fields: this is a standalone image block, NOT a hero. Render it as a plain `<img src={imageSrc} alt="" className="vp-generated-image w-full h-auto object-contain" />` inside a `max-w-[1280px]` wrapper. Do NOT use `background-image` CSS or a fixed-height div for these image-only cover sections.',
    );
    lines.push(
      '⛔ For `tabs`, render a real interactive tab UI using the approved `tabs[]` labels/content in the same order. Do NOT flatten tabs into one long static text block or convert them into cards/grid items.',
    );
    lines.push(
      '⛔ Tab interaction fidelity: when rendering WordPress-style tabs, keep tab labels visually tab-like rather than plain inline text. If the source shows underlined labels at rest, preserve that default state, but on hover/focus remove the underline and show a visible tab border/outline for keyboard focus.',
    );
    lines.push(
      '⛔ For `slider`, render a real carousel/slider UI using the approved `slides[]` content in the same order. Do NOT collapse it into a plain stacked list unless the source data contains only one slide.',
    );
    lines.push(
      '⛔ Slider implementation contract: use Swiper for approved `slider` sections. Import `Swiper` / `SwiperSlide` from `swiper/react`, import the needed modules from `swiper/modules` (for example `Navigation`, `Pagination`, `Autoplay`, `A11y`, `EffectFade`), and import the matching package CSS such as `swiper/css`, `swiper/css/navigation`, `swiper/css/pagination`, and `swiper/css/effect-fade` when those features are used. Do NOT hand-roll the slider with only `useState`, array indexing, and conditional text swaps when Swiper is available.',
    );
    lines.push(
      '⛔ Slider interaction quality: when a `slider` has more than one slide, the slide change MUST have visible motion. Do NOT instantly replace heading/paragraph text. Use either a translating track or stacked slides with active/inactive classes such as `opacity-*`, `translate-*`, or `scale-*` plus `transition-all`/`transition-opacity`/`transition-transform` and a real duration (roughly 300-700ms).',
    );
    lines.push(
      'For multi-slide sliders, keep obvious controls in the section itself: dot indicators at minimum, and visible prev/next controls near the left/right edges by default unless the source explicitly proves a dots-only carousel. Autoplay, if enabled by the plan, must reuse the same animated transition instead of a hard content swap.',
    );
    lines.push(
      'If `lucide-react` is available in the project, prefer icons such as `ChevronLeft` / `ChevronRight` for slider edge controls instead of raw text glyphs like `<`, `>`, `‹`, or `›`.',
    );
    lines.push(
      'Slider width contract: match the source slider shell width instead of blindly using the page-wide container. If the WordPress source shows a visibly constrained, centered carousel block, keep the OUTER slider wrapper constrained and centered in React too. Only use the full wide section container when the source actually stretches the carousel that wide. Treat `contentWidth` as the readable max width for the inner text/copy stack, not automatic proof that the whole slider shell must be full-width.',
    );
    lines.push(
      'Slider framing contract: do NOT invent an outline, border, ring, or card chrome around the whole slider unless the source clearly shows a framed carousel shell. If the WordPress source is an open, borderless slider, keep the React version borderless too.',
    );
    lines.push(
      'Standalone `slider` sections also need breathing room from neighboring sections. Unless the source explicitly nests the slider inside the same card/container as the surrounding content, do NOT collapse it to `py-0`; keep non-zero top and bottom spacing so the section does not visually stick to the next CTA or trigger block.',
    );
    lines.push(
      '⛔ For `modal`, render a real trigger + dialog/modal interaction using the approved `triggerText`, `heading`, `description`, and `cta` content. Do NOT downgrade it to an inline CTA block.',
    );
    lines.push(
      '⛔ Modal interaction quality: opening/closing must animate both the backdrop and the dialog panel. Use a fixed `inset-0` backdrop with opacity transition, and a panel that animates with opacity plus `translate-y-*` or `scale-*` classes. Do NOT let the modal appear/disappear instantly.',
    );
    lines.push(
      '⛔ Modal accessibility contract: the modal panel must include `role="dialog"` and `aria-modal="true"`, provide a visible close button, close on Escape, and close when the user clicks the backdrop unless the source explicitly indicates otherwise.',
    );
    lines.push(
      'If `lucide-react` is available in the project, prefer a real icon component such as `X` for the modal close button instead of a raw `×`/`✕` character.',
    );
    lines.push(
      'If a `modal` trigger is its own top-level section, preserve vertical spacing around that trigger section too. Do not leave it glued to the previous/next section with `py-0` unless the source clearly shows a shared wrapper.',
    );
    lines.push(
      '⛔ For `accordion`, render a real accordion/disclosure UI using the approved `items[]` titles/content in the same order. Do NOT flatten it into static paragraphs or convert it into cards.',
    );
    lines.push(
      '⛔ For `button-group`, render the approved buttons in the SAME order with the approved text/link values and aligned according to `align`. Do NOT invent extra headings.' +
        " TRAILING CTA EXCEPTION: If the `button-group` section immediately follows a `hero`, `cover`, or `newsletter` section that already has a styled card/container (white box, rounded bg, etc.), render the button(s) INSIDE that preceding section's container — at the bottom of its flex-col content — instead of wrapping them in a new outer `<section>`. Keep the `data-vp-section-key` attribute on the button element itself.",
    );
    lines.push(
      'When a `button-group` remains a standalone top-level section, do not compress it with `py-0`. Give it visible section padding so the CTA has enough separation from a slider, modal trigger, or neighboring content block.',
    );
    lines.push(
      '⛔ SECTION BOUNDARIES: If the approved plan lists separate sections with different `sectionKey` / `sourceNodeId`, keep them as separate top-level JSX wrappers in the same order. Do NOT merge two approved sections into one split row or one shared wrapper.' +
        ' Exception: a trailing `button-group` that is a CTA for the immediately preceding content section may be rendered inline per the rule above.',
    );
    lines.push(
      '⛔ CONTIGUOUS GROUP RULE: Separate tracked wrappers do NOT automatically mean visible spacing between them. When adjacent approved sections come from the same parent WordPress group/cluster, keep the wrappers separate for tracking but render them flush with no artificial root gap, divider, stripe, or duplicated outer padding between them.',
    );
    lines.push(
      '⛔ If one approved section is text-first and a later approved section owns the image, keep the image in the later section. Do NOT pull that image up beside the earlier text block.',
    );
    lines.push(
      '⛔ Split/flex-row guardrail: use side-by-side text/image layout ONLY when the approved section itself is `media-text` or a `hero` whose approved `layout=split`. Do NOT introduce `md:flex-row` / two-column hero structure for a section that is approved as a text-only hero followed by a later media/image section.',
    );
    lines.push(
      '⛔ Hero layout rule: if an approved `hero` uses `layout=centered` or `layout=left` and also has an image, render it as a vertical stack with text/CTA first and the image BELOW. Do NOT place that image beside the text unless the approved plan explicitly says `layout=split`.',
    );
    lines.push(
      '⛔ Source-structure rule: do NOT infer `md:flex-row`, CSS grid, or a two-column wrapper from visual similarity alone. Use horizontal split only when the approved plan or source structure explicitly proves side-by-side columns/media-text.',
    );

    const trackedSections = visualPlan.sections
      .filter((section) => !!section.sourceRef?.sourceNodeId)
      .map((section, index) => {
        const sectionKey =
          section.sectionKey ??
          `${section.type}${index === 0 ? '' : `-${index}`}`;
        return [
          `- section ${index + 1}: type=${section.type}`,
          `sectionKey=${sectionKey}`,
          `sourceNodeId=${section.sourceRef?.sourceNodeId}`,
          `template=${section.sourceRef?.templateName}`,
          `sourceFile=${section.sourceRef?.sourceFile}`,
          componentName
            ? `sectionComponent=${buildTrackedSectionComponentName(componentName, sectionKey)}`
            : null,
        ]
          .filter(Boolean)
          .join(' | ');
      });

    if (trackedSections.length > 0) {
      lines.push('');
      lines.push('## Section tracking markers — MANDATORY');
      lines.push(
        'For every approved section, keep a dedicated top-level JSX wrapper and preserve these exact string-literal attributes on that wrapper:',
      );
      lines.push(
        '`data-vp-source-node`, `data-vp-template`, `data-vp-source-file`, `data-vp-section-key`, `data-vp-component`, `data-vp-section-component`.',
      );
      lines.push(
        'Do NOT rename, hash, omit, or move these attributes to a child element. They are required for exact capture-to-source resolution after React generation.',
      );
      lines.push(...trackedSections);
    }

    const contiguousClusters = collectContiguousSourceClusters(visualPlan);
    if (contiguousClusters.length > 0) {
      lines.push('');
      lines.push('## Contiguous source clusters — preserve seamless flow');
      lines.push(
        'These adjacent approved sections came from the same parent WordPress group/cluster. Keep separate tracked wrappers, but do NOT create extra vertical gap/banding between them.',
      );
      for (const cluster of contiguousClusters) {
        lines.push(
          `- sections ${cluster.startIndex + 1}-${cluster.endIndex + 1} share source cluster ${cluster.clusterKey}: types=${cluster.sectionTypes.join(' -> ')} | sectionKeys=${cluster.sectionKeys.join(', ')}`,
        );
      }
    }
  }

  const sidebarSection = visualPlan.sections?.find((s) => s.type === 'sidebar');
  if (sidebarSection?.type === 'sidebar') {
    lines.push('');
    lines.push('## Sidebar contract — MANDATORY');
    lines.push(
      'Treat the `sidebar` section as a constrained data widget area, not a free-design area.',
    );
    lines.push(
      `Allowed sidebar sources from the approved plan: showPages=${sidebarSection.showPages}, showPosts=${sidebarSection.showPosts}, showSiteInfo=${sidebarSection.showSiteInfo}, menuSlug=${sidebarSection.menuSlug ?? 'none'}.`,
    );
    lines.push(
      '⛔ Do NOT invent extra sidebar widgets such as "Useful Links", "Resources", "Quick Links", social links, footer-style columns, or author bio blocks unless they are explicitly present in the template source or directly supported by approved API data above.',
    );
    lines.push(
      'If a URL is not present in the template source or API data, prefer a temporary `href="#"` placeholder over inventing a fake internal route path.',
    );
    lines.push(
      'If a sidebar item should remain clickable but no real URL is available yet, `href="#"` is an acceptable temporary placeholder. Do NOT invent a fake internal route path.',
    );
  }

  // Enforce the distinction between wide section shells and narrow prose bodies.
  if (visualPlan.layout?.containerClass) {
    lines.push('');
    lines.push(
      `⛔ MANDATORY LAYOUT: Full-width sections, shared chrome, grids, heroes, sidebars, and major page wrappers MUST use the class "${visualPlan.layout.containerClass}". Do NOT shrink those areas to article width.`,
    );
  }
  if (visualPlan.layout?.contentContainerClass) {
    lines.push(
      `- Narrow prose containers (article body, page body, comments) should use "${visualPlan.layout.contentContainerClass}" when you need readable text width.`,
    );
    lines.push(
      '⛔ Do NOT wrap the entire page in the prose container unless the whole template is genuinely a single-column article view.',
    );
  }
  lines.push(
    '- For centered intro/hero copy inside a full-width or wide section: do NOT let long paragraph text span the full section width. Use a centered inner wrapper with a readable max width. If the approved section provides `contentWidth`, follow it exactly. Otherwise, when the section is centered and contains long copy, constrain the paragraph/body to roughly 85-90% of the theme wide width instead of the full container width.',
  );

  lines.push('');
  lines.push('## Compact visual plan summary');
  lines.push(...buildCompactSectionSummary(visualPlan, componentName));

  return lines.join('\n');
}

export function buildComponentPrompt(
  componentName: string,
  templateSource: string,
  siteInfo: WpSiteInfo,
  content?: DbContentResult,
  tokens?: ThemeTokens,
  repoManifest?: RepoThemeManifest,
  componentPlan?: ComponentPromptContext,
  editRequestContextNote?: string,
  retryError?: string,
): string {
  const normalizedDataNeeds = normalizeDataNeeds(componentPlan?.dataNeeds);
  const hasPlanContract =
    componentPlan !== undefined &&
    (componentPlan.route !== undefined ||
      componentPlan.isDetail !== undefined ||
      componentPlan.dataNeeds !== undefined);
  const isSingle = hasPlanContract
    ? componentPlan?.isDetail === true &&
      normalizedDataNeeds.includes('postDetail')
    : SINGLE_TEMPLATES.has(componentName);
  const isPage = hasPlanContract
    ? componentPlan?.isDetail === true &&
      normalizedDataNeeds.includes('pageDetail')
    : PAGE_TEMPLATES.has(componentName);

  const menuContextNote = '';
  const dataGrounding = content
    ? buildDataGroundingNote(content, { dataNeeds: normalizedDataNeeds })
    : '';
  const templateTexts = buildTemplateTextsNote(templateSource);
  const imageSources = buildImageSourcesNote(templateSource);
  const classicThemeNote = buildClassicThemeNote(
    templateSource,
    isSingle ?? false,
    isPage ?? false,
    componentPlan?.type === 'page',
  );
  const repoContext = shouldIncludeRepoManifestContext(
    componentName,
    componentPlan,
  )
    ? buildRepoManifestContextNote(repoManifest, {
        mode: 'compact',
        includeLayoutHints: true,
        includeStyleHints: false,
        includeStructureHints: true,
      })
    : '';
  const planContext = [
    buildPlanContextNote(componentPlan, componentName),
    buildVisualPlanContextNote(componentPlan?.visualPlan, componentName),
    buildSourceFidelityNote(templateSource),
    repoContext,
    editRequestContextNote,
  ]
    .filter(Boolean)
    .join('\n\n');
  const retryNote = buildRetryNote(retryError);
  const isNoTitle =
    /no.?title/i.test(componentName ?? '') ||
    /without.{0,20}title|no.{0,10}title|omit.{0,10}title/i.test(
      componentPlan?.description ?? '',
    );

  const slugFetchingNote =
    isSingle || isPage
      ? `## IMPORTANT — This is a detail/single view component
- Import \`useParams\` from \`react-router-dom\`
- Read the slug from URL: \`const { slug } = useParams<{ slug: string }>()\`
- Fetch the specific ${isSingle ? 'post' : 'page'} by slug:
  - ${isSingle ? '`GET /api/posts/:slug`' : '`GET /api/pages/:slug`'}
- If the response is null/404, show a "Not found" message
- Do NOT fetch the full list and pick index 0 — always use the slug from URL
${
  isNoTitle
    ? '- This is a NoTitle variant: do NOT render the record title in any heading element.'
    : `- Render \`${isSingle ? 'post' : 'page'}.title\` as the primary heading above the content.`
}
- Preserve approved/source heading alignment for the detail intro/title cluster. If the source centers the title/meta block, keep the generated heading/meta wrapper centered rather than drifting to \`text-left\`.
- When the detail page uses a constrained reading column, the title/meta cluster must share that SAME column width and left edge as the article body. Do NOT center the title text independently while the prose below starts from a different left edge.
- Preferred pattern for left-aligned post/page detail intros: one shared wrapper such as \`<div className="max-w-[620px] mx-auto w-full flex flex-col gap-[...]">\` containing the heading and meta row, followed by the content body in that same readable width. Avoid inner wrappers like \`text-center\`, \`items-center\`, or \`justify-center\` unless the approved source explicitly centers the intro.
- Render runtime date strings directly (\`post.date\`, \`comment.date\`) to preserve the source WordPress display order. Do NOT format them with \`new Date(...).toLocaleDateString()\`, \`toLocaleString()\`, or \`Intl.DateTimeFormat\`.
${
  isPage
    ? `- Page Detail Contract: NO \`author\`, \`categories\`, \`tags\`, \`date\`, \`excerpt\`, \`comments\`.
- \`interface Page\` (MANDATORY for pages) must match the canonical Page contract from the API note.
- Use \`item: Page | null\` state, not \`Post\`.`
    : ''
}`
      : '';
  return TEMPLATE.replace('{{componentName}}', componentName)
    .replace(
      '{{apiContract}}',
      buildScopedApiContractNote({
        dataNeeds: normalizedDataNeeds,
        route: componentPlan?.route,
        componentName,
      }),
    )
    .replace('{{menuContext}}', menuContextNote)
    .replace('{{planContext}}', planContext)
    .replace('{{slugFetchingNote}}', slugFetchingNote)
    .replace('{{classicThemeNote}}', classicThemeNote)
    .replace('{{themeTokens}}', buildThemeTokensNote(tokens))
    .replace('{{dataGrounding}}', dataGrounding)
    .replace('{{imageSources}}', imageSources)
    .replace('{{templateTexts}}', templateTexts)
    .replace('{{retryError}}', retryNote)
    .replace('{{siteName}}', siteInfo.siteName)
    .replace('{{siteUrl}}', siteInfo.siteUrl)
    .replace('{{templateSource}}', templateSource);
}

/**
 * Lightweight prompt for sub-components generated by section chunking.
 * Each section renders only its slice of the page and must not recreate the page shell.
 */
export function buildSectionPrompt(input: {
  sectionName: string;
  parentName: string;
  sectionIndex: number;
  totalSections: number;
  nodesJson: string;
  siteInfo: WpSiteInfo;
  menus: WpMenu[];
  tokens?: ThemeTokens;
  repoManifest?: RepoThemeManifest;
  componentPlan?: ComponentPromptContext;
  editRequestContextNote?: string;
  retryError?: string;
  content?: DbContentResult;
}): string {
  const normalizedDataNeeds = normalizeDataNeeds(
    input.componentPlan?.dataNeeds,
  );
  const hasPlanContract =
    input.componentPlan !== undefined &&
    (input.componentPlan.route !== undefined ||
      input.componentPlan.isDetail !== undefined ||
      input.componentPlan.dataNeeds !== undefined);
  const isSingle = hasPlanContract
    ? input.componentPlan?.isDetail === true &&
      normalizedDataNeeds.includes('postDetail')
    : SINGLE_TEMPLATES.has(input.parentName);
  const isPage = hasPlanContract
    ? input.componentPlan?.isDetail === true &&
      normalizedDataNeeds.includes('pageDetail')
    : PAGE_TEMPLATES.has(input.parentName);

  const menuContextNote = input.content ? '' : buildMenusNote(input.menus);
  const dataGrounding = input.content
    ? buildDataGroundingNote(input.content, { dataNeeds: normalizedDataNeeds })
    : '';
  const templateTexts = buildTemplateTextsNote(input.nodesJson);
  const imageSources = buildImageSourcesNote(input.nodesJson);
  const classicThemeNote = buildClassicThemeNote(
    input.nodesJson,
    isSingle ?? false,
    isPage ?? false,
    input.componentPlan?.type === 'page',
  );
  const repoContext = shouldIncludeRepoManifestContext(
    input.parentName,
    input.componentPlan,
  )
    ? buildRepoManifestContextNote(input.repoManifest, {
        mode: 'compact',
        includeLayoutHints: true,
        includeStyleHints: false,
        includeStructureHints: true,
      })
    : '';
  const sectionContextNote = `## Section context — CRITICAL
This is **section ${input.sectionIndex + 1} of ${input.totalSections}** of the \`${input.parentName}\` component.
⛔ DO NOT wrap in \`<header>\`, \`<nav>\`, or \`<footer>\` tags — those belong to other sections.
⛔ DO NOT duplicate page-level layout (no full-page wrapper, no navigation bar, no footer).
If this section needs runtime data, declare/fetch only the data actually rendered in this section.
Render ONLY the JSX for the blocks in the template source below.`;
  const sourceTrackingNote = buildSourceTrackingNoteForNodes(
    input.nodesJson,
    input.parentName,
    input.sectionName,
  );
  const planContext = [
    sectionContextNote,
    buildPlanContextNote(input.componentPlan, input.parentName),
    buildVisualPlanContextNote(
      input.componentPlan?.visualPlan,
      input.parentName,
    ),
    buildSourceFidelityNote(input.nodesJson),
    sourceTrackingNote,
    repoContext,
    input.editRequestContextNote,
  ]
    .filter(Boolean)
    .join('\n\n');
  const retryNote = buildRetryNote(input.retryError);

  const slugFetchingNote =
    isSingle || isPage
      ? `## Detail route context for this section
- The parent component route is slug-based.
- Only add \`useParams<{ slug: string }>()\` if this section truly renders ${isSingle ? 'post' : 'page'} detail data.
- If you need detail data in this section, fetch ${isSingle ? '`GET /api/posts/:slug`' : '`GET /api/pages/:slug`'} by slug. Never fetch the full list and pick index 0.
- Keep loading/error handling local to this section. Do NOT generate a full-page shell.`
      : '';

  return TEMPLATE.replace('{{componentName}}', input.sectionName)
    .replace(
      '{{apiContract}}',
      buildScopedApiContractNote({
        dataNeeds: normalizedDataNeeds,
        route: input.componentPlan?.route,
        componentName: input.parentName,
      }),
    )
    .replace('{{menuContext}}', menuContextNote)
    .replace('{{planContext}}', planContext)
    .replace('{{slugFetchingNote}}', slugFetchingNote)
    .replace('{{classicThemeNote}}', classicThemeNote)
    .replace('{{themeTokens}}', buildThemeTokensNote(input.tokens))
    .replace('{{dataGrounding}}', dataGrounding)
    .replace('{{imageSources}}', imageSources)
    .replace('{{templateTexts}}', templateTexts)
    .replace('{{retryError}}', retryNote)
    .replace('{{siteName}}', input.siteInfo.siteName)
    .replace('{{siteUrl}}', input.siteInfo.siteUrl)
    .replace('{{templateSource}}', input.nodesJson);
}

function buildSourceTrackingNoteForNodes(
  nodesJson: string,
  componentName: string,
  sectionComponentName: string,
): string {
  try {
    const parsed = JSON.parse(nodesJson) as WpNode[];
    const requiredCustomClassNames = extractCustomClassNamesFromNodes(parsed);
    const trackedNodes = parsed
      .filter((node) => !!node.sourceRef?.sourceNodeId)
      .map((node, index) => {
        const sectionKey =
          node.sourceRef?.blockName?.replace(/^core\//, '') ??
          `section-${index + 1}`;
        return [
          `- top-level node ${index + 1}: sourceNodeId=${node.sourceRef?.sourceNodeId}`,
          `template=${node.sourceRef?.templateName}`,
          `sourceFile=${node.sourceRef?.sourceFile}`,
          `sectionKey=${sectionKey}`,
          node.customClassNames?.length
            ? `customClassNames=${formatClassList(node.customClassNames)}`
            : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' | ');
      });

    if (trackedNodes.length === 0 && requiredCustomClassNames.length === 0)
      return '';

    const lines = [
      '## Source tracking markers — MANDATORY',
      'For each top-level source node rendered by this section component, keep a stable outer JSX wrapper with exact string-literal attributes:',
      '`data-vp-source-node`, `data-vp-template`, `data-vp-source-file`, `data-vp-section-key`, `data-vp-component`, `data-vp-section-component`.',
      `Use \`data-vp-component="${componentName}"\` and \`data-vp-section-component="${sectionComponentName}"\` on every tracked wrapper in this file.`,
    ];
    if (requiredCustomClassNames.length > 0) {
      lines.push(
        `Preserve these exact source custom classes in this section's JSX: ${formatClassList(requiredCustomClassNames)}.`,
      );
    }
    if (trackedNodes.length > 0) {
      lines.push('Tracked top-level source nodes:');
      lines.push(...trackedNodes);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function extractCustomClassNamesFromNodes(nodes: WpNode[]): string[] {
  const result = new Set<string>();
  const visit = (node: WpNode) => {
    for (const className of node.customClassNames ?? []) {
      const normalized = className.trim();
      if (normalized) result.add(normalized);
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return [...result];
}

function formatClassList(classNames: string[]): string {
  return classNames.map((className) => `\`${className}\``).join(', ');
}

function formatSourceLayout(layout: SourceLayoutHint): string {
  const entries = Object.entries(layout as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  if (entries.length === 0) return '{}';
  return `{${entries.map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(', ')}}`;
}

function buildTrackedSectionComponentName(
  componentName: string,
  sectionKey: string,
): string {
  return `${componentName}${sectionKey
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join('')}Section`;
}

function compactRetryError(retryError?: string): string {
  if (!retryError) return '';
  const normalized = retryError.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_RETRY_ERROR_CHARS) return normalized;
  return `${normalized.slice(0, MAX_RETRY_ERROR_CHARS)}...`;
}

function buildRetryNote(retryError?: string): string {
  if (!retryError) return '';

  if (/^## RETRY MODE — DELTA ONLY/m.test(retryError)) {
    return retryError;
  }

  return `## ERROR FROM PREVIOUS ATTEMPT\n${compactRetryError(retryError)}\nFIX THIS.${
    /jsx|closing tag|Expected corresponding|parse/i.test(retryError)
      ? '\n\n**Parsing:** Re-check every `<div>` / `<section>` / `<main>` / `<article>` — each must have a matching `</…>` in order. The file must be complete, valid TSX before `export default`.'
      : ''
  }${
    /Page detail contract|interface Page|post-only field/i.test(retryError)
      ? '\n\n**Page type:** `interface Page` must match the canonical contract — remove post-only fields like `author`, `categories`, `tags`, `date`, `excerpt`, and `comments`. `page.featuredImage`, `page.parentId`, `page.menuOrder`, and `page.template` are allowed. Do NOT access `page.author` or `pageDetail.author`. Sidebar/list items (recent posts, etc.) must use a separate `interface Post` — using `item.author` inside a `posts.map()` is fine.'
      : ''
  }`;
}
