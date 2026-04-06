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
  componentType?: 'page' | 'partial';
  route?: string | null;
  isDetail?: boolean;
  dataNeeds?: DataNeed[];
  sourceAnalysis?: string;
}): { systemPrompt: string; userPrompt: string } {
  const {
    componentName,
    templateSource,
    content,
    tokens,
    componentType,
    route,
    isDetail,
    dataNeeds,
    sourceAnalysis,
  } = input;

  const palette = buildPaletteHint(tokens);
  const siteCtx = buildSiteContext(content);
  const imageHints = buildImageSourcesHint(templateSource);
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

Every section also supports optional exact spacing fields from the template:
\`\`\`
{ paddingStyle?: string, marginStyle?: string }
\`\`\`
Use them when the template source exposes real spacing values and you can preserve them exactly.

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
| \`comments\`     | WordPress comments list + leave a reply form |
| \`search\` | search input + results |
| \`breadcrumb\` | breadcrumb trail |
| \`sidebar\` | sidebar column for page/post layouts with menus, page links, or recent posts |

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
post-content: { showTitle, showAuthor, showDate, showCategories }
page-content: { showTitle }
comments:     { showForm, requireName, requireEmail }
search:       { title? }
breadcrumb:   {}
sidebar:      { title?, menuSlug?, showSiteInfo, showPages, showPosts, maxItems? }
\`\`\`

## Rules
- Preserve the original WordPress layout hierarchy and reading order as closely as possible.
- Keep the same major wrappers/regions from the template source. Do NOT upgrade a simple block into a dramatic hero, promo banner, testimonial strip, or newsletter section unless the template clearly contains that section already.
- Do NOT add decorative sections, marketing content, or stronger CTAs than the original template shows.
- Use ONLY hex colors. Derive them from theme tokens first, then from explicit template colors/classes if present. Do NOT invent a new palette direction.
- Text content in sections (headings, body text, card copy) must come EXACTLY from the template source — no invented text.
- If you need to output a dynamic variable (e.g. {item.title} or {post.title}), use EXACTLY ONE pair of curly braces. NEVER use double braces like {{item.title}} or {{post.title}}, as it breaks JSX syntax.
- If a section has a background image, use the exact \`src\` from the template.
- Never invent image URLs, avatars, featured artwork, or placeholder media. If the template source does not contain an image source for that section, omit the image/avatar field entirely.
- For testimonial sections specifically: only set \`authorAvatar\` when the template source contains a matching real image source. Otherwise omit \`authorAvatar\`.
- Preserve exact padding/margin from the template when visible by filling \`paddingStyle\` / \`marginStyle\` with concrete CSS shorthand values.
- Preserve the original alignment, column count, and section density when the template source makes them visible.
- NEVER output a \`custom\` / raw JSX section. If a template has a sidebar layout, use a \`sidebar\` section plus the normal \`page-content\` or \`post-content\` section.
- For sidebar page templates, place the \`sidebar\` section immediately after the main \`page-content\` or \`post-content\` section.
- When \`pageDetail\` is in dataNeeds: the WordPress page API only exposes \`id, title, content, slug\`. Do not plan UI that requires post-only fields (author, categories, date, excerpt, featured image) on **pages** — those apply to posts only.
- The approved component contract is authoritative. Do NOT invent sections or data access outside that contract.
- If the approved component type is \`page\`, NEVER emit \`navbar\` or \`footer\` sections. Shared site chrome belongs to dedicated layout partials, not pages.
- If the approved component type is \`page\` and you emit a \`sidebar\` section, that sidebar must be content-only: use \`showPages\` and/or \`showPosts\`, but NEVER set \`menuSlug\` or \`showSiteInfo\`.
- Emit \`post-content\` only when the approved dataNeeds include \`postDetail\`. Emit \`page-content\` only when the approved dataNeeds include \`pageDetail\`.
- Emit \`comments\` only when the approved dataNeeds include \`postDetail\` or \`comments\`.
- Output ONLY valid JSON — no markdown fences, no explanation.`;

  const userPrompt = `## Component to plan: ${componentName}

${contractHint}

${sourceAnalysis ? `${sourceAnalysis}\n\n` : ''}${siteCtx}

${palette}

${imageHints}

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

  return { sections: sanitized, adjustments };
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
    h1: 'text-[2.5rem] leading-tight',
    h2: 'text-[2rem] leading-snug',
    h3: 'text-[1.5rem] leading-snug',
    body: 'text-[1rem]',
    small: 'text-sm',
    buttonRadius: 'rounded',
  };

  const layout = {
    containerClass: 'max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8',
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
