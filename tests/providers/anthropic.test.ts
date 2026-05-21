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

  describe('model override', () => {
    it('per-request surgeModel rewrites model and reports requested_model', async () => {
      const fakeClient = { messages: { create: realCreate } };
      const wrapped = wrapAnthropicClient(fakeClient);

      await wrapped.messages.create({
        model: 'claude-opus-4-6',
        messages: [],
        surgeModel: 'claude-sonnet-4-6',
      } as object);

      // Real method sees the rewritten model
      expect(realCreate.mock.calls[0]![0].model).toBe('claude-sonnet-4-6');
      expect(realCreate.mock.calls[0]![0]).not.toHaveProperty('surgeModel');

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.model).toBe('claude-sonnet-4-6');
      expect(payload.requested_model).toBe('claude-opus-4-6');
      // Opus = (15, 75) per 1M; 42 in + 17 out → 0.000630 + 0.001275 = 0.001905
      expect(payload.requested_cost_usd).toBe(0.001905);
    });

    it('global modelOverrides map rewrites model when no per-request override', async () => {
      configure({ modelOverrides: { 'claude-opus-4-6': 'claude-haiku-4-5' } });
      const fakeClient = { messages: { create: realCreate } };
      const wrapped = wrapAnthropicClient(fakeClient);

      await wrapped.messages.create({ model: 'claude-opus-4-6', messages: [] } as object);

      expect(realCreate.mock.calls[0]![0].model).toBe('claude-haiku-4-5');
      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.requested_model).toBe('claude-opus-4-6');
    });

    it('per-request surgeModel wins over global modelOverrides', async () => {
      configure({ modelOverrides: { 'claude-opus-4-6': 'claude-haiku-4-5' } });
      const fakeClient = { messages: { create: realCreate } };
      const wrapped = wrapAnthropicClient(fakeClient);

      await wrapped.messages.create({
        model: 'claude-opus-4-6',
        messages: [],
        surgeModel: 'claude-sonnet-4-6',
      } as object);

      expect(realCreate.mock.calls[0]![0].model).toBe('claude-sonnet-4-6');
      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.model).toBe('claude-sonnet-4-6');
      expect(payload.requested_model).toBe('claude-opus-4-6');
    });

    it('does not include requested_model when no override occurred', async () => {
      const fakeClient = { messages: { create: realCreate } };
      const wrapped = wrapAnthropicClient(fakeClient);

      await wrapped.messages.create({ model: 'claude-sonnet-4-6', messages: [] } as object);

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.requested_model).toBeUndefined();
      expect(payload.requested_cost_usd).toBeUndefined();
    });

    it('strips surgeModel from args even when value equals requested model (no-op override)', async () => {
      const fakeClient = { messages: { create: realCreate } };
      const wrapped = wrapAnthropicClient(fakeClient);

      await wrapped.messages.create({
        model: 'claude-sonnet-4-6',
        messages: [],
        surgeModel: 'claude-sonnet-4-6',
      } as object);

      expect(realCreate.mock.calls[0]![0]).not.toHaveProperty('surgeModel');
      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.requested_model).toBeUndefined();
    });
  });
});
