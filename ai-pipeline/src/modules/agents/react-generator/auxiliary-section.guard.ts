import type { SectionPlan } from './visual-plan.schema.js';

export const INVENTED_AUXILIARY_SECTION_LABELS = [
  'about',
  'privacy',
  'resources',
  'useful links',
  'navigation',
  'pages',
  'latest posts',
  'social',
] as const;

const INVENTED_AUXILIARY_LABEL_SET = new Set<string>(
  INVENTED_AUXILIARY_SECTION_LABELS,
);
const VISIBLE_TEXT_KEYS = new Set([
  'text',
  'title',
  'heading',
  'subheading',
  'label',
  'html',
]);

export function formatInventedAuxiliarySectionLabels(
  labels: readonly string[] = INVENTED_AUXILIARY_SECTION_LABELS,
): string {
  return labels
    .map(
      (label) => `\`${label.replace(/\b\w/g, (char) => char.toUpperCase())}\``,
    )
    .join(', ');
}

export function normalizeAuxiliaryLabel(value?: string | null): string | null {
  if (!value) return null;
  const normalized = decodeMinimalEntities(stripHtml(value))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized || null;
}

export function getExactInventedAuxiliaryLabel(
  value?: string | null,
): string | null {
  const normalized = normalizeAuxiliaryLabel(value);
  if (!normalized) return null;
  return INVENTED_AUXILIARY_LABEL_SET.has(normalized) ? normalized : null;
}

export function mergeAuxiliaryLabels(
  ...groups: Array<readonly string[] | undefined>
): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const value of group ?? []) {
      const label = getExactInventedAuxiliaryLabel(value);
      if (label) merged.add(label);
    }
  }
  return [...merged];
}

export function extractAuxiliaryLabelsFromSections(
  sections?: readonly SectionPlan[],
): string[] {
  if (!sections?.length) return [];

  const labels = new Set<string>();
  for (const section of sections) {
    for (const candidate of getSectionHeadingCandidates(section)) {
      const label = getExactInventedAuxiliaryLabel(candidate);
      if (label) labels.add(label);
    }
  }
  return [...labels];
}

export function getPrimaryInventedAuxiliaryLabelForSection(
  section: SectionPlan,
): string | null {
  for (const candidate of getSectionHeadingCandidates(section)) {
    const label = getExactInventedAuxiliaryLabel(candidate);
    if (label) return label;
  }
  return null;
}

export function extractSourceBackedAuxiliaryLabels(input: {
  source?: string | null;
  draftSections?: readonly SectionPlan[];
}): string[] {
  const labels = new Set<string>(
    extractAuxiliaryLabelsFromSections(input.draftSections),
  );

  for (const candidate of collectVisibleSourceTexts(input.source ?? '')) {
    const label = getExactInventedAuxiliaryLabel(candidate);
    if (label) labels.add(label);
  }

  return [...labels];
}

export function pruneTrailingInventedAuxiliarySections(
  sections: SectionPlan[],
  options?: {
    componentType?: 'page' | 'partial';
    allowedAuxiliaryLabels?: readonly string[];
  },
): { sections: SectionPlan[]; droppedLabels: string[] } {
  // Apply to all component types — stray "About" sections appear on Singles,
  // Archives, and Index pages too, not just static pages.
  if (sections.length === 0) {
    return { sections, droppedLabels: [] };
  }

  const allowed = new Set(
    mergeAuxiliaryLabels(options?.allowedAuxiliaryLabels ?? []),
  );
  const next = [...sections];
  const droppedLabels: string[] = [];

  while (next.length > 0) {
    const lastSection = next[next.length - 1];
    const label = getPrimaryInventedAuxiliaryLabelForSection(lastSection);
    if (!label || allowed.has(label)) break;
    droppedLabels.push(label);
    next.pop();
  }

  return {
    sections: next,
    droppedLabels: droppedLabels.reverse(),
  };
}

function getSectionHeadingCandidates(section: SectionPlan): string[] {
  switch (section.type) {
    case 'hero':
      return [section.heading, section.subheading].filter(isNonEmptyString);
    case 'cta-strip':
      return [];
    case 'cover':
      return [section.heading, section.subheading].filter(isNonEmptyString);
    case 'post-list':
      return [section.title].filter(isNonEmptyString);
    case 'card-grid':
      return [section.title, section.subtitle].filter(isNonEmptyString);
    case 'media-text':
      return [section.heading].filter(isNonEmptyString);
    case 'prose-block':
      return section.sourceSegments
        .filter((segment) => segment.type === 'heading')
        .map((segment) => segment.text)
        .filter(isNonEmptyString);
    case 'newsletter':
      return [section.heading, section.subheading].filter(isNonEmptyString);
    case 'search':
      return [section.title].filter(isNonEmptyString);
    case 'sidebar':
      return [section.title].filter(isNonEmptyString);
    case 'modal':
      return [section.heading, section.triggerText].filter(isNonEmptyString);
    case 'tabs':
      return [section.title].filter(isNonEmptyString);
    case 'accordion':
      return [section.title].filter(isNonEmptyString);
    case 'footer':
      return section.menuColumns
        .map((column) => column.title)
        .filter(isNonEmptyString);
    default:
      return [];
  }
}

function collectVisibleSourceTexts(source: string): string[] {
  if (!source.trim()) return [];

  try {
    const parsed = JSON.parse(source);
    const result: string[] = [];
    collectVisibleJsonTexts(parsed, result);
    return result;
  } catch {
    return extractVisibleHtmlTexts(source);
  }
}

function collectVisibleJsonTexts(
  value: unknown,
  result: string[],
  parentKey?: string,
): void {
  if (typeof value === 'string') {
    if (parentKey && VISIBLE_TEXT_KEYS.has(parentKey)) {
      if (parentKey === 'html') {
        result.push(...extractVisibleHtmlTexts(value));
      } else {
        result.push(value);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectVisibleJsonTexts(entry, result);
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    collectVisibleJsonTexts(entry, result, key);
  }
}

function extractVisibleHtmlTexts(source: string): string[] {
  const result: string[] = [];
  const tagPattern =
    /<(h[1-6]|a|button|p|span|strong|em|li)[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of source.matchAll(tagPattern)) {
    if (match[2]) result.push(match[2]);
  }

  return result;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function decodeMinimalEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
