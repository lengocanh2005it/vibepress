import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AiProcessError,
  submitReactVisualEdit,
  type ReactVisualEditPayload,
  type ReactVisualEditRouteEntry,
} from "../services/AiService";
import { captureRegion } from "../services/automationService";
import type {
  Capture,
  CaptureDomTarget,
  CaptureGeometry,
  CaptureNormalizedRect,
  CaptureTargetNode,
  CaptureViewport,
  DocumentCaptureRect,
  ViewportCaptureRect,
} from "../types/capture";

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

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant";
  text: string;
  attachments?: Capture[];
  tone?: "default" | "success" | "error";
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const round = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

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

const selectionRect = (selection: SelectionRect) => ({
  x: Math.min(selection.startX, selection.endX),
  y: Math.min(selection.startY, selection.endY),
  width: Math.abs(selection.endX - selection.startX),
  height: Math.abs(selection.endY - selection.startY),
});

const getCaptureDisplayUrl = (capture: Capture) =>
  capture.asset?.url || `${import.meta.env.VITE_BACKEND_URL}${capture.filePath}`;

const normalizeMimeType = (
  value?: string,
): "image/png" | "image/jpeg" | "image/webp" | undefined => {
  if (value === "image/png" || value === "image/jpeg" || value === "image/webp") {
    return value;
  }
  return undefined;
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

const getDocDimensions = (frameDocument: Document) => {
  const body = frameDocument.body;
  const root = frameDocument.documentElement;
  return {
    width: Math.max(
      body?.scrollWidth ?? 0,
      body?.offsetWidth ?? 0,
      root?.scrollWidth ?? 0,
      root?.offsetWidth ?? 0,
      root?.clientWidth ?? 0,
    ),
    height: Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      root?.scrollHeight ?? 0,
      root?.offsetHeight ?? 0,
      root?.clientHeight ?? 0,
    ),
  };
};

const buildDomSnapshot = (frameDocument: Document, viewportRect: ViewportCaptureRect, fallbackRoute: string) => {
  const centerX = viewportRect.x + viewportRect.width / 2;
  const centerY = viewportRect.y + viewportRect.height / 2;
  const element = frameDocument.elementFromPoint(centerX, centerY);
  if (!element) {
    return {} as { domTarget?: CaptureDomTarget; targetNode?: CaptureTargetNode };
  }

  const htmlElement = element as HTMLElement;
  const owner = (element.closest("[data-vp-source-node]") || element) as HTMLElement;
  const block = (
    element.closest("[data-block], [data-type], [data-block-name], [class*='wp-block-']") ||
    element
  ) as HTMLElement;
  const role =
    htmlElement.dataset.vpNodeRole ||
    element.getAttribute("role") ||
    (element.tagName.toLowerCase() === "button" ? "button" : undefined) ||
    (element.tagName.toLowerCase() === "a" ? "link" : undefined) ||
    "container";

  const domTarget: CaptureDomTarget = {
    cssSelector: element.tagName.toLowerCase(),
    tagName: element.tagName.toLowerCase(),
    elementId: element.getAttribute("id") || undefined,
    classNames: Array.from(element.classList).filter(Boolean),
    htmlSnippet: element.outerHTML.replace(/\s+/g, " ").slice(0, 240),
    textSnippet: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) || undefined,
    blockName: block.dataset.type || block.dataset.blockName || undefined,
    blockClientId: block.dataset.block || block.dataset.id || undefined,
    domPath: element.tagName.toLowerCase(),
    role,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    nearestHeading:
      (element.closest("section, article, main, header, footer")?.querySelector("h1, h2, h3, h4, h5, h6")
        ?.textContent
        ?.trim()
        .slice(0, 120)) ||
      undefined,
    nearestLandmark:
      element.closest("header, nav, main, section, article, aside, footer, form")?.tagName.toLowerCase() ||
      undefined,
  };

  const targetNode: CaptureTargetNode = {
    nodeId: htmlElement.dataset.vpNodeId,
    templateName:
      htmlElement.dataset.vpTemplate ||
      owner.dataset.vpTemplate ||
      frameDocument.documentElement.dataset.vpTemplate ||
      undefined,
    route:
      htmlElement.dataset.vpRoute || frameDocument.documentElement.dataset.vpRoute || fallbackRoute,
    blockName: domTarget.blockName,
    blockClientId: domTarget.blockClientId,
    tagName: element.tagName.toLowerCase(),
    domPath: domTarget.domPath,
    nearestHeading: domTarget.nearestHeading,
    nearestLandmark: domTarget.nearestLandmark,
  };

  return { domTarget, targetNode };
};

