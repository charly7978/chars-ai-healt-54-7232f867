#!/usr/bin/env node
/**
 * scripts/motion-tuning-telemetry.mjs
 * --------------------------------------------------------------------------
 * CI artifact generator for MotionRejection auto-tuning.
 *
 * Replays a deterministic battery of synthetic trackerSigma trajectories
 * (still / micro-drift / sliding / burst / mixed) through the same blending
 * math used in src/modules/signal-processing/MotionRejection.ts and writes
 * one NDJSON line per frame plus a final summary record into
 *
 *     artifacts/motion-tuning.ndjson
 *
 * The CI workflows then upload that file as a build artifact, so the
 * effUpgradeFrames / effAlpha / sigmaStd response curve can be inspected
 * across pipeline runs without booting a browser. This is *telemetry*, not
 * a test — it never fails the build, it only records the curve.
 *
 * Pure ESM, no TypeScript imports → runs under plain `node` in CI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// --- Mirror of DEFAULT_CONFIG in MotionRejection.ts ------------------------
const CFG = {
  upgradeConfirmFrames: 3,
  weightSmoothingAlpha: 0.35,
  upgradeConfirmFramesHigh: 8,
  weightSmoothingAlphaLow: 0.10,
  autoTuneSigmaTrigger: 1.0,
  autoTuneSigmaSaturate: 4.0,
  autoTuneWindow: 30,
};

function makeReplay() {
  const buf = new Float64Array(CFG.autoTuneWindow);
  let idx = 0, count = 0;
  let effFrames = CFG.upgradeConfirmFrames;
  let effAlpha = CFG.weightSmoothingAlpha;

  const std = () => {
    if (count < 4) return 0;
    let s = 0;
    for (let i = 0; i < count; i++) s += buf[i];
    const m = s / count;
    let v = 0;
    for (let i = 0; i < count; i++) { const d = buf[i] - m; v += d * d; }
    return Math.sqrt(v / count);
  };

  const recompute = () => {
    const s = std();
    const lo = CFG.autoTuneSigmaTrigger;
    const hi = Math.max(lo + 1e-3, CFG.autoTuneSigmaSaturate);
    const t = Math.max(0, Math.min(1, (s - lo) / (hi - lo)));
    const baseF = CFG.upgradeConfirmFrames;
    const highF = Math.max(baseF, CFG.upgradeConfirmFramesHigh);
    effFrames = Math.round(baseF + (highF - baseF) * t);
    const baseA = CFG.weightSmoothingAlpha;
    const lowA = Math.min(baseA, CFG.weightSmoothingAlphaLow);
    effAlpha = baseA + (lowA - baseA) * t;
    return s;
  };

  return (sigma) => {
    buf[idx] = sigma;
    idx = (idx + 1) % buf.length;
    if (count < buf.length) count++;
    const sigmaStd = recompute();
    return { effUpgradeFrames: effFrames, effAlpha, sigmaStd };
  };
}

// --- Synthetic trajectories ------------------------------------------------
function* trajectories() {
  // Each trajectory is 120 frames (~4 s @ 30 fps).
  const N = 120;
  yield { name: 'still',       seq: Array.from({ length: N }, () => 0.4) };
  yield { name: 'micro_drift', seq: Array.from({ length: N }, (_, i) => 1.5 + Math.sin(i / 6) * 0.6) };
  yield { name: 'sliding',     seq: Array.from({ length: N }, (_, i) => 4 + Math.sin(i / 4) * 1.5) };
  yield { name: 'burst',       seq: Array.from({ length: N }, (_, i) => (i % 25 === 0 ? 9 : 0.5)) };
  yield {
    name: 'mixed',
    seq: Array.from({ length: N }, (_, i) =>
      i < 30 ? 0.4 :
      i < 60 ? 1.5 + Math.sin(i / 5) * 0.6 :
      i < 90 ? 3.5 + Math.sin(i / 3) * 1.2 :
               0.6),
  };
}

// --- Run + emit NDJSON -----------------------------------------------------
const outPath = resolve(process.cwd(), 'artifacts/motion-tuning.ndjson');
mkdirSync(dirname(outPath), { recursive: true });

const lines = [];
const meta = {
  type: 'meta',
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA ?? null,
  runId:  process.env.GITHUB_RUN_ID ?? null,
  ref:    process.env.GITHUB_REF ?? null,
  config: CFG,
};
lines.push(JSON.stringify(meta));

for (const { name, seq } of trajectories()) {
  const step = makeReplay();
  let lastFrames = -1, lastAlpha = -1;
  let stateChanges = 0;
  let maxFrames = 0, minAlpha = Infinity, maxSigmaStd = 0;

  for (let i = 0; i < seq.length; i++) {
    const out = step(seq[i]);
    if (out.effUpgradeFrames !== lastFrames || Math.abs(out.effAlpha - lastAlpha) > 1e-6) {
      stateChanges++;
      lastFrames = out.effUpgradeFrames;
      lastAlpha  = out.effAlpha;
    }
    if (out.effUpgradeFrames > maxFrames) maxFrames = out.effUpgradeFrames;
    if (out.effAlpha < minAlpha) minAlpha = out.effAlpha;
    if (out.sigmaStd > maxSigmaStd) maxSigmaStd = out.sigmaStd;
    lines.push(JSON.stringify({
      type: 'sample',
      trajectory: name,
      frame: i,
      trackerSigma: +seq[i].toFixed(4),
      effUpgradeFrames: out.effUpgradeFrames,
      effAlpha: +out.effAlpha.toFixed(4),
      sigmaStd: +out.sigmaStd.toFixed(4),
    }));
  }
  lines.push(JSON.stringify({
    type: 'summary',
    trajectory: name,
    frames: seq.length,
    tuningChanges: stateChanges,
    maxEffUpgradeFrames: maxFrames,
    minEffAlpha: +minAlpha.toFixed(4),
    maxSigmaStd: +maxSigmaStd.toFixed(4),
  }));
}

writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`✅ MotionRejection tuning telemetry → ${outPath} (${lines.length} records)`);