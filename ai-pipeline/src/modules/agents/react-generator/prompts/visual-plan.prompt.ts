import type { DbContentResult } from '../../db-content/db-content.service.js';
import type { ThemeTokens } from '../../block-parser/block-parser.service.js';
import type { RepoThemeManifest } from '../../repo-analyzer/repo-analyzer.service.js';
import { buildRepoManifestContextNote } from '../../repo-analyzer/repo-manifest-context.js';
import type {
  ColorPalette,
  ComponentVisualPlan,
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
  sourceWidgetHints?: string[];
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
    sourceWidgetHints,
    draftSections,
    editRequestContextNote,
  } = input;

  const palette = buildPaletteHint(tokens);
  const siteCtx = buildSiteContext(content);
  const imageHints = buildImageSourcesHint(templateSource);
  const repoContext = buildRepoManifestContextNote(repoManifest, {
    mode: 'full',
    includeLayoutHints: true,
    includeStyleHints: true,
    includeStructureHints: true,
  });
  const patternHints = buildPatternSuggestionsHint(repoManifest);
  const spectraHints = buildSpectraPlanningHint(
    repoManifest,
    sourceWidgetHints,
  );
  const contractHint = buildContractHint({
    componentName,
    componentType,
    route,
    isDetail,
    dataNeeds,
    sourceWidgetHints,
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
  dataNeeds: Array<'siteInfo' | 'footerLinks' | 'posts' | 'pages' | 'menus' | 'postDetail' | 'pageDetail' | 'comments'>;
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

Every section also supports optional visual overrides, spacing fields, presentation/layout fields, and preserved custom class hooks from the template:
\`\`\`
{
  background?: string,   // exact hex — section-level background override, e.g. "#1a1a2e"
  textColor?: string,    // exact hex — section-level text color override, e.g. "#f9f9f9"
  paddingStyle?: string,
  marginStyle?: string,
  gapStyle?: string,
  shadow?: string,       // CSS box-shadow value
  border?: { radius?: string, color?: string, width?: string },
  presentation?: { container?: shell|content, contentAlign?: left|center|right, textAlign?: left|center|right, itemsAlign?: start|center|end|stretch, justify?: start|center|between|end, contentMaxWidth?: string },
  customClassNames?: string[]
}
\`\`\`
Use them when the template source exposes real values. For \`background\` and \`textColor\`: set them whenever a section wrapper has a distinct background or text color that differs from the page defaults — this is critical for dark sections, colored banners, and card surfaces.

For element-level source classes, preserve them on the closest matching blueprint field instead of collapsing everything onto the section wrapper:
- \`hero.image.customClassNames\`
- \`card-grid.cards[].customClassNames\`
- \`card-grid.cards[].imageCustomClassNames\`
- \`media-text.imageCustomClassNames\`
- \`testimonial.authorAvatarCustomClassNames\`
- \`modal.imageCustomClassNames\`
- \`tabs.tabs[].imageCustomClassNames\`
- \`carousel.slides[].imageCustomClassNames\`

Typography and exact column-ratio metadata may also appear when the template exposes them:
\`\`\`
{
  headingStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  subheadingStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  bodyStyle?: { fontSize?, fontFamily?, fontWeight?, letterSpacing?, lineHeight?, textTransform? },
  columnWidths?: string[]
}
\`\`\`

## Blueprint visual fields — fill from theme when present

Every section also accepts blueprint fields that make the plan a complete visual spec for code generation.
When the template source or theme tokens expose values for these fields, you MUST include them in the section JSON.

**Button / CTA style** — applies to any section with a CTA button:
\`\`\`
ctaStyle?: {
  variant?: "solid" | "outline" | "ghost" | "link",
  background?: string,   // exact hex from theme/template
  color?: string,        // exact hex
  hoverBackground?: string,
  hoverColor?: string,
  border?: string,       // e.g. "1px solid #d8613c"
  borderRadius?: string, // e.g. "8px" or "9999px"
  padding?: string       // e.g. "0.75rem 1.5rem"
}
secondaryCtaStyle?: { ... same shape ... }
\`\`\`
Fill ctaStyle from: button bg color in template attrs → palette.accent/palette.accentText → theme button tokens.
Fill borderRadius from: template button border-radius → layout.buttonRadius → theme button tokens.

**Card style** — for card-grid, testimonial:
\`\`\`
cardStyle?: {
  background?: string,
  padding?: string,
  borderRadius?: string,
  border?: string,
  shadow?: string,
  titleStyle?: TypographyStyle,
  bodyStyle?: TypographyStyle,
  imageRadius?: string,
  imageAspectRatio?: string
}
\`\`\`
Fill from: card wrapper background/padding/radius in template → layout.cardRadius/layout.cardPadding → palette.surface.

**Section-specific additions:**
- testimonial: also add quoteStyle (TypographyStyle), authorStyle (TypographyStyle), cardStyle
- carousel: also add slideHeight (e.g. "500px"), dotsColor, arrowColor, arrowBackground
- modal: also add triggerStyle (SectionButtonStyle), headingStyle, bodyStyle
- card-grid: also add titleStyle (TypographyStyle for the section-level h2)
- newsletter: also add headingStyle, inputStyle with background/borderRadius/border
- media-text: also add imageRadius, imageAspectRatio

**Rules for blueprint fields:**
- Fill these fields ONLY when you have a concrete value from the template source, theme tokens, or a plugin repo contract surfaced below. Do NOT invent values.
- When the template shows a button with a specific background color or border-radius, that value MUST appear in ctaStyle.
- When the template shows cards with a specific background, padding, or radius, those MUST appear in cardStyle.
- When typography on a specific element (quote font, card heading size) differs from the global body font, capture it in the matching Style field (quoteStyle, authorStyle, etc.).
- For Spectra/UAGB interactive widgets, if the plugin repo contract exposes concrete defaults such as modal width/height/overlay color or slider arrow background, you MAY and SHOULD use those values when the block markup does not override them.
- Omit a field entirely only when neither the template, nor the theme, nor the plugin repo contract provides a concrete value.

## Available section types

| type | use when |
|---|---|
| \`navbar\` | header/navigation bar |
| \`hero\` | large heading + optional CTA + optional image; \`centered\` / \`left\` heroes keep image BELOW text, only \`split\` may place image beside text |
| \`cta-strip\` | standalone button/CTA row without a hero heading |
| \`cover\` | full-width image with overlay text |
| \`post-list\` | list or grid of blog posts from API |
| \`card-grid\` | static grid of feature cards |
| \`media-text\` | image beside text content |
| \`testimonial\` | quote block with author |
| \`newsletter\` | email signup section |
| \`footer\` | page footer with nav columns |
| \`post-content\` | single post detail (uses :slug param) |
| \`post-meta\` | reusable byline/meta row for one current post item |
| \`page-content\` | single page detail (uses :slug param) |
| \`comments\`     | WordPress comments list + leave a reply form |
| \`search\` | search input + results |
| \`breadcrumb\` | breadcrumb trail |
| \`sidebar\` | sidebar column for page/post layouts with menus, page links, or recent posts |
| \`modal\` | source-backed modal/popup/dialog with trigger text and modal content |
| \`tabs\` | interactive tab set with source-backed labels and tab panels |
| \`accordion\` | FAQ/accordion/content-toggle with source-backed panel headings and bodies |
| \`carousel\` | slider/carousel with ordered slides from the source |

## Section schemas (key fields only)

\`\`\`
navbar:       { sticky, menuSlug, cta? }
hero:         { layout: centered|left|split, heading, subheading?, headingStyle?, subheadingStyle?, cta?, ctas?, image? } // centered|left => vertical stack (text first, image below)
cta-strip:    { align?: left|center|right, cta?, ctas? }
cover:        { imageSrc, dimRatio, minHeight, heading?, subheading?, headingStyle?, subheadingStyle?, cta?, ctas?, contentAlign }
post-list:    { title?, layout: list|grid-2|grid-3, showDate, showAuthor, showCategory, showExcerpt, showFeaturedImage, itemLayout?: title-meta-inline|stacked, metaLayout?: inline|stacked, metaAlign?: start|end, metaSeparator?: none|dot|dash|slash|pipe, itemGap?, metaGap? }
card-grid:    { title?, titleStyle?, subtitle?, columns: 2|3|4, columnWidths?, cardStyle?, cards: [{heading,body}] }
media-text:   { imageSrc, imageAlt, imagePosition: left|right, imageRadius?, imageAspectRatio?, columnWidths?, heading?, body?, headingStyle?, bodyStyle?, listItems?, cta?, ctas? }
testimonial:  { quote, authorName, authorTitle?, authorAvatar?, contentAlign?, quoteStyle?, authorStyle?, cardStyle? }
newsletter:   { heading, headingStyle?, subheading?, buttonText, layout: centered|card, inputStyle?, cardStyle? }
footer:       { brandDescription?, menuColumns: [{title,menuSlug}], copyright? }
post-content: { showTitle, showAuthor, showDate, showCategories }
post-meta:    { layout?: inline|stacked, showAuthor, showDate, showCategories, showSeparator? }
page-content: { showTitle }
comments:     { showForm, requireName, requireEmail }
search:       { title? }
breadcrumb:   {}
sidebar:      { title?, menuSlug?, showSiteInfo, showPages, showPosts, maxItems? }
modal:        { triggerText?, triggerStyle?, heading?, headingStyle?, body?, bodyStyle?, imageSrc?, imageAlt?, cta?, ctas?, layout?: centered|split, closeOnOverlay?, closeOnEsc?, overlayColor?, width?, height? }
tabs:         { title?, activeTab?, variant?, tabAlign?, tabs: [{ label, heading?, body?, imageSrc?, imageAlt?, cta? }] }
accordion:    { title?, items: [{ heading, body }], allowMultiple?, enableToggle?, defaultOpenItems?, variant? }
carousel:     { slides: [{ heading?, subheading?, imageSrc?, imageAlt?, cta? }], slideHeight?, dotsColor?, arrowColor?, arrowBackground?, headingStyle?, subheadingStyle?, autoplay?, autoplaySpeed?, loop?, effect?, showDots?, showArrows?, vertical?, transitionSpeed?, pauseOn?, contentAlign? }
\`\`\`

## Rules
- Preserve the original WordPress layout hierarchy and reading order as closely as possible.
- Treat the selected WordPress source, theme files under \`themes/**\`, and interactive plugin contracts from \`plugins/ultimate-addons-for-gutenberg\` / Spectra as the primary source of truth. Prefer extracting exact structure from those sources over inferring a cleaner or more generic composition.
- When repo hints expose concrete wrapper classes, variant names, item classes, alignment classes, or widget attr keys from Spectra/UAGB plugin source, preserve that same widget family in the plan instead of collapsing it into generic hero/card/media-text sections.
- If theme or plugin source is sparse, keep the plan sparse. Do NOT compensate by inventing extra wrapper sections, promo rows, centered hero treatments, or broader containers.
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
- When one source-backed section contains multiple real buttons, preserve ALL of them in order. Use \`cta\` for the first button and \`ctas\` for the full ordered list.
- Use ONLY hex colors. Derive them from theme tokens first, then from explicit template colors/classes if present. Do NOT invent a new palette direction.
- Text content in sections (headings, body text, card copy) must come EXACTLY from the template source — no invented text.
- If you need to output a dynamic variable (e.g. {item.title} or {post.title}), use EXACTLY ONE pair of curly braces. NEVER use double braces like {{item.title}} or {{post.title}}, as it breaks JSX syntax.
- If a section has a background image, use the exact \`src\` from the template.
- Never invent image URLs, avatars, featured artwork, or placeholder media. If the template source does not contain an image source for that section, omit the image/avatar field entirely.
- For testimonial sections specifically: only set \`authorAvatar\` when the template source contains a matching real image source. Otherwise omit \`authorAvatar\`.
- Preserve exact padding/margin/gap from the template when visible by filling \`paddingStyle\` / \`marginStyle\` / \`gapStyle\` with concrete CSS shorthand values.
- Preserve source-level custom classes by carrying them into \`customClassNames\` when a draft section or source node already exposes them. Do NOT drop or rename these classes.
- Preserve exact per-block typography and explicit column ratios when the template source exposes them; do not flatten them back to generic defaults.
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
- If the source shows a real slider/carousel widget (for example Spectra/UAGB slider), preserve it as a \`carousel\` section instead of collapsing it into a \`card-grid\`.
- If source widget hints say \`slider\` or \`carousel\`, the output MUST include at least one \`carousel\` section. Do not replace it with \`hero\`, \`card-grid\`, or \`media-text\`.
- If the source shows a real modal/popup/dialog block, preserve it as a \`modal\` section. Do NOT flatten it into \`hero\`, \`card-grid\`, or generic text.
- If source widget hints say \`modal\`, the output MUST include at least one \`modal\` section. Preserve trigger text plus modal heading/body/CTA content when present in source.
- When the source exposes interactive widget settings, preserve them in the JSON plan instead of flattening them away. Examples: slider autoplay/arrows/dots/effect, modal overlay-close/esc-close/overlay-color/width/height, tabs active tab + variant, accordion multi-open/default-open/toggle behavior.
- If the repo source-of-truth hints include Spectra plugin appearance cues, keep the closest Spectra visual family instead of defaulting to generic cards. Examples: tabs \`hstyle4\` / \`vstyle9\` should stay rounded-pill tabs, \`vstyle6-10\` should stay vertical rail tabs, modal should stay a fixed centered overlay dialog with explicit close button, accordion should stay a question-row + sliding-answer surface, and slider should keep inner arrows/dots inside one masked frame.
- Preserve source widget variant labels when they are already exposed by the source attrs or repo hints. Do not replace a concrete Spectra-style variant with a vague generic variant name.
- If the source shows a real tabs widget, preserve it as a \`tabs\` section. Do NOT flatten it into a \`card-grid\` or generic copy block.
- If source widget hints say \`tabs\`, the output MUST include at least one \`tabs\` section. Preserve every source-backed tab label and tab panel body.
- If the source shows a real accordion/FAQ/content-toggle widget, preserve it as an \`accordion\` section. Do NOT flatten it into a \`card-grid\`, \`hero\`, or generic text block.
- If source widget hints say \`accordion\`, the output MUST include at least one \`accordion\` section. Preserve every source-backed accordion panel heading and body.
- If source widget hints detect an interactive widget that is NOT represented in the deterministic draft sections, you must still add the missing source-backed section instead of silently omitting it.
- For Spectra/UAGB widgets, prefer exact source attrs and plugin contract cues over generic defaults. Examples: preserve slider arrows/dots/autoplay/effect, modal width/height/overlay-close behavior, tabs variant/alignment, accordion toggle rules, and source-backed inner wrappers.
- Output ONLY valid JSON — no markdown fences, no explanation.`;

  const draftHint = buildDraftSectionsHint(draftSections);

  const userPrompt = `## Component to plan: ${componentName}

${contractHint}

${buildAuxiliaryGuardHint(sourceBackedAuxiliaryLabels)}

${sourceAnalysis ? `${sourceAnalysis}\n\n` : ''}${repoContext ? `${repoContext}\n\n` : ''}${patternHints ? `${patternHints}\n\n` : ''}${spectraHints ? `${spectraHints}\n\n` : ''}${siteCtx}

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

  const lines = [
    '## Detected section order (deterministic, from WordPress block tree)',
    'The following sections were detected in the EXACT order they appear in the WordPress template.',
    'You MUST preserve this order in the `sections` array.',
    'You MAY fill in missing content fields (headings, image srcs, menu slugs, cta text) from the template source and site context.',
    'You MUST preserve all styling fields already set in each draft section (`background`, `textColor`, `paddingStyle`, `marginStyle`, `gapStyle`, `shadow`, `border`, `ctaStyle`, `cardStyle`, `presentation`) — copy them verbatim into your output section. Do NOT replace them with palette defaults.',
    'You MUST NOT reorder, merge, split, or drop sections from this list.',
    'If two adjacent draft sections have different `sectionKey` or different `sourceRef.sourceNodeId`, they must stay as two separate output sections.',
    'Do NOT transform a text-only draft section plus a later image-owning draft section into one split hero/media-text section.',
    '',
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
  sourceWidgetHints?: string[];
}): string {
  const lines = ['## Approved component contract'];
  lines.push(`Component: ${input.componentName}`);
  lines.push(`Type: ${input.componentType ?? 'unspecified'}`);
  lines.push(`Route: ${input.route ?? 'null'}`);
  lines.push(`Detail route: ${input.isDetail ? 'yes' : 'no'}`);
  lines.push(
    `Allowed dataNeeds: ${input.dataNeeds?.join(', ') || '(none declared)'}`,
  );
  if (input.sourceWidgetHints?.length) {
    lines.push(
      `Required source widget preservation hints: ${input.sourceWidgetHints
        .map((hint) => `\`${hint}\``)
        .join(', ')}`,
    );
    if (
      input.sourceWidgetHints.includes('slider') ||
      input.sourceWidgetHints.includes('carousel')
    ) {
      lines.push(
        'Hard rule: include at least one `carousel` section because the source contains a real slider/carousel widget.',
      );
    }
    if (input.sourceWidgetHints.includes('tabs')) {
      lines.push(
        'Hard rule: include at least one `tabs` section because the source contains a real tabs widget.',
      );
    }
    if (input.sourceWidgetHints.includes('modal')) {
      lines.push(
        'Hard rule: include at least one `modal` section because the source contains a real modal/popup widget.',
      );
    }
    if (input.sourceWidgetHints.includes('accordion')) {
      lines.push(
        'Hard rule: include at least one `accordion` section because the source contains a real accordion/FAQ widget.',
      );
    }
  }
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

function buildSpectraPlanningHint(
  repoManifest?: RepoThemeManifest,
  sourceWidgetHints?: string[],
): string {
  const spectra = repoManifest?.interactiveContracts?.spectra;
  if (!spectra?.detected || !sourceWidgetHints?.length) return '';

  const widgetConfigs: Array<{
    hint: string;
    contractKey: keyof typeof spectra.widgets;
    sectionType: string;
  }> = [
    { hint: 'modal', contractKey: 'modal', sectionType: 'modal' },
    { hint: 'tabs', contractKey: 'tabs', sectionType: 'tabs' },
    {
      hint: 'accordion',
      contractKey: 'accordion',
      sectionType: 'accordion',
    },
    { hint: 'slider', contractKey: 'slider', sectionType: 'carousel' },
    { hint: 'carousel', contractKey: 'slider', sectionType: 'carousel' },
  ];

  const lines = [
    '## Spectra / UAGB repo contract',
    'The repo includes `plugins/ultimate-addons-for-gutenberg`. When the scoped source contains one of these widgets, keep the matching interactive section type in the visual plan instead of flattening it into static content.',
  ];
  let included = 0;

  for (const config of widgetConfigs) {
    if (!sourceWidgetHints.includes(config.hint)) continue;
    const contract = spectra.widgets[config.contractKey];
    if (!contract) continue;
    included += 1;
    lines.push(
      `- ${config.hint}: keep as \`${config.sectionType}\`; block=${contract.blockType}; runtime=${contract.runtime}; attrs=${contract.attrKeys.join(', ') || 'none'}`,
    );
    const defaultParts = [
      contract.defaults?.width ? `width=${contract.defaults.width}` : null,
      contract.defaults?.height ? `height=${contract.defaults.height}` : null,
      contract.defaults?.maxWidth
        ? `maxWidth=${contract.defaults.maxWidth}`
        : null,
      contract.defaults?.overlayColor
        ? `overlayColor=${contract.defaults.overlayColor}`
        : null,
      contract.defaults?.background
        ? `background=${contract.defaults.background}`
        : null,
      contract.defaults?.textColor
        ? `textColor=${contract.defaults.textColor}`
        : null,
      contract.defaults?.contentPadding
        ? `contentPadding=${contract.defaults.contentPadding}`
        : null,
      contract.defaults?.slideHeight
        ? `slideHeight=${contract.defaults.slideHeight}`
        : null,
      typeof contract.defaults?.activeTab === 'number'
        ? `activeTab=${contract.defaults.activeTab}`
        : null,
      contract.defaults?.variant
        ? `variant=${contract.defaults.variant}`
        : null,
      contract.defaults?.layout ? `layout=${contract.defaults.layout}` : null,
      contract.defaults?.tabAlign
        ? `tabAlign=${contract.defaults.tabAlign}`
        : null,
      contract.defaults?.iconPosition
        ? `iconPosition=${contract.defaults.iconPosition}`
        : null,
      contract.defaults?.arrowBackground
        ? `arrowBackground=${contract.defaults.arrowBackground}`
        : null,
      contract.defaults?.arrowColor
        ? `arrowColor=${contract.defaults.arrowColor}`
        : null,
      contract.defaults?.dotsColor
        ? `dotsColor=${contract.defaults.dotsColor}`
        : null,
      typeof contract.defaults?.autoplay === 'boolean'
        ? `autoplay=${contract.defaults.autoplay}`
        : null,
      typeof contract.defaults?.autoplaySpeed === 'number'
        ? `autoplaySpeed=${contract.defaults.autoplaySpeed}`
        : null,
      typeof contract.defaults?.loop === 'boolean'
        ? `loop=${contract.defaults.loop}`
        : null,
      contract.defaults?.effect ? `effect=${contract.defaults.effect}` : null,
      typeof contract.defaults?.showDots === 'boolean'
        ? `showDots=${contract.defaults.showDots}`
        : null,
      typeof contract.defaults?.showArrows === 'boolean'
        ? `showArrows=${contract.defaults.showArrows}`
        : null,
      typeof contract.defaults?.vertical === 'boolean'
        ? `vertical=${contract.defaults.vertical}`
        : null,
      typeof contract.defaults?.transitionSpeed === 'number'
        ? `transitionSpeed=${contract.defaults.transitionSpeed}`
        : null,
      contract.defaults?.pauseOn
        ? `pauseOn=${contract.defaults.pauseOn}`
        : null,
      typeof contract.defaults?.allowMultiple === 'boolean'
        ? `allowMultiple=${contract.defaults.allowMultiple}`
        : null,
      contract.defaults?.defaultOpenItems
        ? `defaultOpenItems=${JSON.stringify(contract.defaults.defaultOpenItems)}`
        : null,
      typeof contract.defaults?.enableToggle === 'boolean'
        ? `enableToggle=${contract.defaults.enableToggle}`
        : null,
    ].filter((part): part is string => !!part);
    if (defaultParts.length > 0) {
      lines.push(`  plugin defaults: ${defaultParts.join(', ')}`);
    }
    if (contract.appearance?.wrapperClasses?.length) {
      lines.push(
        `  wrapper markers: ${contract.appearance.wrapperClasses.slice(0, 5).join(', ')}`,
      );
    }
    if (contract.appearance?.itemClasses?.length) {
      lines.push(
        `  item markers: ${contract.appearance.itemClasses.slice(0, 6).join(', ')}`,
      );
    }
  }

  if (included === 0) return '';
  lines.push(
    'Prefer these plugin-backed cues over generic hero/card/media-text interpretations when both could fit superficially.',
  );
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
      /(?:src|imageSrc)=["']([^"']+)["']/g,
    )) {
      if (match[1]) result.add(match[1].trim());
    }
    for (const match of templateSource.matchAll(/"src":"([^"]+)"/g)) {
      if (match[1]) result.add(match[1].trim());
    }
    for (const match of templateSource.matchAll(
      /https?:\/\/[^\s"'()<>]+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?[^\s"'()<>]*)?/gi,
    )) {
      if (match[0]) result.add(match[0].trim());
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
  'cta-strip',
  'cover',
  'post-list',
  'card-grid',
  'media-text',
  'testimonial',
  'newsletter',
  'footer',
  'post-content',
  'post-meta',
  'page-content',
  'comments',
  'search',
  'breadcrumb',
  'sidebar',
  'modal',
  'tabs',
  'accordion',
  'carousel',
]);

