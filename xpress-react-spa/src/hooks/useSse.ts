import { useEffect, useState, useCallback, useRef } from "react";

/**
 * Pipeline step status
 */
export type PipelineStepStatus = "pending" | "running" | "done" | "error";

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
  };
  content: {
    total: number;
    passed: number;
    failed: number;
    missing: number;
    passRate: number;
    avgOverall: number;
  };
  overall: {
    visualAvgAccuracy: number;
    contentAvgOverall: number;
    visualPassRate: number;
    contentPassRate: number;
  };
  errors: {
    visual: string | null;
    content: string | null;
  };
}

interface ProgressEventData {
  previewUrl?: string;
  metrics: {
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
}

/**
 * Hook để subscribe vào SSE stream từ orchestrator backend
 * @param jobId - Job ID của pipeline
 * @param apiUrl - Base URL của API (default: http://localhost:3000)
 * @returns State và reconnect function
 */
export function useSse(
  jobId: string,
  apiUrl: string = "http://localhost:3001",
) {
  const [state, setState] = useState<UseSseState>({
    isConnected: false,
    isLoading: true,
    error: null,
    currentEvent: null,
    allEvents: [],
    progress: 0,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const pipelineCompletedRef = useRef(false);

  /**
   * Connect đến SSE endpoint
   */
  const connect = useCallback(() => {
    if (!jobId) {
      setState((prev) => ({
        ...prev,
        error: new Error("jobId is required"),
        isLoading: false,
      }));
      return;
    }

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    pipelineCompletedRef.current = false;

    const url = `${apiUrl}/pipeline/progress/${jobId}`;

    try {
      const eventSource = new EventSource(url);

      eventSource.onopen = () => {
        setState((prev) => ({
          ...prev,
          isConnected: true,
          isLoading: false,
          error: null,
        }));
      };

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          // ServerSentEvent data là JSON string
          const data = JSON.parse(event.data) as PipelineProgressEvent;
          console.log(data);
          if (data.status === "done" && data.data?.previewUrl) {
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
        eventSource.close();
        eventSourceRef.current = null;

        if (pipelineCompletedRef.current) {
          // Server closed the stream after pipeline finished — not a real error
          setState((prev) => ({
            ...prev,
            isConnected: false,
            isLoading: false,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            error: new Error("Không thể kết nối tới server. Kiểm tra pipeline đang chạy không."),
            isConnected: false,
            isLoading: false,
          }));
        }
      };

      eventSourceRef.current = eventSource;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err : new Error(String(err)),
        isLoading: false,
      }));
    }
  }, [jobId, apiUrl]);

  /**
   * Disconnect từ SSE
   */
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      isConnected: false,
    }));
  }, []);

  /**
   * Auto-connect khi jobId thay đổi
   */
  useEffect(() => {
    if (jobId) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [jobId]);

  return {
    ...state,
    connect,
    disconnect,
  };
}
