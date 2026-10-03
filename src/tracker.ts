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
  sendTrack(event, tenant, properties);
}

/** track() with an optional per-event `product`; falls back to `productLine`. */
function sendTrack(
  event: string,
  tenant: string,
  properties?: Record<string, unknown>,
  product?: string | null,
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
    product: product || cfg.productLine,
    properties: properties ?? {},
  };

  enqueue({
    url: cfg.surgeApiUrl,
    path: '/api/track',
    apiKey: cfg.surgeApiKey,
    payload,
  });
}

/**
 * Report a quota event to Surge (spec §1.5) — a convenience wrapper around
 * {@link track} for the other products to use.
 *
 * `kind` is `'ceiling_hit'` or `'limit_hit'` (or a full `'quota.*'` event name).
 * The event is scoped/named by `customerId`. `plan` plus any extra `fields`
 * (`spend_usd`, `ceiling_usd`, `unit`, `used`, `limit`, …) are passed through as
 * event properties; null/undefined values are dropped. Fire-and-forget.
 *
 * @example
 * trackQuotaEvent('ceiling_hit', 'forge', 'cust_42', 'maker',
 *   { spend_usd: 9.12, ceiling_usd: 9.0 });
 */
export function trackQuotaEvent(
  kind: 'ceiling_hit' | 'limit_hit' | string,
  productLine: string,
  customerId: string,
  plan?: string | null,
  fields: Record<string, unknown> = {},
): void {
  const event = String(kind).startsWith('quota.') ? kind : `quota.${kind}`;
  const properties: Record<string, unknown> = {
    product_line: productLine,
    customer_id: customerId,
    plan,
    ...fields,
  };
  for (const key of Object.keys(properties)) {
    if (properties[key] === undefined || properties[key] === null) delete properties[key];
  }
  // The event's top-level `product` is this productLine, not only the globally
  // configured one, so a shared service reporting quota events for several
  // products attributes each to the right product.
  sendTrack(event, String(customerId ?? productLine ?? 'unknown'), properties, productLine);
}
