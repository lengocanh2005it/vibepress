export interface RuntimeSourceRef {
  sourceNodeId?: string;
  sourceFile?: string;
}

export interface RuntimeBoxSpacingSpec {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface RuntimeSpacingSpec {
  margin?: RuntimeBoxSpacingSpec;
  padding?: RuntimeBoxSpacingSpec;
  blockGap?: string | { x?: string; y?: string };
}

export interface RuntimeColorSpec {
  text?: string;
  background?: string;
  overlay?: string;
}

export interface RuntimeTypographySpec {
  fontSize?: string;
  lineHeight?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  textAlign?: string;
}

export interface RuntimeDimensionsSpec {
  minHeight?: string;
  width?: string;
}

export interface RuntimeLayoutSpec {
  kind?: string;
  align?: string;
  columnWidth?: string;
  justifyContent?: string;
  alignItems?: string;
  orientation?: string;
  columns?: number;
}

export interface RuntimeStyleSpec {
  classNames?: string[];
  colors?: RuntimeColorSpec;
  spacing?: RuntimeSpacingSpec;
  typography?: RuntimeTypographySpec;
  dimensions?: RuntimeDimensionsSpec;
  borderRadius?: string;
  gap?: string;
}

export interface RuntimeWrapperSpec {
  tagName?: string;
  domId?: string;
  preserveWrapper?: boolean;
}

export interface RuntimeImageRef {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface RuntimeSectionItem {
  heading?: string;
  title?: string;
  label?: string;
  body?: string;
  text?: string;
  imageSrc?: string;
  imageAlt?: string;
  href?: string;
  [key: string]: unknown;
}

export interface RuntimeBlockNode {
  nodeId?: string;
  kind: string;
  blockName: string;
  sourceRef?: RuntimeSourceRef;
  attrs?: Record<string, unknown>;
  wrapper?: RuntimeWrapperSpec;
  style?: RuntimeStyleSpec;
  layout?: RuntimeLayoutSpec;
  customClassNames?: string[];
  domId?: string;
  text?: string;
  level?: number;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  href?: string;
  html?: string;
  bgColor?: string;
  textColor?: string;
  borderRadius?: string;
  gap?: string;
  padding?: Record<string, string>;
  margin?: Record<string, string>;
  minHeight?: string;
  overlayColor?: string;
  hasParallax?: boolean;
  focalPoint?: { x: number; y: number };
  columnWidth?: string;
  textAlign?: string;
  justifyContent?: string;
  align?: string;
  menuOrientation?: string;
  overlayMenu?: string;
  isResponsive?: boolean;
  fontFamily?: string;
  typography?: Record<string, string>;
  templatePartSlug?: string;
  patternSlug?: string;
  refName?: string;
  tagName?: string;
  children?: RuntimeBlockNode[];
}

export interface RuntimePageRecord {
  id: number;
  title: string;
  content: string;
  slug: string;
  parentId: number;
  menuOrder: number;
  template: string;
  featuredImage: string | null;
  status?: string;
  excerpt?: string;
}

export interface RuntimePageSource {
  kind: 'page-post-content' | 'template' | 'template-chain';
  template: string;
  slug: string;
  sourceSummary?: string;
}

export interface RuntimePageSupport {
  safeForRuntime: boolean;
  unsupportedBlocks: string[];
}

export interface RuntimeSectionPlan {
  id?: string;
  type: string;
  debugKey?: string;
  sectionKey?: string;
  sourceNodeId?: string;
  blockName?: string;
  sourceRef?: RuntimeSourceRef;
  title?: string;
  subtitle?: string;
  body?: string;
  image?: RuntimeImageRef;
  imageSrc?: string;
  imageAlt?: string;
  columns?: number;
  showTitle?: boolean;
  cards?: RuntimeSectionItem[];
  items?: RuntimeSectionItem[];
  slides?: RuntimeSectionItem[];
  tabs?: RuntimeSectionItem[];
  listItems?: string[];
  layout?: RuntimeLayoutSpec;
  style?: RuntimeStyleSpec;
  children?: RuntimeSectionPlan[];
  customClassNames?: string[];
  hasParallax?: boolean;
  focalPoint?: { x: number; y: number };
  [key: string]: unknown;
}

export type RuntimePageSection = RuntimeSectionPlan;

export interface RuntimePageSubtreeBinding {
  nodeId: string;
  blockName: string;
  renderer: string;
  preserveWrapper: boolean;
  preserveChildrenOrder: boolean;
  childCount?: number;
  sectionId?: string;
  sectionDebugKey?: string;
}

export interface RuntimePagePatch {
  target: {
    sourceNodeId?: string;
    sectionId?: string;
  };
  op:
    | 'replace-text'
    | 'replace-image'
    | 'update-style'
    | 'hide-node'
    | 'show-node'
    | 'reorder-within-parent';
  value: Record<string, unknown>;
}

export interface RuntimePageOverrideSet {
  pageSlug: string;
  patches: RuntimePagePatch[];
}

export interface RuntimePagePlan {
  version: 1 | 2;
  mode: 'block-centric' | 'hybrid' | 'page-content';
  fidelity: 'strict-structure' | 'best-effort';
  layoutFamily?: string;
  source: RuntimePageSource;
  support: RuntimePageSupport;
  dataNeeds: string[];
  sections: RuntimeSectionPlan[];
  blockTree: RuntimeBlockNode[];
  subtreeBindings?: RuntimePageSubtreeBinding[];
  overrides?: RuntimePageOverrideSet;
}

export interface RuntimePageResponse {
  page: RuntimePageRecord;
  runtimePlan: RuntimePagePlan;
}