const buildAttachmentPayload = (capture: Capture) => ({
  id: capture.id,
  note: capture.comment,
  sourcePageUrl: capture.pageUrl,
  captureContext: {
    capturedAt: capture.capturedAt,
    iframeSrc: capture.iframeSrc,
    viewport: capture.viewport,
    page: {
      url: capture.pageUrl,
      route: capture.page.route,
      title: capture.page.title,
    },
    document: {
      width: capture.page.documentWidth,
      height: capture.page.documentHeight,
    },
  },
  selection: capture.selection,
  geometry: capture.geometry,
  ...(capture.domTarget ? { domTarget: capture.domTarget } : {}),
  ...(capture.targetNode ? { targetNode: capture.targetNode } : {}),
  asset: {
    provider: capture.asset?.provider || "local",
    fileName:
      capture.asset?.fileName ||
      capture.fileName ||
      capture.filePath.split("/").pop() ||
      `${capture.id}.png`,
    publicUrl: getCaptureDisplayUrl(capture),
    mimeType: normalizeMimeType(capture.asset?.mimeType),
    width: capture.asset?.width,
    height: capture.asset?.height,
  },
});

const VisualEditor: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;
  const jobId = state.jobId || "";
  const siteId = state.siteId || "";

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const [statusData, setStatusData] = useState<PipelineStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [frameTitle, setFrameTitle] = useState("");
  const [frameLoading, setFrameLoading] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [dragSelection, setDragSelection] = useState<SelectionRect | null>(null);
  const [savedSelection, setSavedSelection] = useState<SelectionRect | null>(null);
  const [captureNote, setCaptureNote] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [prompt, setPrompt] = useState("");
  const [isSubmittingCapture, setIsSubmittingCapture] = useState(false);
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false);
  const [lastSubmitLogPath, setLastSubmitLogPath] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "system",
      text:
        "Ban dang sua tren React preview. Chon route, tao capture va gui DTO sang endpoint moi `/pipeline/react-visual-edit`.",
    },
  ]);

  const previewUrl = statusData?.result?.previewUrl || state.previewUrl || "";
  const apiBaseUrl = statusData?.result?.apiBaseUrl || state.apiBaseUrl || "";

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/ai-api/pipeline/status/${jobId}`);
        if (!response.ok) {
          throw new Error(`Khong the tai pipeline status (${response.status})`);
        }
        const data = (await response.json()) as PipelineStatusResponse;
        if (!cancelled) {
          setStatusData(data);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(
            fetchError instanceof Error ? fetchError.message : "Khong the tai du lieu Visual Edit.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const routes = useMemo(
    () =>
      buildRouteItems(
        previewUrl,
        statusData?.result?.metrics?.pages,
        statusData?.result?.routeEntries,
      ),
    [previewUrl, statusData?.result?.metrics?.pages, statusData?.result?.routeEntries],
  );

  useEffect(() => {
    if (!routes.length) return;
    if (routes.some((route) => route.id === selectedRouteId)) return;
    setSelectedRouteId(routes[0].id);
  }, [routes, selectedRouteId]);

  const selectedRoute = routes.find((route) => route.id === selectedRouteId) || routes[0] || null;
  const selectedPageUrl = selectedRoute?.pageUrl || previewUrl;
  const frameSrc = buildProxyUrl(selectedPageUrl, siteId);
  const activeSelection = dragSelection || savedSelection;
  const activeSelectionRect = activeSelection ? selectionRect(activeSelection) : null;

  useEffect(() => {
    setFrameLoading(true);
    setDragSelection(null);
    setSavedSelection(null);
    setCaptureNote("");
    setIsCapturing(false);
  }, [frameSrc]);

  const refreshFrameMeta = () => {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    setFrameTitle(frameDocument.title || selectedRoute?.label || "React Preview");
  };

  const getFrameSnapshot = () => {
    const iframe = iframeRef.current;
    const overlay = overlayRef.current;
    const frameWindow = iframe?.contentWindow;
    const frameDocument = iframe?.contentDocument;
    if (!iframe || !overlay || !frameWindow || !frameDocument) {
      throw new Error("Preview chua san sang de capture.");
    }

    const viewport: CaptureViewport = {
      width: Math.max(1, Math.round(frameWindow.innerWidth || frameDocument.documentElement.clientWidth || 1280)),
      height: Math.max(1, Math.round(frameWindow.innerHeight || frameDocument.documentElement.clientHeight || 720)),
      scrollX: Math.max(0, Math.round(frameWindow.scrollX || 0)),
      scrollY: Math.max(0, Math.round(frameWindow.scrollY || 0)),
      dpr: Math.max(1, Number(frameWindow.devicePixelRatio) || 1),
    };
    const documentSize = getDocDimensions(frameDocument);

    return {
      viewport,
      page: {
        route:
          frameDocument.documentElement.dataset.vpRoute ||
          selectedRoute?.route ||
          normalizeRoute(selectedPageUrl),
        title: frameDocument.title || selectedRoute?.label,
        documentWidth: documentSize.width,
        documentHeight: documentSize.height,
      },
      frameDocument,
      overlayWidth: overlay.clientWidth,
      overlayHeight: overlay.clientHeight,
    };
  };

  const buildCaptureSnapshot = (selection: SelectionRect) => {
    const overlayBox = selectionRect(selection);
    const snapshot = getFrameSnapshot();
    const scaleX = snapshot.viewport.width / Math.max(1, snapshot.overlayWidth);
    const scaleY = snapshot.viewport.height / Math.max(1, snapshot.overlayHeight);

    const viewportRect: ViewportCaptureRect = {
      x: clamp(round(overlayBox.x * scaleX), 0, snapshot.viewport.width - 1),
      y: clamp(round(overlayBox.y * scaleY), 0, snapshot.viewport.height - 1),
      width: clamp(round(overlayBox.width * scaleX), 1, snapshot.viewport.width),
      height: clamp(round(overlayBox.height * scaleY), 1, snapshot.viewport.height),
      coordinateSpace: "iframe-viewport",
    };

    const documentRect: DocumentCaptureRect = {
      x: round(viewportRect.x + snapshot.viewport.scrollX),
      y: round(viewportRect.y + snapshot.viewport.scrollY),
      width: viewportRect.width,
      height: viewportRect.height,
      coordinateSpace: "iframe-document",
    };

    const normalizedRect: CaptureNormalizedRect = {
      x: round(clamp(documentRect.x / Math.max(1, snapshot.page.documentWidth), 0, 1)),
      y: round(clamp(documentRect.y / Math.max(1, snapshot.page.documentHeight), 0, 1)),
      width: round(clamp(documentRect.width / Math.max(1, snapshot.page.documentWidth), 0, 1)),
      height: round(clamp(documentRect.height / Math.max(1, snapshot.page.documentHeight), 0, 1)),
      coordinateSpace: "iframe-document-normalized",
    };

    return {
      viewport: snapshot.viewport,
      page: snapshot.page,
      selection: documentRect,
      geometry: {
        viewportRect,
        documentRect,
        normalizedRect,
      } satisfies CaptureGeometry,
      ...buildDomSnapshot(
        snapshot.frameDocument,
        viewportRect,
        snapshot.page.route || selectedRoute?.route || "/",
      ),
    };
  };

  const resetCaptureDraft = () => {
    setDragSelection(null);
    setSavedSelection(null);
    setCaptureNote("");
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isCapturing) return;
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    setDragSelection({ startX: x, startY: y, endX: x, endY: y });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!dragSelection) return;
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = clamp(event.clientX - bounds.left, 0, bounds.width);
    const y = clamp(event.clientY - bounds.top, 0, bounds.height);
    setDragSelection((previous) => (previous ? { ...previous, endX: x, endY: y } : previous));
  };

  const handleMouseUp = () => {
    if (!dragSelection) return;
    const rect = selectionRect(dragSelection);
    if (rect.width < 14 || rect.height < 14) {
      setDragSelection(null);
      return;
    }
    setSavedSelection(dragSelection);
    setDragSelection(null);
  };

  const handleSaveCapture = async () => {
    if (!savedSelection || !captureNote.trim()) return;
    setIsSubmittingCapture(true);
    try {
      const snapshot = buildCaptureSnapshot(savedSelection);
      const result = await captureRegion(
        selectedPageUrl,
        frameSrc,
        {
          x: snapshot.geometry.viewportRect.x,
          y: snapshot.geometry.viewportRect.y,
          width: snapshot.geometry.viewportRect.width,
          height: snapshot.geometry.viewportRect.height,
        },
        captureNote.trim(),
        snapshot.viewport,
      );

      const capture: Capture = {
        id: `react-capture-${Date.now()}`,
        filePath: result.filePath,
        fileName: result.fileName,
        asset: result.asset,
        comment: captureNote.trim(),
        pageUrl: selectedPageUrl,
        iframeSrc: frameSrc,
        capturedAt: new Date().toISOString(),
        viewport: snapshot.viewport,
        page: snapshot.page,
        selection: snapshot.selection,
        geometry: snapshot.geometry,
        domTarget: snapshot.domTarget,
        targetNode: snapshot.targetNode,
      };

      setCaptures((previous) => [capture, ...previous]);
      setMessages((previous) => [
        ...previous,
        {
          id: `capture-${capture.id}`,
          role: "assistant",
          text: `Da them 1 capture cho route ${selectedRoute?.route || "/"}.`,
          attachments: [capture],
          tone: "success",
        },
      ]);
      resetCaptureDraft();
      setIsCapturing(false);
    } catch (captureError) {
      setMessages((previous) => [
        ...previous,
        {
          id: `capture-error-${Date.now()}`,
          role: "assistant",
          text:
            captureError instanceof Error
              ? captureError.message
              : "Khong the tao capture tren preview nay.",
          tone: "error",
        },
      ]);
    } finally {
      setIsSubmittingCapture(false);
    }
  };

  const buildPayload = (): ReactVisualEditPayload => {
    const pageSnapshot = (() => {
      try {
        return getFrameSnapshot();
      } catch {
        return null;
      }
    })();
    const firstCapture = captures[0];

    return {
      prompt: prompt.trim() || undefined,
      language: /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
        `${prompt} ${captures.map((capture) => capture.comment).join(" ")}`,
      )
        ? "vi"
        : "en",
      pageContext: {
        reactUrl: selectedPageUrl,
        reactRoute: selectedRoute?.route || "/",
        iframeSrc: frameSrc,
        pageTitle: pageSnapshot?.page.title || frameTitle || selectedRoute?.label,
        viewport: pageSnapshot?.viewport,
        document: pageSnapshot
          ? {
              width: pageSnapshot.page.documentWidth,
              height: pageSnapshot.page.documentHeight,
            }
          : undefined,
      },
      attachments: captures.map(buildAttachmentPayload),
      targetHint: {
        componentName: selectedRoute?.componentName,
        route: firstCapture?.targetNode?.route || selectedRoute?.route || "/",
        templateName: firstCapture?.targetNode?.templateName,
        sectionIndex:
          typeof firstCapture?.geometry?.normalizedRect?.y === "number"
            ? Math.max(0, Math.min(9, Math.floor(firstCapture.geometry.normalizedRect.y * 10)))
            : undefined,
        sectionType: firstCapture?.domTarget?.role,
      },
      constraints: {
        preserveOutsideSelection: captures.length > 0,
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

  const handleSubmitRequest = async () => {
    if (!jobId || !siteId) return;
    if (!prompt.trim() && captures.length === 0) {
      setMessages((previous) => [
        ...previous,
        {
          id: `empty-${Date.now()}`,
          role: "assistant",
          text: "Hay nhap prompt hoac them it nhat 1 capture truoc khi gui.",
          tone: "error",
        },
      ]);
      return;
    }

    setIsSubmittingRequest(true);
    setMessages((previous) => [
      ...previous,
      {
        id: `user-${Date.now()}`,
        role: "user",
        text: prompt.trim() || `Gui ${captures.length} capture cho route ${selectedRoute?.route || "/"}.`,
        attachments: captures,
      },
    ]);

    try {
      const response = await submitReactVisualEdit(siteId, jobId, buildPayload());
      setLastSubmitLogPath(response.logPath || null);
      setMessages((previous) => [
        ...previous,
        {
          id: `success-${Date.now()}`,
          role: "assistant",
          text:
            "DTO da duoc gui sang `/pipeline/react-visual-edit`. Backend hien chi log request de chuan bi cho buoc sua source code.",
          tone: "success",
        },
      ]);
      setPrompt("");
      setCaptures([]);
    } catch (submitError) {
      const message =
        submitError instanceof AiProcessError
          ? submitError.message
          : submitError instanceof Error
            ? submitError.message
            : "Gui request that bai.";
      setMessages((previous) => [
        ...previous,
        {
          id: `submit-error-${Date.now()}`,
          role: "assistant",
          text: message,
          tone: "error",
        },
      ]);
    } finally {
      setIsSubmittingRequest(false);
    }
  };

  if (!jobId || !siteId) {
    return (
      <div className="flex h-[calc(100vh-96px)] items-center justify-center px-6">
        <div className="max-w-lg rounded-[28px] border border-[#ddd5c8] bg-[#fbf7f1] p-8 text-center shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#8b826f]">
            Visual Edit
          </p>
          <h1 className="mt-3 text-2xl font-semibold text-[#1f2a24]">
            Chua co context tu AI Generate
          </h1>
          <p className="mt-3 text-sm leading-7 text-[#667062]">
            Hay quay lai buoc AI Generate, doi pipeline chay xong, roi bam nut Open Visual Edit.
          </p>
          <button
            onClick={() => navigate("/app/editor/split-view")}
            className="mt-6 inline-flex items-center rounded-full bg-[#315f4e] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#274f40]"
          >
            Quay lai AI Generate
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-96px)] overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(244,228,200,0.55),_transparent_34%),linear-gradient(135deg,_#f7f1e7_0%,_#f2ece2_42%,_#ece7df_100%)] px-4 pb-4">
      <div className="flex h-full flex-col gap-4">
        <section className="rounded-[28px] border border-[#ddd2c4] bg-white/80 px-6 py-4 shadow-[0_22px_80px_rgba(55,39,20,0.09)] backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#907d61]">Step 5 · Visual Edit</p>
              <h1 className="mt-1 text-2xl font-semibold text-[#1f2a24]">Sua React preview bang capture va chat</h1>
              <p className="mt-1 text-sm text-[#657064]">
                Endpoint hien tai: <span className="font-semibold text-[#355c4a]">POST /pipeline/react-visual-edit</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => navigate("/app/editor/split-view", { state: { jobId, siteId } })}
                className="rounded-full border border-[#d9d0c4] bg-white px-4 py-2 text-sm font-semibold text-[#31473d] transition hover:bg-[#f7f3ec]"
              >
                Ve AI Generate
              </button>
              {previewUrl && (
                <button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className="rounded-full bg-[#336b59] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#285948]"
                >
                  Mo Frontend
                </button>
              )}
              {apiBaseUrl && (
                <button
                  onClick={() => window.open(apiBaseUrl, "_blank")}
                  className="rounded-full bg-[#8f5a2d] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#794b24]"
                >
                  Mo Backend
                </button>
              )}
            </div>
          </div>
          {lastSubmitLogPath && (
            <div className="mt-4 rounded-2xl border border-[#c9decf] bg-[#eef7f1] px-4 py-3 text-sm text-[#2e5744]">
              Da log request tai: <span className="font-semibold">{lastSubmitLogPath}</span>
            </div>
          )}
        </section>

        <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_360px] gap-4">
          <aside className="min-h-0 overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf3] shadow-sm">
            <div className="border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">React Routes</p>
              <p className="mt-1 text-sm text-[#617067]">Chon page, post hoac route trong preview React.</p>
            </div>
            <div className="max-h-[50%] overflow-y-auto px-3 py-3">
              {loading ? (
                <div className="rounded-2xl border border-dashed border-[#dccfbc] bg-white px-4 py-5 text-sm text-[#677164]">Dang tai context...</div>
              ) : error ? (
                <div className="rounded-2xl border border-[#e7c8c1] bg-[#fff2ef] px-4 py-5 text-sm text-[#9c4b3d]">{error}</div>
              ) : (
                <div className="space-y-2">
                  {routes.map((route) => (
                    <button
                      key={route.id}
                      onClick={() => setSelectedRouteId(route.id)}
                      className={`w-full rounded-[22px] border px-4 py-3 text-left transition ${
                        route.id === selectedRouteId ? "border-[#3f6b58] bg-[#eef6f1] shadow-sm" : "border-[#e7dfd3] bg-white hover:bg-[#faf6ef]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-[#213129]">{route.label}</p>
                        <span className="rounded-full bg-[#efe7d8] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#7f6846]">{route.typeLabel}</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-[#6e746b]">{route.route}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="border-y border-[#ede4d8] px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Captures</p>
                  <p className="mt-1 text-sm text-[#617067]">Capture nao duoc gui thi se vao DTO.</p>
                </div>
                <span className="rounded-full bg-[#e8efe9] px-3 py-1 text-xs font-semibold text-[#35614f]">{captures.length}</span>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto px-3 py-3">
              {captures.length > 0 ? (
                <div className="space-y-3">
                  {captures.map((capture) => (
                    <div key={capture.id} className="overflow-hidden rounded-[22px] border border-[#e7dfd3] bg-white">
                      <img src={getCaptureDisplayUrl(capture)} alt="capture" className="h-32 w-full bg-[#f5f0e6] object-contain" />
                      <div className="space-y-2 px-4 py-3">
                        <p className="text-xs font-semibold text-[#1f2a24]">{capture.comment}</p>
                        <p className="text-[11px] text-[#6a7269]">{capture.page.route || "/"}</p>
                        <button
                          onClick={() => setCaptures((previous) => previous.filter((item) => item.id !== capture.id))}
                          className="text-[11px] font-semibold text-[#a34e3f] transition hover:text-[#8f3c2c]"
                        >
                          Xoa capture
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-[22px] border border-dashed border-[#d8d0c4] bg-white px-4 py-6 text-center text-sm text-[#6a7269]">
                  Chua co capture nao. Bam <span className="font-semibold text-[#3d6653]">Bat dau capture</span> de chon vung tren preview.
                </div>
              )}
            </div>
          </aside>

          <div className="min-h-0 overflow-hidden rounded-[30px] border border-[#ddd2c4] bg-[#f9f6ef] shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ece2d6] px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">Preview Canvas</p>
                <p className="mt-1 text-sm font-semibold text-[#1f2a24]">{selectedRoute?.label || "React Preview"}</p>
                <p className="mt-1 text-xs text-[#687067]">{selectedRoute?.route || "/"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    setIsCapturing((previous) => !previous);
                    resetCaptureDraft();
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                    isCapturing ? "bg-[#a34939] text-white hover:bg-[#8f3d2d]" : "bg-[#315f4e] text-white hover:bg-[#274f40]"
                  }`}
                >
                  {isCapturing ? "Huy capture" : "Bat dau capture"}
                </button>
                <button
                  onClick={() => {
                    setFrameLoading(true);
                    iframeRef.current?.contentWindow?.location.reload();
                  }}
                  className="rounded-full border border-[#d8cfbf] bg-white px-4 py-2 text-sm font-semibold text-[#30483d] transition hover:bg-[#f6f2eb]"
                >
                  Tai lai preview
                </button>
              </div>
            </div>
            <div className="relative h-[calc(100%-82px)] p-5">
              <div className="relative h-full overflow-hidden rounded-[26px] border border-[#d9d0c4] bg-white shadow-inner">
                <iframe ref={iframeRef} src={frameSrc} title="React Visual Preview" className="h-full w-full bg-white" onLoad={() => {
                  refreshFrameMeta();
                  setFrameLoading(false);
                }} />
                <div
                  ref={overlayRef}
                  className={`absolute inset-0 ${isCapturing ? "cursor-crosshair" : "pointer-events-none"}`}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  {frameLoading && <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-semibold text-[#4f5d54] backdrop-blur-sm">Dang tai route...</div>}
                  {activeSelectionRect && (
                    <div
                      className="absolute border-2 border-[#315f4e] bg-[#5f9b82]/15 shadow-[0_0_0_9999px_rgba(23,27,24,0.18)]"
                      style={{ left: activeSelectionRect.x, top: activeSelectionRect.y, width: activeSelectionRect.width, height: activeSelectionRect.height }}
                    />
                  )}
                </div>
                <div className="pointer-events-none absolute left-5 top-5 rounded-2xl border border-white/70 bg-white/92 px-4 py-3 shadow-lg backdrop-blur">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a7a62]">Trang dang sua</p>
                  <p className="mt-1 text-sm font-semibold text-[#1f2a24]">{frameTitle || selectedRoute?.label || "React Preview"}</p>
                  <p className="mt-1 text-xs text-[#6c7267]">{selectedPageUrl || "Dang khoi tao..."}</p>
                </div>
              </div>
            </div>
          </div>

          <aside className="min-h-0 overflow-hidden rounded-[28px] border border-[#ddd2c4] bg-[#fffaf5] shadow-sm">
            <div className="border-b border-[#ede4d8] px-5 py-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8b826f]">AI Visual Edit</p>
              <p className="mt-1 text-sm text-[#617067]">Prompt tong quat la tuy chon. Capture notes moi la context chinh.</p>
            </div>
            <div className="h-[calc(100%-204px)] overflow-y-auto px-4 py-4">
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
                    {message.attachments && message.attachments.length > 0 && (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {message.attachments.map((capture) => (
                          <div key={capture.id} className={`overflow-hidden rounded-2xl ${message.role === "user" ? "border border-white/25 bg-white/10" : "border border-[#ebe2d6] bg-[#faf6ef]"}`}>
                            <img src={getCaptureDisplayUrl(capture)} alt="capture" className="h-24 w-full object-contain" />
                            <div className="px-3 py-2 text-[11px] leading-5">{capture.comment}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-[#ede4d8] px-5 py-4">
              <div className="rounded-[24px] border border-[#e6dece] bg-white p-4">
                <label className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a7a62]">Yeu cau bo sung</label>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Vi du: giu nguyen bo cuc, chi doi style button va text trong khu vuc da capture..."
                  className="mt-3 h-32 w-full resize-none rounded-[18px] border border-[#e7dfd2] bg-[#fcfaf6] px-4 py-3 text-sm text-[#243129] outline-none transition focus:border-[#3a6b57] focus:bg-white"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="text-xs text-[#6c7267]">
                    {captures.length > 0 ? `Se gui ${captures.length} capture vao DTO.` : "Ban co the gui prompt khong, hoac prompt + captures."}
                  </div>
                  <button
                    onClick={() => void handleSubmitRequest()}
                    disabled={isSubmittingRequest}
                    className="rounded-full bg-[#8b5c32] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#744a26] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmittingRequest ? "Dang gui..." : "Gui cho AI"}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </div>

      {savedSelection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#20180f]/55 p-4 backdrop-blur-sm" onClick={() => {
          resetCaptureDraft();
          setIsCapturing(false);
        }}>
          <div className="w-full max-w-xl rounded-[28px] border border-[#e0d4c4] bg-[#fff9f2] p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#907d61]">Luu capture</p>
            <h2 className="mt-2 text-xl font-semibold text-[#1f2a24]">Mo ta thay doi can sua tren React preview</h2>
            <p className="mt-2 text-sm leading-7 text-[#687067]">Note nay se di cung screenshot vao DTO de backend sau nay map ve source code.</p>
            <textarea
              value={captureNote}
              onChange={(event) => setCaptureNote(event.target.value)}
              placeholder="Vi du: doi mau chu thanh vang, tang contrast button CTA va giu nguyen layout ben ngoai."
              className="mt-4 h-36 w-full resize-none rounded-[22px] border border-[#e2d9cc] bg-white px-4 py-4 text-sm text-[#243129] outline-none transition focus:border-[#3a6b57]"
              autoFocus
            />
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  resetCaptureDraft();
                  setIsCapturing(false);
                }}
                className="rounded-full border border-[#d9d0c4] bg-white px-4 py-2 text-sm font-semibold text-[#31473d] transition hover:bg-[#f5f1ea]"
              >
                Huy
              </button>
              <button
                onClick={() => void handleSaveCapture()}
                disabled={isSubmittingCapture || !captureNote.trim()}
                className="rounded-full bg-[#315f4e] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#274f40] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmittingCapture ? "Dang luu..." : "Them capture"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisualEditor;
