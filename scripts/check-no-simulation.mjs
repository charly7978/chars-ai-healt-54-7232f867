#!/usr/bin/env node
/**
 * Anti-simulation guardrail for the PPG pipeline.
 * Fails CI if forbidden patterns appear in production source.
 *
 * Scans: src/** (excluding __tests__ and *.test.*)
 * Forbidden: Math.random(), keywords mock/fake/dummy/synthetic/simulate
 * Whitelisted by inline marker:  // anti-sim-allow: <reason>
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "src";
const SKIP_DIR = new Set(["__tests__", "test", "tests", "node_modules"]);
const SKIP_FILE = /\.(test|spec)\.[jt]sx?$/;

const PATTERNS = [
  { id: "MATH_RANDOM", re: /\bMath\.random\s*\(/ },
  { id: "MOCK",        re: /\bmock(?:ed|ing|s)?\b/i },
  { id: "FAKE",        re: /\bfake(?:d|s)?\b/i },
  { id: "DUMMY",       re: /\bdummy\b/i },
  { id: "SYNTHETIC",   re: /\bsynthe(?:tic|sized?|sis)\b/i },
  { id: "SIMULATE",    re: /\bsimulat(?:e|ed|ing|ion)\b/i },
];

// Files allowed to mention these patterns inside comments/strings only.
// Each entry: { file, allow: [pattern ids] }
const FILE_WHITELIST = [
  // Auth UI uses HTML "placeholder" attribute — never matched by patterns above.
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !SKIP_FILE.test(name)) yield p;
  }
}

const violations = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("anti-sim-allow")) return;
    for (const { id, re } of PATTERNS) {
      if (re.test(line)) {
        violations.push({ file: relative(".", file), line: i + 1, id, text: line.trim() });
      }
    }
  });
}

if (violations.length) {
  console.error("\n❌ ANTI-SIMULATION GUARDRAIL FAILED\n");
  for (const v of violations) {
    console.error(`  [${v.id}] ${v.file}:${v.line}\n    ${v.text}`);
  }
  console.error(`\n${violations.length} violation(s). Use \`// anti-sim-allow: <reason>\` to whitelist a legitimate line.\n`);
  process.exit(1);
}
console.log("✅ Anti-simulation guardrail passed (pipeline clean).");