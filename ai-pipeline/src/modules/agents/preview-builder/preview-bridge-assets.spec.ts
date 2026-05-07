import {
  buildSourceMotionBootstrapTs,
  SOURCE_MOTION_BRIDGE_CSS,
} from './preview-bridge-assets.js';

describe('preview source motion bridge assets', () => {
  it('includes sticky-header and scroll-top bridge CSS hooks', () => {
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('#sticky-header');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('width: 100vw !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'margin-left: calc(50% - 50vw) !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'header.wp-site-blocks:has(#sticky-header)',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('@media (max-width: 780px)');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header button[aria-label="Toggle menu"]',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header > .wp-block-group > .wp-block-navigation.hidden',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header > .wp-block-group > .wp-block-navigation.md\\:hidden',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('color: #fff !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('@media (min-width: 781px)');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header > .wp-block-group',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'border-bottom: 1px solid #4f4f4f !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'grid-template-columns: auto minmax(0, 1fr) auto;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'max-width: var(--wp--style--global--content-size, 1200px) !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header .profolio-fse-header-btn',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '#sticky-header .wp-block-navigation__container',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('opacity: 1 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('#sticky-header .header-btn');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('min-width: 0;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'border-color: #F5B731 !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).not.toContain('width: min(100%, 1500px)');
    expect(SOURCE_MOTION_BRIDGE_CSS).not.toContain('gap: 40px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).not.toContain(
      'text-decoration: underline !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).not.toContain(
      'padding: 14px 18px !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-scroll-top');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('display: block !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-scroll-top.vp-scroll-top-visible',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'transform: translate3d(0, 12px, 0) scale(0.96);',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('opacity 320ms ease');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-scroll-top:not(p):not(a):not(button)::before',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.pg-footer-center-row .wp-block-column',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'row-gap: var(--wp--preset--spacing--10, 1rem);',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.pg-footer-center-row .wp-block-image.is-resized img[src*="arrow-up"]',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('max-width: 39px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('footer.wp-site-blocks');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('footer .pg-footer-center-row');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'footer .pg-footer-center-row > .wp-block-columns',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'max-width: var(--wp--style--global--wide-size, 1200px);',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).not.toContain(
      'footer .pg-footer-center-row,\n  footer .has-base-2-background-color {\n    width: 100vw !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'footer .wp-block-social-links i',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'footer .wp-block-social-links svg.wp-social-link-svg',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'footer .wp-block-social-links .fa-x-twitter::before',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('content: "X";');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.pg-footer-center-row .wp-block-column:last-child > .wp-block-group',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('height: auto !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('width: 100% !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('margin-top: auto !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'width: fit-content !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('margin-left: auto !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('margin: 0 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'footer p:has(a[href*="themegrove"])',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper mark',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'background-color: transparent !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('color: #F5B731 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper .wp-block-social-links',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('display: none !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper .wp-block-button__link',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper .vp-generated-button',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'background-color: #F5B731 !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('color: #f2f2f2 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'background-color: #f58931 !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'padding-top: clamp(12px, 2vw, 28px);',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper .r-cover:has(img[src*="banner-image"])',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'justify-content: center !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-banner-wrapper img[src*="banner-image"]',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'margin-left: auto !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('--vp-wow-distance: 38px;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('--vp-wow-duration: 820ms;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-projects-wrapper',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('main.wp-site-blocks > .r-pad');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '[style*="grid-template-columns"] > section h3',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-project-arrow');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('top: 1em !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('right: 1em !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('border-radius: 5px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.r-cover div:has(> img[src*="arrow-up"])',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-services-wrapper',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-services-stack');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-service-card');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'main.wp-site-blocks > .r-pad > .cover-inner > section',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('gap: 24px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('padding-top: 48px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-service-card-copy',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('padding-top: 8px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-services-wrapper .profolio-fse-service-card-media',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('border: 0 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'border-color: transparent !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('box-shadow: none !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-services-wrapper .wp-block-button__link:not(.is-style-outline)',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('color: #f2f2f2 !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-experience-wrapper',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'main.wp-site-blocks > .r-pad.has-secondary-background-color',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('padding-top: 80px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'padding-bottom: 80px !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('padding-left: 20px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-experience-copy');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '.profolio-fse-experience-image > :first-child:not(img)',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'background-color: transparent !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-skills-wrapper');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '[data-source-node-id="front-page::group::1.3"]',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      'grid-template-columns: repeat(5, minmax(112px, 1fr)) !important;',
    );
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-skill-card');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('max-width: 180px !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('--vp-wow-scale: 0;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.profolio-fse-skill-icon');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('margin-left: auto !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('.vp-source-reveal');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain('animation: none !important;');
    expect(SOURCE_MOTION_BRIDGE_CSS).toContain(
      '  @media (prefers-reduced-motion: reduce) {',
    );
  });

  it('includes sticky-header and scroll-top runtime bridge logic', () => {
    const bootstrap = buildSourceMotionBootstrapTs();

    expect(bootstrap).toContain(
      "const SOURCE_STICKY_HEADER_SELECTOR = '#sticky-header';",
    );
    expect(bootstrap).toContain(
      "const SOURCE_SCROLL_TOP_SELECTOR = '.profolio-fse-scroll-top';",
    );
    expect(bootstrap).toContain(
      '\'.wow, .animate__animated[class*="animate__"], \' +',
    );
    expect(bootstrap).toContain('.profolio-fse-banner-wrapper');
    expect(bootstrap).toContain('[data-source-node-id^="front-page::"]');
    expect(bootstrap).toContain("element.classList.add('vp-source-reveal');");
    expect(bootstrap).toContain(
      'const isEligibleScrollTopElement = (element: HTMLElement) => {',
    );
    expect(bootstrap).toContain(
      'if (structuralTags.has(element.tagName)) return false;',
    );
    expect(bootstrap).toContain('const removeLeakedScrollTopHooks = () => {');
    expect(bootstrap).toContain(
      "element.classList.remove('profolio-fse-scroll-top');",
    );
    expect(bootstrap).toContain(
      "window.scrollTo({ top: 0, behavior: 'smooth' });",
    );
    expect(bootstrap).toContain("element.style.position = 'sticky';");
    expect(bootstrap).toContain('const shouldShowScrollTop = () => {');
    expect(bootstrap).toContain(
      'footer.getBoundingClientRect().top <= viewportHeight * 1.15',
    );
    expect(bootstrap).toContain(
      'const progressThreshold = Math.min(maxScroll, Math.max(72, viewportHeight * 0.18));',
    );
    expect(bootstrap).toContain(
      "element.classList.toggle('vp-scroll-top-visible', shouldShow);",
    );
    expect(bootstrap).toContain(
      "element.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');",
    );
    expect(bootstrap).toContain("element.classList.add('vp-wow-visible');");
    expect(bootstrap).toContain(
      'const pendingActivations = new Set<HTMLElement>();',
    );
    expect(bootstrap).toContain('const hydrateProfolioRevealCards =');
    expect(bootstrap).toContain(
      '.profolio-fse-banner-wrapper .cover-inner',
    );
    expect(bootstrap).toContain(
      'const suppressNestedProjectServiceMotion = (scope: ParentNode) => {',
    );
    expect(bootstrap).toContain(
      '.profolio-fse-projects-grid > .profolio-fse-project-card',
    );
    expect(bootstrap).toContain(
      '.profolio-fse-projects-wrapper .profolio-fse-projects-grid',
    );
    expect(bootstrap).toContain(
      '.profolio-fse-services-wrapper .profolio-fse-services-stack',
    );
    expect(bootstrap).toContain(
      'main.wp-site-blocks > .r-pad > .cover-inner > section',
    );
    expect(bootstrap).toContain(
      '.profolio-fse-experience-wrapper .profolio-fse-experience-copy',
    );
    expect(bootstrap).toContain(
      'main.wp-site-blocks > .r-pad.has-secondary-background-color .cover-inner',
    );
    expect(bootstrap).toContain(
      '.profolio-fse-skills-wrapper .profolio-fse-skill-card',
    );
    expect(bootstrap).toContain('.profolio-fse-skills-grid > div');
    expect(bootstrap).toContain(
      "element.parentElement?.classList.contains('profolio-fse-skills-grid')",
    );
    expect(bootstrap).toContain(
      '[data-source-node-id="front-page::group::1.3.1"] > div',
    );
    expect(bootstrap).toContain(
      "].forEach((className) => element.classList.remove(className));",
    );
    expect(bootstrap).toContain("element.classList.add('animate__zoomIn');");
    expect(bootstrap).toContain("element.classList.add('animate__delay-1s');");
    expect(bootstrap).toContain('let skillIndex = -1;');
    expect(bootstrap).toContain('skillIndex += 1;');
    expect(bootstrap).toContain(
      "element.style.setProperty('--vp-wow-scale', '0');",
    );
    expect(bootstrap).toContain("'animate__fadeInUp'");
    expect(bootstrap).toContain('--vp-wow-delay');
    expect(bootstrap).toContain(
      'nextFrame(() => nextFrame(() => activate(element)));',
    );
    expect(bootstrap).toContain('scheduleActivate(element);');
    expect(bootstrap).toContain("element.dataset.vpWowObserved === '1'");
    expect(bootstrap).toContain("element.dataset.vpWowObserved = '1';");
    expect(bootstrap).toContain('observer.unobserve(element);');
    expect(bootstrap).toContain("rootMargin: '0px 0px -8% 0px'");
    expect(bootstrap).toContain('threshold: 0.16');
  });
});
