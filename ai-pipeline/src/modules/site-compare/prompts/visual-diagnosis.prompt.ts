import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  AutomationComparePageResult,
  VisualMismatchDiagnosis,
} from '../visual-diagnosis.types.js';

const TEMPLATE = readFileSync(
  join(
    process.cwd(),
    'src/modules/site-compare/prompts/visual-diagnosis.prompt.md',
  ),
  'utf-8',
);

const JSON_SCHEMA = `{"componentName":"string","routeKey":"string|null","route":"string|null","shouldRepair":true,"confidence":0.0,"score":0,"issues":[{"type":"missing_section|section_order|layout_mismatch|element_position|style_mismatch|content_missing|image_mismatch|unknown","severity":"low|medium|high","sectionHint":"string","location":"string","evidence":"string","suggestedFix":"string","sourceBacked":true}],"rootCause":{"primary":"plan-omission|missing-section|missing-image|content-drift|layout-drift|route-mapping-error|data-binding-error|shared-layout-mismatch|unknown","secondary":["string"],"reasoning":"string"},"evidence":{"sourceHints":["string"],"missingLabels":["string"],"sectionLikelyMissingFromPlan":true},"repairPlan":{"strategy":"string","instructions":["string"],"targetAreas":[{"type":"section","sectionHint":"string","headingHint":"string"}],"guardrails":["string"]}}`;

export const VISUAL_DIAGNOSIS_SYSTEM_PROMPT = TEMPLATE.replace(
  '{{JSON_SCHEMA}}',
  JSON_SCHEMA,
).trim();

export function buildVisualDiagnosisUserPrompt(input: {
  componentName: string;
  page: AutomationComparePageResult;
  sourceEvidence: string[];
  planEvidence: string[];
  heuristic: VisualMismatchDiagnosis;
}): string {
  const { componentName, page, sourceEvidence, planEvidence, heuristic } =
    input;
  const lines: string[] = [
    `Component: ${componentName}`,
    `Route key: ${page.routeKey ?? 'unknown'}`,
    `Route: ${page.route ?? page.visual?.reactPath ?? 'unknown'}`,
    `Suggested component hint from automation: ${page.componentHint ?? 'unknown'}`,
    '',
    'Automation metrics:',
    `- visual status: ${page.visual?.status ?? 'unknown'}`,
    `- content status: ${page.content?.status ?? 'unknown'}`,
    `- visual accuracy: ${page.visual?.accuracy ?? 'unknown'}`,
    `- diffPct: ${page.visual?.diffPct ?? 'unknown'}`,
    `- overlapDiffPct: ${page.visual?.overlapDiffPct ?? 'unknown'}`,
    `- extraDiffPct: ${page.visual?.extraDiffPct ?? 'unknown'}`,
    `- domSimilarity: ${page.visual?.domComparison?.similarityScore ?? 'unknown'}`,
    `- region count: ${(page.visual?.regions ?? []).length}`,
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
    lines.push('WordPress / DB source evidence:');
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
    `Heuristic baseline diagnosis: rootCause=${heuristic.rootCause.primary}, confidence=${heuristic.confidence.toFixed(2)}, score=${heuristic.score}, missingLabels=${heuristic.evidence.missingLabels.join(' | ') || 'none'}`,
  );
  lines.push('');
  lines.push(
    'Return only the JSON object described by the system prompt. Do not add commentary.',
  );

  return lines.join('\n');
}
