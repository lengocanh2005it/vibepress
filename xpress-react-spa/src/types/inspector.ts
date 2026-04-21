export interface SourceLocation {
  file: string;    // e.g. "src/components/Hero.tsx"
  line: number;    // line number
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
}

export interface InspectorMessage {
  type: "INSPECTOR_DATA";
  payload: ComponentInfo;
}
