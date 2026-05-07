import type { ThemeProfile } from './theme-profile.interface.js';

export const PROFOLIO_FSE_THEME_PROFILE: ThemeProfile = {
  id: 'profolio-fse',
  kind: 'fse',
  slug: 'profolio-fse',
  label: 'Profolio FSE',
  sourceFaithfulComponents: ['Header', 'Footer', 'Sidebar'],
  sharedChromeMode: 'block-tree-first',
  motionHooks: [
    'wow',
    'animate__animated',
    'animate__fadeInUp',
    'animate__zoomIn',
    'animate__delay-1s',
    'cover-inner',
    'r-cover',
  ],
  stickySelectors: ['#sticky-header'],
  activeNavStateClassNames: ['current-menu-item', 'current_page_item'],
  scrollTopSelectors: ['.profolio-fse-scroll-top'],
  notes: [
    'Pattern-heavy portfolio-oriented FSE theme.',
    'Templates are often thin wrappers; patterns carry much of the real page composition.',
    'Source patterns use WOW/animate.css enter motion classes such as `wow animate__animated animate__fadeInUp` and `animate__zoomIn`; preserve those source-backed motion cues instead of flattening them into static content.',
    'Shared chrome is source-faithful: header/footer should prefer preserved block-tree structure over semantic fallback stubs whenever source block markup exists.',
  ],
};
