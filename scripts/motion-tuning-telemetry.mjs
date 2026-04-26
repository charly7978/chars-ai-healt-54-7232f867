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
  autoTuneImuTrigger: 0.15,
  autoTuneImuSaturate: 0.80,
  autoTuneWindow: 30,
};

function makeReplay() {
  const sBuf = new Float64Array(CFG.autoTuneWindow);
  const iBuf = new Float64Array(CFG.autoTuneWindow);
  let sIdx = 0, sCount = 0, iIdx = 0, iCount = 0;
  let effFrames = CFG.upgradeConfirmFrames;
  let effAlpha = CFG.weightSmoothingAlpha;

  const std = (buf, count) => {
    if (count < 4) return 0;
    let s = 0;
    for (let i = 0; i < count; i++) s += buf[i];
    const m = s / count;
    let v = 0;
    for (let i = 0; i < count; i++) { const d = buf[i] - m; v += d * d; }
    return Math.sqrt(v / count);
  };

  const recompute = () => {
    const sOpt = std(sBuf, sCount);
    const loO = CFG.autoTuneSigmaTrigger;
    const hiO = Math.max(loO + 1e-3, CFG.autoTuneSigmaSaturate);
    const tOpt = Math.max(0, Math.min(1, (sOpt - loO) / (hiO - loO)));
    const sImu = std(iBuf, iCount);
    const loI = CFG.autoTuneImuTrigger;
    const hiI = Math.max(loI + 1e-3, CFG.autoTuneImuSaturate);
    const tImu = Math.max(0, Math.min(1, (sImu - loI) / (hiI - loI)));
    const t = Math.max(tOpt, tImu);
    const eps = 1e-6;
    const dominant = Math.abs(tOpt - tImu) < eps ? 'TIE' : (tOpt > tImu ? 'OPTICAL' : 'IMU');
    const baseF = CFG.upgradeConfirmFrames;
    const highF = Math.max(baseF, CFG.upgradeConfirmFramesHigh);
    effFrames = Math.round(baseF + (highF - baseF) * t);
    const baseA = CFG.weightSmoothingAlpha;
    const lowA = Math.min(baseA, CFG.weightSmoothingAlphaLow);
    effAlpha = baseA + (lowA - baseA) * t;
    return { sigmaStd: sOpt, imuStd: sImu, tOpt, tImu, tBlend: t, tDominant: dominant };
  };

  return (sigma, imu = 0) => {
    sBuf[sIdx] = sigma;
    sIdx = (sIdx + 1) % sBuf.length;
    if (sCount < sBuf.length) sCount++;
    iBuf[iIdx] = imu;
    iIdx = (iIdx + 1) % iBuf.length;
    if (iCount < iBuf.length) iCount++;
    const r = recompute();
    return { effUpgradeFrames: effFrames, effAlpha, ...r };
  };
}

// --- Synthetic trajectories ------------------------------------------------
function* trajectories() {
  // Each trajectory is 120 frames (~4 s @ 30 fps). `imu` is optional; if
  // omitted the IMU channel stays quiet so only the optical tuner reacts.
  const N = 120;
  yield { name: 'still',       seq: Array.from({ length: N }, () => ({ s: 0.4, i: 0.05 })) };
  yield { name: 'micro_drift', seq: Array.from({ length: N }, (_, k) => ({ s: 1.5 + Math.sin(k / 6) * 0.6, i: 0.10 })) };
  yield { name: 'sliding',     seq: Array.from({ length: N }, (_, k) => ({ s: 4 + Math.sin(k / 4) * 1.5, i: 0.30 })) };
  yield { name: 'burst',       seq: Array.from({ length: N }, (_, k) => ({ s: (k % 25 === 0 ? 9 : 0.5), i: (k % 25 === 0 ? 1.8 : 0.05) })) };
  // V9.3 — finger optically still, hand-held jitter only.
  yield { name: 'imu_only',    seq: Array.from({ length: N }, (_, k) => ({ s: 0.4, i: 0.4 + Math.sin(k / 5) * 0.5 })) };
  yield {
    name: 'mixed',
    seq: Array.from({ length: N }, (_, k) => ({
      s: k < 30 ? 0.4 :
         k < 60 ? 1.5 + Math.sin(k / 5) * 0.6 :
         k < 90 ? 3.5 + Math.sin(k / 3) * 1.2 :
                  0.6,
      i: k < 30 ? 0.05 :
         k < 60 ? 0.20 :
         k < 90 ? 0.55 :
                  0.05,
    })),
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
  let maxFrames = 0, minAlpha = Infinity, maxSigmaStd = 0, maxImuStd = 0;
  // V9.5 — count how many frames each branch dominated. Useful for
  // correlating downstream artefacts with the channel that drove tuning.
  const dominantCount = { OPTICAL: 0, IMU: 0, TIE: 0 };

  for (let i = 0; i < seq.length; i++) {
    const { s, i: imu } = seq[i];
    const out = step(s, imu);
    if (out.effUpgradeFrames !== lastFrames || Math.abs(out.effAlpha - lastAlpha) > 1e-6) {
      stateChanges++;
      lastFrames = out.effUpgradeFrames;
      lastAlpha  = out.effAlpha;
    }
    if (out.effUpgradeFrames > maxFrames) maxFrames = out.effUpgradeFrames;
    if (out.effAlpha < minAlpha) minAlpha = out.effAlpha;
    if (out.sigmaStd > maxSigmaStd) maxSigmaStd = out.sigmaStd;
    if (out.imuStd  > maxImuStd)   maxImuStd   = out.imuStd;
    dominantCount[out.tDominant]++;
    lines.push(JSON.stringify({
      type: 'sample',
      trajectory: name,
      frame: i,
      trackerSigma: +s.toFixed(4),
      imuScore: +imu.toFixed(4),
      effUpgradeFrames: out.effUpgradeFrames,
      effAlpha: +out.effAlpha.toFixed(4),
      sigmaStd: +out.sigmaStd.toFixed(4),
      imuStd:   +out.imuStd.toFixed(4),
      tOpt:     +out.tOpt.toFixed(4),
      tImu:     +out.tImu.toFixed(4),
      tBlend:   +out.tBlend.toFixed(4),
      tDominant: out.tDominant,
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
    maxImuStd:   +maxImuStd.toFixed(4),
    dominantCount,
  }));
}

writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`✅ MotionRejection tuning telemetry → ${outPath} (${lines.length} records)`);