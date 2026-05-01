import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type {
  RepoResolvedSourceSummary,
  RepoThemeManifest,
} from '../repo-analyzer/repo-analyzer.service.js';
import type {
  ComponentVisualPlan,
  SectionPlan,
} from '../react-generator/visual-plan.schema.js';
import {
  getVisualPlanRenderAuthority,
  shouldProtectDeterministicStructureFromAi,
} from '../react-generator/visual-plan.schema.js';
import type {
  PlanningSourceCandidate,
  PlanningSourceContext,
} from './planner-visual-repair.service.js';

export interface LayoutAnalysisArtifact {
  version: 1;
  scope: 'fse-shared-chrome-v1';
  generatedAt: string;
  supported: boolean;
  supportReason: string;
  theme: {
    parserType: 'classic' | 'fse';
    detectedThemeKind?: string;
    themeSlug?: string;
    activeThemeSlug?: string;
    parentThemeSlug?: string;
  };
  contentSummary: {
    menus: number;
    dbNavigations: number;
    dbTemplates: number;
    pages: number;
    posts: number;
  };
  deterministicComponents: string[];
  pixelLockedComponents: string[];
  components: LayoutAnalysisComponentEntry[];
}

export interface LayoutAnalysisComponentEntry {
  templateName: string;
  componentName: string;
  componentType: 'page' | 'partial';
  sourceFile?: string;
  dataNeeds: string[];
  canLockDeterministic: boolean;
  deterministicConfidence: number;
  reason: string;
  renderMode?: ComponentVisualPlan['renderMode'];
  deterministicAuthority?: boolean;
  renderAuthority?: ComponentVisualPlan['renderAuthority'];
  lockPolicy?: ComponentVisualPlan['lockPolicy'];
  planningSource?: {
    label?: string;
    templateName?: string;
    file?: string;
    reason?: string;
    analysis?: string;
  };
  sourceCandidates: LayoutAnalysisSourceCandidate[];
  blockTreeSummary?: LayoutAnalysisBlockTreeSummary;
  draftBlockTree?: BlockNode[];
  draftSections?: SectionPlan[];
  visualPlan?: {
    renderMode?: ComponentVisualPlan['renderMode'];
    deterministicAuthority?: boolean;
    renderAuthority?: ComponentVisualPlan['renderAuthority'];
    lockPolicy?: ComponentVisualPlan['lockPolicy'];
    sectionTypes: string[];
    sections: SectionPlan[];
  };
}

export interface LayoutAnalysisSourceCandidate {
  label: string;
  templateName?: string;
  sourceFile?: string;
  reason: string;
  priority: number;
  richness: number;
  selectionScore?: number;
}

export interface LayoutAnalysisBlockTreeSummary {
  rootCount: number;
  nodeCount: number;
  maxDepth: number;
  blockNames: string[];
  sourceFiles: string[];
}

export function createUnsupportedLayoutAnalysisArtifact(input: {
  parserType: 'classic' | 'fse';
  supportReason: string;
  manifest?: RepoThemeManifest;
  resolvedSource?: RepoResolvedSourceSummary;
  content: DbContentResult;
}): LayoutAnalysisArtifact {
  return {
    version: 1,
    scope: 'fse-shared-chrome-v1',
    generatedAt: new Date().toISOString(),
    supported: false,
    supportReason: input.supportReason,
    theme: buildThemeSummary({
      parserType: input.parserType,
      manifest: input.manifest,
      resolvedSource: input.resolvedSource,
    }),
    contentSummary: buildContentSummary(input.content),
    deterministicComponents: [],
    pixelLockedComponents: [],
    components: [],
  };
}

export function createLayoutAnalysisArtifact(input: {
  parserType: 'classic' | 'fse';
  manifest?: RepoThemeManifest;
  resolvedSource?: RepoResolvedSourceSummary;
  content: DbContentResult;
  components: LayoutAnalysisComponentEntry[];
}): LayoutAnalysisArtifact {
  const deterministicComponents = input.components
    .filter((component) => component.canLockDeterministic)
    .map((component) => component.componentName);
  const pixelLockedComponents = input.components
    .filter((component) => component.renderAuthority === 'deterministic-pixel')
    .map((component) => component.componentName);

  return {
    version: 1,
    scope: 'fse-shared-chrome-v1',
    generatedAt: new Date().toISOString(),
    supported: true,
    supportReason:
      'FSE shared chrome candidates were analyzed from repo + DB sources.',
    theme: buildThemeSummary({
      parserType: input.parserType,
      manifest: input.manifest,
      resolvedSource: input.resolvedSource,
    }),
    contentSummary: buildContentSummary(input.content),
    deterministicComponents,
    pixelLockedComponents,
    components: input.components,
  };
}

