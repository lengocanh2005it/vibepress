import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { runAiProcess } from "../services/AiService";
import {
  captureRegion,
  getWpSitePages,
  type CaptureAssetResponse,
  type CaptureViewport,
} from "../services/automationService";

interface WpPage {
  id: number;
  title: string;
  slug: string;
  link: string;
  status: string;
}

interface Capture {
  id: string;
  filePath: string;
  fileName?: string;
  asset?: CaptureAssetResponse;
  comment: string;
  pageUrl: string;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface Annotation {
  id: number;
  targetId: string;
  author: string;
  time: string;
  content: string;
  initials: string;
  colorClasses: string;
}

const Editor: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const siteUrl: string = location.state?.siteUrl || "";
  const siteId: string = location.state?.siteId || "";

  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [sitePagesOpen, setSitePagesOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [wpPages, setWpPages] = useState<WpPage[]>([]);
  const [selectedPageUrl, setSelectedPageUrl] = useState<string>(siteUrl);

  // Capture states
  const [isCapturing, setIsCapturing] = useState(false);
  const [selection, setSelection] = useState<SelectionRect | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [captureComment, setCaptureComment] = useState("");
  const [showCommentPopup, setShowCommentPopup] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<string[]>([]);
  const [chatCaptures, setChatCaptures] = useState<Capture[]>([]);
  const [previewCapture, setPreviewCapture] = useState<Capture | null>(null);
  const [isSubmittingCapture, setIsSubmittingCapture] = useState(false);
  const [isSendingAiRequest, setIsSendingAiRequest] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [capturesOpen, setCapturesOpen] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [annotations, setAnnotations] = useState<Annotation[]>([
    {
      id: 1,
      targetId: "block-1",
      author: "John Doe",
      time: "10 minutes ago",
      content:
        "Make this header sticky so it follows the user down the page. Also increase the top padding slightly.",
      initials: "JD",
      colorClasses: "bg-[#d2dacb] text-[#49704F]",
    },
    {
      id: 2,
      targetId: "block-2",
      author: "Sarah Miller",
      time: "2 hours ago",
      content:
        "Adjust font-weight of the subheaders. They feel a bit too thin compared to the primary headline.",
      initials: "SM",
      colorClasses: "bg-[#e8d5a1]/40 text-[#7a5e18]",
    },
    {
      id: 3,
      targetId: "block-3",
      author: "Alex Kim",
      time: "Yesterday",
      content:
        "Should we add a newsletter signup widget here? It's a key conversion point for the client.",
      initials: "AK",
      colorClasses: "bg-[#f0eede] text-[#8e9892]",
    },
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === "ArrowRight") {
        navigate("/app/editor/split-view", { state: { siteId } });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, siteId]);

  useEffect(() => {
    if (!siteUrl) return;
    getWpSitePages(siteUrl)
      .then(setWpPages)
      .catch(() => setWpPages([]));
  }, [siteUrl]);

  const cancelCaptureFlow = () => {
    setIsCapturing(false);
    setSelection(null);
    setShowCommentPopup(false);
    setCaptureComment("");
    setIsDragging(false);
  };

  useEffect(() => {
    if (!isCapturing && !showCommentPopup) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelCaptureFlow();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isCapturing, showCommentPopup]);

  const getDefaultAiPrompt = () => {
    if (chatCaptures.length === 0) return "";
    return "Apply the requested changes from the attached captures. Preserve everything else unless a broader update is required.";
  };

  const getCaptureDisplayUrl = (capture: Capture) =>
    capture.asset?.url ||
    `${import.meta.env.VITE_BACKEND_URL}${capture.filePath}`;

  const getCaptureMimeType = (
    capture: Capture,
  ): "image/png" | "image/jpeg" | "image/webp" => {
    const mimeType = capture.asset?.mimeType;
    if (
      mimeType === "image/png" ||
      mimeType === "image/jpeg" ||
      mimeType === "image/webp"
    ) {
      return mimeType;
    }
    return "image/png";
  };

  const sendChatMessage = async () => {
    const trimmedPrompt = chatInput.trim();
    const userPrompt = trimmedPrompt || getDefaultAiPrompt();

    if (!siteId || (!userPrompt && chatCaptures.length === 0)) return;

    setIsSendingAiRequest(true);

    const requestBody = {
      prompt: userPrompt,
      language: "en",
      pageContext: {
        reactUrl: window.location.href,
        reactRoute: window.location.pathname,
        wordpressUrl: selectedPageUrl,
        iframeSrc: previewSrc,
        viewport: getCaptureViewport(),
      },
      attachments: chatCaptures.map((capture) => ({
        id: capture.id,
        note: capture.comment,
        sourcePageUrl: capture.pageUrl,
        asset: {
          publicUrl: getCaptureDisplayUrl(capture),
          storagePath: capture.filePath,
          mimeType: getCaptureMimeType(capture),
        },
      }))
    };
    console.log("Sending AI request with body:", requestBody);
    try {
      const data = await runAiProcess(siteId, requestBody);

      setChatInput("");
      setChatCaptures([]);
      console.log("AI process started with job ID:", data.jobId);
      navigate("/app/editor/split-view", {
        state: { jobId: data.jobId, siteId },
      });
    } finally {
      setIsSendingAiRequest(false);
    }
  };

  const handleAddComment = () => {
    if (!commentText.trim() || !activeTarget) return;
    const newId =
      annotations.length > 0
        ? Math.max(...annotations.map((a) => a.id)) + 1
        : 1;
    const newAnnotation: Annotation = {
      id: newId,
      targetId: activeTarget,
      author: "Current User",
      time: "Just now",
      content: commentText.trim(),
      initials: "CU",
      colorClasses: "bg-[#49704F] text-white",
    };
    setAnnotations([...annotations, newAnnotation]);
    setCommentText("");
    setActiveTarget(null);
  };

  const getRelativeRect = (sel: SelectionRect) => ({
    x: Math.min(sel.startX, sel.endX),
    y: Math.min(sel.startY, sel.endY),
    width: Math.abs(sel.endX - sel.startX),
    height: Math.abs(sel.endY - sel.startY),
  });

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = overlayRef.current!.getBoundingClientRect();
    setSelection({
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
    });
    setIsDragging(true);
  };

