// ── Edit Operation Utilities ──────────────────────────────────────────────────
// Detects the edit operation type from user prompt and generates structured
// specs for section add/replace operations.

export type EditOperation =
  | 'change_layout' // đổi layout
  | 'change_content' // đổi nội dung
  | 'change_color' // đổi màu sắc
  | 'replace_section' // thay cái cũ bằng cái mới
  | 'add_section' // thêm section mới (carousel, slider, v.v.)
  | 'add_component' // thêm component mới (widget, interactive element)
  | 'adjust_layout' // sửa layout dựa trên cái hiện có
  | 'general'; // general / undetected

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

  const hasAddSignal =
    /\b(them|tao them|tao moi|bo sung|chen vao|add|insert|introduce|create new|generate new)\b/.test(
      n,
    );
  const hasReplaceSignal =
    /\b(thay bang|thay the bang|thay the boi|doi thanh|chuyen thanh|replace with|switch to|convert to)\b/.test(
      n,
    );
  const hasColorSignal =
    /\b(mau sac|doi mau|mau nen|mau chu|background color|text color|color|palette|theme color|bo mau|mau sac moi)\b/.test(
      n,
    );
  const hasLayoutSignal =
    /\b(layout|bo cuc|cach sap xep|column|hang cot|trai phai|chia cot|doi layout|change layout)\b/.test(
      n,
    );
  const hasContentSignal =
    /\b(noi dung|van ban|chu viet|text|tieu de|heading|doi noi dung|change content|update content|noi dung moi)\b/.test(
      n,
    );
  const hasAdjustSignal =
    /\b(sua lai|dieu chinh|chinh sua lai|can chinh|fix|tweak|adjust|refine|improve|cai thien)\b/.test(
      n,
    );

  const sectionType = detectSectionType(n);
  const hasSectionKeyword =
    /\b(section|vung|block|khu vuc|slider|carousel|modal|tabs|accordion|faq)\b/.test(
      n,
    );
  const hasComponentKeyword =
    /\b(component|widget|thanh phan|module|interactive|tinh nang)\b/.test(n);

  // Add operations
  if (hasAddSignal) {
    if (sectionType || hasSectionKeyword) return 'add_section';
    if (hasComponentKeyword) return 'add_component';
    // "thêm" without specific type → treat as add_section if any interactive keyword present
    if (/\b(interactive|animation|tinh nang tuong tac)\b/.test(n))
      return 'add_component';
    return 'add_section';
  }

  // Replace operations
  if (hasReplaceSignal && (sectionType || hasSectionKeyword)) {
    return 'replace_section';
  }

  // Style operations
  if (hasColorSignal && !hasLayoutSignal && !hasContentSignal)
    return 'change_color';

  // Layout operations
  if (hasLayoutSignal) {
    return hasAdjustSignal ? 'adjust_layout' : 'change_layout';
  }

  // Content operations
  if (hasContentSignal && !hasLayoutSignal) return 'change_content';

  // Adjust without specific layout/content target
  if (hasAdjustSignal) return 'adjust_layout';

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
  const sectionType = detectSectionType(prompt);

  switch (operation) {
    case 'add_section': {
      const spec = sectionType ? buildSectionSpec(sectionType) : '';
      return [
        `OPERATION: ADD NEW SECTION`,
        `Insert a new ${sectionType ?? 'section'} section at the most contextually appropriate position in the component.`,
        spec
          ? `Suggested section structure (adapt content, images, and colors to the actual theme palette and real data):\n\`\`\`json\n${spec}\n\`\`\``
          : '',
        `CRITICAL: Return the COMPLETE updated component with the new section inserted. Do NOT remove or alter any existing sections.`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'add_component': {
      return [
        `OPERATION: ADD INTERACTIVE COMPONENT`,
        `Add the requested interactive component/widget to this component.`,
        `Implement it as a self-contained React element with appropriate state (useState/useEffect if needed).`,
        `Place it at the most contextually appropriate position.`,
        `Return the COMPLETE updated component with the new element inserted.`,
      ].join('\n');
    }

    case 'replace_section': {
      const spec = sectionType ? buildSectionSpec(sectionType) : '';
      return [
        `OPERATION: REPLACE SECTION`,
        `Replace the targeted section with a new ${sectionType ?? 'section'} section as described.`,
        spec ? `New section structure:\n\`\`\`json\n${spec}\n\`\`\`` : '',
        `Preserve ALL surrounding sections unchanged. Only the targeted section should change.`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'change_layout':
      return [
        `OPERATION: CHANGE LAYOUT`,
        `Rearrange the visual structure as described in the request.`,
        `Preserve all content text, data fetching, API contracts, and color scheme.`,
        `Do NOT change copy or colors unless explicitly requested.`,
      ].join('\n');

    case 'adjust_layout':
      return [
        `OPERATION: ADJUST LAYOUT`,
        `Make incremental layout improvements based on the existing structure.`,
        `Keep all data contracts, colors, and content copy intact.`,
        `Apply only the specific layout refinements requested.`,
      ].join('\n');

    case 'change_color':
      return [
        `OPERATION: CHANGE COLORS`,
        `Update ONLY the colors and/or backgrounds as described.`,
        `Preserve all layout, typography scale, content text, and data contracts.`,
        `Do not restructure or move any elements.`,
      ].join('\n');

    case 'change_content':
      return [
        `OPERATION: CHANGE CONTENT`,
        `Update ONLY the specified content (text, headings, labels, descriptions).`,
        `Preserve all layout, colors, spacing, and data contracts exactly as-is.`,
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
