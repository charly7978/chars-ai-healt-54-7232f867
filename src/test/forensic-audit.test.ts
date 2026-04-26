/**
 * FORENSIC AUDIT TEST — fails the build if the codebase contains any
 * synthetic / demo / fallback vital paths, or default normal-range
 * literals that could publish vitals without real PublicationGate evidence.
 *
 * Mirrors and extends scripts/audit-forensic.mjs but runs inside Vitest so
 * `bun run test` (and CI) catches regressions automatically.
 *
 * If you legitimately need one of these tokens in source (e.g. a DSP
 * `Math.sin` for filter coefficients, a UI alpha animation, or a test file
 * that intentionally uses synthetic streams), add it to the ALLOWLIST
 * below with a brief justification.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";

const ROOT = "src";

/**
 * Files/paths that are allowed to contain otherwise-forbidden tokens.
 * Each entry MUST justify why. Keep this list short and review every change.
 */
const ALLOWLIST: Array<{ file: string; tokens: RegExp[]; reason: string }> = [
  {
    file: "src/test/forensic-audit.test.ts",
    tokens: [/.*/],
    reason: "This file IS the audit; it must mention the patterns it bans.",
  },
  {
    file: "src/modules/signal-processing/BandpassFilter.ts",
    tokens: [/Math\.sin/],
    reason: "Math.sin(w0) is a legitimate biquad filter coefficient (DSP).",
  },
  {
    file: "src/components/PPGSignalMeter.tsx",
    tokens: [/Math\.sin/],
    reason: "Math.sin drives a UI alpha pulse animation, not a signal value.",
  },
  {
    file: "src/components/sr-diagnostics/__tests__/srDiagnosticsState.test.ts",
    tokens: [/synthetic/i],
    reason: "Test file legitimately uses the word 'synthetic stream'.",
  },
];

/**
 * Vital/feedback setters that MUST never be called with a hardcoded
 * physiological constant. We forbid the literal pattern, not the setter.
 */
