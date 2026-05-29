export type Provider = 'anthropic' | 'openai' | 'gemini';

export type Rate = readonly [input: number, output: number];

export const PRICING: Record<Provider, Record<string, Rate>> = {
  anthropic: {
    'claude-opus-4-0': [15.0, 75.0],
    'claude-opus-4-6': [15.0, 75.0],
    'claude-sonnet-4-0': [3.0, 15.0],
    'claude-sonnet-4-6': [3.0, 15.0],
    'claude-haiku-3-5': [0.8, 4.0],
    'claude-haiku-4-5': [0.8, 4.0],
    'claude-3-5-sonnet': [3.0, 15.0],
    'claude-3-opus': [15.0, 75.0],
    'claude-3-haiku': [0.25, 1.25],
  },
  openai: {
    'gpt-4o': [2.5, 10.0],
    'gpt-4o-mini': [0.15, 0.6],
    'gpt-4-turbo': [10.0, 30.0],
    'gpt-3.5-turbo': [0.5, 1.5],
    o1: [15.0, 60.0],
    'o1-mini': [3.0, 12.0],
  },
  gemini: {
    'gemini-2.5-pro': [1.25, 10.0],
    'gemini-2.5-flash': [0.15, 0.6],
    'gemini-2.0-flash': [0.1, 0.4],
    'gemini-1.5-pro': [1.25, 5.0],
    'gemini-1.5-flash': [0.075, 0.3],
  },
};

export const DEFAULT_PRICING: Rate = [3.0, 15.0];

// Audio transcription/translation pricing (USD per minute of audio). Billed by
// duration, not tokens — a separate model from PRICING above.
export const AUDIO_PRICING: Record<string, Record<string, number>> = {
  openai: {
    'whisper-1': 0.006,
    'gpt-4o-transcribe': 0.006,
    'gpt-4o-mini-transcribe': 0.003,
  },
};

export const DEFAULT_AUDIO_RATE = 0.006;

export function estimateAudioCost(
  provider: Provider | string,
  model: string,
  audioSeconds: number,
): number {
  const table = AUDIO_PRICING[provider as Provider] ?? {};
  const entries = Object.entries(table).sort((a, b) => b[0].length - a[0].length);
  let rate = DEFAULT_AUDIO_RATE;
  for (const [key, r] of entries) {
    if (model.includes(key)) {
      rate = r;
      break;
    }
  }
  return (Math.max(audioSeconds, 0) / 60) * rate;
}

export function estimateCost(
  provider: Provider | string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Sort keys longest-first so e.g. "gpt-4o-mini" isn't matched as "gpt-4o"
  // by iteration order. Both keys substring-match the model name; longest
  // match wins.
  const providerTable = PRICING[provider as Provider] ?? {};
  const entries = Object.entries(providerTable).sort((a, b) => b[0].length - a[0].length);
  let rates: Rate = DEFAULT_PRICING;
  for (const [key, r] of entries) {
    if (model.includes(key)) {
      rates = r;
      break;
    }
  }
  return (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1];
}
