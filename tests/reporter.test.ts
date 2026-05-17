import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configure, _resetConfigForTests } from '../src/config.js';
import { reportUsage, _flushForTests } from '../src/reporter.js';

describe('reporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetConfigForTests();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await _flushForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetConfigForTests();
  });

  it('is a no-op when no surgeApiUrl is set', async () => {
    reportUsage('anthropic', 'claude-sonnet-4-6', 100, 50);
    await _flushForTests();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs an event payload with the expected shape', async () => {
    configure({
      surgeApiUrl: 'https://api.example.com',
      surgeApiKey: 'surge_sk_test',
      productLine: 'my-app',
      defaultTags: { team: 'eng' },
    });

    reportUsage('anthropic', 'claude-sonnet-4-6', 100, 50, {
      feature: 'chat',
      customer_id: 'cust_abc',
    });

    await _flushForTests();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/events');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer surge_sk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.redirect).toBe('error');

    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: Number(((100 / 1_000_000) * 3.0 + (50 / 1_000_000) * 15.0).toFixed(6)),
      requests: 1,
      product_line: 'my-app',
      feature: 'chat',
      customer_id: 'cust_abc',
    });
  });

  it('strips trailing slashes on surgeApiUrl', async () => {
    configure({ surgeApiUrl: 'https://api.example.com///' });
    reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1);
    await _flushForTests();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/api/events');
  });

  it('does not throw if the POST fails', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(() => reportUsage('openai', 'gpt-4o', 10, 10)).not.toThrow();
    await _flushForTests();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fire-and-forget: reportUsage returns before fetch completes', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    let resolveFetch: (v: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((res) => {
        resolveFetch = res;
      }),
    );

    let fetchSeen = false;
    fetchMock.mockImplementation(() => {
      fetchSeen = true;
      return new Promise<Response>((res) => {
        resolveFetch = res;
      });
    });

    reportUsage('openai', 'gpt-4o', 1, 1);
    // reportUsage is sync — must return immediately. fetch hasn't run yet (setImmediate).
    expect(fetchSeen).toBe(false);

    // After the event loop ticks, fetch fires
    await new Promise((r) => setImmediate(r));
    expect(fetchSeen).toBe(true);

    resolveFetch(new Response(null, { status: 200 }));
    await _flushForTests();
  });

  it('truncates oversize tag values', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    const long = 'x'.repeat(500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1, { feature: long });
    await _flushForTests();
    const init = fetchMock.mock.calls[0]![1];
    const payload = JSON.parse(init.body);
    expect(payload.feature).toHaveLength(256);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('merges defaultTags with per-call tags, per-call wins', async () => {
    configure({
      surgeApiUrl: 'https://api.example.com',
      defaultTags: { feature: 'default-feature', customer_id: 'default-cust' },
    });
    reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1, { feature: 'override' });
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.feature).toBe('override');
    expect(payload.customer_id).toBe('default-cust');
  });

  it('rounds cost_usd to 6 decimal places', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    reportUsage('anthropic', 'claude-sonnet-4-6', 7, 11);
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    // 7 * 3 / 1e6 + 11 * 15 / 1e6 = 0.000021 + 0.000165 = 0.000186
    expect(payload.cost_usd).toBe(0.000186);
  });

  it('limits concurrency to 4 in-flight reports', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<(v: Response) => void> = [];

    fetchMock.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((res) => {
        resolvers.push((v) => {
          inFlight--;
          res(v);
        });
      });
    });

    for (let i = 0; i < 10; i++) {
      reportUsage('anthropic', 'claude-sonnet-4-6', 1, 1);
    }

    // Let setImmediate fire so all 10 jobs are queued
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(inFlight).toBe(4);
    expect(maxInFlight).toBe(4);

    // Resolve them in batches
    while (resolvers.length > 0) {
      const r = resolvers.shift();
      r?.(new Response(null, { status: 200 }));
      await new Promise((res) => setImmediate(res));
    }

    await _flushForTests();
    expect(maxInFlight).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
