import { readFileSync } from 'fs';
import { join } from 'path';
import type { WpNode } from '../../../../common/utils/wp-block-to-json.js';
import {
  stripTags,
  wpBlocksToJson,
} from '../../../../common/utils/wp-block-to-json.js';
import type { ThemeTokens } from '../../../agents/block-parser/block-parser.service.js';
import { WpMenu, WpSiteInfo } from '../../../sql/wp-query.service.js';
import { DbContentResult } from '../../db-content/db-content.service.js';
import type { ComponentVisualPlan } from '../visual-plan.schema.js';
import {
  API_CONTRACT_SOURCE_PATH,
  COMMENT_FIELDS,
  MENU_FIELDS,
  MENU_ITEM_FIELDS,
  PAGE_FRONTEND_FIELDS,
  POST_FIELDS,
  SITE_INFO_FIELDS,
  buildCanonicalApiContractNote,
} from '../api-contract.js';

export function extractTexts(nodes: WpNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.href && node.text) {
      result.push(`[button] ${node.text}`);
    } else if (node.text) {
      result.push(node.text);
    } else if (node.html) {
      const plain = stripTags(node.html).replace(/\s+/g, ' ').trim();
      if (plain.length > 0) result.push(plain);
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
  'post-detail': 'postDetail',
  'page-detail': 'pageDetail',
  'product-detail': 'productDetail',
};

