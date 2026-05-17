import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configure, getConfig, _resetConfigForTests } from '../src/config.js';

describe('config', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SURGE_API_URL;
    delete process.env.SURGE_SDK_KEY;
    delete process.env.SURGE_PRODUCT_LINE;
    _resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    _resetConfigForTests();
  });

  it('returns empty config by default', () => {
    const c = getConfig();
    expect(c.surgeApiUrl).toBeNull();
    expect(c.surgeApiKey).toBeNull();
    expect(c.productLine).toBeNull();
    expect(c.defaultTags).toEqual({});
  });

  it('configure() sets values', () => {
    configure({
      surgeApiUrl: 'https://example.com',
      surgeApiKey: 'k',
      productLine: 'app',
      defaultTags: { team: 'eng' },
    });
    const c = getConfig();
    expect(c.surgeApiUrl).toBe('https://example.com');
    expect(c.surgeApiKey).toBe('k');
    expect(c.productLine).toBe('app');
    expect(c.defaultTags).toEqual({ team: 'eng' });
  });

  it('configure() preserves prior values when fields are omitted', () => {
    configure({ surgeApiUrl: 'https://a.example', productLine: 'p1' });
    configure({ surgeApiKey: 'key2' });
    const c = getConfig();
    expect(c.surgeApiUrl).toBe('https://a.example');
    expect(c.productLine).toBe('p1');
    expect(c.surgeApiKey).toBe('key2');
  });

  it('falls back to env vars on first read', () => {
    process.env.SURGE_API_URL = 'https://env.example';
    process.env.SURGE_SDK_KEY = 'envkey';
    process.env.SURGE_PRODUCT_LINE = 'envproduct';
    _resetConfigForTests();
    const c = getConfig();
    expect(c.surgeApiUrl).toBe('https://env.example');
    expect(c.surgeApiKey).toBe('envkey');
    expect(c.productLine).toBe('envproduct');
  });

  it('warns on non-HTTPS surgeApiUrl', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({ surgeApiUrl: 'http://api.example.com' });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toContain('not HTTPS');
    warn.mockRestore();
  });

  it('does NOT warn for localhost http URLs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({ surgeApiUrl: 'http://localhost:5000' });
    configure({ surgeApiUrl: 'http://127.0.0.1:3000' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT warn for HTTPS URLs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configure({ surgeApiUrl: 'https://api.example.com' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
