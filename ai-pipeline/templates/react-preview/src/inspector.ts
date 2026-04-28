// src/inspector.ts

interface ComponentInfo {
  component: string;
  tag: string;
  text: string;
  classes: string[];
  rect: { w: number; h: number };
  source?: {
    file: string;
    line: number;
    column?: number;
  };
  // Section identity — minimal DOM markers; resolve detailed metadata via ui-source-map
  vpSourceNode?: string;
  vpSectionKey?: string;
  vpComponent?: string;
  // Child node targeting — describes the specific element clicked
  targetNodeRole?: string;
  targetElementTag?: string;
  targetTextPreview?: string;
  targetStartLine?: number;
}

type InspectorCommand = 'INSPECTOR_ENABLE' | 'INSPECTOR_DISABLE';

// ── React Fiber helpers ───────────────────────────────────
interface ReactFiber {
  type?: unknown;
  elementType?: unknown;
  return?: ReactFiber;
  _debugSource?: {
    fileName: string;
    lineNumber: number;
    columnNumber?: number;
  };
  _debugOwner?: ReactFiber;
}

function getReactFiber(el: Element): ReactFiber | null {
  const key = Object.keys(el).find(
    (k) =>
      k.startsWith('__reactFiber') ||
      k.startsWith('__reactInternalInstance'),
  );
  return key ? (el as unknown as Record<string, ReactFiber>)[key] : null;
}

function resolveTypeName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'function') {
    return (type as { displayName?: string; name?: string }).displayName
      || (type as { name?: string }).name
      || null;
  }
  if (typeof type === 'object') {
    const t = type as {
      displayName?: string;
      name?: string;
      render?: unknown;
      type?: unknown;
      $$typeof?: symbol;
    };
    return (
      t.displayName
      || t.name
      || resolveTypeName(t.render)
      || resolveTypeName(t.type)
      || null
    );
  }
  return null;
}

function getComponentName(el: Element): string {
  const fiber = getReactFiber(el);
  if (!fiber) return el.tagName.toLowerCase();

  let current: ReactFiber | undefined = fiber;
  while (current) {
    const name =
      resolveTypeName(current.type) ||
      resolveTypeName(current.elementType);

    if (name && /^[A-Z]/.test(name)) return name;
    current = current.return;
  }

  return el.tagName.toLowerCase();
}

function extractSource(
  src: NonNullable<ReactFiber['_debugSource']>,
): ComponentInfo['source'] | null {
  if (src.fileName.includes('node_modules') || src.fileName.startsWith('\0')) {
    return null;
  }
  return {
    file: src.fileName.replace(/^.*\/src\//, 'src/'),
    line: src.lineNumber,
    column: src.columnNumber,
  };
}

function getSourceInfo(el: Element): ComponentInfo['source'] {
  const fiber = getReactFiber(el);
  if (!fiber) return undefined;

  {
    let owner: ReactFiber | undefined = fiber._debugOwner;
    while (owner) {
      if (owner._debugSource) {
        const s = extractSource(owner._debugSource);
        if (s) return s;
      }
      owner = owner._debugOwner;
    }
  }

  {
    let current: ReactFiber | undefined = fiber;
    while (current) {
      if (current._debugSource) {
        const s = extractSource(current._debugSource);
        if (s) return s;
      }
      current = current.return;
    }
  }

  return undefined;
}

// ── data-vp-* section identity ────────────────────────────
function getVpSectionData(el: Element): Pick<
  ComponentInfo,
  'vpSourceNode' | 'vpSectionKey' | 'vpComponent'
> {
  let current: Element | null = el;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.vpSourceNode) {
      return {
        vpSourceNode: current.dataset.vpSourceNode || undefined,
        vpSectionKey: current.dataset.vpSectionKey || undefined,
        vpComponent: current.dataset.vpComponent || undefined,
      };
    }
    current = current.parentElement;
  }
  return {};
}

// ── Target node role inference ────────────────────────────
function inferNodeRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role')?.toLowerCase();

  if (role === 'button' || tag === 'button') return 'button';
  if (role === 'link' || tag === 'a') return 'link';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (['img', 'picture', 'figure', 'video', 'svg', 'canvas'].includes(tag)) return 'media';
  if (tag === 'form') return 'form';
  if (['input', 'textarea', 'select'].includes(tag)) return 'input';
  if (['ul', 'ol', 'li', 'dl'].includes(tag)) return 'list';
  if (['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(tag)) return 'section';

  const className = String((el instanceof HTMLElement ? el.className : '') || '');
  if (/card|panel|tile|badge|banner/i.test(className)) return 'card';
  if (['p', 'span', 'label', 'small', 'strong', 'em'].includes(tag)) return 'text';

  return 'container';
}

export function startInspectorClient(): void {
  let isActive = false;

  // ── Tạo overlay highlight ─────────────────────────────────
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '99999',
    border: '2px solid #6366f1',
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderRadius: '4px',
    transition: 'all 60ms ease',
    display: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute',
    top: '-24px',
    left: '0',
    background: '#6366f1',
    color: '#fff',
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    fontFamily: 'monospace',
  } satisfies Partial<CSSStyleDeclaration>);

  overlay.appendChild(label);
  document.body.appendChild(overlay);

  // ── Highlight element ─────────────────────────────────────
  function highlight(el: Element): void {
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    const source = getSourceInfo(el);
    const componentName = getComponentName(el);
    label.textContent = source
      ? `${componentName}  ${source.file}:${source.line}`
      : componentName;
  }

  // ── Event handlers ────────────────────────────────────────
  function onMouseMove(e: MouseEvent): void {
    if (!isActive) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    highlight(el);
  }

  function onMouseOut(e: MouseEvent): void {
    if (!isActive) return;
    if (!e.relatedTarget) {
      overlay.style.display = 'none';
    }
  }

  function onClick(e: MouseEvent): void {
    if (!isActive || !(e.target instanceof Element)) return;
    e.preventDefault();
    e.stopPropagation();

    const r = e.target.getBoundingClientRect();
    const source = getSourceInfo(e.target);
    const vpData = getVpSectionData(e.target);

    const payload: ComponentInfo = {
      component: getComponentName(e.target),
      tag: e.target.tagName,
      text: (e.target as HTMLElement).innerText?.slice(0, 100) ?? '',
      classes: [...e.target.classList],
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      source,
      ...vpData,
      targetNodeRole: inferNodeRole(e.target),
      targetElementTag: e.target.tagName.toLowerCase(),
      targetTextPreview: (e.target as HTMLElement).innerText?.slice(0, 120) ?? '',
      targetStartLine: source?.line,
    };

    window.parent.postMessage({ type: 'INSPECTOR_DATA', payload }, '*');
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('click', onClick, true);

  // ── Nhận lệnh từ Dashboard ────────────────────────────────
  window.addEventListener('message', (e: MessageEvent) => {
    const type = e.data?.type as InspectorCommand;

    if (type === 'INSPECTOR_ENABLE') {
      isActive = true;
      document.body.style.cursor = 'crosshair';
    }

    if (type === 'INSPECTOR_DISABLE') {
      isActive = false;
      overlay.style.display = 'none';
      document.body.style.cursor = '';
    }
  });

  // ── Ctrl+I để toggle ──────────────────────────────────────
  document.addEventListener('keydown', (e: KeyboardEvent): void => {
    if (e.ctrlKey && e.key === 'i') {
      isActive = !isActive;
      document.body.style.cursor = isActive ? 'crosshair' : '';
      if (!isActive) overlay.style.display = 'none';
    }
  });
}

export type { ComponentInfo };
