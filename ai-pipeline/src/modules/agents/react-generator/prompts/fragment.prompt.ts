import type { ComponentVisualPlan } from '../visual-plan.schema.js';
import { buildFlatRestSchemaNote } from '../api-contract.js';

export const FRAGMENT_SYSTEM_PROMPT =
  'You are a React TSX layout expert for WordPress migrations. Write only the JSX body block — no imports, no function declaration, no export default. Output raw JSX starting with a single root element.';

/**
 * Builds the short user prompt for JSX-fragment-only generation.
 *
 * The AI receives:
 * - Which variables are already declared in the surrounding frame
 * - The WordPress template source (block tree or PHP hints)
 * - The visual plan sections
 * - On retry: the exact TypeScript compiler errors from the previous attempt
 *
 * The AI should output ONLY a JSX fragment (starting with <main>, <section>,
 * <header>, or <footer>) — not a full file.
 */
export function buildFragmentPrompt(options: {
  componentName: string;
  availableVariables: string;
  templateSource: string;
  visualPlan?: ComponentVisualPlan;
  componentType?: 'page' | 'partial';
  editRequestContextNote?: string;
  retryError?: string;
  previousFragment?: string;
}): string {
  const {
    componentName,
    availableVariables,
    templateSource,
    visualPlan,
    componentType,
    editRequestContextNote,
    retryError,
    previousFragment,
  } = options;

  const visualPlanText = visualPlan
    ? visualPlan.sections
        .map((s) => {
          const { type, ...rest } = s as unknown as Record<string, unknown>;
          const detail = Object.keys(rest).length
            ? ` — ${JSON.stringify(rest).slice(0, 600)}`
            : '';
          return `- ${type}${detail}`;
        })
        .join('\n')
    : '(none — derive layout entirely from template source)';

  const retrySection =
    retryError && previousFragment
      ? `

## PREVIOUS ATTEMPT FAILED — fix ONLY these errors:
\`\`\`
${retryError}
\`\`\`

Important diagnosis:
- You likely referenced fields that do not exist on this project's flat REST types.
- Remove any GraphQL/WordPress wrapper access such as \`.node\`, \`.nodes\`, \`.rendered\`, or \`.edges\`.

Previous fragment (contains the error above):
\`\`\`tsx
${previousFragment}
\`\`\`

Rewrite the fragment to fix the errors. Do NOT change anything that was already correct.`
      : '';

  return `Fill in the JSX return body for the \`${componentName}\` React component.

## Variables already declared in the surrounding frame (do NOT redeclare):
${availableVariables}

${buildFlatRestSchemaNote(availableVariables)}

## Strict rules:
- Output ONE JSX fragment only — no imports, no \`export default\`, no function wrapper
- Start with a SINGLE root element: \`<main>\`, \`<section>\`, \`<header>\`, or \`<footer>\`
- No CSS imports, no \`style.foo\`
- Use Tailwind utilities for layout/spacing. For colors, typography, and button/card styles, prefer inline \`style\` props from the visual plan fields (ctaStyle, cardStyle, headingStyle, etc.) when present — do NOT invent values.
- Recreate the source layout faithfully with semantic wrappers, spacing, and widths from the template and theme tokens.
- \`<Link to="...">\` for internal paths (already imported)
- Do NOT add \`useState\`, \`useEffect\`, \`fetch\`, or \`useParams\` — they are in the frame
- Do NOT reference undeclared runtime variables such as \`node\`, \`nodes\`, \`block\`, \`attrs\`, or \`children\`
- Do NOT use GraphQL/WordPress wrapper fields: \`.node\`, \`.nodes\`, \`.rendered\`, \`.edges\`
- No markdown fences, no explanations, no comments
- Every opening JSX tag must have a matching closing tag
${componentType === 'page' ? '- This is a page-content component inside a shared Layout wrapper. Do NOT emit a site-level `<header>`, `<footer>`, navigation chrome, copyright text, or footer link columns even if the original template source contains them.' : ''}

## Visual plan sections:
${visualPlanText}

${editRequestContextNote ? `${editRequestContextNote}\n\n` : ''}## WordPress template source:
${templateSource}${retrySection}

Fragment:`;
}
