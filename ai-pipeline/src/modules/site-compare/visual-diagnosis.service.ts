import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LlmFactoryService } from '../../common/llm/llm-factory.service.js';
import { OPENAI_CLIENT } from '../../common/providers/openai/openai.provider.js';
import type {
  AutomationComparePageResult,
  PostEditVisualValidationIssue,
  PostEditVisualValidationResult,
  VisualMismatchDiagnosis,
  VisualMismatchIssue,
  VisualMismatchRootCause,
} from './visual-diagnosis.types.js';
import {
  buildPostEditVisualValidationUserPrompt,
  POST_EDIT_VISUAL_VALIDATION_SYSTEM_PROMPT,
} from './prompts/post-edit-visual-validation.prompt.js';
import {
  buildVisualDiagnosisUserPrompt,
  VISUAL_DIAGNOSIS_SYSTEM_PROMPT,
} from './prompts/visual-diagnosis.prompt.js';

interface DiagnoseVisualMismatchInput {
  componentName: string;
  page: AutomationComparePageResult;
  sourceEvidence: string[];
  planEvidence: string[];
  modelName?: string;
  visionImageUrls?: string[];
}

interface ValidatePostEditVisualInput {
  componentName: string;
  page: AutomationComparePageResult;
  requestContextLines: string[];
  sourceEvidence: string[];
  planEvidence: string[];
  modelName?: string;
  visionImageUrls?: string[];
  baselineAccuracy?: number | null;
}

@Injectable()
export class SiteCompareVisualDiagnosisService {
  constructor(
    private readonly llmFactory: LlmFactoryService,
    private readonly configService: ConfigService,
    @Inject(OPENAI_CLIENT) private readonly openai: OpenAI,
  ) {}

  async diagnose(
    input: DiagnoseVisualMismatchInput,
  ): Promise<VisualMismatchDiagnosis> {
    const {
      componentName,
      page,
      sourceEvidence,
      planEvidence,
      modelName,
      visionImageUrls = [],
    } = input;

    const heuristic = this.buildHeuristicVisualDiagnosis({
      componentName,
      page,
      sourceEvidence,
      planEvidence,
    });
    const prompt = buildVisualDiagnosisUserPrompt({
      componentName,
      page,
      sourceEvidence,
      planEvidence,
      heuristic,
    });
    const requestedModel =
      modelName?.trim() ||
      this.configService.get<string>('pipeline.reviewCodeModel') ||
      this.llmFactory.getModel();
    const normalizedVisionUrls = visionImageUrls
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);
    const visionModel = this.resolvePreferredVisionModel(requestedModel);

