export interface RuntimeSourceRef {
  sourceNodeId?: string;
  sourceFile?: string;
}

export interface RuntimeBlockNode {
  kind: string;
  blockName: string;
  sourceRef?: RuntimeSourceRef;
  attrs?: Record<string, unknown>;
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

export interface RuntimeSectionPlan {
  type: string;
  debugKey?: string;
  sectionKey?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  imageSrc?: string;
  imageAlt?: string;
  columns?: number;
  showTitle?: boolean;
  cards?: RuntimeSectionItem[];
  items?: RuntimeSectionItem[];
  slides?: RuntimeSectionItem[];
  tabs?: RuntimeSectionItem[];
  listItems?: string[];
  customClassNames?: string[];
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
  sectionDebugKey?: string;
}

export interface RuntimePagePlan {
  version: 1;
  mode: 'block-centric' | 'hybrid' | 'page-content';
  fidelity: 'strict-structure' | 'best-effort';
  layoutFamily?: string;
  source: RuntimePageSource;
  support: RuntimePageSupport;
  dataNeeds: string[];
  sections: RuntimeSectionPlan[];
  blockTree: RuntimeBlockNode[];
  subtreeBindings?: RuntimePageSubtreeBinding[];
}

export interface RuntimePageResponse {
  page: RuntimePageRecord;
  runtimePlan: RuntimePagePlan;
}
