import type { DbContentResult } from '../../db-content/db-content.service.js';
import type { ThemeTokens } from '../../block-parser/block-parser.service.js';
import type { RepoThemeManifest } from '../../repo-analyzer/repo-analyzer.service.js';
import { buildRepoManifestContextNote } from '../../repo-analyzer/repo-manifest-context.js';
import type {
  ColorPalette,
  ComponentVisualPlan,
  ComponentPresentationPlan,
  SectionPresentationPatch,
  DataNeed,
  SectionPlan,
} from '../visual-plan.schema.js';
import {
  formatInventedAuxiliarySectionLabels,
  pruneTrailingInventedAuxiliarySections,
} from '../auxiliary-section.guard.js';

/**
 * Build the Stage 1 prompt: ask AI to analyze a template and return a
 * ComponentVisualPlan JSON — NOT TSX code.
 */
export function buildVisualPlanPrompt(input: {
  componentName: string;
  templateSource: string; // pre-parsed block JSON string or PHP markup
  content: DbContentResult;
  tokens?: ThemeTokens;
  repoManifest?: RepoThemeManifest;
  componentType?: 'page' | 'partial';
  route?: string | null;
  isDetail?: boolean;
  dataNeeds?: DataNeed[];
  sourceAnalysis?: string;
  sourceBackedAuxiliaryLabels?: string[];
  /** Pre-computed ordered draft sections from WpNodeToSectionsMapper. When present,
   *  AI must preserve this order and only fill in missing content fields. */
  draftSections?: SectionPlan[];
  editRequestContextNote?: string;
}): { systemPrompt: string; userPrompt: string } {
  const {
    componentName,
    templateSource,
    content,
    tokens,
    repoManifest,
    componentType,
    route,
    isDetail,
    dataNeeds,
    sourceAnalysis,
    sourceBackedAuxiliaryLabels,
    draftSections,
    editRequestContextNote,
  } = input;

  const palette = buildPaletteHint(tokens);
  const siteCtx = buildSiteContext(content);
  const imageHints = buildImageSourcesHint(templateSource);
  const repoContext = buildRepoManifestContextNote(repoManifest);
  const patternHints = buildPatternSuggestionsHint(repoManifest);
  const contractHint = buildContractHint({
    componentName,
    componentType,
    route,
    isDetail,
    dataNeeds,
  });

  const systemPrompt = `You are a WordPress-to-React UI planner.
Given a WordPress template (block JSON tree or PHP markup) and site context, you output a JSON ComponentVisualPlan describing the visual layout.
You do NOT write TSX code — only a structured JSON plan.

Primary goal: preserve the ORIGINAL WordPress UI as faithfully as possible.
This is a migration plan, NOT a redesign brief.

## ComponentVisualPlan schema

\`\`\`typescript
interface ComponentVisualPlan {
  componentName: string;
  dataNeeds: Array<'siteInfo' | 'posts' | 'pages' | 'menus' | 'postDetail' | 'pageDetail' | 'comments'>;
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

Every section also supports optional exact spacing fields, preserved custom class hooks, and source layout metadata from the template: \`\`\`
{ textAlign?: "left"|"center"|"right", contentWidth?: string, paddingStyle?: string, marginStyle?: string, gapStyle?: string, customClassNames?: string[], sourceLayout?: { type?, orientation?, justifyContent?, flexWrap?, verticalAlignment?, columnCount?, minimumColumnWidth?, contentSize?, wideSize? } }
\`\`\`
Use them when the template source exposes real alignment, constrained widths, spacing values, explicit custom classes, or concrete wrapper layout attrs and you can preserve them exactly.

Typography and exact column-ratio metadata may also appear when the template exposes them:
\`\`\`
{
  headingStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  subheadingStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  bodyStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  columnWidths?: string[]
}
\`\`\`

## Available section types

| type | use when |
|---|---|
| \`navbar\` | header/navigation bar |
| \`hero\` | large heading + optional CTA + optional image; \`centered\` / \`left\` heroes keep image BELOW text, only \`split\` may place image beside text |
| \`cover\` | full-width image with overlay text |
| \`post-list\` | list or grid of blog posts from API |
| \`card-grid\` | static grid of feature cards |
| \`media-text\` | image beside text content |
| \`testimonial\` | quote block with author |
| \`newsletter\` | email signup section |
| \`footer\` | page footer with nav columns |
| \`post-content\` | single post detail (uses :slug param) |
| \`page-content\` | single page detail (uses :slug param) |
| \`comments\`     | WordPress comments list + leave a reply form |
| \`search\` | search input + results |
| \`breadcrumb\` | breadcrumb trail |
| \`sidebar\` | sidebar column for page/post layouts with menus, page links, or recent posts |
| \`tabs\` | interactive tabbed content block |
| \`slider\` | interactive slide/carousel block |
| \`modal\` | interactive modal/dialog trigger + content |
| \`accordion\` | interactive accordion / FAQ block |
| \`button-group\` | standalone row of one or more CTA buttons |

## Section schemas (key fields only)

\`\`\`
navbar:       { sticky, menuSlug, cta? }
hero:         { layout: centered|left|split, heading, subheading?, headingStyle?, subheadingStyle?, cta?, image? } // centered|left => vertical stack (text first, image below)
cover:        { imageSrc, dimRatio, minHeight, heading?, subheading?, headingStyle?, subheadingStyle?, cta?, contentAlign }
post-list:    { title?, layout: list|grid-2|grid-3, showDate, showAuthor, showCategory, showExcerpt, showFeaturedImage }
card-grid:    { title?, subtitle?, columns: 2|3|4, columnWidths?, cards: [{heading,body}] }
media-text:   { imageSrc, imageAlt, imagePosition: left|right, columnWidths?, heading?, body?, headingStyle?, bodyStyle?, listItems?, cta? }
testimonial:  { quote, authorName, authorTitle?, authorAvatar? }
newsletter:   { heading, subheading?, buttonText, layout: centered|card }
footer:       { brandDescription?, menuColumns: [{title,menuSlug}], copyright? }
post-content: { showTitle, showAuthor, showDate, showCategories }
page-content: { showTitle }
comments:     { showForm, requireName, requireEmail }
search:       { title? }
breadcrumb:   {}
sidebar:      { title?, menuSlug?, showSiteInfo, showPages, showPosts, maxItems? }
tabs:         { tabs: [{label,content}] }
slider:       { slides: [{heading?,description?,cta?}], autoplay? }
modal:        { triggerText, heading?, description?, cta? }
accordion:    { items: [{title,content?}] }
button-group: { align: left|center|right, buttons: [{text,link}] }
\`\`\`

## Rules
- Preserve the original WordPress layout hierarchy and reading order as closely as possible.
- When a "## Detected section order" block is present in the user message: treat its "sections" array as the AUTHORITATIVE order. Fill in content fields but do NOT reorder or remove sections.
- When deterministic draft sections are provided, keep a 1:1 mapping between draft entries and output \`sections\` entries whenever adjacent draft entries have different \`sectionKey\` or different \`sourceRef.sourceNodeId\`.
- Do NOT merge two adjacent draft sections into one \`hero\`, \`cover\`, or \`media-text\` section just because they look visually related.
- If an earlier draft section owns the heading/body/CTA and a later draft section owns the image, keep them as two separate sections in the JSON output. The later image must NOT be pulled up beside the earlier text block.
- \`hero.layout: "split"\` is allowed ONLY when that SAME single draft section already contains both the text content and the image/media content under one shared wrapper/source node.
- If a single hero section contains both text and image but the source does NOT show an explicit side-by-side wrapper, columns block, media-text block, or left/right column ratio, use \`layout: "centered"\` or \`layout: "left"\` and keep the image BELOW the text content.
- Do NOT use \`hero.layout: "split"\` just because the overall page contains both copy and an image in the same broad hero area. Split is only valid when the source structure itself proves a horizontal two-column relationship.
- \`media-text\` is allowed ONLY when the source wrapper itself is a real image-beside-text block (for example a WordPress media-text block or one columns/group wrapper that clearly contains both sides). It must NOT be used to fuse separate sibling sections.
- Keep the same major wrappers/regions from the template source. Do NOT upgrade a simple block into a dramatic hero, promo banner, testimonial strip, or newsletter section unless the template clearly contains that section already.
- Do NOT add decorative sections, marketing content, or stronger CTAs than the original template shows.
- Use ONLY hex colors. Derive them from theme tokens first, then from explicit template colors/classes if present. Do NOT invent a new palette direction.
- Text content in sections (headings, body text, card copy) must come EXACTLY from the template source — no invented text.
- If the source already contains inline HTML formatting such as \`<strong>\`, \`<em>\`, or links inside body text or list items, preserve that markup in the JSON string instead of flattening it to plain text.
- If you need to output a dynamic variable (e.g. {item.title} or {post.title}), use EXACTLY ONE pair of curly braces. NEVER use double braces like {{item.title}} or {{post.title}}, as it breaks JSX syntax.
- If a section has a background image, use the exact \`src\` from the template.
- Never invent image URLs, avatars, featured artwork, or placeholder media. If the template source does not contain an image source for that section, omit the image/avatar field entirely.
- For testimonial sections specifically: only set \`authorAvatar\` when the template source contains a matching real image source. Otherwise omit \`authorAvatar\`.
- Preserve exact padding/margin/gap from the template when visible by filling \`paddingStyle\` / \`marginStyle\` / \`gapStyle\` with concrete CSS shorthand values.
- Preserve exact text alignment from source blocks by filling \`textAlign\` when the original heading/body is explicitly left/center/right aligned.
- Preserve constrained inner widths from source wrappers by filling \`contentWidth\` when a section's intro/body content sits inside a real WordPress \`contentSize\`-style container (for example \`620px\` prose width inside a wider full-width section).
- If a centered intro section sits inside a wide/full wrapper and the source shows long centered paragraph copy but no explicit \`contentSize\`, do NOT leave that body copy edge-to-edge. Add a reasonable \`contentWidth\` for the intro/body copy so it wraps similarly to WordPress instead of stretching across the whole wide container.
- Preserve source-level custom classes by carrying them into \`customClassNames\` when a draft section or source node already exposes them. Do NOT drop or rename these classes.
- Preserve source-level wrapper layout metadata by carrying \`sourceLayout\` forward when the draft already exposes real WordPress block layout attrs such as \`type: "flex"\`, \`justifyContent: "space-between"\`, \`orientation\`, \`flexWrap\`, or constrained layout widths like \`contentSize\` / \`wideSize\`.
- Preserve exact per-block typography and explicit column ratios when the template source exposes them; do not flatten them back to generic defaults.
- When a source WP node has \`typography.fontWeight\` (e.g. "700" or "bold"), propagate it to the section's \`bodyStyle.fontWeight\` or \`headingStyle.fontWeight\` accordingly. Do NOT drop bold/weight overrides set on individual blocks.
- Preserve the original alignment, column count, and section density when the template source makes them visible.
- NEVER output a \`custom\` / raw JSX section. If a template has a sidebar layout, use a \`sidebar\` section plus the normal \`page-content\` or \`post-content\` section.
- For sidebar page templates, place the \`sidebar\` section immediately after the main \`page-content\` or \`post-content\` section.
- When \`pageDetail\` is in dataNeeds: the WordPress page API exposes \`id, title, content, slug, parentId, menuOrder, template, featuredImage\`. Do not plan UI that requires post-only fields (author, categories, tags, date, excerpt, comments) on **pages** — those apply to posts only.
- The approved component contract is authoritative. Do NOT invent sections or data access outside that contract.
- If the approved component type is \`page\`, NEVER emit \`navbar\` or \`footer\` sections. Shared site chrome belongs to dedicated layout partials, not pages.
- If the approved component type is \`page\` and you emit a \`sidebar\` section, that sidebar must be content-only: use \`showPages\` and/or \`showPosts\`, but NEVER set \`menuSlug\` or \`showSiteInfo\`.
- For page/listing/body components, do NOT add trailing utility/footer/sidebar-like sections or headings such as ${formatInventedAuxiliarySectionLabels()} unless that EXACT label is already source-backed in the scoped template source or deterministic draft sections supplied in the user prompt.
- Emit \`post-content\` only when the approved dataNeeds include \`postDetail\`. Emit \`page-content\` only when the approved dataNeeds include \`pageDetail\`.
- Emit \`comments\` only when the approved dataNeeds include \`postDetail\` or \`comments\`.
- Output ONLY valid JSON — no markdown fences, no explanation.`;

  const draftHint = buildDraftSectionsHint(draftSections);

  const userPrompt = `## Component to plan: ${componentName}

${contractHint}

${buildAuxiliaryGuardHint(sourceBackedAuxiliaryLabels)}

${sourceAnalysis ? `${sourceAnalysis}\n\n` : ''}${repoContext ? `${repoContext}\n\n` : ''}${patternHints ? `${patternHints}\n\n` : ''}${siteCtx}

${palette}

${imageHints}

${editRequestContextNote ? `${editRequestContextNote}\n\n` : ''}${draftHint ? `${draftHint}\n\n` : ''}## Template source

${templateSource}

## Output

Return a single valid JSON object matching ComponentVisualPlan. No markdown, no explanation.`;

  return { systemPrompt, userPrompt };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildDraftSectionsHint(draftSections?: SectionPlan[]): string {
  if (!draftSections || draftSections.length === 0) return '';

  const interactiveTypes = new Set(['slider', 'tabs', 'modal', 'accordion']);
  const sourceBackedTypes = new Set([
    'slider',
    'tabs',
    'modal',
    'accordion',
    'button-group',
    'cover',
    'post-list',
    'card-grid',
    'media-text',
  ]);

  const hasInteractive = draftSections.some((s) =>
    interactiveTypes.has(s.type),
  );
  const sourceBackedSections = draftSections.filter((s) =>
    sourceBackedTypes.has(s.type),
  );

  const lines = [
    '## Detected section order (deterministic, from WordPress block tree)',
    `The following ${draftSections.length} sections were detected in the EXACT order they appear in the WordPress template.`,
    '',
    '### HARD CONSTRAINTS — violating any of these will cause the plan to be rejected:',
    `⛔ Your \`sections\` array MUST contain exactly ${draftSections.length} items — same count as the draft below.`,
    '⛔ You MUST preserve the EXACT order of sections as listed below.',
    '⛔ You MUST NOT merge two or more draft sections into one output section.',
    '⛔ You MUST NOT split one draft section into multiple output sections.',
    '⛔ You MUST carry forward the `sectionKey` of each draft section into your output.',
    ...(sourceBackedSections.length > 0
      ? [
          `⛔ The following ${sourceBackedSections.length} section(s) are SOURCE-BACKED (detected from WordPress blocks) and MUST appear in your output with the exact same \`type\`:`,
          ...sourceBackedSections.map(
            (s) =>
              `   - sectionKey="${s.sectionKey ?? s.type}" type="${s.type}" — DO NOT drop, rename, or merge this section`,
          ),
        ]
      : []),
    '',
    '### What you MAY do:',
    'You MAY fill in missing content fields (headings, image srcs, cta text, colors) from the template source and site context.',
    'You MAY improve presentation fields (background, textAlign, padding) based on WordPress styling.',
    '',
    ...(hasInteractive
      ? [
          '### Interactive block types — TYPE IS LOCKED',
          'Some draft sections are interactive Spectra/UAGB plugin blocks. You MUST output the exact same `type` value:',
          '- `type: "slider"` → populate `slides[]` with heading, description, optional cta from source.',
          '- `type: "tabs"` → populate `tabs[]` with label and content from source.',
          '- `type: "modal"` → populate triggerText, heading, description, optional cta from source.',
          '- `type: "accordion"` → preserve accordion structure from source.',
          '',
        ]
      : []),
    '### Draft sections (your output must mirror this structure exactly):',
    '```json',
    JSON.stringify(draftSections, null, 2),
    '```',
  ];
  return lines.join('\n');
}

function buildPaletteHint(tokens?: ThemeTokens): string {
  if (!tokens?.defaults) return '';

  const d = tokens.defaults;
  const lines: string[] = [
    '## Theme palette hints (use for the palette field)',
  ];
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
  lines.push(
    `Menus: ${content.menus.map((m) => `${m.name} (slug: ${m.slug})`).join(', ') || '(none)'}`,
  );
  lines.push(`Posts in DB: ${content.posts.length}`);
  lines.push(`Pages in DB: ${content.pages.length}`);
  return lines.join('\n');
}

function buildContractHint(input: {
  componentName: string;
  componentType?: 'page' | 'partial';
  route?: string | null;
  isDetail?: boolean;
  dataNeeds?: DataNeed[];
}): string {
  const lines = ['## Approved component contract'];
  lines.push(`Component: ${input.componentName}`);
  lines.push(`Type: ${input.componentType ?? 'unspecified'}`);
  lines.push(`Route: ${input.route ?? 'null'}`);
  lines.push(`Detail route: ${input.isDetail ? 'yes' : 'no'}`);
  lines.push(
    `Allowed dataNeeds: ${input.dataNeeds?.join(', ') || '(none declared)'}`,
  );
  if (input.componentType === 'page') {
    lines.push(
      'Hard rule: do not plan navbar/footer shared chrome inside this page.',
    );
    lines.push(
      'Hard rule: any sidebar on this page must be content-only, never menu/site info chrome.',
    );
  }
  return lines.join('\n');
}

function buildAuxiliaryGuardHint(
  sourceBackedAuxiliaryLabels?: string[],
): string {
  const lines = ['## Auxiliary section guard'];
  lines.push(
    `Invalid invented auxiliary headings by default: ${formatInventedAuxiliarySectionLabels()}.`,
  );
  if (sourceBackedAuxiliaryLabels?.length) {
    lines.push(
      `These exact auxiliary labels are allowed because the scoped source already contains them: ${sourceBackedAuxiliaryLabels
        .map((label) => `\`${label}\``)
        .join(', ')}.`,
    );
  } else {
    lines.push(
      'No source-backed auxiliary labels were detected in the scoped source. Treat the banned labels above as invalid for this component.',
    );
  }
  lines.push(
    'If a sparse page ends with a generic utility/footer/sidebar-style section using one of those labels, omit that section entirely.',
  );
  return lines.join('\n');
}

function buildPatternSuggestionsHint(repoManifest?: RepoThemeManifest): string {
  const patterns = repoManifest?.structureHints.patternMeta;
  if (!patterns || patterns.length === 0) return '';

  const lines = [
    '## Available theme patterns',
    'These patterns are declared by the theme. When the template source references one of these slugs via wp:pattern, use it to inform your section type choice instead of inventing a new section.',
  ];
  for (const p of patterns.slice(0, 15)) {
    const cats = p.categories.length > 0 ? ` [${p.categories.join(', ')}]` : '';
    lines.push(`- ${p.slug}: "${p.title}"${cats}`);
  }
  if (patterns.length > 15) {
    lines.push(`- ... and ${patterns.length - 15} more`);
  }
  return lines.join('\n');
}

export function extractStaticImageSources(templateSource: string): string[] {
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

function buildImageSourcesHint(templateSource: string): string {
  const sources = extractStaticImageSources(templateSource);
  if (sources.length === 0) {
    return '## Static image sources in template\n- None. Do NOT invent images or avatars.';
  }

  return [
    '## Static image sources in template',
    ...sources.slice(0, 20).map((src) => `- ${src}`),
    sources.length > 20 ? `- ... and ${sources.length - 20} more` : '',
    'Use only these exact sources for static images/avatars.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Validation constants ───────────────────────────────────────────────────

const VALID_SECTION_TYPES = new Set<string>([
  'navbar',
  'hero',
  'cover',
  'post-list',
  'card-grid',
  'media-text',
  'testimonial',
  'newsletter',
  'footer',
  'post-content',
  'page-content',
  'comments',
  'search',
  'breadcrumb',
  'sidebar',
  'tabs',
  'slider',
  'modal',
]);

const VALID_DATA_NEEDS = new Set<string>([
  'siteInfo',
  'posts',
  'pages',
  'menus',
  'postDetail',
  'pageDetail',
  'comments',
]);

export interface VisualPlanContract {
  componentType?: 'page' | 'partial';
  route?: string | null;
  isDetail?: boolean;
  dataNeeds?: DataNeed[];
  stripLayoutChrome?: boolean;
  sourceBackedAuxiliaryLabels?: string[];
}

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
  for (const key of [
    'background',
    'surface',
    'text',
    'textMuted',
    'accent',
    'accentText',
  ]) {
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
 *  - Missing required string content (e.g. imageSrc) → null
 *  - Missing/wrong scalar config → auto-repair with sensible defaults
 *  - Missing array fields that are mapped over → auto-repair with empty array
 */
function validateSectionDetailed(
  raw: any,
  options?: { allowedImageSrcs?: string[] },
): {
  section: SectionPlan | null;
  reason?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return { section: null, reason: 'section is not an object' };
  }
  const type = raw.type as string;
  if (!VALID_SECTION_TYPES.has(type)) {
    return {
      section: null,
      reason: `unsupported section type "${String(type)}"`,
    };
  }

  // Auto-repair double braces {{var}} -> {var} across all string fields to prevent JSX errors
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'string') {
      raw[key] = raw[key].replace(/\{\{([^}]+)\}\}/g, '{$1}');
    }
  }
  if (typeof raw.paddingStyle !== 'string') delete raw.paddingStyle;
  if (typeof raw.marginStyle !== 'string') delete raw.marginStyle;
  if (typeof raw.gapStyle !== 'string') delete raw.gapStyle;
  if (!['left', 'center', 'right'].includes(raw.textAlign)) {
    delete raw.textAlign;
  }
  if (typeof raw.contentWidth === 'string' && raw.contentWidth.trim()) {
    raw.contentWidth = normalizeCssLengthString(raw.contentWidth.trim());
  } else {
    delete raw.contentWidth;
  }
  const sourceLayout = sanitizeSourceLayout(raw.sourceLayout);
  if (sourceLayout) raw.sourceLayout = sourceLayout;
  else delete raw.sourceLayout;
  if (Array.isArray(raw.customClassNames)) {
    raw.customClassNames = [
      ...new Set(
        raw.customClassNames
          .filter(
            (value: unknown): value is string => typeof value === 'string',
          )
          .map((value: string) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (raw.customClassNames.length === 0) delete raw.customClassNames;
  } else {
    delete raw.customClassNames;
  }
  for (const key of ['headingStyle', 'subheadingStyle', 'bodyStyle'] as const) {
    const value = sanitizeTypographyStyle(raw[key]);
    if (value) raw[key] = value;
    else delete raw[key];
  }
  if (Array.isArray(raw.columnWidths)) {
    raw.columnWidths = raw.columnWidths.filter(
      (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );
    raw.columnWidths = raw.columnWidths.map((value: string) =>
      normalizeCssLengthString(value),
    );
    if (raw.columnWidths.length === 0) delete raw.columnWidths;
  } else {
    delete raw.columnWidths;
  }

  // eslint-disable-next-line default-case
  switch (type) {
    case 'navbar':
      if (typeof raw.menuSlug !== 'string' || !raw.menuSlug)
        raw.menuSlug = 'primary';
      if (typeof raw.sticky !== 'boolean') raw.sticky = false;
      break;

    case 'hero':
      if (!['centered', 'left', 'split'].includes(raw.layout))
        raw.layout = 'centered';
      if (typeof raw.heading !== 'string') raw.heading = '';
      if (
        raw.image &&
        !isAllowedStaticImage(raw.image.src, options?.allowedImageSrcs)
      ) {
        delete raw.image;
      }
      break;

    case 'cover':
      if (
        typeof raw.imageSrc !== 'string' ||
        !raw.imageSrc ||
        !isAllowedStaticImage(raw.imageSrc, options?.allowedImageSrcs)
      ) {
        return { section: null, reason: 'cover.imageSrc is required' };
      }
      if (typeof raw.dimRatio !== 'number') raw.dimRatio = 50;
      if (typeof raw.minHeight !== 'string') raw.minHeight = '400px';
      else raw.minHeight = normalizeCssLengthString(raw.minHeight);
      if (!['center', 'left', 'right'].includes(raw.contentAlign))
        raw.contentAlign = 'center';
      break;

    case 'post-list':
      if (!['list', 'grid-2', 'grid-3'].includes(raw.layout))
        raw.layout = 'grid-3';
      for (const f of [
        'showDate',
        'showAuthor',
        'showCategory',
        'showExcerpt',
        'showFeaturedImage',
      ]) {
        if (typeof raw[f] !== 'boolean') raw[f] = true;
      }
      break;

    case 'card-grid':
      if (!Array.isArray(raw.cards) || raw.cards.length === 0) {
        return {
          section: null,
          reason: 'card-grid.cards must be a non-empty array',
        };
      }
      if (![2, 3, 4].includes(raw.columns)) raw.columns = 3;
      // Ensure each card has heading + body strings
      raw.cards = (raw.cards as any[]).filter(
        (c) => c && typeof c.heading === 'string' && typeof c.body === 'string',
      );
      if (raw.cards.length === 0) {
        return {
          section: null,
          reason: 'card-grid.cards has no valid {heading, body} items',
        };
      }
      break;

    case 'media-text':
      if (
        typeof raw.imageSrc !== 'string' ||
        !raw.imageSrc ||
        !isAllowedStaticImage(raw.imageSrc, options?.allowedImageSrcs)
      ) {
        return { section: null, reason: 'media-text.imageSrc is required' };
      }
      if (typeof raw.imageAlt !== 'string') raw.imageAlt = '';
      if (!['left', 'right'].includes(raw.imagePosition))
        raw.imagePosition = 'left';
      break;

    case 'testimonial':
      if (typeof raw.quote !== 'string' || !raw.quote.trim()) {
        return { section: null, reason: 'testimonial.quote is required' };
      }
      if (typeof raw.authorName !== 'string') raw.authorName = '';
      if (!isAllowedStaticImage(raw.authorAvatar, options?.allowedImageSrcs)) {
        delete raw.authorAvatar;
      }
      break;

    case 'newsletter':
      if (typeof raw.heading !== 'string')
        raw.heading = 'Subscribe to our newsletter';
      if (typeof raw.buttonText !== 'string') raw.buttonText = 'Subscribe';
      if (!['centered', 'card'].includes(raw.layout)) raw.layout = 'centered';
      break;

    case 'footer':
      if (!Array.isArray(raw.menuColumns)) raw.menuColumns = [];
      break;

    case 'post-content':
      if (typeof raw.showTitle !== 'boolean') raw.showTitle = true;
      // migrate legacy showMeta → individual flags
      if ('showMeta' in raw) {
        const meta = raw.showMeta as boolean;
        raw.showAuthor = raw.showAuthor ?? meta;
        raw.showDate = raw.showDate ?? meta;
        raw.showCategories = raw.showCategories ?? meta;
        delete raw.showMeta;
      }
      if (typeof raw.showAuthor !== 'boolean') raw.showAuthor = true;
      if (typeof raw.showDate !== 'boolean') raw.showDate = true;
      if (typeof raw.showCategories !== 'boolean') raw.showCategories = true;
      break;

    case 'page-content':
      if (typeof raw.showTitle !== 'boolean') raw.showTitle = true;
      break;

    case 'comments':
      if (typeof raw.showForm !== 'boolean') raw.showForm = true;
      if (typeof raw.requireName !== 'boolean') raw.requireName = true;
      if (typeof raw.requireEmail !== 'boolean') raw.requireEmail = false;
      break;

    case 'sidebar':
      if (typeof raw.title !== 'string') delete raw.title;
      if (typeof raw.menuSlug !== 'string' || !raw.menuSlug.trim()) {
        delete raw.menuSlug;
      }
      if (typeof raw.showSiteInfo !== 'boolean') raw.showSiteInfo = false;
      if (typeof raw.showPages !== 'boolean') raw.showPages = true;
      if (typeof raw.showPosts !== 'boolean') raw.showPosts = false;
      if (typeof raw.maxItems !== 'number' || raw.maxItems <= 0)
        raw.maxItems = 6;
      break;

    case 'tabs':
      if (!Array.isArray(raw.tabs)) raw.tabs = [];
      raw.tabs = raw.tabs
        .filter((tab: unknown) => tab && typeof tab === 'object')
        .map((tab: any) => ({
          label: typeof tab.label === 'string' ? tab.label : '',
          content: typeof tab.content === 'string' ? tab.content : '',
        }))
        .filter(
          (tab: { label: string; content: string }) =>
            tab.label.trim() || tab.content.trim(),
        );
      break;

    case 'slider':
      if (!Array.isArray(raw.slides)) raw.slides = [];
      raw.slides = raw.slides
        .filter((slide: unknown) => slide && typeof slide === 'object')
        .map((slide: any) => {
          const next: {
            heading?: string;
            description?: string;
            cta?: { text: string; link: string };
          } = {};
          if (typeof slide.heading === 'string') next.heading = slide.heading;
          if (typeof slide.description === 'string')
            next.description = slide.description;
          if (
            slide.cta &&
            typeof slide.cta === 'object' &&
            typeof slide.cta.text === 'string' &&
            typeof slide.cta.link === 'string'
          ) {
            next.cta = { text: slide.cta.text, link: slide.cta.link };
          }
          return next;
        })
        .filter(
          (slide: {
            heading?: string;
            description?: string;
            cta?: { text: string; link: string };
          }) =>
            !!(slide.heading?.trim() || slide.description?.trim() || slide.cta),
        );
      if (typeof raw.autoplay !== 'boolean') delete raw.autoplay;
      break;

    case 'modal':
      if (typeof raw.triggerText !== 'string' || !raw.triggerText.trim()) {
        raw.triggerText = 'Open Modal';
      }
      if (typeof raw.heading !== 'string') delete raw.heading;
      if (typeof raw.description !== 'string') delete raw.description;
      if (
        !raw.cta ||
        typeof raw.cta !== 'object' ||
        typeof raw.cta.text !== 'string' ||
        typeof raw.cta.link !== 'string'
      ) {
        delete raw.cta;
      }
      break;

    case 'accordion':
      if (!Array.isArray(raw.items)) raw.items = [];
      raw.items = raw.items
        .filter((item: unknown) => item && typeof item === 'object')
        .map((item: any) => ({
          title: typeof item.title === 'string' ? item.title : '',
          ...(typeof item.content === 'string'
            ? { content: item.content }
            : {}),
        }))
        .filter(
          (item: { title: string; content?: string }) =>
            item.title.trim() || item.content?.trim(),
        );
      break;

    case 'button-group':
      if (!['left', 'center', 'right'].includes(raw.align)) raw.align = 'left';
      if (!Array.isArray(raw.buttons)) raw.buttons = [];
      raw.buttons = raw.buttons
        .filter((button: unknown) => button && typeof button === 'object')
        .map((button: any) => ({
          text: typeof button.text === 'string' ? button.text : '',
          link: typeof button.link === 'string' ? button.link : '#',
        }))
        .filter((button: { text: string; link: string }) => button.text.trim());
      if (raw.buttons.length === 0) {
        return { section: null, reason: 'button-group.buttons is required' };
      }
      break;

    // search, breadcrumb — no required fields
  }

  return { section: raw as SectionPlan };
}

function isAllowedStaticImage(
  src: unknown,
  allowedImageSrcs?: string[],
): src is string {
  if (typeof src !== 'string' || !src.trim()) return false;
  if (!allowedImageSrcs || allowedImageSrcs.length === 0) return false;
  return allowedImageSrcs.includes(src.trim());
}

function validateSection(raw: any): SectionPlan | null {
  return validateSectionDetailed(raw).section;
}

export interface VisualPlanParseDiagnostic {
  reason: string;
  rawOutput: string;
  cleanedOutput: string;
  droppedSections?: string[];
}

export interface VisualPlanParseResult {
  plan: ComponentVisualPlan | null;
  diagnostic?: VisualPlanParseDiagnostic;
}

export function sanitizeSectionsForContract(
  sections: SectionPlan[],
  contract?: VisualPlanContract,
): { sections: SectionPlan[]; adjustments: string[] } {
  if (!contract) return { sections, adjustments: [] };

  const adjustments: string[] = [];
  const allowedNeeds = new Set(contract.dataNeeds ?? []);
  const allowPostDetail = allowedNeeds.has('postDetail');
  const allowPageDetail = allowedNeeds.has('pageDetail');
  const allowComments = allowPostDetail || allowedNeeds.has('comments');
  const stripLayoutChrome =
    contract.stripLayoutChrome ?? contract.componentType === 'page';

  const sanitized = sections
    .map((section) => {
      if (
        stripLayoutChrome &&
        (section.type === 'navbar' || section.type === 'footer')
      ) {
        adjustments.push(`removed ${section.type} section from page contract`);
        return null;
      }

      if (section.type === 'post-content' && !allowPostDetail) {
        adjustments.push(
          'removed post-content section because contract does not allow postDetail',
        );
        return null;
      }

      if (section.type === 'page-content' && !allowPageDetail) {
        adjustments.push(
          'removed page-content section because contract does not allow pageDetail',
        );
        return null;
      }

      if (section.type === 'comments' && !allowComments) {
        adjustments.push(
          'removed comments section because contract does not allow comments',
        );
        return null;
      }

      if (section.type === 'sidebar' && contract.componentType === 'page') {
        const next = { ...section };
        let changed = false;
        if (next.menuSlug) {
          delete next.menuSlug;
          changed = true;
        }
        if (next.showSiteInfo) {
          next.showSiteInfo = false;
          changed = true;
        }
        if (!next.showPages && !next.showPosts) {
          next.showPages = true;
          changed = true;
        }
        if (changed) {
          adjustments.push(
            'sanitized sidebar to remove shared chrome and keep only content widgets',
          );
        }
        return next;
      }

      return section;
    })
    .filter((section): section is SectionPlan => !!section);

  const prunedAuxiliarySections = pruneTrailingInventedAuxiliarySections(
    sanitized,
    {
      componentType: contract.componentType,
      allowedAuxiliaryLabels: contract.sourceBackedAuxiliaryLabels,
    },
  );
  if (prunedAuxiliarySections.droppedLabels.length > 0) {
    adjustments.push(
      `removed invented trailing auxiliary section(s): ${prunedAuxiliarySections.droppedLabels.join(', ')}`,
    );
  }

  return { sections: prunedAuxiliarySections.sections, adjustments };
}

/**
 * Parse and validate the AI response into a ComponentVisualPlan.
 *
 * - Palette: sanitized (bad hex → defaults), never rejects plan
 * - Sections: each validated individually; invalid sections are dropped
 * - Returns null only when JSON is unparseable or all sections are invalid
 */
export function parseVisualPlanDetailed(
  raw: string,
  componentName: string,
  options?: { allowedImageSrcs?: string[]; contract?: VisualPlanContract },
): VisualPlanParseResult {
  const cleaned = raw
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '')
    .trim();

  let parsed: any;
  let parseError: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: any) {
    parseError = err;
  }

  if (!parsed) {
    for (const candidate of buildJsonRepairCandidates(cleaned)) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        // try next repair candidate
      }
    }
  }

  if (!parsed) {
    return {
      plan: null,
      diagnostic: {
        reason: `invalid JSON: ${parseError?.message ?? 'unknown parse error'}`,
        rawOutput: raw,
        cleanedOutput: cleaned,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      plan: null,
      diagnostic: {
        reason: 'parsed output is not an object',
        rawOutput: raw,
        cleanedOutput: cleaned,
      },
    };
  }
  if (!Array.isArray(parsed.sections)) {
    return {
      plan: null,
      diagnostic: {
        reason: 'missing sections array',
        rawOutput: raw,
        cleanedOutput: cleaned,
      },
    };
  }

  const palette = sanitizePalette(parsed.palette);

  const sections: SectionPlan[] = [];
  const droppedSections: string[] = [];
  for (const rawSection of parsed.sections) {
    const { section, reason } = validateSectionDetailed(rawSection, options);
    if (section) {
      sections.push(section);
    } else {
      droppedSections.push(
        `type=${typeof rawSection?.type === 'string' ? rawSection.type : 'unknown'}: ${reason ?? 'invalid section'}`,
      );
    }
  }

  const sanitizedSections = sanitizeSectionsForContract(
    sections,
    options?.contract,
  );
  droppedSections.push(...sanitizedSections.adjustments);

  if (sanitizedSections.sections.length === 0) {
    return {
      plan: null,
      diagnostic: {
        reason: 'all sections were rejected by validator or contract sanitizer',
        rawOutput: raw,
        cleanedOutput: cleaned,
        droppedSections,
      },
    };
  }

  const parsedDataNeeds: DataNeed[] = Array.isArray(parsed.dataNeeds)
    ? (parsed.dataNeeds as any[]).filter((d): d is DataNeed =>
        VALID_DATA_NEEDS.has(d),
      )
    : [];
  const dataNeeds = options?.contract?.dataNeeds?.length
    ? parsedDataNeeds.filter((need) =>
        options.contract!.dataNeeds!.includes(need),
      )
    : parsedDataNeeds;

  // Planner always overrides typography + layout after calling parseVisualPlan.
  // When called directly from CodeReviewerService (fallback path), we inject
  // sensible defaults so CodeGeneratorService always receives a complete plan.
  const typography = {
    headingFamily: 'inherit',
    bodyFamily: 'inherit',
    h1: 'text-[2rem] leading-[1.15]',
    h2: 'text-[1.5rem] leading-[1.2]',
    h3: 'text-[1.25rem] leading-[1.3]',
    body: 'text-[0.95rem]',
    small: 'text-sm',
    buttonRadius: 'rounded',
  };

  const layout = {
    containerClass: 'max-w-[1280px] mx-auto w-full',
    contentContainerClass: 'max-w-[800px] mx-auto w-full',
    blockGap: 'gap-16',
    includes: [] as string[],
  };

  return {
    plan: {
      componentName,
      dataNeeds,
      palette,
      sections: sanitizedSections.sections,
      typography,
      layout,
      blockStyles: {},
    },
  };
}

export function parseVisualPlan(
  raw: string,
  componentName: string,
): ComponentVisualPlan | null {
  return parseVisualPlanDetailed(raw, componentName).plan;
}

function buildJsonRepairCandidates(input: string): string[] {
  const candidates: string[] = [];
  const pushCandidate = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed === input.trim() || candidates.includes(trimmed)) {
      return;
    }
    candidates.push(trimmed);
  };

  const escapedControls = escapeControlCharsInJsonStrings(input);
  pushCandidate(escapedControls);

  const withoutTrailingCommas = removeTrailingCommas(escapedControls);
  pushCandidate(withoutTrailingCommas);

  const jsObjectLiteral = convertJsObjectLiteralToJson(withoutTrailingCommas);
  pushCandidate(jsObjectLiteral);

  return candidates;
}

function removeTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

function convertJsObjectLiteralToJson(input: string): string {
  let out = input.trim();
  out = stripJavaScriptComments(out);
  out = quoteUnquotedObjectKeys(out);
  out = convertSingleQuotedStrings(out);
  out = removeTrailingCommas(out);
  return out;
}

function stripJavaScriptComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function quoteUnquotedObjectKeys(input: string): string {
  return input.replace(
    /([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g,
    '$1"$2"$3',
  );
}

function convertSingleQuotedStrings(input: string): string {
  return input.replace(
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    (_match, content: string) => {
      const normalized = content
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      return JSON.stringify(normalized);
    },
  );
}

function escapeControlCharsInJsonStrings(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }

    if (char === '\n') {
      out += '\\n';
      continue;
    }
    if (char === '\r') {
      out += '\\r';
      continue;
    }
    if (char === '\t') {
      out += '\\t';
      continue;
    }

    out += char;
  }

  return out;
}

function sanitizeTypographyStyle(value: unknown):
  | {
      fontSize?: string;
      fontFamily?: string;
      fontWeight?: string;
      letterSpacing?: string;
      lineHeight?: string;
      textTransform?: string;
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const next = {
    ...(typeof raw.fontSize === 'string' && raw.fontSize.trim()
      ? { fontSize: raw.fontSize }
      : {}),
    ...(typeof raw.fontFamily === 'string' && raw.fontFamily.trim()
      ? { fontFamily: raw.fontFamily }
      : {}),
    ...(typeof raw.fontWeight === 'string' && raw.fontWeight.trim()
      ? { fontWeight: raw.fontWeight }
      : {}),
    ...(typeof raw.letterSpacing === 'string' && raw.letterSpacing.trim()
      ? { letterSpacing: raw.letterSpacing }
      : {}),
    ...(typeof raw.lineHeight === 'string' && raw.lineHeight.trim()
      ? { lineHeight: raw.lineHeight }
      : {}),
    ...(typeof raw.textTransform === 'string' && raw.textTransform.trim()
      ? { textTransform: raw.textTransform }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeSourceLayout(value: unknown):
  | {
      type?: string;
      orientation?: string;
      justifyContent?: string;
      flexWrap?: string;
      verticalAlignment?: string;
      columnCount?: number;
      minimumColumnWidth?: string;
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const next = {
    ...(typeof raw.type === 'string' && raw.type.trim()
      ? { type: raw.type.trim() }
      : {}),
    ...(typeof raw.orientation === 'string' && raw.orientation.trim()
      ? { orientation: raw.orientation.trim() }
      : {}),
    ...(typeof raw.justifyContent === 'string' && raw.justifyContent.trim()
      ? { justifyContent: raw.justifyContent.trim() }
      : {}),
    ...(typeof raw.flexWrap === 'string' && raw.flexWrap.trim()
      ? { flexWrap: raw.flexWrap.trim() }
      : {}),
    ...(typeof raw.verticalAlignment === 'string' &&
    raw.verticalAlignment.trim()
      ? { verticalAlignment: raw.verticalAlignment.trim() }
      : {}),
    ...(typeof raw.columnCount === 'number' &&
    Number.isFinite(raw.columnCount) &&
    raw.columnCount > 0
      ? { columnCount: raw.columnCount }
      : {}),
    ...(typeof raw.minimumColumnWidth === 'string' &&
    raw.minimumColumnWidth.trim()
      ? {
          minimumColumnWidth: normalizeCssLengthString(
            raw.minimumColumnWidth.trim(),
          ),
        }
      : {}),
    ...(typeof raw.contentSize === 'string' && raw.contentSize.trim()
      ? {
          contentSize: normalizeCssLengthString(raw.contentSize.trim()),
        }
      : {}),
    ...(typeof raw.wideSize === 'string' && raw.wideSize.trim()
      ? {
          wideSize: normalizeCssLengthString(raw.wideSize.trim()),
        }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeCssLengthString(value: string): string {
  const normalized = value.trim();
  if (!normalized) return value;
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
}

// ── Presentation-patch mode ────────────────────────────────────────────────
//
// Used when a deterministic draft exists (FSE/block theme).
// AI only fills presentation/content fields per sectionKey — it does NOT
// decide structure, type, order, or count. Draft is immutable source of truth.

/**
 * Build a prompt that asks AI to output a ComponentPresentationPlan (patches only).
 * Used instead of buildVisualPlanPrompt when draftSections are available.
 */
export function buildPresentationPatchPrompt(input: {
  componentName: string;
  templateSource: string;
  content: DbContentResult;
  tokens?: ThemeTokens;
  draftSections: SectionPlan[];
  editRequestContextNote?: string;
}): { systemPrompt: string; userPrompt: string } {
  const {
    componentName,
    templateSource,
    content,
    tokens,
    draftSections,
    editRequestContextNote,
  } = input;

  const palette = buildPaletteHint(tokens);
  const siteCtx = buildSiteContext(content);
  const imageHints = buildImageSourcesHint(templateSource);

  const draftJson = JSON.stringify(
    draftSections.map((s) => ({
      sectionKey: s.sectionKey ?? s.type,
      type: s.type,
    })),
    null,
    2,
  );

  const systemPrompt = `You are a WordPress-to-React presentation analyst.
You are given a FIXED list of sections (the structural source of truth) extracted deterministically from a WordPress block template.
Your job is to fill in ONLY presentation and content fields for each section — you do NOT decide the section structure, type, or order.

## Your output format: ComponentPresentationPlan

\`\`\`typescript
interface ComponentPresentationPlan {
  componentName: string;
  palette: {
    background: string; surface: string; text: string; textMuted: string;
    accent: string; accentText: string; dark?: string; darkText?: string;
  };
  patches: SectionPresentationPatch[];
}

interface SectionPresentationPatch {
  sectionKey: string;  // MUST match a key from the fixed section list

  // Presentation fields (all optional — only set what you can identify from source):
  background?: string;       // hex color for this section's background
  textColor?: string;        // hex
  textAlign?: "left"|"center"|"right";
  paddingStyle?: string;     // exact CSS e.g. "4rem 1.5rem"
  marginStyle?: string;
  gapStyle?: string;
  contentWidth?: string;     // e.g. "620px"

  // Content fills (only from template source — do NOT invent):
  heading?: string;
  subheading?: string;
  body?: string;             // may contain inline HTML (<strong>, <em>, links)
  cta?: { text: string; link: string };
  imageSrc?: string;         // exact src from source only
  imageAlt?: string;
  layout?: "centered"|"left"|"split";   // hero sections only
  contentAlign?: "center"|"left"|"right"; // cover sections only
  imagePosition?: "left"|"right";       // media-text only
  listItems?: string[];
  title?: string;            // section heading for post-list / card-grid
  autoplay?: boolean;        // slider
  triggerText?: string;      // modal trigger button text
  menuSlug?: string;         // navbar: slug of the menu to display
  menuColumns?: { title: string; menuSlug: string }[];  // footer
  copyright?: string;        // footer
  quote?: string;            // testimonial
  authorName?: string;       // testimonial
  authorTitle?: string;      // testimonial
  showDate?: boolean; showAuthor?: boolean; showCategory?: boolean;
  showExcerpt?: boolean; showFeaturedImage?: boolean;  // post-list
}
\`\`\`

## Hard rules
- Output exactly ONE patch per section in the fixed list (same count, same order, matching sectionKeys).
- NEVER add extra patches or omit a patch for a section in the fixed list.
- NEVER change a section's type — type is fixed by the structure.
- NEVER invent image URLs, avatar URLs, or placeholder media. If source has no image for a section, omit imageSrc.
- Text content must come EXACTLY from the template source — no invented headings or body text.
- Use ONLY hex colors derived from theme tokens or explicit template colors.
- Output ONLY valid JSON — no markdown fences, no explanation.`;

  const userPrompt = `## Component: ${componentName}

## Fixed section structure (immutable — do NOT change type, order, or count):
\`\`\`json
${draftJson}
\`\`\`

${palette}

${siteCtx}

${imageHints}

${editRequestContextNote ? `${editRequestContextNote}\n\n` : ''}## Template source (read for content and presentation details only):

${templateSource}

## Output
Return a single valid JSON object matching ComponentPresentationPlan.
Patches array must have exactly ${draftSections.length} items, in the same order as the fixed section list above.
No markdown, no explanation.`;

  return { systemPrompt, userPrompt };
}

export interface PresentationPlanParseResult {
  plan: ComponentPresentationPlan | null;
  diagnostic?: { reason: string; rawOutput: string };
}

export interface PresentationPlanParseOptions {
  expectedSectionKeys?: string[];
  allowedImageSrcs?: string[];
}

/**
 * Parse AI response in patch mode.
 * Returns null when JSON is invalid, patches are malformed, sectionKey order
 * diverges from the deterministic draft, or AI references images outside the
 * template source allowlist.
 */
export function parsePresentationPlan(
  raw: string,
  componentName: string,
  options?: PresentationPlanParseOptions,
): PresentationPlanParseResult {
  const cleaned = raw
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '')
    .trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // try repair
    for (const candidate of [
      cleaned.replace(/,\s*([}\]])/g, '$1'), // trailing commas
      cleaned.replace(/([{,]\s*)(\w+):/g, '$1"$2":'), // unquoted keys
    ]) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        // continue
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      plan: null,
      diagnostic: { reason: 'invalid JSON or not an object', rawOutput: raw },
    };
  }

  if (!Array.isArray(parsed.patches)) {
    return {
      plan: null,
      diagnostic: { reason: 'missing patches array', rawOutput: raw },
    };
  }

  const palette = sanitizePalette(parsed.palette);
  const expectedSectionKeys = options?.expectedSectionKeys ?? [];
  if (
    expectedSectionKeys.length > 0 &&
    parsed.patches.length !== expectedSectionKeys.length
  ) {
    return {
      plan: null,
      diagnostic: {
        reason: `patch count mismatch: expected ${expectedSectionKeys.length}, got ${parsed.patches.length}`,
        rawOutput: raw,
      },
    };
  }

  const seenKeys = new Set<string>();
  const patches: SectionPresentationPatch[] = [];
  for (let index = 0; index < parsed.patches.length; index++) {
    const current = parsed.patches[index];
    if (!current || typeof current !== 'object') {
      return {
        plan: null,
        diagnostic: {
          reason: `patch at index ${index} is not an object`,
          rawOutput: raw,
        },
      };
    }
    if (typeof current.sectionKey !== 'string' || !current.sectionKey.trim()) {
      return {
        plan: null,
        diagnostic: {
          reason: `patch at index ${index} is missing sectionKey`,
          rawOutput: raw,
        },
      };
    }

    const sectionKey = current.sectionKey.trim();
    if (seenKeys.has(sectionKey)) {
      return {
        plan: null,
        diagnostic: {
          reason: `duplicate patch sectionKey "${sectionKey}"`,
          rawOutput: raw,
        },
      };
    }
    seenKeys.add(sectionKey);

    if (
      expectedSectionKeys.length > 0 &&
      sectionKey !== expectedSectionKeys[index]
    ) {
      return {
        plan: null,
        diagnostic: {
          reason: `patch order mismatch at index ${index}: expected "${expectedSectionKeys[index]}", got "${sectionKey}"`,
          rawOutput: raw,
        },
      };
    }

    const patch: SectionPresentationPatch = { sectionKey };
    if (typeof current.background === 'string')
      patch.background = current.background;
    if (typeof current.textColor === 'string')
      patch.textColor = current.textColor;
    if (['left', 'center', 'right'].includes(current.textAlign)) {
      patch.textAlign = current.textAlign;
    }
    if (typeof current.paddingStyle === 'string') {
      patch.paddingStyle = current.paddingStyle;
    }
    if (typeof current.marginStyle === 'string') {
      patch.marginStyle = current.marginStyle;
    }
    if (typeof current.gapStyle === 'string') patch.gapStyle = current.gapStyle;
    if (typeof current.contentWidth === 'string') {
      patch.contentWidth = current.contentWidth;
    }
    if (Array.isArray(current.customClassNames)) {
      patch.customClassNames = Array.from(
        new Set(
          current.customClassNames
            .filter(
              (value: unknown): value is string => typeof value === 'string',
            )
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );
    }
    if (typeof current.heading === 'string') patch.heading = current.heading;
    if (typeof current.subheading === 'string') {
      patch.subheading = current.subheading;
    }
    if (typeof current.body === 'string') patch.body = current.body;
    if (
      current.cta &&
      typeof current.cta === 'object' &&
      typeof current.cta.text === 'string' &&
      typeof current.cta.link === 'string'
    ) {
      patch.cta = current.cta;
    }
    if (typeof current.imageSrc === 'string') {
      if (!isAllowedStaticImage(current.imageSrc, options?.allowedImageSrcs)) {
        return {
          plan: null,
          diagnostic: {
            reason: `patch "${sectionKey}" has imageSrc outside allowed template sources`,
            rawOutput: raw,
          },
        };
      }
      patch.imageSrc = current.imageSrc.trim();
    }
    if (typeof current.imageAlt === 'string') patch.imageAlt = current.imageAlt;
    if (typeof current.title === 'string') patch.title = current.title;
    if (typeof current.subtitle === 'string') patch.subtitle = current.subtitle;
    if (typeof current.quote === 'string') patch.quote = current.quote;
    if (typeof current.authorName === 'string')
      patch.authorName = current.authorName;
    if (typeof current.authorTitle === 'string') {
      patch.authorTitle = current.authorTitle;
    }
    if (typeof current.authorAvatar === 'string') {
      if (
        !isAllowedStaticImage(current.authorAvatar, options?.allowedImageSrcs)
      ) {
        return {
          plan: null,
          diagnostic: {
            reason: `patch "${sectionKey}" has authorAvatar outside allowed template sources`,
            rawOutput: raw,
          },
        };
      }
      patch.authorAvatar = current.authorAvatar.trim();
    }
    if (typeof current.triggerText === 'string') {
      patch.triggerText = current.triggerText;
    }
    if (typeof current.description === 'string') {
      patch.description = current.description;
    }
    if (typeof current.menuSlug === 'string') patch.menuSlug = current.menuSlug;
    if (typeof current.copyright === 'string') {
      patch.copyright = current.copyright;
    }
    if (typeof current.brandDescription === 'string') {
      patch.brandDescription = current.brandDescription;
    }
    if (Array.isArray(current.menuColumns)) {
      patch.menuColumns = current.menuColumns
        .filter(
          (value: unknown): value is { title: string; menuSlug: string } =>
            !!value &&
            typeof value === 'object' &&
            typeof (value as any).title === 'string' &&
            typeof (value as any).menuSlug === 'string',
        )
        .map((value) => ({
          title: value.title.trim(),
          menuSlug: value.menuSlug.trim(),
        }))
        .filter((value) => value.title && value.menuSlug);
    }
    if (Array.isArray(current.listItems)) {
      patch.listItems = current.listItems
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (['centered', 'left', 'split'].includes(current.layout)) {
      patch.layout = current.layout;
    }
    if (['center', 'left', 'right'].includes(current.contentAlign)) {
      patch.contentAlign = current.contentAlign;
    }
    if (['left', 'right'].includes(current.imagePosition)) {
      patch.imagePosition = current.imagePosition;
    }
    if (typeof current.autoplay === 'boolean')
      patch.autoplay = current.autoplay;
    if (typeof current.sticky === 'boolean') patch.sticky = current.sticky;
    if (typeof current.showDate === 'boolean')
      patch.showDate = current.showDate;
    if (typeof current.showAuthor === 'boolean') {
      patch.showAuthor = current.showAuthor;
    }
    if (typeof current.showCategory === 'boolean') {
      patch.showCategory = current.showCategory;
    }
    if (typeof current.showExcerpt === 'boolean') {
      patch.showExcerpt = current.showExcerpt;
    }
    if (typeof current.showFeaturedImage === 'boolean') {
      patch.showFeaturedImage = current.showFeaturedImage;
    }
    if (current.headingStyle && typeof current.headingStyle === 'object') {
      patch.headingStyle = current.headingStyle;
    }
    if (
      current.subheadingStyle &&
      typeof current.subheadingStyle === 'object'
    ) {
      patch.subheadingStyle = current.subheadingStyle;
    }
    if (current.bodyStyle && typeof current.bodyStyle === 'object') {
      patch.bodyStyle = current.bodyStyle;
    }
    if (Array.isArray(current.columnWidths)) {
      patch.columnWidths = current.columnWidths
        .filter((value: unknown): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (current.image && typeof current.image.src === 'string') {
      if (!isAllowedStaticImage(current.image.src, options?.allowedImageSrcs)) {
        return {
          plan: null,
          diagnostic: {
            reason: `patch "${sectionKey}" has image.src outside allowed template sources`,
            rawOutput: raw,
          },
        };
      }
      patch.image = {
        src: current.image.src.trim(),
        alt: typeof current.image.alt === 'string' ? current.image.alt : '',
        position: current.image.position === 'right' ? 'right' : 'below',
      };
    }
    if (typeof current.dimRatio === 'number') patch.dimRatio = current.dimRatio;
    if (typeof current.minHeight === 'string')
      patch.minHeight = current.minHeight;
    patches.push(patch);
  }

  if (
    expectedSectionKeys.length > 0 &&
    patches.length !== expectedSectionKeys.length
  ) {
    return {
      plan: null,
      diagnostic: {
        reason: `sanitized patch count mismatch: expected ${expectedSectionKeys.length}, got ${patches.length}`,
        rawOutput: raw,
      },
    };
  }

  return {
    plan: {
      componentName: parsed.componentName ?? componentName,
      palette,
      patches,
    },
  };
}
