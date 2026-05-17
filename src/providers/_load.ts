import { createRequire } from 'node:module';

declare const __filename: string | undefined;

const filename = typeof __filename === 'string' ? __filename : import.meta.url;
const req = createRequire(filename);

const cache = new Map<string, unknown>();

export function loadPeerModule(name: string, installHint: string): unknown {
  if (cache.has(name)) return cache.get(name);
  try {
    const mod = req(name);
    cache.set(name, mod);
    return mod;
  } catch (err) {
    throw new Error(
      `${name} is not installed. Run \`${installHint}\` to use this wrapper. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}
