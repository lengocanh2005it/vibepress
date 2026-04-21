import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AiProcessError,
  submitReactVisualEdit,
  type ReactVisualEditPayload,
  type ReactVisualEditRouteEntry,
} from "../services/AiService";
import { useInspector } from "../hooks/useInspector";

interface SourceMapEntry {
  sourceNodeId: string;
  templateName?: string;
  sourceFile?: string;
  topLevelIndex?: number;
  blockName?: string;
  componentName?: string;
  sectionKey?: string;
  sectionComponentName?: string;
  outputFilePath?: string;
  startLine?: number;
  endLine?: number;
}

type PipelineJobStatus =
  | "running"
  | "stopping"
  | "stopped"
  | "done"
  | "error"
  | "deleted";

interface MetricPage {
  url: string | null;
  slug: string;
  type: string;
}

interface PipelineStatusResponse {
  jobId: string;
  status: PipelineJobStatus;
  error?: string;
  result?: {
    previewDir?: string;
    frontendDir?: string;
    previewUrl?: string;
    apiBaseUrl?: string;
    uiSourceMapPath?: string;
    routeEntries?: ReactVisualEditRouteEntry[];
    metrics?: {
      pages: MetricPage[];
    };
  };
}

interface LocationState {
  jobId?: string;
  siteId?: string;
  previewUrl?: string;
  apiBaseUrl?: string;
}

interface RouteItem {
  id: string;
  label: string;
  route: string;
  pageUrl: string;
  typeLabel: string;
  componentName?: string;
}

interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  tone?: "default" | "success" | "error";
}

const normalizeRoute = (value?: string | null) => {
  if (!value) return "/";
  const withoutOrigin = value.trim().replace(/^https?:\/\/[^/]+/i, "");
  const withoutHash = withoutOrigin.split("#")[0] ?? withoutOrigin;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  const normalized = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const trimmed = normalized.replace(/\/+$/g, "");
  return trimmed || "/";
};

