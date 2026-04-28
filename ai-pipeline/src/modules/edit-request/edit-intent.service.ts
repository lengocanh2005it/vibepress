import { Injectable, Logger } from '@nestjs/common';
import { LlmFactoryService } from '../../common/llm/llm-factory.service.js';
import type { PipelineEditRequestDto } from '../orchestrator/orchestrator.dto.js';
import type {
  EditExecutionStrategy,
  EditIntentCategory,
  EditIntentDecision,
  EditIntentTargetCandidate,
  EditOperation,
  EditTargetScope,
  ValidatedEditRequest,
} from './edit-request.types.js';
import { detectEditOperation } from './edit-operation.util.js';

@Injectable()
export class EditIntentService {
  private readonly logger = new Logger(EditIntentService.name);

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async evaluate(input: ValidatedEditRequest): Promise<EditIntentDecision> {
    if (input.mode === 'none') {
      return this.buildAcceptedDecision(input, {
        category: 'full_site_migration',
        globalIntent: 'Migrate the full site to React.',
        confidence: 1,
        source: 'heuristic',
      });
    }

    const prompt = input.request?.prompt ?? '';
    const normalized = normalizeText(prompt);

    if (looksOutOfScope(normalized)) {
      return this.buildRejectedDecision(input, {
        rejectionCode: 'OUT_OF_SCOPE',
        userMessage:
          'This prompt does not look like a site migration or UI-focused request.',
        confidence: 0.95,
        source: 'heuristic',
      });
    }

    if (input.mode === 'capture') {
      try {
        return await this.evaluateWithLlm(input);
      } catch (error: unknown) {
        this.logger.warn(
          `Falling back to heuristic capture intent evaluation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.buildBestEffortDecision(input, {
          preferredCategory: 'full_site_migration_with_focus',
          confidence: 0.65,
          source: 'heuristic',
          extraWarnings: [
            'Capture intent classification fell back to heuristics, so the edit flow will rely more heavily on target hints and visual evidence.',
          ],
        });
      }
    }

    if (
      !looksLikeMigrationIntent(normalized) &&
      !looksLikeTargetedComponentEdit(normalized)
    ) {
      return this.buildBestEffortDecision(input, {
        confidence: 0.58,
        source: 'heuristic',
        extraWarnings: [
          'The request is broad or underspecified, so the pipeline will infer the most plausible UI-focused target and strategy.',
        ],
      });
    }

    try {
      return await this.evaluateWithLlm(input);
    } catch (error: unknown) {
      this.logger.warn(
        `Falling back to heuristic no-capture intent evaluation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const instructionText = buildInstructionText(input.request);
    const editOperation = detectEditOperation(instructionText);

    if (
      !looksLikeMigrationIntent(normalized) &&
      looksLikeTargetedComponentEdit(normalized)
    ) {
      return this.buildAcceptedDecision(input, {
        category: 'targeted_component_edit',
        editOperation,
        globalIntent: buildTargetedEditIntent(editOperation, instructionText),
        focusHint: prompt.trim() || firstAttachmentNote(input.request),
        confidence: 0.8,
        source: 'heuristic',
      });
    }

    const category: EditIntentCategory = mentionsFocusTarget(normalized)
      ? 'full_site_migration_with_focus'
      : 'full_site_migration';

    return this.buildAcceptedDecision(input, {
      category,
      editOperation,
      globalIntent:
        category === 'full_site_migration_with_focus'
          ? 'Migrate the full site to React, with extra fidelity on the focused page or area described by the user.'
          : 'Migrate the full site to React.',
      focusHint:
        category === 'full_site_migration_with_focus'
          ? prompt.trim() || firstAttachmentNote(input.request)
          : undefined,
      confidence: 0.7,
      source: 'heuristic',
    });
  }

  private async evaluateWithLlm(
    input: ValidatedEditRequest,
  ): Promise<EditIntentDecision> {
    const prompt = buildIntentClassifierPrompt(input);
    const { text } = await this.llmFactory.chat({
      model: this.llmFactory.getModel(),
      systemPrompt: INTENT_SYSTEM_PROMPT,
      userPrompt: prompt,
      maxTokens: 600,
      temperature: 0,
    });

    const parsed = parseIntentClassifierResponse(text);
    return this.toDecision(input, parsed);
  }

  private toDecision(
    input: ValidatedEditRequest,
    parsed: IntentClassifierResponse,
  ): EditIntentDecision {
    if (!parsed.accepted && parsed.rejectionCode === 'OUT_OF_SCOPE') {
      return this.buildRejectedDecision(input, {
        rejectionCode: 'OUT_OF_SCOPE',
        userMessage:
          parsed.userMessage ??
          'This prompt does not look like a site migration or UI-focused request.',
        confidence: parsed.confidence,
        source: 'llm',
      });
    }

    if (!parsed.accepted) {
      return this.buildBestEffortDecision(input, {
        confidence: parsed.confidence ?? 0.55,
        source: 'llm',
        extraWarnings: parsed.userMessage
          ? [parsed.userMessage]
          : ['LLM intent classification could not resolve a precise category.'],
      });
    }

    const category: EditIntentCategory =
      parsed.category === 'full_site_migration_with_focus'
        ? 'full_site_migration_with_focus'
        : parsed.category === 'targeted_component_edit'
          ? 'targeted_component_edit'
          : 'full_site_migration';

    const instructionText = buildInstructionText(input.request);
    const editOperation =
      asEditOperation(parsed.editOperation) ??
      detectEditOperation(instructionText);

    return this.buildAcceptedDecision(input, {
      category,
      editOperation,
      globalIntent:
        category === 'targeted_component_edit'
          ? buildTargetedEditIntent(editOperation, instructionText)
          : category === 'full_site_migration_with_focus'
            ? 'Migrate the full site to React, with extra fidelity on the focused page or area described by the user.'
            : 'Migrate the full site to React.',
      focusHint:
        parsed.focusHint?.trim() ||
        input.request?.prompt?.trim() ||
        firstAttachmentNote(input.request),
      confidence: parsed.confidence,
      source: 'llm',
      extraWarnings:
        parsed.category === 'invalid' && parsed.userMessage
          ? [parsed.userMessage]
          : [],
    });
  }

  private buildAcceptedDecision(
    input: ValidatedEditRequest,
    options: {
      category: EditIntentCategory;
      globalIntent: string;
      editOperation?: EditOperation;
      focusHint?: string;
      confidence?: number;
      source: 'llm' | 'heuristic';
      extraWarnings?: string[];
    },
  ): EditIntentDecision {
    const analysis = deriveIntentAnalysis({
      request: input.request,
      category: options.category,
      inputWarnings: input.warnings,
      extraWarnings: options.extraWarnings,
      inputNeedsInference: input.needsInference,
      focusHint: options.focusHint,
    });

    return {
      accepted: true,
      mode: input.mode,
      category: options.category,
      editOperation:
        options.editOperation ??
        detectEditOperation(buildInstructionText(input.request)),
      request: input.request,
      globalIntent: options.globalIntent,
      focusHint: analysis.focusHint,
      confidence: options.confidence,
      source: options.source,
      warnings: analysis.warnings,
      needsInference: analysis.needsInference,
      targetScope: analysis.targetScope,
      targetCandidates: analysis.targetCandidates,
      inferredAssumptions: analysis.inferredAssumptions,
      ambiguities: analysis.ambiguities,
      recommendedStrategy: analysis.recommendedStrategy,
    };
  }

  private buildBestEffortDecision(
    input: ValidatedEditRequest,
    options: {
      preferredCategory?: EditIntentCategory;
      confidence?: number;
      source: 'llm' | 'heuristic';
      extraWarnings?: string[];
    },
  ): EditIntentDecision {
    const category = inferBestEffortCategory(
      input.request,
      options.preferredCategory,
    );
    const instructionText = buildInstructionText(input.request);
    const editOperation = detectEditOperation(instructionText);

    return this.buildAcceptedDecision(input, {
      category,
      editOperation,
      globalIntent:
        category === 'targeted_component_edit'
          ? buildTargetedEditIntent(editOperation, instructionText)
          : category === 'full_site_migration_with_focus'
            ? 'Migrate the full site to React, with best-effort focus on the most plausible page or area inferred from the request.'
            : 'Migrate the full site to React, inferring the unresolved target from the available context.',
      focusHint:
        input.request?.prompt?.trim() || firstAttachmentNote(input.request),
      confidence: options.confidence,
      source: options.source,
      extraWarnings: [
        ...(options.extraWarnings ?? []),
        'The request was accepted via best-effort inference rather than an exact intent match.',
      ],
    });
  }

  private buildRejectedDecision(
    input: ValidatedEditRequest,
    options: {
      rejectionCode: 'UNCLEAR_INTENT' | 'OUT_OF_SCOPE';
      userMessage: string;
      confidence?: number;
      source: 'llm' | 'heuristic';
    },
  ): EditIntentDecision {
    const analysis = deriveIntentAnalysis({
      request: input.request,
      category: 'invalid',
      inputWarnings: input.warnings,
      extraWarnings: [options.userMessage],
      inputNeedsInference: input.needsInference,
      focusHint:
        input.request?.prompt?.trim() || firstAttachmentNote(input.request),
    });

    return {
      accepted: false,
      mode: input.mode,
      category: 'invalid',
      editOperation: detectEditOperation(buildInstructionText(input.request)),
      request: input.request,
      globalIntent: '',
      focusHint: analysis.focusHint,
      confidence: options.confidence,
      source: options.source,
      warnings: analysis.warnings,
      needsInference: analysis.needsInference,
      targetScope: analysis.targetScope,
      targetCandidates: analysis.targetCandidates,
      inferredAssumptions: analysis.inferredAssumptions,
      ambiguities: analysis.ambiguities,
      recommendedStrategy: analysis.recommendedStrategy,
      rejectionCode: options.rejectionCode,
      userMessage: options.userMessage,
    };
  }
}

interface IntentClassifierResponse {
  accepted: boolean;
  category:
    | 'full_site_migration'
    | 'full_site_migration_with_focus'
    | 'targeted_component_edit'
    | 'invalid';
  editOperation?: string;
  focusHint?: string;
  confidence?: number;
  rejectionCode?: 'UNCLEAR_INTENT' | 'OUT_OF_SCOPE';
  userMessage?: string;
}

interface DerivedIntentAnalysis {
  focusHint?: string;
  warnings: string[];
  needsInference: boolean;
  targetScope: EditTargetScope;
  targetCandidates: EditIntentTargetCandidate[];
  inferredAssumptions: string[];
  ambiguities: string[];
  recommendedStrategy: EditExecutionStrategy;
}

const INTENT_SYSTEM_PROMPT = `You classify incoming requests for a WordPress-to-React migration product.
Input may be in English, Vietnamese, or mixed English/Vietnamese.

Hard rules:
- The product migrates full sites. A request may still be a targeted UI edit on an already-generated component.
- "full_site_migration" — user wants to migrate or regenerate the full site with no specific focus.
- "full_site_migration_with_focus" — user wants full migration but with extra focus on one page or area.
- "targeted_component_edit" — user wants to edit an already-generated component: change layout/colors/content, add a new section (carousel, slider, modal, tabs, accordion, etc.), replace an existing section, or adjust layout. These are post-generation edits, not full regenerations.
- If captures exist, treat them as visual evidence of the targeted area.
- Accept UI edit requests (layout, color, content, add section, replace section) as "targeted_component_edit".
- Accept feature additions (carousel, FAQ, newsletter, modal, chat, widget) as "targeted_component_edit" if they target a specific component, or as "full_site_migration_with_focus" if they apply site-wide.
- If the request is vague but still plausibly about UI/migration, prefer the closest accepted category instead of "invalid".
- Reject anything clearly unrelated to UI, migration, or component editing.

editOperation values (pick the best match):
- "change_layout" — rearranging visual structure
- "change_content" — updating text, headings, copy
- "change_color" — changing colors, backgrounds
- "replace_section" — replacing one section type with another
- "add_section" — adding a new section (carousel, tabs, accordion, modal, etc.)
- "add_component" — adding a new interactive widget
- "adjust_layout" — minor layout tweaks based on existing structure
- "general" — general edit not matching above

Return ONLY valid JSON with this exact shape:
{
  "accepted": boolean,
  "category": "full_site_migration" | "full_site_migration_with_focus" | "targeted_component_edit" | "invalid",
  "editOperation": "change_layout" | "change_content" | "change_color" | "replace_section" | "add_section" | "add_component" | "adjust_layout" | "general" | null,
  "focusHint": string | null,
  "confidence": number,
  "rejectionCode": "UNCLEAR_INTENT" | "OUT_OF_SCOPE" | null,
  "userMessage": string | null
}`;

function buildIntentClassifierPrompt(input: ValidatedEditRequest): string {
  const request = input.request;
  const lines = [
    `Mode: ${input.mode}`,
    `Has captures: ${(request?.attachments?.length ?? 0) > 0 ? 'yes' : 'no'}`,
    `Needs inference: ${input.needsInference ? 'yes' : 'no'}`,
    `Prompt: ${request?.prompt?.trim() || '(empty)'}`,
  ];

  if (input.warnings.length > 0) {
    lines.push('Validation warnings:');
    for (const warning of input.warnings.slice(0, 6)) {
      lines.push(`- ${warning}`);
    }
  }

  if (request?.targetHint) {
    lines.push(
      `Target hint: component=${request.targetHint.componentName ?? '(none)'}; route=${request.targetHint.route ?? '(none)'}; template=${request.targetHint.templateName ?? '(none)'}; sourceNodeId=${request.targetHint.sourceNodeId ?? '(none)'}; sectionType=${request.targetHint.sectionType ?? '(none)'}; debugKey=${request.targetHint.sectionKey ?? '(none)'}; targetRole=${request.targetHint.targetNodeRole ?? '(none)'}`,
    );
  }

  if (request?.constraints) {
    lines.push(
      `Constraints: preserveOutsideSelection=${request.constraints.preserveOutsideSelection ? 'yes' : 'no'}; preserveDataContract=${request.constraints.preserveDataContract ? 'yes' : 'no'}; rerunFromScratch=${request.constraints.rerunFromScratch ? 'yes' : 'no'}`,
    );
  }

  if (request?.pageContext) {
    lines.push(
      `WordPress URL: ${request.pageContext.wordpressUrl ?? '(none)'}`,
    );
    lines.push(`React route: ${request.pageContext.reactRoute ?? '(none)'}`);
  }

  if (request?.attachments?.length) {
    lines.push('Capture notes:');
    for (const attachment of request.attachments.slice(0, 6)) {
      lines.push(
        `- id=${attachment.id}; note=${attachment.note?.trim() || '(empty)'}; page=${attachment.sourcePageUrl ?? attachment.captureContext?.page?.url ?? '(none)'}; route=${attachment.targetNode?.route ?? attachment.captureContext?.page?.route ?? '(none)'}; template=${attachment.targetNode?.templateName ?? '(none)'}; targetRole=${attachment.targetNode?.editNodeRole ?? '(none)'}`,
      );
    }
  }

  lines.push(
    'Classify this request for full-site migration, focused migration, targeted component edit, or invalid/out-of-scope.',
  );
  return lines.join('\n');
}

function parseIntentClassifierResponse(raw: string): IntentClassifierResponse {
  const cleaned = raw
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '')
    .trim();
  const parsed = JSON.parse(cleaned) as IntentClassifierResponse;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM intent classifier returned a non-object response');
  }
  if (typeof parsed.accepted !== 'boolean') {
    throw new Error('LLM intent classifier missing accepted boolean');
  }
  if (
    ![
      'full_site_migration',
      'full_site_migration_with_focus',
      'targeted_component_edit',
      'invalid',
    ].includes(parsed.category)
  ) {
    throw new Error('LLM intent classifier returned an invalid category');
  }
  return parsed;
}

function deriveIntentAnalysis(input: {
  request?: PipelineEditRequestDto;
  category: EditIntentCategory;
  inputWarnings?: string[];
  extraWarnings?: string[];
  inputNeedsInference?: boolean;
  focusHint?: string;
}): DerivedIntentAnalysis {
  const request = input.request;
  const targetCandidates = collectTargetCandidates(request);
  const targetScope = inferTargetScope(
    request,
    targetCandidates,
    input.category,
  );
  const ambiguities = collectAmbiguities(
    request,
    targetCandidates,
    input.category,
  );
  const inferredAssumptions = collectAssumptions(
    request,
    targetCandidates,
    targetScope,
  );

  const warnings = dedupeStrings([
    ...(input.inputWarnings ?? []),
    ...(input.extraWarnings ?? []),
  ]);
  const needsInference = Boolean(
    input.inputNeedsInference ||
    warnings.length > 0 ||
    ambiguities.length > 0 ||
    (!request?.prompt?.trim() && input.category !== 'full_site_migration') ||
    (input.category !== 'full_site_migration' && targetCandidates.length === 0),
  );

  if (needsInference) {
    warnings.push(
      'Execute this request conservatively and infer only the smallest viable target from the available context.',
    );
  }

  return {
    focusHint:
      input.focusHint?.trim() ||
      request?.prompt?.trim() ||
      firstAttachmentNote(request),
    warnings: dedupeStrings(warnings),
    needsInference,
    targetScope,
    targetCandidates,
    inferredAssumptions,
    ambiguities,
    recommendedStrategy: inferRecommendedStrategy(
      input.category,
      targetScope,
      needsInference,
    ),
  };
}

function collectTargetCandidates(
  request?: PipelineEditRequestDto,
): EditIntentTargetCandidate[] {
  if (!request) return [];

  const candidates: EditIntentTargetCandidate[] = [];

  if (request.targetHint) {
    candidates.push({
      componentName: request.targetHint.componentName,
      route: request.targetHint.route,
      templateName: request.targetHint.templateName,
      sourceNodeId: request.targetHint.sourceNodeId,
      debugKey: request.targetHint.sectionKey,
      outputFilePath: request.targetHint.outputFilePath,
      sectionKey: request.targetHint.sectionKey,
      sectionType: request.targetHint.sectionType,
      targetNodeRole: request.targetHint.targetNodeRole,
      confidence: scoreTargetHintConfidence(request.targetHint),
      evidence: compactStrings([
        request.targetHint.componentName
          ? `explicit component=${request.targetHint.componentName}`
          : undefined,
        request.targetHint.route
          ? `explicit route=${request.targetHint.route}`
          : undefined,
        request.targetHint.templateName
          ? `explicit template=${request.targetHint.templateName}`
          : undefined,
        request.targetHint.sourceNodeId
          ? `explicit sourceNodeId=${request.targetHint.sourceNodeId}`
          : undefined,
        request.targetHint.sectionKey
          ? `debugKey=${request.targetHint.sectionKey}`
          : undefined,
        request.targetHint.sectionType
          ? `explicit sectionType=${request.targetHint.sectionType}`
          : undefined,
        request.targetHint.targetNodeRole
          ? `explicit targetRole=${request.targetHint.targetNodeRole}`
          : undefined,
      ]),
    });
  }

  const pageRoute =
    request.pageContext?.reactRoute ?? request.pageContext?.wordpressRoute;
  if (pageRoute) {
    candidates.push({
      componentName: deriveComponentNameFromRoute(pageRoute),
      route: pageRoute,
      confidence: 0.62,
      evidence: [`pageContext route=${pageRoute}`],
    });
  }

  for (const attachment of request.attachments ?? []) {
    const route =
      attachment.targetNode?.route ??
      attachment.captureContext?.page?.route ??
      toComparablePath(attachment.sourcePageUrl) ??
      undefined;
    const templateName =
      attachment.targetNode?.templateName ??
      request.targetHint?.templateName ??
      inferTemplateNameFromRoute(route);
    const componentName =
      request.targetHint?.componentName ??
      deriveComponentNameFromTemplateName(templateName) ??
      deriveComponentNameFromRoute(route);
    const sectionType =
      request.targetHint?.sectionType ??
      inferSectionTypeFromCaptureSignals(attachment);
    const sourceNodeId =
      attachment.targetNode?.sourceNodeId ?? request.targetHint?.sourceNodeId;
    const targetNodeRole = normalizeNodeRole(
      attachment.targetNode?.editNodeRole ?? request.targetHint?.targetNodeRole,
    );
    const evidence = compactStrings([
      `attachment=${attachment.id}`,
      attachment.note ? `note="${truncate(attachment.note, 100)}"` : undefined,
      route ? `route=${route}` : undefined,
      templateName ? `template=${templateName}` : undefined,
      attachment.targetNode?.nearestHeading
        ? `heading="${truncate(attachment.targetNode.nearestHeading, 80)}"`
        : undefined,
      attachment.targetNode?.blockName
        ? `block=${attachment.targetNode.blockName}`
        : undefined,
      sourceNodeId ? `sourceNodeId=${sourceNodeId}` : undefined,
      targetNodeRole ? `targetRole=${targetNodeRole}` : undefined,
    ]);
    if (evidence.length === 0) continue;

    candidates.push({
      componentName,
      route,
      templateName,
      sourceNodeId,
      debugKey: request.targetHint?.sectionKey,
      sectionType,
      targetNodeRole,
      confidence: scoreAttachmentCandidateConfidence(attachment),
      evidence,
    });
  }

  return dedupeCandidates(candidates).sort(
    (left, right) => right.confidence - left.confidence,
  );
}

function inferTargetScope(
  request: PipelineEditRequestDto | undefined,
  targetCandidates: EditIntentTargetCandidate[],
  category: EditIntentCategory,
): EditTargetScope {
  if (
    request?.targetHint?.targetNodeRole ||
    request?.targetHint?.targetTextPreview ||
    request?.targetHint?.targetElementTag ||
    request?.attachments?.some(
      (attachment) => attachment.targetNode?.editNodeRole,
    )
  ) {
    return 'element';
  }
  if (
    request?.targetHint?.sourceNodeId ||
    request?.targetHint?.sectionKey ||
    request?.targetHint?.sectionType ||
    typeof request?.targetHint?.sectionIndex === 'number' ||
    targetCandidates.some(
      (candidate) =>
        candidate.sourceNodeId ||
        candidate.debugKey ||
        candidate.sectionKey ||
        candidate.sectionType,
    )
  ) {
    return 'section';
  }
  if (
    request?.targetHint?.componentName ||
    request?.targetHint?.templateName ||
    targetCandidates.some(
      (candidate) => candidate.componentName || candidate.templateName,
    )
  ) {
    return 'component';
  }
  if (
    request?.targetHint?.route ||
    request?.pageContext?.reactRoute ||
    request?.pageContext?.wordpressRoute ||
    targetCandidates.some((candidate) => candidate.route)
  ) {
    return category === 'full_site_migration' ? 'site' : 'route';
  }
  if (category === 'full_site_migration') {
    return 'site';
  }
  return 'unknown';
}

function collectAmbiguities(
  request: PipelineEditRequestDto | undefined,
  targetCandidates: EditIntentTargetCandidate[],
  category: EditIntentCategory,
): string[] {
  const ambiguities: string[] = [];
  if (!request) return ambiguities;

  if (category !== 'full_site_migration' && targetCandidates.length === 0) {
    ambiguities.push(
      'No explicit target component, route, section, or element was identified.',
    );
  }

  const distinctRoutes = new Set(
    targetCandidates
      .map((candidate) => normalizeRoute(candidate.route))
      .filter(Boolean),
  );
  if (distinctRoutes.size > 1) {
    ambiguities.push(
      'The request references multiple possible routes/pages, so the primary edit target is ambiguous.',
    );
  }

  const distinctComponents = new Set(
    targetCandidates
      .map((candidate) => candidate.componentName?.trim())
      .filter(Boolean),
  );
  if (distinctComponents.size > 1) {
    ambiguities.push(
      'More than one plausible component target was detected from the request context.',
    );
  }

  if (
    !request.prompt?.trim() &&
    (request.attachments?.length ?? 0) > 0 &&
    !(request.attachments ?? []).every((attachment) => attachment.note?.trim())
  ) {
    ambiguities.push(
      'Some captures have no written instruction, so the requested mutation must be inferred from visual evidence.',
    );
  }

  return ambiguities;
}

function collectAssumptions(
  request: PipelineEditRequestDto | undefined,
  targetCandidates: EditIntentTargetCandidate[],
  targetScope: EditTargetScope,
): string[] {
  const assumptions: string[] = [];
  if (!request) return assumptions;

  if (request.targetHint?.route && !request.targetHint.componentName) {
    assumptions.push(
      `Assume route ${request.targetHint.route} maps to the intended generated React component.`,
    );
  }

  if (request.targetHint?.templateName && !request.targetHint.componentName) {
    assumptions.push(
      `Assume template ${request.targetHint.templateName} maps to the intended generated React component.`,
    );
  }

  if (
    !request.prompt?.trim() &&
    (request.targetHint ||
      request.constraints ||
      (request.attachments?.length ?? 0) > 0)
  ) {
    assumptions.push(
      'Infer the requested mutation from target hints, constraints, and visual evidence because no standalone prompt was provided.',
    );
  }

  if (
    (request.attachments ?? []).some((attachment) => !attachment.note?.trim())
  ) {
    assumptions.push(
      'Treat the selected capture region and DOM metadata as the intended edit target when note text is missing.',
    );
  }

  if (targetScope === 'section') {
    assumptions.push(
      'Prefer a localized source-backed region edit unless a resolved child-element target proves otherwise.',
    );
  }

  if (
    targetCandidates.length > 1 &&
    targetCandidates[0]?.confidence > targetCandidates[1]?.confidence
  ) {
    assumptions.push(
      'Use the highest-confidence target candidate as the primary edit target and preserve the rest of the page.',
    );
  }

  return dedupeStrings(assumptions);
}

function inferRecommendedStrategy(
  category: EditIntentCategory,
  targetScope: EditTargetScope,
  needsInference: boolean,
): EditExecutionStrategy {
  if (needsInference && targetScope === 'unknown') {
    return 'best-effort-inference';
  }

  if (category === 'full_site_migration') {
    return 'full-site-migration';
  }

  if (category === 'full_site_migration_with_focus') {
    return targetScope === 'site'
      ? 'focused-migration'
      : mapScopeToStrategy(targetScope);
  }

  if (category === 'targeted_component_edit') {
    return mapScopeToStrategy(targetScope);
  }

  return 'best-effort-inference';
}

function mapScopeToStrategy(
  targetScope: EditTargetScope,
): EditExecutionStrategy {
  switch (targetScope) {
    case 'element':
      return 'element-edit';
    case 'section':
      return 'section-edit';
    case 'component':
      return 'component-edit';
    case 'route':
      return 'focused-migration';
    case 'site':
      return 'full-site-migration';
    default:
      return 'best-effort-inference';
  }
}

function inferBestEffortCategory(
  request?: PipelineEditRequestDto,
  preferredCategory?: EditIntentCategory,
): EditIntentCategory {
  if (
    preferredCategory &&
    [
      'full_site_migration',
      'full_site_migration_with_focus',
      'targeted_component_edit',
    ].includes(preferredCategory)
  ) {
    return preferredCategory;
  }

  const instructionText = normalizeText(buildInstructionText(request));
  const hasSpecificTarget = Boolean(
    request?.targetHint?.componentName ||
    request?.targetHint?.sectionType ||
    request?.targetHint?.targetNodeRole ||
    request?.attachments?.length,
  );

  if (looksLikeTargetedComponentEdit(instructionText) || hasSpecificTarget) {
    return 'targeted_component_edit';
  }

  return request?.pageContext?.reactRoute ||
    request?.pageContext?.wordpressRoute
    ? 'full_site_migration_with_focus'
    : 'full_site_migration';
}

function buildInstructionText(request?: PipelineEditRequestDto): string {
  return compactStrings([
    request?.prompt?.trim(),
    ...(request?.attachments ?? [])
      .map((attachment) => attachment.note?.trim())
      .filter(Boolean),
  ]).join(' ');
}

function firstAttachmentNote(
  request?: PipelineEditRequestDto,
): string | undefined {
  return request?.attachments
    ?.map((attachment) => attachment.note?.trim())
    .find(Boolean);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function looksOutOfScope(prompt: string): boolean {
  return /\b(joke|poem|story|weather|stock|crypto|translate song|recipe|ke chuyen|lam tho|thoi tiet|gia co phieu|cong thuc)\b/.test(
    stripVietnameseMarks(prompt),
  );
}

function looksLikeMigrationIntent(prompt: string): boolean {
  const normalized = stripVietnameseMarks(prompt);
  const migrationSignal =
    /\b(migrate|migration|convert|rebuild|clone|port|transform|chuyen doi|migrate full|migrate toan bo|di chuyen sang react)\b/.test(
      normalized,
    );
  const uiSignal =
    /\b(improve|update|adjust|refine|redesign|restyle|focus|preserve|change|make|toi uu|dieu chinh|chinh sua|giu nguyen|doi mau|tap trung|doi layout|sua layout|sua giao dien|doi giao dien)\b/.test(
      normalized,
    );
  const featureSignal =
    /\b(add|insert|create|build|integrate|enable|introduce|implement|feature|functionality|widget|module|popup|modal|form|signup|newsletter|chatbot|chat|calculator|booking|spin|lucky wheel|wheel|carousel|faq|search|filter|them|chen|tao|xay dung|tich hop|bat|bo sung|tinh nang|chuc nang|dang ky|vong quay|quay thuong|tim kiem|bo loc)\b/.test(
      normalized,
    );
  const scopeSignal =
    /\b(site|website|wordpress|theme|all pages|full site|whole site|entire site|toan bo|ca trang|toan site|toan website)\b/.test(
      normalized,
    );
  const focusSignal = mentionsFocusTarget(normalized);
  const targetedEditSignal =
    /\b(doi|sua|thay|them|chen|bo sung|replace|add|insert|switch|convert)\b/.test(
      normalized,
    ) &&
    /\b(layout|mau|color|noi dung|content|section|carousel|slider|modal|tabs|accordion|hero|banner|component|widget)\b/.test(
      normalized,
    );

  return (
    migrationSignal ||
    ((uiSignal || featureSignal) && (scopeSignal || focusSignal)) ||
    (targetedEditSignal && focusSignal)
  );
}

function mentionsFocusTarget(prompt: string): boolean {
  return /\b(home|homepage|landing|about|contact|blog|header|hero|footer|navbar|section|page|trang chu|trang home|trang gioi thieu|trang lien he|dau trang|chan trang|khu vuc)\b/.test(
    prompt,
  );
}

function stripVietnameseMarks(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function looksLikeTargetedComponentEdit(prompt: string): boolean {
  const editActionSignal =
    /\b(doi|sua|thay|them|chen|bo sung|change|edit|update|replace|add|insert|adjust|refine|switch|convert)\b/.test(
      prompt,
    );
  const uiTargetSignal =
    /\b(layout|mau|color|noi dung|content|section|vung|component|widget|slider|carousel|modal|tabs|accordion|faq|hero|banner|header|footer|background|bo cuc|giao dien)\b/.test(
      prompt,
    );
  return editActionSignal && uiTargetSignal;
}

const VALID_EDIT_OPERATIONS = [
  'change_layout',
  'change_content',
  'change_color',
  'replace_section',
  'add_section',
  'add_component',
  'adjust_layout',
  'general',
] as const;

function asEditOperation(value: string | undefined): EditOperation | undefined {
  if (!value) return undefined;
  return (VALID_EDIT_OPERATIONS as readonly string[]).includes(value)
    ? (value as EditOperation)
    : undefined;
}

function buildTargetedEditIntent(
  operation: EditOperation,
  prompt: string,
): string {
  const snippet = `"${prompt.slice(0, 120)}"`;
  switch (operation) {
    case 'add_section':
      return `Add a new section to the targeted component as described: ${snippet}`;
    case 'add_component':
      return `Add a new interactive component to the targeted area as described: ${snippet}`;
    case 'replace_section':
      return `Replace the targeted section with a new one as described: ${snippet}`;
    case 'change_layout':
      return `Change the layout of the targeted component/section as described: ${snippet}`;
    case 'adjust_layout':
      return `Adjust the layout of the targeted component based on its current structure: ${snippet}`;
    case 'change_color':
      return `Update the colors/backgrounds of the targeted component as described: ${snippet}`;
    case 'change_content':
      return `Update the content (text, headings) of the targeted component as described: ${snippet}`;
    default:
      return `Apply the requested UI change to the targeted component: ${snippet}`;
  }
}

function scoreTargetHintConfidence(
  targetHint: NonNullable<PipelineEditRequestDto['targetHint']>,
): number {
  let score = 0.42;
  if (targetHint.componentName) score += 0.22;
  if (targetHint.route) score += 0.16;
  if (targetHint.templateName) score += 0.12;
  if (targetHint.sourceNodeId) score += 0.14;
  if (targetHint.sectionKey || targetHint.sectionType) score += 0.04;
  if (targetHint.targetNodeRole) score += 0.06;
  return clampMetric(score);
}

function scoreAttachmentCandidateConfidence(
  attachment: NonNullable<PipelineEditRequestDto['attachments']>[number],
): number {
  let score = 0.38;
  if (attachment.note?.trim()) score += 0.16;
  if (attachment.targetNode?.route) score += 0.14;
  if (attachment.targetNode?.templateName) score += 0.12;
  if (attachment.targetNode?.nearestHeading) score += 0.07;
  if (attachment.targetNode?.editNodeRole) score += 0.07;
  if (attachment.geometry?.normalizedRect) score += 0.04;
  return clampMetric(score);
}

function dedupeCandidates(
  candidates: EditIntentTargetCandidate[],
): EditIntentTargetCandidate[] {
  const merged = new Map<string, EditIntentTargetCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.componentName ?? '',
      normalizeRoute(candidate.route) ?? '',
      candidate.templateName ?? '',
      candidate.sourceNodeId ?? '',
      candidate.debugKey ?? '',
      candidate.sectionKey ?? '',
      candidate.sectionType ?? '',
      candidate.outputFilePath ?? '',
      candidate.targetNodeRole ?? '',
    ].join('|');
    const existing = merged.get(key);
    if (!existing || existing.confidence < candidate.confidence) {
      merged.set(key, {
        ...candidate,
        evidence: dedupeStrings(candidate.evidence),
      });
      continue;
    }

    existing.evidence = dedupeStrings([
      ...existing.evidence,
      ...candidate.evidence,
    ]);
  }

  return Array.from(merged.values());
}

function deriveComponentNameFromTemplateName(
  templateName?: string | null,
): string | undefined {
  const normalized = String(templateName ?? '').trim();
  if (!normalized) return undefined;
  const name = normalized
    .replace(/\.(php|html)$/i, '')
    .split(/[\\/_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  if (!name) return undefined;
  return /^\d/.test(name) ? `Page${name}` : name;
}

function deriveComponentNameFromRoute(
  route?: string | null,
): string | undefined {
  const normalized = normalizeRoute(route);
  if (!normalized) return undefined;
  if (normalized === '/') return 'Home';
  const slug = normalized.split('/').filter(Boolean).pop();
  return deriveComponentNameFromTemplateName(slug);
}

function inferTemplateNameFromRoute(route?: string | null): string | undefined {
  const normalized = normalizeRoute(route);
  if (!normalized) return undefined;
  if (normalized === '/') return 'home';
  return normalized.split('/').filter(Boolean).pop()?.toLowerCase();
}

function inferSectionTypeFromCaptureSignals(
  attachment: NonNullable<PipelineEditRequestDto['attachments']>[number],
): string | undefined {
  const signal = normalizeText(
    compactStrings([
      attachment.targetNode?.blockName,
      attachment.targetNode?.tagName,
      attachment.targetNode?.domPath,
      attachment.targetNode?.nearestHeading,
      attachment.targetNode?.nearestLandmark,
      attachment.domTarget?.blockName,
      attachment.domTarget?.tagName,
      attachment.domTarget?.domPath,
      attachment.domTarget?.nearestHeading,
      attachment.domTarget?.nearestLandmark,
      attachment.note,
    ]).join(' '),
  );

  if (!signal) return undefined;
  if (/\b(hero|banner|cover)\b/.test(signal)) return 'hero';
  if (/\b(header|navigation|navbar|menu)\b/.test(signal)) return 'header';
  if (/\bfooter\b/.test(signal)) return 'footer';
  if (/\bfaq|accordion\b/.test(signal)) return 'faq';
  if (/\btestimonial|review|quote\b/.test(signal)) return 'testimonial';
  if (/\bpricing|price|plan\b/.test(signal)) return 'pricing';
  if (/\bfeature|benefit|service\b/.test(signal)) return 'features';
  if (/\b(contact|form|signup|newsletter|chat|search|filter)\b/.test(signal)) {
    return 'interactive';
  }
  if (/\b(gallery|image|media|video)\b/.test(signal)) return 'media';
  if (/\b(posts|post|query|blog|article)\b/.test(signal)) return 'posts';
  if (/\b(sidebar|aside)\b/.test(signal)) return 'sidebar';
  if (/\b(section|group|columns|column|container)\b/.test(signal)) {
    return 'section';
  }
  return undefined;
}

function normalizeNodeRole(value?: string | null): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

function normalizeRoute(route?: string | null): string | null {
  if (!route) return null;
  const normalized = route
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');
  return normalized || '/';
}

function toComparablePath(value?: string | null): string | null {
  if (!value) return null;
  try {
    const path = new URL(value).pathname.replace(/\/+$/g, '');
    return path || '/';
  } catch {
    const normalized = value.trim().replace(/\/+$/g, '');
    return normalized || '/';
  }
}

function compactStrings(values: Array<string | undefined | null>): string[] {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function clampMetric(value: number): number {
  return Math.min(Math.max(Math.round(value * 100) / 100, 0), 1);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
