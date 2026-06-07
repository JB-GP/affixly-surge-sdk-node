import { getConfig } from './config.js';
import { estimateCost, type Provider } from './pricing.js';
import { logger, truncate } from './utils.js';
import { enqueue } from './transport.js';

// Re-exported so existing test imports (`from '../src/reporter.js'`) keep working
// now that the queue machinery lives in transport.ts.
export { _flushForTests } from './transport.js';

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
  requested_model?: string;
  requested_cost_usd?: number;
}

export function reportUsage(
  provider: Provider | string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  tags?: Record<string, string> | null,
  requestedModel?: string,
  costOverride?: number,
): void {
  const cfg = getConfig();
  if (!cfg.surgeApiUrl) return;

  // costOverride lets callers (e.g. the audio/transcription path) supply a
  // precomputed cost that isn't token-based; otherwise estimate from tokens.
  const cost =
    costOverride !== undefined ? costOverride : estimateCost(provider, model, inputTokens, outputTokens);
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

  if (requestedModel) {
    const requestedCost = estimateCost(provider, requestedModel, inputTokens, outputTokens);
    if (Number.isFinite(requestedCost)) {
      const truncated = truncate(requestedModel);
      if (truncated !== null) {
        payload.requested_model = truncated;
        payload.requested_cost_usd = Number(requestedCost.toFixed(6));
      }
    }
  }

  enqueue({
    url: cfg.surgeApiUrl,
    path: '/api/events',
    apiKey: cfg.surgeApiKey,
    payload,
  });
}
