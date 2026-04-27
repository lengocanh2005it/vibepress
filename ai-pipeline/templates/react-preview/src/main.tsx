import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { startInspectorClient } from './inspector';

const SOURCE_MOTION_SELECTOR =
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

function watchForSourceMotionSignals() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let started = false;
  let signalObserver: MutationObserver | null = null;

  const boot = async () => {
    if (started) return;
    started = true;
    signalObserver?.disconnect();
    await import('./styles/source-motion-bridges.css');
    startSourceMotionBridge();
  };

  const hasSignal = () =>
    !!document.querySelector<HTMLElement>(SOURCE_MOTION_SELECTOR);

  const check = () => {
    if (!hasSignal()) return;
    void boot();
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

startInspectorClient();
watchForSourceMotionSignals();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
