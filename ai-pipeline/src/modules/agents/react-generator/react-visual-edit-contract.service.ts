import { Injectable } from '@nestjs/common';
import type {
  PipelineReactVisualEditRequestDto,
  PipelinePreviewRouteEntryDto,
} from '../../orchestrator/orchestrator.dto.js';
import {
  detectUnsupportedEditRequestReason,
  type EditOperation,
} from '../../edit-request/edit-operation.util.js';
import type { PlanResult } from '../planner/planner.service.js';

export interface ReactVisualEditContractValidationInput {
  editRequest: PipelineReactVisualEditRequestDto;
  plan?: PlanResult;
  routeEntries?: PipelinePreviewRouteEntryDto[];
}

export interface ReactVisualEditContractValidationResult {
  normalizedRequest: PipelineReactVisualEditRequestDto;
  resolvedComponentName?: string;
  warnings: string[];
  editOperation: EditOperation;
}

@Injectable()
export class ReactVisualEditContractService {
  validate(
    input: ReactVisualEditContractValidationInput,
  ): ReactVisualEditContractValidationResult {
    const plan = input.plan ?? [];
    const hasPlan = plan.length > 0;
    const normalizedRequest = normalizeRequest(input.editRequest);
    const instructionText = buildInstructionText(normalizedRequest);
    const warnings: string[] = [];

    if (!instructionText) {
      throw new Error(
        'Add a concrete local visual edit request before sending it to the React visual editor.',
      );
    }

    if (!isMeaningfulVisualEditInstruction(instructionText)) {
      throw new Error(
        'The visual edit request is too vague. Describe a concrete local UI change such as spacing, colors, background, or content.',
      );
    }

    if (looksLikeBroadMigrationRequest(instructionText)) {
      throw new Error(
        'This endpoint only supports local visual patches on the existing React app. Use the main pipeline run flow for full-site migration or broad multi-page changes.',
      );
    }

    const unsupportedReason =
      detectUnsupportedEditRequestReason(instructionText);
    if (unsupportedReason) {
      throw new Error(buildUnsupportedOperationMessage(unsupportedReason));
    }

    const attachments = normalizedRequest.attachments ?? [];
    const firstAttachment = attachments[0];
    const route =
      normalizeRoute(
        normalizedRequest.targetHint?.route ??
          normalizedRequest.pageContext?.reactRoute ??
          firstAttachment?.captureContext?.page?.route,
      ) ?? undefined;
    const hintedComponentName =
      normalizedRequest.targetHint?.componentName?.trim() || undefined;
    const resolvedComponentName =
      hintedComponentName ||
      resolveComponentNameFromRoute(route, input.routeEntries);
    const sourceFile =
      normalizedRequest.targetHint?.sourceFile?.trim() || undefined;
    const outputFilePath =
      normalizedRequest.targetHint?.outputFilePath?.trim() || undefined;
    const hasTargetGeometry = attachments.some((attachment) =>
      Boolean(
        attachment.asset?.publicUrl?.trim() &&
        (attachment.geometry?.normalizedRect ||
          attachment.geometry?.documentRect ||
          attachment.geometry?.viewportRect ||
          attachment.selection),
      ),
    );

    if (
      attachments.length === 0 &&
      !resolvedComponentName &&
      !sourceFile &&
      !outputFilePath
    ) {
      throw new Error(
        'Select a concrete element in Inspector before submitting a post-generation visual edit.',
      );
    }

    if (
      attachments.length > 0 &&
      !hasTargetGeometry &&
      !resolvedComponentName &&
      !sourceFile
    ) {
      throw new Error(
        'The selected capture is missing target geometry. Re-select the element in Inspector and try again.',
      );
    }

    if (!route && !resolvedComponentName && !sourceFile && !outputFilePath) {
      throw new Error(
        'Could not determine which route/component should receive this visual edit.',
      );
    }

    if (attachments.length > 1) {
      warnings.push(
        'Multiple captures were attached. The current visual edit flow prioritizes the first exact target region.',
      );
    }

    if (sourceFile && !/\.(t|j)sx$/i.test(sourceFile)) {
      warnings.push(
        'The source file hint does not look like a TSX component file, so the backend may fall back to route/component resolution.',
      );
    }

    if (resolvedComponentName) {
      if (hasPlan) {
        const matchedComponent = plan.find(
          (component) => component.componentName === resolvedComponentName,
        );
        if (!matchedComponent) {
          throw new Error(
            `The requested visual edit targets component "${resolvedComponentName}", but that component was not found in the generated plan.`,
          );
        }
      } else {
        warnings.push(
          'Generated plan is unavailable for this reopened job. The backend will rely on the selected component/file hints instead.',
        );
      }
    } else if (route) {
      const matchedRoute = hasPlan
        ? plan.some((component) => normalizeRoute(component.route) === route)
        : false;
      if (hasPlan && !matchedRoute && !sourceFile && !outputFilePath) {
        throw new Error(
          `The requested visual edit points at route "${route}", but no generated page component could be matched to that route.`,
        );
      }
      if (hasPlan && !matchedRoute) {
        warnings.push(
          `The route "${route}" was not found in the planner output. The backend will rely on the source-file hint instead.`,
        );
      } else if (!hasPlan) {
        warnings.push(
          `Generated plan is unavailable for route "${route}". The backend will resolve the edit using the selected component, route map, and file hints.`,
        );
      }
    }

    const editOperation = detectEditOperationFromInstruction(instructionText);
    if (editOperation === 'general') {
      warnings.push(
        'The request does not map cleanly to a single edit category, so the backend will preserve scope conservatively around the selected target.',
      );
    }

    return {
      normalizedRequest,
      resolvedComponentName,
      warnings,
      editOperation,
    };
  }
}

