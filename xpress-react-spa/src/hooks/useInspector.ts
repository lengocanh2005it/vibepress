import { useEffect, useRef, useState, useCallback } from "react";
import type { ComponentInfo, InspectorMessage } from "../types/inspector";

interface UseInspectorReturn {
  iframeRef: React.RefObject<HTMLIFrameElement>;
  isActive: boolean;
  selectedComponent: ComponentInfo | null;
  toggle: () => void;
  clear: () => void;
}

export function useInspector(): UseInspectorReturn {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isActive, setIsActive] = useState(false);
  const [selectedComponent, setSelectedComponent] = useState<ComponentInfo | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent<InspectorMessage>) => {
      if (e.data?.type === "INSPECTOR_DATA") {
        setSelectedComponent(e.data.payload);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const sendToIframe = useCallback((type: "INSPECTOR_ENABLE" | "INSPECTOR_DISABLE") => {
    iframeRef.current?.contentWindow?.postMessage({ type }, "*");
  }, []);

  const toggle = useCallback(() => {
    setIsActive((prev) => {
      const next = !prev;
      sendToIframe(next ? "INSPECTOR_ENABLE" : "INSPECTOR_DISABLE");
      return next;
    });
  }, [sendToIframe]);

  const clear = useCallback(() => {
    setSelectedComponent(null);
  }, []);

  return { iframeRef, isActive, selectedComponent, toggle, clear };
}
