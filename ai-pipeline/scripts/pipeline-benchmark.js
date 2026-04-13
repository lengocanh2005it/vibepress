const fs = require('fs/promises');
const path = require('path');

loadEnvFile(path.resolve(__dirname, '..', '.env'));

const DEFAULTS = {
  runs: readEnvNumber('BENCHMARK_RUNS', 10),
  concurrency: readEnvNumber('BENCHMARK_CONCURRENCY', 1),
  siteId: readEnvString('BENCHMARK_SITE_ID', 'wp-1776064736747-8eb93302'),
  pipelineBaseUrl: readEnvString(
    'BENCHMARK_PIPELINE_BASE_URL',
    `http://localhost:${readEnvString('PORT', '3001')}`,
  ),
  pollMs: readEnvNumber('BENCHMARK_POLL_MS', 5000),
  label: readEnvString('BENCHMARK_LABEL', 'full-site'),
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    ...DEFAULTS,
    ...args,
  };

  await ensureServer(config.pipelineBaseUrl);

  const startedAt = new Date().toISOString();
  const runIndexes = Array.from(
    { length: config.runs },
    (_, index) => index + 1,
  );
  const results = await runWithConcurrency(
    runIndexes,
    config.concurrency,
    (runIndex) => executeBenchmarkRun(runIndex, config),
  );
  const aggregate = summarizeRuns(results);
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    aggregate,
    runs: results,
  };

  const reportDir = path.join(process.cwd(), 'temp', 'benchmarks');
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `benchmark-${Date.now()}-${sanitizeName(config.label)}.json`,
  );
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  printSummary(reportPath, results, aggregate);
}

