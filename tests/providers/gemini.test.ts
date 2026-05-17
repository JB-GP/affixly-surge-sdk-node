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
});
