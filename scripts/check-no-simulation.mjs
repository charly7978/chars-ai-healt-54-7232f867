#!/usr/bin/env node
/**
 * Anti-simulation guardrail for the PPG pipeline.
 * Fails CI if forbidden patterns appear in production source.
 *
 * Scans: src/** (excluding __tests__ and *.test.*)
 * Forbidden: Math.random(), keywords mock/fake/dummy/synthetic/simulate
 * Exceptions:
 *   1) Inline marker — REQUIRES `reason=...` and `ref=...` (ticket/PR id):
 *        // anti-sim-allow: reason="Butterworth coeffs" ref="PR-123"
 *   2) Centralized allowlist file: scripts/anti-sim-allowlist.json
 *      Entry shape: { file, line?, pattern?, reason, ref }
 *      Both `reason` and `ref` are mandatory.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

// ---------- Centralized allowlist ----------
const ALLOWLIST_PATH = "scripts/anti-sim-allowlist.json";
let ALLOWLIST = [];
if (existsSync(ALLOWLIST_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
    ALLOWLIST = Array.isArray(raw.entries) ? raw.entries : [];
  } catch (e) {
    console.error(`❌ Failed to parse ${ALLOWLIST_PATH}: ${e.message}`);
    process.exit(1);
  }
}
const allowlistErrors = [];
ALLOWLIST.forEach((e, i) => {
  if (!e || typeof e !== "object") return allowlistErrors.push(`entry #${i}: not an object`);
  if (!e.file)   allowlistErrors.push(`entry #${i}: missing "file"`);
  if (!e.reason) allowlistErrors.push(`entry #${i} (${e.file}): missing "reason"`);
  if (!e.ref)    allowlistErrors.push(`entry #${i} (${e.file}): missing "ref" (ticket/PR id)`);
});
if (allowlistErrors.length) {
  console.error("❌ Invalid allowlist entries:\n  " + allowlistErrors.join("\n  "));
  process.exit(1);
}

function isAllowlisted(fileRel, lineNo, patternId) {
  return ALLOWLIST.some(e =>
    e.file === fileRel &&
    (e.line == null || e.line === lineNo) &&
    (e.pattern == null || e.pattern === patternId)
  );
}

// Inline marker MUST contain reason=... and ref=...
const INLINE_RE = /anti-sim-allow:\s*(.*)$/;
function inlineMarkerValid(line) {
  const m = line.match(INLINE_RE);
  if (!m) return { present: false, valid: false };
  const body = m[1];
  const hasReason = /reason\s*=\s*["'][^"']+["']/.test(body);
  const hasRef    = /ref\s*=\s*["'][^"']+["']/.test(body);
  return { present: true, valid: hasReason && hasRef };
}

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
const malformedMarkers = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const fileRel = relative(".", file);
  lines.forEach((line, i) => {
    const marker = inlineMarkerValid(line);
    if (marker.present) {
      if (!marker.valid) {
        malformedMarkers.push({ file: fileRel, line: i + 1, text: line.trim() });
      }
      return; // marker present (valid or not — malformed is reported separately)
    }
    for (const { id, re } of PATTERNS) {
      if (re.test(line)) {
        if (isAllowlisted(fileRel, i + 1, id)) continue;
        violations.push({ file: fileRel, line: i + 1, id, text: line.trim() });
      }
    }
  });
}

if (malformedMarkers.length) {
  console.error("\n❌ MALFORMED `anti-sim-allow` MARKERS (require reason=\"...\" and ref=\"...\"):\n");
  for (const m of malformedMarkers) console.error(`  ${m.file}:${m.line}\n    ${m.text}`);
}
if (violations.length || malformedMarkers.length) {
  if (violations.length) {
    console.error("\n❌ ANTI-SIMULATION GUARDRAIL FAILED\n");
    for (const v of violations) console.error(`  [${v.id}] ${v.file}:${v.line}\n    ${v.text}`);
    console.error(`\n${violations.length} violation(s). To allow, add an entry to ${ALLOWLIST_PATH} (with reason+ref) or use an inline marker:\n  // anti-sim-allow: reason="..." ref="ISSUE-123"\n`);
  }
  process.exit(1);
}
console.log(`✅ Anti-simulation guardrail passed (pipeline clean, ${ALLOWLIST.length} allowlisted entr${ALLOWLIST.length === 1 ? "y" : "ies"}).`);