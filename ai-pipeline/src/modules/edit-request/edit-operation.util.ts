// ── Edit Operation Utilities ──────────────────────────────────────────────────
// Detects the edit operation type from user prompt and generates structured
// specs for section add/replace operations.

export type EditOperation =
  | 'change_layout' // đổi layout
  | 'change_content' // đổi nội dung
  | 'change_background' // đổi background
  | 'change_color' // đổi màu sắc
  | 'general'; // general / undetected

export const SUPPORTED_TARGETED_EDIT_OPERATIONS = [
  'change_content',
  'change_background',
  'change_color',
  'change_layout',
] as const satisfies readonly EditOperation[];

export function isSupportedTargetedEditOperation(
  operation: EditOperation | undefined,
): operation is (typeof SUPPORTED_TARGETED_EDIT_OPERATIONS)[number] {
  return (
    !!operation &&
    (SUPPORTED_TARGETED_EDIT_OPERATIONS as readonly string[]).includes(
      operation,
    )
  );
}

export function detectUnsupportedEditRequestReason(
  prompt: string,
): string | undefined {
  const normalized = normalizeOp(prompt);
  if (!normalized) return undefined;

  if (
    /\b(add|insert|create|introduce|them|chen|tao moi|bo sung)\b/.test(
      normalized,
    ) &&
    /\b(section|component|widget|feature|module|carousel|slider|modal|popup|tabs|accordion|faq|newsletter|form|chat|chatbot)\b/.test(
      normalized,
    )
  ) {
    return 'add-section-or-component';
  }

  if (
    /\b(replace|convert|switch|swap|thay the|doi thanh|chuyen thanh)\b/.test(
      normalized,
    ) &&
    /\b(section|component|widget|layout block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(
      normalized,
    )
  ) {
    return 'replace-section-or-component';
  }

  if (
    /\b(remove|delete|drop|xoa|bo)\b/.test(normalized) &&
    /\b(section|component|widget|block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(
      normalized,
    )
  ) {
    return 'remove-section-or-component';
  }

  if (
    /\b(font|typography|font-size|text size|line-height|letter-spacing|font weight|chu|co chu)\b/.test(
      normalized,
    )
  ) {
    return 'typography-change';
  }

  return undefined;
}

// ── Section type detection ────────────────────────────────────────────────────

export function detectSectionType(prompt: string): string | undefined {
  const n = normalizeOp(prompt);
  if (/\b(carousel|slider|swiper|bang chuyen|truot)\b/.test(n))
    return 'carousel';
  if (/\b(modal|popup|dialog|cua so boc|hop thoai)\b/.test(n)) return 'modal';
  if (/\b(accordion|faq|collapse|cau hoi thuong gap)\b/.test(n))
    return 'accordion';
  if (/\b(tabs|tab panel)\b/.test(n)) return 'tabs';
  if (/\b(card.?grid|card grid|grid bai viet|luoi)\b/.test(n))
    return 'card-grid';
  if (/\b(testimonial|review|nhan xet|cam nhan|danh gia khach hang)\b/.test(n))
    return 'testimonial';
  if (/\b(newsletter|subscribe|dang ky email|email form)\b/.test(n))
    return 'newsletter';
  if (/\b(cover)\b/.test(n)) return 'cover';
  if (/\b(hero|banner chinh)\b/.test(n)) return 'hero';
  if (/\b(media.?text|hinh anh.?chu|image.?text)\b/.test(n))
    return 'media-text';
  if (/\b(cta.?strip|cta strip|call to action strip)\b/.test(n))
    return 'cta-strip';
  return undefined;
}

// ── Edit operation detection ──────────────────────────────────────────────────

export function detectEditOperation(prompt: string): EditOperation {
  const n = normalizeOp(prompt);

  if (detectUnsupportedEditRequestReason(n)) {
    return 'general';
  }

  const hasBackgroundSignal =
    /\b(background|bg|nen|overlay|gradient|hero background|banner background|mau nen)\b/.test(
      n,
    );
  const hasColorSignal =
    /\b(mau sac|doi mau|mau chu|text color|color|palette|theme color|bo mau|mau sac moi)\b/.test(
      n,
    );
  const hasLayoutSignal =
    /\b(layout|bo cuc|cach sap xep|column|hang cot|trai phai|chia cot|doi layout|change layout|spacing|gap|padding|margin|align|can giua|can trai|can phai|center|left align|right align|rearrange)\b/.test(
      n,
    );
  const hasContentSignal =
    /\b(noi dung|van ban|chu viet|text|tieu de|heading|doi noi dung|change content|update content|noi dung moi)\b/.test(
      n,
    );

  // Style operations
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

  // Layout operations
  if (hasLayoutSignal) {
    return 'change_layout';
  }

  // Content operations
  if (hasContentSignal && !hasLayoutSignal) return 'change_content';

  return 'general';
}

// ── Instruction builder ───────────────────────────────────────────────────────

/**
 * Builds a concise operation instruction block to inject into the LLM feedback.
 * Returns empty string for `general` operation (no extra instruction needed).
 */
export function buildOperationInstruction(
  operation: EditOperation,
  prompt: string,
): string {
  switch (operation) {
    case 'change_layout':
      return [
        `OPERATION: CHANGE LAYOUT`,
        `Rearrange the visual structure as described in the request.`,
        `Allowed scope is limited to layout only: alignment, spacing, column distribution, ordering, sizing, and wrapper structure.`,
        `Preserve all content text, colors/backgrounds, data fetching, and API contracts.`,
        `Do NOT add, remove, or replace sections/components.`,
      ].join('\n');

    case 'change_background':
      return [
        `OPERATION: CHANGE BACKGROUND`,
        `Update ONLY the requested background treatment: solid background, gradient, overlay, or section background fill.`,
        `Preserve all layout, text content, foreground colors, typography scale, and data contracts.`,
        `Do NOT add, remove, move, or replace sections/components.`,
      ].join('\n');

    case 'change_color':
      return [
        `OPERATION: CHANGE COLORS`,
        `Update ONLY the requested foreground colors such as text, icon, border, or button colors.`,
        `Preserve all layout, backgrounds, typography scale, content text, and data contracts.`,
        `Do NOT restructure, move, add, remove, or replace any elements.`,
      ].join('\n');

    case 'change_content':
      return [
        `OPERATION: CHANGE CONTENT`,
        `Update ONLY the specified content (text, headings, labels, descriptions).`,
        `Preserve all layout, background, colors, spacing, and data contracts exactly as-is.`,
        `Do NOT add, remove, or replace sections/components.`,
      ].join('\n');

    default:
      return '';
  }
}

// ── Section spec generator ────────────────────────────────────────────────────

function buildSectionSpec(sectionType: string): string {
  switch (sectionType) {
    case 'carousel':
      return JSON.stringify(
        {
          type: 'carousel',
          slides: [
            {
              heading: 'Product 1',
              subheading: 'Brief description',
              imageSrc: '',
              imageAlt: 'Product 1',
            },
            {
              heading: 'Product 2',
              subheading: 'Brief description',
              imageSrc: '',
              imageAlt: 'Product 2',
            },
            {
              heading: 'Product 3',
              subheading: 'Brief description',
              imageSrc: '',
              imageAlt: 'Product 3',
            },
          ],
          autoplay: true,
          autoplaySpeed: 4000,
          loop: true,
          showDots: true,
          showArrows: true,
          contentAlign: 'center',
        },
        null,
        2,
      );

    case 'tabs':
      return JSON.stringify(
        {
          type: 'tabs',
          tabs: [
            { label: 'Tab 1', heading: 'Tab 1 Title', body: 'Tab 1 content.' },
            { label: 'Tab 2', heading: 'Tab 2 Title', body: 'Tab 2 content.' },
            { label: 'Tab 3', heading: 'Tab 3 Title', body: 'Tab 3 content.' },
          ],
          tabAlign: 'left',
          activeTab: 0,
        },
        null,
        2,
      );

    case 'accordion':
      return JSON.stringify(
        {
          type: 'accordion',
          items: [
            { heading: 'Question 1?', body: 'Answer 1.' },
            { heading: 'Question 2?', body: 'Answer 2.' },
            { heading: 'Question 3?', body: 'Answer 3.' },
          ],
          allowMultiple: false,
          enableToggle: true,
          defaultOpenItems: [0],
        },
        null,
        2,
      );

    case 'modal':
      return JSON.stringify(
        {
          type: 'modal',
          triggerText: 'Open',
          heading: 'Modal Heading',
          body: 'Modal body content.',
          layout: 'centered',
          closeOnOverlay: true,
          closeOnEsc: true,
        },
        null,
        2,
      );

    case 'card-grid':
      return JSON.stringify(
        {
          type: 'card-grid',
          columns: 3,
          cards: [
            { heading: 'Card 1', body: 'Description for card 1.' },
            { heading: 'Card 2', body: 'Description for card 2.' },
            { heading: 'Card 3', body: 'Description for card 3.' },
          ],
        },
        null,
        2,
      );

    case 'testimonial':
      return JSON.stringify(
        {
          type: 'testimonial',
          quote: 'Customer testimonial quote here.',
          authorName: 'Author Name',
          authorTitle: 'Position, Company',
          contentAlign: 'center',
        },
        null,
        2,
      );

    case 'newsletter':
      return JSON.stringify(
        {
          type: 'newsletter',
          heading: 'Stay Updated',
          subheading: 'Subscribe to receive the latest updates.',
          buttonText: 'Subscribe',
          layout: 'centered',
        },
        null,
        2,
      );

    case 'media-text':
      return JSON.stringify(
        {
          type: 'media-text',
          imageSrc: '',
          imageAlt: '',
          imagePosition: 'left',
          heading: 'Section Heading',
          body: 'Section body text.',
        },
        null,
        2,
      );

    default:
      return '';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeOp(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}