function normalizeRequest(
  request: PipelineReactVisualEditRequestDto,
): PipelineReactVisualEditRequestDto {
  return {
    ...request,
    prompt: request.prompt?.trim() || undefined,
    pageContext: request.pageContext
      ? {
          ...request.pageContext,
          reactUrl: request.pageContext.reactUrl?.trim() || undefined,
          reactRoute:
            normalizeRoute(request.pageContext.reactRoute) || undefined,
          iframeSrc: request.pageContext.iframeSrc?.trim() || undefined,
          pageTitle: request.pageContext.pageTitle?.trim() || undefined,
        }
      : undefined,
    attachments:
      request.attachments?.map((attachment) => ({
        ...attachment,
        note: attachment.note?.trim() || undefined,
        sourcePageUrl: attachment.sourcePageUrl?.trim() || undefined,
        captureContext: attachment.captureContext
          ? {
              ...attachment.captureContext,
              iframeSrc:
                attachment.captureContext.iframeSrc?.trim() || undefined,
              page: attachment.captureContext.page
                ? {
                    ...attachment.captureContext.page,
                    url:
                      attachment.captureContext.page.url?.trim() || undefined,
                    route:
                      normalizeRoute(attachment.captureContext.page.route) ||
                      undefined,
                    title:
                      attachment.captureContext.page.title?.trim() || undefined,
                  }
                : undefined,
            }
          : undefined,
        asset: {
          ...attachment.asset,
          fileName: attachment.asset.fileName?.trim() || attachment.id,
          publicUrl:
            attachment.asset.publicUrl?.trim() || attachment.asset.publicUrl,
        },
      })) ?? undefined,
    targetHint: request.targetHint
      ? {
          ...request.targetHint,
          componentName: request.targetHint.componentName?.trim() || undefined,
          route: normalizeRoute(request.targetHint.route) || undefined,
          sourceFile: request.targetHint.sourceFile?.trim() || undefined,
          outputFilePath:
            request.targetHint.outputFilePath?.trim() || undefined,
          targetTextPreview:
            request.targetHint.targetTextPreview?.trim() || undefined,
        }
      : undefined,
  };
}

