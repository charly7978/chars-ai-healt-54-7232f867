#!/usr/bin/env node
/**
 * FORENSIC AUDIT — falla si encuentra patrones prohibidos en src/.
 *  - Math.random en módulos de signal-processing/vital-signs/HeartBeatProcessor
 *  - Defaults fisiológicos: || 70 BPM, || 97 SpO2, || 120/80 mmHg
 *  - playBeep / navigator.vibrate sin guard publicationGate cercano
 *
 * Uso: node scripts/audit-forensic.mjs
 * Exit 0 si limpio, 1 si encuentra violaciones.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src/modules', 'src/hooks', 'src/pages', 'src/components'];
const violations = [];

const FORBIDDEN = [
  { re: /Math\.random\s*\(/g, where: /modules\/(signal-processing|vital-signs|biomarkers)|HeartBeatProcessor/, msg: 'Math.random en pipeline fisiológico' },
  { re: /\|\|\s*70\b(?![0-9])/g, msg: 'Default BPM=70 sospechoso' },
  { re: /\|\|\s*97\b(?![0-9])/g, msg: 'Default SpO2=97 sospechoso' },
  { re: /\|\|\s*120\b(?![0-9])/g, msg: 'Default systolic=120 sospechoso' },
  { re: /\|\|\s*80\b(?![0-9])/g, msg: 'Default diastolic=80 sospechoso' },
  { re: /\|\|\s*60\b(?![0-9])/g, where: /modules\/(vital-signs|biomarkers)|HeartBeatProcessor/, msg: 'Default BPM=60 sospechoso' },
  { re: /\|\|\s*90\b(?![0-9])/g, where: /modules\/(vital-signs|biomarkers)/, msg: 'Default 90 (SpO2/dia) sospechoso' },
  { re: /\b(mock|fake|dummy|synthetic|placeholder)\b/gi, where: /modules\/(signal-processing|vital-signs|biomarkers)|HeartBeatProcessor/, msg: 'Palabra prohibida (mock/fake/synthetic)' },
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (['.ts', '.tsx'].includes(extname(p))) audit(p);
  }
}

function audit(file) {
  // Skip test files — they legitimately reference forbidden tokens to
  // assert behaviour against them.
  if (/(__tests__|\.test\.[tj]sx?$|src\/test\/)/.test(file)) return;
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (const rule of FORBIDDEN) {
    if (rule.where && !rule.where.test(file)) continue;
    lines.forEach((ln, i) => {
      // Skip comments
      const trimmed = ln.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      const m = ln.match(rule.re);
      if (m) violations.push(`${file}:${i + 1}  ${rule.msg}  →  ${ln.trim().slice(0, 100)}`);
    });
  }
}

for (const r of ROOTS) {
  try { walk(r); } catch {}
}

if (violations.length === 0) {
  console.log('✅ FORENSIC AUDIT OK — sin patrones prohibidos.');
  process.exit(0);
}

// ── Structured failure summary for CI logs ──
// Each violation string has the shape:
//   "<file>:<line>  <rule msg>  →  <snippet>"
// We re-parse to group by file and by rule for a readable report.
const parsed = violations.map((v) => {
  const m = /^(.*?):(\d+)\s{2}(.*?)\s+→\s{2}(.*)$/.exec(v);
  if (!m) return { file: '?', line: '?', rule: v, snippet: '' };
  return { file: m[1], line: m[2], rule: m[3], snippet: m[4] };
});

const byFile = new Map();
const byRule = new Map();
for (const p of parsed) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
  byRule.set(p.rule, (byRule.get(p.rule) || 0) + 1);
}

const isCI = !!process.env.GITHUB_ACTIONS;
const group = (title) => isCI ? console.error(`::group::${title}`) : console.error(`\n── ${title} ──`);
const endGroup = () => { if (isCI) console.error('::endgroup::'); };

console.error('');
console.error('❌ FORENSIC AUDIT FAIL');
console.error(`   ${violations.length} violation(s) across ${byFile.size} file(s), ${byRule.size} rule(s).`);

group('Violations by file');
for (const [file, items] of byFile) {
  console.error(`\n  ${file}  (${items.length})`);
  for (const it of items) {
    console.error(`    L${it.line}  [${it.rule}]`);
    if (it.snippet) console.error(`         → ${it.snippet}`);
    if (isCI) {
      // GitHub Actions inline annotation on the offending line.
      const msg = `${it.rule} → ${it.snippet}`.replace(/[\r\n]+/g, ' ');
      console.error(`::error file=${it.file},line=${it.line}::${msg}`);
    }
  }
}
endGroup();

group('Summary by rule');
const ruleRows = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
for (const [rule, count] of ruleRows) {
  console.error(`  ${String(count).padStart(4)}  ${rule}`);
}
endGroup();

console.error('');
console.error('💡 To allow a legitimate match, add a justified entry to the ALLOWLIST in');
console.error('   src/test/forensic-audit.test.ts (the only sanctioned escape hatch).');
process.exit(1);
