import type { SiteCompareMetrics } from '../site-compare.types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function looksLikeSiteCompareMetrics(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.pages) ||
    typeof value.diffPercentage === 'number' ||
    typeof value.differentPixels === 'number' ||
    typeof value.totalPixels === 'number' ||
    typeof value.summary === 'object'
  );
}

export function normalizeOpenClawCompareResult(
  payload: unknown,
): SiteCompareMetrics | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  if (looksLikeSiteCompareMetrics(root)) return root as SiteCompareMetrics;

  const candidates = [root.result, root.data, root.output, root.metrics];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (record && looksLikeSiteCompareMetrics(record)) {
      return record as SiteCompareMetrics;
    }
  }

  return undefined;
}
