// Single source of truth for the version is package.json. tsup injects it at
// build time via a `define` (see tsup.config.ts), so there is no second
// hard-coded copy to drift. The fallback only applies when the module is run
// un-bundled (e.g. ts-node against source).
declare const __SDK_VERSION__: string;

export const version: string =
  typeof __SDK_VERSION__ !== 'undefined' ? __SDK_VERSION__ : '0.0.0-dev';
