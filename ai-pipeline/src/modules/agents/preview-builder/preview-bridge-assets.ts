export const SOURCE_MOTION_BRIDGE_CSS = String.raw`@layer components {
  .wow {
    will-change: opacity, transform;
  }

  .wow.animate__animated {
    opacity: 0;
  }

  .wow.animate__animated.vp-wow-visible,
  .wow.vp-wow-visible {
    opacity: 1;
  }

  .wow.animate__fadeInUp {
    transform: translateY(24px);
    transition:
      opacity 700ms ease,
      transform 700ms ease;
  }

  .wow.animate__fadeInUp.vp-wow-visible {
    transform: translateY(0);
  }

  .wow.animate__fadeInLeft {
    transform: translateX(-24px);
    transition:
      opacity 700ms ease,
      transform 700ms ease;
  }

  .wow.animate__fadeInLeft.vp-wow-visible {
    transform: translateX(0);
  }

  .wow.animate__fadeInRight {
    transform: translateX(24px);
    transition:
      opacity 700ms ease,
      transform 700ms ease;
  }

  .wow.animate__fadeInRight.vp-wow-visible {
    transform: translateX(0);
  }

  .wow.animate__zoomIn {
    transform: scale(0.92);
    transition:
      opacity 700ms ease,
      transform 700ms ease;
  }

  .wow.animate__zoomIn.vp-wow-visible {
    transform: scale(1);
  }

  .wow.animate__delay-1s {
    transition-delay: 1s;
  }

  .wow.animate__delay-2s {
    transition-delay: 2s;
  }

  .wow.animate__delay-3s {
    transition-delay: 3s;
  }

  .wow.animate__delay-4s {
    transition-delay: 4s;
  }

  .wow.animate__delay-5s {
    transition-delay: 5s;
  }
}

@media (prefers-reduced-motion: reduce) {
  @layer components {
    .wow,
    .wow.animate__animated,
    .wow.animate__fadeInUp,
    .wow.animate__fadeInLeft,
    .wow.animate__fadeInRight,
    .wow.animate__zoomIn {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }
}
`;

export const SOURCE_MOTION_BOOTSTRAP_TS = String.raw`const SOURCE_MOTION_SELECTOR =
  '.wow.animate__animated, .wow[class*="animate__"]';

function startSourceMotionBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const reduceMotion = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  const activate = (element: HTMLElement) => {
    element.classList.add('vp-wow-visible');
  };

  const register = (
    element: HTMLElement,
    observer?: IntersectionObserver,
  ) => {
    if (
      !element.classList.contains('wow') ||
      element.dataset.vpWowObserved === '1'
    ) {
      return;
    }

    element.dataset.vpWowObserved = '1';

    if (reduceMotion || !observer) {
      activate(element);
      return;
    }

    observer.observe(element);
  };

  const scan = (root: ParentNode, observer?: IntersectionObserver) => {
    if (root instanceof HTMLElement) {
      register(root, observer);
    }
    root
      .querySelectorAll?.<HTMLElement>('.wow')
      .forEach((element) => register(element, observer));
  };

  if (reduceMotion || typeof IntersectionObserver === 'undefined') {
    scan(document, undefined);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target;
        if (element instanceof HTMLElement) {
          activate(element);
          observer.unobserve(element);
        }
      }
    },
    {
      threshold: 0.16,
      rootMargin: '0px 0px -8% 0px',
    },
  );

  scan(document, observer);

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        scan(node, observer);
      }
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener(
    'beforeunload',
    () => {
      mutationObserver.disconnect();
      observer.disconnect();
    },
    { once: true },
  );
}

export function watchForSourceMotionSignals() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let started = false;
  let signalObserver: MutationObserver | null = null;

  const boot = () => {
    if (started) return;
    started = true;
    signalObserver?.disconnect();
    startSourceMotionBridge();
  };

  const hasSignal = () =>
    !!document.querySelector<HTMLElement>(SOURCE_MOTION_SELECTOR);

  const check = () => {
    if (!hasSignal()) return;
    boot();
  };

  check();
  if (started) return;

  signalObserver = new MutationObserver(() => {
    check();
  });

  signalObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  window.addEventListener(
    'beforeunload',
    () => {
      signalObserver?.disconnect();
    },
    { once: true },
  );

  window.requestAnimationFrame(check);
}
`;