function buildInstructionText(
  request: PipelineReactVisualEditRequestDto,
): string {
  return [
    request.prompt?.trim(),
    ...(request.attachments ?? []).map((attachment) => attachment.note?.trim()),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim();
}

function normalizeRoute(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const normalized = parsed.pathname.replace(/\/+$/g, '');
    return normalized || '/';
  } catch {
    const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
    const prefixed = withoutQuery.startsWith('/')
      ? withoutQuery
      : `/${withoutQuery}`;
    const normalized = prefixed.replace(/\/+$/g, '');
    return normalized || '/';
  }
}

function resolveComponentNameFromRoute(
  route: string | undefined,
  routeEntries?: PipelinePreviewRouteEntryDto[],
): string | undefined {
  if (!route || !routeEntries?.length) return undefined;
  return routeEntries.find((entry) => normalizeRoute(entry.route) === route)
    ?.componentName;
}

function stripVietnameseMarks(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeText(value: string): string {
  return stripVietnameseMarks(value.trim().toLowerCase().replace(/\s+/g, ' '));
}

function isMeaningfulVisualEditInstruction(value: string): boolean {
  const normalized = normalizeText(value);
  if (normalized.length < 6) return false;
  return ![
    'hello',
    'hi',
    'test',
    'ok',
    'oke',
    'fix this',
    'change this',
    'xin chao',
    'chao',
    'thu',
    'sua cai nay',
    'doi cai nay',
  ].includes(normalized);
}

function looksLikeBroadMigrationRequest(value: string): boolean {
  const normalized = normalizeText(value);
  return /\b(migrate|migration|full site|whole site|entire site|all pages|toan bo|toan site|toan website|ca trang)\b/.test(
    normalized,
  );
}

function detectEditOperationFromInstruction(value: string): EditOperation {
  const normalized = normalizeText(value);
  const hasBackgroundSignal =
    /\b(background|bg|nen|overlay|gradient|hero background|banner background|mau nen)\b/.test(
      normalized,
    );
  const hasColorSignal =
    /\b(mau sac|doi mau|mau chu|text color|color|palette|theme color|bo mau|mau sac moi)\b/.test(
      normalized,
    );
  const hasLayoutSignal =
    /\b(layout|bo cuc|column|hang cot|doi layout|spacing|gap|padding|margin|align|can giua|can trai|can phai|center|rearrange|shrink|expand|reduce|increase)\b/.test(
      normalized,
    );
  const hasContentSignal =
    /\b(noi dung|van ban|text|tieu de|heading|doi noi dung|change content|update content|label|copy)\b/.test(
      normalized,
    );

  if (hasLayoutSignal) return 'change_layout';
  if (hasBackgroundSignal && !hasLayoutSignal && !hasContentSignal) {
    return 'change_background';
  }
  if (
    hasColorSignal &&
    !hasBackgroundSignal &&
    !hasLayoutSignal &&
    !hasContentSignal
  ) {
    return 'change_color';
  }
  if (hasContentSignal && !hasLayoutSignal) return 'change_content';
  return 'general';
}

function buildUnsupportedOperationMessage(reason: string): string {
  switch (reason) {
    case 'add-section-or-component':
      return 'React visual edit only supports local content, background, color, or layout patches. Adding new sections, widgets, or features is not supported here.';
    case 'replace-section-or-component':
      return 'React visual edit only supports local content, background, color, or layout patches. Replacing sections/components is not supported here.';
    case 'remove-section-or-component':
      return 'React visual edit only supports local content, background, color, or layout patches. Removing sections/components is not supported here.';
    case 'typography-change':
      return 'React visual edit only supports content, background, color, or layout changes. Typography-only edits are not supported here.';
    default:
      return 'React visual edit only supports local content, background, color, or layout patches.';
  }
}
