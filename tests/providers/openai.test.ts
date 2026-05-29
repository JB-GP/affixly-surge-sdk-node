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

  describe('streaming', () => {
    function makeStreamChunks() {
      // OpenAI chunks: content first (no usage), then a final chunk with
      // usage populated because we forced stream_options.include_usage=true.
      return [
        { id: 'c1', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, index: 0 }] },
        { id: 'c1', model: 'gpt-4o', choices: [{ delta: { content: '!' }, index: 0 }] },
        {
          id: 'c1',
          model: 'gpt-4o',
          choices: [],
          usage: { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 },
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

    it('injects stream_options.include_usage=true when caller did not set it', async () => {
      const streamingCreate = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = { chat: { completions: { create: streamingCreate } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      const stream = await wrapped.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
      } as object);
      for await (const _c of stream as AsyncIterable<unknown>) {
        /* drain */
      }

      expect(streamingCreate.mock.calls[0]![0].stream_options).toEqual({ include_usage: true });
    });

    it('merges with existing stream_options (preserving other options, forcing include_usage)', async () => {
      const streamingCreate = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = { chat: { completions: { create: streamingCreate } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      await wrapped.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
        stream_options: { include_usage: false, other_opt: 'keep_me' },
      } as object);

      const passed = streamingCreate.mock.calls[0]![0].stream_options;
      expect(passed.include_usage).toBe(true);
      expect(passed.other_opt).toBe('keep_me');
    });

    it('reports cumulative usage from the final chunk', async () => {
      const streamingCreate = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = { chat: { completions: { create: streamingCreate } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      const stream = await wrapped.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
      } as object);
      for await (const _c of stream as AsyncIterable<unknown>) {
        /* drain */
      }

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.provider).toBe('openai');
      expect(payload.model).toBe('gpt-4o');
      expect(payload.input_tokens).toBe(18);
      expect(payload.output_tokens).toBe(5);
    });

    it('streaming + surgeModel rewrites model before the provider call', async () => {
      const streamingCreate = vi.fn(async (_args: object) => asyncIterable(makeStreamChunks()));
      const fakeClient = { chat: { completions: { create: streamingCreate } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      const stream = await wrapped.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
        surgeModel: 'gpt-3.5-turbo',
      } as object);
      for await (const _c of stream as AsyncIterable<unknown>) {
        /* drain */
      }

      expect(streamingCreate.mock.calls[0]![0].model).toBe('gpt-3.5-turbo');
      expect(streamingCreate.mock.calls[0]![0]).not.toHaveProperty('surgeModel');

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.requested_model).toBe('gpt-4o');
    });
  });

  describe('audio transcription', () => {
    it('reports per-minute audio cost from response.duration with 0 tokens', async () => {
      // 120s of whisper-1 audio = 2 min * $0.006/min = $0.012
      const transcribe = vi.fn().mockResolvedValue({ text: 'hello', duration: 120 });
      const fakeClient = { audio: { transcriptions: { create: transcribe } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      await wrapped.audio.transcriptions.create({
        model: 'whisper-1',
        file: 'fake',
        surgeTags: { feature: 'transcribe_video' },
      } as object);

      const passed = transcribe.mock.calls[0]![0];
      expect(passed).not.toHaveProperty('surgeTags');
      expect(passed.model).toBe('whisper-1');

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.provider).toBe('openai');
      expect(payload.model).toBe('whisper-1');
      expect(payload.input_tokens).toBe(0);
      expect(payload.output_tokens).toBe(0);
      expect(payload.cost_usd).toBeCloseTo(0.012, 6);
      expect(payload.feature).toBe('transcribe_video');
    });

    it('reports 0 cost when duration is absent (non-verbose_json response)', async () => {
      const transcribe = vi.fn().mockResolvedValue({ text: 'hello' });
      const fakeClient = { audio: { transcriptions: { create: transcribe } } };
      const wrapped = wrapOpenAIClient(fakeClient);

      const response = await wrapped.audio.transcriptions.create({
        model: 'whisper-1',
        file: 'fake',
      } as object);
      expect(response).toEqual({ text: 'hello' });

      await _flushForTests();
      const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(payload.cost_usd).toBe(0);
      expect(payload.input_tokens).toBe(0);
    });
  });

  it('model override: surgeModel rewrites model and emits requested_model', async () => {
    // Override-aware mock: response.model echoes the actually-called model,
    // matching real OpenAI behavior (and what the reporter reads).
    // Using gpt-4o → gpt-3.5-turbo (non-colliding pricing keys).
    const dynamicCreate = vi.fn().mockImplementation(async (args: { model?: string }) => ({
      model: args.model ?? 'gpt-4o',
      usage: { prompt_tokens: 30, completion_tokens: 8 },
    }));
    const fakeClient = { chat: { completions: { create: dynamicCreate } } };
    const wrapped = wrapOpenAIClient(fakeClient);

    await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      surgeModel: 'gpt-3.5-turbo',
    } as object);

    expect(dynamicCreate.mock.calls[0]![0].model).toBe('gpt-3.5-turbo');
    expect(dynamicCreate.mock.calls[0]![0]).not.toHaveProperty('surgeModel');

    await _flushForTests();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(payload.model).toBe('gpt-3.5-turbo');
    expect(payload.requested_model).toBe('gpt-4o');
    expect(payload.requested_cost_usd).toBeGreaterThan(payload.cost_usd);
  });
});
