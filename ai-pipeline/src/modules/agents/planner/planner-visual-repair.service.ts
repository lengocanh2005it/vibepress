import { Injectable, Logger } from '@nestjs/common';
import { buildEditRequestContextNote } from '../../edit-request/edit-request-prompt.util.js';
import type { PipelineEditRequestDto } from '../../orchestrator/orchestrator.dto.js';
import type { DbContentResult } from '../db-content/db-content.service.js';
import type { ThemeTokens } from '../block-parser/block-parser.service.js';
import {
  buildVisualPlanPrompt,
  extractStaticImageSources,
  parseVisualPlanDetailed,
  type VisualPlanContract,
} from '../react-generator/prompts/visual-plan.prompt.js';
import {
  extractAuxiliaryLabelsFromSections,
  mergeAuxiliaryLabels,
} from '../react-generator/auxiliary-section.guard.js';
import type { RepoThemeManifest } from '../repo-analyzer/repo-analyzer.service.js';
import type {
  ColorPalette,
  ComponentVisualPlan,
  DataNeed,
  LayoutTokens,
  SectionPlan,
  TypographyTokens,
} from '../react-generator/visual-plan.schema.js';

export interface PlannerComponentPlanLike {
  templateName: string;
  componentName: string;
  type: 'page' | 'partial';
  route: string | null;
  dataNeeds: string[];
  isDetail: boolean;
  description: string;
  fixedSlug?: string;
  fixedPageId?: number | string;
  fixedTitle?: string;
}

export interface PlanningSourceCandidate {
  source: string;
  label: string;
  reason: string;
  templateName?: string;
  sourceFile?: string;
  priority: number;
  richness: number;
  selectionScore?: number;
}

export interface PlanningSourceSupplement {
  source: string;
  label: string;
  reason?: string;
  templateName?: string;
  sourceFile?: string;
}

export interface PlanningSourceContext {
  source: string;
  sourceAnalysis: string;
  sourceBackedAuxiliaryLabels: string[];
  supplementalSources?: PlanningSourceSupplement[];
  sourceLabel?: string;
  sourceTemplateName?: string;
  sourceFile?: string;
  sourceReason?: string;
}

export interface PlannerPageEvidence {
  id: number | string;
  title: string;
  slug?: string | null;
  content: string;
}

export interface PlannerVisualPlanRepairState {
  planningSource: PlanningSourceContext;
  draftSections?: SectionPlan[];
  detectedCustomClassNames: string[];
  sourceBackedAuxiliaryLabels: string[];
  sourceWidgetHints: string[];
  allowedImageSrcs: string[];
  visualContract: VisualPlanContract;
}

export interface PlannerVisualRepairDelegate {
  buildPlanningSourceCandidates(
    componentPlan: PlannerComponentPlanLike,
    templateSource: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    repoManifest?: RepoThemeManifest,
  ): PlanningSourceCandidate[];
  buildPlanningSourceContext(
    componentPlan: PlannerComponentPlanLike,
    templateSource: string,
    sourceMap: Map<string, string>,
    content: DbContentResult,
    hasSharedLayoutPartials: boolean,
    repoManifest?: RepoThemeManifest,
  ): PlanningSourceContext;
  buildPlanningSourceContextFromResolvedSource(
    componentPlan: PlannerComponentPlanLike,
    preferredSource: PlanningSourceCandidate,
    hasSharedLayoutPartials: boolean,
  ): PlanningSourceContext;
  buildDraftSectionsForPlanningSource(
    planningSource: PlanningSourceContext | undefined,
    componentPlan: PlannerComponentPlanLike,
    tokens: ThemeTokens | undefined,
  ): SectionPlan[] | undefined;
  collectDraftCustomClassNames(draftSections?: SectionPlan[]): string[];
  detectInteractiveWidgetsFromSource(source: string): string[];
  extractHeadingTextsFromSource(source: string): string[];
  countDraftSectionsInSource(source: string): number;
  scorePlanningSourceRichness(source: string): number;
  findRepresentativePagesForTemplate(
    componentPlan: PlannerComponentPlanLike,
    content: DbContentResult,
  ): PlannerPageEvidence[];
  collectAllowedImageSrcs(
    planningSource: string,
    content: DbContentResult,
  ): string[];
  requestVisualPlanCompletion(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  isRetryableVisualPlanError(error: unknown): boolean;
  delay(ms: number): Promise<void>;
  trackVisualPlanTokens(input: {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    label: string;
  }): Promise<void>;
  deriveComponentLayout(
    tokens: ThemeTokens | undefined,
    componentName: string,
  ): LayoutTokens;
  mergeDraftSectionPresentation(
    sections: SectionPlan[],
    draftSections?: SectionPlan[],
    contract?: VisualPlanContract,
  ): SectionPlan[];
}

interface VisualPlanFailureDiagnosis {
  summary: string;
  categories: string[];
  focusWidgets: string[];
  shouldRefreshSource: boolean;
  shouldRunBestEffortRepair: boolean;
}

interface PreparedRepairContext {
  diagnosis: VisualPlanFailureDiagnosis;
  state: PlannerVisualPlanRepairState;
  previousSourceLabel?: string;
  sourceChanged: boolean;
  investigationContext: string;
  repairNote: string;
}

@Injectable()
export class PlannerVisualRepairService {
  private readonly logger = new Logger(PlannerVisualRepairService.name);
  private readonly rawOutputDivider = '\n----- RAW OUTPUT BEGIN -----\n';

