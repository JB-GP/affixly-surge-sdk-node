import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapOpenAIClient } from '../../src/providers/openai.js';
import { configure, _resetConfigForTests } from '../../src/config.js';
import { _flushForTests } from '../../src/reporter.js';

describe('OpenAI wrapper', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let realCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetConfigForTests();
    configure({ surgeApiUrl: 'https://api.example.com' });
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    realCreate = vi.fn().mockResolvedValue({
      model: 'gpt-4o',
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    });
  });

  afterEach(async () => {
    await _flushForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetConfigForTests();
  });

  it('strips surgeTags before invoking the real method', async () => {
    const fakeClient = { chat: { completions: { create: realCreate } } };
    const wrapped = wrapOpenAIClient(fakeClient);

    await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      surgeTags: { feature: 'qa' },
    } as object);

    const passed = realCreate.mock.calls[0]![0];
    expect(passed).not.toHaveProperty('surgeTags');
    expect(passed.model).toBe('gpt-4o');
  });

  it('reports usage with prompt/completion token counts', async () => {
    const fakeClient = { chat: { completions: { create: realCreate } } };
    const wrapped = wrapOpenAIClient(fakeClient);

    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] } as object);
    await _flushForTests();

    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.provider).toBe('openai');
    expect(payload.model).toBe('gpt-4o');
    expect(payload.input_tokens).toBe(30);
    expect(payload.output_tokens).toBe(8);
  });

  it('returns the provider response unchanged', async () => {
    const fakeClient = { chat: { completions: { create: realCreate } } };
    const wrapped = wrapOpenAIClient(fakeClient);
    const response = await wrapped.chat.completions.create({} as object);
    expect(response).toEqual({
      model: 'gpt-4o',
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    });
  });
});
