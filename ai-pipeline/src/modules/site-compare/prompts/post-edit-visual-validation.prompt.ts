import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  AutomationComparePageResult,
  PostEditVisualValidationResult,
} from '../visual-diagnosis.types.js';

const TEMPLATE = readFileSync(
  join(
    process.cwd(),
    'src/modules/site-compare/prompts/post-edit-visual-validation.prompt.md',
  ),
  'utf-8',
);

const JSON_SCHEMA = `{"componentName":"string","routeKey":"string|null","route":"string|null","passed":true,"shouldRepair":false,"editIntentSatisfied":true,"outOfScopeRegression":false,"wpParityAdvisoryOnly":false,"confidence":0.0,"score":0,"summary":"string","issues":[{"type":"edit_not_applied|scope_regression|layout_regression|style_regression|content_regression|wp_drift_advisory|unknown","severity":"low|medium|high","target":"string","evidence":"string","suggestedAction":"string","inEditScope":true}],"repairPlan":{"strategy":"string","instructions":["string"],"targetAreas":[{"type":"section","sectionHint":"string","headingHint":"string"}],"guardrails":["string"]}}`;

export const POST_EDIT_VISUAL_VALIDATION_SYSTEM_PROMPT = TEMPLATE.replace(
  '{{JSON_SCHEMA}}',
  JSON_SCHEMA,
).trim();

export function buildPostEditVisualValidationUserPrompt(input: {
  componentName: string;
  page: AutomationComparePageResult;
  requestContextLines: string[];
  sourceEvidence: string[];
  planEvidence: string[];
  baselineAccuracy?: number | null;
  heuristic: PostEditVisualValidationResult;
}): string {
  const {
    componentName,
    page,
    requestContextLines,
    sourceEvidence,
    planEvidence,
    baselineAccuracy,
    heuristic,
  } = input;
  const lines: string[] = [
    `Component: ${componentName}`,
    `Route key: ${page.routeKey ?? 'unknown'}`,
    `Route: ${page.route ?? page.visual?.reactPath ?? 'unknown'}`,
    `Suggested component hint from automation: ${page.componentHint ?? 'unknown'}`,
    '',
    'User edit request context:',
    ...requestContextLines.map((line) => `- ${line}`),
    '',
    'Edited preview compare metrics:',
    `- visual status: ${page.visual?.status ?? 'unknown'}`,
    `- content status: ${page.content?.status ?? 'unknown'}`,
    `- visual accuracy: ${page.visual?.accuracy ?? 'unknown'}`,
    `- diffPct: ${page.visual?.diffPct ?? 'unknown'}`,
    `- overlapDiffPct: ${page.visual?.overlapDiffPct ?? 'unknown'}`,
    `- extraDiffPct: ${page.visual?.extraDiffPct ?? 'unknown'}`,
    `- domSimilarity: ${page.visual?.domComparison?.similarityScore ?? 'unknown'}`,
    `- region count: ${(page.visual?.regions ?? []).length}`,
    `- baseline accuracy before edit: ${baselineAccuracy ?? 'unknown'}`,
  ];

  if ((page.visual?.regions?.length ?? 0) > 0) {
    lines.push('Top diff regions:');
    for (const region of page.visual?.regions ?? []) {
      const bbox = region.bbox;
      lines.push(
        `- ${region.id ?? 'region'} | severity=${region.severity ?? 'unknown'} | kind=${region.kind ?? 'diff'} | diffPixels=${region.diffPixels ?? 'unknown'} | bbox=${bbox ? `(${bbox.x},${bbox.y},${bbox.width},${bbox.height})` : 'unknown'}`,
      );
    }
  }

  if ((page.content?.issues?.length ?? 0) > 0) {
    lines.push('Content issues:');
    for (const issue of page.content?.issues ?? []) {
      lines.push(`- ${issue}`);
    }
  }

  if (sourceEvidence.length > 0) {
    lines.push('WordPress / DB source evidence (secondary reference only):');
    for (const evidence of sourceEvidence) {
      lines.push(`- ${evidence}`);
    }
  }

  if (planEvidence.length > 0) {
    lines.push('Current plan evidence:');
    for (const evidence of planEvidence) {
      lines.push(`- ${evidence}`);
    }
  }

  lines.push(
    `Heuristic baseline validation: passed=${heuristic.passed} shouldRepair=${heuristic.shouldRepair} editIntentSatisfied=${heuristic.editIntentSatisfied} outOfScopeRegression=${heuristic.outOfScopeRegression} score=${heuristic.score} confidence=${heuristic.confidence.toFixed(2)}`,
  );
  lines.push('');
  lines.push(
    'Return only the JSON object described by the system prompt. Do not add commentary.',
  );

  return lines.join('\n');
}
