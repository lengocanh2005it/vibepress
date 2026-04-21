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
  source?: SourceLocation;
  // Section identity — from data-vp-* on nearest ancestor with data-vp-source-node
  vpSourceNode?: string;
  vpTemplate?: string;
  vpSourceFile?: string;
  vpSectionKey?: string;
  vpComponent?: string;
  vpSectionComponent?: string;
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
