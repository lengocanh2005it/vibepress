export function isDefaultRuntimePageTemplateCandidate(input: {
  templateName?: string;
  route?: string | null;
  type?: 'page' | 'partial';
  fixedSlug?: string;
  dataNeeds?: string[];
}): boolean {
  if (input.type !== 'page') return false;
  if (input.fixedSlug?.trim()) return false;
  if (input.route !== '/page/:slug') return false;
  const needs = new Set((input.dataNeeds ?? []).map((need) => need.trim()));
  if (!needs.has('page-detail')) return false;
  const templateName = normalizeTemplateIdentifier(input.templateName);
  return templateName === 'page';
}

function normalizeTemplateIdentifier(value: string | undefined): string {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.replace(/\.(php|html)$/i, '');
}
