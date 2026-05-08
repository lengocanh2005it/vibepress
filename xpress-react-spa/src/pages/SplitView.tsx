import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AiProcessError,
  applyPendingEditRequest,
  runAiProcess,
  skipPendingEditRequest,
  skipVisualCompare,
  type AiEditRequestPayload,
} from "../services/AiService";
import type {
  PipelineMetricsPayload,
  PipelineProgressEvent,
} from "../hooks/useSse";
import { useSse } from "../hooks/useSse";

interface SplitViewLocationState {
  jobId?: string;
  siteId?: string;
  editRequest?: AiEditRequestPayload;
}

interface DeferredEditUiState {
  loading: boolean;
  applied: boolean;
  completed: boolean;
  dismissed: boolean;
  error: string | null;
  decision?: "apply" | "skip" | null;
  previewStage?: "baseline" | "edited" | "final";
  editApprovalRequired?: boolean;
  editApplied?: boolean;
}

interface VisualCompareSkipUiState {
  loading: boolean;
  requested: boolean;
  error: string | null;
}

interface CapturePreviewState {
  src: string;
  alt: string;
  note?: string;
  route?: string | null;
  pageTitle?: string;
  capturedAt?: string | null;
}

const SPLIT_VIEW_SESSION_KEY = "vp.splitView.lastRun";

type CompareMetricsView = {
  kind: "compare";
  summary: NonNullable<PipelineMetricsPayload["summary"]>;
  pages: NonNullable<PipelineMetricsPayload["pages"]>;
};

type AuditMetricItem = {
  key: string;
  label: string;
  value: string;
};

type AuditScoreItem = {
  key: string;
  label: string;
  value: number;
};

type AuditMetricsView = {
  kind: "audit";
  requestedUrl: string | null;
  finalUrl: string | null;
  fetchTime: string | null;
  formFactor: string | null;
  throttlingMethod: string | null;
  runs: number | null;
  scores: AuditScoreItem[];
  metrics: AuditMetricItem[];
  runScores: AuditScoreItem[][];
};

type RawMetricsView = {
  kind: "raw";
  pretty: string;
};

