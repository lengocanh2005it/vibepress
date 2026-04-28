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
  // Section identity — minimal DOM markers; detailed metadata resolves via ui-source-map
  vpSourceNode?: string;
  vpSectionKey?: string;
  vpComponent?: string;
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
