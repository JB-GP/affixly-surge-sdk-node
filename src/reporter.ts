import { getConfig } from './config.js';
import { estimateCost, type Provider } from './pricing.js';
import { logger, truncate } from './utils.js';

const MAX_WORKERS = 4;
const REQUEST_TIMEOUT_MS = 5000;

export interface UsageEventPayload {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  requests: 1;
  product_line: string | null;
  feature: string | null;
  customer_id: string | null;
}

interface PendingJob {
  url: string;
  apiKey: string | null;
  payload: UsageEventPayload;
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
        logger.debug('Surge event report failed', err);
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

    const response = await fetch(`${job.url.replace(/\/+$/, '')}/api/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(job.payload),
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.debug(`Surge event report returned status ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function reportUsage(
  provider: Provider | string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  tags?: Record<string, string> | null,
): void {
  const cfg = getConfig();
  if (!cfg.surgeApiUrl) return;

  const cost = estimateCost(provider, model, inputTokens, outputTokens);
  if (!Number.isFinite(cost)) {
    logger.warn(`Cost estimate is not finite (model=${model}), skipping report`);
    return;
  }

  const mergedTags: Record<string, string> = { ...cfg.defaultTags, ...(tags ?? {}) };

  const payload: UsageEventPayload = {
    provider: truncate(provider) ?? '',
    model: truncate(model) ?? '',
    input_tokens: Math.trunc(inputTokens || 0),
    output_tokens: Math.trunc(outputTokens || 0),
    cost_usd: Number(cost.toFixed(6)),
    requests: 1,
    product_line: truncate(cfg.productLine),
    feature: truncate(mergedTags['feature']),
    customer_id: truncate(mergedTags['customer_id']),
  };

  const job: PendingJob = {
    url: cfg.surgeApiUrl,
    apiKey: cfg.surgeApiKey,
    payload,
  };

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
