import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WpSiteInfo,
  WpMenu,
  WpPost,
  WpPage,
} from '../../../sql/wp-query.service.js';
import { DbContentResult } from '../../db-content/db-content.service.js';
import {
  wpBlocksToJson,
  stripTags,
} from '../../../../common/utils/wp-block-to-json.js';
import type { WpNode } from '../../../../common/utils/wp-block-to-json.js';
import type { ThemeTokens } from '../../../agents/block-parser/block-parser.service.js';

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
      '- `bgColor` → `style={{backgroundColor:"#hex"}}` (use the value as-is)',
    );
    lines.push('- `textColor` → `style={{color:"#hex"}}` (use the value as-is)');
    lines.push(
      '- If you need a color by CSS var (e.g. for root defaults), the palette is:',
    );
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
      if (style.typography?.fontWeight)
        parts.push(`weight \`font-[${style.typography.fontWeight}]\``);
      if (style.typography?.letterSpacing)
        parts.push(`tracking \`tracking-[${style.typography.letterSpacing}]\``);
      if (style.typography?.lineHeight)
        parts.push(`leading \`leading-[${style.typography.lineHeight}]\``);
      if (style.border?.radius)
        parts.push(`rounded \`rounded-[${style.border.radius}]\``);
      if (style.spacing?.padding)
        parts.push(`padding \`style={{padding:"${style.spacing.padding}"}}\``);
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
function buildClassicThemeNote(templateSource: string): string {
  if (!templateSource.includes('{/* WP:')) return '';

  return `## CLASSIC PHP THEME — MANDATORY RULES
This template source is from a **classic PHP theme** (identified by \`{/* WP: ... */}\` hint comments, NOT a JSON block tree).

### What each hint means — follow exactly:
- \`{/* WP: <Header /> */}\` → render site name (\`{siteInfo.siteName}\`) + fetch \`GET /api/menus\` and render ALL returned nav items
- \`{/* WP: <Navigation /> */}\` → fetch \`GET /api/menus\` and render ALL items — **NEVER write \`{/* No menus available */}\`**
- \`{/* WP: post.content (HTML) */}\` → fetch \`GET /api/pages\` and render \`pages[0]?.content\` with \`dangerouslySetInnerHTML={{ __html: pages[0]?.content ?? '' }}\`
- \`{/* WP: loop start */}\` → fetch \`GET /api/posts\` and map over results
- \`{/* WP: post.title */}\` → render \`{post.title}\` (inside loop)
- \`{/* WP: post.excerpt */}\` → render \`{post.excerpt}\` (inside loop)
- \`{/* WP: <Footer /> */}\` → render site name + fetch \`GET /api/menus\` for footer links

### ⛔ ABSOLUTE PROHIBITIONS for classic PHP themes:
1. **NEVER invent hero headings** like "Discover Your Next Adventure", "Build Something Amazing", etc. — these are FABRICATIONS
2. **NEVER write \`{/* No menus available */}\`** — if you fetch \`GET /api/menus\` and it returns items, you MUST render them
3. **NEVER hardcode paragraph text** like "Explore the world through our curated collection..." — all body text comes from \`GET /api/pages\` or \`GET /api/posts\`
4. **NO static hero section** unless the static text explicitly appears in the template source (after PHP stripping) in the \`## Static text\` list above
`;
}

// ── Data Grounding ─────────────────────────────────────────────────────────