export const SPECTRA_COMPAT_CSS = String.raw`@layer components {
  body.hide-scroll {
    overflow: hidden;
  }

  /* WordPress is-style-asterisk card grid decoration */
  .is-style-asterisk > span.is-style-asterisk {
    display: block;
    font-size: 1.5rem;
    line-height: 1;
    margin-bottom: 0.5rem;
    color: inherit;
    opacity: 0.7;
  }

  .uagb-modal-wrapper {
    width: 100%;
  }

  .uagb-modal-trigger.uagb-modal-button-link {
    text-decoration: none;
    align-items: center;
    cursor: pointer;
  }

  .uagb-modal-popup {
    visibility: hidden;
    position: fixed;
  }

  .uagb-modal-popup.active {
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    visibility: visible;
  }

  .uagb-modal-popup .uagb-modal-popup-wrap {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    max-width: 100%;
    position: relative;
    box-sizing: border-box;
  }

  .uagb-effect-default .uagb-modal-popup-wrap {
    opacity: 0;
  }

  .uagb-effect-default.active .uagb-modal-popup-wrap {
    opacity: 1;
    transition: all 0.3s;
  }

  .uagb-modal-popup .uagb-modal-popup-content {
    overflow-x: hidden;
    overflow-y: auto;
    height: 100%;
  }

  .uagb-modal-popup .uagb-modal-popup-close {
    display: none;
    border: none;
    background: transparent;
    padding: 0;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close {
    display: flex;
    align-items: center;
    opacity: 1;
    cursor: pointer;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close svg {
    transition-property: filter, transform;
    transition-duration: 250ms;
  }

  .uagb-modal-popup.active .uagb-modal-popup-close:focus svg {
    transform: scale(1.2);
  }

  .uagb-modal-trigger:not(img) {
    display: flex;
  }

  img.uagb-modal-trigger {
    cursor: pointer;
    height: auto;
    max-width: 100%;
  }

  .uagb-spectra-button-wrapper {
    line-height: 1;
  }

  .uagb-spectra-button-wrapper .uagb-modal-button-link.uagb-modal-trigger {
    display: inline-flex;
    align-items: center;
  }

  .uagb-tabs__wrap {
    display: flex;
    width: 100%;
  }

  .uagb-tabs__wrap .uagb-tabs__panel {
    margin: 0;
    list-style: none;
    padding: 0;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-center {
    justify-content: center;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-left {
    justify-content: flex-start;
  }

  .uagb-tabs__wrap .uagb-tabs__panel.uagb-tabs__align-right {
    justify-content: flex-end;
  }

  .uagb-tabs__wrap .uagb-tab {
    list-style: none;
  }

  .uagb-tabs__wrap .uagb-tabs-list {
    width: 100%;
    text-decoration: none;
  }

  .uagb-tabs__wrap .uagb-tabs__body-wrap {
    position: relative;
    max-width: 100%;
    padding: 10px;
  }

  .uagb-tabs__wrap.uagb-tabs__hstyle4-desktop .uagb-tab,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tab,
  .uagb-tabs__wrap.uagb-tabs__stack4-mobile .uagb-tab {
    border-radius: 999px;
  }

  .uagb-tabs__wrap.uagb-tabs__hstyle5-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__panel {
    justify-content: space-between;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop {
    flex-direction: row;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tabs__panel,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__panel {
    flex-direction: column;
    min-width: 24%;
    max-width: 24%;
  }

  .uagb-tabs__wrap.uagb-tabs__vstyle6-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle7-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle8-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle9-desktop .uagb-tabs__body-wrap,
  .uagb-tabs__wrap.uagb-tabs__vstyle10-desktop .uagb-tabs__body-wrap {
    max-width: 75%;
    flex-grow: 1;
  }

  .uagb-tabs__wrap .uagb-tabs__body-container {
    display: none;
  }

  .uagb-tabs__wrap .uagb-tabs__body-container.uagb-tabs-body__active {
    display: block;
  }

  .uagb-slider-container {
    position: relative;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    transition: box-shadow 0.2s ease;
  }

  .uagb-swiper {
    position: relative;
    overflow: hidden;
  }

  .uagb-slider-container .swiper-wrapper {
    align-items: stretch;
  }

  .uagb-slider-container .swiper-notification {
    left: 0;
    top: 0;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    z-index: -1000;
  }

  .uagb-slider-container .swiper-button-next.swiper-button-disabled,
  .uagb-slider-container .swiper-button-prev.swiper-button-disabled {
    pointer-events: all;
  }

  .uagb-slider-container .swiper-button-prev,
  .uagb-slider-container .swiper-button-next {
    border-style: none;
    background: rgba(239, 239, 239, 0.9);
    color: #111111 !important;
    min-width: 2.75rem;
    min-height: 2.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
  }

  .uagb-slider-container .swiper-button-prev:empty::before {
    content: '\2039';
    font-size: 1.5rem;
    line-height: 1;
  }

  .uagb-slider-container .swiper-button-next:empty::before {
    content: '\203A';
    font-size: 1.5rem;
    line-height: 1;
  }

  .uagb-slider-container .swiper-pagination.swiper-pagination-bullets {
    max-width: 100%;
  }

  .uagb-slider-container .swiper-pagination-bullet {
    display: inline-flex;
  }

  .wp-block-uagb-faq.uagb-faq__wrap {
    width: 100%;
  }

  .wp-block-uagb-faq .uagb-faq-child__outer-wrap {
    width: 100%;
  }

  .wp-block-uagb-faq .uagb-faq-item {
    overflow: hidden;
  }

  .wp-block-uagb-faq .uagb-faq-questions-button {
    cursor: pointer;
  }

  .wp-block-uagb-faq .uagb-faq-content {
    margin-bottom: 0;
  }

  .wp-block-uagb-faq .uagb-faq-content p {
    margin: auto;
  }

  .wp-block-uagb-faq .uagb-faq-icon-wrap {
    flex: 0 0 auto;
  }

  .uagb-faq-layout-grid.uagb-faq-equal-height.uagb-faq__wrap
    .uagb-faq-child__outer-wrap,
  .uagb-faq-layout-grid.uagb-faq-equal-height.uagb-faq__wrap .uagb-faq-item {
    height: 100%;
  }
}
`;
