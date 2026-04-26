#!/usr/bin/env node
/**
 * Verify that every property emitted by producers into `ProcessedSignal`
 * actually exists in `src/types/signal.d.ts` BEFORE running `tsc` or
 * bundling. Catches the failure mode that bit us repeatedly: a producer
 * adds a new diagnostics field, the type isn't extended, and the TS error
 * surfaces deep in a callsite far from the real cause.
 *
 * Strategy (intentionally pragmatic, no full TS AST):
 *   1. Parse `src/types/signal.d.ts` and extract the keys declared inside
 *      the `diagnostics?:` and `forensicGate?:` blocks of `ProcessedSignal`.
 *   2. Scan known producer files for object literals assigned to those
 *      keys (`diagnostics: { ... }`, `forensicGate: { ... }`) and pull
 *      the property names from each literal.
 *   3. Diff: any producer-side key missing from the type → fail with a
 *      precise, actionable message and exit 1.
 *   4. Finally, exec `tsc --noEmit -p tsconfig.app.json`.
 *
 * This is faster than `tsc` alone (it short-circuits on schema drift with
 * a one-line diagnostic) and stricter than `tsc` (it tells you which
 * producer key is undeclared instead of an error at the consumer site).
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TYPE_FILE = 'src/types/signal.d.ts';
const PRODUCERS = [
  'src/modules/signal-processing/PPGSignalProcessor.ts',
];

function fail(msg) {
  console.error(`\n[verify-signal-types] ✗ ${msg}\n`);
  process.exit(1);
}

/** Extract keys from a `name?: { ... }` block inside an interface. */
function extractBlockKeys(src, blockName) {
  const re = new RegExp(`${blockName}\\?\\s*:\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const body = src.slice(start, i - 1);
  // Strip block + line comments to avoid false positives.
  const clean = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const keys = new Set();
  // Match `identifier?:` or `identifier:` at the top level only — depth-aware.
  let d = 0;
  let buf = '';
  for (const ch of clean) {
    if (ch === '{') d++;
    else if (ch === '}') d--;
    if (d === 0) buf += ch;
  }
  const keyRe = /(?:^|[;\n,])\s*([a-zA-Z_$][\w$]*)\s*\??\s*:/g;
  let km;
  while ((km = keyRe.exec(buf))) keys.add(km[1]);
  return keys;
}

/** Extract keys from each `name: { ... }` literal in producer source. */
function extractLiteralKeys(src, propName) {
  const re = new RegExp(`${propName}\\s*:\\s*\\{`, 'g');
  const all = new Set();
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = src.slice(start, i - 1);
    const clean = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Top-level keys only.
    let d = 0;
    let buf = '';
    for (const ch of clean) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
      if (d === 0) buf += ch;
    }
    const keyRe = /(?:^|[,\n])\s*([a-zA-Z_$][\w$]*)\s*:/g;
    let km;
    while ((km = keyRe.exec(buf))) all.add(km[1]);
  }
  return all;
}

function main() {
  if (!existsSync(TYPE_FILE)) fail(`missing ${TYPE_FILE}`);
  const typeSrc = readFileSync(TYPE_FILE, 'utf8');
  const declared = {
    diagnostics: extractBlockKeys(typeSrc, 'diagnostics'),
    forensicGate: extractBlockKeys(typeSrc, 'forensicGate'),
  };
  if (!declared.diagnostics) fail('could not parse diagnostics block in signal.d.ts');
  if (!declared.forensicGate) fail('could not parse forensicGate block in signal.d.ts');

  const errors = [];
  for (const file of PRODUCERS) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const block of ['diagnostics', 'forensicGate']) {
      const used = extractLiteralKeys(src, block);
      for (const key of used) {
        if (!declared[block].has(key)) {
          errors.push(
            `${file}: producer emits "${block}.${key}" but it is NOT declared ` +
            `in ${TYPE_FILE} → add it to ProcessedSignal.${block}.`,
          );
        }
      }
    }
  }

  if (errors.length) {
    console.error('\n[verify-signal-types] schema drift detected:');
    for (const e of errors) console.error('  • ' + e);
    process.exit(1);
  }
  console.log('[verify-signal-types] ✓ producers ↔ signal.d.ts in sync.');

  const tsc = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.app.json'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(tsc.status ?? 1);
}

main();