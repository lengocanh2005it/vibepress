export type ThemeProfileKind = 'fse';

export interface ThemeProfile {
  id: string;
  kind: ThemeProfileKind;
  slug?: string;
  label: string;
  notes: string[];
  isGenericFallback?: boolean;
}

export function normalizeThemeSlug(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
