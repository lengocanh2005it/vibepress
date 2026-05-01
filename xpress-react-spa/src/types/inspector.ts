import type {
  CaptureNormalizedRect,
  CaptureViewport,
  DocumentCaptureRect,
  ViewportCaptureRect,
} from "./capture";

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

export interface ComponentInfo {
  component: string;
  tag: string;
  text: string;
  classes: string[];
  rect: {
    w: number;
    h: number;
  };
  viewport?: CaptureViewport;
  document?: {
    width: number;
    height: number;
  };
  viewportRect?: ViewportCaptureRect;
  documentRect?: DocumentCaptureRect;
  normalizedRect?: CaptureNormalizedRect;
  source?: SourceLocation;
  // Child node targeting — describes the specific element clicked
  targetNodeRole?: string;
  targetElementTag?: string;
  targetTextPreview?: string;
  targetStartLine?: number;
}

export interface InspectorMessage {
  type: "INSPECTOR_DATA";
  payload: ComponentInfo;
}
