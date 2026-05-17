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

export function estimateCost(
  provider: Provider | string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const providerTable = PRICING[provider as Provider] ?? {};
  let rates: Rate = DEFAULT_PRICING;
  for (const [key, r] of Object.entries(providerTable)) {
    if (model.includes(key)) {
      rates = r;
      break;
    }
  }
  return (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1];
}
