function inferTemplateHintFromRoute(route) {
  const normalizedRoute = String(route || "/").trim() || "/";
  if (normalizedRoute === "/" || normalizedRoute === "") return "front-page";
  if (/^\/category(\/|$)/i.test(normalizedRoute)) return "category";
  if (/^\/author(\/|$)/i.test(normalizedRoute)) return "author";
  if (/^\/tag(\/|$)/i.test(normalizedRoute)) return "tag";
  if (/^\/search(\/|$)/i.test(normalizedRoute)) return "search";
  return "page";
}

function buildPreviewInstrumentationScript({
  route,
  templateHint,
  sourceFile,
  siteId,
  sourceMap,
}) {
  const safeRoute = JSON.stringify(route || "/");
  const safeTemplateHint = JSON.stringify(templateHint || "unknown");
  const safeSourceFile = JSON.stringify(sourceFile || "");
  const safeSiteId = JSON.stringify(siteId || "");
  const safeSourceMap = JSON.stringify(Array.isArray(sourceMap) ? sourceMap : []);

  return `
(() => {
  if (window.__VP_PREVIEW_INSTRUMENTED__) return;
  window.__VP_PREVIEW_INSTRUMENTED__ = true;

  const defaultRoute = ${safeRoute};
  const defaultTemplateHint = ${safeTemplateHint};
  const defaultSourceFile = ${safeSourceFile};
  const defaultSiteId = ${safeSiteId};
  const previewSourceMap = Array.isArray(${safeSourceMap}) ? ${safeSourceMap} : [];

  const normalizeText = (value, maxLength = 120) => {
    const normalized = String(value || '').replace(/\\s+/g, ' ').trim();
    return normalized.length > maxLength
      ? normalized.slice(0, Math.max(0, maxLength - 3)) + '...'
      : normalized;
  };

  const normalizeSourceToken = (value, fallback) => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\\.(php|html)$/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || fallback;
  };

  const buildSourceNodeId = (templateName, blockName, topLevelIndex) => {
    const templateToken = normalizeSourceToken(templateName, 'template');
    const blockToken = normalizeSourceToken(blockName, 'node');
    return [templateToken, blockToken, String(topLevelIndex)].join('::');
  };

  const inferSourceFile = (templateName, isSharedPart = false) => {
    if (!templateName) return defaultSourceFile || '';
    if (/\\.(php|html)$/i.test(templateName)) return templateName;
    return (isSharedPart ? 'parts/' : 'templates/') + templateName + '.html';
  };

  const toCanonicalBlockName = (value, fallback) => {
    const normalized = String(value || '').trim();
    if (!normalized) return fallback;
    if (normalized.startsWith('wp-block-')) {
      return 'core/' + normalized.slice('wp-block-'.length);
    }
    return normalized;
  };

  const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
  const SOURCE_ROOT_SELECTOR = [
    '[data-block]',
    '[data-type]',
    '[data-block-name]',
    '[class*="wp-block-"]',
    'header',
    'nav',
    'section',
    'article',
    'aside',
    'footer',
    'form'
  ].join(',');
  const CANDIDATE_SELECTOR = [
    '[data-vp-source-node]',
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
    'h4',
    'h5',
    'h6',
    'p',
    'span',
    'li',
    'label',
    'button',
    'a',
    'img',
    'figure',
    'picture',
    'video',
    'input',
    'textarea',
    'select'
  ].join(',');

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

    if (bodyClasses.includes('home') || bodyClasses.includes('front-page')) {
      return 'front-page';
    }
    if (bodyClasses.includes('single')) return 'single';
    if (bodyClasses.includes('page')) return 'page';
    if (bodyClasses.includes('archive')) return 'archive';
    if (bodyClasses.includes('category')) return 'category';
    if (bodyClasses.includes('author')) return 'author';
    if (bodyClasses.includes('tag')) return 'tag';
    if (bodyClasses.includes('search')) return 'search';
    if (bodyClasses.includes('error404')) return '404';

    const wpTemplateClass = bodyClasses.find((className) =>
      /^(page-template-|single-|archive-|home|blog|page-|post-type-archive)/.test(className),
    );
    if (wpTemplateClass) return wpTemplateClass;

    if (location.pathname === '/' || location.pathname === '') {
      return 'front-page';
    }

    return defaultTemplateHint;
  };

  const getBlockMetadata = (element) => {
    const blockHost = element.closest(
      '[data-block], [data-type], [data-block-name], [class*="wp-block-"]',
    );
    if (!blockHost) {
      return {
        blockName: undefined,
        blockClientId: undefined,
      };
    }

    const blockClass = Array.from(blockHost.classList).find((className) =>
      className.startsWith('wp-block-'),
    );

    return {
      blockName: toCanonicalBlockName(
        blockHost.getAttribute('data-type') ||
          blockHost.getAttribute('data-block-name') ||
          blockClass,
        undefined,
      ),
      blockClientId:
        blockHost.getAttribute('data-block') ||
        blockHost.getAttribute('data-id') ||
        undefined,
    };
  };

  const getSemanticBlockName = (element, metadata) => {
    const tagName = element.tagName.toLowerCase();
    if (metadata?.blockName) return metadata.blockName;
    if (tagName === 'nav') return 'navigation';
    if (tagName === 'header') return 'header';
    if (tagName === 'footer') return 'footer';
    return tagName;
  };

  const isButtonLikeElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'button') return true;
    if (element.tagName.toLowerCase() !== 'a') return false;
    const className = element.className || '';
    return /btn|button|cta|chip|pill/i.test(String(className));
  };

  const inferNodeRole = (element) => {
    if (!(element instanceof HTMLElement)) return 'unknown';

    const explicitRole = (element.getAttribute('role') || '').toLowerCase();
    if (explicitRole === 'button') return 'button';
    if (explicitRole === 'link') return 'link';

    const tagName = element.tagName.toLowerCase();
    if (tagName === 'button') return 'button';
    if (tagName === 'a') {
      return isButtonLikeElement(element) ? 'button' : 'link';
    }
    if (/^h[1-6]$/.test(tagName)) return 'heading';
    if (['img', 'picture', 'video', 'figure', 'svg', 'canvas'].includes(tagName)) {
      return 'media';
    }
    if (tagName === 'form') return 'form';
    if (['input', 'textarea', 'select', 'option'].includes(tagName)) return 'input';
    if (['ul', 'ol', 'li', 'dl'].includes(tagName)) return 'list';
    if (['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(tagName)) {
      return 'section';
    }

    const className = String(element.className || '');
    if (/card|panel|tile|badge|banner|feature/i.test(className)) {
      return 'card';
    }

    const textContent = normalizeText(element.textContent || '', 80);
    if (['p', 'span', 'label', 'small', 'strong', 'em'].includes(tagName) || textContent) {
      return 'text';
    }

    return 'container';
  };

  const shouldTrackSourceRoot = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (['script', 'style', 'link', 'meta'].includes(element.tagName.toLowerCase())) {
      return false;
    }

    const metadata = getBlockMetadata(element);
    const tagName = element.tagName.toLowerCase();
    return Boolean(
      metadata.blockName ||
        ['header', 'nav', 'section', 'article', 'aside', 'footer', 'form'].includes(tagName),
    );
  };

  const resolveSharedTemplateForRoot = (element, blockName, pageTemplateHint) => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'header') {
      return { templateName: 'header', sourceFile: inferSourceFile('header', true) };
    }
    if (tagName === 'footer') {
      return { templateName: 'footer', sourceFile: inferSourceFile('footer', true) };
    }
    if (tagName === 'nav' && !element.closest('main')) {
      return { templateName: 'header', sourceFile: inferSourceFile('header', true) };
    }
    return {
      templateName: pageTemplateHint,
      sourceFile: defaultSourceFile || inferSourceFile(pageTemplateHint, false),
    };
  };

  const collectTopLevelSourceRoots = () => {
    const candidates = Array.from(document.querySelectorAll(SOURCE_ROOT_SELECTOR))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => shouldTrackSourceRoot(element));

    return candidates.filter((element) => {
      const ancestor = element.parentElement?.closest(SOURCE_ROOT_SELECTOR);
      if (!(ancestor instanceof HTMLElement)) return true;
      return !shouldTrackSourceRoot(ancestor);
    });
  };

  const annotateSourceRoots = (sourceRoots, pageTemplateHint) => {
    const remainingEntries = previewSourceMap.slice();

    sourceRoots.forEach((element, topLevelIndex) => {
      if (!(element instanceof HTMLElement)) return;
      const metadata = getBlockMetadata(element);
      const blockName = getSemanticBlockName(element, metadata);
      const manifestEntry = (() => {
        if (remainingEntries.length === 0) return null;

        const tagName = element.tagName.toLowerCase();
        const preferredTemplateName =
          tagName === 'header'
            ? 'header'
            : tagName === 'footer'
              ? 'footer'
              : null;
        const preferredIndex = remainingEntries.findIndex((entry) => {
          if (!entry) return false;
          if (preferredTemplateName && entry.templateName === preferredTemplateName) {
            return true;
          }
          if (entry.blockName === blockName) return true;
          return false;
        });

        if (preferredIndex >= 0) {
          return remainingEntries.splice(preferredIndex, 1)[0];
        }

        return remainingEntries.shift() || null;
      })();

      const templateInfo = manifestEntry
        ? {
            templateName: manifestEntry.templateName || pageTemplateHint,
            sourceFile:
              manifestEntry.sourceFile ||
              defaultSourceFile ||
              inferSourceFile(pageTemplateHint, false),
            blockName: manifestEntry.blockName || blockName,
            topLevelIndex:
              typeof manifestEntry.topLevelIndex === 'number'
                ? manifestEntry.topLevelIndex
                : topLevelIndex,
            sourceNodeId: manifestEntry.sourceNodeId,
          }
        : {
            ...resolveSharedTemplateForRoot(
              element,
              blockName,
              pageTemplateHint,
            ),
            blockName,
            topLevelIndex,
            sourceNodeId: buildSourceNodeId(
              resolveSharedTemplateForRoot(
                element,
                blockName,
                pageTemplateHint,
              ).templateName,
              blockName,
              topLevelIndex,
            ),
          };
      const sourceNodeId =
        templateInfo.sourceNodeId ||
        buildSourceNodeId(
          templateInfo.templateName,
          templateInfo.blockName || blockName,
          templateInfo.topLevelIndex,
        );

      element.dataset.vpSourceNode = sourceNodeId;
      element.dataset.vpSourceFile = templateInfo.sourceFile || '';
      element.dataset.vpTopLevelIndex = String(templateInfo.topLevelIndex);
      element.dataset.vpTemplate = templateInfo.templateName;
      element.dataset.vpSectionKey = normalizeSourceToken(
        templateInfo.blockName || blockName,
        'section',
      );

      if (templateInfo.blockName || blockName) {
        element.dataset.vpBlockName = templateInfo.blockName || blockName;
      }
      if (metadata.blockClientId) {
        element.dataset.vpBlockClientId = metadata.blockClientId;
      }
    });
  };

  const route = defaultRoute || location.pathname || '/';
  const templateHint = detectTemplateHint();
  const pageSourceFile = defaultSourceFile || inferSourceFile(templateHint, false);
  const sourceRoots = collectTopLevelSourceRoots();
  annotateSourceRoots(sourceRoots, templateHint);

  const candidates = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
  let counter = 0;

  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;

    const blockMetadata = getBlockMetadata(element);
    const nearestHeading = resolveHeadingText(element);
    const sourceRoot = element.closest('[data-vp-source-node]');
    const nodeRole = inferNodeRole(element);

    if (!element.dataset.vpNodeId) {
      const semanticKey =
        element.getAttribute('id') ||
        element.getAttribute('data-block') ||
        element.getAttribute('data-id') ||
        blockMetadata.blockName ||
        element.tagName.toLowerCase();
      element.dataset.vpNodeId = 'vp_' + normalizeSourceToken(semanticKey, 'node') + '_' + counter;
      counter += 1;
    }

    element.dataset.vpRoute = route;
    element.dataset.vpTag = element.tagName.toLowerCase();
    element.dataset.vpDomPath = getDomPath(element);
    element.dataset.vpNodeRole = nodeRole;

    if (sourceRoot instanceof HTMLElement) {
      if (sourceRoot.dataset.vpNodeId) {
        element.dataset.vpOwnerNodeId = sourceRoot.dataset.vpNodeId;
      }
      if (sourceRoot.dataset.vpSourceNode) {
        element.dataset.vpOwnerSourceNode = sourceRoot.dataset.vpSourceNode;
      }
      if (sourceRoot.dataset.vpSourceFile) {
        element.dataset.vpOwnerSourceFile = sourceRoot.dataset.vpSourceFile;
      }
      if (sourceRoot.dataset.vpTopLevelIndex) {
        element.dataset.vpOwnerTopLevelIndex = sourceRoot.dataset.vpTopLevelIndex;
      }
      if (sourceRoot.dataset.vpSectionKey) {
        element.dataset.vpOwnerSectionKey = sourceRoot.dataset.vpSectionKey;
      }
      if (sourceRoot.dataset.vpTemplate) {
        element.dataset.vpOwnerTemplate = sourceRoot.dataset.vpTemplate;
      }
    } else {
      element.dataset.vpTemplate = templateHint;
    }

    if (blockMetadata.blockName) {
      element.dataset.vpBlockName = blockMetadata.blockName;
    }

    if (blockMetadata.blockClientId) {
      element.dataset.vpBlockClientId = blockMetadata.blockClientId;
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
  document.documentElement.dataset.vpSourceFile = pageSourceFile;
  if (defaultSiteId) {
    document.documentElement.dataset.vpSiteId = defaultSiteId;
  }
  document.documentElement.dataset.vpInstrumented = 'true';
})();
  `.trim();
}

function injectWpPreviewMetadata(html, input) {
  const targetUrl =
    typeof input === "string"
      ? input
      : input?.targetUrl;
  if (!targetUrl) return html;

  let resolvedUrl;
  try {
    resolvedUrl = new URL(targetUrl);
  } catch {
    return html;
  }

  const route = resolvedUrl.pathname || "/";
  const templateHint =
    typeof input === "string"
      ? inferTemplateHintFromRoute(route)
      : input?.templateHint || inferTemplateHintFromRoute(route);
  const sourceFile =
    typeof input === "string" ? "" : input?.sourceFile || "";
  const siteId =
    typeof input === "string" ? "" : input?.siteId || "";
  const sourceMap =
    typeof input === "string" ? [] : input?.sourceMap || [];
  const script = buildPreviewInstrumentationScript({
    route,
    templateHint,
    sourceFile,
    siteId,
    sourceMap,
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
