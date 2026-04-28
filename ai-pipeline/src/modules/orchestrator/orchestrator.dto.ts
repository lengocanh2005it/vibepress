export interface PipelineViewportDto {
  width: number;
  height: number;
  scrollX?: number;
  scrollY?: number;
  dpr?: number;
}

export interface PipelineCaptureBBoxDto {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: 'iframe-viewport' | 'iframe-document';
}

export interface PipelineCaptureNormalizedBBoxDto {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace?: 'iframe-document-normalized';
}

export interface PipelineDocumentDimensionsDto {
  width: number;
  height: number;
}

export interface PipelineCaptureAssetDto {
  provider: 'local' | 'cloudinary' | 'imagekit';
  fileName: string;
  publicUrl: string;
  storagePath?: string;
  originalPath?: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes?: number;
  width?: number;
  height?: number;
  createdAt?: string;
  providerAssetId?: string;
  providerAssetPath?: string;
  format?: string;
}

export interface PipelineDomTargetDto {
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

export interface PipelineCaptureGeometryDto {
  viewportRect?: PipelineCaptureBBoxDto;
  documentRect?: PipelineCaptureBBoxDto;
  normalizedRect?: PipelineCaptureNormalizedBBoxDto;
}

export interface PipelineCapturePageContextDto {
  url?: string;
  route?: string | null;
  title?: string;
}

export interface PipelineCaptureTargetNodeDto {
  nodeId?: string;
  sourceNodeId?: string;
  sourceFile?: string;
  topLevelIndex?: number;
  templateName?: string;
  ownerNodeId?: string;
  ownerSourceNodeId?: string;
  ownerSourceFile?: string;
  ownerTopLevelIndex?: number;
  ownerTemplateName?: string;
  editNodeId?: string;
  editSourceNodeId?: string;
  editSourceFile?: string;
  editTopLevelIndex?: number;
  editTemplateName?: string;
  editNodeRole?: string;
  editTagName?: string;
  ancestorSourceNodeIds?: string[];
  route?: string | null;
  blockName?: string;
  blockClientId?: string;
  tagName?: string;
  domPath?: string;
  nearestHeading?: string;
  nearestLandmark?: string;
}

export interface PipelineClientEditPageContextDto {
  reactUrl?: string;
  reactRoute?: string;
  wordpressUrl?: string;
  wordpressRoute?: string | null;
  iframeSrc?: string;
  pageTitle?: string;
  viewport?: PipelineViewportDto;
  document?: PipelineDocumentDimensionsDto;
}

export interface PipelineClientAttachmentCaptureContextDto {
  capturedAt?: string;
  iframeSrc?: string;
  viewport?: PipelineViewportDto;
  page?: Pick<PipelineCapturePageContextDto, 'url' | 'route' | 'title'>;
  document?: PipelineDocumentDimensionsDto;
}

export interface PipelineClientCaptureAssetDto {
  provider: 'local' | 'cloudinary' | 'imagekit';
  fileName: string;
  publicUrl: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
}

export interface PipelineClientCaptureAttachmentDto {
  id: string;
  note?: string;
  sourcePageUrl?: string;
  captureContext?: PipelineClientAttachmentCaptureContextDto;
  selection?: PipelineCaptureBBoxDto;
  geometry?: PipelineCaptureGeometryDto;
  domTarget?: PipelineDomTargetDto;
  targetNode?: PipelineCaptureTargetNodeDto;
  asset: PipelineClientCaptureAssetDto;
}

export interface PipelineEditPageContextDto {
  reactUrl?: string;
  reactRoute?: string;
  wordpressUrl?: string;
  wordpressRoute?: string | null;
  iframeSrc?: string;
  pageTitle?: string;
  viewport?: PipelineViewportDto;
  document?: PipelineDocumentDimensionsDto;
}

export interface PipelineAttachmentCaptureContextDto {
  capturedAt?: string;
  iframeSrc?: string;
  viewport?: PipelineViewportDto;
  page?: PipelineCapturePageContextDto;
  document?: PipelineDocumentDimensionsDto;
}

export interface PipelineCaptureAttachmentDto {
  id: string;
  note?: string;
  sourcePageUrl?: string;
  asset: PipelineCaptureAssetDto;
  captureContext?: PipelineAttachmentCaptureContextDto;
  selection?: PipelineCaptureBBoxDto;
  geometry?: PipelineCaptureGeometryDto;
  domTarget?: PipelineDomTargetDto;
  targetNode?: PipelineCaptureTargetNodeDto;
}

export interface PipelineEditTargetHintDto {
  templateName?: string;
  componentName?: string;
  route?: string | null;
  sectionIndex?: number;
  sectionType?: string;
  sourceNodeId?: string;
  sectionKey?: string;
  sectionComponentName?: string;
  sourceFile?: string;
  outputFilePath?: string;
  startLine?: number;
  endLine?: number;
  targetNodeRole?: string;
  targetElementTag?: string;
  targetTextPreview?: string;
  targetStartLine?: number;
}

export interface PipelineEditConstraintsDto {
  preserveOutsideSelection?: boolean;
  preserveDataContract?: boolean;
  rerunFromScratch?: boolean;
}

export interface PipelinePreviewRouteEntryDto {
  route: string;
  componentName: string;
}

export interface PipelineClientEditRequestDto {
  prompt?: string;
  language?: string;
  pageContext?: PipelineClientEditPageContextDto;
  attachments?: PipelineClientCaptureAttachmentDto[];
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

export interface PipelineEditRequestDto {
  prompt: string;
  language?: string;
  pageContext?: PipelineEditPageContextDto;
  attachments?: PipelineCaptureAttachmentDto[];
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

export interface LegacyPipelineEditRequestDto {
  userPrompt?: string;
  language?: string;
  pageContext?: PipelineEditPageContextDto;
  capture?: {
    bbox?: PipelineCaptureBBoxDto;
    croppedScreenshot?: {
      url?: string;
      mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    };
    domTarget?: PipelineDomTargetDto;
    targetNode?: PipelineCaptureTargetNodeDto;
  };
  captures?: Array<{
    id: string;
    fileName?: string;
    filePath?: string;
    url?: string;
    comment?: string;
    pageUrl?: string;
    capturedAt?: string;
    iframeSrc?: string;
    viewport?: PipelineViewportDto;
    page?: PipelineCapturePageContextDto;
    document?: PipelineDocumentDimensionsDto;
    provider?: 'local' | 'cloudinary' | 'imagekit';
    bytes?: number;
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    width?: number;
    height?: number;
    createdAt?: string;
    publicId?: string;
    fileId?: string;
    providerFilePath?: string;
    originalPath?: string;
    format?: string;
    bbox?: PipelineCaptureBBoxDto;
    geometry?: PipelineCaptureGeometryDto;
    domTarget?: PipelineDomTargetDto;
    targetNode?: PipelineCaptureTargetNodeDto;
  }>;
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
}

export type PipelineIncomingEditRequestDto =
  | PipelineClientEditRequestDto
  | LegacyPipelineEditRequestDto;

export interface RunPipelineRequestDto {
  siteId: string;
  editRequest?: PipelineIncomingEditRequestDto;
}

export interface RunPipelineDto {
  themeGithubUrl: string;
  dbConnectionString: string;
  editRequest?: PipelineEditRequestDto;
}

export interface PipelineReactSourceTargetDto {
  previewDir?: string;
  frontendDir?: string;
  previewUrl?: string;
  apiBaseUrl?: string;
  uiSourceMapPath?: string;
  routeEntries?: PipelinePreviewRouteEntryDto[];
}

export interface PipelineReactVisualEditRequestDto {
  prompt?: string;
  language?: string;
  pageContext?: PipelineClientEditPageContextDto;
  attachments?: PipelineClientCaptureAttachmentDto[];
  targetHint?: PipelineEditTargetHintDto;
  constraints?: PipelineEditConstraintsDto;
  reactSourceTarget: PipelineReactSourceTargetDto;
}

export interface SubmitReactVisualEditDto {
  siteId: string;
  jobId: string;
  editRequest: PipelineReactVisualEditRequestDto;
}

export interface ApplyPendingEditRequestDto {
  siteId: string;
  jobId: string;
}

export interface SkipPendingEditRequestDto {
  siteId: string;
  jobId: string;
}

export interface UndoReactVisualEditDto {
  siteId: string;
  jobId: string;
}