export interface ComponentPromptContext {
  description?: string;
  dataNeeds?: string[];
  route?: string | null;
  isDetail?: boolean;
  type?: 'page' | 'partial';
  visualPlan?: ComponentVisualPlan;
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
    "→ Use menus.find(m => m.slug === '<slug>') ?? menus[0] to select the right menu",
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
    if (d.contentWidth)
      lines.push(
        `- Content max-width: \`max-w-[${d.contentWidth}]\` on content wrappers`,
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
        `- Default block gap: \`${d.blockGap}\` — WordPress applies this as \`margin-block-start\` between ALL direct children of the root wrapper (not just flex/grid). Replicate this by:\n  1. Root wrapper → \`flex flex-col gap-[${d.blockGap}]\` (this is the most critical rule)\n  2. Every inner flex/grid container with NO explicit \`gap\` field → also add \`gap-[${d.blockGap}]\``,
      );
    if (d.rootPadding)
      lines.push(
        `- Root/global padding: \`style={{padding:"${d.rootPadding}"}}\` — apply to the outermost wrapper \`<div>\` of this component (replicates WordPress .wp-site-blocks padding)`,
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
      '**Colors** — `bgColor`/`textColor`/`overlayColor` fields in the template JSON are already resolved to hex. Apply them directly:',
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

  if (tokens.spacing.length > 0) {
    lines.push(
      '**Spacing** — when template uses `var:preset|spacing|N` or `var(--wp--preset--spacing--N)`, use Tailwind arbitrary value `p-[size]` / `py-[size]` / `px-[size]` / `gap-[size]`:',
    );
    for (const s of tokens.spacing) {
      lines.push(`- slug \`${s.slug}\` → \`${s.size}\``);
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

function buildTemplateTextsNote(templateSource: string): string {
  try {
    const nodes: WpNode[] = JSON.parse(templateSource);
    const texts = extractTexts(nodes);
    if (texts.length === 0) return '';
    return `## Static text in this template — hardcode EXACTLY as-is (do NOT paraphrase or invent)
${texts.map((t) => `- ${t}`).join('\n')}
`;
  } catch {
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
    if (texts.length === 0) return '';
    return `## Static text extracted from classic PHP template — hardcode EXACTLY as-is
${texts.map((t) => `- ${t}`).join('\n')}
`;
  }
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
      ? `- \`{/* WP: post.content (HTML) */}\` → render \`${isSingle ? 'post' : 'page'}?.content\` with \`dangerouslySetInnerHTML={{ __html: ${isSingle ? 'post' : 'page'}?.content ?? '' }}\` (NO fetch array)`
      : `- \`{/* WP: post.content (HTML) */}\` → fetch \`GET /api/pages\` and render \`pages[0]?.content\` with \`dangerouslySetInnerHTML={{ __html: pages[0]?.content ?? '' }}\``;

  const loopHint =
    isSingle || isPage
      ? `- \`{/* WP: loop start */}\` → (Single view) Render the specific \`${isSingle ? 'post' : 'page'}\` properties. NO loop / array map.`
      : `- \`{/* WP: loop start */}\` → fetch \`GET /api/posts\` and map over results`;

  // For PAGE components, the shared Layout wrapper handles Header/Footer chrome.
  // Suppress those hints so the AI does not fetch site-info/menus or render site chrome.
  const headerHint = isPageComponent
    ? `- \`{/* WP: <Header /> */}\` → ⛔ SKIP entirely — this is a PAGE component; the shared Layout wrapper renders the site header. Do NOT fetch site-info or menus for it.`
    : `- \`{/* WP: <Header /> */}\` → render the site title as a home link (\`<Link to="/">{siteInfo.siteName}</Link>\`) + fetch \`GET /api/menus\` and render ALL returned nav items`;
  const footerHint = isPageComponent
    ? `- \`{/* WP: <Footer /> */}\` → ⛔ SKIP entirely — this is a PAGE component; the shared Layout wrapper renders the site footer. Do NOT fetch site-info or menus for it.`
    : `- \`{/* WP: <Footer /> */}\` → render the site title as a home link (\`<Link to="/">{siteInfo.siteName}</Link>\`) + fetch \`GET /api/menus\` for footer links`;

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

export function buildDataGroundingNote(content: DbContentResult): string {
  const { siteInfo, posts, pages, menus, taxonomies } = content;
  const parts: string[] = [];

  parts.push(
    `## ACTUAL DATA from this site — grounded to ${API_CONTRACT_SOURCE_PATH}`,
  );
  parts.push('');
  parts.push(
    '> Only use fields shown below. Any field not listed here does NOT exist.',
  );
  parts.push(
    `> Posts have: ${formatContractFields(POST_FIELDS)}.`,
  );
  parts.push(`> Pages have: ${formatContractFields(PAGE_FRONTEND_FIELDS)}.`);
  parts.push(
    '> ⛔ Pages do NOT have: excerpt, date, author, categories, featuredImage, comments.',
  );
  parts.push(
    '> ⛔ NEVER render siteName more than once per component — one element only.',
  );
  parts.push('');

  // Site info
  parts.push('### Site info (GET /api/site-info)');
  parts.push(
    `${SITE_INFO_FIELDS[1]}: "${siteInfo.siteName}" | ${SITE_INFO_FIELDS[0]}: "${siteInfo.siteUrl}" | ${SITE_INFO_FIELDS[2]}: "${siteInfo.blogDescription}"`,
  );
  parts.push('');

  // Posts sample
  const postSample = posts.slice(0, 5);
  parts.push(
    `### Posts — ${posts.length} total (GET /api/posts)` +
      (posts.length === 0 ? ' — NONE, do NOT invent posts' : ''),
  );
  for (const p of postSample) {
    parts.push(`  id:${p.id} slug:"${p.slug}" title:"${p.title}"`);
  }
  if (posts.length > 5) parts.push(`  ... and ${posts.length - 5} more`);
  if (posts.length === 0) parts.push('  (empty)');
  parts.push('');

  // Pages sample
  const pageSample = pages.slice(0, 5);
  parts.push(
    `### Pages — ${pages.length} total (GET /api/pages)` +
      (pages.length === 0 ? ' — NONE, do NOT invent pages' : ''),
  );
  for (const p of pageSample) {
    const contentPreview = p.content
      ? stripTags(p.content).replace(/\s+/g, ' ').trim().slice(0, 300)
      : '';
    parts.push(`  id:${p.id} slug:"${p.slug}" title:"${p.title}"`);
    if (contentPreview)
      parts.push(`    content preview: "${contentPreview}..."`);
  }
  if (pages.length > 5) parts.push(`  ... and ${pages.length - 5} more`);
  if (pages.length === 0) parts.push('  (empty)');
  parts.push('');

  // Menus full
  parts.push(
    `### Menus — ${menus.length} total (GET /api/menus)` +
      (menus.length === 0 ? ' — NONE, do NOT invent nav links' : ''),
  );
  parts.push(
    `> Menu fields: ${formatContractFields(MENU_FIELDS)} | MenuItem fields: ${formatContractFields(MENU_ITEM_FIELDS)}.`,
  );
  for (const m of menus) {
    parts.push(
      `  menu slug:"${m.slug}" name:"${m.name}" — ${m.items.length} items`,
    );
    for (const item of m.items) {
      parts.push(
        `    - id:${item.id} parentId:${item.parentId} title:"${item.title}" url:"${item.url}"`,
      );
    }
  }
  if (menus.length === 0) parts.push('  (empty)');

  parts.push('');
  parts.push(
    `### Comments contract (GET /api/comments) — fields: ${formatContractFields(COMMENT_FIELDS)}`,
  );
  parts.push(
    'Use `comment.author` and `comment.content` directly; moderation polling uses `/api/comments/submissions`.',
  );

  // Taxonomies — categories, tags, custom
  if (taxonomies && taxonomies.length > 0) {
    parts.push(
      `### Taxonomies — ${taxonomies.length} type(s) (GET /api/taxonomies)`,
    );
    parts.push(
      '> Use taxonomy slugs for archive routes (e.g. /category/:slug, /tag/:slug).',
    );
    for (const tax of taxonomies) {
      const termPreview = tax.terms
        .slice(0, 8)
        .map((t) => `"${t.slug}"(${t.count})`)
        .join(', ');
      const suffix =
        tax.terms.length > 8 ? ` +${tax.terms.length - 8} more` : '';
      parts.push(
        `  taxonomy:"${tax.taxonomy}" — ${tax.terms.length} terms: ${termPreview}${suffix}`,
      );
    }
  }

  return parts.join('\n');
}

export function buildPlanContextNote(plan?: {
  description?: string;
  dataNeeds?: string[];
  route?: string | null;
  type?: 'page' | 'partial';
}): string {
  if (!plan) return '';
  const lines: string[] = ['## Component plan'];
  const normalizedDataNeeds = normalizeDataNeeds(plan.dataNeeds);
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
  const routeHasParams = /:[A-Za-z_]/.test(plan.route ?? '');
  if (normalizedDataNeeds.includes('postDetail')) {
    lines.push(
      routeHasParams
        ? 'Detail data contract: fetch the specific post with `/api/posts/${slug}` and render that record, not the full posts list.'
        : 'Data contract: this component displays post detail data but does NOT own the route. ' +
            'Accept a `post` prop of type `Post` from the parent component — do NOT call `useParams` or fetch `/api/posts/...` yourself.',
    );
  }
  if (normalizedDataNeeds.includes('pageDetail')) {
    lines.push(
      routeHasParams
        ? 'Detail data contract: fetch the specific page with `/api/pages/${slug}` and render that record, not the full pages list.'
        : 'Data contract: this component displays page detail data but does NOT own the route. ' +
            'Accept a `page` prop of type `Page` from the parent component — do NOT call `useParams` or fetch `/api/pages/...` yourself.',
    );
    lines.push(
      '⛔ Page Detail Contract: a page has NO `author`, `categories`, `date`, `excerpt`, `featuredImage`, or `comments`. Use ONLY `id, title, content, slug`.',
    );
    lines.push(
      '⛔ If you declare `interface Page`, it must ONLY have those 4 fields. Do NOT use `Post` type for pages.',
    );
    lines.push(
      '⛔ In ANY output, do not reference page fields outside of `id`, `title`, `content`, `slug`.' +
        '\n- Reject and rewrite if you detect: `page.author`, `page.categories`, `page.date`, `page.excerpt`, `page.featuredImage`, `page.comments`.' +
        '\n- If the template shows an <img> element, render it from existing page content markup or via a separate visual section; do NOT use `page.featuredImage`.' +
        '\n- If you need post-only metadata, use `Post` type in `postDetail` components, not `Page`.' +
        '\n- Page detail type must be exactly: `interface Page { id: string; title: string; content: string; slug: string; }`',
    );
  }
  if (normalizedDataNeeds.includes('productDetail')) {
    lines.push(
      routeHasParams
        ? 'Detail data contract: fetch the specific product with `/api/products/${productId}` (or by slug) and render that product, including variations and related products.'
        : 'Data contract: this component displays a product and should fetch it from `/api/products/${productId}` inside a `useEffect`.',
    );
    lines.push(
      'WooCommerce Product Detail: fetch from `/api/products/:id` — returns { id, title, price, currency, description, image, sku, stock, categories[], attributes{}, variations[] }.',
    );
    lines.push(
      'If the URL has a parameter like `:productId`, use `useParams()` to extract it and fetch the product. ' +
        'Show product images, price, description, attributes (size, color, etc), variations selector, stock status, and "Add to Cart" button.',
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
  if (
    !normalizedDataNeeds.includes('postDetail') &&
    !normalizedDataNeeds.includes('pageDetail') &&
    !normalizedDataNeeds.includes('productDetail')
  ) {
    lines.push(
      'Data contract: do NOT fetch slug-based detail endpoints unless the plan explicitly requires detail data.',
    );
  }

  // ── Layout contract for page components ───────────────────────────────────
  if (plan?.type === 'page') {
    lines.push('');
    lines.push('## Layout contract — MANDATORY');
    lines.push('This component renders PAGE CONTENT ONLY.');
    lines.push(
      '⛔ Do NOT generate a `<header>` navigation bar or `<footer>` element — they are rendered by the shared Layout wrapper that wraps every page.',
    );
    lines.push(
      '✅ Start your JSX return with the main page content directly (e.g. `<main>`, `<section>`, or a wrapper `<div>`). No site logo, no top nav, no copyright footer.',
    );
    lines.push(
      '⛔ Do NOT fetch `GET /api/site-info` or `GET /api/menus` just to rebuild global site chrome inside this page. Shared Header/Footer/Navigation partials own that data.',
    );
    lines.push(
      '⛔ Do NOT render `siteInfo.siteName`, `siteInfo.blogDescription`, or `menus.find(...)/menus.map(...)` in this page unless the approved plan is specifically for a dedicated layout partial.',
    );
    lines.push(
      '⛔ Even if the original WordPress template source contains header/footer/site-title/navigation/footer-column markup or text, IGNORE it for page components. Shared chrome is migrated into dedicated partials and must not be duplicated inside page content.',
    );
    lines.push(
      '⛔ Do NOT hardcode fallback footer columns, copyright text, placeholder nav links, or `No menus available` messages in any page component.',
    );
  }

  // ── UI Rendering Guidelines ────────────────────────────────────────────────
  lines.push('');
  lines.push('## Fidelity Goal');
  lines.push(
    'This is a WordPress-to-React migration, not a redesign. Match the original WordPress UI as closely as possible.',
  );
  lines.push(
    '- Preserve the original block order, wrapper hierarchy, alignment, and section density from the template source.',
  );
  lines.push(
    '- Keep the same visual tone as the source template. Do NOT center, enlarge, simplify, or "modernize" sections unless the original template already does that.',
  );
  lines.push(
    '- Do NOT add hero/marketing/newsletter/testimonial treatments unless those blocks clearly exist in the template source or approved visual plan.',
  );
  lines.push(
    '- If the original template is simple or sparse, keep it simple or sparse. Do NOT embellish it.',
  );

  lines.push('');
  lines.push('## UI Rendering Guidelines');
  lines.push(
    'Render a complete React component that preserves the template source structure and original visual design as faithfully as possible. Follow these standards:',
  );
  lines.push('');
  lines.push('### Layout & Structure');
  if (plan?.type === 'page') {
    lines.push(
      '- Use semantic HTML: `<main>`, `<section>`, `<article>`, `<aside>`, `<nav>` instead of generic `<div>`. ⛔ Do NOT use site-level `<header>` or `<footer>` elements — the shared Layout wrapper provides them.',
    );
  } else {
    lines.push(
      '- Use semantic HTML: `<main>`, `<section>`, `<article>`, `<aside>`, `<header>`, `<footer>`, `<nav>` instead of generic `<div>`.',
    );
  }
  lines.push(
    '- Implement responsive design: use Tailwind responsive prefixes (`sm:`, `md:`, `lg:`, `xl:`) for mobile-first layouts.',
  );
  lines.push(
    '- Container widths: use theme tokens for max-width (e.g., `max-w-[1280px]` from contentWidth), center with `mx-auto`.',
  );
  lines.push(
    '- Spacing: use consistent spacing from theme tokens (blockGap, padding, margins) — avoid arbitrary values.',
  );
  lines.push('');
  lines.push('### Typography & Colors');
  lines.push(
    '- Headings: use theme typography tokens (`h1`, `h2`, `h3`, `body`) for consistent sizing and family.',
  );
  lines.push(
    '- Colors: use palette from theme tokens (`text`, `textMuted`, `accent`, `background`, `surface`) — no hardcoded colors.',
  );
  lines.push(
    '- Text hierarchy: ensure proper heading levels (h1 → h2 → h3) and semantic structure.',
  );
  lines.push('');
  lines.push('### Images & Media');
  lines.push(
    '- Images: use exact `src` from template source or static image sources provided. Add `alt` attributes for accessibility.',
  );
  lines.push(
    '- Responsive images: use `w-full h-auto` for fluid images, or specific aspect ratios from template.',
  );
  lines.push(
    '- Image radius: apply theme `imageRadius` (e.g., `rounded-[8px]`) for consistent styling.',
  );
  lines.push('');
  lines.push('### Interactive Elements');
  lines.push(
    '- Buttons/Links: use `accent` colors, theme `buttonPadding` and `buttonRadius` for consistent styling.',
  );
  lines.push(
    '- Navigation: render menus as `<nav>` with proper ARIA labels and keyboard navigation.',
  );
  lines.push(
    '- Forms: if present, use semantic `<form>`, `<label>`, `<input>` with proper `for` attributes.',
  );
  lines.push('');
  lines.push('### Accessibility & Best Practices');
  lines.push(
    '- ARIA: add `aria-label`, `role` where needed (e.g., `role="navigation"` for nav).',
  );
  lines.push(
    '- Keyboard navigation: ensure focusable elements have visible focus states.',
  );
  lines.push(
    '- Screen readers: use `sr-only` for hidden labels, descriptive `alt` text.',
  );
  lines.push(
    '- Loading states: show loading indicators for async data (posts, pages, comments).',
  );
  lines.push(
    '- Error handling: display user-friendly error messages for failed API calls.',
  );
  lines.push('');
  lines.push('### Code Quality');
  lines.push(
    '- Clean JSX: no unnecessary nesting, use fragments `<>` where appropriate.',
  );
  lines.push(
    '- Tailwind classes: use utility-first approach, combine with arbitrary values only when theme tokens require it.',
  );
  lines.push(
    '- Performance: avoid inline functions in render, use `useCallback` for event handlers if needed.',
  );
  lines.push(
    '- TypeScript: declare proper interfaces for props and state, use union types for variants.',
  );

  return lines.join('\n');
}

function extractStaticImageSources(templateSource: string): string[] {
  const result = new Set<string>();

  try {
    const parsed = JSON.parse(templateSource);
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.src === 'string' && node.src.trim()) {
        result.add(node.src.trim());
      }
      if (typeof node.imageSrc === 'string' && node.imageSrc.trim()) {
        result.add(node.imageSrc.trim());
      }
      if (Array.isArray(node.children)) node.children.forEach(visit);
      if (Array.isArray(node)) node.forEach(visit);
    };
    visit(parsed);
  } catch {
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
    for (const src of sources.slice(0, 20)) {
      lines.push(`- ${src}`);
    }
    if (sources.length > 20) {
      lines.push(`- ... and ${sources.length - 20} more`);
    }
    lines.push('Use only these exact sources for static images and avatars.');
  }

  lines.push(
    '⛔ If a testimonial/person/media block has no image source in the template, omit the image/avatar entirely.',
  );

  return lines.join('\n');
}

export function buildVisualPlanContextNote(
  visualPlan?: ComponentVisualPlan,
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

  lines.push('Visual plan JSON:');
  lines.push('```json');
  lines.push(JSON.stringify(visualPlan, null, 2));
  lines.push('```');

  return lines.join('\n');
}

export function buildComponentPrompt(
  componentName: string,
  templateSource: string,
  siteInfo: WpSiteInfo,
  content?: DbContentResult,
  tokens?: ThemeTokens,
  componentPlan?: ComponentPromptContext,
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

  const menuContextNote = buildMenusNote(content?.menus ?? []);
  const dataGrounding = content ? buildDataGroundingNote(content) : '';
  const templateTexts = buildTemplateTextsNote(templateSource);
  const imageSources = buildImageSourcesNote(templateSource);
  const classicThemeNote = buildClassicThemeNote(
    templateSource,
    isSingle ?? false,
    isPage ?? false,
    componentPlan?.type === 'page',
  );
  const planContext = [
    buildPlanContextNote(componentPlan),
    buildVisualPlanContextNote(componentPlan?.visualPlan),
  ]
    .filter(Boolean)
    .join('\n\n');
  const retryNote = retryError
    ? `## ERROR FROM PREVIOUS ATTEMPT\n${retryError}\nFIX THIS.${
        /jsx|closing tag|Expected corresponding|parse/i.test(retryError)
          ? '\n\n**Parsing:** Re-check every `<div>` / `<section>` / `<main>` / `<article>` — each must have a matching `</…>` in order. The file must be complete, valid TSX before `export default`.'
          : ''
      }${
        /Page detail contract|interface Page|post-only field/i.test(retryError)
          ? '\n\n**Page type:** `interface Page` must declare ONLY `{ id, title, content, slug }` — remove `author`, `categories`, `date`, `excerpt`, `featuredImage`, `comments` from it. Do NOT access `page.author` or `pageDetail.author`. Sidebar/list items (recent posts, etc.) must use a separate `interface Post` — using `item.author` inside a `posts.map()` is fine.'
          : ''
      }`
    : '';

  const slugFetchingNote =
    isSingle || isPage
      ? `## IMPORTANT — This is a detail/single view component
- Import \`useParams\` from \`react-router-dom\`
- Read the slug from URL: \`const { slug } = useParams<{ slug: string }>()\`
- Fetch the specific ${isSingle ? 'post' : 'page'} by slug:
  - ${isSingle ? '`GET /api/posts/:slug`' : '`GET /api/pages/:slug`'}
- If the response is null/404, show a "Not found" message
- Do NOT fetch the full list and pick index 0 — always use the slug from URL
- Always render \`${isSingle ? 'post' : 'page'}.title\` as a heading (e.g. \`<h1>{${isSingle ? 'post' : 'page'}.title}</h1>\`) above the content — do NOT skip it. \`title\` is a plain string, not an object
${
  isPage
    ? `- Page Detail Contract: NO \`author\`, \`categories\`, \`date\`, \`excerpt\`, \`featuredImage\`, \`comments\`.
- \`interface Page\` (MANDATORY for pages) must list only \`id, title, content, slug\`.
- Use \`item: Page | null\` state, not \`Post\`.`
    : ''
}`
      : '';

  return TEMPLATE.replace('{{componentName}}', componentName)
    .replace('{{apiContract}}', buildCanonicalApiContractNote())
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
  componentPlan?: ComponentPromptContext;
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

  const menuContextNote = buildMenusNote(input.content?.menus ?? input.menus);
  const dataGrounding = input.content
    ? buildDataGroundingNote(input.content)
    : '';
  const templateTexts = buildTemplateTextsNote(input.nodesJson);
  const imageSources = buildImageSourcesNote(input.nodesJson);
  const classicThemeNote = buildClassicThemeNote(
    input.nodesJson,
    isSingle ?? false,
    isPage ?? false,
    input.componentPlan?.type === 'page',
  );
  const sectionContextNote = `## Section context — CRITICAL
This is **section ${input.sectionIndex + 1} of ${input.totalSections}** of the \`${input.parentName}\` component.
⛔ DO NOT wrap in \`<header>\`, \`<nav>\`, or \`<footer>\` tags — those belong to other sections.
⛔ DO NOT duplicate page-level layout (no full-page wrapper, no navigation bar, no footer).
If this section needs runtime data, declare/fetch only the data actually rendered in this section.
Render ONLY the JSX for the blocks in the template source below.`;
  const planContext = [
    sectionContextNote,
    buildPlanContextNote(input.componentPlan),
    buildVisualPlanContextNote(input.componentPlan?.visualPlan),
  ]
    .filter(Boolean)
    .join('\n\n');
  const retryNote = input.retryError
    ? `## ERROR FROM PREVIOUS ATTEMPT\n${input.retryError}\nFIX THIS.`
    : '';

  const slugFetchingNote =
    isSingle || isPage
      ? `## Detail route context for this section
- The parent component route is slug-based.
- Only add \`useParams<{ slug: string }>()\` if this section truly renders ${isSingle ? 'post' : 'page'} detail data.
- If you need detail data in this section, fetch ${isSingle ? '`GET /api/posts/:slug`' : '`GET /api/pages/:slug`'} by slug. Never fetch the full list and pick index 0.
- Keep loading/error handling local to this section. Do NOT generate a full-page shell.`
      : '';

  return TEMPLATE.replace('{{componentName}}', input.sectionName)
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