  const handleOverlayMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !selection) return;
    const rect = overlayRef.current!.getBoundingClientRect();
    setSelection((s) =>
      s ? { ...s, endX: e.clientX - rect.left, endY: e.clientY - rect.top } : s,
    );
  };

  const handleOverlayMouseUp = () => {
    if (!selection) return;
    setIsDragging(false);
    const r = getRelativeRect(selection);
    if (r.width > 10 && r.height > 10) setShowCommentPopup(true);
  };

  const getCommentPopupPosition = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const popupWidth = 288;
    const popupHeight = 212;
    const margin = 12;
    const overlayWidth = Math.max(
      popupWidth + margin * 2,
      Math.round(overlayRef.current?.clientWidth || window.innerWidth),
    );
    const overlayHeight = Math.max(
      popupHeight + margin * 2,
      Math.round(overlayRef.current?.clientHeight || window.innerHeight),
    );

    const left = Math.min(
      Math.max(margin, rect.x),
      overlayWidth - popupWidth - margin,
    );

    const preferredBelow = rect.y + rect.height + 8;
    const preferredAbove = rect.y - popupHeight - 8;
    const top =
      preferredBelow + popupHeight <= overlayHeight - margin
        ? preferredBelow
        : Math.max(margin, preferredAbove);

    return {
      left,
      top: Math.min(top, overlayHeight - popupHeight - margin),
    };
  };

  const getCaptureViewport = (): CaptureViewport => {
    const iframeEl = iframeRef.current;
    const fallbackWidth = Math.max(
      1,
      Math.round(overlayRef.current?.clientWidth || window.innerWidth),
    );
    const fallbackHeight = Math.max(
      1,
      Math.round(overlayRef.current?.clientHeight || window.innerHeight),
    );

    if (!iframeEl) {
      return {
        width: fallbackWidth,
        height: fallbackHeight,
        scrollX: 0,
        scrollY: 0,
        dpr: window.devicePixelRatio || 1,
      };
    }

    try {
      const frameWindow = iframeEl.contentWindow;
      const frameDocument = frameWindow?.document;
      const docEl = frameDocument?.documentElement;

      return {
        width: Math.max(
          1,
          Math.round(
            docEl?.clientWidth || frameWindow?.innerWidth || fallbackWidth,
          ),
        ),
        height: Math.max(
          1,
          Math.round(
            docEl?.clientHeight || frameWindow?.innerHeight || fallbackHeight,
          ),
        ),
        scrollX: Math.max(0, Math.round(frameWindow?.scrollX || 0)),
        scrollY: Math.max(0, Math.round(frameWindow?.scrollY || 0)),
        dpr: Math.max(
          1,
          frameWindow?.devicePixelRatio || window.devicePixelRatio || 1,
        ),
      };
    } catch {
      return {
        width: fallbackWidth,
        height: fallbackHeight,
        scrollX: 0,
        scrollY: 0,
        dpr: window.devicePixelRatio || 1,
      };
    }
  };

  const handleSaveCapture = async () => {
    if (!selection) return;
    setIsSubmittingCapture(true);
    try {
      const previewSrc = `/api/wp/proxy?url=${encodeURIComponent(selectedPageUrl)}`;
      const result = await captureRegion(
        selectedPageUrl,
        previewSrc,
        getRelativeRect(selection),
        captureComment,
        getCaptureViewport(),
      );
      setCaptures((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          filePath: result.filePath,
          fileName: result.fileName,
          asset: result.asset,
          comment: captureComment,
          pageUrl: selectedPageUrl,
        },
      ]);
    } finally {
      setIsSubmittingCapture(false);
      setShowCommentPopup(false);
      setCaptureComment("");
      setSelection(null);
      setIsCapturing(false);
    }
  };

  const toggleCaptureSelection = (captureId: string) => {
    setSelectedCaptureIds((prev) =>
      prev.includes(captureId)
        ? prev.filter((id) => id !== captureId)
        : [...prev, captureId],
    );
  };

  const handleDeleteSelectedCaptures = () => {
    if (selectedCaptureIds.length === 0) return;
    setCaptures((prev) =>
      prev.filter((capture) => !selectedCaptureIds.includes(capture.id)),
    );
    setChatCaptures((prev) =>
      prev.filter((capture) => !selectedCaptureIds.includes(capture.id)),
    );
    setSelectedCaptureIds([]);
  };

  const handleSaveCapturesToChat = () => {
    if (selectedCaptureIds.length === 0) return;

    const capturesToSave = captures.filter((capture) =>
      selectedCaptureIds.includes(capture.id),
    );

    if (capturesToSave.length === 0) return;

    setChatCaptures((prev) => {
      const merged = [...prev];
      for (const capture of capturesToSave) {
        if (!merged.some((item) => item.id === capture.id)) {
          merged.push(capture);
        }
      }
      return merged;
    });

    setIsChatOpen(true);
  };

  const handleRemoveChatCapture = (captureId: string) => {
    setChatCaptures((prev) =>
      prev.filter((capture) => capture.id !== captureId),
    );
    setSelectedCaptureIds((prev) => prev.filter((id) => id !== captureId));
  };

  const handleClearChatCaptures = () => {
    const chatCaptureIds = chatCaptures.map((capture) => capture.id);
    setChatCaptures([]);
    setSelectedCaptureIds((prev) =>
      prev.filter((id) => !chatCaptureIds.includes(id)),
    );
  };

  const handleSelectAllCaptures = () => {
    setSelectedCaptureIds(captures.map((capture) => capture.id));
  };

  const handleClearCaptureSelection = () => {
    setSelectedCaptureIds([]);
  };

  const previewSrc = selectedPageUrl
    ? `/api/wp/proxy?url=${encodeURIComponent(selectedPageUrl)}`
    : "";
  const selectedPage = wpPages.find((page) => page.link === selectedPageUrl);
  const selectedPageLabel =
    selectedPage?.title?.trim() ||
    selectedPageUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") ||
    "Current page";
  const selectedPageMeta = selectedPage?.slug
    ? `/${selectedPage.slug}`
    : selectedPageUrl;
  const canSendChatMessage =
    !!siteId &&
    (!!chatInput.trim() || chatCaptures.length > 0) &&
    !isSendingAiRequest;

  return (
    <div className="flex flex-col h-screen bg-[#FAF7F0] font-body text-[#233227] overflow-hidden">
      {/* Top Navbar */}
      <header className="h-[72px] shrink-0 border-b border-[#e8e6df] px-6 flex items-center justify-between bg-[#FAF7F0] z-20">
        <div className="flex items-center gap-2">
          <span className="font-headline text-[22px] font-bold text-[#49704F] tracking-tight">
            TerraWP
          </span>
        </div>

        <div className="flex-1 flex justify-center max-w-2xl px-8">
          <div className="relative w-full max-w-md">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-[#8e9892] text-[18px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search pages..."
              className="w-full bg-[#e8e6df]/60 border-none rounded-full pl-11 pr-4 py-2.5 text-[14px] focus:ring-2 focus:ring-[#49704F]/30 outline-none placeholder:text-[#8e9892]"
            />
          </div>
        </div>

        <div className="flex items-center gap-5">
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors">
            <span className="material-symbols-outlined text-[20px]">help</span>
          </button>
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors">
            <span className="material-symbols-outlined text-[20px]">
              notifications
            </span>
          </button>
          <button className="text-[#5c6860] hover:text-[#233227] transition-colors">
            <span className="material-symbols-outlined text-[20px]">
              settings
            </span>
          </button>
          <div className="w-8 h-8 rounded-full overflow-hidden bg-stone-300 border border-[#e8e6df]">
            <img
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBNquCMiRaqjW9ZQps-IM_DXabuGUWa5xfomwd9zlIJn7NyMhcGfdKCYFCtJWfNM1zH94ZA4ylfu9E-NpBJ6cnjgIkQeyNlppuzfxcoKXDCLkNr55QMG2hN8o0i3stD84tWxv6CPjOhxCNCTCpPsHyu72rwl4y45POvfYHIrx9kfwbLravt0JpmIMr-Ky4PNBEde_d--vaoYEWCtz1ZmUP_56qT9wRvWbKM2YYGPa91v99RPbXvS8dHLGGD4jlB2yNgdM7SXTCISW8"
              className="w-full h-full object-cover"
              alt="User profile"
            />
          </div>
        </div>
      </header>

      {/* Main Work Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Sidebar: Site Pages */}
        <aside
          className={`relative shrink-0 overflow-hidden bg-[#FAF7F0] z-10 transition-[width] duration-300 ease-in-out ${sitePagesOpen ? "w-64 border-r border-[#e8e6df]" : "w-14 border-r border-[#e8e6df]"}`}
        >
          {sitePagesOpen ? (
            <div className="flex h-full w-64 flex-col transition-opacity duration-200 opacity-100">
              <div className="p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-headline text-[20px] font-bold text-[#1a2b21] mb-1">
                      Site Pages
                    </h2>
                    <p className="text-[#5c6860] text-[13px]">
                      Select a page to edit layout.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSitePagesOpen(false)}
                    title="Hide site pages"
                    aria-label="Hide site pages"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      left_panel_close
                    </span>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
                {wpPages.length > 0 ? (
                  <>
                    {wpPages.map((page) => {
                      const isActive = selectedPageUrl === page.link;
                      return (
                        <div
                          key={page.id}
                          onClick={() => setSelectedPageUrl(page.link)}
                          className={`rounded-2xl p-4 flex flex-col gap-2 cursor-pointer transition-colors ${isActive ? "border-2 border-[#49704F] bg-[#FAF7F0] shadow-sm" : "bg-white border border-[#e8e6df] hover:border-[#dcd9ce]"}`}
                        >
                          {isActive && (
                            <div className="self-end bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">
                              Editing
                            </div>
                          )}
                          <div className="flex items-center gap-3">
                            <span
                              className={`material-symbols-outlined text-[18px] ${isActive ? "text-[#49704F]" : "text-[#8e9892]"}`}
                            >
                              article
                            </span>
                            <span className="font-bold text-[#233227] text-[14px]">
                              {page.title}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-[#8e9892]">
                            /{page.slug}
                          </span>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <div className="bg-[#FAF7F0] border-2 border-[#49704F] rounded-2xl p-4 flex flex-col gap-2 relative shadow-sm cursor-pointer">
                      <div className="absolute top-4 right-4 bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full">
                        Editing
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-[#49704F] text-[18px]">
                          home
                        </span>
                        <span className="font-bold text-[#233227] text-[14px]">
                          Home
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                        <span className="material-symbols-outlined text-[13px]">
                          history
                        </span>
                        Saved 2m ago
                      </div>
                    </div>

                    {["Blog", "About Us", "Services", "Contact"].map(
                      (page, idx) => (
                        <div
                          key={idx}
                          className="bg-white border border-[#e8e6df] rounded-2xl p-4 flex flex-col gap-2 hover:border-[#dcd9ce] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-[#8e9892] text-[18px]">
                              {page === "Blog"
                                ? "article"
                                : page === "About Us"
                                  ? "info"
                                  : page === "Services"
                                    ? "build"
                                    : "mail"}
                            </span>
                            <span className="font-bold text-[#233227] text-[14px]">
                              {page}
                            </span>
                          </div>
                          {page === "Blog" && (
                            <div className="flex items-center gap-1.5 text-[11px] text-[#5c6860] mt-1">
                              <span className="material-symbols-outlined text-[13px]">
                                history
                              </span>{" "}
                              Updated 5h ago
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </>
                )}

                <button className="w-full mt-4 bg-transparent border-2 border-dashed border-[#dcd9ce] rounded-full py-3 flex items-center justify-center gap-2 text-[#233227] font-bold text-[13px] hover:bg-[#e8e6df]/30 transition-colors">
                  <span className="material-symbols-outlined text-[18px]">
                    add_circle
                  </span>{" "}
                  Add new page
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-14 items-start justify-center pt-6">
              <button
                type="button"
                onClick={() => setSitePagesOpen(true)}
                title="Show site pages"
                aria-label="Show site pages"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
              >
                <span className="material-symbols-outlined text-[16px]">
                  left_panel_open
                </span>
              </button>
            </div>
          )}
        </aside>

        {/* Center Canvas */}
        <main className="min-w-0 flex-1 bg-[#e8e6df]/50 flex flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="shrink-0 border-b border-[#e8e6df] bg-[#f6f1e8] px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#e0dacd] bg-white text-[#49704F]">
                  <span className="material-symbols-outlined text-[18px]">
                    language
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7a866f]">
                    Current Preview
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="max-w-[280px] truncate text-[15px] font-bold text-[#233227]">
                      {selectedPageLabel}
                    </p>
                    {selectedCaptureIds.length > 0 && (
                      <span className="rounded-full border border-[#d8e2d1] bg-[#edf4e8] px-2.5 py-1 text-[11px] font-bold text-[#49704F]">
                        {selectedCaptureIds.length} selected
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 max-w-[360px] truncate text-[12px] text-[#72806f]">
                    {selectedPageMeta}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => {
                    if (isCapturing || showCommentPopup) {
                      cancelCaptureFlow();
                      return;
                    }
                    setIsCapturing(true);
                  }}
                  className={`text-[13px] font-bold px-4 py-2 rounded-full shadow-sm flex items-center gap-2 transition-colors ${isCapturing ? "bg-red-500 hover:bg-red-600 text-white" : "bg-white border border-[#e8e6df] text-[#233227] hover:bg-[#f0ece4]"}`}
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {isCapturing ? "close" : "crop"}
                  </span>
                  {isCapturing ? "Cancel" : "Capture"}
                </button>
                <button
                  onClick={() => setAnnotationsOpen(!annotationsOpen)}
                  className="bg-[#49704F] text-white text-[13px] font-bold px-4 py-2 rounded-full shadow-sm flex items-center gap-2 hover:bg-[#346E56] transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {annotationsOpen ? "dock_to_right" : "comment_bank"}
                  </span>
                  {annotationsOpen ? "Close notes" : "Stakeholder Notes"}
                </button>
              </div>
            </div>
          </div>

          <div className="w-full flex-1 relative">
            {selectedPageUrl ? (
              <iframe
                ref={iframeRef}
                src={previewSrc}
                className="w-full h-full border-none"
                title="Site Preview"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-[#8e9892] text-sm">
                No site URL found. Select a page from the Project Selector.
              </div>
            )}

            {/* Capture overlay */}
            {isCapturing && (
              <div
                ref={overlayRef}
                className="absolute inset-0 z-30"
                style={{ cursor: "crosshair", background: "rgba(0,0,0,0.15)" }}
                onMouseDown={handleOverlayMouseDown}
                onMouseMove={handleOverlayMouseMove}
                onMouseUp={handleOverlayMouseUp}
              >
                {selection &&
                  (() => {
                    const r = getRelativeRect(selection);
                    return (
                      <div
                        className="absolute border-2 border-[#49704F] bg-[#49704F]/10"
                        style={{
                          left: r.x,
                          top: r.y,
                          width: r.width,
                          height: r.height,
                          pointerEvents: "none",
                        }}
                      />
                    );
                  })()}
              </div>
            )}

            {/* Comment popup after capture */}
            {showCommentPopup &&
              selection &&
              (() => {
                const r = getRelativeRect(selection);
                const popupPosition = getCommentPopupPosition(r);
                return (
                  <div
                    className="absolute z-40 bg-white rounded-2xl shadow-xl border border-[#e8e6df] p-4 w-72"
                    style={{
                      left: popupPosition.left,
                      top: popupPosition.top,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-[13px] font-bold text-[#233227] mb-2">
                      Describe the change for this area
                    </p>
                    <textarea
                      autoFocus
                      value={captureComment}
                      onChange={(e) => setCaptureComment(e.target.value)}
                      placeholder="Describe the edit request..."
                      className="w-full border border-[#e8e6df] rounded-xl p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={cancelCaptureFlow}
                        className="text-[#5c6860] text-[12px] font-bold px-3 py-1.5 rounded-lg hover:bg-[#e8e6df]/50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveCapture}
                        disabled={isSubmittingCapture}
                        className="bg-[#49704F] disabled:opacity-50 text-white text-[12px] font-bold px-4 py-1.5 rounded-lg hover:bg-[#346E56]"
                      >
                        {isSubmittingCapture ? "Saving..." : "Save"}
                      </button>
                    </div>
                  </div>
                );
              })()}
          </div>

          {/* Preview chat toggle + collapsible chat panel */}
          {!previewCapture && (
            <div className="absolute right-6 bottom-6 z-30 flex flex-col items-end gap-3 pointer-events-none">
              {isChatOpen && (
                <div className="flex max-h-[70vh] w-[380px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-3xl border border-[#d8ddd4] bg-white pointer-events-auto">
                  <div className="p-3 border-b border-[#e5e8df]">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <h3 className="font-semibold text-sm text-[#2e3e2f]">
                        Live Chat
                      </h3>
                    </div>
                  </div>

                  {chatCaptures.length > 0 && (
                    <div className="flex-1 overflow-hidden p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#6d7d68]">
                          Attached Captures
                        </p>
                        <button
                          type="button"
                          onClick={handleClearChatCaptures}
                          className="text-[11px] font-bold text-[#7a836f] hover:text-[#233227] transition-colors"
                        >
                          Clear all
                        </button>
                      </div>
                      <div className="max-h-[320px] overflow-y-auto pr-1">
                        <div className="flex flex-wrap items-start gap-3">
                          {chatCaptures.map((capture) => (
                            <div
                              key={capture.id}
                              className="relative w-[140px] overflow-hidden rounded-2xl border border-[#d9e3d1] bg-white"
                            >
                              <button
                                type="button"
                                onClick={() => setPreviewCapture(capture)}
                                className="block w-full text-left"
                              >
                                <div className="flex h-20 items-center justify-center bg-[#f7f4ec] p-2">
                                  <img
                                    src={getCaptureDisplayUrl(capture)}
                                    alt="chat capture"
                                    className="block h-full w-full rounded-xl border border-[#ebe5d7] bg-white object-contain"
                                  />
                                </div>
                                <div className="px-2 py-2">
                                  <p
                                    className="overflow-hidden text-[11px] leading-relaxed text-[#556255]"
                                    style={{
                                      display: "-webkit-box",
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: "vertical",
                                    }}
                                  >
                                    {capture.comment || "No edit request"}
                                  </p>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleRemoveChatCapture(capture.id)
                                }
                                className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[#d9d1c3] bg-white/95 text-[#6c7466] hover:text-[#233227] transition-colors"
                                aria-label="Remove attached capture"
                              >
                                <span className="material-symbols-outlined text-[14px]">
                                  close
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {chatCaptures.length === 0 && (
                    <div className="border-t border-[#e5e8df] bg-[#fcfbf7] px-3 py-3">
                      <p className="text-[12px] leading-relaxed text-[#6b7568]">
                        No captures attached yet. Save a selection from the
                        preview to send visual context.
                      </p>
                    </div>
                  )}

                  <div className="p-3 border-t border-[#e5e8df]">
                    <div className="flex gap-2 items-center">
                      <input
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && canSendChatMessage)
                            void sendChatMessage();
                        }}
                        className="flex-1 h-10 text-sm border border-[#ccd7cc] rounded-full px-4 outline-none focus:ring-2 focus:ring-[#4a7c59]/40"
                        placeholder="Ask AI anything (press Enter to send)..."
                      />
                      <button
                        onClick={() => void sendChatMessage()}
                        disabled={!canSendChatMessage}
                        className="h-10 w-10 rounded-full bg-primary disabled:opacity-50 text-white flex items-center justify-center hover:bg-[#356944] transition-colors"
                      >
                        <span className="material-symbols-outlined">
                          {isSendingAiRequest ? "progress_activity" : "send"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => setIsChatOpen((prev) => !prev)}
                className="pointer-events-auto h-12 px-4 rounded-full bg-[#49704F] text-white flex items-center gap-2 hover:bg-[#346E56] transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isChatOpen ? "close" : "auto_awesome"}
                </span>
                <span className="text-[12px] font-bold">
                  {isChatOpen ? "Close chat" : "Open AI chat"}
                </span>
              </button>
            </div>
          )}
        </main>

        {/* Right Sidebar: Captures */}
        <aside
          className={`relative shrink-0 overflow-hidden bg-[#FAF7F0] z-10 transition-[width] duration-300 ease-in-out ${capturesOpen ? "w-[360px] border-l border-[#e8e6df]" : "w-14 border-l border-[#e8e6df]"}`}
        >
          {capturesOpen ? (
            <div className="flex h-full w-[360px] flex-col transition-opacity duration-200 opacity-100">
              <div className="p-6 pb-4 border-b border-[#e8e6df]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-headline text-[18px] font-bold text-[#1a2b21]">
                        Captures
                      </h2>
                      <span className="bg-[#d9edd9] text-[#2c6e49] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full border border-[#cfe2cf]">
                        {captures.length} Saved
                      </span>
                    </div>
                    <p className="text-[#5c6860] text-[13px]">
                      Visual snippets saved from the current preview.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCapturesOpen(false)}
                    title="Hide captures"
                    aria-label="Hide captures"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
                  >
                    <span className="material-symbols-outlined text-[16px]">
                      right_panel_close
                    </span>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {captures.length > 0 ? (
                  <div className="h-full flex flex-col">
                    {captures.length > 1 && (
                      <div className="px-4 pt-4">
                        <div className="flex items-center justify-end gap-3">
                          {selectedCaptureIds.length < captures.length ? (
                            <button
                              type="button"
                              onClick={handleSelectAllCaptures}
                              className="text-[12px] font-bold text-[#49704F] hover:text-[#2f5840] transition-colors"
                            >
                              Select all
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={handleClearCaptureSelection}
                              className="text-[12px] font-bold text-[#7a836f] hover:text-[#233227] transition-colors"
                            >
                              Clear selection
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {selectedCaptureIds.length > 0 && (
                      <div className="border-b border-[#e8e6df] bg-[#faf7f0] px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="inline-flex items-center gap-2 rounded-full border border-[#dde3d8] bg-white px-3 py-1.5">
                            <span className="material-symbols-outlined text-[15px] text-[#49704F]">
                              check_circle
                            </span>
                            <p className="text-[12px] font-bold text-[#4f5b50]">
                              {selectedCaptureIds.length} selected
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={handleSaveCapturesToChat}
                              className="inline-flex items-center gap-1 rounded-full border border-[#cfe0c5] bg-white px-3 py-1.5 text-[11px] font-bold text-[#49704F] hover:bg-[#f3f8ef] transition-colors"
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                forum
                              </span>
                              Add to Chat
                            </button>
                            <button
                              type="button"
                              onClick={handleDeleteSelectedCaptures}
                              className="inline-flex items-center gap-1 rounded-full border border-[#e3c3bc] bg-white px-3 py-1.5 text-[11px] font-bold text-[#a94f46] hover:bg-[#fbf2f0] transition-colors"
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                delete
                              </span>
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex-1 overflow-y-auto px-4 py-4">
                      <div className="space-y-4">
                        {captures.map((cap) => (
                          <div
                            key={cap.id}
                            className={`relative overflow-hidden rounded-[24px] border bg-white transition-colors ${selectedCaptureIds.includes(cap.id) ? "border-[#cfd7cb] bg-[#fcfdfb]" : "border-[#e4e0d4]"}`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleCaptureSelection(cap.id)}
                              className={`absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${selectedCaptureIds.includes(cap.id) ? "border-[#49704F] bg-[#49704F] text-white" : "border-[#d9d4c7] bg-white/95 text-transparent hover:border-[#49704F]"}`}
                              aria-label={
                                selectedCaptureIds.includes(cap.id)
                                  ? "Deselect capture"
                                  : "Select capture"
                              }
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                check
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setPreviewCapture(cap)}
                              className="block w-full border-b border-[#eee8dc] bg-[#f7f4ec] p-3 text-left"
                            >
                              <div className="flex h-36 items-center justify-center">
                                <img
                                  src={getCaptureDisplayUrl(cap)}
                                  alt="capture"
                                  className="block h-full w-full rounded-[18px] border border-[#ebe5d7] bg-white object-contain"
                                />
                              </div>
                            </button>
                            <div className="space-y-1 px-4 py-3">
                              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#7f9475]">
                                Edit Request
                              </p>
                              <p className="text-[13px] leading-relaxed text-[#556255]">
                                {cap.comment || "No edit request provided."}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="m-4 rounded-2xl border border-dashed border-[#d6ddd0] bg-white/70 px-5 py-8 text-center">
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#eef3e8] text-[#49704F]">
                      <span className="material-symbols-outlined text-[20px]">
                        crop
                      </span>
                    </div>
                    <p className="text-[13px] font-bold text-[#233227]">
                      No captures yet
                    </p>
                    <p className="mt-2 text-[12px] leading-relaxed text-[#667062]">
                      Select an area in the preview and save it. Captures will
                      appear here for AI context and later review.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full w-14 items-start justify-center pt-6">
              <button
                type="button"
                onClick={() => setCapturesOpen(true)}
                title="Show captures"
                aria-label="Show captures"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#e8e6df] bg-white text-[#233227] shadow-sm transition-colors hover:bg-[#f0ece4]"
              >
                <span className="material-symbols-outlined text-[16px]">
                  right_panel_open
                </span>
              </button>
            </div>
          )}
        </aside>

        {/* Stakeholder annotations drawer */}
        {annotationsOpen && (
          <>
            <div
              className="absolute inset-0 z-20 bg-[#233227]/12 backdrop-blur-[1px]"
              onClick={() => setAnnotationsOpen(false)}
            />
            <aside className="absolute inset-y-0 right-0 z-30 w-[360px] bg-[#FAF7F0] border-l border-[#e8e6df] flex flex-col shadow-2xl transition-all duration-300">
              <div className="p-6 pb-4 border-b border-[#e8e6df]">
                <div className="flex justify-between items-start gap-3 mb-1">
                  <div>
                    <h2 className="font-headline text-[18px] font-bold text-[#1a2b21]">
                      Stakeholder Notes
                    </h2>
                    <p className="mt-1 text-[#5c6860] text-[13px]">
                      Feedback from{" "}
                      <span className="font-bold text-[#233227]">
                        stakeholders
                      </span>
                      .
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="bg-[#e8d5a1] bg-opacity-40 text-[#7a5e18] text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full border border-[#dcd9ce]">
                      {annotations.length} Open
                    </span>
                    <button
                      type="button"
                      onClick={() => setAnnotationsOpen(false)}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-[#dcd9ce] bg-white text-[#5c6860] hover:text-[#233227] hover:bg-[#f4f1ea] transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        close
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
                {activeTarget && (
                  <div className="bg-white border border-[#49704F]/50 ring-2 ring-[#49704F]/20 rounded-2xl p-4 shadow-sm relative z-20 mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="material-symbols-outlined text-[#49704F] text-[16px]">
                        add_comment
                      </span>
                      <span className="text-[12px] font-bold text-[#49704F]">
                        Comment on {activeTarget.replace("-", " ")}
                      </span>
                    </div>
                    <textarea
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Type your feedback here..."
                      className="w-full bg-[#FAF7F0] border border-[#e8e6df] rounded-lg p-2 text-[13px] outline-none focus:border-[#49704F] resize-none h-20 mb-3"
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => {
                          setActiveTarget(null);
                          setCommentText("");
                        }}
                        className="text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#e8e6df]/50 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleAddComment}
                        disabled={!commentText.trim()}
                        className="bg-[#49704F] disabled:opacity-50 text-white text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#346E56] transition-colors"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {annotations.map((ann) => (
                  <div key={ann.id} className="relative group">
                    <div className="absolute -left-2 top-0 w-6 h-6 rounded-full border-2 border-white bg-[#49704F] text-white flex items-center justify-center font-bold text-[10px] z-10">
                      {ann.id}
                    </div>
                    <div
                      className={`bg-white border rounded-2xl p-5 ml-2 shadow-sm transition-colors ${activeTarget === ann.targetId ? "border-[#49704F] ring-1 ring-[#49704F]" : "border-[#e8e6df]"}`}
                    >
                      <div className="flex items-center gap-3 mb-3">
                        <div
                          className={`w-8 h-8 rounded-full ${ann.colorClasses} flex items-center justify-center text-[11px] font-bold`}
                        >
                          {ann.initials}
                        </div>
                        <div className="leading-tight">
                          <p className="text-[13px] font-bold text-[#233227]">
                            {ann.author}
                          </p>
                          <p className="text-[10px] text-[#8e9892]">
                            {ann.time}
                          </p>
                        </div>
                      </div>
                      <p className="text-[13px] text-[#5c6860] leading-relaxed mb-4">
                        "{ann.content}"
                      </p>
                      <div className="flex gap-2">
                        <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce] transition-colors">
                          Reply
                        </button>
                        <button className="bg-[#e8e6df]/50 text-[#5c6860] text-[11px] font-bold px-3 py-1.5 rounded-md hover:bg-[#dcd9ce] transition-colors">
                          Resolve
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-4 border-t border-[#e8e6df]">
                <button
                  onClick={() => {
                    if (!activeTarget) setActiveTarget("block-1");
                  }}
                  className="w-full bg-[#49704F] text-white text-[13px] font-bold py-3 rounded-full flex items-center justify-center gap-2 hover:bg-[#346E56] transition-colors shadow-sm"
                >
                  <span className="material-symbols-outlined text-[16px]">
                    add_comment
                  </span>{" "}
                  New Annotation
                </button>
              </div>
            </aside>
          </>
        )}

        {previewCapture && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-[#233227]/70 p-6 backdrop-blur-sm"
            onClick={() => setPreviewCapture(null)}
          >
            <div
              className="relative max-h-full w-full max-w-5xl overflow-hidden rounded-[28px] border border-[#d8d1c3] bg-[#faf7f0] shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4 border-b border-[#ece5d8] px-5 py-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7f9475]">
                    Capture Preview
                  </p>
                  <p className="mt-1 text-[13px] text-[#5c6860]">
                    {previewCapture.comment ||
                      "No edit request for this capture."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPreviewCapture(null)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#d9d1c3] bg-white text-[#5c6860] hover:text-[#233227] hover:bg-[#f4f1ea] transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    close
                  </span>
                </button>
              </div>
              <div className="max-h-[80vh] overflow-auto bg-[#f7f4ec] p-5">
                <img
                  src={getCaptureDisplayUrl(previewCapture)}
                  alt="capture preview"
                  className="mx-auto block max-w-full rounded-[22px] border border-[#ebe5d7] bg-white"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Editor;
