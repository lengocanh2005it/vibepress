export interface SiteCompareMetrics {
  urlA?: string;
  urlB?: string;
  diffPercentage?: number;
  differentPixels?: number;
  totalPixels?: number;
  summary?: {
    overall?: {
      visualAvgAccuracy?: number;
      visualPassRate?: number;
      contentAvgOverall?: number;
      diffPercentage?: number;
      differentPixels?: number;
      totalPixels?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  artifacts?: {
    imageA?: string;
    imageB?: string;
    diff?: string;
    [key: string]: unknown;
  };
  pages?: unknown[];
  [key: string]: unknown;
}

export interface SiteCompareInput {
  siteId: string;
  wpBaseUrl: string;
  reactFeUrl: string;
  reactBeUrl: string;
  jobId?: string;
  mode?: 'baseline' | 'edited';
  routeEntries?: unknown[];
}

export interface SiteCompareExecutionResult {
  provider: 'automation';
  metrics?: SiteCompareMetrics;
  warnings?: string[];
}
