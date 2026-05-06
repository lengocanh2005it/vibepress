import type { SectionPlan } from '../../modules/agents/react-generator/visual-plan.schema.js';

export type ChunkStructuralKind =
  | 'pattern'
  | 'template-part'
  | 'group'
  | 'columns'
  | 'cover'
  | 'query'
  | 'uagb-container'
  | 'uagb-section'
  | 'misc';

export type ChunkMergeHint =
  | 'isolated'
  | 'merge-next'
  | 'merge-prev'
  | 'optional';

export interface ChunkPlan {
  chunkId: string;
  order: number;
  structuralKind: ChunkStructuralKind;
  sourceRef?: {
    sourceNodeId?: string;
    templateName?: string;
    sourceFile?: string;
    topLevelIndex?: number;
    blockName?: string;
    parentSourceNodeId?: string;
  };
  blockNames: string[];
  wrapperClassNames: string[];
  rawHtml?: string;
  draftSections: SectionPlan[];
  aiLabel?: {
    semanticKind: string;
    suggestedSectionType: SectionPlan['type'];
    mergeHint: ChunkMergeHint;
    confidence: number;
    rationale?: string;
  };
}
