import type {
  ChunkPlan,
  ChunkMergeHint,
} from '../../../common/types/chunk.schema.js';
import type { SectionPlan } from '../react-generator/visual-plan.schema.js';

export interface ChunkLabelResult {
  chunkId: string;
  semanticKind: string;
  suggestedSectionType: SectionPlan['type'];
  mergeHint: ChunkMergeHint;
  confidence: number;
  rationale?: string;
}

const VALID_SECTION_TYPES: SectionPlan['type'][] = [
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
  'post-title',
  'post-featured-image',
  'post-meta',
  'post-terms',
  'post-navigation',
  'page-content',
  'prose-block',
  'search',
  'breadcrumb',
  'comments',
  'sidebar',
  'modal',
  'tabs',
  'accordion',
  'carousel',
];

const VALID_MERGE_HINTS: ChunkMergeHint[] = [
  'isolated',
  'merge-next',
  'merge-prev',
  'optional',
];

export function buildChunkLabelingPrompt(chunks: ChunkPlan[]): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt = `You are a WordPress-to-React semantic classifier.

Given an array of WordPress block chunks (structural subtrees from a page template), classify each chunk with a semantic label.

Output a JSON array (one entry per chunk) with exactly these fields:
\`\`\`
[
  {
    "chunkId": string,          // same as input chunkId
    "semanticKind": string,     // short lowercase label: "hero", "services", "projects", "testimonials", "cta", "footer", "nav", "newsletter", "blog-list", "gallery", "pricing", "faq", "sidebar", "search", "breadcrumb", etc.
    "suggestedSectionType": string, // one of the valid section types below
    "mergeHint": "isolated" | "merge-next" | "merge-prev" | "optional",
    "confidence": number,       // 0.0–1.0
    "rationale": string         // one sentence explaining the classification
  }
]
\`\`\`

Valid suggestedSectionType values:
${VALID_SECTION_TYPES.join(', ')}

mergeHint rules:
- "isolated": this chunk stands alone and must never be merged with adjacent chunks
- "merge-next": this chunk wants to merge with the following chunk (small intro text, decorative divider, etc.)
- "merge-prev": this chunk wants to merge with the preceding chunk (small footnote, attribution, etc.)
- "optional": this chunk is a minor element that can be absorbed if adjacent chunks merge, but is not required

Use "isolated" when in doubt. Only use merge hints when there is a clear semantic reason (e.g. a 2-word CTA text row above a button grid).

Return ONLY the JSON array. No markdown fences, no explanation outside the array.`;

  const chunkSummaries = chunks.map((chunk) => {
    const draftTypes = chunk.draftSections.map((s) => s.type).join(', ');
    return {
      chunkId: chunk.chunkId,
      structuralKind: chunk.structuralKind,
      blockNames: chunk.blockNames.slice(0, 12),
      wrapperClassNames: chunk.wrapperClassNames.slice(0, 8),
      draftSectionTypes: draftTypes || '(none)',
      rawHtmlSnippet: chunk.rawHtml ? chunk.rawHtml.slice(0, 300) : undefined,
    };
  });

  const userPrompt = `Classify these ${chunks.length} WordPress block chunks:

${JSON.stringify(chunkSummaries, null, 2)}`;

  return { systemPrompt, userPrompt };
}

export function parseChunkLabelingResponse(
  text: string,
  chunks: ChunkPlan[],
): ChunkLabelResult[] {
  const fallbackResults = (): ChunkLabelResult[] =>
    chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      semanticKind: chunk.structuralKind,
      suggestedSectionType: (chunk.draftSections[0]?.type ??
        'prose-block') as SectionPlan['type'],
      mergeHint: 'isolated' as ChunkMergeHint,
      confidence: 0,
    }));

  try {
    const trimmed = text.trim();
    const jsonText = trimmed.startsWith('[')
      ? trimmed
      : trimmed
          .replace(/^```(?:json)?\n?/, '')
          .replace(/\n?```$/, '')
          .trim();

    const parsed: unknown = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return fallbackResults();

    const chunkIndex = new Map(chunks.map((c) => [c.chunkId, c]));
    const results: ChunkLabelResult[] = [];

    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      const chunkId =
        typeof entry['chunkId'] === 'string' ? entry['chunkId'] : null;
      if (!chunkId || !chunkIndex.has(chunkId)) continue;

      const semanticKind =
        typeof entry['semanticKind'] === 'string'
          ? entry['semanticKind']
          : 'misc';
      const rawType = entry['suggestedSectionType'];
      const suggestedSectionType = (
        typeof rawType === 'string' &&
        VALID_SECTION_TYPES.includes(rawType as SectionPlan['type'])
          ? rawType
          : (chunkIndex.get(chunkId)!.draftSections[0]?.type ?? 'prose-block')
      ) as SectionPlan['type'];
      const rawHint = entry['mergeHint'];
      const mergeHint = (
        typeof rawHint === 'string' &&
        VALID_MERGE_HINTS.includes(rawHint as ChunkMergeHint)
          ? rawHint
          : 'isolated'
      ) as ChunkMergeHint;
      const rawConf = entry['confidence'];
      const confidence =
        typeof rawConf === 'number' ? Math.min(1, Math.max(0, rawConf)) : 0.5;
      const rationale =
        typeof entry['rationale'] === 'string' ? entry['rationale'] : undefined;

      results.push({
        chunkId,
        semanticKind,
        suggestedSectionType,
        mergeHint,
        confidence,
        rationale,
      });
    }

    // Fill in any missing chunks with fallback
    const covered = new Set(results.map((r) => r.chunkId));
    for (const chunk of chunks) {
      if (!covered.has(chunk.chunkId)) {
        results.push({
          chunkId: chunk.chunkId,
          semanticKind: chunk.structuralKind,
          suggestedSectionType: (chunk.draftSections[0]?.type ??
            'prose-block') as SectionPlan['type'],
          mergeHint: 'isolated',
          confidence: 0,
        });
      }
    }

    return results;
  } catch {
    return fallbackResults();
  }
}