export function buildDataGroundingNote(content: DbContentResult): string {
  const { siteInfo, posts, pages, menus } = content;
  const parts: string[] = [];

  parts.push(
    '## ACTUAL DATA from this site — do NOT invent anything outside this',
  );
  parts.push('');
  parts.push(
    '> Only use fields shown below. Any field not listed here does NOT exist.',
  );
  parts.push(
    '> Posts have: id, title, content, excerpt, slug, type, status, date, author, categories (string[]), featuredImage.',
  );
  parts.push(
    '> ⛔ NEVER render siteName more than once per component — one element only.',
  );
  parts.push('');

  // Site info
  parts.push('### Site info (GET /api/site-info)');
  parts.push(
    `siteName: "${siteInfo.siteName}" | siteUrl: "${siteInfo.siteUrl}" | blogDescription: "${siteInfo.blogDescription}"`,
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

  return parts.join('\n');
}

export function buildPlanContextNote(plan?: {
  description?: string;
  dataNeeds?: string[];
  route?: string | null;
}): string {
  if (!plan) return '';
  const lines: string[] = ['## Component plan'];
  if (plan.description) lines.push(`Purpose: ${plan.description}`);
  if (plan.route) lines.push(`Route: \`${plan.route}\``);
  if (plan.dataNeeds && plan.dataNeeds.length > 0)
    lines.push(`Data needed: ${plan.dataNeeds.join(', ')}`);
  return lines.join('\n');
}

export function buildComponentPrompt(
  componentName: string,
  templateSource: string,
  siteInfo: WpSiteInfo,
  content?: DbContentResult,
  tokens?: ThemeTokens,
  componentPlan?: {
    description?: string;
    dataNeeds?: string[];
    route?: string | null;
    isDetail?: boolean;
  },
): string {
  const isSingle =
    SINGLE_TEMPLATES.has(componentName) ||
    (componentPlan?.isDetail === true &&
      componentPlan?.dataNeeds?.includes('post-detail'));
  const isPage =
    PAGE_TEMPLATES.has(componentName) ||
    (componentPlan?.isDetail === true &&
      componentPlan?.dataNeeds?.includes('page-detail'));

  const menuContextNote = buildMenusNote(content?.menus ?? []);
  const dataGrounding = content ? buildDataGroundingNote(content) : '';
  const templateTexts = buildTemplateTextsNote(templateSource);
  const classicThemeNote = buildClassicThemeNote(templateSource);
  const planContext = buildPlanContextNote(componentPlan);

  const slugFetchingNote =
    isSingle || isPage
      ? `## IMPORTANT — This is a detail/single view component
- Import \`useParams\` from \`react-router-dom\`
- Read the slug from URL: \`const { slug } = useParams<{ slug: string }>()\`
- Fetch the specific ${isSingle ? 'post' : 'page'} by slug:
  - ${isSingle ? '`GET /api/posts/:slug`' : '`GET /api/pages/:slug`'}
- If the response is null/404, show a "Not found" message
- Do NOT fetch the full list and pick index 0 — always use the slug from URL
- Always render \`post.title\` as a heading (e.g. \`<h1>{post.title}</h1>\`) above the content — do NOT skip it. \`title\` is a plain string, not an object`
      : '';

  return TEMPLATE.replace('{{componentName}}', componentName)
    .replace('{{menuContext}}', menuContextNote)
    .replace('{{planContext}}', planContext)
    .replace('{{slugFetchingNote}}', slugFetchingNote)
    .replace('{{classicThemeNote}}', classicThemeNote)
    .replace('{{themeTokens}}', buildThemeTokensNote(tokens))
    .replace('{{dataGrounding}}', dataGrounding)
    .replace('{{templateTexts}}', templateTexts)
    .replace('{{siteName}}', siteInfo.siteName)
    .replace('{{siteUrl}}', siteInfo.siteUrl)
    .replace('{{templateSource}}', templateSource);
}

/**
 * Lightweight prompt for sub-components generated by section chunking.
 * No routing, no useParams, no page-level fetching.
 * The parent assembly component handles routing; each section just renders its slice.
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
  content?: DbContentResult;
}): string {
  const {
    sectionName,
    parentName,
    sectionIndex,
    totalSections,
    nodesJson,
    siteInfo,
    menus,
    tokens,
    content,
  } = input;

  const tokensNote = buildThemeTokensNote(tokens);
  const menusNote = buildMenusNote(menus);
  const groundingNote = buildDataGroundingNote(
    content ?? { siteInfo, posts: [], pages: [], menus },
  );
  const templateTexts = buildTemplateTextsNote(nodesJson);

  return `You are a WordPress-to-React migration expert.

Convert the partial WordPress template section below into a clean React functional component using TypeScript + TSX + Tailwind CSS.

## Context
- This component is section ${sectionIndex + 1} of ${totalSections} for the \`${parentName}\` page.
- Component name: \`${sectionName}\`
- It accepts NO props. It fetches its own data if needed (posts list, menus, etc.).
- Site name: ${siteInfo.siteName}
- Site URL: ${siteInfo.siteUrl}

## Rules — CRITICAL
- Do NOT add routing logic (\`useParams\`, \`<Route>\`, navigation to detail pages).
- Do NOT fetch a single post/page by slug — this section is not a detail view.
- DO fetch lists if the template structure calls for it (e.g. \`block: "query"\` → \`GET /api/posts\`).
- DO fetch menus whenever the section has any \`block: "navigation"\` node (\`GET /api/menus\`).
- \`block: "navigation"\` → **ALWAYS fetch \`GET /api/menus\`**. NEVER render navigation-link children as static \`<a>\` tags.
  - If the navigation node has \`navigation-link\` children, use their \`text\` values as hints to pick the right menu: find the menu whose name/items best match (e.g. children "Team","History" → menu named "About"). Render items from that API menu, filtered by \`parentId === 0\`.
  - If no match found or no children, fall back to \`menus.find(m => m.slug === 'primary') ?? menus[0]\`.
  - NEVER skip or write "no menus available".
- \`block: "site-logo"\` → **skip entirely** — do not render image, fallback text, or siteName here.
- **Footer navigation**: Only render menus that actually exist in the API response. Do NOT invent sections with hardcoded links.
- Export the component as default: \`export default ${sectionName};\`
- Return ONLY raw TSX code. NO markdown fences, NO explanation. Start with \`import React\`.

## Available API endpoints — ALWAYS use relative paths like \`/api/posts\`, NEVER hardcode \`http://localhost:PORT/api/...\`
- \`GET /api/posts\` → \`{ id, title: string, content: string, excerpt: string, slug, type, status, date: string, author: string, categories: string[], featuredImage: string|null }[]\` — sorted newest first
- \`GET /api/posts/:slug\` → same shape as above (single post)
- \`GET /api/pages\` → \`{ id, title: string, content: string, slug, menuOrder, template }[]\`
- \`GET /api/menus\` → \`{ name, slug, items: { id, title, url, order, parentId }[] }[]\`
- \`GET /api/site-info\` → \`{ siteUrl, siteName, blogDescription, adminEmail, language }\`
- **CRITICAL — ONLY these fields exist. Do NOT access \`post.tags\`, \`post.title.rendered\`, or any unlisted field — they are \`undefined\` and cause runtime errors.**
- \`featuredImage\` is a full URL string or \`null\` — render with \`<img src={post.featuredImage} />\` only when not null
- \`title\` and \`content\` are plain strings — use directly, not \`.rendered\`

${menusNote}

${groundingNote}

## Data fetching rules
- Use \`useEffect\` + \`useState\` for async fetching
- Show a loading state (\`if (loading) return <div>Loading...</div>\`)
- Handle errors (\`if (error) return <div>Error loading content</div>\`)

## Layout + content rules
- **Preserve the exact order of blocks** in the JSON
- \`src\` fields → use as image \`src\`; paths like \`/wp-content/uploads/...\` keep as-is
- \`block: "cover"\` → **CRITICAL**: render as a \`<div>\` with CSS \`backgroundImage\` — the \`src\` field is a background photo, NOT a figure/img. Use \`style={{backgroundImage:"url('"+src+"')", backgroundSize:'cover', backgroundPosition:'center', minHeight: minHeight ?? '500px'}}\` on the outer div. Content goes on top inside a \`relative z-10\` child. Add \`<div className="absolute inset-0 bg-black" style={{opacity:(dimRatio??0)/100}} />\` overlay when dimRatio > 0. **⛔ NEVER use \`<img src={src}>\` for a cover block.**
- \`block: "columns"\` → render children side by side (CSS grid/flex)
- \`block: "query"\` → fetch \`/api/posts\` and map over results. Inner blocks: \`post-title\` → \`<a href={'/post/'+post.slug}>{post.title}</a>\`; \`post-date\` → \`<time className="whitespace-nowrap">{post.date}</time>\` (always \`whitespace-nowrap\` — never let the date break across lines); \`post-author\` → \`<span>by {post.author}</span>\`; \`post-excerpt\` → \`<p>{post.excerpt}</p>\`; \`post-featured-image\` → conditional \`<img src={post.featuredImage} />\`. If the post row shows columns (title | date | meta), use \`flex items-baseline gap-4\` with \`flex-1\` on title and \`whitespace-nowrap shrink-0\` on date/meta to prevent narrow cells.
- \`html\` field → render with \`dangerouslySetInnerHTML\` in \`<div className="prose max-w-none">\`
- \`bgColor\` / \`textColor\` fields in the JSON are already resolved hex values — apply directly: \`style={{backgroundColor:'#hex'}}\` / \`style={{color:'#hex'}}\`. NEVER use generic Tailwind colors like \`text-gray-700\`, \`bg-white\`.
- \`overlayColor\` on a cover node is already a hex value — use \`style={{backgroundColor:'#hex'}}\` for the overlay div. If absent, fall back to \`bg-black\`.
- **Default colors**: root wrapper uses \`style={{backgroundColor:'var(--wp--preset--color--base,#fff)',color:'var(--wp--preset--color--contrast,#000)'}}\`.
- **Block padding** (\`padding\`): values already in px/rem — apply as \`pt-[top] pr-[right] pb-[bottom] pl-[left]\`.
- **Block margin** (\`margin\`): apply as \`mt-[top] mr-[right] mb-[bottom] ml-[left]\`. Never skip.
- **Column width** (\`columnWidth\`): apply \`style={{flexBasis:'XX%',flexGrow:0,flexShrink:0}}\` on \`block:"column"\` elements.
- **Text alignment** (\`textAlign\`): apply \`text-left\` / \`text-center\` / \`text-right\` directly.
- **Section width** (\`align\`): \`"full"\` → \`w-full\`; \`"wide"\` → \`style={{maxWidth:'var(--wp--style--global--wide-size)'}} className="mx-auto w-full"\`; absent → content max-width.
- **Font family on block** (\`fontFamily\` slug): \`style={{fontFamily:'var(--wp--preset--font-family--{slug})'}}\`.
- **Font sizes** slug → \`style={{fontSize:'var(--wp--preset--font-size--{slug})'}}\`. NEVER use \`text-sm\`, \`text-xl\`, etc.
- **Gap / spacing** → \`style={{gap:'var(--wp--style--block-gap)'}}\` for block-level gap; spacing values in JSON are already resolved to px/rem.
- **WP block class names**: add \`wp-block-{type}\` to each block's outermost element (e.g. \`wp-block-cover\`, \`wp-block-columns\`, \`wp-block-group is-layout-flex\`, \`wp-block-query\`). These classes have layout CSS pre-defined — you get flex/grid/cover layout for free.
- Use Tailwind ONLY for fine-grained layout utilities: \`flex\`, \`grid\`, \`items-center\`, \`justify-between\`, \`w-full\`, \`mx-auto\`, \`relative\`, \`absolute\`, \`z-10\`, \`overflow-hidden\`, \`min-h-[value]\`.

## GOLDEN RULE — Two sources only
Every piece of content must come from EXACTLY one of:
1. **Template JSON** below — static structural text, image URLs, layout
2. **API / Database** — dynamic content: site name, posts, pages, menus

If content is not in the JSON AND not fetchable from the API → **omit it entirely**. Never invent, guess, or paraphrase.

${templateTexts}
**Text content rules:**
- Text outside \`block: "query"\` → hardcode EXACTLY the \`text\` field value from the JSON — do NOT paraphrase
- Text inside \`block: "query"\` → comes from fetched posts/pages data
- Site name/description → \`GET /api/site-info\`
- Navigation/footer links → \`GET /api/menus\`
- **NEVER invent text** not present in the JSON or API response
- **⛔ NEVER render \`siteName\` more than once** — if you render it via \`block: "site-title"\`, skip any other \`text\` field that duplicates it

${tokensNote}

## Section template (JSON) — section ${sectionIndex + 1}/${totalSections}
${nodesJson}
`;
}

function buildPageContentNote(
  componentName: string,
  content?: DbContentResult,
): string {
  if (!content) return '';

  const slug = componentName.replace(/([A-Z])/g, (_, l, i) =>
    i === 0 ? l.toLowerCase() : `-${l.toLowerCase()}`,
  );

  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const slugNorm = normalize(slug);

  const page = content.pages.find((p) => {
    if (normalize(p.slug) === slugNorm) return true;
    if (p.template && normalize(p.template).includes(slugNorm)) return true;
    if (normalize(p.title ?? '').includes(slugNorm)) return true;
    return false;
  });

  if (!page) return '';

  const texts = extractTexts(wpBlocksToJson(page.content ?? ''));

  const textList =
    texts.length > 0
      ? texts.map((t) => `- "${t}"`).join('\n')
      : '(no static text found)';

  return `
## Page content from database
This component renders the page **"${page.title}"** (slug: \`${page.slug}\`).

**CRITICAL — use these exact strings for ALL static text in this component (headings, paragraphs, buttons, labels). Do NOT invent or paraphrase any text:**
${textList}
`;
}
