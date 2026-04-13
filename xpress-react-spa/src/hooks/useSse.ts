import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Pipeline step status
 */
export type PipelineStepStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "skipped"
  | "stopped";

/**
 * SSE event từ server
 */
export interface PipelineProgressEvent {
  step: string; // internal step name (e.g. "1_repo_analyzer")
  label: string; // tên tiếng Việt (e.g. "Phân tích cấu trúc repo")
  status: PipelineStepStatus; // pending, running, done, error
  percent: number; // 0–100
  message?: string; // log message tuỳ chọn
  data?: ProgressEventData;
}

interface MetricPageVisual {
  accuracy: number;
  diffPct: number;
  status: string;
  artifacts: {
    imageA: string;
    imageB: string;
    diff: string;
  };
  error: string | null;
}

interface MetricPageContent {
  status: string;
  scores: {
    title: number;
    content: number;
    overall: number;
  };
  issues: string[];
  wp: { title: string; contentPreview: string };
  react: { title: string; contentPreview: string } | null;
}

export interface MetricPage {
  url: string | null;
  slug: string;
  type: string;
  visual: MetricPageVisual | null;
  content: MetricPageContent | null;
}

export interface MetricsSummary {
  visual: {
    totalCompared: number;
    passed: number;
    failed: number;
    passRate: number;
    avgAccuracy: number;
  } | null;
  content: {
    total: number;
    passed: number;
    failed: number;
    missing: number;
    passRate: number;
    avgOverall: number;
  } | null;
  overall: {
    visualAvgAccuracy: number | null;
    contentAvgOverall: number | null;
    visualPassRate: number | null;
    contentPassRate: number | null;
  };
  errors: {
    visual: string | null;
    content: string | null;
  };
}

interface ProgressEventData {
  previewUrl?: string;
  apiBaseUrl?: string;
  previewStage?: "baseline" | "edited" | "final";
  hasEditRequest?: boolean;
  metrics?: {
    summary: MetricsSummary;
    pages: MetricPage[];
  };
}

/**
 * Hook state
 */
export interface UseSseState {
  isConnected: boolean;
  isLoading: boolean;
  error: Error | null;
  currentEvent: PipelineProgressEvent | null;
  allEvents: PipelineProgressEvent[];
  progress: number;
  connectionState:
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "completed"
    | "error";
}

type PipelineJobStatus =
  | "running"
  | "stopping"
  | "stopped"
  | "done"
  | "error"
  | "deleted";

interface PipelineStatusResponse {
  jobId: string;
  status: PipelineJobStatus;
  error?: string;
  result?: {
    previewUrl?: string;
    apiBaseUrl?: string;
    previewStage?: ProgressEventData["previewStage"];
    hasEditRequest?: boolean;
    metrics?: ProgressEventData["metrics"];
  };
}

/**
 * Hook để subscribe vào SSE stream từ orchestrator backend
 * @param jobId - Job ID của pipeline
 * @param apiUrl - Base URL của API (default: /ai-api — nginx proxy tới ai_pipeline:3001)
 * @returns State và reconnect function
 */
