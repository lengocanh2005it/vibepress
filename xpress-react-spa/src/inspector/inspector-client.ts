/**
 * Inspector client — inject vào preview app (chạy trong iframe).
 * Lắng nghe INSPECTOR_ENABLE/DISABLE từ dashboard, highlight element khi hover,
 * đọc _debugSource từ React fiber để lấy file + line khi click.
 *
 * Cách dùng trong preview app's main.tsx:
 *   import { startInspectorClient } from './inspector/inspector-client'
 *   if (import.meta.env.DEV) startInspectorClient()
 */

interface DebugSource {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}

interface ReactFiber {
  _debugSource?: DebugSource;
  return?: ReactFiber;
  type?: unknown;
  elementType?: unknown;
}

// Đọc React fiber từ DOM element
function getFiber(el: Element): ReactFiber | null {
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return key ? (el as any)[key] as ReactFiber : null;
}

// Đọc tên component từ fiber type
function getComponentName(fiber: ReactFiber | null): string {
  if (!fiber) return "Unknown";
  let f: ReactFiber | undefined = fiber;
  while (f) {
    const type = f.type ?? f.elementType;
    if (type) {
      if (typeof type === "function") return type.name || "Anonymous";
      if (typeof type === "object" && type !== null) {
        // forwardRef, memo, etc.
        const t = type as { displayName?: string; name?: string; render?: { name?: string } };
        return t.displayName ?? t.name ?? t.render?.name ?? "Anonymous";
      }
    }
    f = f.return;
  }
  return "Unknown";
}

// Đi ngược fiber tree để tìm _debugSource gần nhất
function getDebugSource(fiber: ReactFiber | null): DebugSource | null {
  let f: ReactFiber | undefined = fiber ?? undefined;
  while (f) {
    if (f._debugSource) return f._debugSource;
    f = f.return;
  }
  return null;
}

// Rút gọn đường dẫn file — bỏ prefix tuyệt đối, giữ từ src/ trở đi
function shortenPath(filePath: string): string {
  const idx = filePath.indexOf("/src/");
  return idx !== -1 ? filePath.slice(idx + 1) : filePath;
}

// Walk up DOM để tìm nearest ancestor có data-vp-source-node và đọc toàn bộ data-vp-*
function getVpSection(el: Element) {
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute("data-vp-source-node")) {
      return {
        vpSourceNode: node.getAttribute("data-vp-source-node") ?? undefined,
        vpTemplate: node.getAttribute("data-vp-template") ?? undefined,
        vpSourceFile: node.getAttribute("data-vp-source-file") ?? undefined,
        vpSectionKey: node.getAttribute("data-vp-section-key") ?? undefined,
        vpComponent: node.getAttribute("data-vp-component") ?? undefined,
        vpSectionComponent: node.getAttribute("data-vp-section-component") ?? undefined,
      };
    }
    node = node.parentElement;
  }
  return {};
}

// Suy ra semantic role từ HTML tag
function inferNodeRole(tag: string): string {
  const t = tag.toLowerCase();
  if (/^h[1-6]$/.test(t)) return "heading";
  if (["p", "span", "em", "strong", "blockquote", "label"].includes(t)) return "text";
  if (["img", "video", "picture", "figure", "canvas", "svg"].includes(t)) return "media";
  if (t === "button") return "button";
  if (t === "a") return "link";
  if (["input", "textarea", "select"].includes(t)) return "input";
  if (["ul", "ol", "li"].includes(t)) return "list";
  if (["nav", "header", "footer", "main", "section", "article", "aside"].includes(t)) return "section";
  return "container";
}

// ─── Overlay UI ─────────────────────────────────────────────────────────────

let overlayEl: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;

function ensureOverlay() {
  if (overlayEl) return;

  overlayEl = document.createElement("div");
  Object.assign(overlayEl.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "999998",
    outline: "2px solid #6366f1",
    background: "rgba(99,102,241,0.08)",
    transition: "all 60ms ease",
    borderRadius: "2px",
    boxSizing: "border-box",
  });

  labelEl = document.createElement("div");
  Object.assign(labelEl.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "999999",
    background: "#6366f1",
    color: "#fff",
    fontSize: "11px",
    fontFamily: "monospace",
    padding: "2px 7px",
    borderRadius: "4px",
    whiteSpace: "nowrap",
    lineHeight: "18px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
  });

  document.body.appendChild(overlayEl);
  document.body.appendChild(labelEl);
}

function removeOverlay() {
  overlayEl?.remove();
  labelEl?.remove();
  overlayEl = null;
  labelEl = null;
}

function positionOverlay(el: Element, component: string, sourceLabel: string) {
  if (!overlayEl || !labelEl) return;
  const r = el.getBoundingClientRect();
  Object.assign(overlayEl.style, {
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  labelEl.textContent = sourceLabel ? `${component}  ${sourceLabel}` : component;
  // đặt label ngay trên element, căn trái
  const labelTop = r.top > 22 ? r.top - 22 : r.top + r.height;
  Object.assign(labelEl.style, {
    top: `${labelTop}px`,
    left: `${r.left}px`,
  });
}

// ─── Inspector logic ─────────────────────────────────────────────────────────

let active = false;
let currentTarget: Element | null = null;

function onMouseOver(e: MouseEvent) {
  if (!active) return;
  const el = e.target as Element;
  if (el === currentTarget) return;
  currentTarget = el;
  ensureOverlay();

  const fiber = getFiber(el);
  const component = getComponentName(fiber);
  const src = getDebugSource(fiber);
  const sourceLabel = src
    ? `${shortenPath(src.fileName)}:${src.lineNumber}`
    : "";

  positionOverlay(el, component, sourceLabel);
}

function onMouseOut() {
  if (!active) return;
  currentTarget = null;
  if (overlayEl) {
    Object.assign(overlayEl.style, { width: "0", height: "0" });
  }
  if (labelEl) labelEl.textContent = "";
}

function onClick(e: MouseEvent) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();

  const el = e.target as Element;
  const fiber = getFiber(el);
  const src = getDebugSource(fiber);
  const rect = el.getBoundingClientRect();
  const textContent = (el.textContent ?? "").trim().slice(0, 100);

  window.parent.postMessage(
    {
      type: "INSPECTOR_DATA",
      payload: {
        component: getComponentName(fiber),
        tag: el.tagName,
        text: textContent,
        classes: Array.from(el.classList),
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        source: src
          ? {
              file: shortenPath(src.fileName),
              line: src.lineNumber,
              column: src.columnNumber,
            }
          : undefined,
        // Layer 2: section identity từ data-vp-* trên nearest ancestor
        ...getVpSection(el),
        // Layer 3: child node targeting
        targetNodeRole: inferNodeRole(el.tagName),
        targetElementTag: el.tagName.toLowerCase(),
        targetTextPreview: textContent,
        targetStartLine: src?.lineNumber,
      },
    },
    "*",
  );
}

function enable() {
  if (active) return;
  active = true;
  document.body.style.cursor = "crosshair";
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onClick, true);
  ensureOverlay();
}

function disable() {
  if (!active) return;
  active = false;
  document.body.style.cursor = "";
  document.removeEventListener("mouseover", onMouseOver, true);
  document.removeEventListener("mouseout", onMouseOut, true);
  document.removeEventListener("click", onClick, true);
  removeOverlay();
  currentTarget = null;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function startInspectorClient() {
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "INSPECTOR_ENABLE") enable();
    else if (e.data?.type === "INSPECTOR_DISABLE") disable();
  });
}