const FORBIDDEN_RULES: Array<{
  re: RegExp;
  msg: string;
  scope?: RegExp; // limit to certain paths (default: all of src)
}> = [
  // ── Synthetic / fake / mock / demo data sources ──
  {
    re: /\bMath\.random\s*\(/g,
    msg: "Math.random() is forbidden anywhere in src/ — vitals must come from real signal.",
  },
  {
    re: /\bMath\.sin\s*\(/g,
    msg: "Math.sin is forbidden outside the DSP/UI allowlist — could be used to fabricate a fake PPG.",
  },
  { re: /\bmock(?:ed|s)?\b/gi,        msg: "'mock' token suggests fabricated vitals." },
  { re: /\bsimulate(?:d|s)?\b/gi,     msg: "'simulate' token suggests fabricated vitals." },
  { re: /\bsimulation\b/gi,           msg: "'simulation' token suggests fabricated vitals." },
  { re: /\bfake(?:d|s)?\b/gi,         msg: "'fake' token suggests fabricated vitals." },
  { re: /\bdummy\b/gi,                msg: "'dummy' token suggests fabricated vitals." },
  { re: /\bsynthetic\b/gi,            msg: "'synthetic' token suggests fabricated vitals." },
  { re: /\bplaceholderVital(?:s)?\b/gi, msg: "Placeholder vitals are forbidden." },
  { re: /\bdefaultVitals?\b/gi,       msg: "defaultVitals is forbidden — never publish without evidence." },
  { re: /\bnormalRange(?:s)?\b/gi,    msg: "normalRange constants must not seed vitals output." },

  // ── Hardcoded physiological fallbacks (`|| 70`, `|| 97`, `|| 120/80`, ...) ──
  { re: /\|\|\s*70\b(?!\s*[*/+\-%])/g,  msg: "Default BPM=70 fallback forbidden." },
  { re: /\|\|\s*72\b(?!\s*[*/+\-%])/g,  msg: "Default BPM=72 fallback forbidden." },
  { re: /\|\|\s*75\b(?!\s*[*/+\-%])/g,  msg: "Default BPM=75 fallback forbidden." },
  { re: /\|\|\s*97\b(?!\s*[*/+\-%])/g,  msg: "Default SpO2=97 fallback forbidden." },
  { re: /\|\|\s*98\b(?!\s*[*/+\-%])/g,  msg: "Default SpO2=98 fallback forbidden." },
  { re: /\|\|\s*99\b(?!\s*[*/+\-%])/g,  msg: "Default SpO2=99 fallback forbidden." },
  { re: /\|\|\s*120\b(?!\s*[*/+\-%])/g, msg: "Default systolic=120 fallback forbidden." },
  { re: /\|\|\s*80\b(?!\s*[*/+\-%])/g,  msg: "Default diastolic=80 fallback forbidden." },
  { re: /\|\|\s*100\b(?!\s*[*/+\-%])/g, msg: "Default glucose=100 fallback forbidden." },
  { re: /\|\|\s*200\b(?!\s*[*/+\-%])/g, msg: "Default cholesterol=200 fallback forbidden." },

  // ── Object-literal seeding of vitals with hardcoded normal numbers ──
  // e.g. `bpm: 72` / `spo2: 97` / `systolic: 120`. Allow `: 0` (zero is the
  // explicit "no evidence" sentinel) and any non-numeric / variable value.
  { re: /\b(?:bpm|heartRate)\s*:\s*(?:7[02-9]|8[0-9]|9[0-9]|1[0-4][0-9])\b/g, msg: "Hardcoded BPM literal in object — must come from detector." },
  { re: /\bspo2\s*:\s*(?:9[5-9]|100)\b/gi,                                    msg: "Hardcoded SpO2 literal in object — must come from processor." },
  { re: /\bsystolic\s*:\s*(?:1[01][0-9]|12[0-9]|13[0-9]|14[0-9])\b/g,         msg: "Hardcoded systolic literal — must come from processor." },
  { re: /\bdiastolic\s*:\s*(?:[6-9][0-9])\b/g,                                msg: "Hardcoded diastolic literal — must come from processor." },
  { re: /\bglucose\s*:\s*(?:[7-9][0-9]|1[0-4][0-9])\b/g,                      msg: "Hardcoded glucose literal — must come from processor." },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Skip generated / vendor folders
      if (name === "node_modules" || name === "dist" || name === ".vite") continue;
      walk(p, out);
    } else if ([".ts", ".tsx"].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

function isAllowed(file: string, token: string): boolean {
  const norm = file.split(sep).join("/");
  return ALLOWLIST.some(
    (entry) => norm.endsWith(entry.file) && entry.tokens.some((re) => re.test(token))
  );
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("forensic-audit: no synthetic/fallback vital paths", () => {
  const files = walk(ROOT);

  it("should find source files to audit", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("contains no forbidden synthetic/fallback patterns", () => {
    const violations: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");

      for (const rule of FORBIDDEN_RULES) {
        if (rule.scope && !rule.scope.test(file)) continue;
        lines.forEach((ln, i) => {
          if (isCommentLine(ln)) return;
          // Reset stateful global regexes per line.
          rule.re.lastIndex = 0;
          const m = ln.match(rule.re);
          if (!m) return;
          for (const token of m) {
            if (isAllowed(file, token)) continue;
            const rel = relative(process.cwd(), file).split(sep).join("/");
            violations.push(
              `${rel}:${i + 1}  ${rule.msg}  →  ${ln.trim().slice(0, 120)}`
            );
          }
        });
      }
    }

    if (violations.length > 0) {
      const header =
        "\n❌ FORENSIC AUDIT FAILED — forbidden synthetic/fallback patterns:\n";
      throw new Error(header + violations.join("\n") + "\n");
    }
    expect(violations).toEqual([]);
  });
});