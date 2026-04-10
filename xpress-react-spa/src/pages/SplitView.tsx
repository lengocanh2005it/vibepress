import React, { useEffect, useMemo, useState } from "react";
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
      case "error":
        return "text-red-500";
      case "pending":
      default:
        return "text-white/40";
    }
  };

  // Check if pipeline is complete by looking for any done event with previewUrl
  const getCompletionEvent = () => {
    return sse.allEvents.find(
      (event) => event.status === "done" && event.data?.previewUrl,
    );
  };

  const completionEvent = getCompletionEvent();
  const latestEvent = sse.currentEvent;

  useEffect(() => {
    setElapsedSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const isFinished =
        sse.connectionState === "completed" ||
        sse.currentEvent?.status === "done";
      if (isFinished) {
        window.clearInterval(timer);
        return;
      }

      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [jobId, sse.connectionState, sse.currentEvent?.status]);

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
          <div className="flex gap-2">
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

          {completionEvent && (
            <div className="mt-8 p-4 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs">
              <div className="font-bold mb-2">Preview Is Ready</div>
              <p className="text-green-400/80">
                Preview URL: {completionEvent.data?.previewUrl}
              </p>
              <p className="mt-1 text-green-400/65">
                The AI workflow finished building and checking the preview.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() =>
                    window.open(completionEvent.data?.previewUrl, "_blank")
                  }
                  className="px-3 py-1 bg-green-500/20 hover:bg-green-500/30 border border-green-500/50 rounded text-green-400 text-xs"
                >
                  Open Preview
                </button>
                {completionEvent.data?.metrics && (
                  <button
                    onClick={() => setShowMetrics(true)}
                    className="px-3 py-1 bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 rounded text-blue-400 text-xs"
                  >
                    View Metrics
                  </button>
                )}
                {pushGitState.githubUrl ? (
                  <button
                    onClick={() => window.open(pushGitState.githubUrl!, "_blank")}
                    className="px-3 py-1 bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/50 rounded text-violet-400 text-xs"
                  >
                    View on GitHub →
                  </button>
                ) : (
                  <button
                    onClick={handlePushToGit}
                    disabled={pushGitState.loading}
                    className="px-3 py-1 bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/50 rounded text-violet-400 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {pushGitState.loading ? "Pushing…" : "Push to GitHub"}
                  </button>
                )}
                {pushGitState.error && (
                  <span className="text-red-400 text-xs self-center">
                    {pushGitState.error}
                  </span>
                )}
              </div>
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
            {sse.currentEvent?.status === "done"
              ? "WORKFLOW COMPLETE"
              : "AGENTS WORKING"}
          </div>
        </div>
      </section>

      <section className="w-1/2 bg-surface-container-low flex flex-col">
        <div className="px-6 py-4 flex items-center justify-between border-b border-outline-variant bg-white/50 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-on-surface-variant">
              visibility
            </span>
            <h2 className="font-headline text-lg text-on-surface">
              Live Preview
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {completionEvent?.data?.previewUrl ? (
              <button
                onClick={() =>
                  window.open(completionEvent.data?.previewUrl, "_blank")
                }
                className="px-4 py-2 bg-primary text-white rounded-lg hover:opacity-90 text-sm font-bold"
              >
                Open Preview →
              </button>
            ) : (
              <span className="text-xs text-on-surface-variant">
                Waiting for the preview build...
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 p-8 overflow-y-auto flex items-center justify-center">
          {completionEvent?.data?.previewUrl ? (
            <iframe
              src={completionEvent.data?.previewUrl || ""}
              title="Live Preview"
              className="w-full h-full rounded-lg border border-outline-variant"
            />
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
        completionEvent?.data?.metrics &&
        (() => {
          const { summary, pages } = completionEvent.data.metrics;
          const visualAccuracy = summary.visual.avgAccuracy;
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
                          {summary.visual.avgAccuracy.toFixed(1)}
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
                            width: `${summary.visual.avgAccuracy}%`,
                          }}
                        />
                      </div>
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-500">
                          {summary.visual.passed} passed
                        </span>
                        <span className="text-error">
                          {summary.visual.failed} failed
                        </span>
                        <span className="text-on-surface-variant">
                          {summary.visual.totalCompared} total
                        </span>
                      </div>
                    </div>

                    {/* Content */}
                    <div className="p-4 rounded-2xl border border-outline-variant/30 bg-surface-container-low">
                      <p className="text-xs font-medium text-on-surface-variant mb-2 uppercase tracking-wider">
                        Content
                      </p>
                      <div className="flex items-end gap-2 mb-2">
                        <p className="text-3xl font-headline font-bold text-on-surface">
                          {summary.content.passRate.toFixed(1)}
                          <span className="text-base">%</span>
                        </p>
                        <p className="text-xs text-on-surface-variant mb-1">
                          pass rate
                        </p>
                      </div>
                      <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden mb-2">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${summary.content.passRate}%` }}
                        />
                      </div>
                      <div className="flex gap-3 text-xs">
                        <span className="text-green-500">
                          {summary.content.passed} passed
                        </span>
                        <span className="text-yellow-500">
                          {summary.content.missing} missing
                        </span>
                        <span className="text-on-surface-variant">
                          {summary.content.total} total
                        </span>
                      </div>
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
