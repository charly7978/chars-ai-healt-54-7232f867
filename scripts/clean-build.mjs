#!/usr/bin/env node
/**
 * Clean build caches so the TS server / CI / bundler pick up the latest
 * type definitions in `src/types/*.d.ts`. Removes:
 *   - *.tsbuildinfo (incremental compile cache)
 *   - node_modules/.vite                (Vite dep optimiser cache)
 *   - node_modules/.cache               (generic toolchain cache)
 *   - node_modules/.tmp                 (vitest / swc tmp)
 *   - dist/                             (last bundle)
 *
 * Idempotent. Safe to run any time. Does NOT delete node_modules itself —
 * use `rm -rf node_modules && bun install` for a full reinstall.
 */
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';

const targets = [
  'node_modules/.vite',
  'node_modules/.cache',
  'node_modules/.tmp',
  'dist',
];

async function removeIfExists(p) {
  if (!existsSync(p)) return;
  await rm(p, { recursive: true, force: true });
  console.log(`[clean] removed ${p}`);
}

async function main() {
  for (const t of targets) await removeIfExists(t);
  // tsbuildinfo files anywhere in the repo (root + nested package dirs).
  for await (const f of glob('**/*.tsbuildinfo', { exclude: ['node_modules/**'] })) {
    await removeIfExists(f);
  }
  console.log('[clean] done.');
}

main().catch((e) => { console.error(e); process.exit(1); });