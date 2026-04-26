# Forensic CI gate: block simulation/random/mock/defaults on every push & PR

## Goal
Make it impossible to merge or push code that reintroduces simulated data, `Math.random`, mock/fake placeholders, or hardcoded physiological defaults (BPM=70/72/75, SpO₂=97/98/99, BP=120/80, glucose=100, cholesterol=200, etc.). Today the CI only runs `npm run build`, so the existing forensic guards (`scripts/audit-forensic.mjs`, `src/test/forensic-audit.test.ts`, `.githooks/pre-commit`) are advisory only.

## What's already in place (reuse, don't duplicate)
- `scripts/audit-forensic.mjs` — Node script that scans `src/modules`, `src/hooks`, `src/pages`, `src/components` for forbidden patterns; exits 1 on violations.
- `src/test/forensic-audit.test.ts` — Vitest suite with a stricter rule set + an explicit allowlist with justifications, plus a "liveness thresholds" lock-in test for `PPGSignalProcessor`.
- `.githooks/pre-commit` — local hook that blocks commits containing `Math.random`, simulation keywords, non-physiological literals, or the obsolete `HeartRateDisplay`.

## Changes

### 1. `package.json` — add first-class scripts
Add (no new dependencies; `vitest` is already a devDep):
- `"test": "vitest run"`
- `"test:forensic": "vitest run src/test/forensic-audit.test.ts"`
- `"audit:forensic": "node scripts/audit-forensic.mjs"`
- `"ci:guard": "npm run audit:forensic && npm run test:forensic && npm run lint && npm run build"`

This gives both humans and CI a single command (`npm run ci:guard`) that fails fast on any forensic regression.

### 2. `.github/workflows/npm-gulp.yml` — turn the build job into a real gate
Rename to a clearer `Forensic CI` workflow and restructure into ordered, required steps so a failure in any step fails the check:
1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version: 20.x` and `cache: 'npm'` (drop the 18/20/22 matrix — Node 18 is EOL and the matrix triples CI cost without catching anything the audit cares about; a single LTS makes the required check unambiguous).
3. `npm ci`
4. **Forensic audit script** — `npm run audit:forensic` (fails on `Math.random`, `|| 70/72/75/97/98/99/120/80/60/90`, mock/fake/synthetic/placeholder tokens in pipeline modules).
5. **Forensic Vitest suite** — `npm run test:forensic` (the stricter superset with allowlist + the `PPGSignalProcessor` threshold lock-ins).
6. **Full unit tests** — `npm run test` (33/33 must stay green: arrhythmia, gates, sample-rate, sr-diagnostics).
7. **Lint** — `npm run lint`.
8. **Build** — `npm run build`.

Each step runs independently so the PR check annotations point at the exact failing gate (audit vs. test vs. lint vs. build).

### 3. `.github/workflows/forensic-pr.yml` — new dedicated PR-only job
Small additional workflow that runs **only** `npm run audit:forensic` + `npm run test:forensic` on `pull_request` events. Rationale:
- Gives a fast (~30s) signal on every PR independent of the heavier build matrix.
- Appears as its own required check in branch protection, so the violation reason is visible without digging through build logs.
- Uses `concurrency: { group: forensic-${{ github.ref }}, cancel-in-progress: true }` to avoid wasted runs on force-pushes.

### 4. `.githooks/pre-push` — new local gate that mirrors CI
Add a pre-push hook that runs `npm run audit:forensic && npm run test:forensic` before allowing a push. Pre-commit already blocks the obvious patterns line-by-line; pre-push catches cross-file regressions (e.g. a new file under `src/modules/biomarkers/` that re-adds a `|| 100` glucose default) before they reach GitHub. The hook is opt-in via `git config core.hooksPath .githooks` (the convention already used by the existing pre-commit).

### 5. `docs/medical-validation.md` — append a "Forensic CI" section
Document for future contributors:
- The exact list of forbidden patterns and where they're enforced (script vs. vitest vs. hook).
- How to add an entry to the `ALLOWLIST` in `src/test/forensic-audit.test.ts` with a written justification (the only escape hatch).
- The required-checks list to configure in GitHub branch protection: `Forensic CI / build` and `forensic-pr / audit`.

### 6. README — short "CI gates" section
One paragraph + the `npm run ci:guard` command so any contributor (or a future AI session) knows the local equivalent of the CI gate.

## Explicitly NOT in scope
- No changes to `src/integrations/supabase/client.ts`, `src/integrations/supabase/types.ts`, or `.env`.
- No changes to the signal-processing pipeline, vital estimators, UI, or camera code — this task is purely the enforcement layer.
- Not touching `supabase/config.toml` project-level settings.
- Not adding new runtime dependencies; everything reuses `vitest` and plain Node.

## Verification after implementation
1. `npm run ci:guard` passes locally on current `main` (baseline must be green — audit + 33/33 tests already pass per prior turn).
2. Insert a deliberate violation (e.g. `const fallbackBpm = real || 72;` in `src/hooks/useHealthAnalysis.ts`), re-run `npm run ci:guard`, and confirm BOTH `audit:forensic` and `test:forensic` fail with a file:line message naming the rule. Revert.
3. Push a throwaway branch and confirm the new `forensic-pr` check appears and blocks merge on GitHub.
4. Confirm branch protection on `main` lists the two required checks.

## Result
Any future change — by a human, an AI, or a merge from a fork — that reintroduces `Math.random`, simulation tokens, or hardcoded vital defaults in `src/` will fail CI before it can land, with a precise file:line:rule message. The existing allowlist remains the single, auditable escape hatch.