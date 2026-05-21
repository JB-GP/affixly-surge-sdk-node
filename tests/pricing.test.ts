import { describe, it, expect } from 'vitest';
import { estimateCost, PRICING, DEFAULT_PRICING } from '../src/pricing.js';

describe('pricing', () => {
  it('estimates cost for a known Anthropic model', () => {
    // claude-sonnet-4-6: (3.0, 15.0) per million
    // 1_000_000 input + 1_000_000 output = 3.0 + 15.0 = 18.0
    expect(estimateCost('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(
      18.0,
      6,
    );
  });

  it('estimates cost for a known OpenAI model', () => {
    // gpt-4o: (2.50, 10.00)
    expect(estimateCost('openai', 'gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(12.5, 6);
  });

  it('estimates cost for a known Gemini model', () => {
    // gemini-1.5-flash: (0.075, 0.30)
    expect(estimateCost('gemini', 'gemini-1.5-flash', 1_000_000, 1_000_000)).toBeCloseTo(
      0.375,
      6,
    );
  });

  it('matches by substring (model id contains the key)', () => {
    // The pricing key 'claude-sonnet-4-6' appears in this longer model id
    expect(
      estimateCost('anthropic', 'claude-sonnet-4-6-20251015', 1_000_000, 0),
    ).toBeCloseTo(3.0, 6);
  });

  it('falls back to default pricing for unknown models', () => {
    // DEFAULT_PRICING is (3.0, 15.0)
    expect(estimateCost('anthropic', 'totally-unknown-model', 1_000_000, 1_000_000)).toBeCloseTo(
      18.0,
      6,
    );
    expect(estimateCost('openai', 'mystery-gpt', 0, 1_000_000)).toBeCloseTo(15.0, 6);
  });

  it('uses default pricing for unknown provider', () => {
    expect(estimateCost('aleph', 'gpt-4o', 1_000_000, 0)).toBeCloseTo(3.0, 6);
  });

  it('exposes the pricing tables and default fallback', () => {
    expect(PRICING.anthropic['claude-opus-4-6']).toEqual([15.0, 75.0]);
    expect(PRICING.openai['gpt-4o-mini']).toEqual([0.15, 0.6]);
    expect(PRICING.gemini['gemini-2.5-pro']).toEqual([1.25, 10.0]);
    expect(DEFAULT_PRICING).toEqual([3.0, 15.0]);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCost('anthropic', 'claude-sonnet-4-6', 0, 0)).toBe(0);
  });

  describe('longest-match (regression: gpt-4o vs gpt-4o-mini)', () => {
    it('prices gpt-4o-mini at gpt-4o-mini rates, not gpt-4o', () => {
      // gpt-4o-mini: (0.15, 0.6)
      // If matched as gpt-4o, would be (2.5, 10.0) — 16x higher.
      expect(estimateCost('openai', 'gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    });

    it('prices o1-mini at o1-mini rates, not o1', () => {
      // o1-mini: (3.0, 12.0), o1: (15.0, 60.0)
      expect(estimateCost('openai', 'o1-mini', 1_000_000, 1_000_000)).toBeCloseTo(15.0, 6);
    });

    it('still prices gpt-4o at gpt-4o rates', () => {
      expect(estimateCost('openai', 'gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(12.5, 6);
    });

    it('still prices o1 at o1 rates', () => {
      expect(estimateCost('openai', 'o1', 1_000_000, 1_000_000)).toBeCloseTo(75.0, 6);
    });
  });
});
