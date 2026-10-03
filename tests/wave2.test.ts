import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configure, _resetConfigForTests } from '../src/config.js';
import { reportUsage, _flushForTests } from '../src/reporter.js';
import { track, trackQuotaEvent } from '../src/tracker.js';
import { flush, setDiagnostics } from '../src/transport.js';

function bodyOf(call: any): any {
  return JSON.parse(call[1].body);
}

describe('wave2 — plan tag, trackQuotaEvent, quota header, flush, diagnostics', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetConfigForTests();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setDiagnostics({ onReportError: null });
  });

  afterEach(async () => {
    await _flushForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetConfigForTests();
    setDiagnostics({ onReportError: null });
  });

  it('forwards the plan tag on usage events', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    reportUsage('anthropic', 'claude-sonnet-4-6', 100, 50, {
      feature: 'gen',
      customer_id: 'cust_42',
      plan: 'maker',
    });
    await _flushForTests();
    const payload = bodyOf(fetchMock.mock.calls[0]);
    expect(payload.plan).toBe('maker');
    expect(payload.feature).toBe('gen');
    expect(payload.customer_id).toBe('cust_42');
  });

  it('trackQuotaEvent posts quota.ceiling_hit naming product/account/plan', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    trackQuotaEvent('ceiling_hit', 'forge', 'cust_42', 'maker', {
      spend_usd: 9.12,
      ceiling_usd: 9.0,
    });
    await _flushForTests();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/track');
    const payload = JSON.parse(init.body);
    expect(payload.event).toBe('quota.ceiling_hit');
    expect(payload.tenant).toBe('cust_42');
    expect(payload.properties).toEqual({
      product_line: 'forge',
      customer_id: 'cust_42',
      plan: 'maker',
      spend_usd: 9.12,
      ceiling_usd: 9.0,
    });
  });

  it('trackQuotaEvent drops null/undefined properties', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    trackQuotaEvent('limit_hit', 'parse', 'cust_1'); // no plan, no extra fields
    await _flushForTests();
    const payload = bodyOf(fetchMock.mock.calls[0]);
    expect(payload.event).toBe('quota.limit_hit');
    expect(payload.properties).toEqual({ product_line: 'parse', customer_id: 'cust_1' });
  });

  it('warns once per process on X-Surge-Quota: exceeded and never throws', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    fetchMock.mockResolvedValue(
      new Response(null, { status: 202, headers: { 'X-Surge-Quota': 'exceeded' } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => {
      reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1, { plan: 'free' });
      reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1, { plan: 'free' });
    }).not.toThrow();
    await _flushForTests();
    const quotaWarns = warn.mock.calls.filter((c) => String(c[0]).includes('event quota exceeded'));
    expect(quotaWarns.length).toBe(1);
    warn.mockRestore();
  });

  it('flush() resolves true once reports drain', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    track('x.happened', 'cust_1', { a: 1 });
    reportUsage('openai', 'gpt-4o', 5, 5, { plan: 'pro' });
    const ok = await flush(2000);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('flush(timeout) leaves no pending timer once reports drain', async () => {
    // A leftover deadline timer keeps the event loop alive, so a short-lived
    // script that awaits flush(30000) would hang ~30s before exiting.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
      // Hold the request open so flush() must take its deadline-race path.
      let release!: () => void;
      fetchMock.mockImplementationOnce(
        () => new Promise((r) => { release = () => r(new Response(null, { status: 200 })); }),
      );
      track('x.happened', 'cust_1');
      const pending = flush(30_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      release();
      const ok = await pending;
      expect(ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('trackQuotaEvent sends product = productLine, not the configured one', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'shared-svc' });
    trackQuotaEvent('limit_hit', 'parse', 'cust_1', 'pro');
    track('other.event', 'cust_1');
    await _flushForTests();
    const payloads = fetchMock.mock.calls.map((c) => bodyOf(c));
    const quota = payloads.find((p) => p.event === 'quota.limit_hit');
    const other = payloads.find((p) => p.event === 'other.event');
    expect(quota.product).toBe('parse');
    expect(other.product).toBe('shared-svc');
  });

  it('setDiagnostics surfaces reporting failures without throwing', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k', productLine: 'forge' });
    fetchMock.mockRejectedValue(new Error('network down'));
    const seen: unknown[] = [];
    setDiagnostics({ onReportError: (e) => seen.push(e) });
    expect(() => reportUsage('openai', 'gpt-4o', 1, 1)).not.toThrow();
    await _flushForTests();
    expect(seen.length).toBe(1);
    expect((seen[0] as Error).message).toBe('network down');
  });
});
