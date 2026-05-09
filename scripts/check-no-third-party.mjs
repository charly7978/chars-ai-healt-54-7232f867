#!/usr/bin/env node
/**
 * Third-party / token guardrail.
 *
 * Fails the build if the frontend source contains:
 *   1) Imports of disallowed third-party SDKs (Sanity.io CMS, Firebase,
 *      Mixpanel, Segment, PostHog, Amplitude, Sentry, Google Analytics,
 *      raw `axios` outbound clients, etc.).
 *   2) HTTP(S) URLs to third-party hosts (anything not in the allowlist).
 *   3) Hardcoded credential-looking strings (Bearer tokens, API keys,
 *      Slack/GitHub/Stripe/Google secrets, JWTs not equal to the public
 *      Supabase publishable key already shipped in the client).
 *   4) `import.meta.env.*` references to env vars outside the
 *      `VITE_SUPABASE_*` allowlist.
 *
 * Local modules whose names happen to contain `sanity` (e.g.
 * `src/lib/sanity/*` — signal sanity checks) are NOT third-party and are
 * scanned like the rest of the codebase. The guardrail only flags imports
 * from real npm packages such as `@sanity/...` or `sanity`.
 *
 * Inline opt-out (rare, must justify): a comment on the same line containing
 *   third-party-allow: reason="..." ref="..."
 * Both `reason` and `ref` are mandatory.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = "src";
const SKIP_DIR = new Set(["__tests__", "test", "tests", "node_modules"]);
const SKIP_FILE = /\.(test|spec)\.[jt]sx?$/;
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

// --- Allowed import packages (anything else is fine; we ONLY flag the list
// below). We deliberately keep this as a deny-list, not an allow-list, to
// avoid breaking on every new shadcn dependency.
const FORBIDDEN_PACKAGE_RE = [
  /^@sanity(\/|$)/,                  // Sanity.io CMS
  /^sanity$/,                        // Sanity.io CMS root
  /^firebase(\/|$)/,
  /^@firebase(\/|$)/,
  /^mixpanel(-browser)?$/,
  /^@segment(\/|$)/,
  /^analytics-node$/,
  /^posthog-js$/,
  /^@amplitude(\/|$)/,
  /^amplitude-js$/,
  /^@sentry(\/|$)/,
  /^@google-analytics(\/|$)/,
  /^react-ga4?$/,
  /^axios$/,                          // outbound HTTP client; use fetch + supabase
  /^@datadog(\/|$)/,
  /^logrocket$/,
  /^@bugsnag(\/|$)/,
  /^@hotjar(\/|$)/,
];

// --- Allowed network hosts (URLs in source code).
const HOST_ALLOWLIST = [
  /\.supabase\.co$/,
  /\.supabase\.in$/,
  /\.lovable\.app$/,
  /\.lovable\.dev$/,
  /^localhost$/,
  /^127\.0\.0\.1$/,
  // Schema / spec URLs that appear inside JSON-LD or w3.org refs are non-runtime
  /^www\.w3\.org$/,
  /^schema\.org$/,
];

// --- Allowed env variables (referenced via import.meta.env.*)
const ENV_ALLOWLIST = new Set([
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PROJECT_ID",
  "MODE", "DEV", "PROD", "SSR", "BASE_URL",
]);

// --- The single public Supabase publishable JWT shipped to the client.
// Other JWT-looking strings are flagged.
const ENV_PATH = ".env";
let SUPABASE_PUBLIC_JWT = null;
if (existsSync(ENV_PATH)) {
  const m = readFileSync(ENV_PATH, "utf8").match(/VITE_SUPABASE_PUBLISHABLE_KEY\s*=\s*"?([^"\s]+)"?/);
  if (m) SUPABASE_PUBLIC_JWT = m[1];
}

// --- Token / credential regexes
const TOKEN_PATTERNS = [
  { id: "STRIPE_SK",      re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/g },
  { id: "STRIPE_RK",      re: /\brk_(live|test)_[A-Za-z0-9]{16,}/g },
  { id: "GITHUB_PAT",     re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: "GITHUB_OAUTH",   re: /\bgho_[A-Za-z0-9]{36}\b/g },
  { id: "SLACK_TOKEN",    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { id: "AWS_ACCESS_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "OPENAI_KEY",     re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: "PRIVATE_KEY",    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // Bearer token literal in source (any alphanumeric-ish token after Bearer)
  { id: "BEARER_LITERAL", re: /["'`]\s*Bearer\s+[A-Za-z0-9_\-\.=]{20,}["'`]/g },
];

// JWT pattern: three base64url segments separated by '.'
const JWT_RE = /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g;

// URL pattern (capture host)
const URL_RE = /https?:\/\/([A-Za-z0-9.\-]+)(?::\d+)?(?:\/[^\s'"`]*)?/g;

// Import / require / dynamic import specifiers
const IMPORT_RE = /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]*\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

// Inline opt-out marker
const ALLOW_RE = /third-party-allow:\s*(.+)$/;
function inlineAllowed(line) {
  const m = line.match(ALLOW_RE);
  if (!m) return { present: false, valid: false };
  const body = m[1];
  const ok = /reason\s*=\s*["'][^"']+["']/.test(body) && /ref\s*=\s*["'][^"']+["']/.test(body);
  return { present: true, valid: ok };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SCAN_EXT.has(extname(p)) && !SKIP_FILE.test(name)) yield p;
  }
}

function isAllowedHost(host) {
  return HOST_ALLOWLIST.some(re => re.test(host));
}

const violations = [];
const malformedMarkers = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  scanned++;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const fileRel = relative(".", file);

  // 1) Imports from forbidden packages
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) continue;
    if (FORBIDDEN_PACKAGE_RE.some(re => re.test(spec))) {
      const lineNo = text.slice(0, m.index).split("\n").length;
      const lineText = lines[lineNo - 1] ?? "";
      const allow = inlineAllowed(lineText);
      if (allow.present && !allow.valid) malformedMarkers.push({ file: fileRel, line: lineNo, text: lineText.trim() });
      if (allow.valid) continue;
      violations.push({ file: fileRel, line: lineNo, id: "FORBIDDEN_IMPORT", text: spec });
    }
  }

  // 2) Per-line scans
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const allow = inlineAllowed(line);
    if (allow.present && !allow.valid) {
      malformedMarkers.push({ file: fileRel, line: lineNo, text: line.trim() });
    }
    if (allow.valid) return;

    // URLs
    URL_RE.lastIndex = 0;
    let u;
    while ((u = URL_RE.exec(line)) !== null) {
      const host = u[1];
      if (!isAllowedHost(host)) {
        violations.push({ file: fileRel, line: lineNo, id: "EXTERNAL_URL", text: `${host}` });
      }
    }

    // Token regexes
    for (const { id, re } of TOKEN_PATTERNS) {
      re.lastIndex = 0;
      const tm = line.match(re);
      if (tm) violations.push({ file: fileRel, line: lineNo, id, text: tm[0].slice(0, 40) + "…" });
    }

    // JWTs (allow the published Supabase publishable key)
    JWT_RE.lastIndex = 0;
    let j;
    while ((j = JWT_RE.exec(line)) !== null) {
      const tok = j[0];
      if (SUPABASE_PUBLIC_JWT && tok === SUPABASE_PUBLIC_JWT) continue;
      violations.push({ file: fileRel, line: lineNo, id: "JWT_LITERAL", text: tok.slice(0, 40) + "…" });
    }

    // import.meta.env.<NAME>
    const envRe = /import\.meta\.env\.([A-Z0-9_]+)/g;
    let e;
    while ((e = envRe.exec(line)) !== null) {
      const name = e[1];
      if (!ENV_ALLOWLIST.has(name)) {
        violations.push({ file: fileRel, line: lineNo, id: "DISALLOWED_ENV", text: name });
      }
    }
  });
}

// Also scan .env* files for unexpected variables
for (const envFile of [".env", ".env.local", ".env.production"]) {
  if (!existsSync(envFile)) continue;
  const text = readFileSync(envFile, "utf8");
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m) return;
    const name = m[1];
    if (!ENV_ALLOWLIST.has(name)) {
      violations.push({ file: envFile, line: i + 1, id: "DISALLOWED_ENV_FILE", text: name });
    }
  });
}

if (malformedMarkers.length) {
  console.error("\n❌ MALFORMED `third-party-allow` MARKERS (require reason=\"...\" and ref=\"...\"):");
  for (const m of malformedMarkers) console.error(`  ${m.file}:${m.line}\n    ${m.text}`);
}

if (violations.length || malformedMarkers.length) {
  if (violations.length) {
    console.error("\n❌ THIRD-PARTY / TOKEN GUARDRAIL FAILED\n");
    for (const v of violations) console.error(`  [${v.id}] ${v.file}:${v.line}  ${v.text}`);
    console.error(`\n${violations.length} violation(s). The frontend must not call third-party APIs or embed tokens. Route external calls through Supabase Edge Functions and store secrets server-side.\n`);
  }
  process.exit(1);
}

console.log(`✅ Third-party guardrail passed (${scanned} files scanned).`);