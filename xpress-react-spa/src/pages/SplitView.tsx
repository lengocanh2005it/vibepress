import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AiProcessError,
  applyPendingEditRequest,
  runAiProcess,
  skipPendingEditRequest,
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
  const [selectedStepEvent, setSelectedStepEvent] =
    useState<PipelineProgressEvent | null>(null);
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
  const previousPreviewStageRef = useRef<string | undefined>(undefined);
  const startedAtRef = useRef<number>(Date.now());

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

  const getStatusColor = (status: PipelineProgressEvent["status"]) => {
    switch (status) {
      case "done":
        return "text-green-500";
      case "running":
        return "text-primary animate-spin";
      case "stopped":
        return "text-red-500";
      case "skipped":
        return "text-white/30";
      case "error":
        return "text-red-500";
      case "pending":
      default:
        return "text-white/40";
    }
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
  const latestEvent = sse.currentEvent;
  const previewData = latestPreviewEvent?.data;
  const previewUrl =
    previewData?.previewUrl ?? completionEvent?.data?.previewUrl;
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
  const metricsData =
    deferredEditState.applied || editApplied
      ? undefined
      : latestMetricsEvent?.data?.metrics;
  const metricsView = useMemo(
    () => normalizeMetricsPayload(metricsData),
    [metricsData],
  );
  const showDeferredEditPrompt =
    Boolean(previousEditRequest) &&
    hasEditRequest &&
    ((editApprovalRequired && !editApplied && !deferredEditState.dismissed) ||
      deferredEditState.loading ||
      deferredEditState.completed);
  const terminalStopMessage =
    stoppedEvent?.message ??
    sse.error?.message ??
    "The AI pipeline was interrupted and this workflow has been stopped.";
  const hasStoppedWorkflow =
    sse.connectionState === "stopped" || Boolean(stoppedEvent);
  const isWorkflowStopped = !deleteState.done && hasStoppedWorkflow;

  const previewFrameSrc = useMemo(() => {
    if (!previewUrl) return "";
    const base = jobId ? `/preview/${jobId}/` : previewUrl;
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}livePreview=${previewRefreshNonce}`;
  }, [jobId, previewRefreshNonce, previewUrl]);

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
        title: "Preview is still being prepared",
        description: "The preview will appear here as soon as it starts.",
        badgeClass: "border-slate-300 bg-white text-slate-700",
      };
    }

    if (hasEditRequest && editApprovalRequired && !editApplied) {
      return {
        badge: previewStage === "final" ? "Approval Needed" : "Baseline Live",
        title:
          previewStage === "final"
            ? "Baseline preview is ready for approval"
            : "You are viewing the baseline preview",
        description:
          previewStage === "final"
            ? "The WordPress site has already been migrated to React. Review this baseline preview first, then decide whether the stored edit request should be applied."
            : "The WordPress site has already been migrated to React. The requested edit is stored separately and will only be applied after user approval.",
        badgeClass: "border-amber-300 bg-amber-50 text-amber-800",
      };
    }

    if (previewStage === "baseline") {
      return {
        badge: "Preview Live",
        title: "The preview is ready for inspection",
        description:
          "Frontend and backend preview servers are live while the pipeline continues with metrics and cleanup.",
        badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
      };
    }

    if (previewStage === "edited") {
      return {
        badge: "Edited Live",
        title: "Requested edits are now visible",
        description:
          "The running preview has been updated with the approved edit request.",
        badgeClass: "border-sky-300 bg-sky-50 text-sky-800",
      };
    }

    if (previewStage === "final" && editApplied) {
      return {
        badge: "Edited Final",
        title: "Approved edits are now applied",
        description:
          "The baseline React preview has been updated with the approved user edits.",
        badgeClass: "border-sky-300 bg-sky-50 text-sky-800",
      };
    }

    return {
      badge: "Final Ready",
      title: "The final baseline preview is ready",
      description:
        "Pipeline execution is complete. You can inspect the baseline preview and then decide whether to apply the stored edit request.",
      badgeClass: "border-emerald-300 bg-emerald-50 text-emerald-800",
    };
  }, [editApplied, editApprovalRequired, hasEditRequest, previewStage]);

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

  useEffect(() => {
    if (!deferredEditState.loading || !deferredEditState.decision) return;

    if (
      deferredEditState.decision === "apply" &&
      (editApplied || previewStage === "edited" || previewStage === "final")
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
    previewStage,
  ]);

  const isPipelineCompleted =
    sse.connectionState === "completed" || Boolean(completionEvent);
  const isWorkflowTerminal =
    isPipelineCompleted || isWorkflowStopped || deleteState.done;

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

  const handleDeletePipeline = async () => {
    setDeleteState({ loading: true, done: false });
    try {
      await fetch(`/ai-api/pipeline/delete/${jobId}`, { method: "POST" });
      sse.disconnect();
      setDeleteState({ loading: false, done: true });
      setShowStopConfirm(false);
    } catch {
      setDeleteState({ loading: false, done: false });
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

  const [pushGitState, setPushGitState] = useState<{
    loading: boolean;
    githubUrl: string | null;
    error: string | null;
  }>({ loading: false, githubUrl: null, error: null });

  const handlePushToGit = async () => {
    setPushGitState({ loading: true, githubUrl: null, error: null });
    try {
      const res = await fetch(
        `${import.meta.env.VITE_BACKEND_URL}/api/deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, siteId }),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Push failed");
      setPushGitState({
        loading: false,
        githubUrl: data.githubUrl,
        error: null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setPushGitState({ loading: false, githubUrl: null, error: message });
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
      hasEditRequest ||
      deferredEditState.loading ||
      deferredEditState.completed
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
            ? Math.max(existingEditStep?.percent ?? 0, 88)
            : deferredEditState.completed
              ? 100
              : existingEditStep?.percent ?? 80,
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
      .sort((a, b) => {
        const stepA = parseInt(a.step.split("_")[0]) || 0;
        const stepB = parseInt(b.step.split("_")[0]) || 0;
        return stepA - stepB;
      });
  }, [
    deferredEditState.completed,
    deferredEditState.decision,
    deferredEditState.loading,
    editApplied,
    editApprovalRequired,
    hasStoppedWorkflow,
    hasEditRequest,
    sse.allEvents,
    terminalStopMessage,
  ]);

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
              {isWorkflowStopped && !deleteState.done && (
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
              {sse.isConnected && !deleteState.done && !isWorkflowStopped && (
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
          {isWorkflowStopped && (
            <div className="rounded-xl border border-red-300/70 bg-red-50 p-4 text-red-900">
              <p className="text-[11px] uppercase tracking-[0.18em] text-red-500/80">
                Pipeline Stopped
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

          {stepStatuses.map((event) => (
            <button
              key={event.step}
              type="button"
              onClick={() => setSelectedStepEvent(event)}
              className="group flex w-full items-start gap-3 rounded-2xl border border-transparent bg-white/25 px-3 py-3 text-left transition hover:border-[#d9d1c3] hover:bg-white/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              <span
                className={`material-symbols-outlined mt-0.5 text-lg ${getStatusColor(event.status)}`}
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                {getStatusIcon(event.status)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-green-700 transition group-hover:text-green-800">
                    {event.label}
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
              </div>
            </button>
          ))}

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
                    Metrics Ready
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
                            : "Applying the stored edit request…"
                          : deferredEditState.completed
                            ? deferredEditState.decision === "skip"
                              ? "Baseline preview confirmed"
                              : "Approved edits applied"
                            : "Apply the stored edit request?"}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {deferredEditState.loading
                          ? deferredEditState.decision === "skip"
                            ? "The backend has resumed the pipeline and is continuing without the pending edit request."
                            : "The backend has resumed the pipeline and is now applying the approved edit request to the running preview."
                          : deferredEditState.completed
                            ? deferredEditState.decision === "skip"
                              ? "The user chose to continue with the baseline preview. Requested edit handling is complete."
                              : "The approved edit request has been accepted and applied to the live preview."
                            : "You are currently viewing the baseline React migration. The requested edits have not been applied yet."}
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
                              <div className="mt-3 space-y-3">
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
                                    className="overflow-hidden rounded-2xl border border-amber-100 bg-[#fffaf2]"
                                  >
                                    <div className="flex gap-3 p-3">
                                      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#f6e8cf]">
                                        {imageSrc ? (
                                          <img
                                            src={imageSrc}
                                            alt={
                                              capture.note ||
                                              `capture-${capture.id}`
                                            }
                                            className="h-full w-full object-cover"
                                          />
                                        ) : (
                                          <span className="material-symbols-outlined text-[20px] text-amber-700">
                                            image
                                          </span>
                                        )}
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-700">
                                            Capture {index + 1}
                                          </span>
                                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                                            {pageRoute}
                                          </span>
                                          {tagName ? (
                                            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                                              {tagName}
                                            </span>
                                          ) : null}
                                        </div>
                                        <p className="mt-2 text-sm font-semibold leading-5 text-slate-900">
                                          {capture.note ||
                                            "No capture note was provided."}
                                        </p>
                                        {pageTitle ? (
                                          <p className="mt-1 text-[11px] text-slate-500">
                                            Page: {pageTitle}
                                          </p>
                                        ) : null}
                                        {(nearestHeading ||
                                          selector ||
                                          capturedAtLabel) && (
                                          <div className="mt-2 rounded-xl bg-white px-3 py-2 text-[11px] leading-5 text-slate-600">
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
                                  </div>
                                );
                                })}
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
                  onClick={() => window.open(jobId ? `/preview/${jobId}/` : previewUrl, "_blank")}
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
                {completionEvent &&
                  (pushGitState.githubUrl ? (
                    <button
                      onClick={() =>
                        window.open(pushGitState.githubUrl!, "_blank")
                      }
                      className={`${actionButtonClass} border-slate-950 bg-slate-900 text-white hover:bg-black focus-visible:ring-slate-500`}
                    >
                      View on GitHub
                    </button>
                  ) : (
                    <button
                      onClick={handlePushToGit}
                      disabled={pushGitState.loading}
                      className={`${actionButtonClass} border-slate-950 bg-slate-900 text-white hover:bg-black focus-visible:ring-slate-500 disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {pushGitState.loading ? "Pushing…" : "Push to GitHub"}
                    </button>
                  ))}
              </div>
              {pushGitState.error && (
                <p className="mt-3 text-xs text-red-700">
                  {pushGitState.error}
                </p>
              )}
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
            <div className="flex shrink-0 items-center justify-end">
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
          ) : isWorkflowStopped ? (
            <div className="max-w-lg text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto">
                <span
                  className="material-symbols-outlined text-red-400 text-3xl"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  stop_circle
                </span>
              </div>
              <p className="text-on-surface font-medium">Pipeline đã dừng</p>
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
                      Metrics Ready
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
                  Tất cả tiến trình đang chạy sẽ bị dừng và preview/artifacts
                  hiện tại sẽ bị xóa.
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
                onClick={handleDeletePipeline}
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
                          className={`material-symbols-outlined text-2xl ${getStatusColor(selectedStepEvent.status)}`}
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          {getStatusIcon(selectedStepEvent.status)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${getStatusBadgeClass(selectedStepEvent.status)}`}
                          >
                            {getStatusLabel(selectedStepEvent.status)}
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
                            "This workflow step does not expose extra structured details yet."}
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
                          <div className="mt-5 grid gap-4 md:grid-cols-2">
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
                                  <div className="flex h-56 items-center justify-center bg-[#f2e8da]">
                                    {imageSrc ? (
                                      <img
                                        src={imageSrc}
                                        alt={
                                          capture.note ||
                                          `capture-${capture.id}`
                                        }
                                        className="h-full w-full object-contain"
                                      />
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