export function toLayoutAnalysisSourceCandidates(
  candidates: PlanningSourceCandidate[],
): LayoutAnalysisSourceCandidate[] {
  return candidates.map((candidate) => ({
    label: candidate.label,
    templateName: candidate.templateName,
    sourceFile: candidate.sourceFile,
    reason: candidate.reason,
    priority: candidate.priority,
    richness: candidate.richness,
    ...(typeof candidate.selectionScore === 'number'
      ? { selectionScore: candidate.selectionScore }
      : {}),
  }));
}

export function summarizeBlockTree(
  blockTree: BlockNode[] | undefined,
): LayoutAnalysisBlockTreeSummary | undefined {
  if (!blockTree?.length) return undefined;

  const blockNames = new Set<string>();
  const sourceFiles = new Set<string>();
  let nodeCount = 0;
  let maxDepth = 0;

  const visit = (node: BlockNode, depth: number) => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (node.blockName) blockNames.add(node.blockName);
    const sourceFile = node.sourceRef?.sourceFile?.trim();
    if (sourceFile) sourceFiles.add(sourceFile);
    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const node of blockTree) {
    visit(node, 1);
  }

  return {
    rootCount: blockTree.length,
    nodeCount,
    maxDepth,
    blockNames: [...blockNames].sort((a, b) => a.localeCompare(b)),
    sourceFiles: [...sourceFiles].sort((a, b) => a.localeCompare(b)),
  };
}

export function buildLayoutAnalysisComponentEntry(input: {
  templateName: string;
  componentName: string;
  componentType: 'page' | 'partial';
  dataNeeds: string[];
  planningSource?: PlanningSourceContext;
  sourceCandidates: PlanningSourceCandidate[];
  draftBlockTree?: BlockNode[];
  draftSections?: SectionPlan[];
  visualPlan?: ComponentVisualPlan;
  reason: string;
}): LayoutAnalysisComponentEntry {
  const sectionTypes = (input.visualPlan?.sections ?? []).map(
    (section) => section.type,
  );
  const renderAuthority = getVisualPlanRenderAuthority(input.visualPlan);
  const canLockDeterministic =
    shouldProtectDeterministicStructureFromAi(input.visualPlan) &&
    !!input.draftBlockTree?.length;

  return {
    templateName: input.templateName,
    componentName: input.componentName,
    componentType: input.componentType,
    sourceFile: input.planningSource?.sourceFile,
    dataNeeds: input.dataNeeds,
    canLockDeterministic,
    deterministicConfidence:
      canLockDeterministic && input.draftBlockTree?.length ? 1 : 0,
    reason: input.reason,
    renderMode: input.visualPlan?.renderMode,
    deterministicAuthority: input.visualPlan?.deterministicAuthority,
    renderAuthority,
    lockPolicy: input.visualPlan?.lockPolicy,
    planningSource: input.planningSource
      ? {
          label: input.planningSource.sourceLabel,
          templateName: input.planningSource.sourceTemplateName,
          file: input.planningSource.sourceFile,
          reason: input.planningSource.sourceReason,
          analysis: input.planningSource.sourceAnalysis,
        }
      : undefined,
    sourceCandidates: toLayoutAnalysisSourceCandidates(input.sourceCandidates),
    blockTreeSummary: summarizeBlockTree(input.draftBlockTree),
    draftBlockTree: input.draftBlockTree,
    draftSections: input.draftSections,
    visualPlan: input.visualPlan
      ? {
          renderMode: input.visualPlan.renderMode,
          deterministicAuthority: input.visualPlan.deterministicAuthority,
          renderAuthority,
          lockPolicy: input.visualPlan.lockPolicy,
          sectionTypes,
          sections: input.visualPlan.sections,
        }
      : undefined,
  };
}

function buildThemeSummary(input: {
  parserType: 'classic' | 'fse';
  manifest?: RepoThemeManifest;
  resolvedSource?: RepoResolvedSourceSummary;
}): LayoutAnalysisArtifact['theme'] {
  return {
    parserType: input.parserType,
    detectedThemeKind: input.manifest?.themeTypeHints.detectedThemeKind,
    themeSlug: input.manifest?.themeTypeHints.themeSlug,
    activeThemeSlug: input.resolvedSource?.activeTheme.slug,
    parentThemeSlug: input.resolvedSource?.parentTheme?.slug,
  };
}

function buildContentSummary(
  content: DbContentResult,
): LayoutAnalysisArtifact['contentSummary'] {
  return {
    menus: content.menus.length,
    dbNavigations: content.dbNavigations.length,
    dbTemplates: content.dbTemplates.length,
    pages: content.pages.length,
    posts: content.posts.length,
  };
}
