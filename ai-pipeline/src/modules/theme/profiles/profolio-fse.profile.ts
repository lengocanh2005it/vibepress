import type { ThemeProfile } from './theme-profile.interface.js';

export const PROFOLIO_FSE_THEME_PROFILE: ThemeProfile = {
  id: 'profolio-fse',
  kind: 'fse',
  slug: 'profolio-fse',
  label: 'Profolio FSE',
  notes: [
    'Pattern-heavy portfolio-oriented FSE theme.',
    'Templates are often thin wrappers; patterns carry much of the real page composition.',
    'Source patterns use WOW/animate.css enter motion classes such as `wow animate__animated animate__fadeInUp` and `animate__zoomIn`; preserve those source-backed motion cues instead of flattening them into static content.',
  ],
};
