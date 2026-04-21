import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AiProcessError,
  submitReactVisualEdit,
  type ReactVisualEditPayload,
  type ReactVisualEditRouteEntry,
} from "../services/AiService";
import { useInspector } from "../hooks/useInspector";
import { InspectorPanel } from "../components/InspectorPanel";

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
  try {
    return new URL(route, previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`).toString();
  } catch {
    return previewUrl;
  }
};

const buildProxyUrl = (pageUrl?: string | null, siteId?: string | null) => {
  if (!pageUrl) return "";
  const params = new URLSearchParams({ url: pageUrl });
  if (siteId) params.set("siteId", siteId);
  return `/api/wp/proxy?${params.toString()}`;
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
    clear: clearInspector,
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

  const previewUrl = statusData?.result?.previewUrl || state.previewUrl || "";
  const apiBaseUrl = statusData?.result?.apiBaseUrl || state.apiBaseUrl || "";

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
  const frameSrc = selectedPageUrl || buildProxyUrl(selectedPageUrl, siteId);
  const frameLoading = loadedSrc !== frameSrc;

  const refreshFrameMeta = () => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    setFrameTitle(frameDocument.title || selectedRoute?.label || "React Preview");
  };

  const buildPayload = (): ReactVisualEditPayload => ({
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
      componentName: selectedComponent?.component || selectedRoute?.componentName,
      route: selectedRoute?.route || "/",
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
  });

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
        <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_360px] gap-4">

          {/* Left sidebar: Routes + Inspector */}
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf3] shadow-sm">
            <div className="flex-none border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">React Routes</p>
              <p className="mt-1 text-sm text-[#617067]">Chọn page, post hoặc route trong preview React.</p>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {loading ? (
                <div className="rounded-2xl border border-dashed border-[#dccfbc] bg-white px-4 py-5 text-sm text-[#677164]">Đang tải context...</div>
              ) : error ? (
                <div className="rounded-2xl border border-[#e7c8c1] bg-[#fff2ef] px-4 py-5 text-sm text-[#9c4b3d]">{error}</div>
              ) : (
                <div className="space-y-2">
                  {routes.map((route) => (
                    <button
                      key={route.id}
                      onClick={() => setSelectedRouteId(route.id)}
                      className={`w-full rounded-[22px] border px-4 py-3 text-left transition ${
                        route.id === effectiveRouteId
                          ? "border-[#3f6b58] bg-[#eef6f1] shadow-sm"
                          : "border-[#e7dfd3] bg-white hover:bg-[#faf6ef]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-[#213129]">{route.label}</p>
                        <span className="rounded-full bg-[#efe7d8] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#7f6846]">
                          {route.typeLabel}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-[#6e746b]">{route.route}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {(inspectorActive || selectedComponent) && (
              <div className="flex-none border-t border-[#ede4d8]">
                <div className="border-b border-[#ede4d8] px-5 py-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Inspector</p>
                  <p className="mt-0.5 text-xs text-[#617067]">Click vào element để xem thông tin.</p>
                </div>
                <InspectorPanel info={selectedComponent} onClear={clearInspector} />
              </div>
            )}
          </aside>

          {/* Preview Canvas */}
          <div className="min-h-0 overflow-hidden rounded-[30px] border border-[#ddd2c4] bg-[#f9f6ef] shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ece2d6] px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Preview Canvas</p>
                <p className="mt-1 text-sm font-semibold text-[#1f2a24]">{selectedRoute?.label || "React Preview"}</p>
                <p className="mt-1 text-xs text-[#687067]">{selectedRoute?.route || "/"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={toggleInspector}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
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
                  className="rounded-full border border-[#d8cfbf] bg-white px-4 py-2 text-sm font-semibold text-[#30483d] transition hover:bg-[#f6f2eb]"
                >
                  Tải lại preview
                </button>
              </div>
            </div>
            <div className="relative h-[calc(100%-82px)] p-5">
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

          {/* Right sidebar: AI Chat */}
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf5] shadow-sm">
            <div className="flex-none border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">AI Visual Edit</p>
              <p className="mt-1 text-sm text-[#617067]">Dùng Inspector chọn component, rồi nhập yêu cầu chỉnh sửa.</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="space-y-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-[22px] px-4 py-3 ${
                      message.role === "user"
                        ? "ml-6 bg-[#315f4e] text-white"
                        : message.tone === "success"
                          ? "mr-6 border border-[#cae0d1] bg-[#eef7f1] text-[#2b5643]"
                          : message.tone === "error"
                            ? "mr-6 border border-[#f0c9c0] bg-[#fff2ef] text-[#984b3f]"
                            : "mr-6 border border-[#e8dfd1] bg-white text-[#31473d]"
                    }`}
                  >
                    <p className="text-sm leading-6">{message.text}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-none border-t border-[#ede4d8] px-5 py-4">
              <div className="rounded-[24px] border border-[#e6dece] bg-white p-4">
                <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a7a62]">Yêu cầu chỉnh sửa</label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ví dụ: đổi màu nút CTA thành xanh lá, tăng font-size heading..."
                  className="mt-3 h-32 w-full resize-none rounded-[18px] border border-[#e7dfd2] bg-[#fcfaf6] px-4 py-3 text-sm text-[#243129] outline-none transition focus:border-[#3a6b57] focus:bg-white"
                />
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    onClick={() => void handleSubmitRequest()}
                    disabled={isSubmittingRequest}
                    className="w-[50%] rounded-full bg-[#8b5c32] px-5 py-2.5 text-xs text-white transition hover:bg-[#744a26] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmittingRequest ? "Đang gửi..." : "Gửi cho AI"}
                  </button>
                </div>
              </div>
            </div>
          </aside>

        </section>
      </div>
    </div>
  );
};

export default VisualEditor;
