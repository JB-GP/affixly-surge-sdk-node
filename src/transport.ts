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
