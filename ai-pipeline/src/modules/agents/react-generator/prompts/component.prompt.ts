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
    lines.push(
      '- `textColor` → `style={{color:"#hex"}}` (use the value as-is)',
    );
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
  retryError?: string,
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
  const retryNote = retryError
    ? `## ERROR FROM PREVIOUS ATTEMPT\n${retryError}\nFIX THIS.`
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
    .replace('{{retryError}}', retryNote)
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
  componentPlan?: {
    description?: string;
    dataNeeds?: string[];
    route?: string | null;
    isDetail?: boolean;
  };
  retryError?: string;
  content?: DbContentResult;
}): string {
  const isSingle =
    SINGLE_TEMPLATES.has(input.parentName) ||
    (input.componentPlan?.isDetail === true &&
      input.componentPlan?.dataNeeds?.includes('post-detail'));
  const isPage =
    PAGE_TEMPLATES.has(input.parentName) ||
    (input.componentPlan?.isDetail === true &&
      input.componentPlan?.dataNeeds?.includes('page-detail'));

  const menuContextNote = buildMenusNote(input.content?.menus ?? input.menus);
  const dataGrounding = input.content
    ? buildDataGroundingNote(input.content)
    : '';
  const templateTexts = buildTemplateTextsNote(input.nodesJson);
  const classicThemeNote = buildClassicThemeNote(input.nodesJson);
  const planContext = buildPlanContextNote(input.componentPlan);
  const retryNote = input.retryError
    ? `## ERROR FROM PREVIOUS ATTEMPT\n${input.retryError}\nFIX THIS.`
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
- Always render \`post.title\` as a heading (e.g. \`<h1>{post.title}</h1>\`) above the content — do NOT skip it. \`title\` is a plain string, not an object`
      : '';

  return TEMPLATE.replace('{{componentName}}', input.sectionName)
    .replace('{{menuContext}}', menuContextNote)
    .replace('{{planContext}}', planContext)
    .replace('{{slugFetchingNote}}', slugFetchingNote)
    .replace('{{classicThemeNote}}', classicThemeNote)
    .replace('{{themeTokens}}', buildThemeTokensNote(input.tokens))
    .replace('{{dataGrounding}}', dataGrounding)
    .replace('{{templateTexts}}', templateTexts)
    .replace('{{retryError}}', retryNote)
    .replace('{{siteName}}', input.siteInfo.siteName)
    .replace('{{siteUrl}}', input.siteInfo.siteUrl)
    .replace('{{templateSource}}', input.nodesJson);
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
