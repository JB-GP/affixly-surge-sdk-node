import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapAnthropicClient } from '../../src/providers/anthropic.js';
import { configure, _resetConfigForTests } from '../../src/config.js';
import { _flushForTests } from '../../src/reporter.js';

describe('Anthropic wrapper', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let realCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetConfigForTests();
    configure({ surgeApiUrl: 'https://api.example.com', surgeApiKey: 'k' });
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    realCreate = vi.fn().mockResolvedValue({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 42, output_tokens: 17 },
    });
  });

  afterEach(async () => {
    await _flushForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetConfigForTests();
  });

  it('strips surgeTags before invoking the real method', async () => {
    const fakeClient = { messages: { create: realCreate } };
    const wrapped = wrapAnthropicClient(fakeClient);

    await wrapped.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      surgeTags: { feature: 'chat', customer_id: 'cust_1' },
    } as object);

    expect(realCreate).toHaveBeenCalledTimes(1);
    const passed = realCreate.mock.calls[0]![0];
    expect(passed).not.toHaveProperty('surgeTags');
    expect(passed.model).toBe('claude-sonnet-4-6');
    expect(passed.max_tokens).toBe(100);
  });

  it('reports usage with the correct provider, model, and token counts', async () => {
    const fakeClient = { messages: { create: realCreate } };
    const wrapped = wrapAnthropicClient(fakeClient);

    await wrapped.messages.create({
      model: 'claude-sonnet-4-6',
      messages: [],
      surgeTags: { feature: 'chat' },
    } as object);

    await _flushForTests();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe('claude-sonnet-4-6');
    expect(payload.input_tokens).toBe(42);
    expect(payload.output_tokens).toBe(17);
    expect(payload.feature).toBe('chat');
  });

  it('passes the provider response through unchanged to the caller', async () => {
    const fakeClient = { messages: { create: realCreate } };
    const wrapped = wrapAnthropicClient(fakeClient);
    const response = await wrapped.messages.create({ model: 'x', messages: [] } as object);
    expect(response).toEqual({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 42, output_tokens: 17 },
    });
  });

  it('does not block the caller on reporting', async () => {
    // Slow the report fetch
    let releaseFetch: (v: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((res) => {
        releaseFetch = res;
      }),
    );

    const fakeClient = { messages: { create: realCreate } };
    const wrapped = wrapAnthropicClient(fakeClient);

    const start = Date.now();
    const response = await wrapped.messages.create({ model: 'x', messages: [] } as object);
    const elapsed = Date.now() - start;

    // Provider call resolves quickly; report is still pending
    expect(response).toBeDefined();
    expect(elapsed).toBeLessThan(50);

    releaseFetch(new Response(null, { status: 200 }));
    await _flushForTests();
  });

  it('forwards non-create properties on messages unchanged', () => {
    const fakeClient = {
      messages: {
        create: realCreate,
        countTokens: vi.fn().mockReturnValue(123),
      },
    };
    const wrapped = wrapAnthropicClient(fakeClient);
    expect((wrapped.messages as { countTokens: () => number }).countTokens()).toBe(123);
  });
});
