import { getConfig } from './config.js';
import { logger } from './utils.js';
import { enqueue } from './transport.js';

export interface TrackEventPayload {
  event: string;
  tenant: string;
  product: string | null;
  properties: Record<string, unknown>;
}

/**
 * Record a product event for the configured product line.
 *
 * Fire-and-forget: returns synchronously, POSTs `{event, tenant, product,
 * properties}` to `${surgeApiUrl}/api/track` on a later tick, and never throws
 * to the caller. `product` is taken from the globally configured `productLine`.
 *
 * @param event       Event name, e.g. `'parse.repo.connected'`.
 * @param tenant      Stable identifier for the acting tenant/user.
 * @param properties  Optional arbitrary event metadata.
 *
 * @example
 * track('parse.repo.connected', 'octocat', { repo: 'owner/repo', language: 'python' });
 */
export function track(
  event: string,
  tenant: string,
  properties?: Record<string, unknown>,
): void {
  const cfg = getConfig();
  if (!cfg.surgeApiUrl) {
    logger.warn(
      'track() called before configure(); event dropped. ' +
        'Call configure({ surgeApiUrl, surgeApiKey, productLine }) first.',
    );
    return;
  }

  const payload: TrackEventPayload = {
    event,
    tenant,
    product: cfg.productLine,
    properties: properties ?? {},
  };

  enqueue({
    url: cfg.surgeApiUrl,
    path: '/api/track',
    apiKey: cfg.surgeApiKey,
    payload,
  });
}
