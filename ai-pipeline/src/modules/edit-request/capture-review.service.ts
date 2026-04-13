import { Injectable } from '@nestjs/common';
import type { GeneratedComponent } from '../agents/react-generator/react-generator.service.js';
import type { PlanResult } from '../agents/planner/planner.service.js';
import type { PipelineEditRequestDto } from '../orchestrator/orchestrator.dto.js';
import type { PostMigrationEditTask } from './edit-request-phase.service.js';
import type { CaptureSectionMatch } from './capture-section-matcher.service.js';

export type CaptureReviewStatus = 'matched' | 'partial' | 'failed';

export interface CaptureReviewIssue {
  severity: 'high' | 'medium' | 'low';
  message: string;
}

export interface CaptureAttachmentReviewResult {
  attachmentId: string;
  componentName: string;
  editedComponentName: string;
  scope: 'component' | 'section';
  status: CaptureReviewStatus;
  confidence: number;
  matchedSectionIndex?: number;
  matchedSectionType?: string;
  summary: string;
  issues: CaptureReviewIssue[];
  suggestedFixFeedback?: string;
  debugSummary: string;
}

export interface CaptureReviewResult {
  success: boolean;
  summary: string;
  results: CaptureAttachmentReviewResult[];
  failures: CaptureAttachmentReviewResult[];
}

@Injectable()
export class CaptureReviewService {
  reviewFocusedTasks(input: {
    tasks: PostMigrationEditTask[];
    request?: PipelineEditRequestDto;
    plan: PlanResult;
    components: GeneratedComponent[];
    editedComponentNames?: Record<string, string>;
  }): CaptureReviewResult {
    const { tasks, request, plan, components, editedComponentNames } = input;
    const results = tasks.flatMap((task) =>
      this.reviewFocusedTask({
        task,
        request,
        plan,
        components,
        editedComponentName: editedComponentNames?.[task.componentName],
      }),
    );
    const failures = results.filter((result) => result.status === 'failed');
    const partials = results.filter((result) => result.status === 'partial');

    return {
      success: failures.length === 0,
      summary: `captureReviews=${results.length}, failed=${failures.length}, partial=${partials.length}, matched=${results.length - failures.length - partials.length}`,
      results,
      failures,
    };
  }

