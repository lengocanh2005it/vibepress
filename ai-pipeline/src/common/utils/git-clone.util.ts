import { mkdir, rm } from 'fs/promises';
import simpleGit from 'simple-git';

type CloneLogger = Pick<Console, 'log' | 'warn'>;

interface CloneCandidate {
  cloneUrl: string;
  label: string;
}

export interface GitCloneWithRetryOptions {
  repoUrl: string;
  destDir: string;
  token?: string;
  logger?: CloneLogger;
  label?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  cloneArgs?: string[];
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1500;

export async function cloneRepoWithRetry(
  options: GitCloneWithRetryOptions,
): Promise<void> {
  const {
    repoUrl,
    destDir,
    token,
    logger,
    label = 'git clone',
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    cloneArgs = ['--depth', '1'],
  } = options;

  const safeRepoUrl = redactGitCredential(repoUrl);
  const cloneCandidates = buildCloneCandidates(repoUrl, token);

  let lastError: unknown;
  for (
    let candidateIndex = 0;
    candidateIndex < cloneCandidates.length;
    candidateIndex++
  ) {
    const candidate = cloneCandidates[candidateIndex];
    const hasNextCandidate = candidateIndex < cloneCandidates.length - 1;

    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        await rm(destDir, { recursive: true, force: true });
        await mkdir(destDir, { recursive: true });
        if (attempt > 1) {
          logger?.log?.(
            `[${label}] retrying clone ${attempt}/${maxAttempts} via ${candidate.label}: ${safeRepoUrl} → ${destDir}`,
          );
        }
        await simpleGit()
          .env('GIT_TERMINAL_PROMPT', '0')
          .env('GCM_INTERACTIVE', 'Never')
          .clone(candidate.cloneUrl, destDir, cloneArgs);
        return;
      } catch (error) {
        lastError = error;
        const message = getErrorMessage(error);
        const retryable = isRetryableGitCloneError(message);
        const hasNextAttempt = attempt < Math.max(1, maxAttempts);
        if (!retryable) {
          if (hasNextCandidate) {
            logger?.warn?.(
              `[${label}] clone failed via ${candidate.label}: ${message} — trying next credential source`,
            );
            break;
          }
          throw error;
        }
        if (!hasNextAttempt) {
          if (hasNextCandidate) {
            logger?.warn?.(
              `[${label}] exhausted retries via ${candidate.label}: ${message} — trying next credential source`,
            );
            break;
          }
          throw error;
        }

        const delayMs = computeBackoffDelay(baseDelayMs, attempt);
        logger?.warn?.(
          `[${label}] transient clone failure on attempt ${attempt}/${maxAttempts} via ${candidate.label}: ${message} — retrying in ${delayMs}ms`,
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function buildCloneCandidates(
  repoUrl: string,
  explicitToken?: string,
): CloneCandidate[] {
  const candidates: CloneCandidate[] = [];
  const tokens = [
    { value: explicitToken, label: 'request token' },
    {
      value: process.env.GITHUB_WP_REPO_TOKEN,
      label: 'env GITHUB_WP_REPO_TOKEN',
    },
    {
      value: process.env.GITHUB_REACT_REPO_TOKEN,
      label: 'env GITHUB_REACT_REPO_TOKEN',
    },
  ]
    .map((entry) => ({
      ...entry,
      value: entry.value?.trim(),
    }))
    .filter(
      (entry): entry is { value: string; label: string } => !!entry.value,
    );

  const seen = new Set<string>();
  for (const entry of tokens) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    candidates.push({
      cloneUrl: injectTokenIntoRepoUrl(repoUrl, entry.value),
      label: entry.label,
    });
  }

  candidates.push({ cloneUrl: repoUrl, label: 'no token' });
  return candidates;
}

function injectTokenIntoRepoUrl(repoUrl: string, token: string): string {
  if (!/^https:\/\//i.test(repoUrl)) return repoUrl;
  return repoUrl.replace(
    /^https:\/\//i,
    `https://${encodeURIComponent(token)}@`,
  );
}

function computeBackoffDelay(baseDelayMs: number, attempt: number): number {
  const safeBase = Math.max(250, baseDelayMs);
  const jitter = Math.floor(Math.random() * 250);
  return safeBase * 2 ** (attempt - 1) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  const raw =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : String(error ?? '');
  return redactGitCredential(raw);
}

function redactGitCredential(value: string): string {
  return value.replace(/https:\/\/[^@\s]+@/gi, 'https://***@');
}

function isRetryableGitCloneError(message: string): boolean {
  const normalized = message.toLowerCase();

  const nonRetryableMarkers = [
    'authentication failed',
    'repository not found',
    'not found',
    'access denied',
    'permission denied',
    'could not read username',
    'could not read password',
    'invalid username or password',
    'remote: invalid username or token',
    'remote: repository not found',
    'fatal: repository',
    'support for password authentication was removed',
  ];
  if (nonRetryableMarkers.some((marker) => normalized.includes(marker))) {
    return false;
  }

  const retryableMarkers = [
    'rpc failed',
    'http 500',
    'http 502',
    'http 503',
    'http 504',
    'the requested url returned error: 500',
    'the requested url returned error: 502',
    'the requested url returned error: 503',
    'the requested url returned error: 504',
    'expected flush after ref listing',
    'remote end hung up unexpectedly',
    'connection reset',
    'connection was reset',
    'failed to connect',
    'timed out',
    'timeout',
    'tls',
    'ssl',
    'gnutls',
    'temporary failure',
    'internal server error',
    'early eof',
    'could not resolve host',
    'unable to access',
  ];

  return retryableMarkers.some((marker) => normalized.includes(marker));
}
