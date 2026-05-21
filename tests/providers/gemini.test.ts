import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapGeminiClient } from '../../src/providers/gemini.js';
import { configure, _resetConfigForTests } from '../../src/config.js';
import { _flushForTests } from '../../src/reporter.js';

describe('Gemini wrapper', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let realGen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetConfigForTests();
    configure({ surgeApiUrl: 'https://api.example.com' });
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    realGen = vi.fn().mockResolvedValue({
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9 },
    });
  });

  afterEach(async () => {
    await _flushForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetConfigForTests();
  });

  it('strips surgeTags before invoking the real method', async () => {
    const fakeClient = { models: { generateContent: realGen } };
    const wrapped = wrapGeminiClient(fakeClient);

    await wrapped.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: 'hi',
      surgeTags: { feature: 'demo' },
    } as object);

    const passed = realGen.mock.calls[0]![0];
    expect(passed).not.toHaveProperty('surgeTags');
    expect(passed.model).toBe('gemini-1.5-flash');
  });

  it('reads model from request args and tokens from usageMetadata', async () => {
    const fakeClient = { models: { generateContent: realGen } };
    const wrapped = wrapGeminiClient(fakeClient);

    await wrapped.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: 'hi',
      surgeTags: { feature: 'demo', customer_id: 'cust_z' },
    } as object);
    await _flushForTests();

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.provider).toBe('gemini');
    expect(payload.model).toBe('gemini-1.5-flash');
    expect(payload.input_tokens).toBe(12);
    expect(payload.output_tokens).toBe(9);
    expect(payload.feature).toBe('demo');
    expect(payload.customer_id).toBe('cust_z');
  });

  it('strips "models/" prefix from model id', async () => {
    const fakeClient = { models: { generateContent: realGen } };
    const wrapped = wrapGeminiClient(fakeClient);
    await wrapped.models.generateContent({
      model: 'models/gemini-2.5-pro',
      contents: 'x',
    } as object);
    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.model).toBe('gemini-2.5-pro');
  });

  it('passes the provider response through unchanged', async () => {
    const fakeClient = { models: { generateContent: realGen } };
    const wrapped = wrapGeminiClient(fakeClient);
    const response = await wrapped.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: 'x',
    } as object);
    expect(response).toEqual({
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9 },
    });
  });

  describe('streaming', () => {
    function makeStreamChunks() {
      // Gemini stream: content chunks first, final chunk carries cumulative
      // usage_metadata. Token counts ARE cumulative — final chunk's values
      // are the totals.
      return [
        {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 },
        },
        {
          candidates: [{ content: { parts: [{ text: '!' }] } }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
        },
        {
          candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
        },
      ];
    }

    function asyncIterable<T>(items: T[]): AsyncIterable<T> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const item of items) yield item;
        },
      };
    }

    it('wraps generateContentStream and reports cumulative usage from the final chunk', async () => {
      const streamingGen = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = {
        models: {
          generateContent: realGen,
          generateContentStream: streamingGen,
        },
      };
      const wrapped = wrapGeminiClient(fakeClient);

      const stream = await wrapped.models.generateContentStream({
        model: 'gemini-1.5-flash',
        contents: 'hi',
      } as object);
      for await (const _c of stream as AsyncIterable<unknown>) {
        /* drain */
      }

      await _flushForTests();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.provider).toBe('gemini');
      expect(payload.model).toBe('gemini-1.5-flash');
      expect(payload.input_tokens).toBe(7);
      expect(payload.output_tokens).toBe(2);
    });

    it('strips surgeTags and surgeModel from streaming args', async () => {
      const streamingGen = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = {
        models: {
          generateContent: realGen,
          generateContentStream: streamingGen,
        },
      };
      const wrapped = wrapGeminiClient(fakeClient);

      await wrapped.models.generateContentStream({
        model: 'gemini-2.5-pro',
        contents: 'hi',
        surgeTags: { feature: 'demo' },
        surgeModel: 'gemini-2.5-flash',
      } as object);

      const passed = streamingGen.mock.calls[0]![0];
      expect(passed).not.toHaveProperty('surgeTags');
      expect(passed).not.toHaveProperty('surgeModel');
      expect(passed.model).toBe('gemini-2.5-flash'); // override applied
    });
  });

  it('model override: surgeModel rewrites model and emits requested_model', async () => {
    const fakeClient = { models: { generateContent: realGen } };
    const wrapped = wrapGeminiClient(fakeClient);

    await wrapped.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: 'x',
      surgeModel: 'gemini-2.5-flash',
    } as object);

    expect(realGen.mock.calls[0]![0].model).toBe('gemini-2.5-flash');
    expect(realGen.mock.calls[0]![0]).not.toHaveProperty('surgeModel');

    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.model).toBe('gemini-2.5-flash');
    expect(payload.requested_model).toBe('gemini-2.5-pro');
    expect(payload.requested_cost_usd).toBeGreaterThan(payload.cost_usd);
  });
});