  reviewFocusedTask(input: {
    task: PostMigrationEditTask;
    request?: PipelineEditRequestDto;
    plan: PlanResult;
    components: GeneratedComponent[];
    editedComponentName?: string;
  }): CaptureAttachmentReviewResult[] {
    const { task, request, plan, components } = input;
    const reviewedComponentName =
      input.editedComponentName ??
      this.resolveReviewedComponentName(task, components) ??
      task.componentName;
    const reviewedComponent = components.find(
      (component) => component.name === reviewedComponentName,
    );
    const componentPlan = plan.find(
      (entry) => entry.componentName === task.planComponentName,
    );

    return task.attachments.map((attachment) => {
      const sectionMatch = pickAttachmentMatch(
        task.sectionMatches,
        attachment.id,
      );
      const issues: CaptureReviewIssue[] = [];
      const reasons: string[] = [];
      let score = 0;

      if (!reviewedComponent) {
        issues.push({
          severity: 'high',
          message: `Edited component "${reviewedComponentName}" is missing from the generated component set.`,
        });
      } else {
        score += 20;
        reasons.push('component-present');
      }

      const attachmentRoute =
        attachment.targetNode?.route ??
        attachment.captureContext?.page?.route ??
        attachment.sourcePageUrl ??
        null;
      const routeMatches =
        !task.route || !attachmentRoute
          ? Boolean(task.route || attachmentRoute)
          : routeMatchesPath(task.route, attachmentRoute);
      if (routeMatches) {
        score += 10;
        reasons.push('route-match');
      } else if (task.route && attachmentRoute) {
        issues.push({
          severity: 'high',
          message: `Attachment route "${attachmentRoute}" does not match task route "${task.route}".`,
        });
      }

      if (sectionMatch) {
        score += Math.min(20, Math.max(6, sectionMatch.score));
        reasons.push(`section-${sectionMatch.sectionType}`);
      } else if ((task.sectionMatches?.length ?? 0) > 0) {
        issues.push({
          severity: 'medium',
          message:
            'No section match was retained for this attachment during post-edit review.',
        });
      }

      const scope = resolveScope(task.planComponentName, reviewedComponentName);
      if (scope === 'section') {
        score += 8;
        reasons.push('section-scope');
      } else {
        score += 4;
        reasons.push('component-scope');
      }

      const intentSignals = collectIntentSignals(
        attachment.note ?? request?.prompt,
      );
      const componentCode = reviewedComponent?.code ?? '';
      const coveredSignals = intentSignals.filter((signal) =>
        signal.pattern.test(componentCode),
      );
      if (coveredSignals.length > 0) {
        score += Math.min(18, coveredSignals.length * 6);
        reasons.push(
          ...coveredSignals.map((signal) => `signal:${signal.name}`),
        );
      } else if (intentSignals.length > 0) {
        issues.push({
          severity: 'medium',
          message:
            'The edited component code does not show obvious evidence for the requested UI change keywords.',
        });
      }

      if (componentPlan?.route && attachmentRoute && !routeMatches) {
        issues.push({
          severity: 'medium',
          message: `Component plan route "${componentPlan.route}" and attachment route "${attachmentRoute}" do not align cleanly.`,
        });
      }

      if (!attachment.asset?.publicUrl) {
        issues.push({
          severity: 'low',
          message:
            'Attachment is missing a public image URL, so visual verification evidence is incomplete.',
        });
      }

      const normalizedScore = clamp(score / 60, 0, 1);
      const status = deriveStatus(normalizedScore, issues);
      const summary = buildResultSummary({
        attachmentId: attachment.id,
        reviewedComponentName,
        scope,
        sectionMatch,
        reasons,
        status,
      });

      return {
        attachmentId: attachment.id,
        componentName: task.componentName,
        editedComponentName: reviewedComponentName,
        scope,
        status,
        confidence: normalizedScore,
        matchedSectionIndex: sectionMatch?.sectionIndex,
        matchedSectionType: sectionMatch?.sectionType,
        summary,
        issues,
        suggestedFixFeedback:
          status === 'matched'
            ? undefined
            : buildSuggestedFixFeedback({
                task,
                attachmentNote: attachment.note,
                reviewedComponentName,
                scope,
                sectionMatch,
                issues,
              }),
        debugSummary: [
          `attachment=${attachment.id}`,
          `target=${task.componentName}`,
          task.planComponentName !== task.componentName
            ? `planTarget=${task.planComponentName}`
            : null,
          `edited=${reviewedComponentName}`,
          `scope=${scope}`,
          sectionMatch
            ? `section[${sectionMatch.sectionIndex}]=${sectionMatch.sectionType}`
            : 'section=none',
          `score=${normalizedScore.toFixed(2)}`,
          `status=${status}`,
        ]
          .filter((value): value is string => Boolean(value))
          .join(' | '),
      };
    });
  }

  summarizeFailures(results: CaptureAttachmentReviewResult[]): string[] {
    return results
      .filter((result) => result.status !== 'matched')
      .map(
        (result) =>
          `${result.attachmentId} -> ${result.editedComponentName} (${result.status}, ${result.confidence.toFixed(2)}): ${result.issues.map((issue) => issue.message).join(' | ') || result.summary}`,
      );
  }

  private resolveReviewedComponentName(
    task: PostMigrationEditTask,
    components: GeneratedComponent[],
  ): string | undefined {
    if (components.some((component) => component.name === task.componentName)) {
      return task.componentName;
    }

    for (const match of task.sectionMatches) {
      const candidateName = `${task.planComponentName}Section${match.sectionIndex + 1}`;
      if (components.some((component) => component.name === candidateName)) {
        return candidateName;
      }
    }

    if (
      components.some((component) => component.name === task.planComponentName)
    ) {
      return task.planComponentName;
    }

    return undefined;
  }
}

interface IntentSignal {
  name: string;
  pattern: RegExp;
}

function pickAttachmentMatch(
  matches: CaptureSectionMatch[],
  attachmentId: string,
): CaptureSectionMatch | undefined {
  return matches
    .filter((match) => match.attachmentId === attachmentId)
    .sort((left, right) => right.score - left.score)[0];
}

function resolveScope(
  componentName: string,
  reviewedComponentName: string,
): 'component' | 'section' {
  return reviewedComponentName !== componentName ? 'section' : 'component';
}

