const PARTIAL_NAME_PREFIXES = [
  'header',
  'footer',
  'sidebar',
  'nav',
  'navigation',
  'searchform',
  'comments',
  'comment',
  'postmeta',
  'widget',
  'breadcrumb',
  'pagination',
  'loop',
  'contentnone',
  'noresults',
  'functions',
] as const;

export function isPartialComponentName(name: string | null | undefined): boolean {
  if (!name) return false;

  const raw = name.trim();
  if (!raw) return false;

  if (/^part[-_]/i.test(raw) || /^Part[A-Z]/.test(raw)) return true;

  const normalized = raw.replace(/[^a-z0-9]+/gi, '').toLowerCase();
  return PARTIAL_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
