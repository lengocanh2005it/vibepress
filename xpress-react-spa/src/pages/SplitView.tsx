import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PipelineProgressEvent } from "../hooks/useSse";
import { useSse } from "../hooks/useSse";

const SplitView: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const jobId = location.state?.jobId || "";
  const siteId: string = location.state?.siteId || "";
  const sse = useSse(jobId || "");
  const [showMetrics, setShowMetrics] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0);
  const previousPreviewStageRef = useRef<string | undefined>(undefined);

  const getConnectionBadge = () => {
    switch (sse.connectionState) {
      case "connected":
        return {
          label: "Connected",
          className: "bg-green-500/20 text-green-600",
          dotClassName: "bg-green-800 animate-pulse",
        };
      case "reconnecting":
        return {
          label: "Reconnecting",
          className: "bg-amber-500/20 text-amber-600",
          dotClassName: "bg-amber-500 animate-pulse",
        };
      case "connecting":
        return {
          label: "Connecting",
          className: "bg-sky-500/20 text-sky-600",
          dotClassName: "bg-sky-500 animate-pulse",
        };
      case "completed":
        return {
          label: "Completed",
          className: "bg-green-500/20 text-green-600",
          dotClassName: "bg-green-700",
        };
      case "error":
        return {
          label: "Error",
          className: "bg-red-500/20 text-red-400",
          dotClassName: "bg-red-500",
        };
      case "idle":
      default:
        return {
          label: "Idle",
          className: "bg-white/10 text-black/45",
          dotClassName: "bg-white/30",
        };
    }
  };

  const connectionBadge = getConnectionBadge();

  const getStatusIcon = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "check_circle";
      case "running":
        return "sync";
      case "stopped":
        return "stop_circle";
      case "skipped":
        return "skip_next";
      case "error":
        return "error";
      case "pending":
      default:
        return "schedule";
    }
  };

  const getStatusColor = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "text-green-500";
      case "running":
        return "text-primary animate-spin";
      case "stopped":
        return "text-red-500";
      case "skipped":
        return "text-white/30";
      case "error":
        return "text-red-500";
      case "pending":
      default:
        return "text-white/40";
    }
  };

  const completionEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => event.step === "11_done" && event.status === "done") ??
      null,
    [sse.allEvents],
  );
  const latestPreviewEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => Boolean(event.data?.previewUrl)) ?? null,
    [sse.allEvents],
  );
  const latestMetricsEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => Boolean(event.data?.metrics)) ?? null,
    [sse.allEvents],
  );
  const latestEvent = sse.currentEvent;
  const previewData = latestPreviewEvent?.data;
  const previewUrl = previewData?.previewUrl ?? completionEvent?.data?.previewUrl;
  const apiBaseUrl =
    previewData?.apiBaseUrl ?? completionEvent?.data?.apiBaseUrl;
  const previewStage =
    previewData?.previewStage ?? completionEvent?.data?.previewStage;
  const hasEditRequest = Boolean(
    previewData?.hasEditRequest ?? completionEvent?.data?.hasEditRequest,
  );
  const metricsData = latestMetricsEvent?.data?.metrics;

  const previewFrameSrc = useMemo(() => {
    if (!previewUrl) return "";
    const separator = previewUrl.includes("?") ? "&" : "?";
    return `${previewUrl}${separator}livePreview=${previewRefreshNonce}`;
  }, [previewRefreshNonce, previewUrl]);

  useEffect(() => {
    if (!previewUrl || !previewStage) return;
    const previousStage = previousPreviewStageRef.current;
    if (
      previousStage &&
      previousStage !== previewStage &&
      previewStage !== "baseline"
    ) {
      setPreviewRefreshNonce((value) => value + 1);
    }
    previousPreviewStageRef.current = previewStage;
  }, [previewStage, previewUrl]);

  const previewStatus = useMemo(() => {
    if (!previewStage) {
      return {
        badge: "Preparing",
        title: "Preview is still being prepared",
        description: "The preview will appear here as soon as it starts.",
        badgeClass: "border-slate-300 bg-white text-slate-700",
      };
    }

    if (previewStage === "baseline" && hasEditRequest) {
      return {
        badge: "Baseline Live",
        title: "You are viewing the baseline preview",
        description:
          "The preview is already running while the pipeline applies the requested edits in the background.",
        badgeClass: "border-amber-300 bg-amber-50 text-amber-800",
      };
    }

    if (previewStage === "baseline") {
      return {
        badge: "Preview Live",
        title: "The preview is ready for inspection",
        description:
          "Frontend and backend preview servers are live while the pipeline continues with metrics and cleanup.",
        badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
      };
    }

    if (previewStage === "edited") {
      return {
        badge: "Edited Live",
        title: "Requested edits are now visible",
        description:
          "The running preview has been updated with the edit request while the pipeline continues with visual metrics.",
        badgeClass: "border-sky-300 bg-sky-50 text-sky-800",
      };
    }

    return {
      badge: "Final Ready",
      title: "The final edited preview is ready",
      description:
        "Pipeline execution is complete. You can inspect metrics and then push the result to GitHub.",
      badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
    };
  }, [hasEditRequest, previewStage]);

  useEffect(() => {
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const isFinished =
        sse.connectionState === "completed" || Boolean(completionEvent);
      if (isFinished) {
        window.clearInterval(timer);
        return;
      }

      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [completionEvent, jobId, sse.connectionState]);

  const elapsedLabel = useMemo(() => {
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;

    if (hours > 0) {
      return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    }

    return [minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }, [elapsedSeconds]);

  useEffect(() => {
    const shouldWarnBeforeRefresh = () =>
      !completionEvent && sse.connectionState !== "completed";

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldWarnBeforeRefresh()) return;
      event.preventDefault();
      event.returnValue = "";
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isRefreshShortcut =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "r");

      if (!isRefreshShortcut || !shouldWarnBeforeRefresh()) return;

      event.preventDefault();
      const confirmed = window.confirm(
        "The AI pipeline is still running. Refreshing this page may interrupt your live monitoring. Do you want to refresh anyway?",
      );

      if (confirmed) {
        window.location.reload();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [completionEvent, sse.connectionState]);
  const [deleteState, setDeleteState] = useState<{ loading: boolean; done: boolean }>({ loading: false, done: false });

  const handleDeletePipeline = async () => {
    setDeleteState({ loading: true, done: false });
    try {
      await fetch(`/ai-api/pipeline/delete/${jobId}`, { method: "POST" });
      setDeleteState({ loading: false, done: true });
    } catch {
      setDeleteState({ loading: false, done: false });
    }
  };

  const [pushGitState, setPushGitState] = useState<{
    loading: boolean;
    githubUrl: string | null;
    error: string | null;
  }>({ loading: false, githubUrl: null, error: null });

  const handlePushToGit = async () => {
    setPushGitState({ loading: true, githubUrl: null, error: null });
    try {
      const res = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, siteId }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Push failed");
      setPushGitState({ loading: false, githubUrl: data.githubUrl, error: null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setPushGitState({ loading: false, githubUrl: null, error: message });
    }
  };

  const handleRefreshPreview = () => {
    setPreviewRefreshNonce((value) => value + 1);
  };

  const handleOpenVisualEdit = () => {
    if (!completionEvent || !previewUrl) return;
    navigate("/app/editor/visual", {
      state: {
        jobId,
        siteId,
        previewUrl,
        apiBaseUrl,
      },
    });
  };

  const actionButtonClass =
    "inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

  // Group events by step and get the latest status for each step
  const getLatestStepStatuses = () => {
    const stepMap = new Map<string, PipelineProgressEvent>();
    sse.allEvents.forEach((event) => {
      stepMap.set(event.step, event);
    });
    return Array.from(stepMap.values()).sort((a, b) => {
      const stepA = parseInt(a.step.split("_")[0]) || 0;
      const stepB = parseInt(b.step.split("_")[0]) || 0;
      return stepA - stepB;
    });
  };

  if (!jobId) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-on-surface">No Job ID</h1>
          <p className="text-on-surface-variant">
            Please provide a jobId to start pipeline
          </p>
          <button
            onClick={() => navigate("/app/projects")}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:opacity-90"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-background text-on-surface font-body">
      <section className="w-1/2 bg-inverse-surface text-inverse-on-surface flex flex-col border-r border-outline">
        <div className="px-6 py-4 flex items-center justify-between bg-black/10">
          <div className="flex items-center gap-3">
            <div
              className={`w-2 h-2 rounded-full ${connectionBadge.dotClassName}`}
            />
            <div>
              <h2 className="font-headline text-lg tracking-tight">
                AI Workflow Console
              </h2>
              <p className="text-[11px] text-black/45">
                Live progress from the migration agents
              </p>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-xs font-mono opacity-50 px-2 py-1 bg-white/5 rounded">
              Job: {jobId.slice(0, 8)}...
            </span>
            <span className="text-xs font-mono opacity-60 px-2 py-1 bg-white/5 rounded">
              Elapsed: {elapsedLabel}
            </span>
            <span
              className={`text-xs font-mono px-2 py-1 rounded ${connectionBadge.className}`}
            >
              {connectionBadge.label}
            </span>
            {sse.isConnected && !deleteState.done && (
              <button
                onClick={handleDeletePipeline}
                disabled={deleteState.loading}
                className="text-xs font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs" style={{ fontSize: 13 }}>stop_circle</span>
                {deleteState.loading ? "Stopping..." : "Stop"}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 font-mono text-sm space-y-4">
          {latestEvent ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-black/40">
                Current Agent Action
              </p>
              <p className="mt-2 text-sm text-green-700">{latestEvent.label}</p>
              {latestEvent.message && (
                <p className="mt-1 text-xs text-black/55">{latestEvent.message}</p>
              )}
            </div>
          ) : sse.isConnected && !sse.isLoading ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-black/40">
                Current Agent Action
              </p>
              <p className="mt-2 text-sm text-green-700">
                Waiting for the first agent action...
              </p>
              <p className="mt-1 text-xs text-black/55">
                The workflow stream is connected. The first step update will appear here as soon as the backend emits it.
              </p>
            </div>
          ) : null}

          {sse.isLoading && (
            <p className="text-black/40">
              {sse.connectionState === "reconnecting"
                ? "Reconnecting to the AI workflow stream..."
                : "Connecting to the AI workflow stream..."}
            </p>
          )}
          {sse.error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-xs">
              Workflow error: {sse.error.message}
            </div>
          )}

          {sse.allEvents.length === 0 && !sse.isLoading ? (
            <p className="text-black/50">
              {sse.connectionState === "connected"
                ? "Connected. Waiting for the first agent update..."
                : sse.connectionState === "reconnecting"
                  ? "Reconnecting to the workflow stream while the pipeline continues..."
                  : "Waiting for the workflow stream..."}
            </p>
          ) : null}

          {getLatestStepStatuses().map((event) => (
            <div key={event.step} className="flex gap-3 items-start">
              <span
                className={`material-symbols-outlined text-lg ${getStatusColor(event.status)}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {getStatusIcon(event.status)}
              </span>
              <div className="space-y-1 flex-1">
                <p className="text-green-700">{event.label}</p>
                {event.message && (
                  <p className="text-black/50 text-xs">{event.message}</p>
                )}
                <div className="flex items-center gap-2 mt-2">
                  <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${event.percent}%` }}
                    />
                  </div>
                  <span className="text-xs text-black/50">
                    {event.percent}%
                  </span>
                </div>
              </div>
            </div>
          ))}

          {previewUrl && (
            <div className="mt-8 rounded-2xl border border-[#d9d1c3] bg-[#f7f1e8] p-4 text-xs text-slate-700 shadow-lg shadow-black/10">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
                >
                  {previewStatus.badge}
                </span>
                {metricsData && (
                  <span className="inline-flex items-center rounded-full border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-800">
                    Metrics Ready
                  </span>
                )}
              </div>
              <div className="mt-3">
                <p className="text-sm font-semibold text-slate-900">{previewStatus.title}</p>
                <p className="mt-1 text-xs text-slate-600">{previewStatus.description}</p>
              </div>
              <div className="mt-4 space-y-2 rounded-xl border border-[#d8cec0] bg-[#d7d1ca] p-3 text-[11px] text-slate-700">
                <p className="break-all">
                  Frontend Preview: <span className="text-slate-900">{previewUrl}</span>
                </p>
                {apiBaseUrl && (
                  <p className="break-all">
                    Backend API: <span className="text-slate-900">{apiBaseUrl}</span>
                  </p>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className={`${actionButtonClass} border-teal-800 bg-teal-700 text-white hover:bg-teal-800 focus-visible:ring-teal-500`}
                >
                  Open Frontend
                </button>
                {apiBaseUrl && (
                  <button
                    onClick={() => window.open(apiBaseUrl, "_blank")}
                    className={`${actionButtonClass} border-cyan-800 bg-cyan-700 text-white hover:bg-cyan-800 focus-visible:ring-cyan-500`}
                  >
                    Open Backend
                  </button>
                )}
                <button
                  onClick={handleRefreshPreview}
                  className={`${actionButtonClass} border-slate-300 bg-white text-slate-900 hover:bg-slate-100 focus-visible:ring-slate-400`}
                >
                  Refresh Preview
                </button>
                {metricsData && (
                  <button
                    onClick={() => setShowMetrics(true)}
                    className={`${actionButtonClass} border-orange-700 bg-orange-600 text-white hover:bg-orange-700 focus-visible:ring-orange-500`}
                  >
                    View Metrics
                  </button>
                )}
                {completionEvent &&
                  (pushGitState.githubUrl ? (
                    <button
                      onClick={() => window.open(pushGitState.githubUrl!, "_blank")}
                      className={`${actionButtonClass} border-slate-950 bg-slate-900 text-white hover:bg-black focus-visible:ring-slate-500`}
                    >
                      View on GitHub
                    </button>
                  ) : (
                    <button
                      onClick={handlePushToGit}
                      disabled={pushGitState.loading}
                      className={`${actionButtonClass} border-slate-950 bg-slate-900 text-white hover:bg-black focus-visible:ring-slate-500 disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {pushGitState.loading ? "Pushing…" : "Push to GitHub"}
                    </button>
                  ))}
              </div>
              {pushGitState.error && (
                <p className="mt-3 text-xs text-red-700">{pushGitState.error}</p>
              )}
            </div>
          )}
        </div>

        <div className="p-4 bg-black/10 border-t border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-black/40">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">
                terminal
              </span>
              {sse.connectionState === "connected"
                ? "Agent Stream Live"
                : sse.connectionState === "reconnecting"
                  ? "Agent Stream Reconnecting"
                  : sse.connectionState === "connecting"
                    ? "Agent Stream Connecting"
                    : sse.connectionState === "completed"
                      ? "Agent Stream Completed"
                      : "Agent Stream Offline"}
            </span>
            <span className="flex items-center gap-1">
              {sse.progress}% Workflow Progress
            </span>
          </div>
          <div className="text-xs text-primary font-bold">
            {completionEvent
              ? "WORKFLOW COMPLETE"
              : "AGENTS WORKING"}
          </div>
        </div>
      </section>

      <section className="w-1/2 bg-surface-container-low flex flex-col">
        <div className="px-6 py-4 border-b border-outline-variant bg-white/60 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">
                visibility
              </span>
              <div className="min-w-0">
                <h2 className="font-headline text-lg text-on-surface">
                  Live Preview
                </h2>
                {previewUrl ? (
                  <p className="truncate text-xs text-on-surface-variant">
                    {previewStatus.description}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end">
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
              >
                {previewStatus.badge}
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {previewUrl ? (
              <>
                {completionEvent && (
                  <button
                    onClick={handleOpenVisualEdit}
                    className={`${actionButtonClass} border-amber-900 bg-amber-700 text-white hover:bg-amber-800 focus-visible:ring-amber-500 shadow-md shadow-amber-900/20`}
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      auto_fix_high
                    </span>
                    Open Visual Edit
                  </button>
                )}
                <button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className={`${actionButtonClass} border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 focus-visible:ring-emerald-300`}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    language
                  </span>
                  Frontend
                </button>
                {apiBaseUrl && (
                  <button
                    onClick={() => window.open(apiBaseUrl, "_blank")}
                    className={`${actionButtonClass} border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 focus-visible:ring-sky-300`}
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      dns
                    </span>
                    Backend
                  </button>
                )}
                <button
                  onClick={handleRefreshPreview}
                  title="Refresh preview"
                  aria-label="Refresh preview"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-900 shadow-sm transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    refresh
                  </span>
                </button>
              </>
            ) : (
              <span className="text-xs text-on-surface-variant">Waiting...</span>
            )}
          </div>
        </div>

        <div className="flex-1 p-8 overflow-y-auto flex items-center justify-center">
          {deleteState.done ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-red-400 text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>stop_circle</span>
              </div>
              <p className="text-on-surface font-medium">Pipeline đã tạm dừng</p>
              <p className="text-xs text-on-surface-variant">Tất cả tiến trình đã được dừng lại và artifacts đã được xóa.</p>
              <button
                onClick={() => navigate("/app/projects")}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:opacity-90 text-sm font-medium"
              >
                Quay về trang dự án
              </button>
            </div>
          ) : previewUrl ? (
            <div className="relative h-full w-full">
              <div className="pointer-events-none absolute left-5 top-5 z-10 max-w-md rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-lg backdrop-blur">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
                  >
                    {previewStatus.badge}
                  </span>
                  {metricsData && (
                    <span className="inline-flex items-center rounded-full border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-800">
                      Metrics Ready
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {previewStatus.title}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {previewStatus.description}
                </p>
              </div>
              <iframe
                src={previewFrameSrc}
                title="Live Preview"
                className="h-full w-full rounded-2xl border border-outline-variant bg-white shadow-sm transition-all duration-500"
              />
            </div>
          ) : (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin mx-auto" />
              <p className="text-on-surface-variant">AI agents are preparing the preview...</p>
              <p className="text-xs text-on-surface-variant/50">
                {sse.progress > 0
                  ? `${sse.progress}% workflow complete`
                  : "Initializing migration workflow..."}
              </p>
            </div>
          )}
        </div>
      </section>

      {showMetrics &&
        metricsData &&
        (() => {
          const { summary, pages } = metricsData;
          const hasContentSummary = summary.content !== null;
          const visualSummary = summary.visual ?? {
            totalCompared: 0,
            passed: 0,
            failed: 0,
            passRate: 0,
            avgAccuracy: 0,
          };
          const contentSummary = summary.content ?? {
            total: 0,
            passed: 0,
            failed: 0,
            missing: 0,
            passRate: 0,
            avgOverall: 0,
          };
          const visualAccuracy = visualSummary.avgAccuracy;
          const scoreColor =
            visualAccuracy >= 95
              ? "text-primary"
              : visualAccuracy >= 80
                ? "text-[#705c30]"
                : "text-error";
          const scoreBg =
            visualAccuracy >= 95
              ? "bg-primary/10 border-primary/30"
              : visualAccuracy >= 80
                ? "bg-[#705c30]/10 border-[#705c30]/30"
                : "bg-error/10 border-error/30";
          const scoreBarColor =
            visualAccuracy >= 95
              ? "bg-primary"
              : visualAccuracy >= 80
                ? "bg-[#705c30]"
                : "bg-error";

          return (
            <div
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
              onClick={() => setShowMetrics(false)}
            >
              <div
                className="relative bg-surface w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl border border-outline-variant/40 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-surface border-b border-outline-variant/30">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <span
                        className="material-symbols-outlined text-primary text-xl"
                        style={{ fontVariationSettings: "'FILL' 1" }}
                      >
                        analytics
                      </span>
                    </div>
                    <div>
                      <h2 className="font-headline text-base font-bold text-on-surface leading-tight">
                        Migration Report
                      </h2>
                      <p className="text-xs text-on-surface-variant">
                        Visual &amp; content comparison across {pages.length}{" "}
                        pages
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowMetrics(false)}
                    className="p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors"
                  >
                    <span className="material-symbols-outlined text-xl">
                      close
                    </span>
                  </button>
                </div>

                <div className="p-6 space-y-5">
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 gap-3">
                    {/* Visual */}
                    <div
                      className={`p-4 rounded-2xl border ${scoreBg}`}
                    >
                      <p className="text-xs font-medium text-on-surface-variant mb-2 uppercase tracking-wider">
                        Visual
                      </p>
                      <div className="flex items-end gap-2 mb-2">
                        <p
                          className={`text-3xl font-headline font-bold ${scoreColor}`}
                        >
                          {visualSummary.avgAccuracy.toFixed(1)}
                          <span className="text-base">%</span>
                        </p>
                        <p className="text-xs text-on-surface-variant mb-1">
                          avg accuracy
                        </p>
                      </div>
                      <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden mb-2">
                        <div
                          className={`h-full rounded-full ${scoreBarColor}`}
                          style={{
                            width: `${visualSummary.avgAccuracy}%`,
                          }}
                        />
                      </div>
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-500">
                          {visualSummary.passed} passed
                        </span>
                        <span className="text-error">
                          {visualSummary.failed} failed
                        </span>
                        <span className="text-on-surface-variant">
                          {visualSummary.totalCompared} total
                        </span>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-4 rounded-2xl border border-outline-variant/30 bg-surface-container-low">
                      <p className="text-xs font-medium text-on-surface-variant mb-2 uppercase tracking-wider">
                        Content
                      </p>
                      {hasContentSummary ? (
                        <>
                          <div className="flex items-end gap-2 mb-2">
                            <p className="text-3xl font-headline font-bold text-on-surface">
                              {contentSummary.passRate.toFixed(1)}
                              <span className="text-base">%</span>
                            </p>
                            <p className="text-xs text-on-surface-variant mb-1">
                              pass rate
                            </p>
                          </div>
                          <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden mb-2">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${contentSummary.passRate}%` }}
                            />
                          </div>
                          <div className="flex gap-3 text-xs">
                            <span className="text-green-500">
                              {contentSummary.passed} passed
                            </span>
                            <span className="text-yellow-500">
                              {contentSummary.missing} missing
                            </span>
                            <span className="text-on-surface-variant">
                              {contentSummary.total} total
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-xl border border-dashed border-outline-variant/50 bg-surface px-4 py-5">
                          <p className="text-sm font-semibold text-on-surface">
                            Khong co du lieu
                          </p>
                          <p className="mt-1 text-xs text-on-surface-variant">
                            Automation hien khong tra ve tong hop content cho lan so sanh nay.
                          </p>
                        </div>
                      )}
                      {summary.errors.content && (
                        <p className="mt-3 text-[11px] text-amber-700">
                          Content metrics unavailable: {summary.errors.content}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Pages table */}
                  <div>
                    <p className="text-xs font-medium text-on-surface-variant mb-3 uppercase tracking-wider">
                      Pages
                    </p>
                    <div className="rounded-xl border border-outline-variant/30 overflow-hidden">
                      <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-surface-container text-xs font-medium text-on-surface-variant border-b border-outline-variant/30">
                        <span className="col-span-4">Page</span>
                        <span className="col-span-2">Type</span>
                        <span className="col-span-3">Visual accuracy</span>
                        <span className="col-span-3">Content</span>
                      </div>
                      {pages.map((page, i) => {
                        const acc = page.visual?.accuracy ?? null;
                        const accColor =
                          acc === null
                            ? ""
                            : acc >= 95
                              ? "text-primary"
                              : acc >= 80
                                ? "text-[#705c30]"
                                : "text-error";
                        const accBar =
                          acc === null
                            ? ""
                            : acc >= 95
                              ? "bg-primary"
                              : acc >= 80
                                ? "bg-[#705c30]"
                                : "bg-error";
                        return (
                          <div
                            key={page.slug + i}
                            className={`grid grid-cols-12 gap-2 px-4 py-3 text-xs ${i < pages.length - 1 ? "border-b border-outline-variant/20" : ""} hover:bg-surface-container/50`}
                          >
                            <div className="col-span-4 flex flex-col justify-center min-w-0">
                              <p className="font-medium text-on-surface truncate">
                                {page.slug}
                              </p>
                              {page.url && (
                                <p className="text-on-surface-variant/50 truncate">
                                  {page.url.replace(
                                    /^https?:\/\/[^/]+/,
                                    "",
                                  )}
                                </p>
                              )}
                            </div>
                            <div className="col-span-2 flex items-center">
                              <span className="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant text-[10px]">
                                {page.type}
                              </span>
                            </div>
                            <div className="col-span-3 flex flex-col justify-center gap-1">
                              {acc !== null ? (
                                <>
                                  <div className="flex items-center gap-1.5">
                                    <div className="flex-1 h-1 bg-surface-container-high rounded-full overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${accBar}`}
                                        style={{ width: `${acc}%` }}
                                      />
                                    </div>
                                    <span
                                      className={`font-mono text-[11px] shrink-0 ${accColor}`}
                                    >
                                      {acc.toFixed(1)}%
                                    </span>
                                  </div>
                                </>
                              ) : (
                                <span className="text-on-surface-variant/40">
                                  —
                                </span>
                              )}
                            </div>
                            <div className="col-span-3 flex items-center">
                              {page.content ? (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                    page.content.status === "PASS"
                                      ? "bg-green-500/10 text-green-600"
                                      : page.content.status === "MISSING"
                                        ? "bg-yellow-500/10 text-yellow-600"
                                        : "bg-error/10 text-error"
                                  }`}
                                >
                                  {page.content.status}
                                  {page.content.status === "PASS" &&
                                  page.content.scores.overall > 0
                                    ? ` · ${page.content.scores.overall}%`
                                    : ""}
                                </span>
                              ) : (
                                <span className="text-on-surface-variant/40 text-[10px]">
                                  —
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};

export default SplitView;
