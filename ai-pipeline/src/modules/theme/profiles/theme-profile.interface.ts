export type ThemeProfileKind = 'fse';

export type ThemeSharedChromeMode = 'semantic-fallback' | 'block-tree-first';

export interface ThemeProfile {
  id: string;
  kind: ThemeProfileKind;
  slug?: string;
  label: string;
  notes: string[];
  sourceFaithfulComponents?: string[];
  sharedChromeMode?: ThemeSharedChromeMode;
  motionHooks?: string[];
  stickySelectors?: string[];
  activeNavStateClassNames?: string[];
  scrollTopSelectors?: string[];
  isGenericFallback?: boolean;
}

export function normalizeThemeSlug(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}
