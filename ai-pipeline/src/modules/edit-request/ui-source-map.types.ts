import type { SourceRef } from '../../common/utils/source-node-id.util.js';

export interface GeneratedSectionRef {
  sourceNodeId: string;
  componentName: string;
  sectionKey?: string;
  debugKey?: string;
  sectionComponentName?: string;
  outputFilePath: string;
  exportName?: string;
  startLine?: number;
  endLine?: number;
}

export type UiMutationNodeRole =
  | 'section'
  | 'container'
  | 'card'
  | 'button'
  | 'link'
  | 'heading'
  | 'text'
  | 'media'
  | 'form'
  | 'input'
  | 'list'
  | 'unknown';

export interface UiSourceMapEntry extends SourceRef {
  componentName: string;
  sectionKey?: string;
  debugKey?: string;
  sectionComponentName?: string;
  outputFilePath: string;
  exportName?: string;
  startLine?: number;
  endLine?: number;
}

export interface UiMutationCandidate {
  candidateId: string;
  componentName: string;
  outputFilePath: string;
  nodeRole: UiMutationNodeRole;
  elementTag: string;
  ownerComponentName?: string;
  ownerSourceNodeId?: string;
  ownerSectionKey?: string;
  sourceNodeId?: string;
  textPreview?: string;
  startLine?: number;
  endLine?: number;
}

export interface ResolvedCaptureTargetRecord {
  captureId: string;
  sourceNodeId: string;
  templateName: string;
  sourceFile: string;
  componentName: string;
  sectionKey?: string;
  debugKey?: string;
  sectionComponentName?: string;
  outputFilePath: string;
  startLine?: number;
  endLine?: number;
  targetComponentName?: string;
  targetSourceNodeId?: string;
  targetNodeRole?: UiMutationNodeRole;
  targetElementTag?: string;
  targetTextPreview?: string;
  targetStartLine?: number;
  targetEndLine?: number;
  resolution:
    | 'exact-source-map'
    | 'heuristic'
    | 'intent-element-match'
    | 'intent-owner-fallback';
  confidence: number;
}
