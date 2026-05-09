#!/usr/bin/env node
/**
 * Validador estático del repositorio:
 *   1. Resuelve todos los imports relativos / alias "@/..." y verifica
 *      que apunten a un archivo existente (.ts/.tsx/.js/.jsx/index.*).
 *   2. Detecta módulos huérfanos en src/ (no entry, no importados).
 *
 * Salida con código != 0 si encuentra problemas. Pensado para CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];
const RESOLVE_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx'];
const ENTRYPOINTS = new Set([
  'src/main.tsx',
  'src/App.tsx',
  'src/vite-env.d.ts',
  'src/integrations/supabase/client.ts',
  'src/integrations/supabase/types.ts',
]);
const TYPES_GLOB = /\.d\.ts$/;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (EXTS.includes(extname(p))) acc.push(p);
  }
  return acc;
}

function tryResolve(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null; // package import

  const candidates = [
    base,
    ...RESOLVE_EXTS.map(e => base + e),
    ...RESOLVE_EXTS.map(e => join(base, 'index' + e)),
  ];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c; } catch {}
  }
  return false;
}

const importRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const files = walk(SRC);
const importGraph = new Map(); // file -> Set<resolvedFile>
const errors = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const targets = new Set();
  for (const re of [importRe, dynRe]) {
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      const resolved = tryResolve(spec, file);
      if (resolved === null) continue; // external pkg
      if (resolved === false) {
        errors.push(`UNRESOLVED  ${file.replace(ROOT + '/', '')}  ->  ${spec}`);
      } else {
        targets.add(resolved);
      }
    }
  }
  importGraph.set(file, targets);
}

// Orphan detection
const referenced = new Set();
for (const targets of importGraph.values()) for (const t of targets) referenced.add(t);
for (const ep of ENTRYPOINTS) referenced.add(join(ROOT, ep));

const orphans = files.filter(f => {
  const rel = f.replace(ROOT + '/', '');
  if (ENTRYPOINTS.has(rel)) return false;
  if (TYPES_GLOB.test(rel)) return false; // ambient types
  if (rel.includes('__tests__') || /\.(test|spec)\.[tj]sx?$/.test(rel)) return false;
  return !referenced.has(f);
});

for (const o of orphans) errors.push(`ORPHAN      ${o.replace(ROOT + '/', '')}`);

if (errors.length) {
  console.error('❌ Repository hygiene check failed:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(`✅ Repository hygiene OK — ${files.length} files, no unresolved imports, no orphans.`);