export function useSse(
  jobId: string,
  apiUrl: string = "/ai-api",
) {
  const [state, setState] = useState<UseSseState>({
    isConnected: false,
    isLoading: true,
    error: null,
    currentEvent: null,
    allEvents: [],
    progress: 0,
    connectionState: "idle",
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const pipelineCompletedRef = useRef(false);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const disposedRef = useRef(false);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const fetchPipelineStatus = useCallback(async () => {
    const response = await fetch(`${apiUrl}/pipeline/status/${jobId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch pipeline status (${response.status})`);
    }
    return (await response.json()) as PipelineStatusResponse;
  }, [apiUrl, jobId]);

  const pushSyntheticCompletionEvent = useCallback(
    (status: PipelineStatusResponse) => {
      if (!status.result?.previewUrl) return;

      pipelineCompletedRef.current = true;

      const completionEvent: PipelineProgressEvent = {
        step: "11_done",
        label: "Preview Ready",
        status: "done",
        percent: 100,
        message: "Migration workflow is complete. Preview is ready.",
        data: {
          previewUrl: status.result.previewUrl,
          apiBaseUrl: status.result.apiBaseUrl,
          previewStage: status.result.previewStage ?? "final",
          hasEditRequest: status.result.hasEditRequest,
          metrics: status.result.metrics,
        },
      };

      setState((prev) => {
        const alreadyHasCompletion = prev.allEvents.some(
          (event) =>
            event.step === "11_done" &&
            event.status === "done" &&
            event.data?.previewUrl === status.result?.previewUrl,
        );

        return {
          ...prev,
          isConnected: false,
          isLoading: false,
          error: null,
          currentEvent: completionEvent,
          allEvents: alreadyHasCompletion
            ? prev.allEvents
            : [...prev.allEvents, completionEvent],
          progress: 100,
          connectionState: "completed",
        };
      });
    },
    [],
  );

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current) return;
    clearReconnectTimeout();

    const attempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = attempt;
    const delayMs = Math.min(1000 * attempt, 5000);

    setState((prev) => ({
      ...prev,
      isConnected: false,
      isLoading: true,
      error: null,
      connectionState:
        prev.allEvents.length > 0 || reconnectAttemptsRef.current > 0
          ? "reconnecting"
          : "connecting",
    }));

    reconnectTimeoutRef.current = window.setTimeout(() => {
      if (disposedRef.current) return;
      connect();
    }, delayMs);
  }, [clearReconnectTimeout]);

  /**
   * Connect đến SSE endpoint
   */
  const connect = useCallback(() => {
    if (!jobId) {
      setState((prev) => ({
        ...prev,
        error: new Error("jobId is required"),
        isLoading: false,
        connectionState: "error",
      }));
      return;
    }

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    clearReconnectTimeout();

    const url = `${apiUrl}/pipeline/progress/${jobId}`;

    try {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        connectionState:
          prev.allEvents.length > 0 || reconnectAttemptsRef.current > 0
            ? "reconnecting"
            : "connecting",
      }));

      const eventSource = new EventSource(url);

      eventSource.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setState((prev) => ({
          ...prev,
          isConnected: true,
          isLoading: false,
          error: null,
          connectionState: "connected",
        }));
      };

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          // ServerSentEvent data là JSON string
          const data = JSON.parse(event.data) as PipelineProgressEvent;
          console.log(data);
          if (data.step === "11_done" && data.status === "done") {
            pipelineCompletedRef.current = true;
          }
          setState((prev) => ({
            ...prev,
            currentEvent: data,
            allEvents: [...prev.allEvents, data],
            progress: data.percent,
          }));

          // Don't auto-close - let component unmount handle cleanup
        } catch (err) {
          console.error("Failed to parse SSE message:", err);
        }
      };

      eventSource.onerror = () => {
        const handleStreamError = async () => {
          eventSource.close();
          if (eventSourceRef.current === eventSource) {
            eventSourceRef.current = null;
          }

          if (pipelineCompletedRef.current) {
            setState((prev) => ({
              ...prev,
              isConnected: false,
              isLoading: false,
              error: null,
              connectionState: "completed",
            }));
            return;
          }

          try {
            const status = await fetchPipelineStatus();

            if (status.status === "done") {
              pushSyntheticCompletionEvent(status);
              return;
            }

            if (status.status === "running" || status.status === "stopping") {
              scheduleReconnect();
              return;
            }

            setState((prev) => ({
              ...prev,
              error: new Error(
                status.error ||
                  `Pipeline stream stopped while job is ${status.status}.`,
              ),
              isConnected: false,
              isLoading: false,
              connectionState: "error",
            }));
          } catch {
            scheduleReconnect();
          }
        };

        void handleStreamError();
      };

      eventSourceRef.current = eventSource;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err : new Error(String(err)),
        isLoading: false,
        connectionState: "error",
      }));
    }
  }, [
    apiUrl,
    clearReconnectTimeout,
    fetchPipelineStatus,
    jobId,
    pushSyntheticCompletionEvent,
    scheduleReconnect,
  ]);

  /**
   * Disconnect từ SSE
   */
  const disconnect = useCallback(() => {
    clearReconnectTimeout();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      isConnected: false,
      isLoading: false,
      connectionState:
        prev.connectionState === "completed" ? "completed" : "idle",
    }));
  }, [clearReconnectTimeout]);

  /**
   * Auto-connect khi jobId thay đổi
   */
  useEffect(() => {
    disposedRef.current = false;
    if (jobId) {
      connect();
    }

    return () => {
      disposedRef.current = true;
      disconnect();
    };
  }, [connect, disconnect, jobId]);

  return {
    ...state,
    connect,
    disconnect,
  };
}
