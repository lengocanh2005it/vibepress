import type { DbContentResult } from '../../db-content/db-content.service.js';
import type { ThemeTokens } from '../../block-parser/block-parser.service.js';
import type {
  ColorPalette,
  ComponentVisualPlan,
  DataNeed,
  SectionPlan,
} from '../visual-plan.schema.js';

/**
 * Build the Stage 1 prompt: ask AI to analyze a template and return a
 * ComponentVisualPlan JSON — NOT TSX code.
 */
export function buildVisualPlanPrompt(input: {
  componentName: string;
  templateSource: string; // pre-parsed block JSON string or PHP markup
  content: DbContentResult;
  tokens?: ThemeTokens;
}): { systemPrompt: string; userPrompt: string } {
  const { componentName, templateSource, content, tokens } = input;

  const palette = buildPaletteHint(tokens);
  const siteCtx = buildSiteContext(content);

  const systemPrompt = `You are a WordPress-to-React UI planner.
Given a WordPress template (block JSON tree or PHP markup) and site context, you output a JSON ComponentVisualPlan describing the visual layout.
You do NOT write TSX code — only a structured JSON plan.

## ComponentVisualPlan schema

\`\`\`typescript
interface ComponentVisualPlan {
  componentName: string;
  dataNeeds: Array<'siteInfo' | 'posts' | 'pages' | 'menus' | 'postDetail' | 'pageDetail'>;
  palette: {
    background: string;  // hex
    surface: string;     // card backgrounds hex
    text: string;        // primary text hex
    textMuted: string;   // secondary text hex
    accent: string;      // links/buttons hex
    accentText: string;  // text on accent hex
    dark?: string;       // dark section bg hex
    darkText?: string;   // text on dark sections hex
  };
  sections: SectionPlan[];
}
\`\`\`

## Available section types

| type | use when |
|---|---|
| \`navbar\` | header/navigation bar |
| \`hero\` | large heading + optional CTA + optional image |
| \`cover\` | full-width image with overlay text |
| \`post-list\` | list or grid of blog posts from API |
| \`card-grid\` | static grid of feature cards |
| \`media-text\` | image beside text content |
| \`testimonial\` | quote block with author |
| \`newsletter\` | email signup section |
| \`footer\` | page footer with nav columns |
| \`post-content\` | single post detail (uses :slug param) |
| \`page-content\` | single page detail (uses :slug param) |
| \`search\` | search input + results |
| \`breadcrumb\` | breadcrumb trail |
| \`custom\` | LAST RESORT for anything not in list — provide the JSX directly in the \`jsx\` field |

## Section schemas (key fields only)

\`\`\`
navbar:       { sticky, menuSlug, cta? }
hero:         { layout: centered|left|split, heading, subheading?, cta?, image? }
cover:        { imageSrc, dimRatio, minHeight, heading?, subheading?, cta?, contentAlign }
post-list:    { title?, layout: list|grid-2|grid-3, showDate, showAuthor, showCategory, showExcerpt, showFeaturedImage }
card-grid:    { title?, subtitle?, columns: 2|3|4, cards: [{heading,body}] }
media-text:   { imageSrc, imageAlt, imagePosition: left|right, heading?, body?, listItems?, cta? }
testimonial:  { quote, authorName, authorTitle?, authorAvatar? }
newsletter:   { heading, subheading?, buttonText, layout: centered|card }
footer:       { brandDescription?, menuColumns: [{title,menuSlug}], copyright? }
post-content: { showTitle, showMeta }
page-content: { showTitle }
search:       { title? }
breadcrumb:   {}
custom:       { description, jsx: "<JSX string>", imports?: ["import ..."] }
\`\`\`

## Rules
- Use ONLY hex colors. Derive from theme tokens if available, otherwise use sensible defaults matching the template's visual style.
- Text content in sections (headings, body text, card copy) must come EXACTLY from the template source — no invented text.
- If a section has a background image, use the exact \`src\` from the template.
- For \`custom\` sections: the \`jsx\` field must be valid JSX, use variables \`siteInfo\`, \`posts\`, \`menus\`, \`params\` that will be in scope.
- Output ONLY valid JSON — no markdown fences, no explanation.`;

  const userPrompt = `## Component to plan: ${componentName}

${siteCtx}

${palette}

## Template source

${templateSource}

## Output

Return a single valid JSON object matching ComponentVisualPlan. No markdown, no explanation.`;

  return { systemPrompt, userPrompt };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildPaletteHint(tokens?: ThemeTokens): string {
  if (!tokens?.defaults) return '';

  const d = tokens.defaults;
  const lines: string[] = ['## Theme palette hints (use for the palette field)'];
  if (d.bgColor) lines.push(`- background: "${d.bgColor}"`);
  if (d.textColor) lines.push(`- text: "${d.textColor}"`);
  if (d.headingColor) lines.push(`- headings: "${d.headingColor}"`);
  if (d.linkColor) lines.push(`- links/accent: "${d.linkColor}"`);
  if (d.buttonBgColor) lines.push(`- button bg: "${d.buttonBgColor}"`);
  if (d.buttonTextColor) lines.push(`- button text: "${d.buttonTextColor}"`);

  if (tokens.colors.length > 0) {
    lines.push('- Available palette colors:');
    for (const c of tokens.colors.slice(0, 12)) {
      lines.push(`  - ${c.slug}: ${c.value}`);
    }
  }

  return lines.join('\n');
}

function buildSiteContext(content: DbContentResult): string {
  const lines: string[] = ['## Site context'];
  lines.push(`Site name: ${content.siteInfo.siteName}`);
  lines.push(`Description: ${content.siteInfo.blogDescription || '(none)'}`);
  lines.push(`Menus: ${content.menus.map((m) => `${m.name} (slug: ${m.slug})`).join(', ') || '(none)'}`);
  lines.push(`Posts in DB: ${content.posts.length}`);
  lines.push(`Pages in DB: ${content.pages.length}`);
  return lines.join('\n');
}

// ── Validation constants ───────────────────────────────────────────────────

const VALID_SECTION_TYPES = new Set<string>([
  'navbar', 'hero', 'cover', 'post-list', 'card-grid', 'media-text',
  'testimonial', 'newsletter', 'footer', 'post-content', 'page-content',
  'search', 'breadcrumb', 'custom',
]);

const VALID_DATA_NEEDS = new Set<string>([
  'siteInfo', 'posts', 'pages', 'menus', 'postDetail', 'pageDetail',
]);

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const PALETTE_DEFAULTS: Record<string, string> = {
  background: '#ffffff',
  surface: '#f5f5f5',
  text: '#111111',
  textMuted: '#666666',
  accent: '#0066cc',
  accentText: '#ffffff',
};

function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

/**
 * Sanitize the palette object: replace missing or non-hex values with
 * sensible defaults so we never fail an entire plan over bad colors.
 */
function sanitizePalette(raw: any): ColorPalette {
  const result: any = {};
  for (const key of ['background', 'surface', 'text', 'textMuted', 'accent', 'accentText']) {
    result[key] = isHex(raw?.[key]) ? raw[key] : PALETTE_DEFAULTS[key];
  }
  if (isHex(raw?.dark)) result.dark = raw.dark;
  if (isHex(raw?.darkText)) result.darkText = raw.darkText;
  return result as ColorPalette;
}

/**
 * Validate one section object. Returns the (potentially auto-repaired) section
 * or null if the section is structurally broken and cannot be used.
 *
 * Strategy:
 *  - Unknown `type` → null (would silently produce empty output in code-generator)
 *  - Missing required string content (e.g. imageSrc, jsx) → null
 *  - Missing/wrong scalar config → auto-repair with sensible defaults
 *  - Missing array fields that are mapped over → auto-repair with empty array
 */
function validateSection(raw: any): SectionPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type as string;
  if (!VALID_SECTION_TYPES.has(type)) return null;

  // eslint-disable-next-line default-case
  switch (type) {
    case 'navbar':
      if (typeof raw.menuSlug !== 'string' || !raw.menuSlug) raw.menuSlug = 'primary';
      if (typeof raw.sticky !== 'boolean') raw.sticky = false;
      break;

    case 'hero':
      if (!['centered', 'left', 'split'].includes(raw.layout)) raw.layout = 'centered';
      if (typeof raw.heading !== 'string') raw.heading = '';
      break;

    case 'cover':
      if (typeof raw.imageSrc !== 'string' || !raw.imageSrc) return null;
      if (typeof raw.dimRatio !== 'number') raw.dimRatio = 50;
      if (typeof raw.minHeight !== 'string') raw.minHeight = '400px';
      if (!['center', 'left', 'right'].includes(raw.contentAlign)) raw.contentAlign = 'center';
      break;

    case 'post-list':
      if (!['list', 'grid-2', 'grid-3'].includes(raw.layout)) raw.layout = 'grid-3';
      for (const f of ['showDate', 'showAuthor', 'showCategory', 'showExcerpt', 'showFeaturedImage']) {
        if (typeof raw[f] !== 'boolean') raw[f] = true;
      }
      break;

    case 'card-grid':
      if (!Array.isArray(raw.cards) || raw.cards.length === 0) return null;
      if (![2, 3, 4].includes(raw.columns)) raw.columns = 3;
      // Ensure each card has heading + body strings
      raw.cards = (raw.cards as any[]).filter(
        (c) => c && typeof c.heading === 'string' && typeof c.body === 'string',
      );
      if (raw.cards.length === 0) return null;
      break;

    case 'media-text':
      if (typeof raw.imageSrc !== 'string' || !raw.imageSrc) return null;
      if (typeof raw.imageAlt !== 'string') raw.imageAlt = '';
      if (!['left', 'right'].includes(raw.imagePosition)) raw.imagePosition = 'left';
      break;

    case 'testimonial':
      if (typeof raw.quote !== 'string' || !raw.quote.trim()) return null;
      if (typeof raw.authorName !== 'string') raw.authorName = '';
      break;

    case 'newsletter':
      if (typeof raw.heading !== 'string') raw.heading = 'Subscribe to our newsletter';
      if (typeof raw.buttonText !== 'string') raw.buttonText = 'Subscribe';
      if (!['centered', 'card'].includes(raw.layout)) raw.layout = 'centered';
      break;

    case 'footer':
      if (!Array.isArray(raw.menuColumns)) raw.menuColumns = [];
      break;

    case 'post-content':
      if (typeof raw.showTitle !== 'boolean') raw.showTitle = true;
      if (typeof raw.showMeta !== 'boolean') raw.showMeta = true;
      break;

    case 'page-content':
      if (typeof raw.showTitle !== 'boolean') raw.showTitle = true;
      break;

    case 'custom':
      if (typeof raw.jsx !== 'string' || !raw.jsx.trim()) return null;
      if (typeof raw.description !== 'string') raw.description = 'Custom section';
      if (!Array.isArray(raw.imports)) raw.imports = [];
      break;

    // search, breadcrumb — no required fields
  }

  return raw as SectionPlan;
}

/**
 * Parse and validate the AI response into a ComponentVisualPlan.
 *
 * - Palette: sanitized (bad hex → defaults), never rejects plan
 * - Sections: each validated individually; invalid sections are dropped
 * - Returns null only when JSON is unparseable or all sections are invalid
 */
export function parseVisualPlan(
  raw: string,
  componentName: string,
): ComponentVisualPlan | null {
  const cleaned = raw
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.sections)) return null;

  const palette = sanitizePalette(parsed.palette);

  const sections: SectionPlan[] = [];
  for (const rawSection of parsed.sections) {
    const validated = validateSection(rawSection);
    if (validated) {
      sections.push(validated);
    }
  }

  if (sections.length === 0) return null;

  const dataNeeds: DataNeed[] = Array.isArray(parsed.dataNeeds)
    ? (parsed.dataNeeds as any[]).filter((d): d is DataNeed => VALID_DATA_NEEDS.has(d))
    : [];

  return { componentName, dataNeeds, palette, sections };
}
