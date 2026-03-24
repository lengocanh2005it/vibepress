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
      tokens.colors.length === 0 &&
      tokens.spacing.length === 0)
  )
    return '';

  const lines: string[] = [
    '## Theme design tokens — use these Tailwind classes',
  ];

  if (tokens.fonts.length > 0) {
    lines.push('**Fonts** (use `font-[slug]` class):');
    for (const f of tokens.fonts) {
      lines.push(`- \`font-${f.slug}\` → ${f.name} (\`${f.family}\`)`);
    }
  }

  if (tokens.colors.length > 0) {
    lines.push(
      '**Colors** — when a block uses a color slug, use Tailwind arbitrary value with the exact hex:',
    )
    for (const c of tokens.colors) {
      lines.push(
        `- slug \`${c.slug}\` → use \`bg-[${c.value}]\` / \`text-[${c.value}]\` / \`border-[${c.value}]\``,
      );
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

export function buildComponentPrompt(
  componentName: string,
  templateSource: string,
  siteInfo: WpSiteInfo,
  content?: DbContentResult,
  tokens?: ThemeTokens,
): string {
  const isSingle = SINGLE_TEMPLATES.has(componentName);
  const isPage = PAGE_TEMPLATES.has(componentName);

  const menuContextNote = buildMenusNote(content?.menus ?? []);
  const dataGrounding = content ? buildDataGroundingNote(content) : '';
  const templateTexts = buildTemplateTextsNote(templateSource);
  const classicThemeNote = buildClassicThemeNote(templateSource);

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
- \`block: "cover"\` → full-width section with background image from \`src\` field
- \`block: "columns"\` → render children side by side (CSS grid/flex)
- \`block: "query"\` → fetch \`/api/posts\` and map over results; text inside query blocks comes from fetched data, NOT hardcoded
- \`html\` field → render with \`dangerouslySetInnerHTML\` in \`<div className="prose max-w-none">\`
- \`bgColor\` / \`textColor\` → look up the slug in the theme tokens table above and apply the corresponding hex using Tailwind arbitrary classes: \`bg-[#hex]\` / \`text-[#hex]\`. NEVER use \`bg-[slug]\` — always use the actual hex value.
- Replace ALL original CSS with Tailwind utility classes; no inline styles

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
