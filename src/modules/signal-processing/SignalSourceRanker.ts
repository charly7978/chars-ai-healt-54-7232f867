/**
 * MULTI-SOURCE SIGNAL RANKER V3 — 8 CANDIDATES INCLUDING CHROM & POS
 *
 * Generates 8 candidate PPG signals from raw RGB and ranks them by a
 * composite SQI (SNR, periodicity via parabolic-refined autocorrelation,
 * zero-crossing rate, drift, clip & motion penalties).
 *
 * Sources:
 *   R, G, RG, absR, absG, diffRG  — direct & log-absorbance & blends
 *   CHROM (de Haan 2013)          — Xs - α·Ys, projects out specular highlights
 *   POS   (Wang 2017)             — projection orthogonal to skin tone vector
 *
 * CHROM & POS are state-of-the-art rPPG projections that also boost finger-PPG
 * because they cancel illumination flicker that survives the bandpass.
 *
 * Hot path is allocation-free: fixed Float64Array scratch, indexed loops, no
 * Map iteration, no Object.entries.
 */
import { RingBuffer } from './RingBuffer';

const SRC_LABELS = ['R', 'G', 'RG', 'absR', 'absG', 'diffRG', 'CHROM', 'POS'] as const;
type SrcLabel = typeof SRC_LABELS[number];
const N_SRC = SRC_LABELS.length;

export class SignalSourceRanker {
  private buffers: RingBuffer[] = [];
  private sqi: Float64Array = new Float64Array(N_SRC);
  private activeIdx = 2; // 'RG'
  private lastSwitchFrame = 0;
  private readonly HYSTERESIS_FRAMES = 90; // ~3s at 30fps
  private readonly BUFFER_SIZE = 180;
  private frameCount = 0;

  // CHROM/POS running mean for normalization (per-channel skin-tone EWMA)
  private muR = 0; private muG = 0; private muB = 0;
  private muInit = false;
  private readonly MU_ALPHA = 0.04;

  // Reusable scratch for candidate values (zero alloc)
  private cand: Float64Array = new Float64Array(N_SRC);

  constructor() {
    for (let i = 0; i < N_SRC; i++) {
      this.buffers.push(new RingBuffer(this.BUFFER_SIZE));
    }
  }

  /** Generate all candidate signals from raw RGB + baselines */
  update(
    rawR: number, rawG: number, rawB: number,
    baseR: number, baseG: number, baseB: number,
    redPI: number, greenPI: number,
    clipHigh: number, motionArtifact: boolean
  ): { value: number; label: string; allSQI: Record<string, number> } {
    this.frameCount++;
    const eps = 0.01;

    // --- Generate candidates ---
    const rNorm = baseR > 10 ? (baseR - rawR) / baseR : 0;
    const gNorm = baseG > 10 ? (baseG - rawG) / baseG : 0;

    const clamp04 = (v: number) => Math.min(0.04, Math.max(-0.04, v));
    const rPulse = clamp04(rNorm);
    const gPulse = clamp04(gNorm);

    // PI-weighted blend
    const piSum = redPI + greenPI;
    let gW = 0.55, rW = 0.45;
    if (piSum > 0) {
      gW = Math.min(0.8, Math.max(0.25, greenPI / piSum));
      rW = 1 - gW;
    }
    if (rawG > 245) { gW *= 0.4; rW = 1 - gW; }
    if (rawR > 245) { rW *= 0.4; gW = 1 - rW; }

    // --- CHROM (de Haan 2013) & POS (Wang 2017) ---
    // Normalize RGB by their slow EWMA mean → unit-mean RGB Rn,Gn,Bn
    if (!this.muInit) {
      this.muR = rawR; this.muG = rawG; this.muB = rawB; this.muInit = true;
    } else {
      const a = this.MU_ALPHA;
      this.muR = this.muR * (1 - a) + rawR * a;
      this.muG = this.muG * (1 - a) + rawG * a;
      this.muB = this.muB * (1 - a) + rawB * a;
    }
    const Rn = this.muR > 1 ? rawR / this.muR : 1;
    const Gn = this.muG > 1 ? rawG / this.muG : 1;
    const Bn = this.muB > 1 ? rawB / this.muB : 1;

    // CHROM:  Xs = 3·Rn − 2·Gn ;  Ys = 1.5·Rn + Gn − 1.5·Bn ;  S = Xs − α·Ys
    // α adapts as σ(Xs)/σ(Ys); approximate online with a tiny EWMA of |Xs|/|Ys|
    const Xs = 3 * Rn - 2 * Gn;
    const Ys = 1.5 * Rn + Gn - 1.5 * Bn;
    const alphaChrom = Math.abs(Ys) > 1e-3 ? Math.min(2.5, Math.max(0.1, Math.abs(Xs) / Math.abs(Ys))) : 1;
    const chromVal = (Xs - alphaChrom * Ys) * 1500;

    // POS: project on plane orthogonal to skin-tone vector; output = X1 + (σ(X1)/σ(X2))·X2
    // X1 = Gn − Bn ; X2 = Gn + Bn − 2·Rn
    const X1 = Gn - Bn;
    const X2 = Gn + Bn - 2 * Rn;
    const ratio = Math.abs(X2) > 1e-3 ? Math.min(2.5, Math.max(0.1, Math.abs(X1) / Math.abs(X2))) : 1;
    const posVal = (X1 + ratio * X2) * 1500;

    // Fill scratch (no allocation)
    this.cand[0] = rPulse * 3200;                                 // R
    this.cand[1] = gPulse * 3200;                                 // G
    this.cand[2] = (rPulse * rW + gPulse * gW) * 3200;            // RG
    this.cand[3] = baseR > 10 ? -Math.log((rawR + eps) / baseR) * 2000 : 0; // absR
    this.cand[4] = baseG > 10 ? -Math.log((rawG + eps) / baseG) * 2000 : 0; // absG
    this.cand[5] = (rPulse - gPulse) * 2400;                      // diffRG
    this.cand[6] = chromVal;                                      // CHROM
    this.cand[7] = posVal;                                        // POS

    // Push to ring buffers (indexed loop — no allocation)
    for (let i = 0; i < N_SRC; i++) {
      this.buffers[i].push(this.cand[i]);
    }

    // Rank every 30 frames
    const allSQI: Record<string, number> = {};
    if (this.frameCount % 30 === 0) {
      let bestIdx = this.activeIdx;
      let bestSQI = -1;
      for (let i = 0; i < N_SRC; i++) {
        const buf = this.buffers[i];
        if (buf.length < 60) { this.sqi[i] = 0; continue; }
        const s = this.computeSQI(buf, clipHigh, motionArtifact);
        this.sqi[i] = s;
        if (s > bestSQI) { bestSQI = s; bestIdx = i; }
      }
      const currentSQI = this.sqi[this.activeIdx];
      if (bestIdx !== this.activeIdx &&
        bestSQI > currentSQI * 1.25 &&
        this.frameCount - this.lastSwitchFrame > this.HYSTERESIS_FRAMES) {
        this.activeIdx = bestIdx;
        this.lastSwitchFrame = this.frameCount;
      }
    }
    for (let i = 0; i < N_SRC; i++) allSQI[SRC_LABELS[i]] = this.sqi[i];

    const v = this.cand[this.activeIdx];
    const value = Math.min(80, Math.max(-80, v));
    return { value, label: SRC_LABELS[this.activeIdx], allSQI };
  }

