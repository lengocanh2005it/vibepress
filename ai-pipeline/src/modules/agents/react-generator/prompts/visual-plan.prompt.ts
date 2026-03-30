import type { DbContentResult } from '../../db-content/db-content.service.js';
import type { ThemeTokens } from '../../block-parser/block-parser.service.js';
import type { ComponentVisualPlan } from '../visual-plan.schema.js';

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

/**
 * Parse and validate the AI response into a ComponentVisualPlan.
 * Returns null if parsing fails.
 */
export function parseVisualPlan(
  raw: string,
  componentName: string,
): ComponentVisualPlan | null {
  const cleaned = raw
    .replace(/^```[\w]*\n?/m, '')
    .replace(/```$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as ComponentVisualPlan;
    if (!parsed.sections || !Array.isArray(parsed.sections)) return null;
    if (!parsed.palette) return null;
    // Ensure componentName matches
    parsed.componentName = componentName;
    return parsed;
  } catch {
    return null;
  }
}
