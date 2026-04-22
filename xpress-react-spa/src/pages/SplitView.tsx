import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AiProcessError,
  runAiProcess,
  type AiEditRequestPayload,
} from "../services/AiService";
import type { PipelineProgressEvent } from "../hooks/useSse";
import { useSse } from "../hooks/useSse";

interface SplitViewLocationState {
  jobId?: string;
  siteId?: string;
  editRequest?: AiEditRequestPayload;
}

const SplitView: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state ?? {}) as SplitViewLocationState;
  const jobId = locationState.jobId || "";
  const siteId = locationState.siteId || "";
  const previousEditRequest = locationState.editRequest;
  const sse = useSse(jobId || "");
  const [showMetrics, setShowMetrics] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [selectedStepEvent, setSelectedStepEvent] =
    useState<PipelineProgressEvent | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0);
  const [retryState, setRetryState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const previousPreviewStageRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<number>(Date.now());

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

  const getStatusLabel = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "Done";
      case "running":
        return "Running";
      case "stopped":
        return "Stopped";
      case "skipped":
        return "Skipped";
      case "error":
        return "Error";
      case "pending":
      default:
        return "Pending";
    }
  };

  const getStatusBadgeClass = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "border-emerald-300 bg-emerald-50 text-emerald-800";
      case "running":
        return "border-sky-300 bg-sky-50 text-sky-800";
      case "stopped":
        return "border-red-300 bg-red-50 text-red-800";
      case "skipped":
        return "border-slate-300 bg-slate-100 text-slate-700";
      case "error":
        return "border-red-300 bg-red-50 text-red-800";
      case "pending":
      default:
        return "border-slate-300 bg-white text-slate-700";
    }
  };

  const resolveCaptureImageUrl = (imageUrl?: string) => {
    if (!imageUrl) return null;
    if (/^(https?:)?\/\//i.test(imageUrl) || imageUrl.startsWith("data:")) {
      return imageUrl;
    }
    const backendUrl = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
    if (imageUrl.startsWith("/") && backendUrl) {
      return `${backendUrl}${imageUrl}`;
    }
    return imageUrl;
  };

  const formatCapturedAt = (capturedAt?: string) => {
    if (!capturedAt) return null;
    const parsed = new Date(capturedAt);
    if (Number.isNaN(parsed.getTime())) return capturedAt;
    return parsed.toLocaleString();
  };

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
  const latestFailedEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find(
          (event) => event.status === "error" || event.status === "stopped",
        ) ?? null,
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
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setRetryState({ loading: false, error: null });
  }, [jobId]);

  const isPipelineCompleted =
    sse.connectionState === "completed" || Boolean(completionEvent);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nextElapsed = Math.max(
        0,
        Math.floor((Date.now() - startedAtRef.current) / 1000),
      );

      if (isPipelineCompleted) {
        setElapsedSeconds(nextElapsed);
        window.clearInterval(timer);
        return;
      }

      setElapsedSeconds(nextElapsed);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [completionEvent, isPipelineCompleted, sse.connectionState]);

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

  const completionDurationLabel = isPipelineCompleted ? elapsedLabel : null;

  useEffect(() => {
    const shouldWarnBeforeRefresh = () =>
      !isPipelineCompleted;

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
  const canRetryLastRequest = Boolean(siteId && previousEditRequest);
  const shouldShowRetryButton =
    canRetryLastRequest &&
    !deleteState.done &&
    (sse.connectionState === "error" || latestFailedEvent?.status === "error");

  const openStopConfirm = () => {
    if (deleteState.loading || deleteState.done) return;
    setShowStopConfirm(true);
  };

  const closeStopConfirm = () => {
    if (deleteState.loading) return;
    setShowStopConfirm(false);
  };

  const handleDeletePipeline = async () => {
    setDeleteState({ loading: true, done: false });
    try {
      await fetch(`/ai-api/pipeline/delete/${jobId}`, { method: "POST" });
      sse.disconnect();
      setDeleteState({ loading: false, done: true });
      setShowStopConfirm(false);
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

  const handleRetryPipeline = async () => {
    if (!siteId || !previousEditRequest || retryState.loading) return;

    setRetryState({ loading: true, error: null });

    try {
      sse.disconnect();
      const data = await runAiProcess(siteId, previousEditRequest);
      navigate("/app/editor/split-view", {
        replace: true,
        state: {
          jobId: data.jobId,
          siteId,
          editRequest: previousEditRequest,
        },
      });
    } catch (error) {
      const message =
        error instanceof AiProcessError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to retry the pipeline.";
      setRetryState({ loading: false, error: message });
    }
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

  const stepStatuses = useMemo(() => {
    const stepMap = new Map<string, PipelineProgressEvent>();
    sse.allEvents.forEach((event) => {
      stepMap.set(event.step, event);
    });
    return Array.from(stepMap.values()).sort((a, b) => {
      const stepA = parseInt(a.step.split("_")[0]) || 0;
      const stepB = parseInt(b.step.split("_")[0]) || 0;
      return stepA - stepB;
    });
  }, [sse.allEvents]);

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
              {completionDurationLabel && (
                <span className="text-xs font-mono px-2 py-1 rounded bg-emerald-500/15 text-emerald-700">
                  Completed in: {completionDurationLabel}
                </span>
              )}
              <span
                className={`text-xs font-mono px-2 py-1 rounded ${connectionBadge.className}`}
              >
              {connectionBadge.label}
            </span>
            {sse.isConnected && !deleteState.done && (
              <button
                onClick={openStopConfirm}
                disabled={deleteState.loading}
                className="text-xs font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs" style={{ fontSize: 13 }}>stop_circle</span>
                {deleteState.loading ? "Stopping..." : "Stop"}
              </button>
            )}
            {shouldShowRetryButton && (
              <button
                onClick={handleRetryPipeline}
                disabled={retryState.loading}
                className="text-xs font-mono px-2 py-1 rounded bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-xs" style={{ fontSize: 13 }}>
                  replay
                </span>
                {retryState.loading ? "Retrying..." : "Retry"}
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
          {shouldShowRetryButton && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-100">
              <p className="font-semibold text-amber-200">
                The pipeline stopped with an error.
              </p>
              <p className="mt-1 text-amber-100/90">
                Retry will resend the previous request from this screen.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleRetryPipeline}
                  disabled={retryState.loading}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 font-semibold text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    replay
                  </span>
                  {retryState.loading ? "Retrying request..." : "Retry Last Request"}
                </button>
                {latestFailedEvent?.label && (
                  <span className="text-[11px] text-amber-100/80">
                    Failed at: {latestFailedEvent.label}
                  </span>
                )}
              </div>
              {retryState.error && (
                <p className="mt-3 text-[11px] text-red-200">
                  Retry failed: {retryState.error}
                </p>
              )}
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

          {stepStatuses.map((event) => (
            <button
              key={event.step}
              type="button"
              onClick={() => setSelectedStepEvent(event)}
              className="group flex w-full items-start gap-3 rounded-2xl border border-transparent bg-white/25 px-3 py-3 text-left transition hover:border-[#d9d1c3] hover:bg-white/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              <span
                className={`material-symbols-outlined mt-0.5 text-lg ${getStatusColor(event.status)}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {getStatusIcon(event.status)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-green-700 transition group-hover:text-green-800">
                    {event.label}
                  </p>
                  <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    View details
                  </span>
                </div>
                {event.message && (
                  <p className="text-black/50 text-xs">{event.message}</p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
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
            </button>
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
                {completionDurationLabel && (
                  <p className="mt-2 text-xs font-medium text-emerald-800">
                    Total completion time: {completionDurationLabel}
                  </p>
                )}
              </div>
              <div className="mt-4 space-y-2 rounded-xl border border-[#d8cec0] bg-[#d7d1ca] p-3 text-[11px] text-slate-700">
                <p className="break-all">
                  Preview URL: <span className="text-slate-900">{previewUrl}</span>
                </p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className={`${actionButtonClass} border-teal-800 bg-teal-700 text-white hover:bg-teal-800 focus-visible:ring-teal-500`}
                >
                  Open Preview
                </button>
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
                {shouldShowRetryButton && (
                  <button
                    onClick={handleRetryPipeline}
                    disabled={retryState.loading}
                    className={`${actionButtonClass} border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 focus-visible:ring-amber-300 disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      replay
                    </span>
                    {retryState.loading ? "Retrying..." : "Retry Last Request"}
                  </button>
                )}
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
                  Open Preview
                </button>
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

      {showStopConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={closeStopConfirm}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 border-b border-outline-variant/30 px-6 py-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  stop_circle
                </span>
              </div>
              <div className="min-w-0">
                <h2 className="font-headline text-lg font-semibold text-on-surface">
                  Dừng pipeline hiện tại?
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Tất cả tiến trình đang chạy sẽ bị dừng và preview/artifacts hiện tại sẽ bị xóa.
                </p>
              </div>
            </div>
            <div className="px-6 py-4">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Bạn có muốn dừng workflow AI hiện tại không?
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <button
                onClick={closeStopConfirm}
                disabled={deleteState.loading}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={handleDeletePipeline}
                disabled={deleteState.loading}
                className="inline-flex items-center gap-2 rounded-xl border border-red-700 bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">
                  stop_circle
                </span>
                {deleteState.loading ? "Đang dừng..." : "Dừng pipeline"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedStepEvent &&
        (() => {
          const details = selectedStepEvent.data?.stepDetails;
          const previewLink = selectedStepEvent.data?.previewUrl;

          return (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
              onClick={() => setSelectedStepEvent(null)}
            >
              <div
                className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-[28px] border border-outline-variant/40 bg-[#f8f3eb] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sticky top-0 z-10 border-b border-[#e4dac9] bg-[#f8f3eb]/95 px-6 py-5 backdrop-blur">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm">
                        <span
                          className={`material-symbols-outlined text-2xl ${getStatusColor(selectedStepEvent.status)}`}
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          {getStatusIcon(selectedStepEvent.status)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${getStatusBadgeClass(selectedStepEvent.status)}`}
                          >
                            {getStatusLabel(selectedStepEvent.status)}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                            {selectedStepEvent.percent}% complete
                          </span>
                          {details?.kind === "edit-request" && (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800">
                              User Edit Request
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 font-headline text-2xl font-semibold text-slate-900">
                          {details?.title || selectedStepEvent.label}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {details?.summary ||
                            selectedStepEvent.message ||
                            "This workflow step does not expose extra structured details yet."}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedStepEvent(null)}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        close
                      </span>
                    </button>
                  </div>
                </div>

                <div className="space-y-6 px-6 py-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Step
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">
                        {selectedStepEvent.label}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Latest Log
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {selectedStepEvent.message || "No additional log message."}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Preview Context
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {previewLink
                          ? "This step is attached to a live preview context."
                          : "No preview URL was attached to this step."}
                      </p>
                      {previewLink && (
                        <button
                          type="button"
                          onClick={() => window.open(previewLink, "_blank")}
                          className="mt-3 inline-flex items-center gap-2 rounded-xl border border-emerald-700 bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            open_in_new
                          </span>
                          Open Related Preview
                        </button>
                      )}
                    </div>
                  </div>

                  {details?.kind === "edit-request" && (
                    <>
                      <div className="rounded-[24px] border border-[#e4dac9] bg-white p-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-full bg-[#eef3ea] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#446150]">
                            Main Request
                          </span>
                          {details.language && (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                              {details.language}
                            </span>
                          )}
                          {details.targetRoute && (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-700">
                              Route: {details.targetRoute}
                            </span>
                          )}
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-700">
                            Captures: {details.captureCount}
                          </span>
                        </div>
                        <div className="mt-4 rounded-2xl bg-[#f8f3eb] px-4 py-4">
                          <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">
                            {details.prompt || "No main prompt was submitted. This run is driven by capture notes only."}
                          </p>
                        </div>
                        {details.targetPageTitle && (
                          <p className="mt-3 text-xs text-slate-500">
                            Target page: {details.targetPageTitle}
                          </p>
                        )}
                      </div>

                      <div className="rounded-[24px] border border-[#e4dac9] bg-white p-5">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Capture Attachments
                            </p>
                            <h3 className="mt-2 font-headline text-xl text-slate-900">
                              Submitted visual references
                            </h3>
                          </div>
                          <span className="rounded-full bg-[#eef3ea] px-3 py-1 text-xs font-semibold text-[#446150]">
                            {details.captures.length} item(s)
                          </span>
                        </div>

                        {details.captures.length > 0 ? (
                          <div className="mt-5 grid gap-4 md:grid-cols-2">
                            {details.captures.map((capture) => {
                              const imageSrc = resolveCaptureImageUrl(capture.imageUrl);
                              const capturedAtLabel = formatCapturedAt(capture.capturedAt);

                              return (
                                <div
                                  key={capture.id}
                                  className="overflow-hidden rounded-[22px] border border-[#eadfce] bg-[#fcfaf6]"
                                >
                                  <div className="flex h-56 items-center justify-center bg-[#f2e8da]">
                                    {imageSrc ? (
                                      <img
                                        src={imageSrc}
                                        alt={capture.note || `capture-${capture.id}`}
                                        className="h-full w-full object-contain"
                                      />
                                    ) : (
                                      <div className="px-6 text-center text-sm text-slate-500">
                                        This capture does not expose an image URL.
                                      </div>
                                    )}
                                  </div>
                                  <div className="space-y-3 px-4 py-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
                                        {capture.pageRoute || capture.sourcePageUrl || "Unknown route"}
                                      </span>
                                      {capture.tagName && (
                                        <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
                                          {capture.tagName}
                                        </span>
                                      )}
                                    </div>
                                    <div>
                                      <p className="text-sm font-semibold leading-6 text-slate-900">
                                        {capture.note || "No capture note provided."}
                                      </p>
                                      {capture.pageTitle && (
                                        <p className="mt-1 text-xs text-slate-500">
                                          Page: {capture.pageTitle}
                                        </p>
                                      )}
                                    </div>
                                    {(capture.selector ||
                                      capture.nearestHeading ||
                                      capturedAtLabel) && (
                                      <div className="rounded-2xl bg-white px-3 py-3 text-xs leading-6 text-slate-600">
                                        {capture.nearestHeading && (
                                          <p>Nearest heading: {capture.nearestHeading}</p>
                                        )}
                                        {capture.selector && (
                                          <p className="break-all">Target: {capture.selector}</p>
                                        )}
                                        {capturedAtLabel && (
                                          <p>Captured at: {capturedAtLabel}</p>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="mt-5 rounded-2xl border border-dashed border-[#d8cbb7] bg-[#faf5ec] px-4 py-6 text-sm text-slate-600">
                            No capture attachments were submitted for this request.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

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
