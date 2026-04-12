import {
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PipelineIncomingEditRequestDto } from '../orchestrator/orchestrator.dto.js';
import { EditIntentService } from './edit-intent.service.js';
import { EditRequestService } from './edit-request.service.js';
import { EditRequestTargetResolverService } from './edit-request-target-resolver.service.js';
import { EditRequestValidatorService } from './edit-request-validator.service.js';
import type { ResolvedEditRequestContext } from './edit-request.types.js';

type SupportedRequestLanguage = 'vi' | 'en';

@Injectable()
export class EditRequestFacadeService {
  constructor(
    private readonly editRequestService: EditRequestService,
    private readonly editRequestValidator: EditRequestValidatorService,
    private readonly editRequestTargetResolver: EditRequestTargetResolverService,
    private readonly editIntentService: EditIntentService,
  ) {}

  async resolveOrThrow(
    raw?: PipelineIncomingEditRequestDto,
  ): Promise<ResolvedEditRequestContext> {
    const prepared = this.editRequestService.prepare(raw);
    const requestLanguage = resolveRequestLanguage(raw, prepared.request?.language);
    const preparedWithResolvedTarget = prepared.request
      ? {
          ...prepared,
          request: this.editRequestTargetResolver.resolve(prepared.request),
        }
      : prepared;
    const validated = this.editRequestValidator.validate(
      preparedWithResolvedTarget,
    );

    if ('code' in validated) {
      throw new UnprocessableEntityException({
        success: false,
        code: validated.code,
        message: localizeEditRequestError(validated.code, requestLanguage),
        details: {
          source: preparedWithResolvedTarget.summary.source,
          attachmentCount: preparedWithResolvedTarget.summary.attachmentCount,
        },
      });
    }

    const decision = await this.editIntentService.evaluate(validated);
    if (!decision.accepted) {
      const rejectionCode = decision.rejectionCode ?? 'INVALID_EDIT_REQUEST';
      throw new UnprocessableEntityException({
        success: false,
        code: rejectionCode,
        message: localizeEditRequestError(
          rejectionCode,
          requestLanguage,
          decision.userMessage,
        ),
        details: {
          mode: decision.mode,
          category: decision.category,
        },
      });
    }

    return {
      accepted: true,
      mode: decision.mode,
      category: decision.category,
      request: decision.request,
      summary: preparedWithResolvedTarget.summary,
      globalIntent: decision.globalIntent,
      focusHint: decision.focusHint,
      confidence: decision.confidence,
      source: decision.source,
    };
  }
}

function resolveRequestLanguage(
  raw: PipelineIncomingEditRequestDto | undefined,
  preparedLanguage?: string,
): SupportedRequestLanguage {
  if (preparedLanguage === 'vi' || preparedLanguage === 'en') {
    return preparedLanguage;
  }

  const rawLanguage =
    raw && 'language' in raw ? normalizeLanguage(raw.language) : undefined;

  return rawLanguage ?? 'en';
}

function normalizeLanguage(
  language?: string,
): SupportedRequestLanguage | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('vi')) return 'vi';
  if (normalized.startsWith('en')) return 'en';
  if (normalized === 'vietnamese' || normalized === 'tieng viet') return 'vi';
  if (normalized === 'english') return 'en';
  return undefined;
}

function localizeEditRequestError(
  code: string,
  language: SupportedRequestLanguage,
  fallbackMessage?: string,
): string {
  const messages: Record<string, Record<SupportedRequestLanguage, string>> = {
    MAIN_PROMPT_REQUIRED: {
      vi: 'Hãy nhập một yêu cầu migrate rõ ràng khi chưa đính kèm capture.',
      en: 'Add a clear migration prompt when no captures are attached.',
    },
    MAIN_PROMPT_NOT_ALLOWED_WITH_CAPTURES: {
      vi: 'Khi đã chọn capture, hãy dùng note trên từng capture thay vì prompt chính.',
      en: 'When captures are selected, use capture notes instead of the main prompt.',
    },
    MAIN_PROMPT_WITH_CAPTURES_MUST_BE_FEATURE_REQUEST: {
      vi: 'Khi đã có capture, prompt chính chỉ được dùng để yêu cầu thêm chức năng mới. Các chỉnh sửa giao diện cục bộ hãy ghi trong note của từng capture.',
      en: 'When captures are attached, the main prompt is only allowed for requesting a new feature. Keep local UI edits inside each capture note.',
    },
    SUPPLEMENTAL_PROMPT_TOO_VAGUE: {
      vi: 'Khi đã có capture, prompt chính vẫn phải là một chỉ dẫn rõ ràng. Các nội dung như "hello" hoặc "test" sẽ bị chặn.',
      en: 'When captures are attached, the main prompt must still be a clear additional instruction. Inputs like "hello" or "test" are rejected.',
    },
    SUPPLEMENTAL_PROMPT_TARGET_REQUIRED: {
      vi: 'Nếu bạn muốn thêm chức năng mới khi đã có capture, hãy nói rõ nó cần nằm ở page hoặc khu vực nào.',
      en: 'When requesting a new feature with captures attached, also describe which page or area it should go into.',
    },
    CAPTURE_NOTE_REQUIRED: {
      vi: 'Mỗi capture đã chọn cần có một yêu cầu chỉnh sửa rõ ràng trước khi gửi cho AI.',
      en: 'Each selected capture must include a clear edit request before sending to AI.',
    },
    CAPTURE_NOTE_TOO_VAGUE: {
      vi: 'Note của mỗi capture phải mô tả thay đổi UI cụ thể, không chỉ ghi chung chung như Home, header hoặc fix this.',
      en: 'Each capture note must describe a concrete UI change, not just a generic label like Home, header, or fix this.',
    },
    FOCUS_TARGET_ACTION_REQUIRED: {
      vi: 'Nếu bạn nhắc đến một page như Home, hãy nói rõ phần nào trên đó cần thay đổi.',
      en: 'When you mention a page like Home, also describe what should change there.',
    },
    UNCLEAR_INTENT: {
      vi: 'Yêu cầu chưa đủ rõ. Hãy mô tả migrate toàn bộ site hoặc migrate toàn site kèm focus vào một page/khu vực cụ thể.',
      en: 'Describe either a full-site migration intent or a page-level focus for the migration.',
    },
    OUT_OF_SCOPE: {
      vi: 'Yêu cầu này không giống một tác vụ migrate site hoặc chỉnh sửa UI trong quá trình migrate.',
      en: 'This prompt does not look like a site migration or UI-focused request.',
    },
    INVALID_EDIT_REQUEST: {
      vi: 'Không thể hiểu yêu cầu này như một chỉ dẫn migrate hợp lệ.',
      en: 'The request could not be understood as a valid migration instruction.',
    },
  };

  return messages[code]?.[language] ?? fallbackMessage ?? messages.INVALID_EDIT_REQUEST[language];
}
