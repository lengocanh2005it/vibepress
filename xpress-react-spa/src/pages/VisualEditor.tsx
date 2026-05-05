import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AiProcessError,
  submitReactVisualEdit,
  undoReactVisualEdit,
  type ReactVisualEditPayload,
  type ReactVisualEditRouteEntry,
  type ReactVisualEditResult,
} from "../services/AiService";
import { captureRegion } from "../services/automationService";
import { useInspector } from "../hooks/useInspector";
import type { ComponentInfo } from "../types/inspector";

type PipelineJobStatus =
  | "running"
  | "awaiting_confirmation"
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
  deployedUrl?: string | null;
}

interface RouteItem {
  id: string;
  label: string;
  route: string;
  pageUrl: string;
  capturePageUrl: string;
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

const roundMetric = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const buildPreviewProxyUrl = (
  pageUrl?: string | null,
  siteId?: string | null,
  previewVersion?: number,
) => {
  if (!pageUrl) return "";

  const params = new URLSearchParams({ url: pageUrl });
  if (siteId) params.set("siteId", siteId);
  if (typeof previewVersion === "number") {
    params.set("vpv", String(previewVersion));
  }

  return `/api/wp/proxy?${params.toString()}`;
};

const buildRouteItems = (
  iframePreviewUrl?: string,
  capturePreviewUrl?: string,
  metricsPages?: MetricPage[],
  routeEntries?: ReactVisualEditRouteEntry[],
) => {
  const iframeBaseUrl = iframePreviewUrl || capturePreviewUrl;
  if (!iframeBaseUrl) return [] as RouteItem[];
  const map = new Map<string, RouteItem>();

  for (const page of metricsPages ?? []) {
    const route = normalizeRoute(page.url || "/");
    map.set(route, {
      id: `metrics:${route}`,
      label: page.slug === "/" || route === "/" ? "Home" : routeLabel(page.slug || route),
      route,
      pageUrl: toPageUrl(iframeBaseUrl, route),
      capturePageUrl: toPageUrl(capturePreviewUrl || iframeBaseUrl, route),
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
      pageUrl: toPageUrl(iframeBaseUrl, route),
      capturePageUrl:
        existing?.capturePageUrl ||
        toPageUrl(capturePreviewUrl || iframeBaseUrl, route),
      typeLabel: existing?.typeLabel || "route",
      componentName: entry.componentName,
    });
  }

  if (!map.has("/")) {
    map.set("/", {
      id: "preview:/",
      label: "Home",
      route: "/",
      pageUrl: toPageUrl(iframeBaseUrl, "/"),
      capturePageUrl: toPageUrl(capturePreviewUrl || iframeBaseUrl, "/"),
      typeLabel: "home",
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.route === "/") return -1;
    if (b.route === "/") return 1;
    return a.route.localeCompare(b.route);
  });
};

const normalizeVisualEditText = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/\s+/g, " ");

