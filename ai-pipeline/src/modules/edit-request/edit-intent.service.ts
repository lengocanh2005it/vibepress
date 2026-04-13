import { Injectable, Logger } from '@nestjs/common';
import { LlmFactoryService } from '../../common/llm/llm-factory.service.js';
import type {
  EditIntentDecision,
  EditIntentCategory,
  ValidatedEditRequest,
} from './edit-request.types.js';

@Injectable()
export class EditIntentService {
  private readonly logger = new Logger(EditIntentService.name);

  constructor(private readonly llmFactory: LlmFactoryService) {}

  async evaluate(input: ValidatedEditRequest): Promise<EditIntentDecision> {
    if (input.mode === 'none') {
      return {
        accepted: true,
        mode: input.mode,
        category: 'full_site_migration',
        request: undefined,
        globalIntent: 'Migrate the full site to React.',
        confidence: 1,
        source: 'heuristic',
      };
    }

    if (input.mode === 'capture') {
      try {
        return await this.evaluateWithLlm(input);
      } catch (error: unknown) {
        this.logger.warn(
          `Falling back to heuristic capture intent evaluation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          accepted: true,
          mode: input.mode,
          category: 'full_site_migration_with_focus',
          request: input.request,
          globalIntent:
            'Migrate the full site to React. Prioritize fidelity for the selected captured areas.',
          focusHint: 'Focused instructions come from the selected captures.',
          confidence: 0.65,
          source: 'heuristic',
        };
      }
    }

    const prompt = input.request?.prompt ?? '';
    const normalized = normalizeText(prompt);

    if (looksOutOfScope(normalized)) {
      return {
        accepted: false,
        mode: input.mode,
        category: 'invalid',
        request: input.request,
        globalIntent: '',
        confidence: 0.95,
        source: 'heuristic',
        rejectionCode: 'OUT_OF_SCOPE',
        userMessage:
          'This prompt does not look like a site migration or UI-focused request.',
      };
    }

    if (!looksLikeMigrationIntent(normalized)) {
      return {
        accepted: false,
        mode: input.mode,
        category: 'invalid',
        request: input.request,
        globalIntent: '',
        confidence: 0.9,
        source: 'heuristic',
        rejectionCode: 'UNCLEAR_INTENT',
        userMessage:
          'Describe either a full-site migration intent or a page-level focus for the migration.',
      };
    }

    try {
      return await this.evaluateWithLlm(input);
    } catch (error: unknown) {
      this.logger.warn(
        `Falling back to heuristic no-capture intent evaluation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const category: EditIntentCategory = mentionsFocusTarget(normalized)
      ? 'full_site_migration_with_focus'
      : 'full_site_migration';

    return {
      accepted: true,
      mode: input.mode,
      category,
      request: input.request,
      globalIntent:
        category === 'full_site_migration_with_focus'
          ? 'Migrate the full site to React, with extra fidelity on the focused page or area described by the user.'
          : 'Migrate the full site to React.',
      focusHint:
        category === 'full_site_migration_with_focus'
          ? prompt.trim()
          : undefined,
      confidence: 0.7,
      source: 'heuristic',
    };
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
    const category: EditIntentCategory = parsed.accepted
      ? parsed.category === 'full_site_migration_with_focus'
        ? 'full_site_migration_with_focus'
        : 'full_site_migration'
      : 'invalid';

    return {
      accepted: parsed.accepted,
      mode: input.mode,
      category,
      request: input.request,
      globalIntent: parsed.accepted
        ? parsed.category === 'full_site_migration_with_focus'
          ? 'Migrate the full site to React, with extra fidelity on the focused page or area described by the user.'
          : 'Migrate the full site to React.'
        : '',
      focusHint:
        parsed.accepted && parsed.category === 'full_site_migration_with_focus'
          ? parsed.focusHint?.trim() || input.request?.prompt?.trim()
          : undefined,
      confidence: parsed.confidence,
      source: 'llm',
      rejectionCode: parsed.accepted
        ? undefined
        : (parsed.rejectionCode ?? 'UNCLEAR_INTENT'),
      userMessage: parsed.accepted
        ? undefined
        : (parsed.userMessage ??
          'The request could not be understood as a valid migration instruction.'),
    };
  }
}

interface IntentClassifierResponse {
  accepted: boolean;
  category:
    | 'full_site_migration'
    | 'full_site_migration_with_focus'
    | 'invalid';
  focusHint?: string;
  confidence?: number;
  rejectionCode?: 'UNCLEAR_INTENT' | 'OUT_OF_SCOPE';
  userMessage?: string;
}

const INTENT_SYSTEM_PROMPT = `You classify incoming requests for a WordPress-to-React migration product.
Input may be in English, Vietnamese, or mixed English/Vietnamese.

Hard rules:
- The product ALWAYS migrates the full site.
- A request may still mention one page or area. That means "full-site migration with focus", not single-page migration.
- If captures exist, they are focused local instructions. The global scope is still full-site migration.
- If captures exist, a main prompt may still be present as extra text guidance. Treat captures as visual evidence and the main prompt as additional instruction, not as a conflict.
- Accept requests about adding or integrating new page-level features during migration, such as widgets, forms, promos, interactive modules, lucky wheel sections, signup blocks, chat blocks, or similar UI functionality.
- Reject anything unrelated to site migration, UI refinement during migration, visual fidelity, layout changes, styling changes, feature additions during migration, or page-focused migration guidance.

Return ONLY valid JSON with this exact shape:
{
  "accepted": boolean,
  "category": "full_site_migration" | "full_site_migration_with_focus" | "invalid",
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
    `Prompt: ${request?.prompt?.trim() || '(empty)'}`,
  ];

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
        `- id=${attachment.id}; note=${attachment.note?.trim() || '(empty)'}; page=${attachment.sourcePageUrl ?? '(none)'}`,
      );
    }
  }

  lines.push(
    'Decide whether this request should be accepted for full-site migration, or full-site migration with a focused page/area, or rejected.',
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
      'invalid',
    ].includes(parsed.category)
  ) {
    throw new Error('LLM intent classifier returned an invalid category');
  }
  return parsed;
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
    /\b(improve|update|adjust|refine|redesign|restyle|focus|preserve|change|make|toi uu|dieu chinh|chinh sua|giu nguyen|doi mau|tap trung)\b/.test(
      normalized,
    );
  const featureSignal =
    /\b(add|insert|create|build|integrate|enable|introduce|implement|feature|functionality|widget|module|popup|modal|form|signup|newsletter|chatbot|chat|calculator|booking|spin|lucky wheel|wheel|carousel|faq|search|filter|them|chen|tao|xay dung|tich hop|bat|bo sung|tinh nang|chuc nang|widget|module|popup|form|dang ky|newsletter|chatbot|vong quay|quay thuong|faq|tim kiem|bo loc)\b/.test(
      normalized,
    );
  const scopeSignal =
    /\b(site|website|wordpress|theme|all pages|full site|whole site|entire site|toan bo|ca trang|toan site|toan website)\b/.test(
      normalized,
    );
  const focusSignal = mentionsFocusTarget(normalized);

  return (
    migrationSignal ||
    ((uiSignal || featureSignal) && (scopeSignal || focusSignal))
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
