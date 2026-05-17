export const MAX_TAG_LENGTH = 256;

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (process.env.SURGE_SDK_DEBUG) {
      console.debug(`[surge-sdk] ${message}`, ...args);
    }
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[surge-sdk] ${message}`, ...args);
  },
};

export function truncate(value: unknown, maxLen: number = MAX_TAG_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length > maxLen) {
    logger.warn(`Tag value truncated from ${s.length} to ${maxLen} chars`);
    return s.slice(0, maxLen);
  }
  return s;
}

export function validateUrl(url: string | null | undefined): void {
  if (!url) return;
  const lower = url.toLowerCase();
  if (lower.startsWith('https://')) return;
  if (lower.startsWith('http://localhost') || lower.startsWith('http://127.0.0.1')) return;
  logger.warn(
    `surgeApiUrl is not HTTPS: ${JSON.stringify(url)}. ` +
      'Your SDK API key will be transmitted in plaintext. Use https:// in production.',
  );
}
