/**
 * env.ts — load .env without a dependency.
 *
 * Looks for agents/.env then the repo root .env, and fills in only variables that are not
 * already set, so an exported shell value always wins. Imported for side effects by chain.ts
 * so every entrypoint (demo, resolver, buyer) picks it up automatically.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  resolve(here, '../../.env'), // agents/.env
  resolve(here, '../../../.env'), // repo root .env
];

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue;
    for (const [k, v] of Object.entries(parse(readFileSync(path, 'utf8')))) {
      // Never clobber something the shell already exported.
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

loadEnv();
