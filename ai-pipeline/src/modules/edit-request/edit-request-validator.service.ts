import { Injectable } from '@nestjs/common';
import type { PipelineEditRequestDto } from '../orchestrator/orchestrator.dto.js';
import type {
  EditRequestMode,
  EditRequestRejectionCode,
  EditRequestPreparationResult,
  ValidatedEditRequest,
} from './edit-request.types.js';

export interface EditRequestValidationFailure {
  code: EditRequestRejectionCode;
  message: string;
}

@Injectable()
export class EditRequestValidatorService {
  validate(
    prepared: EditRequestPreparationResult,
  ): ValidatedEditRequest | EditRequestValidationFailure {
    const request = prepared.request;
    const mode = this.detectMode(request);

    if (mode === 'none') {
      return {
        mode,
        request: undefined,
        summary: prepared.summary,
      };
    }

    if (mode === 'capture') {
      if (request?.prompt && !this.isMeaningfulSupplementalPrompt(request.prompt)) {
        return {
          code: 'SUPPLEMENTAL_PROMPT_TOO_VAGUE',
          message:
            'When captures are attached, the main prompt must still be a clear additional instruction.',
        };
      }

      if (
        request?.prompt &&
        this.isFeaturePromptWithoutTarget(request.prompt)
      ) {
        return {
          code: 'SUPPLEMENTAL_PROMPT_TARGET_REQUIRED',
          message:
            'When requesting a new feature with captures attached, also describe which page or area it should go into.',
        };
      }

      const attachmentsMissingNotes =
        request?.attachments?.filter(
          (attachment) => !attachment.note?.trim(),
        ) ?? [];
      if (attachmentsMissingNotes.length > 0) {
        return {
          code: 'CAPTURE_NOTE_REQUIRED',
          message:
            'Each selected capture must include a clear edit request before sending to AI.',
        };
      }

      const attachmentsWithVagueNotes =
        request?.attachments?.filter(
          (attachment) => !this.isSpecificCaptureNote(attachment.note),
        ) ?? [];
      if (attachmentsWithVagueNotes.length > 0) {
        return {
          code: 'CAPTURE_NOTE_TOO_VAGUE',
          message:
            'Each capture note must describe a concrete UI change, not just a generic label.',
        };
      }

      return {
        mode,
        request,
        summary: prepared.summary,
      };
    }

    if (!request?.prompt || !this.isMeaningfulPrompt(request.prompt)) {
      return {
        code: 'MAIN_PROMPT_REQUIRED',
        message:
          'Add a clear migration prompt when no captures are attached.',
      };
    }

    if (this.hasFocusTargetWithoutConcreteAction(request.prompt)) {
      return {
        code: 'FOCUS_TARGET_ACTION_REQUIRED',
        message:
          'When you mention a page like Home, also describe what should change there.',
      };
    }

    return {
      mode,
      request,
      summary: prepared.summary,
    };
  }

  isMeaningfulPrompt(prompt?: string): boolean {
    if (!prompt) return false;
    const normalized = normalizeText(prompt);
    if (normalized.length < 12) return false;
    if (
      [
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
        'test nhe',
        'sua cai nay',
        'doi cai nay',
      ].includes(stripVietnameseMarks(normalized))
    ) {
      return false;
    }
    return hasLettersAndSpaces(normalized);
  }

  private isMeaningfulSupplementalPrompt(prompt?: string): boolean {
    if (!prompt) return false;
    const normalized = normalizeText(prompt);
    const normalizedAscii = stripVietnameseMarks(normalized);

    if (normalized.length < 6) return false;
    if (
      [
        'hello',
        'hi',
        'test',
        'ok',
        'oke',
        'xin chao',
        'chao',
        'thu',
      ].includes(normalizedAscii)
    ) {
      return false;
    }

    return (
      hasConcreteEditAction(normalizedAscii) ||
      mentionsFocusTarget(normalizedAscii) ||
      hasFeatureSignal(normalizedAscii)
    );
  }

  private isFeaturePromptWithoutTarget(prompt: string): boolean {
    const normalized = stripVietnameseMarks(normalizeText(prompt));
    return hasFeatureSignal(normalized) && !hasScopeOrTargetHint(normalized);
  }

  private isMeaningfulCaptureNote(note?: string): boolean {
    if (!note) return false;
    const normalized = normalizeText(note);
    if (normalized.length < 6) return false;
    if (
      [
        'fix',
        'change',
        'edit',
        'update',
        'this',
        'sua',
        'doi',
        'cap nhat',
        'cho nay',
        'vung nay',
      ].includes(stripVietnameseMarks(normalized))
    ) {
      return false;
    }
    return hasLettersAndSpaces(normalized);
  }

  private isSpecificCaptureNote(note?: string): boolean {
    if (!this.isMeaningfulCaptureNote(note)) return false;
    const normalized = stripVietnameseMarks(normalizeText(note ?? ''));

    if (isGenericCapturePhrase(normalized)) {
      return false;
    }

    return hasConcreteEditAction(normalized);
  }

  private hasFocusTargetWithoutConcreteAction(prompt: string): boolean {
    const normalized = stripVietnameseMarks(normalizeText(prompt));
    return mentionsFocusTarget(normalized) && !hasConcreteEditAction(normalized);
  }

  private detectMode(request?: PipelineEditRequestDto): EditRequestMode {
    if (!request) return 'none';
    if ((request.attachments?.length ?? 0) > 0) return 'capture';
    if (request.prompt) return 'no_capture';
    return 'none';
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasLettersAndSpaces(value: string): boolean {
  return /\p{L}/u.test(value);
}

function stripVietnameseMarks(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function mentionsFocusTarget(value: string): boolean {
  return /\b(home|homepage|landing|about|contact|blog|header|hero|footer|navbar|section|page|trang chu|trang home|trang gioi thieu|trang lien he|dau trang|chan trang|khu vuc)\b/.test(
    value,
  );
}

function hasConcreteEditAction(value: string): boolean {
  return /\b(make|change|update|adjust|reduce|increase|move|align|center|replace|remove|add|keep|preserve|match|use|switch|resize|shrink|expand|hide|show|simplify|restyle|redesign|improve|fix|doi|sua|chinh sua|dieu chinh|giam|tang|can giua|can trai|can phai|thay|xoa|them|giu|bao toan|khop|dung|chuyen|thu nho|mo rong|an|hien|toi uu|lam nho|lam lon)\b/.test(
    value,
  );
}

function hasFeatureSignal(value: string): boolean {
  return /\b(feature|functionality|widget|module|popup|modal|form|signup|newsletter|chatbot|chat|calculator|booking|spin|lucky wheel|wheel|carousel|faq|search|filter|mini game|game|voucher|coupon|quiz|survey|tinh nang|chuc nang|dang ky|vong quay|quay thuong|tim kiem|bo loc|ma giam gia|khao sat)\b/.test(
    value,
  );
}

function hasScopeOrTargetHint(value: string): boolean {
  const scopeSignal =
    /\b(site|website|wordpress|theme|all pages|full site|whole site|entire site|toan bo|ca trang|toan site|toan website)\b/.test(
      value,
    );
  return scopeSignal || mentionsFocusTarget(value);
}

function isGenericCapturePhrase(value: string): boolean {
  return [
    'home page',
    'homepage',
    'trang home',
    'trang chu',
    'header',
    'hero',
    'footer',
    'section nay',
    'khu vuc nay',
    'cho nay',
    'cai nay',
    'lam dep hon',
    'dep hon',
    'fix giup',
    'sua giup',
    'change this',
    'fix this',
    'make it better',
    'improve this',
    'same here',
  ].includes(value);
}
