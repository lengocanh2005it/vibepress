import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import { ThemeProfileRegistry } from '../../theme/profiles/theme-profile.registry.js';
import {
  isProfolioFseAiLockedVisualPlanSurface,
  isProfolioFseDeterministicStructureSurface,
} from '../../theme/profiles/profolio-fse-generation-policy.js';

type SourceFaithfulPageCandidate = {
  componentName?: string;
  type?: 'page' | 'partial';
  templateName?: string;
  planningSourceReason?: string;
  renderContract?: {
    structure?: {
      renderMode?: string;
    };
  };
  visualPlan?: {
    blockTree?: unknown[];
    renderAuthority?: string;
    renderMode?: string;
    deterministicAuthority?: boolean;
    lockPolicy?: {
      bypassAiGeneration?: boolean;
    };
  };
};

const themeProfiles = new ThemeProfileRegistry();

export function shouldPreferSectionAssemblyForFrontPage(input: {
  componentPlan?: SourceFaithfulPageCandidate;
  componentName: string;
}): boolean {
  const templateName = input.componentPlan?.templateName?.toLowerCase() ?? '';
  return (
    templateName === 'front-page' || /^frontpage$/i.test(input.componentName)
  );
}

export function shouldPreferThemeSourceFaithfulDeterministicPage(input: {
  componentPlan?: SourceFaithfulPageCandidate;
  componentName: string;
  repoManifest?: RepoThemeManifest;
}): boolean {
  const { componentPlan, componentName, repoManifest } = input;
  if (componentPlan?.type !== 'page' || !componentPlan.visualPlan) return false;
  if (
    isProfolioFseAiLockedVisualPlanSurface({
      templateName: componentPlan.templateName,
      componentName,
    })
  ) {
    return false;
  }
  if (
    componentPlan.visualPlan.renderAuthority === 'ai' ||
    componentPlan.visualPlan.deterministicAuthority === false
  ) {
    return false;
  }

  const themeSlug = repoManifest?.themeTypeHints?.themeSlug?.trim();
  if (!themeSlug) return false;

  const profile = themeProfiles.resolveFseProfile(themeSlug);
  if (profile.slug !== 'profolio-fse') return false;
  if (profile.sharedChromeMode !== 'block-tree-first') return false;
  if ((componentPlan.visualPlan.blockTree?.length ?? 0) === 0) return false;

  return isProfolioFseDeterministicStructureSurface({
    templateName: componentPlan.templateName,
    componentName,
  });
}

export function shouldForceStrictThemeSourceFaithfulDeterministicPage(input: {
  componentPlan?: SourceFaithfulPageCandidate;
  componentName: string;
}): boolean {
  const { componentPlan, componentName } = input;
  if (componentPlan?.type !== 'page' || !componentPlan.visualPlan) return false;
  if (
    isProfolioFseAiLockedVisualPlanSurface({
      templateName: componentPlan.templateName,
      componentName,
    })
  ) {
    return false;
  }
  if ((componentPlan.visualPlan.blockTree?.length ?? 0) === 0) return false;

  if (
    !isProfolioFseDeterministicStructureSurface({
      templateName: componentPlan.templateName,
      componentName,
    })
  ) {
    return false;
  }

  return (
    componentPlan.visualPlan.renderAuthority === 'deterministic-pixel' ||
    componentPlan.visualPlan.renderMode === 'block-centric' ||
    componentPlan.visualPlan.lockPolicy?.bypassAiGeneration === true ||
    componentPlan.renderContract?.structure?.renderMode === 'block-tree'
  );
}

export function shouldRegenerateThemeSourceFaithfulDeterministicPage(input: {
  componentPlan?: SourceFaithfulPageCandidate;
  componentName: string;
}): boolean {
  if (
    !shouldForceStrictThemeSourceFaithfulDeterministicPage({
      componentPlan: input.componentPlan,
      componentName: input.componentName,
    })
  ) {
    return false;
  }

  return (
    input.componentPlan?.planningSourceReason ===
    'block-tree deterministic visual plan path'
  );
}
