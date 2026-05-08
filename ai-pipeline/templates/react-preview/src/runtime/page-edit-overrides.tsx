import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

interface PageEditPatch {
  op: 'replace-text' | 'update-colors' | 'replace-image' | 'insert-simple-section';
  target?: {
    sourceNodeId?: string;
    sectionKey?: string;
  };
  value?: Record<string, unknown>;
}

interface PageEditOverrideResponse {
  route: string;
  patches: PageEditPatch[];
}

export function PageEditOverrideApplier({ apiBase = '' }: { apiBase?: string }) {
  const location = useLocation();

  useEffect(() => {
    const route = `${location.pathname}${location.search}`;
    let cancelled = false;

    async function applyOverrides() {
      if (document.querySelector('[data-runtime-component="RuntimePage"]')) {
        return;
      }

      try {
        const res = await fetch(
          `${apiBase}/api/runtime/edit-overrides?route=${encodeURIComponent(route || '/')}`,
        );
        if (!res.ok) return;
        const payload = (await res.json()) as PageEditOverrideResponse;
        if (cancelled || !Array.isArray(payload.patches)) return;
        for (const patch of payload.patches) {
          applyDomPatch(patch);
        }
      } catch {
        // Overrides are optional; the baseline preview should remain usable.
      }
    }

    window.requestAnimationFrame(() => void applyOverrides());

    return () => {
      cancelled = true;
    };
  }, [apiBase, location.pathname, location.search]);

  return null;
}

function applyDomPatch(patch: PageEditPatch): void {
  if (patch.op === 'insert-simple-section') {
    insertSimpleSection(patch);
    return;
  }

  const target = findPatchTarget(patch);
  if (!target) return;

  if (patch.op === 'replace-text') {
    const text = readPatchString(patch.value?.text);
    if (text) target.textContent = text;
    return;
  }

  if (patch.op === 'update-colors') {
    const color = readPatchString(patch.value?.color ?? patch.value?.textColor);
    const backgroundColor = readPatchString(
      patch.value?.backgroundColor ?? patch.value?.bgColor,
    );
    if (color) target.style.color = color;
    if (backgroundColor) target.style.backgroundColor = backgroundColor;
    return;
  }

  if (patch.op === 'replace-image') {
    const src = readPatchString(patch.value?.src);
    if (!src) return;
    const img =
      target.tagName.toLowerCase() === 'img'
        ? (target as HTMLImageElement)
        : target.querySelector('img');
    if (!img) return;
    img.src = resolvePatchAsset(src);
    const alt = readPatchString(patch.value?.alt);
    if (alt) img.alt = alt;
  }
}

function findPatchTarget(patch: PageEditPatch): HTMLElement | null {
  const sourceNodeId = patch.target?.sourceNodeId;
  if (sourceNodeId) {
    const bySource = document.querySelector(
      `[data-source-node-id="${cssEscape(sourceNodeId)}"]`,
    );
    if (bySource instanceof HTMLElement) return bySource;
  }

  const sectionKey = patch.target?.sectionKey;
  if (sectionKey) {
    const bySection = document.querySelector(
      `[data-section-key="${cssEscape(sectionKey)}"]`,
    );
    if (bySection instanceof HTMLElement) return bySection;
  }

  return null;
}

function insertSimpleSection(patch: PageEditPatch): void {
  const section = document.createElement('section');
  section.className = 'runtime-page__inserted-section alignfull';
  section.dataset.runtimeInserted = 'page-edit';
  section.style.boxSizing = 'border-box';
  section.style.width = '100%';
  section.style.padding = '80px 20px';
  section.style.textAlign = 'center';
  section.style.color = readPatchString(patch.value?.textColor) ?? '#ffffff';
  section.style.backgroundColor =
    readPatchString(patch.value?.backgroundColor) ?? '#111111';

  const backgroundImage = readPatchString(
    patch.value?.backgroundImage ?? patch.value?.src,
  );
  if (backgroundImage) {
    section.style.backgroundImage = `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url("${resolvePatchAsset(backgroundImage)}")`;
    section.style.backgroundSize = 'cover';
    section.style.backgroundPosition = 'center';
  }

  const inner = document.createElement('div');
  inner.style.maxWidth = 'var(--wp--style--global--content-size, 1200px)';
  inner.style.margin = '0 auto';

  const heading = document.createElement('h2');
  heading.textContent = readPatchString(patch.value?.heading) ?? 'New Section';
  heading.style.fontSize = 'clamp(2rem, 5vw, 3.25rem)';
  heading.style.lineHeight = '1.15';
  heading.style.margin = '0 0 1rem';
  inner.appendChild(heading);

  const bodyText = readPatchString(patch.value?.body);
  if (bodyText) {
    const body = document.createElement('p');
    body.textContent = bodyText;
    body.style.maxWidth = '760px';
    body.style.margin = '0 auto';
    body.style.lineHeight = '1.7';
    inner.appendChild(body);
  }

  section.appendChild(inner);

  const target = findPatchTarget(patch);
  if (target?.parentElement) {
    target.insertAdjacentElement('afterend', section);
    return;
  }

  document.querySelector('main')?.appendChild(section) ??
    document.body.appendChild(section);
}

function readPatchString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolvePatchAsset(src: string): string {
  if (src.startsWith('theme-asset:')) {
    const assetPath = src.slice('theme-asset:'.length).replace(/^\/+/, '');
    return `${import.meta.env.BASE_URL}assets/${assetPath.replace(/^assets\//, '')}`;
  }
  if (src.startsWith('/assets/')) {
    return `${import.meta.env.BASE_URL}assets/${src.slice('/assets/'.length)}`;
  }
  return src;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
