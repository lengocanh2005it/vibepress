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
  previewUrl?: string; // chỉ có ở event "done" cuối cùng
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

          setState((prev) => ({
            ...prev,
            currentEvent: data,
            allEvents: [...prev.allEvents, data],
            progress: data.percent,
          }));

          // Auto-close khi pipeline done
          if (data.status === "done") {
            eventSource.close();
            setState((prev) => ({
              ...prev,
              isConnected: false,
            }));
            eventSourceRef.current = null;
          }
        } catch (err) {
          console.error("Failed to parse SSE message:", err);
        }
      };

      eventSource.onerror = (error) => {
        const errorMsg =
          error instanceof Event && error.type === "error"
            ? "SSE connection error"
            : String(error);

        setState((prev) => ({
          ...prev,
          error: new Error(errorMsg),
          isConnected: false,
          isLoading: false,
        }));

        eventSource.close();
        eventSourceRef.current = null;
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