  shouldAttemptSelfHeal(reason: string, dropped = '', raw = ''): boolean {
    const combined = `${reason} ${dropped} ${raw}`.trim();
    return combined.length > 0;
  }

  prepareAttemptTwoRepair(input: {
    componentPlan: PlannerComponentPlanLike;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    repoManifest: RepoThemeManifest | undefined;
    scopedEditRequest: PipelineEditRequestDto | undefined;
    visualDataNeeds: DataNeed[];
    hasSharedLayoutPartials: boolean;
    currentState: PlannerVisualPlanRepairState;
    previousReason: string;
    previousDropped: string;
    previousRaw: string;
    delegate: PlannerVisualRepairDelegate;
  }): {
    state: PlannerVisualPlanRepairState;
    systemPrompt: string;
    userPrompt: string;
    diagnosis: VisualPlanFailureDiagnosis;
    previousSourceLabel?: string;
    sourceChanged: boolean;
  } {
    const prepared = this.prepareRepairContext({
      ...input,
      phaseLabel: 'Phase C attempt 2',
    });
    const promptArtifacts = buildVisualPlanPrompt({
      componentName: input.componentPlan.componentName,
      templateSource: prepared.state.planningSource.source,
      content: input.content,
      tokens: input.tokens,
      repoManifest: input.repoManifest,
      componentType: input.componentPlan.type,
      route: input.componentPlan.route,
      isDetail: input.componentPlan.isDetail,
      dataNeeds: input.visualDataNeeds,
      sourceAnalysis: prepared.state.planningSource.sourceAnalysis,
      sourceBackedAuxiliaryLabels: prepared.state.sourceBackedAuxiliaryLabels,
      sourceWidgetHints: prepared.state.sourceWidgetHints,
      draftSections: prepared.state.draftSections,
      editRequestContextNote: [
        buildEditRequestContextNote(input.scopedEditRequest, {
          audience: 'visual-plan',
          componentName: input.componentPlan.componentName,
          route: input.componentPlan.route,
        }),
        prepared.repairNote,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    return {
      state: prepared.state,
      systemPrompt: promptArtifacts.systemPrompt,
      userPrompt: promptArtifacts.userPrompt,
      diagnosis: prepared.diagnosis,
      previousSourceLabel: prepared.previousSourceLabel,
      sourceChanged: prepared.sourceChanged,
    };
  }

  async investigateAndReplanVisualPlan(input: {
    componentPlan: PlannerComponentPlanLike;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
    repoManifest: RepoThemeManifest | undefined;
    modelName: string;
    scopedEditRequest: PipelineEditRequestDto | undefined;
    visualDataNeeds: DataNeed[];
    hasSharedLayoutPartials: boolean;
    currentState: PlannerVisualPlanRepairState;
    previousReason: string;
    previousDropped: string;
    previousRaw: string;
    delegate: PlannerVisualRepairDelegate;
  }): Promise<{
    visualPlan?: ComponentVisualPlan;
    state: PlannerVisualPlanRepairState;
    lastReason: string;
    lastDropped: string;
    lastRaw: string;
  }> {
    const prepared = this.prepareRepairContext({
      ...input,
      phaseLabel: 'Phase C.5 Investigate/Replan',
    });
    const promptArtifacts = buildVisualPlanPrompt({
      componentName: input.componentPlan.componentName,
      templateSource: prepared.state.planningSource.source,
      content: input.content,
      tokens: input.tokens,
      repoManifest: input.repoManifest,
      componentType: input.componentPlan.type,
      route: input.componentPlan.route,
      isDetail: input.componentPlan.isDetail,
      dataNeeds: input.visualDataNeeds,
      sourceAnalysis: prepared.state.planningSource.sourceAnalysis,
      sourceBackedAuxiliaryLabels: prepared.state.sourceBackedAuxiliaryLabels,
      sourceWidgetHints: prepared.state.sourceWidgetHints,
      draftSections: prepared.state.draftSections,
      editRequestContextNote: [
        buildEditRequestContextNote(input.scopedEditRequest, {
          audience: 'visual-plan',
          componentName: input.componentPlan.componentName,
          route: input.componentPlan.route,
        }),
        prepared.repairNote,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });

    this.logger.log(
      `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" diagnosis: ${prepared.diagnosis.summary}`,
    );
    if (prepared.sourceChanged) {
      this.logger.log(
        `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" investigating source ${prepared.previousSourceLabel ?? 'unknown'} -> ${prepared.state.planningSource.sourceLabel ?? 'unknown'}`,
      );
    }

    let lastRaw = input.previousRaw;
    let lastReason = input.previousReason;
    let lastDropped = input.previousDropped;

    const firstPass = await this.requestAndParseVisualPlan({
      componentPlan: input.componentPlan,
      tokens: input.tokens,
      globalPalette: input.globalPalette,
      globalTypography: input.globalTypography,
      modelName: input.modelName,
      systemPrompt: promptArtifacts.systemPrompt,
      userPrompt: promptArtifacts.userPrompt,
      repairState: prepared.state,
      tokenLabel: `${input.componentPlan.componentName}:visual-plan:c5-replan`,
      phaseLabel: 'Phase C.5: Investigate/Replan',
      delegate: input.delegate,
    });
    lastRaw = firstPass.raw;
    if (firstPass.visualPlan) {
      this.logger.log(
        `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" replan succeeded with ${firstPass.visualPlan.sections.length} sections`,
      );
      return {
        visualPlan: firstPass.visualPlan,
        state: prepared.state,
        lastReason: '',
        lastDropped: '',
        lastRaw,
      };
    }

    lastReason = firstPass.reason;
    lastDropped = firstPass.dropped;
    this.logger.warn(
      `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" replan pass failed: ${lastReason}${lastDropped} — attempting strict repair`,
    );

    const strictRepairPrompt = this.buildStrictRetryPrompt({
      componentPlan: input.componentPlan,
      sourceMap: input.sourceMap,
      content: input.content,
      state: prepared.state,
      reason: `${lastReason}${lastDropped}`,
      badRaw: lastRaw,
      investigationContext: prepared.investigationContext,
      diagnosis: prepared.diagnosis,
    });
    const secondPass = await this.requestAndParseVisualPlan({
      componentPlan: input.componentPlan,
      tokens: input.tokens,
      globalPalette: input.globalPalette,
      globalTypography: input.globalTypography,
      modelName: input.modelName,
      systemPrompt: promptArtifacts.systemPrompt,
      userPrompt: strictRepairPrompt,
      repairState: prepared.state,
      tokenLabel: `${input.componentPlan.componentName}:visual-plan:c5-repair`,
      phaseLabel: 'Phase C.5: Investigate/Replan',
      delegate: input.delegate,
    });
    lastRaw = secondPass.raw;
    if (secondPass.visualPlan) {
      this.logger.log(
        `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" strict repair succeeded with ${secondPass.visualPlan.sections.length} sections ${this.formatSectionList(secondPass.visualPlan.sections)}`,
      );
      return {
        visualPlan: secondPass.visualPlan,
        state: prepared.state,
        lastReason: '',
        lastDropped: '',
        lastRaw,
      };
    }

    lastReason = secondPass.reason;
    lastDropped = secondPass.dropped;
    this.logger.warn(
      `[Phase C.5: Investigate/Replan] "${input.componentPlan.componentName}" replan failed: ${lastReason}${lastDropped}${this.formatRawOutput(lastRaw)}`,
    );
    return {
      state: prepared.state,
      lastReason,
      lastDropped,
      lastRaw,
    };
  }

  assessAcceptedVisualPlanQuality(
    visualPlan: ComponentVisualPlan,
    repairState: PlannerVisualPlanRepairState,
  ): string[] {
    return this.assessRepairQuality(visualPlan, repairState);
  }

  private prepareRepairContext(input: {
    componentPlan: PlannerComponentPlanLike;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    repoManifest?: RepoThemeManifest;
    visualDataNeeds: DataNeed[];
    hasSharedLayoutPartials: boolean;
    currentState: PlannerVisualPlanRepairState;
    previousReason: string;
    previousDropped: string;
    previousRaw: string;
    phaseLabel: string;
    delegate: PlannerVisualRepairDelegate;
  }): PreparedRepairContext {
    const diagnosis = this.analyzeFailure(
      input.previousReason,
      input.previousDropped,
      input.previousRaw,
    );
    const chosenCandidate = diagnosis.shouldRefreshSource
      ? this.pickInvestigativePlanningSource({
          componentPlan: input.componentPlan,
          sourceMap: input.sourceMap,
          content: input.content,
          repoManifest: input.repoManifest,
          currentPlanningSource: input.currentState.planningSource,
          diagnosis,
          delegate: input.delegate,
        })
      : null;
    const previousSourceLabel = input.currentState.planningSource.sourceLabel;
    const planningSource = chosenCandidate
      ? input.delegate.buildPlanningSourceContextFromResolvedSource(
          input.componentPlan,
          chosenCandidate,
          input.hasSharedLayoutPartials,
        )
      : input.delegate.buildPlanningSourceContext(
          input.componentPlan,
          input.currentState.planningSource.source,
          input.sourceMap,
          input.content,
          input.hasSharedLayoutPartials,
          input.repoManifest,
        );

    const state = this.buildRepairState({
      componentPlan: input.componentPlan,
      content: input.content,
      tokens: input.tokens,
      visualDataNeeds: input.visualDataNeeds,
      planningSource,
      delegate: input.delegate,
    });
    const investigationContext = this.buildVisualPlanRetryInvestigationContext({
      componentPlan: input.componentPlan,
      planningSource,
      sourceMap: input.sourceMap,
      content: input.content,
      repoManifest: input.repoManifest,
      draftSections: state.draftSections,
      sourceWidgetHints: state.sourceWidgetHints,
      allowedImageSrcs: state.allowedImageSrcs,
      diagnosis,
      delegate: input.delegate,
    });
    const preview = input.previousRaw.slice(0, 700);
    const repairNote = [
      `${input.phaseLabel} is active because the previous visual plan failed.`,
      `Failure diagnosis: ${diagnosis.summary}`,
      `Previous failure: ${input.previousReason}${input.previousDropped}`,
      preview
        ? `Start of previous response:\n\`\`\`\n${preview}${input.previousRaw.length > 700 ? '\n... (truncated)' : ''}\n\`\`\``
        : '',
      this.buildSpecificCorrectionRules(diagnosis, preview),
      investigationContext,
      'Use the refreshed evidence below to repair the plan. Preserve every source-backed section and rebuild missing structure instead of repeating the failed output.',
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      diagnosis,
      state,
      previousSourceLabel,
      sourceChanged:
        Boolean(chosenCandidate) &&
        planningSource.sourceLabel !==
          input.currentState.planningSource.sourceLabel,
      investigationContext,
      repairNote,
    };
  }

  private buildRepairState(input: {
    componentPlan: PlannerComponentPlanLike;
    content: DbContentResult;
    tokens: ThemeTokens | undefined;
    visualDataNeeds: DataNeed[];
    planningSource: PlanningSourceContext;
    delegate: PlannerVisualRepairDelegate;
  }): PlannerVisualPlanRepairState {
    const draftSections = input.delegate.buildDraftSectionsForPlanningSource(
      input.planningSource,
      input.componentPlan,
      input.tokens,
    );
    const detectedCustomClassNames =
      input.delegate.collectDraftCustomClassNames(draftSections);
    const sourceBackedAuxiliaryLabels = mergeAuxiliaryLabels(
      input.planningSource.sourceBackedAuxiliaryLabels,
      extractAuxiliaryLabelsFromSections(draftSections),
    );
    const sourceWidgetHints = input.delegate.detectInteractiveWidgetsFromSource(
      input.planningSource.source,
    );
    const allowedImageSrcs = input.delegate.collectAllowedImageSrcs(
      input.planningSource.source,
      input.content,
    );
    const visualContract: VisualPlanContract = {
      componentType: input.componentPlan.type,
      route: input.componentPlan.route,
      isDetail: input.componentPlan.isDetail,
      dataNeeds: input.visualDataNeeds,
      stripLayoutChrome: input.componentPlan.type === 'page',
      sourceBackedAuxiliaryLabels,
      requiredSourceWidgets: sourceWidgetHints,
    };
    return {
      planningSource: input.planningSource,
      draftSections,
      detectedCustomClassNames,
      sourceBackedAuxiliaryLabels,
      sourceWidgetHints,
      allowedImageSrcs,
      visualContract,
    };
  }

  private analyzeFailure(
    reason: string,
    dropped: string,
    raw = '',
  ): VisualPlanFailureDiagnosis {
    const combined = `${reason} ${dropped} ${raw}`.toLowerCase();
    const categories: string[] = [];
    const focusWidgets: string[] = [];
    const pushCategory = (value: string) => {
      if (!categories.includes(value)) categories.push(value);
    };
    const pushWidget = (value: string) => {
      if (!focusWidgets.includes(value)) focusWidgets.push(value);
    };

    if (
      /source contains .* but output has no .* section/.test(combined) ||
      /visual plan obligations violated/.test(combined)
    ) {
      pushCategory('missing-sections');
    }
    if (/imagesrc|required image|allowed image/.test(combined)) {
      pushCategory('image-resolution');
    }
    if (
      /non-empty array|must include|required|invalid|unexpected|malformed/.test(
        combined,
      )
    ) {
      pushCategory('schema-shape');
    }
    if (/json|markdown fences|parse failure|valid json/.test(combined)) {
      pushCategory('json-format');
    }
    if (
      /lost |droppedsections|preserve every source-backed section/.test(
        combined,
      )
    ) {
      pushCategory('content-drop');
    }
    if (/contract|route|detail|dataneeds|chrome/.test(combined)) {
      pushCategory('contract-mismatch');
    }
    if (
      /timeout|502|429|request failed|processing your request/.test(combined)
    ) {
      pushCategory('transport');
    }

    if (/carousel|slider/.test(combined)) pushWidget('carousel');
    if (/modal|popup|dialog/.test(combined)) pushWidget('modal');
    if (/accordion|faq|toggle/.test(combined)) pushWidget('accordion');
    if (/tabs?/.test(combined)) pushWidget('tabs');
    if (/hero/.test(combined)) pushWidget('hero');
    if (/media-text/.test(combined)) pushWidget('media-text');
    if (/card-grid|card heading|card subtitle/.test(combined))
      pushWidget('card-grid');
    if (/post-list|post list/.test(combined)) pushWidget('post-list');

    if (categories.length === 0) {
      pushCategory('unknown');
    }

    return {
      summary: categories.join(', '),
      categories,
      focusWidgets,
      shouldRefreshSource:
        categories.some((item) =>
          [
            'missing-sections',
            'image-resolution',
            'content-drop',
            'unknown',
          ].includes(item),
        ) || focusWidgets.length > 0,
      shouldRunBestEffortRepair: true,
    };
  }

  private pickInvestigativePlanningSource(input: {
    componentPlan: PlannerComponentPlanLike;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    repoManifest?: RepoThemeManifest;
    currentPlanningSource?: PlanningSourceContext;
    diagnosis: VisualPlanFailureDiagnosis;
    delegate: PlannerVisualRepairDelegate;
  }): PlanningSourceCandidate | null {
    const candidates = input.delegate.buildPlanningSourceCandidates(
      input.componentPlan,
      input.currentPlanningSource?.source ?? '',
      input.sourceMap,
      input.content,
      input.repoManifest,
    );
    if (candidates.length === 0) return null;

    const ranked = candidates
      .map((candidate) => {
        const widgets = new Set(
          input.delegate.detectInteractiveWidgetsFromSource(candidate.source),
        );
        const headings = input.delegate.extractHeadingTextsFromSource(
          candidate.source,
        ).length;
        const imageCount = extractStaticImageSources(candidate.source).length;
        const sectionCount = input.delegate.countDraftSectionsInSource(
          candidate.source,
        );
        let score = candidate.richness + candidate.priority;

        for (const widget of input.diagnosis.focusWidgets) {
          if (widgets.has(widget)) score += 140;
        }
        if (input.diagnosis.categories.includes('image-resolution')) {
          score += imageCount * 24;
        }
        if (input.diagnosis.categories.includes('content-drop')) {
          score += sectionCount * 18;
          score += headings * 6;
        }
        if (input.diagnosis.categories.includes('unknown')) {
          score += headings * 5;
          score += sectionCount * 10;
        }
        if (candidate.label === input.currentPlanningSource?.sourceLabel) {
          score -= 50;
        }
        if (candidate.source === input.currentPlanningSource?.source) {
          score -= 50;
        }
        return { candidate, score };
      })
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.candidate ?? null;
  }

  private buildVisualPlanRetryInvestigationContext(input: {
    componentPlan: PlannerComponentPlanLike;
    planningSource?: PlanningSourceContext;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    repoManifest?: RepoThemeManifest;
    draftSections?: SectionPlan[];
    sourceWidgetHints: string[];
    allowedImageSrcs: string[];
    diagnosis: VisualPlanFailureDiagnosis;
    delegate: PlannerVisualRepairDelegate;
  }): string {
    const lines: string[] = ['## Retry Investigation Context'];

    if (input.planningSource?.sourceLabel) {
      lines.push(`Selected source label: ${input.planningSource.sourceLabel}`);
    }
    if (input.planningSource?.sourceReason) {
      lines.push(
        `Selected source reason: ${input.planningSource.sourceReason}`,
      );
    }
    lines.push(`Failure categories: ${input.diagnosis.categories.join(', ')}`);
    if (input.sourceWidgetHints.length > 0) {
      lines.push(
        `Required source widgets: ${input.sourceWidgetHints.join(', ')}`,
      );
    }

    const candidateLines = this.buildRetrySourceCandidateEvidence(input);
    if (candidateLines.length > 0) {
      lines.push('Additional source candidates reviewed:');
      lines.push(...candidateLines.map((line) => `- ${line}`));
    }

    const draftLines = this.buildRetryDraftEvidence(
      input.draftSections,
      input.diagnosis,
    );
    if (draftLines.length > 0) {
      lines.push('Deterministic draft evidence:');
      lines.push(...draftLines.map((line) => `- ${line}`));
    }

    const dbLines = this.buildRetryDbEvidence(input);
    if (dbLines.length > 0) {
      lines.push('DB evidence reviewed:');
      lines.push(...dbLines.map((line) => `- ${line}`));
    }

    const imageLines = input.allowedImageSrcs
      .slice(0, 15)
      .map((src) => `allowed image: ${src}`);
    if (imageLines.length > 0) {
      lines.push('Validated static image pool:');
      lines.push(...imageLines.map((line) => `- ${line}`));
    }

    const snippetLines = this.buildRetryWidgetSnippetEvidence(
      input.planningSource?.source ?? '',
      input.sourceWidgetHints,
    );
    if (snippetLines.length > 0) {
      lines.push('Relevant widget/source snippets:');
      lines.push(...snippetLines.map((line) => `- ${line}`));
    }

    lines.push(
      'Use this investigation context to correct the JSON now. You may revise section types, restore missing source-backed widgets, query richer DB-like evidence provided above, and prefer richer repo/DB evidence over the failed first attempt.',
    );

    return lines.join('\n');
  }

  private buildRetrySourceCandidateEvidence(input: {
    componentPlan: PlannerComponentPlanLike;
    planningSource?: PlanningSourceContext;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    repoManifest?: RepoThemeManifest;
    delegate: PlannerVisualRepairDelegate;
  }): string[] {
    const candidates = input.delegate
      .buildPlanningSourceCandidates(
        input.componentPlan,
        input.planningSource?.source ?? '',
        input.sourceMap,
        input.content,
        input.repoManifest,
      )
      .filter(
        (candidate) => candidate.label !== input.planningSource?.sourceLabel,
      )
      .slice(0, 3);

    return candidates.map((candidate) => {
      const widgets = input.delegate.detectInteractiveWidgetsFromSource(
        candidate.source,
      );
      const headings = input.delegate.extractHeadingTextsFromSource(
        candidate.source,
      );
      const imageCount = extractStaticImageSources(candidate.source).length;
      return `${candidate.label} | score=${candidate.richness} | widgets=${widgets.join(', ') || 'none'} | images=${imageCount} | headings=${headings.slice(0, 3).join(' | ') || 'none'}`;
    });
  }

  private formatSectionList(
    sections: Array<Pick<SectionPlan, 'type' | 'sectionKey' | 'debugKey'>>,
  ): string {
    if (!Array.isArray(sections) || sections.length === 0) return '[]';

    const seen = new Map<string, number>();
    const labels = sections.map((section, index) => {
      const base =
        section.debugKey?.trim() ||
        section.sectionKey?.trim() ||
        section.type?.trim() ||
        `section-${index + 1}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return count > 1 ? `${base}#${count}` : base;
    });

    return `[${labels.join(', ')}]`;
  }

  private buildRetryDraftEvidence(
    draftSections: SectionPlan[] | undefined,
    diagnosis: VisualPlanFailureDiagnosis,
  ): string[] {
    if (!draftSections?.length) return [];

    const focusTypes = new Set<string>(diagnosis.focusWidgets);
    const relevant =
      focusTypes.size > 0
        ? draftSections.filter((section) => focusTypes.has(section.type))
        : draftSections.slice(0, 8);

    return relevant.slice(0, 8).map((section, index) => {
      const identity = `${section.type}${(section.debugKey ?? section.sectionKey) ? `:${section.debugKey ?? section.sectionKey}` : ''}`;
      switch (section.type) {
        case 'carousel':
          return `${identity} | slides=${section.slides.length}`;
        case 'modal':
          return `${identity} | trigger=${JSON.stringify(section.triggerText ?? '')} | heading=${JSON.stringify(section.heading ?? '')}`;
        case 'tabs':
          return `${identity} | tabs=${section.tabs
            .map((tab) => tab.label)
            .slice(0, 5)
            .join(' | ')}`;
        case 'accordion':
          return `${identity} | items=${section.items
            .map((item) => item.heading)
            .slice(0, 5)
            .join(' | ')}`;
        case 'hero':
          return `${identity} | heading=${JSON.stringify(section.heading ?? '')}`;
        case 'media-text':
          return `${identity} | heading=${JSON.stringify(section.heading ?? '')} | image=${JSON.stringify(section.imageSrc ?? '')}`;
        default:
          return `${identity} | position=${index + 1}`;
      }
    });
  }

  private buildRetryDbEvidence(input: {
    componentPlan: PlannerComponentPlanLike;
    content: DbContentResult;
    diagnosis: VisualPlanFailureDiagnosis;
    delegate: PlannerVisualRepairDelegate;
  }): string[] {
    const pages = input.delegate
      .findRepresentativePagesForTemplate(input.componentPlan, input.content)
      .slice(0, 3);
    const lines: string[] = pages.map((page) => {
      const widgets = input.delegate.detectInteractiveWidgetsFromSource(
        page.content,
      );
      const headings = input.delegate.extractHeadingTextsFromSource(
        page.content,
      );
      return `page:${page.slug || page.id} | title=${JSON.stringify(page.title)} | widgets=${widgets.join(', ') || 'none'} | headings=${headings.slice(0, 4).join(' | ') || 'none'}`;
    });

    if (
      input.componentPlan.route === '/' &&
      input.diagnosis.shouldRefreshSource
    ) {
      const frontPage = input.content.readingSettings?.pageOnFrontId
        ? input.content.pages.find(
            (page) => page.id === input.content.readingSettings?.pageOnFrontId,
          )
        : undefined;
      if (frontPage) {
        lines.unshift(
          `front-page-db:${frontPage.slug || frontPage.id} | title=${JSON.stringify(frontPage.title)} | widgets=${input.delegate.detectInteractiveWidgetsFromSource(frontPage.content).join(', ') || 'none'}`,
        );
      }
    }

    return lines.slice(0, 3);
  }

  private buildRetryWidgetSnippetEvidence(
    source: string,
    widgetHints: string[],
  ): string[] {
    if (!source.trim() || widgetHints.length === 0) return [];

    const patterns = widgetHints.map((hint) => {
      switch (hint) {
        case 'slider':
        case 'carousel':
          return /uagb\/slider[\s\S]{0,220}/gi;
        case 'modal':
          return /uagb\/modal[\s\S]{0,220}/gi;
        case 'tabs':
          return /uagb\/tabs[\s\S]{0,220}/gi;
        case 'accordion':
          return /(accordion|faq|content-toggle|toggle)[\s\S]{0,220}/gi;
        default:
          return null;
      }
    });

    const snippets = new Set<string>();
    for (const pattern of patterns) {
      if (!pattern) continue;
      const matches = source.match(pattern) ?? [];
      for (const match of matches.slice(0, 2)) {
        snippets.add(match.replace(/\s+/g, ' ').trim());
      }
    }
    return [...snippets].slice(0, 5);
  }

  private buildSpecificCorrectionRules(
    diagnosis: VisualPlanFailureDiagnosis,
    preview: string,
  ): string {
    const lines: string[] = ['Specific corrections:'];
    if (diagnosis.focusWidgets.includes('carousel')) {
      lines.push(
        '- The corrected output must include a `carousel` section and preserve the ordered source-backed slides.',
      );
    }
    if (diagnosis.focusWidgets.includes('modal')) {
      lines.push(
        '- The corrected output must include a `modal` section with trigger text and modal content when the source shows a real modal/popup.',
      );
    }
    if (diagnosis.focusWidgets.includes('accordion')) {
      lines.push(
        '- `accordion.items` must be a non-empty array of `{ heading, body }` objects.',
      );
    }
    if (diagnosis.focusWidgets.includes('tabs')) {
      lines.push(
        '- `tabs.tabs` must preserve every source-backed tab label and panel body.',
      );
    }
    if (diagnosis.categories.includes('image-resolution')) {
      lines.push(
        '- Use only image URLs from the validated image pool or the selected source. Do not invent image URLs.',
      );
    }
    if (diagnosis.categories.includes('content-drop')) {
      lines.push(
        '- Do not drop headings, bodies, CTA copy, or source-backed section nodes from the deterministic draft.',
      );
    }
    if (diagnosis.categories.includes('json-format')) {
      lines.push(
        '- Return only a single valid JSON object. No markdown fences, comments, or prose.',
      );
    }
    if (/"cta"/.test(preview) || /label|href/.test(preview)) {
      lines.push(
        '- Use `cta.text` and `cta.link` keys, never `cta.label` or `cta.href`.',
      );
    }
    if (lines.length === 1) {
      lines.push(
        '- Rebuild the visual plan from the selected source and deterministic draft, keeping the approved contract intact.',
      );
    }
    return lines.join('\n');
  }

  private buildStrictRetryPrompt(input: {
    componentPlan: PlannerComponentPlanLike;
    sourceMap: Map<string, string>;
    content: DbContentResult;
    state: PlannerVisualPlanRepairState;
    reason: string;
    badRaw: string;
    investigationContext: string;
    diagnosis: VisualPlanFailureDiagnosis;
  }): string {
    const preview = input.badRaw.slice(0, 700);
    return `Your previous response for component "${input.componentPlan.componentName}" still could not be parsed.

Failure reason: ${input.reason}

Start of previous response:
\`\`\`
${preview}${input.badRaw.length > 700 ? '\n... (truncated)' : ''}
\`\`\`

${this.buildSpecificCorrectionRules(input.diagnosis, preview)}

${input.investigationContext}

Return ONLY a single valid JSON object matching ComponentVisualPlan.
Do not include markdown fences, comments, extra prose, or malformed JSON.`;
  }

  private async requestAndParseVisualPlan(input: {
    componentPlan: PlannerComponentPlanLike;
    tokens: ThemeTokens | undefined;
    globalPalette: ColorPalette;
    globalTypography: TypographyTokens;
    modelName: string;
    systemPrompt: string;
    userPrompt: string;
    repairState: PlannerVisualPlanRepairState;
    tokenLabel: string;
    phaseLabel: string;
    delegate: PlannerVisualRepairDelegate;
  }): Promise<{
    visualPlan?: ComponentVisualPlan;
    raw: string;
    reason: string;
    dropped: string;
  }> {
    const completion = await this.requestVisualPlanCompletionWithRetries({
      componentName: input.componentPlan.componentName,
      modelName: input.modelName,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      tokenLabel: input.tokenLabel,
      phaseLabel: input.phaseLabel,
      delegate: input.delegate,
    });
    const parsedResult = parseVisualPlanDetailed(
      completion.raw,
      input.componentPlan.componentName,
      {
        allowedImageSrcs: input.repairState.allowedImageSrcs,
        contract: input.repairState.visualContract,
        draftSections: input.repairState.draftSections,
      },
    );
    if (parsedResult.plan) {
      const layout = input.delegate.deriveComponentLayout(
        input.tokens,
        input.componentPlan.componentName,
      );
      const mergedSections = input.delegate.mergeDraftSectionPresentation(
        parsedResult.plan.sections,
        input.repairState.draftSections,
        input.repairState.visualContract,
      );
      const candidateVisualPlan: ComponentVisualPlan = {
        ...parsedResult.plan,
        dataNeeds: input.repairState.visualContract.dataNeeds ?? [],
        ...(input.componentPlan.fixedSlug
          ? {
              pageBinding: {
                id: input.componentPlan.fixedPageId,
                slug: input.componentPlan.fixedSlug,
                title: input.componentPlan.fixedTitle,
                route: input.componentPlan.route ?? undefined,
              },
            }
          : {}),
        palette: input.globalPalette,
        typography: input.globalTypography,
        layout,
        blockStyles: input.tokens?.blockStyles,
        sections: mergedSections,
      };
      const qualityIssues = this.assessRepairQuality(
        candidateVisualPlan,
        input.repairState,
      );
      if (qualityIssues.length > 0) {
        return {
          raw: completion.raw,
          reason: `visual plan repair quality gate failed: ${qualityIssues[0]}`,
          dropped: ` | repairQuality: ${qualityIssues.join('; ')}`,
        };
      }
      return {
        visualPlan: candidateVisualPlan,
        raw: completion.raw,
        reason: '',
        dropped: '',
      };
    }

    return {
      raw: completion.raw,
      reason:
        parsedResult.diagnostic?.reason ??
        'unknown visual plan parse failure after self-heal',
      dropped: parsedResult.diagnostic?.droppedSections?.length
        ? ` | droppedSections: ${parsedResult.diagnostic.droppedSections.join('; ')}`
        : '',
    };
  }

  private async requestVisualPlanCompletionWithRetries(input: {
    componentName: string;
    modelName: string;
    systemPrompt: string;
    userPrompt: string;
    tokenLabel: string;
    phaseLabel: string;
    delegate: PlannerVisualRepairDelegate;
  }): Promise<{ raw: string }> {
    let lastTransportError = '';
    const maxTransportRetries = 3;

    for (
      let transportAttempt = 1;
      transportAttempt <= maxTransportRetries;
      transportAttempt++
    ) {
      try {
        if (transportAttempt > 1) {
          this.logger.log(
            `[${input.phaseLabel}] "${input.componentName}" request retry ${transportAttempt}/${maxTransportRetries}`,
          );
        }
        const completion = await input.delegate.requestVisualPlanCompletion({
          model: input.modelName,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          maxTokens: 4096,
        });
        await input.delegate.trackVisualPlanTokens({
          modelName: input.modelName,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          label: input.tokenLabel,
        });
        return { raw: completion.text };
      } catch (err: unknown) {
        lastTransportError = err instanceof Error ? err.message : String(err);
        if (
          !input.delegate.isRetryableVisualPlanError(err) ||
          transportAttempt >= maxTransportRetries
        ) {
          throw err;
        }
        this.logger.warn(
          `[${input.phaseLabel}] "${input.componentName}" transient request error on attempt ${transportAttempt}/${maxTransportRetries}: ${lastTransportError} — retrying`,
        );
        await input.delegate.delay(1200 * transportAttempt);
      }
    }

    throw new Error(
      lastTransportError ||
        'visual plan request failed before a response was received',
    );
  }

  private formatRawOutput(raw: string): string {
    return `${this.rawOutputDivider}${raw || '(empty)'}\n----- RAW OUTPUT END -----`;
  }

  private assessRepairQuality(
    visualPlan: ComponentVisualPlan,
    repairState: PlannerVisualPlanRepairState,
  ): string[] {
    const issues: string[] = [];
    const draftSections = repairState.draftSections ?? [];
    const finalSections = visualPlan.sections;

    if (draftSections.length >= 6) {
      const minimumSectionCount = Math.max(
        4,
        Math.ceil(draftSections.length * 0.7),
      );
      if (finalSections.length < minimumSectionCount) {
        issues.push(
          `section coverage too low (${finalSections.length}/${draftSections.length}); expected at least ${minimumSectionCount} source-backed sections to survive repair`,
        );
      }
    }

    for (const sectionType of [
      'accordion',
      'tabs',
      'carousel',
      'modal',
      'card-grid',
      'testimonial',
      'newsletter',
      'post-list',
    ] as const) {
      const draftCount = draftSections.filter(
        (section) => section.type === sectionType,
      ).length;
      if (draftCount === 0) continue;
      const finalCount = finalSections.filter(
        (section) => section.type === sectionType,
      ).length;
      if (finalCount === 0) {
        issues.push(
          `missing draft-backed ${sectionType} section(s) after repair (${draftCount} expected from deterministic draft)`,
        );
      }
    }

    const draftAccordions = draftSections.filter(
      (section): section is Extract<SectionPlan, { type: 'accordion' }> =>
        section.type === 'accordion',
    );
    const finalAccordions = finalSections.filter(
      (section): section is Extract<SectionPlan, { type: 'accordion' }> =>
        section.type === 'accordion',
    );
    draftAccordions.forEach((draftSection, index) => {
      const repairedSection = finalAccordions[index];
      if (!repairedSection) return;
      if (repairedSection.items.length < draftSection.items.length) {
        issues.push(
          `accordion section ${index + 1} kept only ${repairedSection.items.length}/${draftSection.items.length} FAQ items`,
        );
      }
      const trivialBodies = repairedSection.items.filter((item) =>
        this.isTrivialContentDuplicate(item.heading, item.body),
      );
      if (trivialBodies.length > 0) {
        issues.push(
          `accordion section ${index + 1} has ${trivialBodies.length} item(s) whose body just repeats the heading`,
        );
      }
    });

    const draftCarousels = draftSections.filter(
      (section): section is Extract<SectionPlan, { type: 'carousel' }> =>
        section.type === 'carousel',
    );
    const finalCarousels = finalSections.filter(
      (section): section is Extract<SectionPlan, { type: 'carousel' }> =>
        section.type === 'carousel',
    );
    draftCarousels.forEach((draftSection, index) => {
      const repairedSection = finalCarousels[index];
      if (!repairedSection) return;
      if (repairedSection.slides.length < draftSection.slides.length) {
        issues.push(
          `carousel section ${index + 1} kept only ${repairedSection.slides.length}/${draftSection.slides.length} slides`,
        );
      }
    });

    const draftCardGrids = draftSections.filter(
      (section): section is Extract<SectionPlan, { type: 'card-grid' }> =>
        section.type === 'card-grid',
    );
    const finalCardGrids = finalSections.filter(
      (section): section is Extract<SectionPlan, { type: 'card-grid' }> =>
        section.type === 'card-grid',
    );
    draftCardGrids.forEach((draftSection, index) => {
      const repairedSection = finalCardGrids[index];
      if (!repairedSection) return;
      if (repairedSection.cards.length < draftSection.cards.length) {
        issues.push(
          `card-grid section ${index + 1} kept only ${repairedSection.cards.length}/${draftSection.cards.length} cards`,
        );
      }
      const weakCards = repairedSection.cards.filter(
        (card) =>
          !card.heading?.trim() ||
          !card.body?.trim() ||
          this.isTrivialContentDuplicate(card.heading, card.body),
      );
      if (weakCards.length > 0) {
        issues.push(
          `card-grid section ${index + 1} has ${weakCards.length} weak card(s) with missing or duplicated content`,
        );
      }
    });

    return [...new Set(issues)];
  }

  private isTrivialContentDuplicate(left: string, right: string): boolean {
    const normalizedLeft = this.normalizeSemanticText(left);
    const normalizedRight = this.normalizeSemanticText(right);
    if (!normalizedLeft || !normalizedRight) return false;
    return normalizedLeft === normalizedRight;
  }

  private normalizeSemanticText(value: string): string {
    return String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
}