    try {
      if (visionModel && normalizedVisionUrls.length > 0) {
        const response = await this.llmFactory.runWithRetry(
          `visual-diagnosis:vision:${visionModel}`,
          () =>
            this.openai.chat.completions.create({
              model: visionModel,
              temperature: 0,
              max_completion_tokens: 1400,
              messages: [
                {
                  role: 'system',
                  content: VISUAL_DIAGNOSIS_SYSTEM_PROMPT,
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `${prompt}\n\nAttached images are ordered as: WordPress reference, React output, visual diff/crop.`,
                    },
                    ...normalizedVisionUrls.map((url) => ({
                      type: 'image_url' as const,
                      image_url: { url, detail: 'high' as const },
                    })),
                  ],
                },
              ],
            }),
        );
        const text = response.choices[0]?.message?.content;
        if (text) {
          const parsed = this.parseVisualDiagnosisResponse(
            text,
            componentName,
            page,
            'vision',
          );
          if (parsed) {
            return this.mergeDiagnosisWithHeuristic(
              parsed,
              heuristic,
              'vision',
            );
          }
        }
      }

      const response = await this.llmFactory.chat({
        model: requestedModel,
        systemPrompt: VISUAL_DIAGNOSIS_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 1400,
        temperature: 0,
      });
      const parsed = this.parseVisualDiagnosisResponse(
        response.text,
        componentName,
        page,
        'text',
      );
      if (parsed) {
        return this.mergeDiagnosisWithHeuristic(parsed, heuristic, 'text');
      }
    } catch {
      // Fallback to heuristic diagnosis below.
    }

    return { ...heuristic, analysisMode: 'heuristic' };
  }

  async validatePostEdit(
    input: ValidatePostEditVisualInput,
  ): Promise<PostEditVisualValidationResult> {
    const {
      componentName,
      page,
      requestContextLines,
      sourceEvidence,
      planEvidence,
      modelName,
      visionImageUrls = [],
      baselineAccuracy,
    } = input;

    const heuristic = this.buildHeuristicPostEditValidation({
      componentName,
      page,
      requestContextLines,
      baselineAccuracy,
    });
    const prompt = buildPostEditVisualValidationUserPrompt({
      componentName,
      page,
      requestContextLines,
      sourceEvidence,
      planEvidence,
      baselineAccuracy,
      heuristic,
    });
    const requestedModel =
      modelName?.trim() ||
      this.configService.get<string>('pipeline.reviewCodeModel') ||
      this.llmFactory.getModel();
    const normalizedVisionUrls = visionImageUrls
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);
    const visionModel = this.resolvePreferredVisionModel(requestedModel);

    try {
      if (visionModel && normalizedVisionUrls.length > 0) {
        const response = await this.llmFactory.runWithRetry(
          `post-edit-visual-validation:vision:${visionModel}`,
          () =>
            this.openai.chat.completions.create({
              model: visionModel,
              temperature: 0,
              max_completion_tokens: 1400,
              messages: [
                {
                  role: 'system',
                  content: POST_EDIT_VISUAL_VALIDATION_SYSTEM_PROMPT,
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `${prompt}\n\nAttached images are ordered as: WordPress reference, edited React output, visual diff/crop.`,
                    },
                    ...normalizedVisionUrls.map((url) => ({
                      type: 'image_url' as const,
                      image_url: { url, detail: 'high' as const },
                    })),
                  ],
                },
              ],
            }),
        );
        const text = response.choices[0]?.message?.content;
        if (text) {
          const parsed = this.parsePostEditValidationResponse(
            text,
            componentName,
            page,
            'vision',
          );
          if (parsed) {
            return this.mergePostEditValidationWithHeuristic(
              parsed,
              heuristic,
              'vision',
            );
          }
        }
      }

      const response = await this.llmFactory.chat({
        model: requestedModel,
        systemPrompt: POST_EDIT_VISUAL_VALIDATION_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 1400,
        temperature: 0,
      });
      const parsed = this.parsePostEditValidationResponse(
        response.text,
        componentName,
        page,
        'text',
      );
      if (parsed) {
        return this.mergePostEditValidationWithHeuristic(
          parsed,
          heuristic,
          'text',
        );
      }
    } catch {
      // Fallback to heuristic validation below.
    }

    return { ...heuristic, analysisMode: 'heuristic' };
  }

  private parseVisualDiagnosisResponse(
    raw: string,
    componentName: string,
    page: AutomationComparePageResult,
    analysisMode: 'vision' | 'text',
  ): VisualMismatchDiagnosis | null {
    const candidate = this.extractJsonObject(raw);
    if (!candidate) return null;

    try {
      const parsed = JSON.parse(candidate) as Partial<VisualMismatchDiagnosis>;
      const confidence = Math.max(
        0,
        Math.min(1, this.coerceFiniteNumber(parsed.confidence) ?? 0),
      );
      const score = Math.max(
        0,
        Math.min(
          100,
          this.coerceFiniteNumber(parsed.score) ??
            this.coerceFiniteNumber(page.visual?.accuracy) ??
            Math.max(
              0,
              100 - (this.coerceFiniteNumber(page.visual?.diffPct) ?? 100),
            ),
        ),
      );
      const rootPrimary = parsed.rootCause?.primary ?? 'unknown';
      const allowedRootCauses = new Set<VisualMismatchRootCause>([
        'plan-omission',
        'missing-section',
        'missing-image',
        'content-drift',
        'layout-drift',
        'route-mapping-error',
        'data-binding-error',
        'shared-layout-mismatch',
        'unknown',
      ]);

      return {
        componentName:
          typeof parsed.componentName === 'string' &&
          parsed.componentName.trim().length > 0
            ? parsed.componentName.trim()
            : componentName,
        routeKey:
          typeof parsed.routeKey === 'string'
            ? parsed.routeKey
            : (page.routeKey ?? null),
        route:
          typeof parsed.route === 'string'
            ? parsed.route
            : (page.route ?? page.visual?.reactPath ?? null),
        shouldRepair:
          typeof parsed.shouldRepair === 'boolean' ? parsed.shouldRepair : true,
        confidence,
        score: Number(score.toFixed(2)),
        analysisMode,
        rootCause: {
          primary: allowedRootCauses.has(rootPrimary) ? rootPrimary : 'unknown',
          secondary: Array.isArray(parsed.rootCause?.secondary)
            ? parsed.rootCause.secondary
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 5)
            : [],
          reasoning:
            typeof parsed.rootCause?.reasoning === 'string'
              ? parsed.rootCause.reasoning.trim()
              : '',
        },
        evidence: {
          sourceHints: Array.isArray(parsed.evidence?.sourceHints)
            ? parsed.evidence.sourceHints
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          missingLabels: Array.isArray(parsed.evidence?.missingLabels)
            ? parsed.evidence.missingLabels
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 6)
            : [],
          sectionLikelyMissingFromPlan:
            parsed.evidence?.sectionLikelyMissingFromPlan === true,
        },
        issues: this.normalizeDiagnosisIssues(parsed.issues),
        repairPlan: {
          strategy:
            typeof parsed.repairPlan?.strategy === 'string'
              ? parsed.repairPlan.strategy.trim()
              : 'targeted-visual-repair',
          instructions: Array.isArray(parsed.repairPlan?.instructions)
            ? parsed.repairPlan.instructions
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          targetAreas: Array.isArray(parsed.repairPlan?.targetAreas)
            ? parsed.repairPlan.targetAreas
                .map((target) => ({
                  type: String(target?.type ?? 'section').trim() || 'section',
                  sectionHint:
                    typeof target?.sectionHint === 'string'
                      ? target.sectionHint.trim()
                      : undefined,
                  headingHint:
                    typeof target?.headingHint === 'string'
                      ? target.headingHint.trim()
                      : undefined,
                }))
                .slice(0, 5)
            : [],
          guardrails: Array.isArray(parsed.repairPlan?.guardrails)
            ? parsed.repairPlan.guardrails
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
        },
      };
    } catch {
      return null;
    }
  }

  private normalizeDiagnosisIssues(rawIssues: unknown): VisualMismatchIssue[] {
    if (!Array.isArray(rawIssues)) return [];
    const allowedTypes = new Set<VisualMismatchIssue['type']>([
      'missing_section',
      'section_order',
      'layout_mismatch',
      'element_position',
      'style_mismatch',
      'content_missing',
      'image_mismatch',
      'unknown',
    ]);
    const allowedSeverity = new Set<VisualMismatchIssue['severity']>([
      'low',
      'medium',
      'high',
    ]);

    const normalized: VisualMismatchIssue[] = [];
    for (const issue of rawIssues) {
      const type = String((issue as { type?: unknown })?.type ?? 'unknown')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_') as VisualMismatchIssue['type'];
      const severity = String(
        (issue as { severity?: unknown })?.severity ?? 'medium',
      )
        .trim()
        .toLowerCase() as VisualMismatchIssue['severity'];
      const evidence = String(
        (issue as { evidence?: unknown })?.evidence ?? '',
      ).trim();
      const suggestedFix = String(
        (issue as { suggestedFix?: unknown })?.suggestedFix ?? '',
      ).trim();
      if (!evidence || !suggestedFix) continue;
      normalized.push({
        type: allowedTypes.has(type) ? type : 'unknown',
        severity: allowedSeverity.has(severity) ? severity : 'medium',
        sectionHint:
          typeof (issue as { sectionHint?: unknown })?.sectionHint === 'string'
            ? (issue as { sectionHint: string }).sectionHint.trim()
            : undefined,
        location:
          typeof (issue as { location?: unknown })?.location === 'string'
            ? (issue as { location: string }).location.trim()
            : undefined,
        evidence,
        suggestedFix,
        sourceBacked:
          (issue as { sourceBacked?: unknown })?.sourceBacked === true,
      });
      if (normalized.length >= 8) break;
    }

    return normalized;
  }

  private parsePostEditValidationResponse(
    raw: string,
    componentName: string,
    page: AutomationComparePageResult,
    analysisMode: 'vision' | 'text',
  ): PostEditVisualValidationResult | null {
    const candidate = this.extractJsonObject(raw);
    if (!candidate) return null;

    try {
      const parsed = JSON.parse(
        candidate,
      ) as Partial<PostEditVisualValidationResult>;
      const confidence = Math.max(
        0,
        Math.min(1, this.coerceFiniteNumber(parsed.confidence) ?? 0),
      );
      const score = Math.max(
        0,
        Math.min(
          100,
          this.coerceFiniteNumber(parsed.score) ??
            this.coerceFiniteNumber(page.visual?.accuracy) ??
            Math.max(
              0,
              100 - (this.coerceFiniteNumber(page.visual?.diffPct) ?? 100),
            ),
        ),
      );
      const issues = this.normalizePostEditValidationIssues(parsed.issues);
      const passed =
        typeof parsed.passed === 'boolean'
          ? parsed.passed
          : !(
              parsed.shouldRepair ??
              issues.some((issue) => issue.severity === 'high')
            );
      const shouldRepair =
        typeof parsed.shouldRepair === 'boolean'
          ? parsed.shouldRepair
          : !passed;

      return {
        componentName:
          typeof parsed.componentName === 'string' &&
          parsed.componentName.trim().length > 0
            ? parsed.componentName.trim()
            : componentName,
        routeKey:
          typeof parsed.routeKey === 'string'
            ? parsed.routeKey
            : (page.routeKey ?? null),
        route:
          typeof parsed.route === 'string'
            ? parsed.route
            : (page.route ?? page.visual?.reactPath ?? null),
        passed,
        shouldRepair,
        editIntentSatisfied:
          typeof parsed.editIntentSatisfied === 'boolean'
            ? parsed.editIntentSatisfied
            : passed,
        outOfScopeRegression: parsed.outOfScopeRegression === true,
        wpParityAdvisoryOnly: parsed.wpParityAdvisoryOnly === true,
        confidence,
        score: Number(score.toFixed(2)),
        analysisMode,
        summary:
          typeof parsed.summary === 'string'
            ? parsed.summary.trim()
            : passed
              ? 'Edited preview looks acceptable for the requested change.'
              : 'Edited preview still needs follow-up after the requested change.',
        issues,
        repairPlan: {
          strategy:
            typeof parsed.repairPlan?.strategy === 'string'
              ? parsed.repairPlan.strategy.trim()
              : 'post-edit-visual-validation',
          instructions: Array.isArray(parsed.repairPlan?.instructions)
            ? parsed.repairPlan.instructions
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          targetAreas: Array.isArray(parsed.repairPlan?.targetAreas)
            ? parsed.repairPlan.targetAreas
                .map((target) => ({
                  type: String(target?.type ?? 'section').trim() || 'section',
                  sectionHint:
                    typeof target?.sectionHint === 'string'
                      ? target.sectionHint.trim()
                      : undefined,
                  headingHint:
                    typeof target?.headingHint === 'string'
                      ? target.headingHint.trim()
                      : undefined,
                }))
                .slice(0, 5)
            : [],
          guardrails: Array.isArray(parsed.repairPlan?.guardrails)
            ? parsed.repairPlan.guardrails
                .map((value) => String(value).trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
        },
      };
    } catch {
      return null;
    }
  }

  private normalizePostEditValidationIssues(
    rawIssues: unknown,
  ): PostEditVisualValidationIssue[] {
    if (!Array.isArray(rawIssues)) return [];
    const allowedTypes = new Set<PostEditVisualValidationIssue['type']>([
      'edit_not_applied',
      'scope_regression',
      'layout_regression',
      'style_regression',
      'content_regression',
      'wp_drift_advisory',
      'unknown',
    ]);
    const allowedSeverity = new Set<PostEditVisualValidationIssue['severity']>([
      'low',
      'medium',
      'high',
    ]);

    const normalized: PostEditVisualValidationIssue[] = [];
    for (const issue of rawIssues) {
      const type = String((issue as { type?: unknown })?.type ?? 'unknown')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_') as PostEditVisualValidationIssue['type'];
      const severity = String(
        (issue as { severity?: unknown })?.severity ?? 'medium',
      )
        .trim()
        .toLowerCase() as PostEditVisualValidationIssue['severity'];
      const evidence = String(
        (issue as { evidence?: unknown })?.evidence ?? '',
      ).trim();
      const suggestedAction = String(
        (issue as { suggestedAction?: unknown })?.suggestedAction ?? '',
      ).trim();
      if (!evidence || !suggestedAction) continue;
      normalized.push({
        type: allowedTypes.has(type) ? type : 'unknown',
        severity: allowedSeverity.has(severity) ? severity : 'medium',
        target:
          typeof (issue as { target?: unknown })?.target === 'string'
            ? (issue as { target: string }).target.trim()
            : undefined,
        evidence,
        suggestedAction,
        inEditScope: (issue as { inEditScope?: unknown })?.inEditScope === true,
      });
      if (normalized.length >= 8) break;
    }

    return normalized;
  }

  private extractJsonObject(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return trimmed.slice(start, end + 1);
  }

  private mergeDiagnosisWithHeuristic(
    diagnosis: VisualMismatchDiagnosis,
    heuristic: VisualMismatchDiagnosis,
    analysisMode: 'vision' | 'text',
  ): VisualMismatchDiagnosis {
    return {
      ...diagnosis,
      analysisMode,
      shouldRepair: diagnosis.shouldRepair ?? heuristic.shouldRepair,
      confidence:
        diagnosis.confidence > 0 ? diagnosis.confidence : heuristic.confidence,
      score: diagnosis.score > 0 ? diagnosis.score : heuristic.score,
      rootCause: {
        primary: diagnosis.rootCause.primary ?? heuristic.rootCause.primary,
        secondary:
          diagnosis.rootCause.secondary.length > 0
            ? diagnosis.rootCause.secondary
            : heuristic.rootCause.secondary,
        reasoning:
          diagnosis.rootCause.reasoning || heuristic.rootCause.reasoning,
      },
      evidence: {
        sourceHints:
          diagnosis.evidence.sourceHints.length > 0
            ? diagnosis.evidence.sourceHints
            : heuristic.evidence.sourceHints,
        missingLabels:
          diagnosis.evidence.missingLabels.length > 0
            ? diagnosis.evidence.missingLabels
            : heuristic.evidence.missingLabels,
        sectionLikelyMissingFromPlan:
          diagnosis.evidence.sectionLikelyMissingFromPlan ||
          heuristic.evidence.sectionLikelyMissingFromPlan,
      },
      issues: diagnosis.issues.length > 0 ? diagnosis.issues : heuristic.issues,
      repairPlan: {
        strategy:
          diagnosis.repairPlan.strategy || heuristic.repairPlan.strategy,
        instructions:
          diagnosis.repairPlan.instructions.length > 0
            ? diagnosis.repairPlan.instructions
            : heuristic.repairPlan.instructions,
        targetAreas:
          diagnosis.repairPlan.targetAreas.length > 0
            ? diagnosis.repairPlan.targetAreas
            : heuristic.repairPlan.targetAreas,
        guardrails:
          diagnosis.repairPlan.guardrails.length > 0
            ? diagnosis.repairPlan.guardrails
            : heuristic.repairPlan.guardrails,
      },
    };
  }

  private mergePostEditValidationWithHeuristic(
    validation: PostEditVisualValidationResult,
    heuristic: PostEditVisualValidationResult,
    analysisMode: 'vision' | 'text',
  ): PostEditVisualValidationResult {
    return {
      ...validation,
      analysisMode,
      passed:
        typeof validation.passed === 'boolean'
          ? validation.passed
          : heuristic.passed,
      shouldRepair:
        typeof validation.shouldRepair === 'boolean'
          ? validation.shouldRepair
          : heuristic.shouldRepair,
      editIntentSatisfied:
        typeof validation.editIntentSatisfied === 'boolean'
          ? validation.editIntentSatisfied
          : heuristic.editIntentSatisfied,
      outOfScopeRegression:
        typeof validation.outOfScopeRegression === 'boolean'
          ? validation.outOfScopeRegression
          : heuristic.outOfScopeRegression,
      wpParityAdvisoryOnly:
        typeof validation.wpParityAdvisoryOnly === 'boolean'
          ? validation.wpParityAdvisoryOnly
          : heuristic.wpParityAdvisoryOnly,
      confidence:
        validation.confidence > 0
          ? validation.confidence
          : heuristic.confidence,
      score: validation.score > 0 ? validation.score : heuristic.score,
      summary: validation.summary || heuristic.summary,
      issues:
        validation.issues.length > 0 ? validation.issues : heuristic.issues,
      repairPlan: {
        strategy:
          validation.repairPlan.strategy || heuristic.repairPlan.strategy,
        instructions:
          validation.repairPlan.instructions.length > 0
            ? validation.repairPlan.instructions
            : heuristic.repairPlan.instructions,
        targetAreas:
          validation.repairPlan.targetAreas.length > 0
            ? validation.repairPlan.targetAreas
            : heuristic.repairPlan.targetAreas,
        guardrails:
          validation.repairPlan.guardrails.length > 0
            ? validation.repairPlan.guardrails
            : heuristic.repairPlan.guardrails,
      },
    };
  }

  private buildHeuristicVisualDiagnosis(input: {
    componentName: string;
    page: AutomationComparePageResult;
    sourceEvidence: string[];
    planEvidence: string[];
  }): VisualMismatchDiagnosis {
    const { componentName, page, sourceEvidence, planEvidence } = input;
    const missingLabels = sourceEvidence
      .filter((entry) => entry.startsWith('Heading/text hint: "'))
      .map((entry) =>
        entry.replace(/^Heading\/text hint: "/, '').replace(/"$/, ''),
      )
      .filter(
        (entry) => !planEvidence.some((planLine) => planLine.includes(entry)),
      )
      .slice(0, 4);
    const overlapDiffPct =
      this.coerceFiniteNumber(page.visual?.overlapDiffPct) ?? 0;
    const extraDiffPct =
      this.coerceFiniteNumber(page.visual?.extraDiffPct) ?? 0;
    const diffPct = this.coerceFiniteNumber(page.visual?.diffPct) ?? 0;
    const domSimilarity =
      this.coerceFiniteNumber(page.visual?.domComparison?.similarityScore) ??
      100;
    const accuracy =
      this.coerceFiniteNumber(page.visual?.accuracy) ??
      Number(Math.max(0, 100 - diffPct).toFixed(2));
    const hasHighRegion = (page.visual?.regions ?? []).some(
      (region) => region.severity === 'high',
    );
    const contentStatus = page.content?.status ?? 'PASS';
    const sectionLikelyMissingFromPlan =
      missingLabels.length > 0 && contentStatus !== 'PASS';

    let primary: VisualMismatchRootCause = 'layout-drift';
    let confidence = 0.68;
    let strategy = 'targeted-visual-repair';
    const secondary: string[] = [];

    if (sectionLikelyMissingFromPlan) {
      primary = 'plan-omission';
      confidence = 0.9;
      strategy = 'restore-missing-section-from-source';
      secondary.push('missing-section', 'content-drift');
    } else if (contentStatus === 'MISSING') {
      primary = 'data-binding-error';
      confidence = 0.88;
      strategy = 'restore-missing-content-binding';
      secondary.push('content-drift');
    } else if (extraDiffPct >= 8 && overlapDiffPct < extraDiffPct + 4) {
      primary = 'missing-section';
      confidence = 0.8;
      strategy = 'restore-vertical-missing-block';
      secondary.push('layout-drift');
    } else if (domSimilarity < 75) {
      primary = 'layout-drift';
      confidence = 0.76;
      strategy = 'repair-structure-to-match-source';
      secondary.push('content-drift');
    } else if (hasHighRegion && contentStatus === 'FAIL') {
      primary = 'content-drift';
      confidence = 0.74;
      strategy = 'restore-source-backed-content';
      secondary.push('layout-drift');
    } else if (diffPct < 8) {
      primary = 'unknown';
      confidence = 0.45;
      strategy = 'review-before-repair';
    }

    const issues = this.buildHeuristicIssues({
      primary,
      missingLabels,
      contentStatus,
      sectionLikelyMissingFromPlan,
      diffPct,
      extraDiffPct,
      domSimilarity,
    });

    return {
      componentName,
      routeKey: page.routeKey ?? null,
      route: page.route ?? page.visual?.reactPath ?? null,
      shouldRepair: confidence >= 0.5,
      confidence,
      score: Number(Math.max(0, Math.min(100, accuracy)).toFixed(2)),
      analysisMode: 'heuristic',
      rootCause: {
        primary,
        secondary,
        reasoning:
          primary === 'plan-omission'
            ? 'WordPress/DB source hints show headings or sections that are not represented in the current plan evidence while compare metrics also report strong content/visual drift.'
            : primary === 'data-binding-error'
              ? 'Content compare reports missing data while the route/component still exists, which suggests the React output is not binding or rendering source data correctly.'
              : primary === 'missing-section'
                ? 'Visual diff indicates a large missing vertical band or extra-height mismatch, suggesting an omitted section rather than only cosmetic drift.'
                : primary === 'layout-drift'
                  ? 'The overall DOM structure and visual diff suggest the component layout diverged from WordPress even if content is partially present.'
                  : 'Signal quality is weak, so the root cause is uncertain.',
      },
      evidence: {
        sourceHints: sourceEvidence.slice(0, 8),
        missingLabels,
        sectionLikelyMissingFromPlan,
      },
      issues,
      repairPlan: {
        strategy,
        instructions:
          primary === 'plan-omission'
            ? [
                'Restore the source-backed missing section even if it is absent from the current plan.',
                'Preserve neighboring sections and current correct layout.',
              ]
            : primary === 'data-binding-error'
              ? [
                  'Repair the component so it renders the expected source-backed content again.',
                  'Do not remove existing sections to hide the mismatch.',
                ]
              : [
                  'Repair the mismatched layout in the highest-diff region first.',
                  'Preserve already-correct sections and avoid unnecessary rewrites.',
                ],
        targetAreas: missingLabels.slice(0, 3).map((label) => ({
          type: 'section',
          headingHint: label,
        })),
        guardrails: [
          'Do not simplify the component to reduce diff.',
          'Preserve validated sections, CTAs, and images unless source evidence says they are wrong.',
        ],
      },
    };
  }

  private buildHeuristicPostEditValidation(input: {
    componentName: string;
    page: AutomationComparePageResult;
    requestContextLines: string[];
    baselineAccuracy?: number | null;
  }): PostEditVisualValidationResult {
    const { componentName, page, requestContextLines, baselineAccuracy } =
      input;
    const accuracy =
      this.coerceFiniteNumber(page.visual?.accuracy) ??
      Number(
        Math.max(
          0,
          100 - (this.coerceFiniteNumber(page.visual?.diffPct) ?? 100),
        ).toFixed(2),
      );
    const diffPct = this.coerceFiniteNumber(page.visual?.diffPct) ?? 0;
    const contentStatus = page.content?.status ?? 'PASS';
    const hasHighRegion = (page.visual?.regions ?? []).some(
      (region) => region.severity === 'high',
    );
    const compareDropped =
      this.coerceFiniteNumber(baselineAccuracy) !== null &&
      accuracy + 8 < Number(baselineAccuracy);
    const targetPrompt = requestContextLines.join(' ').toLowerCase();
    const likelyStructuralEdit =
      /add|insert|section|layout|hero|banner|card|block|background|color|spacing|reorder|move/.test(
        targetPrompt,
      );

    const majorFailure =
      contentStatus === 'MISSING' ||
      accuracy < 45 ||
      diffPct >= 28 ||
      (hasHighRegion && diffPct >= 18);
    const mediumConcern =
      contentStatus === 'FAIL' ||
      accuracy < 65 ||
      diffPct >= 14 ||
      compareDropped;

    let passed = !majorFailure;
    let shouldRepair = majorFailure;
    let editIntentSatisfied = !majorFailure;
    let outOfScopeRegression =
      compareDropped || (hasHighRegion && diffPct >= 18);
    let wpParityAdvisoryOnly = false;
    let confidence = majorFailure ? 0.72 : mediumConcern ? 0.58 : 0.5;
    let summary =
      'Edited preview looks acceptable for the requested change, with WordPress used only as a secondary reference.';
    const issues: PostEditVisualValidationIssue[] = [];

    if (majorFailure) {
      summary =
        'Edited preview still shows a strong mismatch or regression after the user-requested change.';
      issues.push({
        type: likelyStructuralEdit ? 'edit_not_applied' : 'layout_regression',
        severity: 'high',
        target: page.route ?? page.visual?.reactPath ?? 'unknown',
        evidence:
          contentStatus === 'MISSING'
            ? 'Edited preview still has missing content on the target route.'
            : 'Edited preview still has a high visual mismatch score after the requested change.',
        suggestedAction:
          'Re-apply the requested change more explicitly and preserve the surrounding layout and data rendering.',
        inEditScope: true,
      });
      shouldRepair = true;
      editIntentSatisfied = false;
      passed = false;
    } else if (mediumConcern) {
      summary =
        'Edited preview mostly reflects the requested change, but there are still visible regressions or weak areas that should be reviewed.';
      issues.push({
        type: outOfScopeRegression ? 'scope_regression' : 'wp_drift_advisory',
        severity: outOfScopeRegression ? 'medium' : 'low',
        target: page.route ?? page.visual?.reactPath ?? 'unknown',
        evidence: outOfScopeRegression
          ? 'The edited preview appears to have drifted in nearby or unrelated areas after the requested change.'
          : 'The edited preview differs from WordPress, but the difference may be acceptable if it was intentional.',
        suggestedAction: outOfScopeRegression
          ? 'Tighten the edit scope and restore nearby unaffected layout/content.'
          : 'Review the difference manually before deciding whether to preserve or adjust it.',
        inEditScope: !outOfScopeRegression,
      });
      wpParityAdvisoryOnly = !outOfScopeRegression;
    }

    if (compareDropped) {
      issues.push({
        type: 'scope_regression',
        severity: 'medium',
        target: 'outside target area',
        evidence: `Edited preview accuracy dropped noticeably compared with the baseline (${baselineAccuracy} -> ${accuracy}).`,
        suggestedAction:
          'Inspect nearby sections and restore anything that regressed outside the requested edit scope.',
        inEditScope: false,
      });
    }

    return {
      componentName,
      routeKey: page.routeKey ?? null,
      route: page.route ?? page.visual?.reactPath ?? null,
      passed,
      shouldRepair,
      editIntentSatisfied,
      outOfScopeRegression,
      wpParityAdvisoryOnly,
      confidence,
      score: Number(Math.max(0, Math.min(100, accuracy)).toFixed(2)),
      analysisMode: 'heuristic',
      summary,
      issues,
      repairPlan: {
        strategy: shouldRepair
          ? 'edit-aware-targeted-repair'
          : wpParityAdvisoryOnly
            ? 'advisory-review-only'
            : 'post-edit-stability-check',
        instructions: shouldRepair
          ? [
              'Prioritize making the user-requested change clearly visible in the edited React preview.',
              'Preserve surrounding sections and avoid dragging the edited page back toward the original WordPress layout unless the request explicitly asked for that.',
            ]
          : [
              'Keep the requested edit as the source of truth.',
              'Only adjust nearby regressions if they materially harm the page outside the intended edit scope.',
            ],
        targetAreas: [
          {
            type: 'section',
            sectionHint: page.route ?? page.visual?.reactPath ?? undefined,
          },
        ],
        guardrails: [
          'Do not undo the approved user-requested edit just to improve WordPress parity.',
          'Preserve build/runtime safety and existing data bindings.',
          'Keep unrelated sections stable unless there is clear evidence of regression.',
        ],
      },
    };
  }

  private buildHeuristicIssues(input: {
    primary: VisualMismatchRootCause;
    missingLabels: string[];
    contentStatus: string;
    sectionLikelyMissingFromPlan: boolean;
    diffPct: number;
    extraDiffPct: number;
    domSimilarity: number;
  }): VisualMismatchIssue[] {
    const {
      primary,
      missingLabels,
      contentStatus,
      sectionLikelyMissingFromPlan,
      diffPct,
      extraDiffPct,
      domSimilarity,
    } = input;

    if (sectionLikelyMissingFromPlan && missingLabels.length > 0) {
      return missingLabels.slice(0, 3).map((label) => ({
        type: 'missing_section',
        severity: 'high',
        sectionHint: label,
        location: 'missing from current React output',
        evidence: `Source-backed heading/text "${label}" appears in WordPress evidence but not in the current plan/rendered React output.`,
        suggestedFix:
          'Insert the missing section using source-backed content from the approved plan/DB evidence.',
        sourceBacked: true,
      }));
    }

    if (primary === 'data-binding-error' || contentStatus === 'MISSING') {
      return [
        {
          type: 'content_missing',
          severity: 'high',
          location: 'page content/data bindings',
          evidence:
            'Content compare reports missing source-backed content in the React output.',
          suggestedFix:
            'Restore the missing bindings and render the source-backed content instead of placeholder or omitted output.',
          sourceBacked: true,
        },
      ];
    }

    if (primary === 'missing-section' || extraDiffPct >= 8) {
      return [
        {
          type: 'missing_section',
          severity: 'high',
          location: 'large vertical mismatch band',
          evidence:
            'Visual diff shows a large extra-height mismatch consistent with an omitted section.',
          suggestedFix:
            'Restore the missing section and preserve neighboring layout.',
          sourceBacked: true,
        },
      ];
    }

    if (primary === 'layout-drift' || domSimilarity < 75 || diffPct >= 8) {
      return [
        {
          type: 'layout_mismatch',
          severity: diffPct >= 20 ? 'high' : 'medium',
          location: 'highest-diff region',
          evidence:
            'The React structure and spacing diverge noticeably from the WordPress reference in the highest-diff region.',
          suggestedFix:
            'Adjust section layout, wrapper structure, and spacing to match the WordPress reference more closely without inventing new content.',
          sourceBacked: false,
        },
      ];
    }

    return [
      {
        type: 'unknown',
        severity: 'medium',
        location: 'general visual drift',
        evidence:
          'Compare metrics indicate a mismatch, but the root cause is not obvious from heuristics alone.',
        suggestedFix:
          'Review the highest-diff region and align the React output to the WordPress visual structure.',
        sourceBacked: false,
      },
    ];
  }

  private resolvePreferredVisionModel(modelName: string): string | null {
    const candidates = [
      modelName,
      this.configService.get<string>('pipeline.reviewCodeModel', ''),
      this.configService.get<string>('pipeline.planningModel', ''),
      'openai/gpt-5.4',
      'gpt-5.4',
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (this.canUseOpenAiVisionModel(candidate)) {
        return this.resolveOpenAiModelName(candidate);
      }
    }

    return null;
  }

  private canUseOpenAiVisionModel(modelName: string): boolean {
    return this.resolveOpenAiModelName(modelName) === 'gpt-5.4';
  }

  private resolveOpenAiModelName(modelName: string): string {
    const trimmed = modelName.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('openai/')) {
      return trimmed.slice('openai/'.length);
    }
    if (trimmed.startsWith('custom/')) {
      return '';
    }
    return trimmed;
  }

  private coerceFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