type MetricsViewModel = CompareMetricsView | AuditMetricsView | RawMetricsView;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const toTitleLabel = (key: string) => {
  const normalizedKey = key.trim();
  if (!normalizedKey) return "Unknown";

  const overrides: Record<string, string> = {
    seo: "SEO",
    url: "URL",
    firstContentfulPaint: "First Contentful Paint",
    largestContentfulPaint: "Largest Contentful Paint",
    totalBlockingTime: "Total Blocking Time",
    cumulativeLayoutShift: "Cumulative Layout Shift",
    speedIndex: "Speed Index",
    bestPractices: "Best Practices",
  };

  if (overrides[normalizedKey]) {
    return overrides[normalizedKey];
  }

  return normalizedKey
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const normalizeMetricsPayload = (
  payload: PipelineMetricsPayload | null | undefined,
): MetricsViewModel | null => {
  if (!payload || !isRecord(payload)) return null;

  if (payload.summary && Array.isArray(payload.pages)) {
    return {
      kind: "compare",
      summary: payload.summary,
      pages: payload.pages,
    };
  }

  const hasAuditShape =
    isRecord(payload.scores) ||
    isRecord(payload.metrics) ||
    Array.isArray(payload.runScores) ||
    typeof payload.runs === "number" ||
    typeof payload.requestedUrl === "string" ||
    typeof payload.finalUrl === "string";

  if (hasAuditShape) {
    const scoreEntries = isRecord(payload.scores)
      ? Object.entries(payload.scores)
          .map(([key, value]) => {
            const score = toFiniteNumber(value);
            return score === null
              ? null
              : {
                  key,
                  label: toTitleLabel(key),
                  value: score,
                };
          })
          .filter((entry): entry is AuditScoreItem => entry !== null)
      : [];

    const metricEntries = isRecord(payload.metrics)
      ? Object.entries(payload.metrics)
          .map(([key, value]) => {
            const textValue = toText(value);
            return textValue === null
              ? null
              : {
                  key,
                  label: toTitleLabel(key),
                  value: textValue,
                };
          })
          .filter((entry): entry is AuditMetricItem => entry !== null)
      : [];

    const runScores = Array.isArray(payload.runScores)
      ? payload.runScores.map((runScore) => {
          if (!isRecord(runScore)) return [];
          return Object.entries(runScore)
            .map(([key, value]) => {
              const score = toFiniteNumber(value);
              return score === null
                ? null
                : {
                    key,
                    label: toTitleLabel(key),
                    value: score,
                  };
            })
            .filter((entry): entry is AuditScoreItem => entry !== null);
        })
      : [];

    return {
      kind: "audit",
      requestedUrl: toText(payload.requestedUrl),
      finalUrl: toText(payload.finalUrl),
      fetchTime: toText(payload.fetchTime),
      formFactor: toText(payload.formFactor),
      throttlingMethod: toText(payload.throttlingMethod),
      runs: toFiniteNumber(payload.runs),
      scores: scoreEntries,
      metrics: metricEntries,
      runScores,
    };
  }

  return {
    kind: "raw",
    pretty: JSON.stringify(payload, null, 2),
  };
};

const CompareMetricsModal = ({
  view,
  onClose,
}: {
  view: CompareMetricsView;
  onClose: () => void;
}) => {
  const { summary, pages } = view;
  const hasContentSummary = summary.content !== null;
  const visualSummary = summary.visual ?? {
    totalCompared: 0,
    passed: 0,
    failed: 0,
    passRate: 0,
    avgAccuracy: 0,
  };
  const contentSummary = summary.content ?? {
    total: 0,
    passed: 0,
    failed: 0,
    missing: 0,
    passRate: 0,
    avgOverall: 0,
  };
  const visualAccuracy = visualSummary.avgAccuracy;
  const scoreColor =
    visualAccuracy >= 95
      ? "text-primary"
      : visualAccuracy >= 80
        ? "text-[#705c30]"
        : "text-error";
  const scoreBg =
    visualAccuracy >= 95
      ? "bg-primary/10 border-primary/30"
      : visualAccuracy >= 80
        ? "bg-[#705c30]/10 border-[#705c30]/30"
        : "bg-error/10 border-error/30";
  const scoreBarColor =
    visualAccuracy >= 95
      ? "bg-primary"
      : visualAccuracy >= 80
        ? "bg-[#705c30]"
        : "bg-error";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="relative max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-outline-variant/30 bg-surface px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <span
                className="material-symbols-outlined text-xl text-primary"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                analytics
              </span>
            </div>
            <div>
              <h2 className="font-headline text-base font-bold leading-tight text-on-surface">
                Migration Report
              </h2>
              <p className="text-xs text-on-surface-variant">
                Visual &amp; content comparison across {pages.length} pages
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <div className="space-y-5 p-6">
          <div className="grid grid-cols-2 gap-3">
            <div className={`rounded-2xl border p-4 ${scoreBg}`}>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Visual
              </p>
              <div className="mb-2 flex items-end gap-2">
                <p className={`font-headline text-3xl font-bold ${scoreColor}`}>
                  {visualSummary.avgAccuracy.toFixed(1)}
                  <span className="text-base">%</span>
                </p>
                <p className="mb-1 text-xs text-on-surface-variant">
                  avg accuracy
                </p>
              </div>
              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
                <div
                  className={`h-full rounded-full ${scoreBarColor}`}
                  style={{ width: `${visualSummary.avgAccuracy}%` }}
                />
              </div>
              <div className="flex gap-3 text-xs">
                <span className="text-green-500">
                  {visualSummary.passed} passed
                </span>
                <span className="text-error">{visualSummary.failed} failed</span>
                <span className="text-on-surface-variant">
                  {visualSummary.totalCompared} total
                </span>
              </div>
            </div>

            <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Content
              </p>
              {hasContentSummary ? (
                <>
                  <div className="mb-2 flex items-end gap-2">
                    <p className="font-headline text-3xl font-bold text-on-surface">
                      {contentSummary.passRate.toFixed(1)}
                      <span className="text-base">%</span>
                    </p>
                    <p className="mb-1 text-xs text-on-surface-variant">
                      pass rate
                    </p>
                  </div>
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${contentSummary.passRate}%` }}
                    />
                  </div>
                  <div className="flex gap-3 text-xs">
                    <span className="text-green-500">
                      {contentSummary.passed} passed
                    </span>
                    <span className="text-yellow-500">
                      {contentSummary.missing} missing
                    </span>
                    <span className="text-on-surface-variant">
                      {contentSummary.total} total
                    </span>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-outline-variant/50 bg-surface px-4 py-5">
                  <p className="text-sm font-semibold text-on-surface">
                    Khong co du lieu
                  </p>
                  <p className="mt-1 text-xs text-on-surface-variant">
                    Automation hien khong tra ve tong hop content cho lan so
                    sanh nay.
                  </p>
                </div>
              )}
              {summary.errors.content && (
                <p className="mt-3 text-[11px] text-amber-700">
                  Content metrics unavailable: {summary.errors.content}
                </p>
              )}
            </div>
          </div>

          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
              Pages
            </p>
            <div className="overflow-hidden rounded-xl border border-outline-variant/30">
              <div className="grid grid-cols-12 gap-2 border-b border-outline-variant/30 bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant">
                <span className="col-span-4">Page</span>
                <span className="col-span-2">Type</span>
                <span className="col-span-3">Visual accuracy</span>
                <span className="col-span-3">Content</span>
              </div>
              {pages.map((page, i) => {
                const acc = page.visual?.accuracy ?? null;
                const accColor =
                  acc === null
                    ? ""
                    : acc >= 95
                      ? "text-primary"
                      : acc >= 80
                        ? "text-[#705c30]"
                        : "text-error";
                const accBar =
                  acc === null
                    ? ""
                    : acc >= 95
                      ? "bg-primary"
                      : acc >= 80
                        ? "bg-[#705c30]"
                        : "bg-error";

                return (
                  <div
                    key={page.slug + i}
                    className={`grid grid-cols-12 gap-2 px-4 py-3 text-xs hover:bg-surface-container/50 ${i < pages.length - 1 ? "border-b border-outline-variant/20" : ""}`}
                  >
                    <div className="col-span-4 min-w-0 flex-col justify-center">
                      <p className="truncate font-medium text-on-surface">
                        {page.slug}
                      </p>
                      {page.url && (
                        <p className="truncate text-on-surface-variant/50">
                          {page.url.replace(/^https?:\/\/[^/]+/, "")}
                        </p>
                      )}
                    </div>
                    <div className="col-span-2 flex items-center">
                      <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] text-on-surface-variant">
                        {page.type}
                      </span>
                    </div>
                    <div className="col-span-3 flex flex-col justify-center gap-1">
                      {acc !== null ? (
                        <div className="flex items-center gap-1.5">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-container-high">
                            <div
                              className={`h-full rounded-full ${accBar}`}
                              style={{ width: `${acc}%` }}
                            />
                          </div>
                          <span
                            className={`shrink-0 font-mono text-[11px] ${accColor}`}
                          >
                            {acc.toFixed(1)}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-on-surface-variant/40">—</span>
                      )}
                    </div>
                    <div className="col-span-3 flex items-center">
                      {page.content ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            page.content.status === "PASS"
                              ? "bg-green-500/10 text-green-600"
                              : page.content.status === "MISSING"
                                ? "bg-yellow-500/10 text-yellow-600"
                                : "bg-error/10 text-error"
                          }`}
                        >
                          {page.content.status}
                          {page.content.status === "PASS" &&
                          page.content.scores.overall > 0
                            ? ` · ${page.content.scores.overall}%`
                            : ""}
                        </span>
                      ) : (
                        <span className="text-[10px] text-on-surface-variant/40">
                          —
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const AuditMetricsModal = ({
  view,
  onClose,
}: {
  view: AuditMetricsView;
  onClose: () => void;
}) => {
  const scoreColor = (value: number) =>
    value >= 90
      ? "text-primary"
      : value >= 70
        ? "text-[#705c30]"
        : "text-error";
  const scoreBar = (value: number) =>
    value >= 90
      ? "bg-primary"
      : value >= 70
        ? "bg-[#705c30]"
        : "bg-error";
  const fetchTimeLabel =
    view.fetchTime && !Number.isNaN(new Date(view.fetchTime).getTime())
      ? new Date(view.fetchTime).toLocaleString()
      : view.fetchTime;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="relative max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-outline-variant/30 bg-surface px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <span
                className="material-symbols-outlined text-xl text-primary"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                analytics
              </span>
            </div>
            <div>
              <h2 className="font-headline text-base font-bold leading-tight text-on-surface">
                Automation Metrics
              </h2>
              <p className="text-xs text-on-surface-variant">
                {view.finalUrl || view.requestedUrl || "Audit results"}
                {view.runs ? ` · ${view.runs} run(s)` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <div className="space-y-5 p-6">
          <div className="flex flex-wrap gap-2">
            {view.formFactor && (
              <span className="rounded-full border border-outline-variant/30 bg-surface-container-low px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-on-surface-variant">
                {view.formFactor}
              </span>
            )}
            {view.throttlingMethod && (
              <span className="rounded-full border border-outline-variant/30 bg-surface-container-low px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-on-surface-variant">
                {view.throttlingMethod}
              </span>
            )}
            {fetchTimeLabel && (
              <span className="rounded-full border border-outline-variant/30 bg-surface-container-low px-3 py-1 text-[11px] font-semibold text-on-surface-variant">
                {fetchTimeLabel}
              </span>
            )}
          </div>

          {view.scores.length > 0 && (
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Category Scores
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {view.scores.map((score) => (
                  <div
                    key={score.key}
                    className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4"
                  >
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <p className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                        {score.label}
                      </p>
                      <p
                        className={`font-headline text-3xl font-bold ${scoreColor(score.value)}`}
                      >
                        {score.value}
                      </p>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high">
                      <div
                        className={`h-full rounded-full ${scoreBar(score.value)}`}
                        style={{
                          width: `${Math.max(0, Math.min(score.value, 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view.metrics.length > 0 && (
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Lab Metrics
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {view.metrics.map((metric) => (
                  <div
                    key={metric.key}
                    className="rounded-2xl border border-outline-variant/30 bg-white p-4"
                  >
                    <p className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                      {metric.label}
                    </p>
                    <p className="mt-2 text-lg font-semibold text-on-surface">
                      {metric.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(view.requestedUrl || view.finalUrl) && (
            <div className="rounded-2xl border border-outline-variant/30 bg-white p-4 text-sm text-on-surface">
              <p className="text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Audit Target
              </p>
              {view.requestedUrl && (
                <p className="mt-3 break-all">
                  Requested URL:{" "}
                  <span className="text-on-surface-variant">
                    {view.requestedUrl}
                  </span>
                </p>
              )}
              {view.finalUrl && (
                <p className="mt-1 break-all">
                  Final URL:{" "}
                  <span className="text-on-surface-variant">{view.finalUrl}</span>
                </p>
              )}
            </div>
          )}

          {view.runScores.some((run) => run.length > 0) && (
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-on-surface-variant">
                Per-run Scores
              </p>
              <div className="overflow-hidden rounded-xl border border-outline-variant/30">
                <div className="grid grid-cols-[120px_repeat(4,minmax(0,1fr))] gap-2 border-b border-outline-variant/30 bg-surface-container px-4 py-2 text-xs font-medium text-on-surface-variant">
                  <span>Run</span>
                  <span>Performance</span>
                  <span>Accessibility</span>
                  <span>Best Practices</span>
                  <span>SEO</span>
                </div>
                {view.runScores.map((run, index) => {
                  const runMap = new Map(
                    run.map((entry) => [entry.key, entry.value]),
                  );

                  return (
                    <div
                      key={`run-${index + 1}`}
                      className={`grid grid-cols-[120px_repeat(4,minmax(0,1fr))] gap-2 px-4 py-3 text-xs ${index < view.runScores.length - 1 ? "border-b border-outline-variant/20" : ""}`}
                    >
                      <span className="font-medium text-on-surface">
                        Run {index + 1}
                      </span>
                      <span>{runMap.get("performance") ?? "—"}</span>
                      <span>{runMap.get("accessibility") ?? "—"}</span>
                      <span>{runMap.get("bestPractices") ?? "—"}</span>
                      <span>{runMap.get("seo") ?? "—"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const RawMetricsModal = ({
  view,
  onClose,
}: {
  view: RawMetricsView;
  onClose: () => void;
}) => (
  <div
    className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
    onClick={onClose}
  >
    <div
      className="relative max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-outline-variant/30 bg-surface px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <span
              className="material-symbols-outlined text-xl text-primary"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              data_object
            </span>
          </div>
          <div>
            <h2 className="font-headline text-base font-bold leading-tight text-on-surface">
              Raw Metrics Payload
            </h2>
            <p className="text-xs text-on-surface-variant">
              Unknown metrics schema. Showing raw payload for inspection.
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
        >
          <span className="material-symbols-outlined text-xl">close</span>
        </button>
      </div>

      <div className="p-6">
        <pre className="overflow-x-auto rounded-2xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
          {view.pretty}
        </pre>
      </div>
    </div>
  </div>
);

const readPersistedSplitViewState = (): SplitViewLocationState => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.sessionStorage.getItem(SPLIT_VIEW_SESSION_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue) as SplitViewLocationState;
    return parsedValue ?? {};
  } catch {
    return {};
  }
};

const resolvePreviewBaseUrl = (previewUrl: string): string => {
  try {
    const parsed = new URL(previewUrl);
    const isInternal =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "ai_pipeline";
    const currentHost = window.location.hostname;
    const isCurrentHostInternal =
      currentHost === "localhost" ||
      currentHost === "127.0.0.1" ||
      currentHost === "ai_pipeline";

    if (isInternal && !isCurrentHostInternal) {
      return parsed.pathname + parsed.search + parsed.hash;
    }

    // Same host — use relative path so the iframe inherits the current protocol,
    // preventing mixed-content blocks when the page is on HTTPS but preview URL is HTTP.
    if (parsed.hostname === currentHost) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // Relative preview URLs should be used as-is.
  }

  return previewUrl;
};

const WORKFLOW_STEP_ORDER = [
  "1_repo_analyzer",
  "2_theme_parser",
  "3_normalizer",
  "4_content_graph",
  "5_planner",
  "6_generator",
  "7_api_builder",
  "8_preview_builder",
  "9_visual_compare",
  "8b_edit_request",
  "9b_post_edit_visual_validation",
  "10_cleanup",
  "11_done",
  "system",
] as const;

const getWorkflowStepSortIndex = (stepName: string): number => {
  const exactIndex = WORKFLOW_STEP_ORDER.indexOf(
    stepName as (typeof WORKFLOW_STEP_ORDER)[number],
  );
  if (exactIndex >= 0) return exactIndex;
  return WORKFLOW_STEP_ORDER.length + 1;
};

const VISUAL_COMPARE_SKIPPED_SUFFIX = " (Skipped by User)";

const renderWorkflowStepLabel = (label: string) => {
  if (!label.endsWith(VISUAL_COMPARE_SKIPPED_SUFFIX)) {
    return label;
  }

  const baseLabel = label.slice(0, -VISUAL_COMPARE_SKIPPED_SUFFIX.length);
  return (
    <>
      {baseLabel}
      <span className="text-amber-800">{VISUAL_COMPARE_SKIPPED_SUFFIX}</span>
    </>
  );
};

const SplitView: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state ?? {}) as SplitViewLocationState;
  const persistedState = useMemo(() => readPersistedSplitViewState(), []);
  const jobId = locationState.jobId || persistedState.jobId || "";
  const siteId = locationState.siteId || persistedState.siteId || "";
  const previousEditRequest =
    locationState.editRequest || persistedState.editRequest;
  const pendingEditCaptures = previousEditRequest?.attachments ?? [];
  const sse = useSse(jobId || "");
  const [showMetrics, setShowMetrics] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showSkipVisualCompareConfirm, setShowSkipVisualCompareConfirm] =
    useState(false);
  const [selectedStepEvent, setSelectedStepEvent] =
    useState<PipelineProgressEvent | null>(null);
  const [activeCapturePreview, setActiveCapturePreview] =
    useState<CapturePreviewState | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [previewRefreshNonce, setPreviewRefreshNonce] = useState(0);
  const [deferredEditState, setDeferredEditState] = useState<DeferredEditUiState>({
    loading: false,
    applied: false,
    completed: false,
    dismissed: false,
    error: null,
    decision: null,
  });
  const [deleteState, setDeleteState] = useState<{
    loading: boolean;
    done: boolean;
  }>({ loading: false, done: false });
  const [rerunState, setRerunState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const [skipVisualCompareState, setSkipVisualCompareState] =
    useState<VisualCompareSkipUiState>({
      loading: false,
      requested: false,
      error: null,
    });
  const previousPreviewStageRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<number>(0);

  const getConnectionBadge = () => {
    switch (sse.connectionState) {
      case "connected":
        return {
          label: "Connected",
          className: "bg-green-500/20 text-green-600",
          dotClassName: "bg-green-800 animate-pulse",
        };
      case "reconnecting":
        return {
          label: "Reconnecting",
          className: "bg-amber-500/20 text-amber-600",
          dotClassName: "bg-amber-500 animate-pulse",
        };
      case "connecting":
        return {
          label: "Connecting",
          className: "bg-sky-500/20 text-sky-600",
          dotClassName: "bg-sky-500 animate-pulse",
        };
      case "completed":
        return {
          label: "Completed",
          className: "bg-green-500/20 text-green-600",
          dotClassName: "bg-green-700",
        };
      case "stopped":
        return {
          label: "Stopped",
          className: "bg-red-500/20 text-red-500",
          dotClassName: "bg-red-500",
        };
      case "error":
        return {
          label: "Error",
          className: "bg-red-500/20 text-red-400",
          dotClassName: "bg-red-500",
        };
      case "idle":
      default:
        return {
          label: "Idle",
          className: "bg-white/10 text-black/45",
          dotClassName: "bg-white/30",
        };
    }
  };

  const connectionBadge = getConnectionBadge();

  const getStatusLabel = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "Done";
      case "running":
        return "Running";
      case "stopped":
        return "Stopped";
      case "skipped":
        return "Skipped";
      case "error":
        return "Error";
      case "pending":
      default:
        return "Pending";
    }
  };

  const isPausedStepEvent = (
    event: Pick<PipelineProgressEvent, "status" | "message">,
  ) => {
    if (event.status !== "pending") return false;
    const message = event.message?.trim().toLowerCase() ?? "";
    if (!message) return false;
    return (
      message.includes("paused") ||
      message.includes("awaiting approval") ||
      message.includes("waiting for your decision") ||
      message.includes("choose apply or skip")
    );
  };

  const getStatusBadgeClass = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "border-emerald-300 bg-emerald-50 text-emerald-800";
      case "running":
        return "border-sky-300 bg-sky-50 text-sky-800";
      case "stopped":
        return "border-red-300 bg-red-50 text-red-800";
      case "skipped":
        return "border-slate-300 bg-slate-100 text-slate-700";
      case "error":
        return "border-red-300 bg-red-50 text-red-800";
      case "pending":
      default:
        return "border-slate-300 bg-white text-slate-700";
    }
  };

  const getStatusLabelForEvent = (
    event: Pick<PipelineProgressEvent, "status" | "message">,
  ) => {
    return isPausedStepEvent(event) ? "Paused" : getStatusLabel(event.status);
  };

  const getStatusBadgeClassForEvent = (
    event: Pick<PipelineProgressEvent, "status" | "message">,
  ) => {
    return isPausedStepEvent(event)
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : getStatusBadgeClass(event.status);
  };

  const resolveCaptureImageUrl = (imageUrl?: string) => {
    if (!imageUrl) return null;
    if (/^(https?:)?\/\//i.test(imageUrl) || imageUrl.startsWith("data:")) {
      return imageUrl;
    }
    const backendUrl = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
    if (imageUrl.startsWith("/") && backendUrl) {
      return `${backendUrl}${imageUrl}`;
    }
    return imageUrl;
  };

  const formatCapturedAt = (capturedAt?: string) => {
    if (!capturedAt) return null;
    const parsed = new Date(capturedAt);
    if (Number.isNaN(parsed.getTime())) return capturedAt;
    return parsed.toLocaleString();
  };

  const openCapturePreview = (input: CapturePreviewState) => {
    setActiveCapturePreview(input);
  };

  const getStatusIcon = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "check_circle";
      case "running":
        return "sync";
      case "stopped":
        return "stop_circle";
      case "skipped":
        return "skip_next";
      case "error":
        return "error";
      case "pending":
      default:
        return "schedule";
    }
  };

  const getStatusIconForEvent = (
    event: Pick<PipelineProgressEvent, "status" | "message">,
  ) => {
    return isPausedStepEvent(event) ? "pause_circle" : getStatusIcon(event.status);
  };

  const getStatusColor = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "text-green-500";
      case "running":
        return "text-primary animate-spin";
      case "stopped":
        return "text-red-500";
      case "skipped":
        return "text-slate-400";
      case "error":
        return "text-red-500";
      case "pending":
      default:
        return "text-slate-400";
    }
  };

  const getStatusColorForEvent = (
    event: Pick<PipelineProgressEvent, "status" | "message">,
  ) => {
    return isPausedStepEvent(event)
      ? "text-amber-500"
      : getStatusColor(event.status);
  };

  const completionEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => event.step === "11_done" && event.status === "done") ??
      null,
    [sse.allEvents],
  );
  const stoppedEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => event.status === "stopped") ?? null,
    [sse.allEvents],
  );
  const failedEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => event.status === "error") ?? null,
    [sse.allEvents],
  );
  const latestPreviewEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => Boolean(event.data?.previewUrl)) ?? null,
    [sse.allEvents],
  );
  const latestMetricsEvent = useMemo(
    () =>
      [...sse.allEvents]
        .reverse()
        .find((event) => Boolean(event.data?.metrics)) ?? null,
    [sse.allEvents],
  );
  const previewData = latestPreviewEvent?.data;
  const previewUrl =
    previewData?.previewUrl ?? completionEvent?.data?.previewUrl;
  const resolvedPreviewUrl = useMemo(
    () => (previewUrl ? resolvePreviewBaseUrl(previewUrl) : ""),
    [previewUrl],
  );
  const previewStage =
    deferredEditState.previewStage ??
    previewData?.previewStage ??
    completionEvent?.data?.previewStage;
  const hasEditRequest = Boolean(
    previewData?.hasEditRequest ?? completionEvent?.data?.hasEditRequest,
  );
  const editApprovalRequired = Boolean(
    deferredEditState.editApprovalRequired ??
      previewData?.editApprovalRequired ??
      completionEvent?.data?.editApprovalRequired,
  );
  const editApplied = Boolean(
    deferredEditState.editApplied ??
      previewData?.editApplied ??
      completionEvent?.data?.editApplied,
  );
  const hasReachedEditApprovalGate = useMemo(
    () =>
      sse.allEvents.some((event) => event.step === "8b_edit_request") ||
      deferredEditState.loading ||
      deferredEditState.completed ||
      Boolean(deferredEditState.error),
    [
      deferredEditState.completed,
      deferredEditState.error,
      deferredEditState.loading,
      sse.allEvents,
    ],
  );
  const metricsData = latestMetricsEvent?.data?.metrics;
  const metricsView = useMemo(
    () => normalizeMetricsPayload(metricsData),
    [metricsData],
  );
  const showDeferredEditPrompt =
    Boolean(previousEditRequest) &&
    hasEditRequest &&
    ((hasReachedEditApprovalGate &&
      editApprovalRequired &&
      !editApplied &&
      !deferredEditState.dismissed) ||
      deferredEditState.loading ||
      deferredEditState.completed);
  const terminalStopMessage =
    failedEvent?.message ??
    stoppedEvent?.message ??
    sse.error?.message ??
    "The AI pipeline was interrupted and this workflow has been stopped.";
  const hasStoppedWorkflow =
    sse.connectionState === "stopped" || Boolean(stoppedEvent);
  const hasFailedWorkflow =
    sse.connectionState === "error" || Boolean(failedEvent) || Boolean(sse.error);
  const isWorkflowStopped = !deleteState.done && hasStoppedWorkflow;
  const isWorkflowFailed = !deleteState.done && hasFailedWorkflow;
  const hasTerminalWorkflowFailure = isWorkflowStopped || isWorkflowFailed;
  const terminalWorkflowTitle = isWorkflowFailed
    ? "Pipeline Failed"
    : "Pipeline Stopped";
  const terminalWorkflowTitleVi = isWorkflowFailed
    ? "Pipeline đã lỗi"
    : "Pipeline đã dừng";

  const previewFrameSrc = useMemo(() => {
    if (!resolvedPreviewUrl) return "";
    const base = resolvedPreviewUrl;
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}livePreview=${previewRefreshNonce}`;
  }, [previewRefreshNonce, resolvedPreviewUrl]);

  useEffect(() => {
    if (!previewUrl || !previewStage) return;
    const previousStage = previousPreviewStageRef.current;
    if (
      previousStage &&
      previousStage !== previewStage &&
      previewStage !== "baseline"
    ) {
      setPreviewRefreshNonce((value) => value + 1);
    }
    previousPreviewStageRef.current = previewStage;
  }, [previewStage, previewUrl]);

  const previewStatus = useMemo(() => {
    if (!previewStage) {
      return {
        badge: "Preparing",
        title: "Preview is being assembled",
        description:
          "The frontend and preview API are still starting. The preview will appear here as soon as the baseline app is live.",
        badgeClass: "border-slate-300 bg-white text-slate-700",
      };
    }

    if (
      hasEditRequest &&
      hasReachedEditApprovalGate &&
      editApprovalRequired &&
      !editApplied
    ) {
      return {
        badge: "Awaiting Approval",
        title: "Baseline preview is ready. The stored edit is waiting for your decision",
        description:
          "The baseline WordPress-vs-React compare has finished. Review the baseline preview, then choose Apply or Skip for the stored user edit request.",
        badgeClass: "border-amber-300 bg-amber-50 text-amber-800",
      };
    }

    if (previewStage === "baseline") {
      return {
        badge: "Baseline Live",
        title: "Baseline preview is live",
        description:
          "The React baseline preview is running while the pipeline finishes compare, validation, and cleanup steps.",
        badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
      };
    }

    if (previewStage === "edited") {
      return {
        badge: "Edited Live",
        title: "Approved edits are now visible",
        description:
          "The running preview has been updated with the approved user edit request. Post-edit validation is running now.",
        badgeClass: "border-sky-300 bg-sky-50 text-sky-800",
      };
    }

    if (previewStage === "final" && editApplied) {
      return {
        badge: "Edited Final",
        title: "Edited preview validation is complete",
        description:
          "The approved edit survived post-edit validation and the workflow is complete.",
        badgeClass: "border-sky-300 bg-sky-50 text-sky-800",
      };
    }

    return {
      badge: "Baseline Final",
      title: "Baseline migration is complete",
      description:
        "The baseline preview has completed compare and validation. The workflow is done.",
      badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
    };
  }, [
    editApplied,
    editApprovalRequired,
    hasEditRequest,
    hasReachedEditApprovalGate,
    previewStage,
  ]);

  useEffect(() => {
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setDeferredEditState({
      loading: false,
      applied: false,
      completed: false,
      dismissed: false,
      error: null,
      decision: null,
    });
    setDeleteState({ loading: false, done: false });
    setRerunState({ loading: false, error: null });
  }, [jobId]);

  const isPipelineCompleted =
    sse.connectionState === "completed" || Boolean(completionEvent);
  const isWorkflowTerminal =
    isPipelineCompleted || hasTerminalWorkflowFailure || deleteState.done;

  useEffect(() => {
    if (!deferredEditState.loading || !deferredEditState.decision) return;

    if (
      deferredEditState.decision === "apply" &&
      (editApplied || previewStage === "edited")
    ) {
      setDeferredEditState((prev) => ({
        ...prev,
        loading: false,
        applied: true,
        completed: true,
        dismissed: true,
        error: null,
        previewStage: previewStage ?? "edited",
        editApprovalRequired: false,
        editApplied: true,
      }));
      return;
    }

    // Pipeline finished but the approved edit required no code changes.
    // Resolve loading without claiming edit was applied.
    if (
      deferredEditState.decision === "apply" &&
      isPipelineCompleted &&
      !editApplied
    ) {
      setDeferredEditState((prev) => ({
        ...prev,
        loading: false,
        applied: false,
        completed: true,
        dismissed: true,
        error: null,
        previewStage: previewStage ?? "baseline",
        editApprovalRequired: false,
        editApplied: false,
      }));
      return;
    }

    if (
      deferredEditState.decision === "skip" &&
      !editApprovalRequired &&
      !editApplied
    ) {
      setDeferredEditState((prev) => ({
        ...prev,
        loading: false,
        applied: false,
        completed: true,
        dismissed: true,
        error: null,
        previewStage: previewStage ?? "baseline",
        editApprovalRequired: false,
        editApplied: false,
      }));
    }
  }, [
    deferredEditState.decision,
    deferredEditState.loading,
    editApplied,
    editApprovalRequired,
    isPipelineCompleted,
    previewStage,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nextElapsed = Math.max(
        0,
        Math.floor((Date.now() - startedAtRef.current) / 1000),
      );

      if (isWorkflowTerminal) {
        setElapsedSeconds(nextElapsed);
        window.clearInterval(timer);
        return;
      }

      setElapsedSeconds(nextElapsed);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [completionEvent, isWorkflowTerminal, sse.connectionState]);

  const elapsedLabel = useMemo(() => {
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;

    if (hours > 0) {
      return [hours, minutes, seconds]
        .map((value) => String(value).padStart(2, "0"))
        .join(":");
    }

    return [minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }, [elapsedSeconds]);

  const completionDurationLabel = isPipelineCompleted ? elapsedLabel : null;

  useEffect(() => {
    if (!jobId || !siteId || !previousEditRequest) return;

    window.sessionStorage.setItem(
      SPLIT_VIEW_SESSION_KEY,
      JSON.stringify({
        jobId,
        siteId,
        editRequest: previousEditRequest,
      } satisfies SplitViewLocationState),
    );
  }, [jobId, previousEditRequest, siteId]);

  useEffect(() => {
    const shouldWarnBeforeRefresh = () => !isWorkflowTerminal;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldWarnBeforeRefresh()) return;
      event.preventDefault();
      event.returnValue = "";
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const isRefreshShortcut =
        event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");

      if (!isRefreshShortcut || !shouldWarnBeforeRefresh()) return;

      event.preventDefault();
      const confirmed = window.confirm(
        "The AI pipeline is still running. Refreshing this page may interrupt your live monitoring. Do you want to refresh anyway?",
      );

      if (confirmed) {
        window.location.reload();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [completionEvent, isWorkflowTerminal, sse.connectionState]);
  const openStopConfirm = () => {
    if (deleteState.loading || deleteState.done) return;
    setShowStopConfirm(true);
  };

  const closeStopConfirm = () => {
    if (deleteState.loading) return;
    setShowStopConfirm(false);
  };

  const openSkipVisualCompareConfirm = () => {
    if (skipVisualCompareState.loading) return;
    setSkipVisualCompareState((prev) => ({ ...prev, error: null }));
    setShowSkipVisualCompareConfirm(true);
  };

  const closeSkipVisualCompareConfirm = () => {
    if (skipVisualCompareState.loading) return;
    setShowSkipVisualCompareConfirm(false);
  };

  const handleStopPipeline = async () => {
    setDeleteState({ loading: true, done: false });
    try {
      await fetch(`/ai-api/pipeline/stop/${jobId}`, { method: "POST" });
      setDeleteState({ loading: false, done: false });
      setShowStopConfirm(false);
    } catch {
      setDeleteState({ loading: false, done: false });
    }
  };

  const handleSkipVisualCompare = async () => {
    if (!jobId || !siteId || skipVisualCompareState.loading) return;

    setSkipVisualCompareState({
      loading: true,
      requested: false,
      error: null,
    });

    try {
      const response = await skipVisualCompare(siteId, jobId);
      if (!response.accepted) {
        setSkipVisualCompareState({
          loading: false,
          requested: false,
          error:
            response.error ||
            "The baseline visual compare could not be skipped.",
        });
        return;
      }

      setSkipVisualCompareState({
        loading: false,
        requested: true,
        error: null,
      });
      setShowSkipVisualCompareConfirm(false);
    } catch (error) {
      const message =
        error instanceof AiProcessError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to skip the baseline visual compare.";
      setSkipVisualCompareState({
        loading: false,
        requested: false,
        error: message,
      });
    }
  };

  const handleResendRequest = async () => {
    if (!siteId || rerunState.loading) return;

    setRerunState({ loading: true, error: null });
    try {
      const data = await runAiProcess(siteId, previousEditRequest);
      sse.disconnect();
      navigate("/app/editor/split-view", {
        replace: true,
        state: {
          jobId: data.jobId,
          siteId,
          editRequest: previousEditRequest,
        } satisfies SplitViewLocationState,
      });
    } catch (error) {
      const message =
        error instanceof AiProcessError
          ? error.message
          : "Failed to resend the AI pipeline request.";
      setRerunState({ loading: false, error: message });
    }
  };

  const handleApplyPendingEdit = async () => {
    if (!jobId || !siteId || deferredEditState.loading) return;
    setDeferredEditState((prev) => ({
      ...prev,
      loading: true,
      completed: false,
      error: null,
      dismissed: false,
      decision: "apply",
    }));
    try {
      const response = await applyPendingEditRequest(siteId, jobId);
      if (!response.accepted) {
        setDeferredEditState((prev) => ({
          ...prev,
          loading: false,
          completed: false,
          error: response.error || "The pending edit request could not be applied.",
        }));
        return;
      }
    } catch (error) {
      const message =
        error instanceof AiProcessError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to apply the pending edit request.";
      setDeferredEditState((prev) => ({
        ...prev,
        loading: false,
        completed: false,
        error: message,
      }));
    }
  };

  const handleSkipPendingEdit = async () => {
    if (!jobId || !siteId || deferredEditState.loading) return;
    setDeferredEditState((prev) => ({
      ...prev,
      loading: true,
      completed: false,
      error: null,
      dismissed: false,
      decision: "skip",
    }));
    try {
      const response = await skipPendingEditRequest(siteId, jobId);
      if (!response.accepted) {
        setDeferredEditState((prev) => ({
          ...prev,
          loading: false,
          completed: false,
          error:
            response.error ||
            "The pipeline could not continue with the baseline preview.",
        }));
        return;
      }
    } catch (error) {
      const message =
        error instanceof AiProcessError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to continue with the baseline preview.";
      setDeferredEditState((prev) => ({
        ...prev,
        loading: false,
        completed: false,
        error: message,
      }));
    }
  };

  const actionButtonClass =
    "inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";

  const stepStatuses = useMemo(() => {
    const stepMap = new Map<string, PipelineProgressEvent>();
    sse.allEvents.forEach((event) => {
      stepMap.set(event.step, event);
    });

    const editStepName = "8b_edit_request";
    const existingEditStep = stepMap.get(editStepName);
    if (
      existingEditStep ||
      deferredEditState.loading ||
      deferredEditState.completed ||
      Boolean(deferredEditState.error) ||
      (hasEditRequest &&
        hasReachedEditApprovalGate &&
        editApprovalRequired &&
        !editApplied) ||
      (hasEditRequest && editApplied)
    ) {
      const optimisticStatus: PipelineProgressEvent["status"] =
        deferredEditState.loading
          ? "running"
          : deferredEditState.completed
            ? "done"
            : editApprovalRequired && !editApplied
              ? "pending"
              : existingEditStep?.status ?? "done";

      const optimisticMessage = deferredEditState.loading
        ? deferredEditState.decision === "skip"
          ? "Continuing with the baseline preview after the user skipped the pending edit request."
          : "Applying the approved edit request to the running preview."
        : deferredEditState.completed
          ? deferredEditState.decision === "skip"
            ? "Requested edit handling is complete. The workflow continued with the baseline preview."
            : "Requested edit handling is complete and the approved edits have been applied."
          : existingEditStep?.message ??
            "Requested edit is pending user approval. The pipeline is paused until the user chooses Apply or Skip.";

      stepMap.set(editStepName, {
        step: editStepName,
        label: existingEditStep?.label ?? "Await Or Apply Requested Edits",
        status: optimisticStatus,
        percent:
          deferredEditState.loading
            ? Math.max(existingEditStep?.percent ?? 0, 90)
            : deferredEditState.completed
              ? 100
              : existingEditStep?.percent ?? 90,
        message: optimisticMessage,
        data: existingEditStep?.data,
      });
    }

    return Array.from(stepMap.values())
      .map((event) =>
        hasStoppedWorkflow && event.status === "running"
          ? {
              ...event,
              status: "stopped" as const,
              message:
                event.message && event.message.trim().length > 0
                  ? event.message
                  : terminalStopMessage,
            }
          : event,
      )
      .map((event) => {
        const shouldAnnotateVisualCompareSkip =
          event.step === "9_visual_compare" &&
          (skipVisualCompareState.requested || event.status === "skipped");
        if (!shouldAnnotateVisualCompareSkip) return event;
        return {
          ...event,
          label: event.label.endsWith(VISUAL_COMPARE_SKIPPED_SUFFIX)
            ? event.label
            : `${event.label}${VISUAL_COMPARE_SKIPPED_SUFFIX}`,
        };
      })
      .sort((a, b) => {
        return getWorkflowStepSortIndex(a.step) - getWorkflowStepSortIndex(b.step);
      });
  }, [
    deferredEditState.completed,
    deferredEditState.decision,
    deferredEditState.loading,
    editApplied,
    editApprovalRequired,
    hasReachedEditApprovalGate,
    hasStoppedWorkflow,
    hasEditRequest,
    skipVisualCompareState.requested,
    sse.allEvents,
    terminalStopMessage,
  ]);
  const visualCompareStep = useMemo(
    () =>
      stepStatuses.find((event) => event.step === "9_visual_compare") ?? null,
    [stepStatuses],
  );
  const isVisualCompareRunning = visualCompareStep?.status === "running";
  const canSkipVisualCompare =
    Boolean(jobId) &&
    Boolean(siteId) &&
    isVisualCompareRunning &&
    !deleteState.done &&
    !hasTerminalWorkflowFailure;

  useEffect(() => {
    if (isVisualCompareRunning) return;
    setShowSkipVisualCompareConfirm(false);
    setSkipVisualCompareState((prev) => ({
      ...prev,
      loading: false,
      requested: false,
    }));
  }, [isVisualCompareRunning]);

  const latestEvent = useMemo(() => {
    const activeStep =
      [...stepStatuses]
        .reverse()
        .find((event) => event.status === "running") ??
      [...stepStatuses]
        .reverse()
        .find((event) => event.status === "pending");
    return activeStep ?? sse.currentEvent;
  }, [sse.currentEvent, stepStatuses]);

  useEffect(() => {
    if (!selectedStepEvent) return;
    const nextSelectedStepEvent = stepStatuses.find(
      (event) => event.step === selectedStepEvent.step,
    );
    if (!nextSelectedStepEvent) return;
    if (
      nextSelectedStepEvent.status !== selectedStepEvent.status ||
      nextSelectedStepEvent.percent !== selectedStepEvent.percent ||
      nextSelectedStepEvent.message !== selectedStepEvent.message ||
      nextSelectedStepEvent.label !== selectedStepEvent.label
    ) {
      setSelectedStepEvent(nextSelectedStepEvent);
    }
  }, [selectedStepEvent, stepStatuses]);

  if (!jobId) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-on-surface">No Job ID</h1>
          <p className="text-on-surface-variant">
            Please provide a jobId to start pipeline
          </p>
          <button
            onClick={() => navigate("/app/projects")}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:opacity-90"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-background text-on-surface font-body">
      <section className="w-[42%] min-w-[420px] bg-inverse-surface text-inverse-on-surface flex flex-col border-r border-outline">
        <div className="px-6 py-4 bg-black/10">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-[220px] flex-1 items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full ${connectionBadge.dotClassName}`}
              />
              <div className="min-w-0">
                <h2 className="font-headline text-lg tracking-tight whitespace-nowrap">
                  AI Workflow Console
                </h2>
                <p className="text-[11px] leading-5 text-black/45">
                  Live progress from the migration agents
                </p>
              </div>
            </div>
            <div className="flex max-w-full flex-wrap items-center justify-start gap-2 md:justify-end">
              <div className="flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5">
                {!completionDurationLabel && (
                  <span className="text-[11px] font-mono text-black/55">
                    Elapsed: {elapsedLabel}
                  </span>
                )}
                {completionDurationLabel && (
                  <span className="text-[11px] font-mono text-emerald-700">
                    Completed in: {completionDurationLabel}
                  </span>
                )}
              </div>
              <span
                className={`text-xs font-mono px-2.5 py-1.5 rounded ${connectionBadge.className}`}
              >
                {connectionBadge.label}
              </span>
              {hasTerminalWorkflowFailure && !deleteState.done && (
                <button
                  onClick={handleResendRequest}
                  disabled={rerunState.loading || !siteId}
                  className="text-xs font-mono px-2.5 py-1.5 rounded bg-emerald-500/20 text-emerald-700 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <span
                    className={`material-symbols-outlined text-xs ${
                      rerunState.loading ? "animate-spin" : ""
                    }`}
                    style={{ fontSize: 13 }}
                  >
                    {rerunState.loading ? "progress_activity" : "refresh"}
                  </span>
                  {rerunState.loading ? "Resending..." : "Resend Request"}
                </button>
              )}
              {sse.isConnected && !deleteState.done && !hasTerminalWorkflowFailure && (
                <>
                  <button
                    onClick={openStopConfirm}
                    disabled={deleteState.loading}
                    className="text-xs font-mono px-2.5 py-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <span
                      className="material-symbols-outlined text-xs"
                      style={{ fontSize: 13 }}
                    >
                      stop_circle
                    </span>
                    {deleteState.loading ? "Stopping..." : "Stop"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 font-mono text-sm space-y-4">
          {latestEvent ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-black/40">
                Current Agent Action
              </p>
              <p
                className={`mt-2 text-sm ${
                  latestEvent.status === "stopped" || latestEvent.status === "error"
                    ? "text-red-500"
                    : "text-green-700"
                }`}
              >
                {latestEvent.label}
              </p>
              {latestEvent.message && (
                <p className="mt-1 text-xs text-black/55">
                  {latestEvent.message}
                </p>
              )}
            </div>
          ) : sse.isConnected && !sse.isLoading ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-black/40">
                Current Agent Action
              </p>
              <p className="mt-2 text-sm text-green-700">
                Waiting for the first agent action...
              </p>
              <p className="mt-1 text-xs text-black/55">
                The workflow stream is connected. The first step update will
                appear here as soon as the backend emits it.
              </p>
            </div>
          ) : null}

          {sse.isLoading && (
            <p className="text-black/40">
              {sse.connectionState === "reconnecting"
                ? "Reconnecting to the AI workflow stream..."
                : "Connecting to the AI workflow stream..."}
            </p>
          )}
          {sse.error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-xs">
              Workflow error: {sse.error.message}
            </div>
          )}
          {skipVisualCompareState.error && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              Skip compare failed: {skipVisualCompareState.error}
            </div>
          )}
          {skipVisualCompareState.requested && isVisualCompareRunning && (
            <div className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
              Skip compare has been requested. The backend is leaving the
              metric step and continuing to the next pipeline stage.
            </div>
          )}
          {hasTerminalWorkflowFailure && (
            <div className="rounded-xl border border-red-300/70 bg-red-50 p-4 text-red-900">
              <p className="text-[11px] uppercase tracking-[0.18em] text-red-500/80">
                {terminalWorkflowTitle}
              </p>
              <p className="mt-2 text-sm text-red-900">{terminalStopMessage}</p>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleResendRequest}
                  disabled={rerunState.loading || !siteId}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-200/30 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`material-symbols-outlined text-[16px] ${
                      rerunState.loading ? "animate-spin" : ""
                    }`}
                  >
                    {rerunState.loading ? "progress_activity" : "refresh"}
                  </span>
                  {rerunState.loading ? "Resending request..." : "Send request again"}
                </button>
                {rerunState.error && (
                  <span className="text-xs text-red-700">{rerunState.error}</span>
                )}
              </div>
            </div>
          )}

          {sse.allEvents.length === 0 && !sse.isLoading ? (
            <p className="text-black/50">
              {sse.connectionState === "connected"
                ? "Connected. Waiting for the first agent update..."
                : sse.connectionState === "reconnecting"
                  ? "Reconnecting to the workflow stream while the pipeline continues..."
                  : "Waiting for the workflow stream..."}
            </p>
          ) : null}

          {stepStatuses.map((event) => {
            const showStepSkipButton =
              event.step === "9_visual_compare" && canSkipVisualCompare;

            return (
              <div
                key={event.step}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedStepEvent(event)}
                onKeyDown={(keyboardEvent) => {
                  if (
                    keyboardEvent.target !== keyboardEvent.currentTarget ||
                    (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ")
                  ) {
                    return;
                  }
                  keyboardEvent.preventDefault();
                  setSelectedStepEvent(event);
                }}
                className="group flex w-full cursor-pointer items-start gap-3 rounded-2xl border border-transparent bg-white/25 px-3 py-3 text-left transition hover:border-[#d9d1c3] hover:bg-white/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                <span
                  className={`material-symbols-outlined mt-0.5 text-lg ${getStatusColorForEvent(event)}`}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {getStatusIconForEvent(event)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-green-700 transition group-hover:text-green-800">
                      {renderWorkflowStepLabel(event.label)}
                    </p>
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      View details
                    </span>
                  </div>
                  {event.message && (
                    <p className="text-black/50 text-xs">{event.message}</p>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{ width: `${event.percent}%` }}
                      />
                    </div>
                    <span className="text-xs text-black/50">
                      {event.percent}%
                    </span>
                  </div>
                  {showStepSkipButton && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={(clickEvent) => {
                          clickEvent.stopPropagation();
                          openSkipVisualCompareConfirm();
                        }}
                        disabled={skipVisualCompareState.loading}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[14px] ${
                            skipVisualCompareState.loading ? "animate-spin" : ""
                          }`}
                        >
                          {skipVisualCompareState.loading
                            ? "progress_activity"
                            : "skip_next"}
                        </span>
                        {skipVisualCompareState.loading
                          ? "Skipping compare..."
                          : "Skip compare"}
                      </button>
                      <span className="text-[11px] text-black/45">
                        Continue with the current preview.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {previewUrl && (
            <div className="mt-8 rounded-2xl border border-[#d9d1c3] bg-[#f7f1e8] p-4 text-xs text-slate-700 shadow-lg shadow-black/10">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
                >
                  {previewStatus.badge}
                </span>
                {metricsView && (
                  <span className="inline-flex items-center rounded-full border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-800">
                    Compare Ready
                  </span>
                )}
              </div>
              <div className="mt-3">
                <p className="text-sm font-semibold text-slate-900">
                  {previewStatus.title}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {previewStatus.description}
                </p>
                {completionDurationLabel && (
                  <p className="mt-2 text-xs font-medium text-emerald-800">
                    Total completion time: {completionDurationLabel}
                  </p>
                )}
              </div>
              <div className="mt-4 space-y-2 rounded-xl border border-[#d8cec0] bg-[#d7d1ca] p-3 text-[11px] text-slate-700">
                <p className="break-all">
                  Preview URL:{" "}
                  <span className="text-slate-900">{previewUrl}</span>
                </p>
              </div>
              {(showDeferredEditPrompt || deferredEditState.error) && (
                <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-slate-800">
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 rounded-full p-2 ${
                        deferredEditState.loading
                          ? "bg-sky-100 text-sky-700"
                          : deferredEditState.completed
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      <span
                        className={`material-symbols-outlined text-[18px] ${
                          deferredEditState.loading ? "animate-spin" : ""
                        }`}
                      >
                        {deferredEditState.loading
                          ? "sync"
                          : deferredEditState.completed
                            ? "check_circle"
                            : "rate_review"}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900">
                        {deferredEditState.loading
                          ? deferredEditState.decision === "skip"
                            ? "Continuing with the baseline preview…"
                            : "Applying the approved edit request…"
                          : deferredEditState.completed
                            ? deferredEditState.decision === "skip"
                              ? "Baseline preview kept"
                              : "Approved edits are live"
                            : "Review and apply the stored edit request?"}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {deferredEditState.loading
                          ? deferredEditState.decision === "skip"
                            ? "The backend has resumed the pipeline and is continuing without the pending edit request."
                            : "The backend has resumed the pipeline and is now applying the approved edit request to the running preview."
                          : deferredEditState.completed
                            ? deferredEditState.decision === "skip"
                              ? "The user chose to keep the baseline preview. Requested edit handling is complete."
                              : "The approved edit request has been applied to the live preview and the pipeline is validating the edited result."
                            : "You are currently viewing the baseline React migration after compare. The stored edit request has not been applied yet."}
                      </p>
                      {!deferredEditState.completed && (
                        <div className="mt-3 space-y-3">
                          <div className="rounded-xl border border-amber-200 bg-white px-3 py-3 text-xs leading-6 text-slate-700">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-slate-900">
                                Main prompt
                              </p>
                              {previousEditRequest?.language ? (
                                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-800">
                                  {previousEditRequest.language}
                                </span>
                              ) : null}
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700">
                                {pendingEditCaptures.length} capture(s)
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap">
                              {previousEditRequest?.prompt ||
                                "No main prompt was submitted. This pending request is driven by capture notes only."}
                            </p>
                          </div>

                          <div className="rounded-xl border border-amber-200 bg-white px-3 py-3 text-xs text-slate-700">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-semibold text-slate-900">
                                Submitted captures
                              </p>
                              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-800">
                                {pendingEditCaptures.length} item(s)
                              </span>
                            </div>
                            {pendingEditCaptures.length > 0 ? (
                              <div className="mt-3">
                                <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                  <span>
                                    Click any thumbnail to open a larger preview.
                                  </span>
                                  <span>{pendingEditCaptures.length} reference(s)</span>
                                </div>
                                <div className="max-h-[38rem] overflow-y-auto pr-1">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {pendingEditCaptures.map((capture, index) => {
                                const imageSrc = resolveCaptureImageUrl(
                                  capture.asset?.publicUrl,
                                );
                                const capturedAtLabel = formatCapturedAt(
                                  capture.captureContext?.capturedAt,
                                );
                                const pageRoute =
                                  capture.captureContext?.page?.route ||
                                  capture.sourcePageUrl ||
                                  "Unknown route";
                                const pageTitle =
                                  capture.captureContext?.page?.title;
                                const nearestHeading =
                                  capture.domTarget?.nearestHeading ||
                                  capture.targetNode?.nearestHeading;
                                const selector =
                                  capture.domTarget?.cssSelector ||
                                  capture.domTarget?.domPath ||
                                  capture.targetNode?.domPath;
                                const tagName =
                                  capture.domTarget?.tagName ||
                                  capture.targetNode?.tagName;

                                return (
                                  <div
                                    key={capture.id}
                                    className="overflow-hidden rounded-2xl border border-amber-100 bg-[#fffaf2] shadow-sm"
                                  >
                                    <div className="relative">
                                        {imageSrc ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              openCapturePreview({
                                                src: imageSrc,
                                                alt:
                                                  capture.note ||
                                                  `capture-${capture.id}`,
                                                note: capture.note,
                                                route: pageRoute,
                                                pageTitle,
                                                capturedAt: capturedAtLabel,
                                              })
                                            }
                                            className="group relative block h-48 w-full overflow-hidden bg-[#f6e8cf] transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                                          >
                                            <img
                                              src={imageSrc}
                                              alt={
                                                capture.note ||
                                                `capture-${capture.id}`
                                              }
                                              className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]"
                                            />
                                            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/75 via-black/15 to-transparent px-3 py-3 text-white">
                                              <div className="min-w-0">
                                                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/80">
                                                  Capture {index + 1}
                                                </p>
                                                <p className="truncate text-xs font-medium">
                                                  {pageTitle || pageRoute}
                                                </p>
                                              </div>
                                              <span className="material-symbols-outlined text-[16px]">
                                                open_in_full
                                              </span>
                                            </div>
                                          </button>
                                        ) : (
                                          <div className="flex h-48 w-full items-center justify-center overflow-hidden bg-[#f6e8cf]">
                                            <span className="material-symbols-outlined text-[20px] text-amber-700">
                                              image
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                      <div className="space-y-3 p-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700">
                                            Capture {index + 1}
                                          </span>
                                          {tagName ? (
                                            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                                              {tagName}
                                            </span>
                                          ) : null}
                                        </div>
                                        <p className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">
                                          {capture.note ||
                                            "No capture note was provided."}
                                        </p>
                                        <div className="space-y-1 text-[11px] text-slate-500">
                                          <p className="truncate">
                                            {pageTitle ? `Page: ${pageTitle}` : pageRoute}
                                          </p>
                                          {pageTitle ? (
                                            <p className="truncate">{pageRoute}</p>
                                          ) : null}
                                        </div>
                                        {(nearestHeading ||
                                          selector ||
                                          capturedAtLabel) && (
                                          <div className="rounded-xl bg-white px-3 py-2 text-[11px] leading-5 text-slate-600">
                                            {nearestHeading ? (
                                              <p>
                                                Nearest heading:{" "}
                                                {nearestHeading}
                                              </p>
                                            ) : null}
                                            {selector ? (
                                              <p className="break-all">
                                                Target: {selector}
                                              </p>
                                            ) : null}
                                            {capturedAtLabel ? (
                                              <p>
                                                Captured at: {capturedAtLabel}
                                              </p>
                                            ) : null}
                                          </div>
                                        )}
                                    </div>
                                  </div>
                                );
                                })}
                                </div>
                                </div>
                              </div>
                            ) : (
                              <p className="mt-3 text-[11px] text-slate-500">
                                No capture attachments were submitted for this pending edit request.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        {deferredEditState.completed ? (
                          <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800">
                            <span className="material-symbols-outlined text-[18px]">
                              check_circle
                            </span>
                            {deferredEditState.decision === "skip"
                              ? "Baseline confirmed"
                              : "Edit request applied"}
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() => void handleApplyPendingEdit()}
                              disabled={deferredEditState.loading}
                              className={`${actionButtonClass} border-amber-800 bg-amber-700 text-white hover:bg-amber-800 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                              {deferredEditState.loading &&
                              deferredEditState.decision === "apply" ? (
                                <span className="material-symbols-outlined animate-spin text-[18px]">
                                  sync
                                </span>
                              ) : null}
                              {deferredEditState.loading &&
                              deferredEditState.decision === "apply"
                                ? "Applying edits…"
                                : "Apply requested edits"}
                            </button>
                            <button
                              onClick={() => void handleSkipPendingEdit()}
                              disabled={deferredEditState.loading}
                              className={`${actionButtonClass} border-slate-300 bg-white text-slate-800 hover:bg-slate-100 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                              {deferredEditState.loading &&
                              deferredEditState.decision === "skip" ? (
                                <span className="material-symbols-outlined animate-spin text-[18px]">
                                  sync
                                </span>
                              ) : null}
                              {deferredEditState.loading &&
                              deferredEditState.decision === "skip"
                                ? "Continuing…"
                                : "Continue with baseline"}
                            </button>
                          </>
                        )}
                      </div>
                      {deferredEditState.error && (
                        <p className="mt-3 text-xs text-red-700">
                          {deferredEditState.error}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => window.open(resolvedPreviewUrl, "_blank")}
                  className={`${actionButtonClass} border-teal-800 bg-teal-700 text-white hover:bg-teal-800 focus-visible:ring-teal-500`}
                >
                  Open Preview
                </button>
                {metricsView && (
                  <button
                    onClick={() => setShowMetrics(true)}
                    className={`${actionButtonClass} border-orange-700 bg-orange-600 text-white hover:bg-orange-700 focus-visible:ring-orange-500`}
                  >
                    View Metrics
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-black/10 border-t border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-4 text-xs text-black/40">
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">
                terminal
              </span>
              {sse.connectionState === "connected"
                ? "Agent Stream Live"
                : sse.connectionState === "reconnecting"
                  ? "Agent Stream Reconnecting"
                  : sse.connectionState === "connecting"
                    ? "Agent Stream Connecting"
                    : sse.connectionState === "completed"
                      ? "Agent Stream Completed"
                      : sse.connectionState === "error"
                        ? "Agent Stream Failed"
                      : sse.connectionState === "stopped"
                        ? "Agent Stream Stopped"
                        : "Agent Stream Offline"}
            </span>
            <span className="flex items-center gap-1">
              {sse.progress}% Workflow Progress
            </span>
          </div>
          <div className="text-xs text-primary font-bold">
            {completionEvent
              ? "WORKFLOW COMPLETE"
              : isWorkflowFailed
                ? "WORKFLOW FAILED"
                : isWorkflowStopped
                ? "WORKFLOW STOPPED"
                : "AGENTS WORKING"}
          </div>
        </div>
      </section>

      <section className="w-[58%] bg-surface-container-low flex flex-col">
        <div className="px-6 py-4 border-b border-outline-variant bg-white/60 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex items-center gap-3">
              <span className="material-symbols-outlined text-on-surface-variant">
                visibility
              </span>
              <div className="min-w-0">
                <h2 className="font-headline text-lg text-on-surface">
                  Live Preview
                </h2>
                {previewUrl ? (
                  <p className="truncate text-xs text-on-surface-variant">
                    {previewStatus.description}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 justify-end">
              {completionEvent && previewUrl && (
                <button
                  onClick={() =>
                    navigate("/app/editor/visual", {
                      state: { jobId, siteId, previewUrl },
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#49704F] px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-[#3f6246]"
                >
                  <span className="material-symbols-outlined text-[15px]">edit</span>
                  Visual Edit
                </button>
              )}
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
              >
                {previewStatus.badge}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 p-4 md:p-5 overflow-y-auto flex items-center justify-center">
          {deleteState.done ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto">
                <span
                  className="material-symbols-outlined text-red-400 text-3xl"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  stop_circle
                </span>
              </div>
              <p className="text-on-surface font-medium">
                Pipeline đã tạm dừng
              </p>
              <p className="text-xs text-on-surface-variant">
                Tất cả tiến trình đã được dừng lại và artifacts đã được xóa.
              </p>
              <button
                onClick={() => navigate("/app/projects")}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:opacity-90 text-sm font-medium"
              >
                Quay về trang dự án
              </button>
            </div>
          ) : hasTerminalWorkflowFailure ? (
            <div className="max-w-lg text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto">
                <span
                  className="material-symbols-outlined text-red-400 text-3xl"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  stop_circle
                </span>
              </div>
              <p className="text-on-surface font-medium">{terminalWorkflowTitleVi}</p>
              <p className="text-sm text-on-surface-variant">
                {terminalStopMessage}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={handleResendRequest}
                  disabled={rerunState.loading || !siteId}
                  className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className={`material-symbols-outlined text-[18px] ${
                      rerunState.loading ? "animate-spin" : ""
                    }`}
                  >
                    {rerunState.loading ? "progress_activity" : "refresh"}
                  </span>
                  {rerunState.loading ? "Đang gửi lại..." : "Gửi lại yêu cầu"}
                </button>
              </div>
              {rerunState.error && (
                <p className="text-xs text-red-500">{rerunState.error}</p>
              )}
            </div>
          ) : previewUrl ? (
            <div className="relative h-full w-full">
              <div className="pointer-events-none absolute left-5 top-5 z-10 max-w-md rounded-2xl border border-white/70 bg-white/90 px-4 py-3 shadow-lg backdrop-blur">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${previewStatus.badgeClass}`}
                  >
                    {previewStatus.badge}
                  </span>
                    {metricsView && (
                      <span className="inline-flex items-center rounded-full border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-800">
                        Compare Ready
                      </span>
                    )}
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {previewStatus.title}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {previewStatus.description}
                </p>
              </div>
              <iframe
                src={previewFrameSrc}
                title="Live Preview"
                className="h-full w-full rounded-2xl border border-outline-variant bg-white shadow-sm transition-all duration-500"
              />
            </div>
          ) : (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin mx-auto" />
              <p className="text-on-surface-variant">
                AI agents are preparing the preview...
              </p>
              <p className="text-xs text-on-surface-variant/50">
                {sse.progress > 0
                  ? `${sse.progress}% workflow complete`
                  : "Initializing migration workflow..."}
              </p>
            </div>
          )}
        </div>
      </section>

      {showStopConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={closeStopConfirm}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 border-b border-outline-variant/30 px-6 py-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  stop_circle
                </span>
              </div>
              <div className="min-w-0">
                <h2 className="font-headline text-lg font-semibold text-on-surface">
                  Dừng pipeline hiện tại?
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Workflow đang chạy sẽ nhận yêu cầu dừng và backend sẽ halt ở
                  checkpoint an toàn gần nhất.
                </p>
              </div>
            </div>
            <div className="px-6 py-4">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Bạn có muốn dừng workflow AI hiện tại không?
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <button
                onClick={closeStopConfirm}
                disabled={deleteState.loading}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={handleStopPipeline}
                disabled={deleteState.loading}
                className="inline-flex items-center gap-2 rounded-xl border border-red-700 bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">
                  stop_circle
                </span>
                {deleteState.loading ? "Đang dừng..." : "Dừng pipeline"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSkipVisualCompareConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={closeSkipVisualCompareConfirm}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-outline-variant/40 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 border-b border-outline-variant/30 px-6 py-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-700">
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  skip_next
                </span>
              </div>
              <div className="min-w-0">
                <h2 className="font-headline text-lg font-semibold text-on-surface">
                  Bỏ qua bước so sánh metric?
                </h2>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Pipeline sẽ dừng bước baseline visual compare và metric-based
                  repair, rồi chuyển thẳng sang bước tiếp theo với preview hiện
                  tại.
                </p>
              </div>
            </div>
            <div className="px-6 py-4">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Dùng khi bước compare đang chạy quá lâu. Preview hiện tại sẽ
                được giữ nguyên; chỉ phần so sánh và sửa theo metric bị bỏ qua.
              </div>
              {skipVisualCompareState.error && (
                <p className="mt-3 text-sm text-red-700">
                  {skipVisualCompareState.error}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <button
                onClick={closeSkipVisualCompareConfirm}
                disabled={skipVisualCompareState.loading}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleSkipVisualCompare()}
                disabled={skipVisualCompareState.loading}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-700 bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    skipVisualCompareState.loading ? "animate-spin" : ""
                  }`}
                >
                  {skipVisualCompareState.loading ? "progress_activity" : "skip_next"}
                </span>
                {skipVisualCompareState.loading
                  ? "Đang bỏ qua..."
                  : "Xác nhận bỏ qua"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedStepEvent &&
        (() => {
          const details = selectedStepEvent.data?.stepDetails;
          const previewLink = selectedStepEvent.data?.previewUrl;

          return (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center"
              onClick={() => setSelectedStepEvent(null)}
            >
              <div
                className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-[28px] border border-outline-variant/40 bg-[#f8f3eb] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="sticky top-0 z-10 border-b border-[#e4dac9] bg-[#f8f3eb]/95 px-6 py-5 backdrop-blur">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-4">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm">
                        <span
                          className={`material-symbols-outlined text-2xl ${getStatusColorForEvent(selectedStepEvent)}`}
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          {getStatusIconForEvent(selectedStepEvent)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${getStatusBadgeClassForEvent(selectedStepEvent)}`}
                          >
                            {getStatusLabelForEvent(selectedStepEvent)}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                            {selectedStepEvent.percent}% complete
                          </span>
                          {details?.kind === "edit-request" && (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800">
                              User Edit Request
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 font-headline text-2xl font-semibold text-slate-900">
                          {details?.title || selectedStepEvent.label}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {details?.summary ||
                            selectedStepEvent.message ||
                            "This workflow step has no extra structured details yet."}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedStepEvent(null)}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
                    >
                      <span className="material-symbols-outlined text-[20px]">
                        close
                      </span>
                    </button>
                  </div>
                </div>

                <div className="space-y-6 px-6 py-6">
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Step
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-900">
                        {selectedStepEvent.label}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Latest Log
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {selectedStepEvent.message ||
                          "No additional log message."}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#e4dac9] bg-white p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Preview Context
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {previewLink
                          ? "This step is attached to a live preview context."
                          : "No preview URL was attached to this step."}
                      </p>
                      {previewLink && (
                        <button
                          type="button"
                          onClick={() => window.open(previewLink, "_blank")}
                          className="mt-3 inline-flex items-center gap-2 rounded-xl border border-emerald-700 bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            open_in_new
                          </span>
                          Open Related Preview
                        </button>
                      )}
                    </div>
                  </div>

                  {details?.kind === "edit-request" && (
                    <>
                      <div className="rounded-[24px] border border-[#e4dac9] bg-white p-5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center rounded-full bg-[#eef3ea] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#446150]">
                            Main Request
                          </span>
                          {details.language && (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                              {details.language}
                            </span>
                          )}
                          {details.targetRoute && (
                            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-700">
                              Route: {details.targetRoute}
                            </span>
                          )}
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-700">
                            Captures: {details.captureCount}
                          </span>
                        </div>
                        <div className="mt-4 rounded-2xl bg-[#f8f3eb] px-4 py-4">
                          <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800">
                            {details.prompt ||
                              "No main prompt was submitted. This run is driven by capture notes only."}
                          </p>
                        </div>
                        {details.targetPageTitle && (
                          <p className="mt-3 text-xs text-slate-500">
                            Target page: {details.targetPageTitle}
                          </p>
                        )}
                      </div>

                      <div className="rounded-[24px] border border-[#e4dac9] bg-white p-5">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Capture Attachments
                            </p>
                            <h3 className="mt-2 font-headline text-xl text-slate-900">
                              Submitted visual references
                            </h3>
                          </div>
                          <span className="rounded-full bg-[#eef3ea] px-3 py-1 text-xs font-semibold text-[#446150]">
                            {details.captures.length} item(s)
                          </span>
                        </div>

                        {details.captures.length > 0 ? (
                          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {details.captures.map((capture) => {
                              const imageSrc = resolveCaptureImageUrl(
                                capture.imageUrl,
                              );
                              const capturedAtLabel = formatCapturedAt(
                                capture.capturedAt,
                              );

                              return (
                                <div
                                  key={capture.id}
                                  className="overflow-hidden rounded-[22px] border border-[#eadfce] bg-[#fcfaf6]"
                                >
                                  <div className="relative flex h-56 items-center justify-center bg-[#f2e8da]">
                                    {imageSrc ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          openCapturePreview({
                                            src: imageSrc,
                                            alt:
                                              capture.note ||
                                              `capture-${capture.id}`,
                                            note: capture.note,
                                            route:
                                              capture.pageRoute ||
                                              capture.sourcePageUrl,
                                            pageTitle: capture.pageTitle,
                                            capturedAt: capturedAtLabel,
                                          })
                                        }
                                        className="group h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                                      >
                                        <img
                                          src={imageSrc}
                                          alt={
                                            capture.note ||
                                            `capture-${capture.id}`
                                          }
                                          className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.02]"
                                        />
                                        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-3 py-3 text-white">
                                          <span className="text-[10px] font-semibold uppercase tracking-[0.16em]">
                                            Click to enlarge
                                          </span>
                                          <span className="material-symbols-outlined text-[18px]">
                                            open_in_full
                                          </span>
                                        </div>
                                      </button>
                                    ) : (
                                      <div className="px-6 text-center text-sm text-slate-500">
                                        This capture does not expose an image
                                        URL.
                                      </div>
                                    )}
                                  </div>
                                  <div className="space-y-3 px-4 py-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
                                        {capture.pageRoute ||
                                          capture.sourcePageUrl ||
                                          "Unknown route"}
                                      </span>
                                      {capture.tagName && (
                                        <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
                                          {capture.tagName}
                                        </span>
                                      )}
                                    </div>
                                    <div>
                                      <p className="text-sm font-semibold leading-6 text-slate-900">
                                        {capture.note ||
                                          "No capture note provided."}
                                      </p>
                                      {capture.pageTitle && (
                                        <p className="mt-1 text-xs text-slate-500">
                                          Page: {capture.pageTitle}
                                        </p>
                                      )}
                                    </div>
                                    {(capture.selector ||
                                      capture.nearestHeading ||
                                      capturedAtLabel) && (
                                      <div className="rounded-2xl bg-white px-3 py-3 text-xs leading-6 text-slate-600">
                                        {capture.nearestHeading && (
                                          <p>
                                            Nearest heading:{" "}
                                            {capture.nearestHeading}
                                          </p>
                                        )}
                                        {capture.selector && (
                                          <p className="break-all">
                                            Target: {capture.selector}
                                          </p>
                                        )}
                                        {capturedAtLabel && (
                                          <p>Captured at: {capturedAtLabel}</p>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="mt-5 rounded-2xl border border-dashed border-[#d8cbb7] bg-[#faf5ec] px-4 py-6 text-sm text-slate-600">
                            No capture attachments were submitted for this
                            request.
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {showMetrics && metricsView?.kind === "compare" && (
        <CompareMetricsModal
          view={metricsView}
          onClose={() => setShowMetrics(false)}
        />
      )}
      {activeCapturePreview && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          onClick={() => setActiveCapturePreview(null)}
        >
          <div
            className="relative w-full max-w-6xl overflow-hidden rounded-[28px] border border-white/15 bg-[#111111] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setActiveCapturePreview(null)}
              className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white transition hover:bg-black/65"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
            <div className="grid max-h-[90vh] min-h-[22rem] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-h-[18rem] items-center justify-center bg-black px-4 py-4">
                <img
                  src={activeCapturePreview.src}
                  alt={activeCapturePreview.alt}
                  className="max-h-[80vh] w-auto max-w-full rounded-2xl object-contain"
                />
              </div>
              <div className="flex flex-col gap-4 bg-[#171717] px-5 py-5 text-white/88">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/45">
                    Capture Preview
                  </p>
                  <p className="mt-3 text-base font-semibold leading-6 text-white">
                    {activeCapturePreview.note || "No capture note provided."}
                  </p>
                </div>
                <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-6">
                  {activeCapturePreview.pageTitle ? (
                    <p>
                      <span className="text-white/45">Page:</span>{" "}
                      {activeCapturePreview.pageTitle}
                    </p>
                  ) : null}
                  {activeCapturePreview.route ? (
                    <p className="break-all">
                      <span className="text-white/45">Route:</span>{" "}
                      {activeCapturePreview.route}
                    </p>
                  ) : null}
                  {activeCapturePreview.capturedAt ? (
                    <p>
                      <span className="text-white/45">Captured at:</span>{" "}
                      {activeCapturePreview.capturedAt}
                    </p>
                  ) : null}
                </div>
                <p className="text-xs text-white/45">
                  Press outside the modal or use the close button to return to the workflow view.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      {showMetrics && metricsView?.kind === "audit" && (
        <AuditMetricsModal
          view={metricsView}
          onClose={() => setShowMetrics(false)}
        />
      )}
      {showMetrics && metricsView?.kind === "raw" && (
        <RawMetricsModal
          view={metricsView}
          onClose={() => setShowMetrics(false)}
        />
      )}
    </div>
  );
};

export default SplitView;