async function executeBenchmarkRun(runIndex, config) {
  const payload = {
    siteId: config.siteId,
  };
  if (config.prompt) {
    payload.editRequest = {
      prompt: config.prompt,
      language: config.language || 'vi',
    };
  }

  const startTime = Date.now();
  const runResponse = await fetchJson(
    `${config.pipelineBaseUrl}/pipeline/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  const jobId = runResponse.jobId;
  const status = await waitForJob(jobId, config);
  const finishedAt = Date.now();
  const summary = await buildRunSummary({
    runIndex,
    jobId,
    status,
    startedAtMs: startTime,
    finishedAtMs: finishedAt,
  });
  return summary;
}

async function waitForJob(jobId, config) {
  for (;;) {
    const status = await fetchJson(
      `${config.pipelineBaseUrl}/pipeline/status/${jobId}`,
    );
    if (
      status.status === 'done' ||
      status.status === 'error' ||
      status.status === 'stopped' ||
      status.status === 'deleted'
    ) {
      return status;
    }
    await sleep(config.pollMs);
  }
}

async function buildRunSummary(input) {
  const { runIndex, jobId, status, startedAtMs, finishedAtMs } = input;
  const logRoot = path.join(process.cwd(), 'temp', 'logs', jobId);
  const pipelineLog = await readOptionalText(
    path.join(logRoot, 'pipeline.log'),
  );
  const tokenSummary = await readOptionalJson(
    path.join(logRoot, 'tokens', 'summary.tokens.json'),
  );
  const aiIndex = await readJsonLines(
    path.join(logRoot, 'ai-logs', 'index.jsonl'),
  );

  const stepDurations = parseStepDurations(pipelineLog);
  const pipelineDurationSec =
    parsePipelineDurationSeconds(pipelineLog) ??
    Number(((finishedAtMs - startedAtMs) / 1000).toFixed(1));
  const metrics = status.result?.metrics ?? null;
  const tokens = tokenSummary?.totals ?? null;
  const aiSummary = summarizeAiIndex(aiIndex);

  return {
    runIndex,
    jobId,
    success: status.status === 'done',
    finalStatus: status.status,
    error: status.error ?? null,
    pipelineDurationSec,
    planDurationSec: stepDurations['5_planner'] ?? null,
    genDurationSec: stepDurations['6_generator'] ?? null,
    retryCount: aiSummary.retryCount + parseBuildFixRetries(pipelineLog),
    retryBreakdown: {
      planning: aiSummary.byStep.planning ?? 0,
      codeGeneration: aiSummary.byStep['code-generation'] ?? 0,
      sectionGeneration: aiSummary.byStep['section-generation'] ?? 0,
      buildFix: parseBuildFixRetries(pipelineLog),
    },
    accuracy: extractAccuracy(metrics),
    visualPassRate: metrics?.summary?.overall?.visualPassRate ?? null,
    contentAccuracy: metrics?.summary?.overall?.contentAvgOverall ?? null,
    tokenUsage: tokens
      ? {
          input: tokens.inputTokens,
          output: tokens.outputTokens,
          total: tokens.totalTokens,
          costUsd: tokens.costUsd,
          calls: tokens.calls,
        }
      : null,
    subjectiveUiAssessment: buildSubjectiveUiAssessment(metrics),
    previewUrl: status.result?.previewUrl ?? null,
    metrics,
  };
}

function summarizeAiIndex(entries) {
  const summary = {
    retryCount: 0,
    byStep: {},
  };
  for (const entry of entries) {
    if (entry.kind !== 'cot') continue;
    const retryCount = Number(entry.retryCount || 0);
    summary.retryCount += retryCount;
    summary.byStep[entry.step] = (summary.byStep[entry.step] || 0) + retryCount;
  }
  return summary;
}

function extractAccuracy(metrics) {
  return metrics?.summary?.overall?.visualAvgAccuracy ?? null;
}

function buildSubjectiveUiAssessment(metrics) {
  const visualAccuracy = metrics?.summary?.overall?.visualAvgAccuracy;
  const visualPassRate = metrics?.summary?.overall?.visualPassRate;
  const contentAccuracy = metrics?.summary?.overall?.contentAvgOverall;

  if (
    typeof visualAccuracy !== 'number' ||
    typeof visualPassRate !== 'number'
  ) {
    return {
      rating: 'khong-du-du-lieu',
      note: 'Automation metrics khong du de danh gia cam tinh giao dien.',
    };
  }

  if (visualAccuracy >= 95 && visualPassRate >= 90) {
    return {
      rating: 'rat-tot',
      note: 'Mat bang giao dien kha sat nguon WP, sai lech visual nho va pass rate cao.',
    };
  }

  if (visualAccuracy >= 90 && visualPassRate >= 75) {
    return {
      rating: 'tot',
      note: 'Giao dien da on, con mot so route lech nhung tong the van gan voi nguon.',
    };
  }

  if (visualAccuracy >= 82) {
    return {
      rating: 'tam-duoc',
      note: 'Giao dien dung huong nhung van con drift ro o spacing/typography/bo-cuc tren mot so route.',
    };
  }

  return {
    rating: 'yeu',
    note: `UI drift con lon${typeof contentAccuracy === 'number' ? `; visual=${visualAccuracy.toFixed(2)}%, content=${contentAccuracy.toFixed(2)}%` : ''}. Nen review lai output va visual-fix loop.`,
  };
}

function summarizeRuns(runs) {
  const successful = runs.filter((run) => run.success);
  return {
    totalRuns: runs.length,
    successCount: successful.length,
    failedCount: runs.length - successful.length,
    avgPlanDurationSec: average(runs.map((run) => run.planDurationSec)),
    avgGenDurationSec: average(runs.map((run) => run.genDurationSec)),
    avgPipelineDurationSec: average(runs.map((run) => run.pipelineDurationSec)),
    avgAccuracy: average(runs.map((run) => run.accuracy)),
    avgRetries: average(runs.map((run) => run.retryCount)),
    avgTokens: average(runs.map((run) => run.tokenUsage?.total)),
    totalTokenCostUsd: Number(
      runs
        .reduce((sum, run) => sum + Number(run.tokenUsage?.costUsd || 0), 0)
        .toFixed(6),
    ),
  };
}

function parseStepDurations(logText) {
  const durations = {};
  if (!logText) return durations;
  for (const match of logText.matchAll(/Step ([^ ]+) done \(([\d.]+)s\)/g)) {
    durations[match[1]] = Number(match[2]);
  }
  return durations;
}

function parsePipelineDurationSeconds(logText) {
  if (!logText) return null;
  const match = logText.match(/Pipeline completed — total ([\d.]+)s/);
  return match ? Number(match[1]) : null;
}

function parseBuildFixRetries(logText) {
  if (!logText) return 0;
  return (logText.match(/Attempting auto-fix \(attempt \d+\/\d+\)/g) || [])
    .length;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    for (;;) {
      const currentIndex = cursor++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Number(concurrency) || 1) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}

async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return data;
}

async function ensureServer(baseUrl) {
  try {
    await fetchJson(`${baseUrl}/pipeline/status/healthcheck`);
  } catch (error) {
    throw new Error(
      `AI pipeline server is not reachable at ${baseUrl}. Start ai-pipeline before running the benchmark. ${error.message}`,
    );
  }
}

function loadEnvFile(filePath) {
  const loadEnv = process.loadEnvFile;
  if (typeof loadEnv === 'function') {
    try {
      loadEnv(filePath);
      return;
    } catch {
      return;
    }
  }

  try {
    const raw = require('fs').readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
      );
      if (!match) continue;

      const [, key, value] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = stripEnvQuotes(value.trim());
    }
  } catch {
    // Ignore missing .env for local utility usage.
  }
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvString(key, fallback) {
  const value = process.env[key]?.trim();
  return value ? value : fallback;
}

function readEnvNumber(key, fallback) {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonLines(filePath) {
  const text = await readOptionalText(filePath);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function printSummary(reportPath, runs, aggregate) {
  console.log(`Benchmark report: ${reportPath}`);
  for (const run of runs) {
    console.log(
      [
        `run=${run.runIndex}`,
        `job=${run.jobId}`,
        `status=${run.success ? 'success' : 'failed'}`,
        `retries=${run.retryCount}`,
        `accuracy=${formatNumber(run.accuracy)}`,
        `plan=${formatNumber(run.planDurationSec)}s`,
        `gen=${formatNumber(run.genDurationSec)}s`,
        `tokens=${formatNumber(run.tokenUsage?.total)}`,
        `ui=${run.subjectiveUiAssessment.rating}`,
      ].join(' | '),
    );
  }

  console.log(
    [
      `summary runs=${aggregate.totalRuns}`,
      `success=${aggregate.successCount}`,
      `failed=${aggregate.failedCount}`,
      `avgAccuracy=${formatNumber(aggregate.avgAccuracy)}`,
      `avgPlan=${formatNumber(aggregate.avgPlanDurationSec)}s`,
      `avgGen=${formatNumber(aggregate.avgGenDurationSec)}s`,
      `avgRetries=${formatNumber(aggregate.avgRetries)}`,
      `avgTokens=${formatNumber(aggregate.avgTokens)}`,
      `totalCostUsd=${formatNumber(aggregate.totalTokenCostUsd)}`,
    ].join(' | '),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value =
      argv[index + 1] && !argv[index + 1].startsWith('--')
        ? argv[++index]
        : 'true';
    parsed[toCamelCase(key)] = maybeNumber(value);
  }
  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function maybeNumber(value) {
  if (value === 'true' || value === 'false') return value === 'true';
  const numeric = Number(value);
  return Number.isFinite(numeric) && String(numeric) === String(value)
    ? numeric
    : value;
}

function average(values) {
  const filtered = values.filter((value) => typeof value === 'number');
  if (filtered.length === 0) return null;
  return Number(
    (filtered.reduce((sum, value) => sum + value, 0) / filtered.length).toFixed(
      2,
    ),
  );
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}

function sanitizeName(value) {
  return String(value || 'benchmark')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