const VALID_DATA_NEEDS = new Set<string>([
  'siteInfo',
  'footerLinks',
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
  requiredSourceWidgets?: string[];
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
  options?: { allowedImageSrcs?: string[]; draftSections?: SectionPlan[] },
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
  const normalizedTopLevelCtas = normalizeCtaConfigs(raw.ctas);
  if (normalizedTopLevelCtas.length > 0) raw.ctas = normalizedTopLevelCtas;
  else delete raw.ctas;
  const normalizedTopLevelCta = normalizeCtaConfig(raw.cta);
  if (normalizedTopLevelCta) raw.cta = normalizedTopLevelCta;
  else if (normalizedTopLevelCtas[0]) raw.cta = normalizedTopLevelCtas[0];
  else delete raw.cta;
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
  const presentationNorm = sanitizeSectionPresentation(raw.presentation);
  if (presentationNorm) raw.presentation = presentationNorm;
  else delete raw.presentation;

  // Blueprint base-section fields — apply to all section types
  const ctaStyleNorm = sanitizeButtonStyle(raw.ctaStyle);
  if (ctaStyleNorm) raw.ctaStyle = ctaStyleNorm;
  else delete raw.ctaStyle;
  const secondaryCtaStyleNorm = sanitizeButtonStyle(raw.secondaryCtaStyle);
  if (secondaryCtaStyleNorm) raw.secondaryCtaStyle = secondaryCtaStyleNorm;
  else delete raw.secondaryCtaStyle;

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

    case 'cta-strip':
      if (!['left', 'center', 'right'].includes(raw.align)) delete raw.align;
      delete raw.heading;
      delete raw.subheading;
      delete raw.image;
      if (!raw.cta && !raw.ctas?.length) {
        return {
          section: null,
          reason: 'cta-strip must include cta or ctas',
        };
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
        raw.layout = 'list';
      for (const f of [
        'showDate',
        'showAuthor',
        'showCategory',
        'showExcerpt',
        'showFeaturedImage',
      ]) {
        if (typeof raw[f] !== 'boolean') raw[f] = true;
      }
      if (!['title-meta-inline', 'stacked'].includes(raw.itemLayout)) {
        delete raw.itemLayout;
      }
      if (!['inline', 'stacked'].includes(raw.metaLayout)) {
        delete raw.metaLayout;
      }
      if (!['start', 'end'].includes(raw.metaAlign)) {
        delete raw.metaAlign;
      }
      if (
        !['none', 'dot', 'dash', 'slash', 'pipe'].includes(raw.metaSeparator)
      ) {
        delete raw.metaSeparator;
      }
      for (const key of ['itemGap', 'metaGap'] as const) {
        if (typeof raw[key] === 'string' && raw[key].trim()) {
          raw[key] = normalizeCssLengthString(raw[key]);
        } else {
          delete raw[key];
        }
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
      if (!['center', 'left', 'right'].includes(raw.contentAlign)) {
        delete raw.contentAlign;
      }
      {
        const qs = sanitizeTypographyStyle(raw.quoteStyle);
        if (qs) raw.quoteStyle = qs;
        else delete raw.quoteStyle;
      }
      {
        const as_ = sanitizeTypographyStyle(raw.authorStyle);
        if (as_) raw.authorStyle = as_;
        else delete raw.authorStyle;
      }
      {
        const cs = sanitizeCardStyle(raw.cardStyle);
        if (cs) raw.cardStyle = cs;
        else delete raw.cardStyle;
      }
      break;

    case 'newsletter':
      if (typeof raw.heading !== 'string')
        raw.heading = 'Subscribe to our newsletter';
      if (typeof raw.buttonText !== 'string') raw.buttonText = 'Subscribe';
      if (!['centered', 'card'].includes(raw.layout)) raw.layout = 'centered';
      {
        const hs = sanitizeTypographyStyle(raw.headingStyle);
        if (hs) raw.headingStyle = hs;
        else delete raw.headingStyle;
      }
      {
        const cs = sanitizeCardStyle(raw.cardStyle);
        if (cs) raw.cardStyle = cs;
        else delete raw.cardStyle;
      }
      if (raw.inputStyle && typeof raw.inputStyle === 'object') {
        const inp = raw.inputStyle as Record<string, unknown>;
        const normalized: Record<string, string> = {};
        for (const k of ['background', 'borderRadius', 'border'] as const) {
          if (typeof inp[k] === 'string' && (inp[k] as string).trim())
            normalized[k] = (inp[k] as string).trim();
        }
        if (Object.keys(normalized).length > 0) raw.inputStyle = normalized;
        else delete raw.inputStyle;
      } else {
        delete raw.inputStyle;
      }
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

    case 'post-meta':
      if (!['inline', 'stacked'].includes(raw.layout)) raw.layout = 'inline';
      if (typeof raw.showAuthor !== 'boolean') raw.showAuthor = true;
      if (typeof raw.showDate !== 'boolean') raw.showDate = true;
      if (typeof raw.showCategories !== 'boolean') raw.showCategories = true;
      if (typeof raw.showSeparator !== 'boolean') raw.showSeparator = true;
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

    case 'modal':
      if (typeof raw.triggerText !== 'string') delete raw.triggerText;
      if (typeof raw.heading !== 'string') delete raw.heading;
      if (typeof raw.body !== 'string') delete raw.body;
      if (!['centered', 'split'].includes(raw.layout)) raw.layout = 'centered';
      if (typeof raw.closeOnOverlay !== 'boolean') delete raw.closeOnOverlay;
      if (typeof raw.closeOnEsc !== 'boolean') delete raw.closeOnEsc;
      if (typeof raw.overlayColor !== 'string' || !raw.overlayColor.trim()) {
        delete raw.overlayColor;
      }
      if (typeof raw.width !== 'string' || !raw.width.trim()) delete raw.width;
      if (typeof raw.height !== 'string' || !raw.height.trim())
        delete raw.height;
      if (
        typeof raw.closeIconPosition !== 'string' ||
        !raw.closeIconPosition.trim()
      ) {
        delete raw.closeIconPosition;
      }
      if (
        typeof raw.imageSrc === 'string' &&
        raw.imageSrc.trim() &&
        !isAllowedStaticImage(raw.imageSrc, options?.allowedImageSrcs)
      ) {
        delete raw.imageSrc;
        delete raw.imageAlt;
      }
      if (typeof raw.imageAlt !== 'string') delete raw.imageAlt;
      {
        const ts = sanitizeButtonStyle(raw.triggerStyle);
        if (ts) raw.triggerStyle = ts;
        else delete raw.triggerStyle;
      }
      {
        const mhs = sanitizeTypographyStyle(raw.headingStyle);
        if (mhs) raw.headingStyle = mhs;
        else delete raw.headingStyle;
      }
      {
        const mbs = sanitizeTypographyStyle(raw.bodyStyle);
        if (mbs) raw.bodyStyle = mbs;
        else delete raw.bodyStyle;
      }
      const modalCta = normalizeCtaConfig(raw.cta);
      if (modalCta) {
        raw.cta = modalCta;
      } else {
        delete raw.cta;
      }
      if (
        !raw.triggerText &&
        !raw.heading &&
        !raw.body &&
        !raw.imageSrc &&
        !raw.cta
      ) {
        return {
          section: null,
          reason:
            'modal must include triggerText, heading, body, imageSrc, or cta',
        };
      }
      break;

    case 'tabs':
      if (typeof raw.title !== 'string') delete raw.title;
      if (
        typeof raw.activeTab !== 'number' ||
        !Number.isFinite(raw.activeTab) ||
        raw.activeTab < 0
      ) {
        delete raw.activeTab;
      } else {
        raw.activeTab = Math.floor(raw.activeTab);
      }
      if (typeof raw.variant !== 'string' || !raw.variant.trim()) {
        delete raw.variant;
      }
      if (!['left', 'center', 'right'].includes(raw.tabAlign)) {
        delete raw.tabAlign;
      }
      if (!Array.isArray(raw.tabs) || raw.tabs.length === 0) {
        return {
          section: null,
          reason: 'tabs.tabs must be a non-empty array',
        };
      }
      raw.tabs = (raw.tabs as any[])
        .map((tab) => {
          if (!tab || typeof tab !== 'object') return null;
          const next: Record<string, unknown> = {};
          const label =
            typeof tab.label === 'string' && tab.label.trim()
              ? tab.label.trim()
              : typeof tab.heading === 'string' && tab.heading.trim()
                ? tab.heading.trim()
                : '';
          if (!label) return null;
          next.label = label;
          if (typeof tab.heading === 'string' && tab.heading.trim()) {
            next.heading = tab.heading.trim();
          }
          if (typeof tab.body === 'string' && tab.body.trim()) {
            next.body = tab.body.trim();
          }
          if (isAllowedStaticImage(tab.imageSrc, options?.allowedImageSrcs)) {
            next.imageSrc = tab.imageSrc.trim();
            if (typeof tab.imageAlt === 'string') {
              next.imageAlt = tab.imageAlt;
            }
          }
          if (normalizeCtaConfig(tab.cta)) {
            next.cta = normalizeCtaConfig(tab.cta);
          }
          if (!next.heading && !next.body && !next.imageSrc && !next.cta) {
            return null;
          }
          return next;
        })
        .filter(Boolean);
      if (raw.tabs.length === 0) {
        return {
          section: null,
          reason: 'tabs.tabs has no valid tab objects',
        };
      }
      if (typeof raw.activeTab === 'number') {
        raw.activeTab = Math.min(
          Math.max(raw.activeTab, 0),
          raw.tabs.length - 1,
        );
      }
      break;

    case 'accordion':
      if (typeof raw.title !== 'string') delete raw.title;
      if (!Array.isArray(raw.items) || raw.items.length === 0) {
        return {
          section: null,
          reason: 'accordion.items must be a non-empty array',
        };
      }
      raw.items = (raw.items as any[])
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const heading =
            typeof item.heading === 'string' && item.heading.trim()
              ? item.heading.trim()
              : typeof item.label === 'string' && item.label.trim()
                ? item.label.trim()
                : typeof item.title === 'string' && item.title.trim()
                  ? item.title.trim()
                  : '';
          const body =
            typeof item.body === 'string' && item.body.trim()
              ? item.body.trim()
              : typeof item.content === 'string' && item.content.trim()
                ? item.content.trim()
                : typeof item.text === 'string' && item.text.trim()
                  ? item.text.trim()
                  : '';
          if (!heading || !body) return null;
          return { heading, body };
        })
        .filter(Boolean);
      if (raw.items.length === 0) {
        return {
          section: null,
          reason: 'accordion.items has no valid {heading, body} items',
        };
      }
      if (typeof raw.allowMultiple !== 'boolean') raw.allowMultiple = false;
      if (typeof raw.enableToggle !== 'boolean') delete raw.enableToggle;
      if (typeof raw.variant !== 'string' || !raw.variant.trim()) {
        delete raw.variant;
      }
      if (Array.isArray(raw.defaultOpenItems)) {
        raw.defaultOpenItems = Array.from<number>(
          new Set<number>(
            raw.defaultOpenItems
              .map((value: unknown) =>
                typeof value === 'number' && Number.isFinite(value)
                  ? Math.floor(value)
                  : null,
              )
              .filter(
                (value: number | null): value is number =>
                  value !== null && value >= 0 && value < raw.items.length,
              ),
          ),
        ).sort((a, b) => a - b);
      } else {
        delete raw.defaultOpenItems;
      }
      break;

    case 'carousel':
      if (!Array.isArray(raw.slides) || raw.slides.length === 0) {
        return {
          section: null,
          reason: 'carousel.slides must be a non-empty array',
        };
      }
      raw.slides = (raw.slides as any[])
        .map((slide) => {
          if (!slide || typeof slide !== 'object') return null;
          const next: Record<string, unknown> = {};
          if (typeof slide.heading === 'string' && slide.heading.trim()) {
            next.heading = slide.heading;
          }
          if (typeof slide.subheading === 'string' && slide.subheading.trim()) {
            next.subheading = slide.subheading;
          }
          if (isAllowedStaticImage(slide.imageSrc, options?.allowedImageSrcs)) {
            next.imageSrc = slide.imageSrc.trim();
            if (typeof slide.imageAlt === 'string') {
              next.imageAlt = slide.imageAlt;
            }
          }
          if (normalizeCtaConfig(slide.cta)) {
            next.cta = normalizeCtaConfig(slide.cta);
          }
          if (Object.keys(next).length === 0) return null;
          return next;
        })
        .filter(Boolean);
      if (raw.slides.length === 0) {
        return {
          section: null,
          reason: 'carousel.slides has no valid slide objects',
        };
      }
      if (typeof raw.autoplay !== 'boolean') raw.autoplay = false;
      if (
        typeof raw.autoplaySpeed !== 'number' ||
        !Number.isFinite(raw.autoplaySpeed) ||
        raw.autoplaySpeed <= 0
      ) {
        delete raw.autoplaySpeed;
      } else {
        raw.autoplaySpeed = Math.round(raw.autoplaySpeed);
      }
      if (typeof raw.loop !== 'boolean') raw.loop = true;
      if (!['slide', 'fade', 'flip', 'coverflow'].includes(raw.effect)) {
        raw.effect = 'slide';
      }
      if (typeof raw.slideHeight === 'string' && raw.slideHeight.trim()) {
        raw.slideHeight = normalizeCssLengthString(raw.slideHeight.trim());
      } else {
        delete raw.slideHeight;
      }
      raw.dotsColor =
        sanitizeCssColorString(raw.dotsColor) ??
        (delete raw.dotsColor, undefined);
      raw.arrowColor =
        sanitizeCssColorString(raw.arrowColor) ??
        (delete raw.arrowColor, undefined);
      raw.arrowBackground =
        sanitizeCssColorString(raw.arrowBackground) ??
        (delete raw.arrowBackground, undefined);
      {
        const chs = sanitizeTypographyStyle(raw.headingStyle);
        if (chs) raw.headingStyle = chs;
        else delete raw.headingStyle;
      }
      {
        const css = sanitizeTypographyStyle(raw.subheadingStyle);
        if (css) raw.subheadingStyle = css;
        else delete raw.subheadingStyle;
      }
      if (typeof raw.showDots !== 'boolean') raw.showDots = true;
      if (typeof raw.showArrows !== 'boolean') raw.showArrows = true;
      if (typeof raw.vertical !== 'boolean') raw.vertical = false;
      if (
        typeof raw.transitionSpeed !== 'number' ||
        !Number.isFinite(raw.transitionSpeed) ||
        raw.transitionSpeed <= 0
      ) {
        delete raw.transitionSpeed;
      } else {
        raw.transitionSpeed = Math.round(raw.transitionSpeed);
      }
      if (!['hover', 'click'].includes(raw.pauseOn)) delete raw.pauseOn;
      if (!['center', 'left', 'right'].includes(raw.contentAlign)) {
        delete raw.contentAlign;
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

function normalizeCtaConfig(value: unknown):
  | {
      text: string;
      link: string;
      style?: 'button' | 'link';
      customClassNames?: string[];
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const text =
    typeof raw.text === 'string' && raw.text.trim()
      ? raw.text.trim()
      : typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim()
        : undefined;
  const link =
    typeof raw.link === 'string' && raw.link.trim()
      ? raw.link.trim()
      : typeof raw.href === 'string' && raw.href.trim()
        ? raw.href.trim()
        : typeof raw.url === 'string' && raw.url.trim()
          ? raw.url.trim()
          : undefined;
  if (!text || !link) return undefined;
  const style =
    raw.style === 'button' || raw.style === 'link' ? raw.style : undefined;
  const customClassNames = Array.isArray(raw.customClassNames)
    ? [
        ...new Set(
          raw.customClassNames
            .filter(
              (entry: unknown): entry is string => typeof entry === 'string',
            )
            .map((entry: string) => entry.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return {
    text,
    link,
    ...(style ? { style } : {}),
    ...(customClassNames.length > 0 ? { customClassNames } : {}),
  };
}

function normalizeCtaConfigs(
  value: unknown,
): Array<
  ReturnType<typeof normalizeCtaConfig> extends infer T ? NonNullable<T> : never
> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Array<NonNullable<ReturnType<typeof normalizeCtaConfig>>> = [];
  for (const entry of value) {
    const cta = normalizeCtaConfig(entry);
    if (!cta) continue;
    const key = `${cta.text}\u0000${cta.link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cta);
  }
  return result;
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

function findMissingRequiredSourceWidgets(
  sections: SectionPlan[],
  contract?: VisualPlanContract,
): string[] {
  const hints = new Set(contract?.requiredSourceWidgets ?? []);
  const missing: string[] = [];

  if (
    (hints.has('slider') || hints.has('carousel')) &&
    !sections.some((section) => section.type === 'carousel')
  ) {
    missing.push(
      'source contains slider/carousel widget but output has no carousel section',
    );
  }
  if (
    hints.has('modal') &&
    !sections.some((section) => section.type === 'modal')
  ) {
    missing.push(
      'source contains modal/popup widget but output has no modal section',
    );
  }
  if (
    hints.has('tabs') &&
    !sections.some((section) => section.type === 'tabs')
  ) {
    missing.push('source contains tabs widget but output has no tabs section');
  }
  if (
    hints.has('accordion') &&
    !sections.some((section) => section.type === 'accordion')
  ) {
    missing.push(
      'source contains accordion/FAQ widget but output has no accordion section',
    );
  }

  return missing;
}

function recoverRequiredSourceWidgetsFromDraft(
  sections: SectionPlan[],
  draftSections?: SectionPlan[],
  allowedImageSrcs?: string[],
  contract?: VisualPlanContract,
): { sections: SectionPlan[]; adjustments: string[] } {
  if (!draftSections?.length || !contract?.requiredSourceWidgets?.length) {
    return { sections, adjustments: [] };
  }

  const adjustments: string[] = [];
  const next = [...sections];
  const requiredTypes = new Set<SectionPlan['type']>();
  const hints = new Set(contract.requiredSourceWidgets);

  if (hints.has('slider') || hints.has('carousel'))
    requiredTypes.add('carousel');
  if (hints.has('modal')) requiredTypes.add('modal');
  if (hints.has('tabs')) requiredTypes.add('tabs');
  if (hints.has('accordion')) requiredTypes.add('accordion');

  for (let draftIndex = 0; draftIndex < draftSections.length; draftIndex++) {
    const draftSection = draftSections[draftIndex];
    if (!requiredTypes.has(draftSection.type)) continue;
    if (next.some((section) => section.type === draftSection.type)) continue;

    const recovered = validateSectionDetailed(
      JSON.parse(JSON.stringify(draftSection)),
      { draftSections, allowedImageSrcs },
    ).section;
    if (!recovered) continue;

    const insertionIndex = Math.min(draftIndex, next.length);
    next.splice(insertionIndex, 0, recovered);
    adjustments.push(
      `recovered missing required ${draftSection.type} section from draft fallback`,
    );
  }

  return { sections: next, adjustments };
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
  options?: {
    allowedImageSrcs?: string[];
    contract?: VisualPlanContract;
    draftSections?: SectionPlan[];
  },
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
  for (let index = 0; index < parsed.sections.length; index++) {
    const rawSection = parsed.sections[index];
    const { section, reason } = validateSectionDetailed(rawSection, options);
    if (section) {
      sections.push(section);
    } else {
      const rawType =
        typeof rawSection?.type === 'string' ? rawSection.type : 'unknown';
      const draftSection = options?.draftSections?.[index];
      const recovered =
        draftSection && (rawType === 'unknown' || draftSection.type === rawType)
          ? validateSectionDetailed(
              JSON.parse(JSON.stringify(draftSection)),
              options,
            ).section
          : null;
      if (recovered) {
        sections.push(recovered);
        droppedSections.push(
          `type=${rawType}: ${reason ?? 'invalid section'}; recovered from draft fallback`,
        );
      } else {
        droppedSections.push(`type=${rawType}: ${reason ?? 'invalid section'}`);
      }
    }
  }

  const recoveredSections = recoverRequiredSourceWidgetsFromDraft(
    sections,
    options?.draftSections,
    options?.allowedImageSrcs,
    options?.contract,
  );
  const sanitizedSections = sanitizeSectionsForContract(
    recoveredSections.sections,
    options?.contract,
  );
  droppedSections.push(...recoveredSections.adjustments);
  droppedSections.push(...sanitizedSections.adjustments);
  const missingRequiredWidgets = findMissingRequiredSourceWidgets(
    sanitizedSections.sections,
    options?.contract,
  );
  if (missingRequiredWidgets.length > 0) {
    droppedSections.push(...missingRequiredWidgets);
    return {
      plan: null,
      diagnostic: {
        reason: missingRequiredWidgets.join('; '),
        rawOutput: raw,
        cleanedOutput: cleaned,
        droppedSections,
      },
    };
  }

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

function normalizeCssLengthString(value: string): string {
  const normalized = value.trim();
  if (!normalized) return value;
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
}

function sanitizeButtonStyle(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const next: Record<string, string> = {};
  const strFields = [
    'variant',
    'background',
    'color',
    'hoverBackground',
    'hoverColor',
    'border',
    'borderRadius',
    'padding',
  ] as const;
  for (const key of strFields) {
    if (typeof raw[key] === 'string' && (raw[key] as string).trim()) {
      next[key] = (raw[key] as string).trim();
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeCardStyle(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  const strFields = [
    'background',
    'padding',
    'borderRadius',
    'border',
    'shadow',
    'imageRadius',
    'imageAspectRatio',
  ] as const;
  for (const key of strFields) {
    if (typeof raw[key] === 'string' && (raw[key] as string).trim()) {
      next[key] = (raw[key] as string).trim();
    }
  }
  const titleStyle = sanitizeTypographyStyle(raw.titleStyle);
  if (titleStyle) next.titleStyle = titleStyle;
  const bodyStyle = sanitizeTypographyStyle(raw.bodyStyle);
  if (bodyStyle) next.bodyStyle = bodyStyle;
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeSectionPresentation(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const next: Record<string, string> = {};
  if (raw.container === 'shell' || raw.container === 'content') {
    next.container = raw.container;
  }
  for (const key of ['contentAlign', 'textAlign'] as const) {
    if (raw[key] === 'left' || raw[key] === 'center' || raw[key] === 'right') {
      next[key] = raw[key];
    }
  }
  if (
    raw.itemsAlign === 'start' ||
    raw.itemsAlign === 'center' ||
    raw.itemsAlign === 'end' ||
    raw.itemsAlign === 'stretch'
  ) {
    next.itemsAlign = raw.itemsAlign;
  }
  if (
    raw.justify === 'start' ||
    raw.justify === 'center' ||
    raw.justify === 'between' ||
    raw.justify === 'end'
  ) {
    next.justify = raw.justify;
  }
  if (
    typeof raw.contentMaxWidth === 'string' &&
    raw.contentMaxWidth.trim().length > 0
  ) {
    next.contentMaxWidth = normalizeCssLengthString(raw.contentMaxWidth);
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeCssColorString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim();
}