const routeLabel = (value: string) =>
  value
    .replace(/^\/+|\/+$/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Home";

const toPageUrl = (previewUrl: string, route: string) => {
  // Strip leading slashes so the route is relative — prevents new URL() from
  // overriding the preview/{jobId}/ base path when the route starts with "/".
  const base = previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`;
  const cleanRoute = route.replace(/^\/+/, "");
  try {
    return new URL(cleanRoute, base).toString();
  } catch {
    return `${base}${cleanRoute}`;
  }
};


const buildRouteItems = (
  previewUrl?: string,
  metricsPages?: MetricPage[],
  routeEntries?: ReactVisualEditRouteEntry[],
) => {
  if (!previewUrl) return [] as RouteItem[];
  const map = new Map<string, RouteItem>();

  for (const page of metricsPages ?? []) {
    const route = normalizeRoute(page.url || "/");
    map.set(route, {
      id: `metrics:${route}`,
      label: page.slug === "/" || route === "/" ? "Home" : routeLabel(page.slug || route),
      route,
      pageUrl: toPageUrl(previewUrl, route),
      typeLabel: page.type || "page",
    });
  }

  for (const entry of routeEntries ?? []) {
    const route = normalizeRoute(entry.route);
    if (route.includes(":")) continue;
    const existing = map.get(route);
    map.set(route, {
      id: existing?.id || `preview:${route}`,
      label: existing?.label || (route === "/" ? "Home" : routeLabel(entry.componentName || route)),
      route,
      pageUrl: toPageUrl(previewUrl, route),
      typeLabel: existing?.typeLabel || "route",
      componentName: entry.componentName,
    });
  }

  if (!map.has("/")) {
    map.set("/", {
      id: "preview:/",
      label: "Home",
      route: "/",
      pageUrl: toPageUrl(previewUrl, "/"),
      typeLabel: "home",
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.route === "/") return -1;
    if (b.route === "/") return 1;
    return a.route.localeCompare(b.route);
  });
};

const VisualEditor: React.FC = () => {
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const jobId = state.jobId || "";
  const siteId = state.siteId || "";

  const {
    iframeRef,
    isActive: inspectorActive,
    selectedComponent,
    toggle: toggleInspector,
  } = useInspector();

  const [statusData, setStatusData] = useState<PipelineStatusResponse | null>(null);
  const [loading, setLoading] = useState(!!jobId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    fetch(`/ai-api/pipeline/status/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PipelineStatusResponse>;
      })
      .then((data) => {
        setStatusData(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Không thể tải dữ liệu.");
        setLoading(false);
      });
  }, [jobId]);

  const [sourceMap, setSourceMap] = useState<SourceMapEntry[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [frameTitle, setFrameTitle] = useState("");
  const [loadedSrc, setLoadedSrc] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      text: "Chọn route trong preview, dùng Inspector để chọn component, rồi nhập yêu cầu chỉnh sửa.",
    },
  ]);
  const [annotationComment, setAnnotationComment] = useState("");
  const [savedAnnotations, setSavedAnnotations] = useState<Array<{
    id: string;
    component: import("../types/inspector").ComponentInfo;
    comment: string;
    route: string;
    savedAt: string;
  }>>([]);

  const previewUrl = statusData?.result?.previewUrl || state.previewUrl || "";
  const apiBaseUrl = statusData?.result?.apiBaseUrl || state.apiBaseUrl || "";

  useEffect(() => {
    if (!previewUrl) return;
    let resolved = previewUrl;
    try {
      const parsed = new URL(previewUrl);
      const isInternal =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "ai_pipeline";
      if (isInternal && window.location.hostname !== "localhost") {
        resolved = parsed.pathname + parsed.search + parsed.hash;
      }
    } catch { /* relative URL — use as-is */ }
    const mapUrl = (resolved.endsWith("/") ? resolved : `${resolved}/`) + "ui-source-map.json";
    fetch(mapUrl)
      .then((r) => (r.ok ? (r.json() as Promise<SourceMapEntry[]>) : Promise.reject()))
      .then(setSourceMap)
      .catch(() => {});
  }, [previewUrl]);

  const resolvePreviewUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const isInternal =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "ai_pipeline";
      if (isInternal && window.location.hostname !== "localhost") {
        return parsed.pathname + parsed.search + parsed.hash;
      }
    } catch {
      // not a valid absolute URL — return as-is
    }
    return url;
  };

  const resolvedPreviewUrl = resolvePreviewUrl(previewUrl);

  const routes = useMemo(
    () =>
      buildRouteItems(
        resolvedPreviewUrl,
        statusData?.result?.metrics?.pages,
        statusData?.result?.routeEntries,
      ),
    [resolvedPreviewUrl, statusData?.result?.metrics?.pages, statusData?.result?.routeEntries],
  );

  const effectiveRouteId = routes.some((r) => r.id === selectedRouteId)
    ? selectedRouteId
    : (routes[0]?.id ?? "");

  const selectedRoute = routes.find((r) => r.id === effectiveRouteId) || routes[0] || null;
  const selectedPageUrl = selectedRoute?.pageUrl || resolvedPreviewUrl;
  const frameSrc = selectedPageUrl;
  const frameLoading = loadedSrc !== frameSrc;

  const refreshFrameMeta = () => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    setFrameTitle(frameDocument.title || selectedRoute?.label || "React Preview");
  };

  const buildPayload = (): ReactVisualEditPayload => {
    const mapEntry = selectedComponent?.vpSourceNode
      ? sourceMap.find((e) => e.sourceNodeId === selectedComponent.vpSourceNode)
      : undefined;

    return {
      prompt: prompt.trim() || undefined,
      language: /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(prompt)
        ? "vi"
        : "en",
      pageContext: {
        reactUrl: selectedPageUrl,
        reactRoute: selectedRoute?.route || "/",
        iframeSrc: frameSrc,
        pageTitle: frameTitle || selectedRoute?.label,
      },
      attachments: [],
      targetHint: {
        route: selectedRoute?.route || "/",
        // Layer 2: section identity — prefer data-vp-* from DOM, fall back to route-level component
        sourceNodeId: selectedComponent?.vpSourceNode,
        sectionKey: selectedComponent?.vpSectionKey,
        componentName: selectedComponent?.vpComponent || selectedComponent?.component || selectedRoute?.componentName,
        sectionComponentName: selectedComponent?.vpSectionComponent,
        templateName: selectedComponent?.vpTemplate,
        sourceFile: selectedComponent?.vpSourceFile,
        // Layer 3: code location — from ui-source-map.json lookup
        outputFilePath: mapEntry?.outputFilePath,
        startLine: mapEntry?.startLine,
        endLine: mapEntry?.endLine,
        // Child node targeting
        targetNodeRole: selectedComponent?.targetNodeRole,
        targetElementTag: selectedComponent?.targetElementTag,
        targetTextPreview: selectedComponent?.targetTextPreview,
        targetStartLine: selectedComponent?.targetStartLine,
      },
      constraints: {
        preserveOutsideSelection: false,
        preserveDataContract: true,
        rerunFromScratch: false,
      },
      reactSourceTarget: {
        previewDir: statusData?.result?.previewDir,
        frontendDir: statusData?.result?.frontendDir,
        previewUrl,
        apiBaseUrl,
        uiSourceMapPath: statusData?.result?.uiSourceMapPath,
        routeEntries: statusData?.result?.routeEntries || [],
      },
    };
  };

  const handleSaveAnnotation = () => {
    if (!selectedComponent) return;
    const item = {
      id: `annotation-${Date.now()}`,
      component: selectedComponent,
      comment: annotationComment.trim(),
      route: selectedRoute?.route || "/",
      savedAt: new Date().toISOString(),
    };
    setSavedAnnotations((prev) => [...prev, item]);
    console.log("[VisualEditor] Saved annotation:", item);
    setAnnotationComment("");
  };

  const handleSubmitRequest = async () => {
    if (!jobId || !siteId) return;
    if (!prompt.trim()) {
      setMessages((prev) => [
        ...prev,
        { id: `empty-${Date.now()}`, role: "assistant", text: "Hãy nhập yêu cầu trước khi gửi.", tone: "error" },
      ]);
      return;
    }

    setIsSubmittingRequest(true);
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", text: prompt.trim() },
    ]);

    try {
      await submitReactVisualEdit(siteId, jobId, buildPayload());
      setMessages((prev) => [
        ...prev,
        {
          id: `success-${Date.now()}`,
          role: "assistant",
          text: "Yêu cầu đã được gửi đến AI. Backend đang xử lý.",
          tone: "success",
        },
      ]);
      setPrompt("");
    } catch (submitError) {
      const message =
        submitError instanceof AiProcessError
          ? submitError.message
          : submitError instanceof Error
            ? submitError.message
            : "Gửi request thất bại.";
      setMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, role: "assistant", text: message, tone: "error" },
      ]);
    } finally {
      setIsSubmittingRequest(false);
    }
  };

  return (
    <div className="h-[calc(100vh-96px)] overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(244,228,200,0.55),_transparent_34%),linear-gradient(135deg,_#f7f1e7_0%,_#f2ece2_42%,_#ece7df_100%)] px-4 pb-4 pt-4">
      <div className="flex h-full flex-col gap-4">
        <section className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] gap-4">

          {/* Preview Canvas */}
          <div className="min-h-0 overflow-hidden rounded-[30px] border border-[#ddd2c4] bg-[#f9f6ef] shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-[#ece2d6] px-5 py-3">
              {/* Route selector */}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">
                  Preview Canvas
                </p>
                {loading ? (
                  <span className="text-xs text-[#9ca3af]">Đang tải...</span>
                ) : error ? (
                  <span className="text-xs text-[#e57373]">{error}</span>
                ) : (
                  <select
                    value={effectiveRouteId}
                    onChange={(e) => setSelectedRouteId(e.target.value)}
                    className="w-1/4 min-w-[160px] rounded-full border border-[#d8cfbf] bg-white px-3 py-1 text-xs font-medium text-[#1f2a24] outline-none transition focus:border-[#3f6b58] cursor-pointer"
                  >
                    {routes.map((route) => (
                      <option key={route.id} value={route.id}>
                        {route.label} — {route.route}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {/* Actions */}
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={toggleInspector}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                    inspectorActive
                      ? "bg-[#6d3aa3] text-white hover:bg-[#5c2f8f]"
                      : "border border-[#d8cfbf] bg-white text-[#30483d] hover:bg-[#f6f2eb]"
                  }`}
                >
                  {inspectorActive ? "Tắt Inspector" : "Bật Inspector"}
                </button>
                <button
                  onClick={() => {
                    setLoadedSrc("");
                    iframeRef.current?.contentWindow?.location.reload();
                  }}
                  className="rounded-full border border-[#d8cfbf] bg-white px-4 py-1.5 text-sm font-semibold text-[#30483d] transition hover:bg-[#f6f2eb]"
                >
                  Tải lại
                </button>
              </div>
            </div>
            <div className="relative h-[calc(100%-57px)] p-4">
              <div className="relative h-full overflow-hidden rounded-[26px] border border-[#d9d0c4] bg-white shadow-inner">
                <iframe
                  ref={iframeRef}
                  src={frameSrc}
                  title="React Visual Preview"
                  className="h-full w-full bg-white"
                  onLoad={() => {
                    refreshFrameMeta();
                    setLoadedSrc(frameSrc);
                  }}
                />
                {frameLoading && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold text-[#4f5d54] backdrop-blur-sm">
                    Đang tải route...
                  </div>
                )}
                <div className="pointer-events-none absolute left-5 top-5 rounded-2xl border border-white/70 bg-white/92 px-4 py-3 shadow-lg backdrop-blur">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a7a62]">Trang đang xem</p>
                  <p className="mt-1 text-sm font-semibold text-[#1f2a24]">{frameTitle || selectedRoute?.label || "React Preview"}</p>
                  <p className="mt-1 text-xs text-[#6c7267]">{selectedPageUrl || "Đang khởi tạo..."}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right sidebar: Inspector + Annotation */}
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf5] shadow-sm">

            {/* Header */}
            <div className="flex-none border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Inspector</p>
              <p className="mt-1 text-sm text-[#617067]">
                {inspectorActive ? "Click vào element để xem thông tin." : "Bật Inspector rồi click vào element trong preview."}
              </p>
            </div>

            {/* Scrollable body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-3">

              {/* Selected element info */}
              {selectedComponent ? (
                <div className="rounded-[20px] border border-[#ddd2c4] bg-white overflow-hidden">
                  {/* Component name + tag */}
                  <div className="px-4 pt-4 pb-3 border-b border-[#f0ebe3]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#6366f1] text-sm">{selectedComponent.component}</span>
                      <code className="rounded bg-[#efe7d8] px-1.5 py-0.5 text-[10px] font-bold text-[#7f6846]">
                        {selectedComponent.tag.toLowerCase()}
                      </code>
                    </div>
                    {selectedComponent.text && (
                      <p className="mt-1.5 truncate text-[11px] text-[#9ca3af]">"{selectedComponent.text}"</p>
                    )}
                    <p className="mt-1 text-[11px] text-[#b4ada4]">{selectedComponent.rect.w} × {selectedComponent.rect.h} px</p>
                  </div>

                  {/* Source file */}
                  {selectedComponent.source?.file && (
                    <div className="bg-[#1e1e2e] px-4 py-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6366f1] mb-1">Source</p>
                      <p className="break-all font-mono text-[11px] text-[#a5b4fc]">{selectedComponent.source.file}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-[#f59e0b]">line {selectedComponent.source.line}</p>
                    </div>
                  )}

                  {/* Section identity */}
                  {selectedComponent.vpSourceNode && (
                    <div className="px-4 py-3 border-t border-[#f0ebe3]">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b826f] mb-1.5">Section</p>
                      <p className="font-mono text-[11px] text-[#374151]">{selectedComponent.vpSourceNode}</p>
                      {selectedComponent.vpSectionKey && (
                        <p className="mt-0.5 text-[11px] text-[#6b7280]">
                          key: <span className="font-semibold text-[#374151]">{selectedComponent.vpSectionKey}</span>
                          {selectedComponent.vpComponent && <span className="ml-1.5 text-[#9ca3af]">· {selectedComponent.vpComponent}</span>}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-[20px] border border-dashed border-[#ddd2c4] bg-white px-4 py-8 text-center">
                  <p className="text-[13px] text-[#9ca3af]">Chưa chọn element nào</p>
                  <p className="mt-1 text-[11px] text-[#b4ada4]">Bật Inspector và click vào element trong preview</p>
                </div>
              )}

              {/* Comment input */}
              <div className="rounded-[20px] border border-[#e6dece] bg-white p-4">
                <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a7a62]">Ghi chú</label>
                <textarea
                  value={annotationComment}
                  onChange={(e) => setAnnotationComment(e.target.value)}
                  placeholder="Nhập ghi chú hoặc yêu cầu chỉnh sửa cho element này..."
                  className="mt-2 h-24 w-full resize-none rounded-[14px] border border-[#e7dfd2] bg-[#fcfaf6] px-3 py-2.5 text-sm text-[#243129] outline-none transition focus:border-[#6366f1] focus:bg-white"
                />
                <button
                  onClick={handleSaveAnnotation}
                  disabled={!selectedComponent}
                  className="mt-2.5 w-full rounded-full bg-[#6366f1] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#4f46e5] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Lưu annotation
                </button>
              </div>

              {/* Saved annotations list */}
              {savedAnnotations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8b826f] px-1">
                    Đã lưu ({savedAnnotations.length})
                  </p>
                  {savedAnnotations.map((item) => (
                    <div key={item.id} className="rounded-[16px] border border-[#e7dfd3] bg-white px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] font-semibold text-[#6366f1]">{item.component.component}</span>
                        <code className="rounded bg-[#efe7d8] px-1.5 py-0.5 text-[9px] font-bold text-[#7f6846]">
                          {item.component.tag.toLowerCase()}
                        </code>
                      </div>
                      <p className="mt-0.5 text-[10px] text-[#9ca3af]">{item.route}</p>
                      {item.comment && (
                        <p className="mt-1.5 text-[12px] text-[#374151] leading-5">"{item.comment}"</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* AI submit messages */}
              {messages.filter(m => m.role !== "system").length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8b826f] px-1">AI</p>
                  {messages.filter(m => m.role !== "system").map((message) => (
                    <div
                      key={message.id}
                      className={`rounded-[16px] px-4 py-3 text-sm ${
                        message.role === "user"
                          ? "bg-[#315f4e] text-white"
                          : message.tone === "success"
                            ? "border border-[#cae0d1] bg-[#eef7f1] text-[#2b5643]"
                            : message.tone === "error"
                              ? "border border-[#f0c9c0] bg-[#fff2ef] text-[#984b3f]"
                              : "border border-[#e8dfd1] bg-white text-[#31473d]"
                      }`}
                    >
                      {message.text}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer: Send to AI */}
            <div className="flex-none border-t border-[#ede4d8] px-4 py-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Yêu cầu AI chỉnh sửa (dựa trên element đã chọn)..."
                className="h-20 w-full resize-none rounded-[14px] border border-[#e7dfd2] bg-[#fcfaf6] px-3 py-2.5 text-sm text-[#243129] outline-none transition focus:border-[#3a6b57] focus:bg-white"
              />
              <button
                onClick={() => void handleSubmitRequest()}
                disabled={isSubmittingRequest}
                className="mt-2 w-full rounded-full bg-[#8b5c32] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#744a26] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmittingRequest ? "Đang gửi..." : "Gửi cho AI"}
              </button>
            </div>
          </aside>

        </section>
      </div>
    </div>
  );
};

export default VisualEditor;
