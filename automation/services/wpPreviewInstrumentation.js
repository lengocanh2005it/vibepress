function escapeForHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPreviewInstrumentationScript({ route, templateHint }) {
  const safeRoute = JSON.stringify(route || '/');
  const safeTemplateHint = JSON.stringify(templateHint || 'unknown');

  return `
(() => {
  if (window.__VP_PREVIEW_INSTRUMENTED__) return;
  window.__VP_PREVIEW_INSTRUMENTED__ = true;

  const defaultRoute = ${safeRoute};
  const defaultTemplateHint = ${safeTemplateHint};

  const normalizeText = (value, maxLength = 120) => {
    const normalized = String(value || '').replace(/\\s+/g, ' ').trim();
    return normalized.length > maxLength
      ? normalized.slice(0, Math.max(0, maxLength - 3)) + '...'
      : normalized;
  };

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

  const toSlug = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node';

  const getDomPath = (element) => {
    const parts = [];
    let current = element;
    let depth = 0;

    while (current && current.nodeType === Node.ELEMENT_NODE && depth < 8) {
      const tagName = current.tagName.toLowerCase();
      let segment = tagName;
      const parent = current.parentElement;

      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current.tagName,
        );
        if (sameTagSiblings.length > 1) {
          segment += ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')';
        }
      }

      parts.unshift(segment);
      if (tagName === 'body') break;
      current = parent;
      depth += 1;
    }

    return parts.join(' > ');
  };

  const findHeadingWithin = (element, fromEnd = false) => {
    if (!element) return '';

    if (element.matches?.(HEADING_SELECTOR)) {
      return normalizeText(element.textContent || '', 100);
    }

    const headings = Array.from(element.querySelectorAll?.(HEADING_SELECTOR) || []);
    const heading = fromEnd ? headings[headings.length - 1] : headings[0];
    return normalizeText(heading?.textContent || '', 100);
  };

  const resolveHeadingText = (element) => {
    const selfHeading = findHeadingWithin(element);
    if (selfHeading) return selfHeading;

    let current = element;
    while (current && current.tagName?.toLowerCase() !== 'body') {
      let sibling = current.previousElementSibling;
      while (sibling) {
        const siblingHeading = findHeadingWithin(sibling, true);
        if (siblingHeading) return siblingHeading;
        sibling = sibling.previousElementSibling;
      }
      current = current.parentElement;
    }

    const localContainers = [
      element.closest('[data-block], [data-type], [data-block-name], [class*="wp-block-"]'),
      element.closest('section, article, header, aside, footer, nav, form'),
      element.parentElement,
      element.parentElement?.parentElement || null,
      element.closest('main'),
    ];

    for (const container of localContainers) {
      const heading = findHeadingWithin(container);
      if (heading) return heading;
    }

    return '';
  };

  const detectTemplateHint = () => {
    const body = document.body;
    if (!body) return defaultTemplateHint;

    const bodyClasses = Array.from(body.classList);
    const directTemplate =
      body.getAttribute('data-vp-template') ||
      body.dataset.templateHint;
    if (directTemplate) return directTemplate;

    const wpTemplateClass = bodyClasses.find((className) =>
      /^(page-template-|single-|archive-|home|blog|page-|post-type-archive)/.test(className),
    );
    if (wpTemplateClass) return wpTemplateClass;

    if (location.pathname === '/' || location.pathname === '') {
      return 'front-page';
    }

    return defaultTemplateHint;
  };

  const route = defaultRoute || location.pathname || '/';
  const templateHint = detectTemplateHint();
  const candidateSelector = [
    '[data-block]',
    '[data-type]',
    '[data-block-name]',
    '[class*="wp-block-"]',
    'header',
    'nav',
    'main',
    'section',
    'article',
    'aside',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'button',
    'a',
    'img'
  ].join(',');

  const candidates = Array.from(document.querySelectorAll(candidateSelector));
  let counter = 0;

  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;

    const blockClass = Array.from(element.classList).find((className) =>
      className.startsWith('wp-block-'),
    );
    const nearestHeading = resolveHeadingText(element);

    if (!element.dataset.vpNodeId) {
      const semanticKey =
        element.getAttribute('id') ||
        element.getAttribute('data-block') ||
        element.getAttribute('data-id') ||
        element.getAttribute('data-type') ||
        blockClass ||
        element.tagName.toLowerCase();
      element.dataset.vpNodeId = 'vp_' + toSlug(semanticKey) + '_' + counter;
      counter += 1;
    }

    element.dataset.vpRoute = route;
    element.dataset.vpTemplate = templateHint;
    element.dataset.vpTag = element.tagName.toLowerCase();
    element.dataset.vpDomPath = getDomPath(element);

    const blockName =
      element.getAttribute('data-type') ||
      element.getAttribute('data-block-name') ||
      blockClass;
    if (blockName) {
      element.dataset.vpBlockName = blockName;
    }

    const blockClientId =
      element.getAttribute('data-block') ||
      element.getAttribute('data-id');
    if (blockClientId) {
      element.dataset.vpBlockClientId = blockClientId;
    }

    const role =
      element.getAttribute('role') ||
      element.closest('header, nav, main, section, article, aside, footer, form')
        ?.tagName
        ?.toLowerCase();
    if (role) {
      element.dataset.vpLandmark = role;
    }

    if (nearestHeading) {
      element.dataset.vpHeading = nearestHeading;
    }

    const textSnippet = normalizeText(element.textContent || '', 140);
    if (textSnippet) {
      element.dataset.vpText = textSnippet;
    }
  }

  document.documentElement.dataset.vpRoute = route;
  document.documentElement.dataset.vpTemplate = templateHint;
  document.documentElement.dataset.vpInstrumented = 'true';
})();
  `.trim();
}

function injectWpPreviewMetadata(html, targetUrl) {
  let resolvedUrl;
  try {
    resolvedUrl = new URL(targetUrl);
  } catch {
    return html;
  }

  const route = resolvedUrl.pathname || '/';
  const script = buildPreviewInstrumentationScript({
    route,
    templateHint: route === '/' ? 'front-page' : route.split('/').filter(Boolean).join('/') || 'page',
  });
  const scriptTag = `\n<script data-vp-preview-script="true">${script}</script>`;

  if (/<script[^>]+data-vp-preview-script=/i.test(html)) {
    return html;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  }

  return `${html}${scriptTag}`;
}

module.exports = {
  injectWpPreviewMetadata,
};
