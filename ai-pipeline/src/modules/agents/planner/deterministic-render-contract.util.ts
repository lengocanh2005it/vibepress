import type { BlockNode } from '../../../common/utils/wp-node-to-block-tree.js';
import type {
  BlockStyleToken,
  ColorPalette,
  ComponentVisualPlan,
  LayoutTokens,
  SectionPlan,
  TypographyTokens,
} from '../react-generator/visual-plan.schema.js';
import {
  getVisualPlanRenderAuthority,
  shouldProtectDeterministicStructureFromAi,
} from '../react-generator/visual-plan.schema.js';
import type { ComponentRenderContract } from './render-contract.schema.js';

export interface DeterministicRenderContractArtifact {
  version: 1;
  scope: 'deterministic-render-contract-v1';
  generatedAt: string;
  deterministicComponents: string[];
  pixelLockedComponents: string[];
  components: DeterministicRenderContractComponent[];
}

export interface DeterministicRenderContractComponent {
  componentName: string;
  templateName: string;
  componentType: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  fixedSlug?: string;
  renderMode?: ComponentVisualPlan['renderMode'];
  deterministicAuthority?: boolean;
  renderAuthority: ReturnType<typeof getVisualPlanRenderAuthority>;
  lockPolicy?: ComponentVisualPlan['lockPolicy'];
  planningSourceLabel?: string;
  planningSourceReason?: string;
  planningSourceFile?: string;
  palette: ColorPalette;
  typography: TypographyTokens;
  layout: LayoutTokens;
  blockStyles?: Record<string, BlockStyleToken>;
  sections: SectionPlan[];
  blockTree?: BlockNode[];
  renderContract?: ComponentRenderContract;
}

export interface DeterministicRenderContractPlanLike {
  componentName: string;
  templateName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  fixedSlug?: string;
  planningSourceLabel?: string;
  planningSourceReason?: string;
  planningSourceFile?: string;
  visualPlan?: ComponentVisualPlan;
  renderContract?: ComponentRenderContract;
}

export function buildDeterministicRenderContractArtifact(
  plan: DeterministicRenderContractPlanLike[],
): DeterministicRenderContractArtifact {
  const components = plan
    .filter((component) =>
      shouldProtectDeterministicStructureFromAi(component.visualPlan),
    )
    .map((component) => toDeterministicContractComponent(component));

  return {
    version: 1,
    scope: 'deterministic-render-contract-v1',
    generatedAt: new Date().toISOString(),
    deterministicComponents: components.map(
      (component) => component.componentName,
    ),
    pixelLockedComponents: components
      .filter(
        (component) => component.renderAuthority === 'deterministic-pixel',
      )
      .map((component) => component.componentName),
    components,
  };
}

function toDeterministicContractComponent(
  component: DeterministicRenderContractPlanLike,
): DeterministicRenderContractComponent {
  const visualPlan = component.visualPlan;
  if (!visualPlan) {
    throw new Error(
      `Cannot build deterministic render contract for "${component.componentName}" without a visualPlan.`,
    );
  }

  return {
    componentName: component.componentName,
    templateName: component.templateName,
    componentType: component.type,
    route: component.route,
    dataNeeds: [...component.dataNeeds],
    ...(component.fixedSlug ? { fixedSlug: component.fixedSlug } : {}),
    renderMode: visualPlan.renderMode,
    deterministicAuthority: visualPlan.deterministicAuthority,
    renderAuthority: getVisualPlanRenderAuthority(visualPlan),
    lockPolicy: visualPlan.lockPolicy,
    planningSourceLabel: component.planningSourceLabel,
    planningSourceReason: component.planningSourceReason,
    planningSourceFile: component.planningSourceFile,
    palette: visualPlan.palette,
    typography: visualPlan.typography,
    layout: visualPlan.layout,
    blockStyles: visualPlan.blockStyles,
    sections: visualPlan.sections,
    blockTree:
      component.renderContract?.sourceModel.blockTree ?? visualPlan.blockTree,
    ...(component.renderContract
      ? { renderContract: component.renderContract }
      : {}),
  };
}
