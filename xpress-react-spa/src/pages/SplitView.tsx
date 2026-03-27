import React, { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { PipelineProgressEvent } from "../hooks/useSse";
import { useSse } from "../hooks/useSse";

const SplitView: React.FC = () => {
  const navigate = useNavigate();
  const location=useLocation();
  const jobId=location.state?.jobId || "";
  const sse = useSse(jobId || "");
  const [showMetrics, setShowMetrics] = useState(false);

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
              className={`w-2 h-2 rounded-full ${sse.isConnected ? "bg-green-800 animate-pulse" : "bg-red-500"}`}
            />
            <h2 className="font-headline text-lg tracking-tight">
              AI Agent Console
            </h2>
          </div>
          <div className="flex gap-2">
            <span className="text-xs font-mono opacity-50 px-2 py-1 bg-white/5 rounded">
              Job: {jobId.slice(0, 8)}...
            </span>
            <span
              className={`text-xs font-mono px-2 py-1 rounded ${sse.isConnected ? "bg-green-500/20 text-green-600" : "bg-red-500/20 text-red-400"}`}
            >
              {sse.isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 font-mono text-sm space-y-4">
          {sse.isLoading && (
            <p className="text-black/40">Connecting to pipeline...</p>
          )}
          {sse.error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-xs">
              Error: {sse.error.message}
            </div>
          )}

          {sse.allEvents.length === 0 && !sse.isLoading ? (
            <p className="text-black/50">Waiting for pipeline events...</p>
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
              <div className="font-bold mb-2">✅ Pipeline Complete!</div>
              <p className="text-green-400/80">
                Preview URL: {completionEvent.data?.previewUrl}
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
              {sse.isConnected ? "Connected" : "Disconnected"}
            </span>
            <span className="flex items-center gap-1">
              {sse.progress}% Progress
            </span>
          </div>
          <div className="text-xs text-primary font-bold">
            {sse.currentEvent?.status === "done"
              ? "PIPELINE COMPLETE"
              : "PIPELINE ACTIVE"}
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
                Waiting for preview...
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
              <p className="text-on-surface-variant">Generating preview...</p>
              <p className="text-xs text-on-surface-variant/50">
                {sse.progress > 0
                  ? `${sse.progress}% complete`
                  : "Initializing..."}
              </p>
            </div>
          )}
        </div>
      </section>

      {showMetrics && completionEvent?.data?.metrics && (() => {
        const m = completionEvent.data.metrics;
        const matchPct = Math.max(0, 100 - m.diffPercentage);
        const scoreColor =
          matchPct >= 95 ? "text-primary" :
          matchPct >= 80 ? "text-[#705c30]" :
          "text-error";
        const scoreBg =
          matchPct >= 95 ? "bg-primary/10 border-primary/30" :
          matchPct >= 80 ? "bg-[#705c30]/10 border-[#705c30]/30" :
          "bg-error/10 border-error/30";
        const scoreLabel =
          matchPct >= 95 ? "Excellent" :
          matchPct >= 80 ? "Good" :
          "Needs work";

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
                    <span className="material-symbols-outlined text-primary text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                      compare
                    </span>
                  </div>
                  <div>
                    <h2 className="font-headline text-base font-bold text-on-surface leading-tight">Visual Diff Report</h2>
                    <p className="text-xs text-on-surface-variant">Pixel-level comparison between original & generated</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowMetrics(false)}
                  className="p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors"
                >
                  <span className="material-symbols-outlined text-xl">close</span>
                </button>
              </div>

              <div className="p-6 space-y-5">
                {/* Score + Stats row */}
                <div className="grid grid-cols-4 gap-3">
                  {/* Match Score — large */}
                  <div className={`col-span-1 flex flex-col items-center justify-center p-4 rounded-2xl border ${scoreBg}`}>
                    <p className={`text-4xl font-headline font-bold ${scoreColor}`}>
                      {matchPct.toFixed(1)}<span className="text-lg">%</span>
                    </p>
                    <p className={`text-xs font-bold mt-1 ${scoreColor}`}>{scoreLabel}</p>
                    <p className="text-[10px] text-on-surface-variant mt-0.5">Match Score</p>
                  </div>

                  {/* Diff % */}
                  <div className="flex flex-col justify-between p-4 bg-surface-container-low rounded-2xl border border-outline-variant/30">
                    <span className="material-symbols-outlined text-on-surface-variant text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>
                      difference
                    </span>
                    <div>
                      <p className="text-2xl font-headline font-bold text-on-surface">{m.diffPercentage.toFixed(2)}<span className="text-sm font-normal">%</span></p>
                      <p className="text-xs text-on-surface-variant mt-0.5">Pixel Diff</p>
                    </div>
                  </div>

                  {/* Different pixels */}
                  <div className="flex flex-col justify-between p-4 bg-surface-container-low rounded-2xl border border-outline-variant/30">
                    <span className="material-symbols-outlined text-on-surface-variant text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>
                      grid_view
                    </span>
                    <div>
                      <p className="text-2xl font-headline font-bold text-on-surface">{(m.differentPixels / 1000).toFixed(1)}<span className="text-sm font-normal">K</span></p>
                      <p className="text-xs text-on-surface-variant mt-0.5">Changed Pixels</p>
                    </div>
                  </div>

                  {/* Total pixels */}
                  <div className="flex flex-col justify-between p-4 bg-surface-container-low rounded-2xl border border-outline-variant/30">
                    <span className="material-symbols-outlined text-on-surface-variant text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>
                      photo_size_select_large
                    </span>
                    <div>
                      <p className="text-2xl font-headline font-bold text-on-surface">{(m.totalPixels / 1000000).toFixed(2)}<span className="text-sm font-normal">M</span></p>
                      <p className="text-xs text-on-surface-variant mt-0.5">Total Pixels</p>
                    </div>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="bg-surface-container-low rounded-xl p-3 border border-outline-variant/30">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-on-surface-variant">Pixel match</span>
                    <span className={`text-xs font-bold ${scoreColor}`}>{matchPct.toFixed(2)}%</span>
                  </div>
                  <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${matchPct >= 95 ? "bg-primary" : matchPct >= 80 ? "bg-[#705c30]" : "bg-error"}`}
                      style={{ width: `${matchPct}%` }}
                    />
                  </div>
                </div>

                {/* URLs */}
                <div className="bg-surface-container-low rounded-xl border border-outline-variant/30 overflow-hidden">
                  {[
                    { label: "Original", icon: "language", url: m.urlA },
                    { label: "Generated", icon: "code", url: m.urlB },
                  ].map(({ label, icon, url }, i) => (
                    <div key={label} className={`flex items-center gap-3 px-4 py-3 ${i === 0 ? "border-b border-outline-variant/30" : ""}`}>
                      <span className="material-symbols-outlined text-on-surface-variant text-base">{icon}</span>
                      <span className="text-xs font-medium text-on-surface-variant w-16 shrink-0">{label}</span>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline truncate"
                      >
                        {url}
                      </a>
                    </div>
                  ))}
                </div>

                {/* Screenshot comparison */}
                <div>
                  <p className="text-xs font-medium text-on-surface-variant mb-3 uppercase tracking-wider">Screenshot Comparison</p>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "Original (A)", icon: "language", src: m.artifacts.imageA, accent: "border-outline-variant/50" },
                      { label: "Generated (B)", icon: "code", src: m.artifacts.imageB, accent: "border-primary/40" },
                      { label: "Pixel Diff", icon: "difference", src: m.artifacts.diff, accent: "border-error/30" },
                    ].map(({ label, icon, src, accent }) => (
                      <div
                        key={label}
                        className={`group rounded-xl border ${accent} overflow-hidden bg-surface-container-low cursor-pointer hover:shadow-md transition-shadow`}
                        onClick={() => window.open(src, "_blank")}
                      >
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/20">
                          <span className="material-symbols-outlined text-on-surface-variant text-sm">{icon}</span>
                          <span className="text-xs font-medium text-on-surface-variant">{label}</span>
                          <span className="material-symbols-outlined text-on-surface-variant/40 text-sm ml-auto group-hover:text-on-surface-variant transition-colors">open_in_new</span>
                        </div>
                        <img
                          src={src}
                          alt={label}
                          className="w-full aspect-video object-cover object-top group-hover:opacity-90 transition-opacity"
                        />
                      </div>
                    ))}
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

