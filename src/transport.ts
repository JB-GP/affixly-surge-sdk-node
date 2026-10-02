import { logger } from './utils.js';

const MAX_WORKERS = 4;
const REQUEST_TIMEOUT_MS = 5000;

export interface PendingJob {
  /** Configured surge base URL (trailing slashes are stripped before send). */
  url: string;
  /** Endpoint path appended to the base URL, e.g. `/api/events` or `/api/track`. */
  path: string;
  apiKey: string | null;
  payload: unknown;
}

const queue: PendingJob[] = [];
const inFlight = new Set<Promise<void>>();
let exitHookRegistered = false;

// Warn at most once per process when the backend signals the event quota is
// exceeded (X-Surge-Quota: exceeded). Delivery just stops counting server-side;
// we never throw.
let quotaWarned = false;
function noteQuotaExceeded(): void {
  if (quotaWarned) return;
  quotaWarned = true;
  logger.warn(
    "Surge: event quota exceeded for this period — new events are being dropped " +
      "server-side and won't appear on your dashboard. Reported once per process; " +
      "never throws. Upgrade the plan to resume ingestion.",
  );
}

// Opt-in diagnostics. Surge never throws on a reporting failure; register a
// handler to observe dropped reports (e.g. bump a metric) without changing that.
let onReportError: ((err: unknown) => void) | null = null;

/** Opt in to reporting diagnostics without changing failure behavior. */
export function setDiagnostics(opts: { onReportError?: ((err: unknown) => void) | null }): void {
  onReportError = opts.onReportError ?? null;
}

function emitReportError(err: unknown): void {
  if (!onReportError) return;
  try {
    onReportError(err);
  } catch {
    logger.debug('Surge onReportError handler threw; ignored');
  }
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.on('beforeExit', () => {
    drain();
  });
}

function drain(): void {
  while (queue.length > 0 && inFlight.size < MAX_WORKERS) {
    const job = queue.shift()!;
    const p = sendJob(job)
      .catch((err) => {
        logger.debug('Surge report failed', err);
        emitReportError(err);
      })
      .finally(() => {
        inFlight.delete(p);
        if (queue.length > 0) drain();
      });
    inFlight.add(p);
  }
}

async function sendJob(job: PendingJob): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (job.apiKey) headers['Authorization'] = `Bearer ${job.apiKey}`;

    const response = await fetch(`${job.url.replace(/\/+$/, '')}${job.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(job.payload),
      redirect: 'error',
      signal: controller.signal,
    });

    if (response.headers.get('X-Surge-Quota') === 'exceeded') {
      noteQuotaExceeded();
    }
    if (!response.ok) {
      logger.debug(`Surge report to ${job.path} returned status ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire-and-forget enqueue. Returns synchronously; the actual POST happens on a
 * later tick (via setImmediate) and is bounded to MAX_WORKERS concurrent sends.
 * A process `beforeExit` hook drains the queue so events survive a short-lived
 * process that schedules a report and exits immediately.
 */
export function enqueue(job: PendingJob): void {
  registerExitHook();
  setImmediate(() => {
    queue.push(job);
    drain();
  });
}

export async function _flushForTests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  while (queue.length > 0 || inFlight.size > 0) {
    if (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Await until queued usage/track reports have been sent, or `timeoutMs` elapses.
 * Resolves `true` if everything drained, `false` on timeout.
 *
 * Call this at the end of a serverless invocation or before a short-lived
 * script exits, where the automatic `beforeExit` drain may not run (e.g. the
 * platform freezes the process between invocations).
 */
export async function flush(timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  // Let any synchronous enqueue()s land on the queue first.
  await new Promise((resolve) => setImmediate(resolve));
  while (queue.length > 0 || inFlight.size > 0) {
    if (deadline !== undefined && Date.now() >= deadline) return false;
    if (inFlight.size > 0) {
      const settle = Promise.allSettled(Array.from(inFlight));
      if (deadline !== undefined) {
        await Promise.race([
          settle,
          new Promise((resolve) => setTimeout(resolve, Math.max(deadline - Date.now(), 0))),
        ]);
      } else {
        await settle;
      }
    } else {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return true;
}
