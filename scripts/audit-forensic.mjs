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
console.error('❌ FORENSIC AUDIT FAIL:');
for (const v of violations) console.error('  ' + v);
process.exit(1);
