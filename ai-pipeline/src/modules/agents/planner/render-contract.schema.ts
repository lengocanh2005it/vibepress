import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type { SectionPlan } from '../react-generator/visual-plan.schema.js';

export type RenderContractMode = 'block-tree' | 'hybrid' | 'fallback-section';

export interface RenderContractSubtreeBinding {
  nodeId: string;
  blockName: string;
  renderer: string;
  preserveWrapper: boolean;
  preserveChildrenOrder: boolean;
  childCount: number;
  sourceFile?: string;
}

export interface RenderContractPreserveRules {
  requireFullNodeCoverage: boolean;
  preserveClassNames: boolean;
  preserveSpacing: boolean;
  preserveTypography: boolean;
  preserveColors: boolean;
  preserveAlignWideFull: boolean;
}

export interface RenderContractFallback {
  reason: string;
  sectionTypes?: string[];
  sections?: SectionPlan[];
}

export interface ComponentRenderContract {
  version: 1;
  sourceModel: {
    kind: 'block-tree';
    blockTree: BlockNode[];
    sourceSummary?: string;
    sourceFile?: string;
    templateName?: string;
  };
  structure: {
    renderMode: RenderContractMode;
    sharedChrome: {
      headerOwnedBy?: string;
      footerOwnedBy?: string;
      sidebarOwnedBy?: string;
    };
    subtreeBindings: RenderContractSubtreeBinding[];
  };
  preserveRules: RenderContractPreserveRules;
  fallback?: RenderContractFallback;
}

export function isStrictBlockTreeRenderContract(
  contract: ComponentRenderContract | undefined,
): boolean {
  return contract?.structure.renderMode === 'block-tree';
}

export function shouldPreferDeterministicGenerationForRenderContract(
  contract: ComponentRenderContract | undefined,
): boolean {
  return (
    contract?.structure.renderMode === 'block-tree' ||
    contract?.structure.renderMode === 'hybrid'
  );
}

export function shouldBlockAiStructuralRewriteForRenderContract(
  contract: ComponentRenderContract | undefined,
): boolean {
  return contract?.structure.renderMode === 'block-tree';
}

export function buildComponentRenderContract(input: {
  componentName: string;
  templateName: string;
  draftBlockTree?: BlockNode[];
  planningSourceFile?: string;
  planningSourceSummary?: string;
  sectionTypes?: string[];
  fallbackSections?: SectionPlan[];
  visualRenderMode?: string;
  deterministicAuthority?: boolean;
}): ComponentRenderContract | undefined {
  const blockTree = cloneBlockTree(input.draftBlockTree);
  if (!blockTree?.length) return undefined;

  const structureMode = resolveRenderContractMode({
    visualRenderMode: input.visualRenderMode,
    deterministicAuthority: input.deterministicAuthority,
    hasFallbackSections: (input.fallbackSections?.length ?? 0) > 0,
  });
  const subtreeBindings = buildSubtreeBindings(blockTree);
  const fallbackSections = cloneSections(input.fallbackSections);

  return {
    version: 1,
    sourceModel: {
      kind: 'block-tree',
      blockTree,
      sourceSummary: input.planningSourceSummary,
      sourceFile: input.planningSourceFile,
      templateName: input.templateName,
    },
    structure: {
      renderMode: structureMode,
      sharedChrome: buildSharedChromeOwnership(input.componentName),
      subtreeBindings,
    },
    preserveRules: {
      requireFullNodeCoverage: true,
      preserveClassNames: true,
      preserveSpacing: true,
      preserveTypography: true,
      preserveColors: true,
      preserveAlignWideFull: true,
    },
    ...(fallbackSections?.length
      ? {
          fallback: {
            reason:
              structureMode === 'fallback-section'
                ? 'No stable block-centric renderer path was confirmed; section fallback remains available.'
                : 'Section fallback retained only as a derived compatibility view over the canonical block tree.',
            ...(input.sectionTypes?.length
              ? { sectionTypes: [...input.sectionTypes] }
              : {}),
            sections: fallbackSections,
          },
        }
      : {}),
  };
}