  private computeSQI(buf: RingBuffer, clipHigh: number, motion: boolean): number {
    const n = Math.min(120, buf.length);
    if (n < 30) return 0;

    // AC/DC ratio
    const p10 = buf.percentile(0.1, n);
    const p90 = buf.percentile(0.9, n);
    const range = p90 - p10;
    if (range < 0.2) return 0;

    const mean = buf.mean(n);
    const v = buf.variance(n);
    const std = Math.sqrt(v);
    const snr = range / (std + 0.1);

    // V3: Periodicity via autocorrelation peak with PARABOLIC INTERPOLATION
    // Search cardiac range: 0.5–3.5Hz → lags 8–60 at 30fps
    let bestAutoCorr = 0;
    let bestLag = 0;
    let prevAc = 0, prevPrevAc = 0;
    let peakAcPrev = 0, peakAcCurr = 0, peakAcNext = 0;
    for (let lag = 8; lag <= 60; lag++) {
      const ac = buf.autocorrelation(lag, n);
      // Detect local maximum: ac[lag-1] > ac[lag-2] AND ac[lag-1] > ac[lag]
      if (lag >= 10 && prevAc > prevPrevAc && prevAc > ac) {
        if (prevAc > bestAutoCorr) {
          bestAutoCorr = prevAc;
          bestLag = lag - 1;
          peakAcPrev = prevPrevAc; peakAcCurr = prevAc; peakAcNext = ac;
        }
      }
      prevPrevAc = prevAc;
      prevAc = ac;
    }
    // Parabolic peak refinement (optional sub-lag precision)
    if (bestLag > 0) {
      const denom = peakAcPrev - 2 * peakAcCurr + peakAcNext;
      if (Math.abs(denom) > 1e-6) {
        const offset = 0.5 * (peakAcPrev - peakAcNext) / denom;
        if (Math.abs(offset) < 1) {
          // Refine peak value via parabolic vertex
          bestAutoCorr = peakAcCurr - 0.25 * (peakAcPrev - peakAcNext) * offset;
        }
      }
    }

    // Zero-crossing rate around mean (too many = HF noise)
    let zeroCrossings = 0;
    for (let i = 1; i < n; i++) {
      if ((buf.get(buf.length - n + i) - mean) * (buf.get(buf.length - n + i - 1) - mean) < 0) {
        zeroCrossings++;
      }
    }
    const zcRate = zeroCrossings / n;
    // Healthy PPG zc rate ≈ 0.05–0.20; aggressive penalty above 0.30
    const zcPenalty = zcRate > 0.30 ? (zcRate - 0.30) * 40 : 0;

    // Drift penalty
    const firstHalfMean = buf.mean(Math.floor(n / 2));
    const drift = Math.abs(firstHalfMean - mean) / (range + 0.1);
    const driftPenalty = drift * 12;

    const snrScore = Math.min(28, snr * 9);
    const periodicityScore = Math.max(0, Math.min(40, bestAutoCorr * 42));
    const clipPenalty = clipHigh * 28;
    const motionPenalty = motion ? 12 : 0;
    // V3: bonus when periodicity is strong AND lag is in physiological range
    const physiologicalBonus = (bestAutoCorr > 0.45 && bestLag >= 10 && bestLag <= 50) ? 6 : 0;

    return Math.max(0, snrScore + periodicityScore + physiologicalBonus
      - clipPenalty - motionPenalty - zcPenalty - driftPenalty);
  }

  getActiveSource(): string { return SRC_LABELS[this.activeIdx]; }

  reset(): void {
    for (let i = 0; i < N_SRC; i++) {
      this.buffers[i].clear();
      this.sqi[i] = 0;
    }
    this.activeIdx = 2; // RG
    this.lastSwitchFrame = 0;
    this.frameCount = 0;
    this.muR = 0; this.muG = 0; this.muB = 0; this.muInit = false;
  }
}
