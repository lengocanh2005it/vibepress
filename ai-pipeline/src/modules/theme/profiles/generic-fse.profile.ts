import type { ThemeProfile } from './theme-profile.interface.js';

export const GENERIC_FSE_THEME_PROFILE: ThemeProfile = {
  id: 'generic-fse',
  kind: 'fse',
  label: 'Generic FSE',
  isGenericFallback: true,
  notes: [
    'Fallback profile for block themes that follow standard WordPress FSE conventions.',
    'Prefer theme.json, templates/, parts/, and patterns/ as the primary repo sources before applying any theme-specific heuristics.',
  ],
};
