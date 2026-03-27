import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useSse } from "../hooks/useSse";
import type { PipelineProgressEvent } from "../hooks/useSse";

const SplitView: React.FC = () => {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const sse = useSse(jobId || "");

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
              <button
                onClick={() =>
                  window.open(completionEvent.data?.previewUrl, "_blank")
                }
                className="mt-2 px-3 py-1 bg-green-500/20 hover:bg-green-500/30 border border-green-500/50 rounded text-green-400 text-xs"
              >
                Open Preview
              </button>
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
    </div>
  );
};

export default SplitView;
