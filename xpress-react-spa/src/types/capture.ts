// -------------------------------------------------------
// Capture types — single source of truth
// Import from here in all files, do NOT re-define locally.
// -------------------------------------------------------

export interface CaptureViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export interface CaptureAssetResponse {
  provider: 'local' | 'cloudinary' | 'imagekit';
  fileName: string;
  originalPath: string;
  url: string;
  bytes: number;
  mimeType: string;
  width?: number;
  height?: number;
  publicId?: string;
  format?: string;
  createdAt?: string;
  fileId?: string;
  filePath?: string;
}

// Specific rect types with literal coordinateSpace for type safety
export interface ViewportCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'iframe-viewport';
}

export interface DocumentCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'iframe-document';
}

export interface CaptureNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: 'iframe-document-normalized';
}

export type CaptureSelection = DocumentCaptureRect;

export interface CaptureGeometry {
  viewportRect: ViewportCaptureRect;
  documentRect: DocumentCaptureRect;
  normalizedRect: CaptureNormalizedRect;
}

export interface CapturePage {
  route: string | null;
  title?: string;
  documentWidth: number;
  documentHeight: number;
}

export interface CaptureDomTarget {
  cssSelector?: string;
  xpath?: string;
  tagName?: string;
  elementId?: string;
  classNames?: string[];
  htmlSnippet?: string;
  textSnippet?: string;
  blockName?: string;
  blockClientId?: string;
  domPath?: string;
  role?: string;
  ariaLabel?: string;
  nearestHeading?: string;
  nearestLandmark?: string;
}

export interface CaptureTargetNode {
  nodeId?: string;
  templateName?: string;
  route?: string | null;
  blockName?: string;
  blockClientId?: string;
  tagName?: string;
  domPath?: string;
  nearestHeading?: string;
  nearestLandmark?: string;
}

export interface CaptureData {
  id: string;
  filePath: string;
  fileName?: string;
  asset?: CaptureAssetResponse;
  comment: string;
  pageUrl: string;
  iframeSrc?: string;
  capturedAt: string;
  viewport: CaptureViewport;
  page: CapturePage;
  selection: CaptureSelection;
  geometry: CaptureGeometry;
  domTarget?: CaptureDomTarget;
  targetNode?: CaptureTargetNode;
}

/** Alias for CaptureData — dùng trong Editor state */
export type Capture = CaptureData;
