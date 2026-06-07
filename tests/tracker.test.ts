import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configure, _resetConfigForTests } from '../src/config.js';
import { track } from '../src/tracker.js';
import { _flushForTests } from '../src/transport.js';

describe('tracker', () => {
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

  it('warns and is a no-op when not configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    track('parse.repo.connected', 'octocat', { repo: 'owner/repo' });
    await _flushForTests();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('POSTs a track payload to /api/track with the expected shape', async () => {
    configure({
      surgeApiUrl: 'https://api.example.com',
      surgeApiKey: 'surge_sk_test',
      productLine: 'parse',
    });

    track('parse.repo.connected', 'octocat', { repo: 'owner/repo', language: 'python' });

    await _flushForTests();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/api/track');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer surge_sk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.redirect).toBe('error');

    const payload = JSON.parse(init.body);
    expect(payload).toEqual({
      event: 'parse.repo.connected',
      tenant: 'octocat',
      product: 'parse',
      properties: { repo: 'owner/repo', language: 'python' },
    });
  });

  it('reads product from the configured productLine', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', productLine: 'forge' });
    track('model.generated', 'user_123');
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.product).toBe('forge');
  });

  it('defaults properties to an empty object when omitted', async () => {
    configure({ surgeApiUrl: 'https://api.example.com', productLine: 'parse' });
    track('app.opened', 'user_123');
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.properties).toEqual({});
  });

  it('sends product: null when productLine is unset', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    track('app.opened', 'user_123');
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.product).toBeNull();
  });

  it('strips trailing slashes on surgeApiUrl', async () => {
    configure({ surgeApiUrl: 'https://api.example.com///', productLine: 'parse' });
    track('app.opened', 'user_123');
    await _flushForTests();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/api/track');
  });

  it('does not throw if the POST fails', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(() => track('app.opened', 'user_123')).not.toThrow();
    await _flushForTests();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fire-and-forget: track returns before fetch runs', async () => {
    configure({ surgeApiUrl: 'https://api.example.com' });
    let fetchSeen = false;
    fetchMock.mockImplementation(() => {
      fetchSeen = true;
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    track('app.opened', 'user_123');
    // track is sync — must return immediately. fetch hasn't run yet (setImmediate).
    expect(fetchSeen).toBe(false);

    await new Promise((r) => setImmediate(r));
    expect(fetchSeen).toBe(true);

    await _flushForTests();
  });
});