const detectUnsupportedVisualEditReason = (value: string) => {
  const normalized = normalizeVisualEditText(value);
  if (!normalized) return undefined;

  if (
    /\b(add|insert|create|introduce|implement|them|chen|tao moi|bo sung)\b/.test(normalized) &&
    /\b(section|component|widget|feature|module|carousel|slider|modal|popup|tabs|accordion|faq|newsletter|form|chat|chatbot)\b/.test(normalized)
  ) {
    return "add-section-or-component";
  }

  if (
    /\b(replace|convert|switch|swap|thay the|doi thanh|chuyen thanh)\b/.test(normalized) &&
    /\b(section|component|widget|layout block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(normalized)
  ) {
    return "replace-section-or-component";
  }

  if (
    /\b(remove|delete|drop|xoa|bo)\b/.test(normalized) &&
    /\b(section|component|widget|block|hero|banner|carousel|slider|modal|tabs|accordion|faq)\b/.test(normalized)
  ) {
    return "remove-section-or-component";
  }

  if (
    /\b(font|typography|font-size|text size|line-height|letter-spacing|font weight|chu|co chu)\b/.test(normalized)
  ) {
    return "typography-change";
  }

  return undefined;
};

const isBroadVisualEditRequest = (value: string) =>
  /\b(migrate|migration|full site|whole site|entire site|all pages|toan bo|toan site|toan website|ca trang)\b/.test(
    normalizeVisualEditText(value),
  );

const isMeaningfulVisualEditPrompt = (value: string) => {
  const normalized = normalizeVisualEditText(value);
  if (normalized.length < 6) return false;
  return ![
    "hello",
    "hi",
    "test",
    "ok",
    "oke",
    "fix this",
    "change this",
    "xin chao",
    "chao",
    "thu",
    "sua cai nay",
    "doi cai nay",
  ].includes(normalized);
};

const getUnsupportedVisualEditMessage = (reason?: string) => {
  switch (reason) {
    case "add-section-or-component":
      return "Visual edit này chỉ hỗ trợ chỉnh cục bộ trên app React hiện tại. Thêm section/widget/feature mới chưa được hỗ trợ ở đây.";
    case "replace-section-or-component":
      return "Visual edit này chỉ hỗ trợ chỉnh cục bộ. Thay nguyên section/component chưa được hỗ trợ ở đây.";
    case "remove-section-or-component":
      return "Visual edit này chỉ hỗ trợ chỉnh cục bộ. Xóa section/component chưa được hỗ trợ ở đây.";
    case "typography-change":
      return "Visual edit này hiện chưa hỗ trợ thay đổi typography đơn lẻ.";
    default:
      return "Yêu cầu visual edit chưa nằm trong phạm vi hỗ trợ.";
  }
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
    clear: clearSelectedComponent,
    syncWithIframe,
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
      text: "Chọn đúng route, click đúng element trong preview, rồi mô tả một chỉnh sửa cục bộ trên app React hiện tại.",
    },
  ]);
  const [canUndo, setCanUndo] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);

  const [publishState, setPublishState] = useState<{
    loading: boolean;
    frontendUrl: string | null;
    error: string | null;
  }>({ loading: false, frontendUrl: null, error: null });

  const [publishModal, setPublishModal] = useState<{
    open: boolean;
    subdomain: string;
    checking: boolean;
    checkError: string | null;
  }>({ open: false, subdomain: '', checking: false, checkError: null });

  const handlePublish = async (repoName: string) => {
    setPublishModal(s => ({ ...s, open: false }));
    setPublishState({ loading: true, frontendUrl: null, error: null });
    try {
      const res = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, siteId, repoName }),
      });
      const data = await res.json() as { success: boolean; frontendUrl?: string; githubUrl?: string; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed');
      setPublishState({ loading: false, frontendUrl: data.frontendUrl ?? null, error: null });
    } catch (err) {
      setPublishState({ loading: false, frontendUrl: null, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  };

  const handlePublishModalConfirm = async () => {
    const slug = publishModal.subdomain.trim().toLowerCase();
    if (!slug) {
      setPublishModal(s => ({ ...s, checkError: 'Vui lòng nhập subdomain.' }));
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) && slug.length > 1) {
      setPublishModal(s => ({ ...s, checkError: 'Chỉ dùng chữ thường, số và dấu gạch ngang.' }));
      return;
    }
    setPublishModal(s => ({ ...s, checking: true, checkError: null }));
    try {
      const res = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/deploy/check-subdomain?subdomain=${encodeURIComponent(slug)}`,
      );
      const data = await res.json() as { available: boolean };
      if (!data.available) {
        setPublishModal(s => ({ ...s, checking: false, checkError: `Subdomain "${slug}" đã được sử dụng. Vui lòng chọn tên khác.` }));
        return;
      }
    } catch {
      setPublishModal(s => ({ ...s, checking: false, checkError: 'Không thể kiểm tra subdomain. Thử lại.' }));
      return;
    }
    void handlePublish(slug);
  };
  const [annotationComment, setAnnotationComment] = useState("");
  const [savedAnnotations, setSavedAnnotations] = useState<Array<{
    id: string;
    component: ComponentInfo;
    comment: string;
    route: string;
    savedAt: string;
  }>>([]);

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
        previewUrl,
        statusData?.result?.metrics?.pages,
        statusData?.result?.routeEntries,
      ),
    [previewUrl, resolvedPreviewUrl, statusData?.result?.metrics?.pages, statusData?.result?.routeEntries],
  );

  const effectiveRouteId = routes.some((r) => r.id === selectedRouteId)
    ? selectedRouteId
    : (routes[0]?.id ?? "");

  const selectedRoute = routes.find((r) => r.id === effectiveRouteId) || routes[0] || null;
  const selectedPageUrl = selectedRoute?.pageUrl || resolvedPreviewUrl;
  const selectedCapturePageUrl = selectedRoute?.capturePageUrl || previewUrl || selectedPageUrl;
  const frameSrc = selectedPageUrl;
  const frameLoading = loadedSrc !== frameSrc;

  const refreshFrameMeta = () => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    setFrameTitle(frameDocument.title || selectedRoute?.label || "React Preview");
  };

  useEffect(() => {
    clearSelectedComponent();
  }, [clearSelectedComponent, frameSrc]);

  const buildAttachmentFromSelection = async () => {
    if (!selectedComponent?.viewportRect || !selectedComponent.viewport) {
      return undefined;
    }

    const now = new Date().toISOString();
    const result = await captureRegion(
      selectedCapturePageUrl,
      buildPreviewProxyUrl(selectedCapturePageUrl, siteId),
      {
        x: selectedComponent.viewportRect.x,
        y: selectedComponent.viewportRect.y,
        width: selectedComponent.viewportRect.width,
        height: selectedComponent.viewportRect.height,
      },
      prompt.trim(),
      selectedComponent.viewport,
    );

    return {
      id: `visual-edit-${Date.now()}`,
      note: prompt.trim() || undefined,
      sourcePageUrl: selectedCapturePageUrl,
      captureContext: {
        capturedAt: now,
        iframeSrc: frameSrc,
        viewport: selectedComponent.viewport,
        page: {
          url: selectedCapturePageUrl,
          route: selectedRoute?.route || "/",
          title: frameTitle || selectedRoute?.label,
        },
        document: selectedComponent.document,
      },
      selection: selectedComponent.documentRect,
      geometry: {
        viewportRect: selectedComponent.viewportRect,
        documentRect: selectedComponent.documentRect,
        normalizedRect: selectedComponent.normalizedRect,
      },
      asset: {
        provider: result.asset?.provider ?? "local",
        fileName: result.asset?.fileName ?? result.fileName,
        publicUrl: result.asset?.url ?? result.filePath,
        mimeType: result.asset?.mimeType as "image/png" | "image/jpeg" | "image/webp" | undefined,
        width: result.asset?.width ?? Math.max(1, Math.round(selectedComponent.viewportRect.width)),
        height: result.asset?.height ?? Math.max(1, Math.round(selectedComponent.viewportRect.height)),
      },
    };
  };

  const buildPayload = async (): Promise<ReactVisualEditPayload> => {
    const attachment = await buildAttachmentFromSelection();
    const componentName =
      selectedComponent?.component?.trim() || selectedRoute?.componentName || undefined;
    const sourceFile = selectedComponent?.source?.file?.trim() || undefined;
    const targetLine =
      selectedComponent?.targetStartLine ?? selectedComponent?.source?.line;

    return {
      prompt: prompt.trim() || undefined,
      language: /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(prompt)
        ? "vi"
        : "en",
      pageContext: {
        reactUrl: selectedCapturePageUrl || selectedPageUrl,
        reactRoute: selectedRoute?.route || "/",
        iframeSrc: frameSrc,
        pageTitle: frameTitle || selectedRoute?.label,
        viewport: selectedComponent?.viewport,
        document: selectedComponent?.document,
      },
      attachments: attachment ? [attachment] : [],
      targetHint: {
        route: selectedRoute?.route || "/",
        componentName,
        sourceFile,
        outputFilePath: sourceFile,
        startLine: targetLine,
        endLine: targetLine,
        targetNodeRole: selectedComponent?.targetNodeRole,
        targetElementTag: selectedComponent?.targetElementTag,
        targetTextPreview: selectedComponent?.targetTextPreview,
        targetStartLine: selectedComponent?.targetStartLine,
      },
      constraints: {
        preserveOutsideSelection: !!attachment,
        preserveDataContract: true,
        rerunFromScratch: false,
      },
      reactSourceTarget: {
        previewDir: statusData?.result?.previewDir,
        frontendDir: statusData?.result?.frontendDir,
        previewUrl,
        apiBaseUrl,
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
        {
          id: `empty-${Date.now()}`,
          role: "assistant",
          text: "Hãy mô tả một chỉnh sửa cục bộ rõ ràng, ví dụ đổi spacing, màu nền, màu chữ, hoặc nội dung trong vùng đã chọn.",
          tone: "error",
        },
      ]);
      return;
    }
    if (!selectedComponent?.viewportRect || !selectedComponent?.viewport) {
      setMessages((prev) => [
        ...prev,
        {
          id: `missing-target-${Date.now()}`,
          role: "assistant",
          text: "Bật Inspector và click đúng element cần sửa trước khi gửi visual edit.",
          tone: "error",
        },
      ]);
      return;
    }

    if (!isMeaningfulVisualEditPrompt(prompt)) {
      setMessages((prev) => [
        ...prev,
        {
          id: `vague-${Date.now()}`,
          role: "assistant",
          text: "Yêu cầu còn quá mơ hồ. Hãy nói rõ thay đổi cục bộ cần làm trên element đã chọn.",
          tone: "error",
        },
      ]);
      return;
    }

    if (isBroadVisualEditRequest(prompt)) {
      setMessages((prev) => [
        ...prev,
        {
          id: `broad-${Date.now()}`,
          role: "assistant",
          text: "Luồng này chỉ sửa cục bộ trên app React đã generate. Nếu muốn migrate lại toàn site hoặc sửa rộng nhiều page, hãy dùng pipeline chính.",
          tone: "error",
        },
      ]);
      return;
    }

    const unsupportedReason = detectUnsupportedVisualEditReason(prompt);
    if (unsupportedReason) {
      setMessages((prev) => [
        ...prev,
        {
          id: `unsupported-${Date.now()}`,
          role: "assistant",
          text: getUnsupportedVisualEditMessage(unsupportedReason),
          tone: "error",
        },
      ]);
      return;
    }

    setIsSubmittingRequest(true);
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", text: prompt.trim() },
    ]);

    try {
      const payload = await buildPayload();
      const res: ReactVisualEditResult = await submitReactVisualEdit(siteId, jobId, payload);
      if (!res.accepted) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            text: res.error || "Backend từ chối xử lý yêu cầu.",
            tone: "error",
          },
        ]);
      } else {
        const componentName = res.result?.componentName;
        setMessages((prev) => [
          ...prev,
          {
            id: `success-${Date.now()}`,
            role: "assistant",
            text: componentName
              ? `Đã cập nhật component "${componentName}" thành công.`
              : "Chỉnh sửa đã được áp dụng thành công.",
            tone: "success",
          },
        ]);
        if (res.result?.warnings?.length) {
          setMessages((prev) => [
            ...prev,
            {
              id: `warning-${Date.now()}`,
              role: "assistant",
              text: res.result?.warnings[0] ?? "",
            },
          ]);
        }
        setCanUndo(true);
        setPrompt("");
        setTimeout(() => {
          iframeRef.current?.contentWindow?.location.reload();
        }, 400);
      }
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

  const handleUndo = async () => {
    if (!jobId || !siteId || isUndoing) return;
    setIsUndoing(true);
    try {
      const res = await undoReactVisualEdit(siteId, jobId);
      if (res.undone) {
        setCanUndo(false);
        setMessages((prev) => [
          ...prev,
          { id: `undo-${Date.now()}`, role: "assistant", text: "Đã hoàn tác chỉnh sửa trước đó.", tone: "default" },
        ]);
        setTimeout(() => {
          iframeRef.current?.contentWindow?.location.reload();
        }, 400);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: `undo-err-${Date.now()}`, role: "assistant", text: res.error || "Không có gì để hoàn tác.", tone: "error" },
        ]);
      }
    } catch (err) {
      const message = err instanceof AiProcessError ? err.message : err instanceof Error ? err.message : "Hoàn tác thất bại.";
      setMessages((prev) => [
        ...prev,
        { id: `undo-err-${Date.now()}`, role: "assistant", text: message, tone: "error" },
      ]);
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <>
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
                {/* Publish button — ẩn nếu đã deploy hoặc vừa publish thành công */}
                {!state.deployedUrl && (
                  publishState.frontendUrl ? (
                    <a
                      href={publishState.frontendUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
                    >
                      <span className="material-symbols-outlined text-[15px]">language</span>
                      Visit Site
                    </a>
                  ) : (
                    <div className="flex flex-col items-end gap-0.5">
                      <button
                        onClick={() => setPublishModal({ open: true, subdomain: '', checking: false, checkError: null })}
                        disabled={publishState.loading}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#d8cfbf] bg-white px-4 py-1.5 text-sm font-semibold text-[#30483d] transition hover:bg-[#f6f2eb] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="material-symbols-outlined text-[15px]">language</span>
                        {publishState.loading ? "Đang publish…" : "Publish"}
                      </button>
                      {publishState.error && (
                        <p className="text-[10px] text-red-500">{publishState.error}</p>
                      )}
                    </div>
                  )
                )}
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
                    syncWithIframe();
                  }}
                />
                {frameLoading && !isSubmittingRequest && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold text-[#4f5d54] backdrop-blur-sm">
                    Đang tải route...
                  </div>
                )}
                {isSubmittingRequest && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a2a22]/60 backdrop-blur-sm">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
                    <p className="text-sm font-semibold text-white drop-shadow">AI đang chỉnh sửa{selectedComponent?.component ? ` "${selectedComponent.component}"` : ""}…</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right sidebar: Inspector + Annotation */}
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf5] shadow-sm">

            {/* Header */}
            <div className="flex-none border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Inspector</p>
              <p className="mt-1 text-sm text-[#617067]">
                {inspectorActive
                  ? "Click vào đúng element cần sửa để lấy target metadata."
                  : "Bật Inspector rồi click vào element trong preview React."}
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

                  {/* Target metadata */}
                  {(selectedComponent.targetNodeRole || selectedComponent.documentRect || selectedComponent.normalizedRect) && (
                    <div className="px-4 py-3 border-t border-[#f0ebe3]">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b826f] mb-1.5">Target</p>
                      {selectedComponent.targetNodeRole && (
                        <p className="text-[11px] text-[#374151]">
                          role: <span className="font-semibold">{selectedComponent.targetNodeRole}</span>
                          {selectedComponent.targetElementTag && (
                            <span className="ml-1.5 text-[#9ca3af]">· {selectedComponent.targetElementTag}</span>
                          )}
                        </p>
                      )}
                      {selectedComponent.documentRect && (
                        <p className="mt-0.5 font-mono text-[11px] text-[#6b7280]">
                          doc rect: {Math.round(selectedComponent.documentRect.x)},{Math.round(selectedComponent.documentRect.y)} · {Math.round(selectedComponent.documentRect.width)}×{Math.round(selectedComponent.documentRect.height)}
                        </p>
                      )}
                      {selectedComponent.normalizedRect && (
                        <p className="mt-0.5 font-mono text-[11px] text-[#9ca3af]">
                          normalized: {roundMetric(selectedComponent.normalizedRect.x, 3)}, {roundMetric(selectedComponent.normalizedRect.y, 3)}, {roundMetric(selectedComponent.normalizedRect.width, 3)}, {roundMetric(selectedComponent.normalizedRect.height, 3)}
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
                placeholder="Ví dụ: Giảm padding của card này, đổi nền section sang be nhạt, hoặc sửa heading trong vùng đã chọn..."
                className="h-20 w-full resize-none rounded-[14px] border border-[#e7dfd2] bg-[#fcfaf6] px-3 py-2.5 text-sm text-[#243129] outline-none transition focus:border-[#3a6b57] focus:bg-white"
              />
              <p className="mt-2 text-[11px] text-[#8b826f]">
                Chỉ dùng ô này cho chỉnh sửa cục bộ trên element đã chọn: content, background, color, hoặc layout.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void handleSubmitRequest()}
                  disabled={isSubmittingRequest || isUndoing}
                  className="flex-1 rounded-full bg-[#8b5c32] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#744a26] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmittingRequest ? "Đang xử lý…" : "Gửi cho AI"}
                </button>
                {canUndo && (
                  <button
                    onClick={() => void handleUndo()}
                    disabled={isUndoing || isSubmittingRequest}
                    className="rounded-full border border-[#d8cfbf] bg-white px-4 py-2 text-xs font-semibold text-[#5c4033] transition hover:bg-[#f6f2eb] disabled:cursor-not-allowed disabled:opacity-50"
                    title="Hoàn tác chỉnh sửa vừa rồi"
                  >
                    {isUndoing ? "…" : "↩ Hoàn tác"}
                  </button>
                )}
              </div>
            </div>
          </aside>

        </section>
      </div>
    </div>

    {/* Publish modal */}
    {publishModal.open && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) setPublishModal(s => ({ ...s, open: false })); }}
      >
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <h2 className="text-base font-bold text-[#1a2e22]">Đặt tên subdomain</h2>
          <p className="mt-1 text-sm text-[#6b7280]">
            Subdomain sẽ là địa chỉ truy cập website sau khi publish.
          </p>
          <div className="mt-4">
            <label className="text-xs font-semibold uppercase tracking-wide text-[#8a7a62]">Subdomain</label>
            <div className="mt-1.5 flex items-center gap-0 rounded-xl border border-[#e0d8cc] bg-[#f9f7f4] focus-within:border-[#6366f1] focus-within:ring-1 focus-within:ring-[#6366f1]">
              <input
                type="text"
                value={publishModal.subdomain}
                onChange={(e) => setPublishModal(s => ({ ...s, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), checkError: null }))}
                onKeyDown={(e) => { if (e.key === 'Enter') void handlePublishModalConfirm(); }}
                placeholder="ten-website-cua-ban"
                className="flex-1 bg-transparent px-3 py-2.5 text-sm text-[#1a2e22] outline-none placeholder:text-[#b4ada4]"
                autoFocus
              />
              <span className="pr-3 text-sm text-[#9ca3af]">.xpress.aihubproduction.com</span>
            </div>
            {publishModal.checkError && (
              <p className="mt-1.5 text-xs text-red-500">{publishModal.checkError}</p>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setPublishModal(s => ({ ...s, open: false }))}
              className="rounded-xl border border-[#e0d8cc] px-4 py-2 text-sm font-semibold text-[#6b7280] hover:bg-[#f6f2eb]"
            >
              Huỷ
            </button>
            <button
              onClick={() => void handlePublishModalConfirm()}
              disabled={publishModal.checking || !publishModal.subdomain.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#30483d] px-4 py-2 text-sm font-semibold text-white hover:bg-[#243129] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publishModal.checking ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-[15px]">progress_activity</span>
                  Đang kiểm tra…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[15px]">language</span>
                  Publish
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default VisualEditor;