function resolveRenderContractMode(input: {
  visualRenderMode?: string;
  deterministicAuthority?: boolean;
  hasFallbackSections: boolean;
}): RenderContractMode {
  if (
    input.visualRenderMode === 'block-centric' ||
    input.deterministicAuthority === true
  ) {
    return 'block-tree';
  }
  if (input.hasFallbackSections) {
    return 'hybrid';
  }
  return 'fallback-section';
}

function buildSharedChromeOwnership(
  componentName: string,
): ComponentRenderContract['structure']['sharedChrome'] {
  const normalized = componentName.trim().toLowerCase();
  return {
    ...(normalized.startsWith('header')
      ? { headerOwnedBy: componentName }
      : {}),
    ...(normalized.startsWith('footer')
      ? { footerOwnedBy: componentName }
      : {}),
    ...(normalized.includes('sidebar')
      ? { sidebarOwnedBy: componentName }
      : {}),
  };
}

function buildSubtreeBindings(
  blockTree: BlockNode[],
): RenderContractSubtreeBinding[] {
  const bindings: RenderContractSubtreeBinding[] = [];

  const visit = (node: BlockNode, path: string) => {
    const nodeId = node.sourceRef?.sourceNodeId?.trim() || path;
    bindings.push({
      nodeId,
      blockName: node.blockName,
      renderer: inferRenderer(node),
      preserveWrapper: shouldPreserveWrapper(node),
      preserveChildrenOrder: true,
      childCount: node.children?.length ?? 0,
      ...(node.sourceRef?.sourceFile
        ? { sourceFile: node.sourceRef.sourceFile }
        : {}),
    });
    node.children?.forEach((child, index) =>
      visit(child, `${path}.${index + 1}`),
    );
  };

  blockTree.forEach((node, index) => visit(node, `root.${index + 1}`));
  return bindings;
}

function inferRenderer(node: BlockNode): string {
  const normalized = node.blockName.trim().toLowerCase();
  switch (normalized) {
    case 'core/group':
    case 'core/post-content':
    case 'core/post-template':
      return 'group';
    case 'core/columns':
      return 'columns';
    case 'core/column':
      return 'column';
    case 'core/heading':
      return 'heading';
    case 'core/paragraph':
      return 'paragraph';
    case 'core/image':
      return 'image';
    case 'core/buttons':
      return 'buttons';
    case 'core/button':
      return 'button';
    case 'core/navigation':
    case 'core/navigation-link':
      return 'navigation';
    case 'core/query':
      return 'query';
    case 'core/cover':
      return 'cover';
    case 'core/template-part':
      return 'template-part';
    default:
      return node.kind || 'unsupported';
  }
}

function shouldPreserveWrapper(node: BlockNode): boolean {
  const normalized = node.blockName.trim().toLowerCase();
  return (
    (node.children?.length ?? 0) > 0 ||
    normalized === 'core/group' ||
    normalized === 'core/columns' ||
    normalized === 'core/column' ||
    normalized === 'core/cover' ||
    normalized === 'core/template-part' ||
    normalized === 'core/query'
  );
}

function cloneBlockTree(
  blockTree: BlockNode[] | undefined,
): BlockNode[] | undefined {
  return blockTree?.map((node) => cloneBlockNode(node));
}

function cloneBlockNode(node: BlockNode): BlockNode {
  return {
    ...node,
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(node.customClassNames?.length
      ? { customClassNames: [...node.customClassNames] }
      : {}),
    ...(node.padding ? { padding: { ...node.padding } } : {}),
    ...(node.margin ? { margin: { ...node.margin } } : {}),
    ...(node.typography ? { typography: { ...node.typography } } : {}),
    ...(node.children?.length
      ? { children: node.children.map((child) => cloneBlockNode(child)) }
      : {}),
  };
}

function cloneSections(
  sections: SectionPlan[] | undefined,
): SectionPlan[] | undefined {
  return sections?.map((section) => ({ ...section }));
}