function collectIntentSignals(note?: string): IntentSignal[] {
  const normalized = normalizeToken(note);
  if (!normalized) return [];

  const signals: IntentSignal[] = [];
  if (/\b(background|bg|nen|hero|banner|cover)\b/.test(normalized)) {
    signals.push({
      name: 'background',
      pattern: /\b(bg-|background|linear-gradient|from-|to-|via-)\b/i,
    });
  }
  if (/\b(text|title|heading|copy|chu|tieu de|noi dung)\b/.test(normalized)) {
    signals.push({
      name: 'text',
      pattern: /\b(text-|color\s*:|font-|leading-|tracking-)\b/i,
    });
  }
  if (/\b(button|cta|link)\b/.test(normalized)) {
    signals.push({
      name: 'cta',
      pattern: /\b(button|cta|href=|onClick|rounded-|px-|py-)\b/i,
    });
  }
  if (
    /\b(padding|spacing|space|margin|gap|height|width|size)\b/.test(normalized)
  ) {
    signals.push({
      name: 'spacing',
      pattern:
        /\b(padding|margin|gap|space-|px-|py-|pt-|pb-|pl-|pr-|mt-|mb-|ml-|mr-|h-|w-)\b/i,
    });
  }
  if (/\b(image|img|photo|media|video)\b/.test(normalized)) {
    signals.push({
      name: 'media',
      pattern: /\b(img|image|video|object-cover|aspect-|figure)\b/i,
    });
  }
  return signals;
}

function deriveStatus(
  confidence: number,
  issues: CaptureReviewIssue[],
): CaptureReviewStatus {
  const hasHighSeverity = issues.some((issue) => issue.severity === 'high');
  if (hasHighSeverity || confidence < 0.4) return 'failed';
  if (issues.length > 0 || confidence < 0.7) return 'partial';
  return 'matched';
}

function buildResultSummary(input: {
  attachmentId: string;
  reviewedComponentName: string;
  scope: 'component' | 'section';
  sectionMatch?: CaptureSectionMatch;
  reasons: string[];
  status: CaptureReviewStatus;
}): string {
  const {
    attachmentId,
    reviewedComponentName,
    scope,
    sectionMatch,
    reasons,
    status,
  } = input;
  return [
    `attachment=${attachmentId}`,
    `edited=${reviewedComponentName}`,
    `scope=${scope}`,
    sectionMatch
      ? `section[${sectionMatch.sectionIndex}]=${sectionMatch.sectionType}`
      : 'section=none',
    `status=${status}`,
    reasons.length > 0 ? `via ${reasons.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

function buildSuggestedFixFeedback(input: {
  task: PostMigrationEditTask;
  attachmentNote?: string;
  reviewedComponentName: string;
  scope: 'component' | 'section';
  sectionMatch?: CaptureSectionMatch;
  issues: CaptureReviewIssue[];
}): string {
  const {
    task,
    attachmentNote,
    reviewedComponentName,
    scope,
    sectionMatch,
    issues,
  } = input;
  const lines = [
    `Capture review follow-up for "${reviewedComponentName}".`,
    `Original focused request: ${attachmentNote ?? task.feedback}`,
    `Scope restriction: stay within ${scope === 'section' ? 'the matched section/subcomponent' : 'this component'} and avoid unrelated page-wide changes.`,
  ];

  if (sectionMatch) {
    lines.push(
      `Prioritize section[${sectionMatch.sectionIndex}] ${sectionMatch.sectionType} for this correction.`,
    );
  }

  if (issues.length > 0) {
    lines.push('Fix the following capture-review issues:');
    for (const issue of issues) {
      lines.push(`- [${issue.severity}] ${issue.message}`);
    }
  }

  lines.push(
    'Return a complete corrected TSX component that satisfies the capture request more precisely.',
  );
  return lines.join('\n');
}

function routeMatchesPath(
  expected?: string | null,
  actual?: string | null,
): boolean {
  const left = normalizeRoute(expected);
  const right = normalizeRoute(actual);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left === '/') return right === '/';
  return right.startsWith(`${left}/`);
}

function normalizeRoute(value?: string | null): string | null {
  if (!value) return null;
  try {
    value = new URL(value).pathname;
  } catch {
    value = value.startsWith('/') ? value : `/${value}`;
  }
  const normalized = value
    .trim()
    .replace(/\/:\w+(?=\/|$)/g, '')
    .replace(/\*$/g, '')
    .replace(/\/+$/g, '');
  return normalized || '/';
}

function normalizeToken(value?: string | null): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
