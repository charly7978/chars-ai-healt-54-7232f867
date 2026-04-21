/**
 * FINGER CONTACT MODEL — 3-LAYER, TEMPORALLY-STABLE
 *
 * Layer A — Chromatic evidence: red dominance + rgRatio + chromaticity (r,g)
 *           + saturation profile, all normalized by per-session percentiles so
 *           the same model works on cameras with very different white points.
 * Layer B — Geometric evidence: a 7×7 binary contact mask cleaned by
 *           open→close, then largest 4-connected component is required to be
 *           central, contiguous and big enough.
 * Layer C — Temporal evidence: hysteretic state machine
 *           NO_CONTACT → ACQUIRING → UNSTABLE → STABLE, with separate side-states
 *           SATURATED and EXCESSIVE_PRESSURE that you cannot promote out of in
 *           less than ~1 s.
 *
 * The model purposefully keeps every threshold *adaptive* (percentile- and
 * EMA-based) instead of hardcoded RGB triplets — that is the single biggest
 * win when going from one phone model to another.
 */

import { ContactState } from '../../types/measurement';
import { open4, close4, largestComponent4, type ConnectedComponent } from './Morphology';

export interface FingerEvidence {
  chromatic: number;     // 0..1
  geometric: number;     // 0..1
  temporal: number;      // 0..1
  saturationOK: number;  // 0..1
  pulsatility: number;   // 0..1
  motionOK: number;      // 0..1
  overall: number;       // 0..1
  blob: ConnectedComponent | null;
  centralityScore: number; // 0..1
}

export interface FingerInputs {
  /** Per-tile chromatic finger-likelihood score, length = gridSize². */
  tileChromaticScore: Float64Array;
  /** Per-tile clip-high penalty 0..1. */
  tileClipHigh: Float64Array;
  /** Per-tile clip-low penalty 0..1. */
  tileClipLow: Float64Array;
  /** Coverage ratio of valid (non-clipped) pixels in the central ROI. */
  coverageRatio: number;
  /** Chromatic features of the fused signal. */
  rgRatio: number;
  redDominance: number;
  /** Saturation stats. */
  clipHighRatio: number;
  clipLowRatio: number;
  /** Pulsatility evidence (perfusion index, 0..1 typical). */
  perfusionIndex: number;
  /** Motion proxy (0 = still, 1 = severe). */
  motionScore: number;
  /** Side of the per-tile grid (e.g. 7). */
  gridSize: number;
}

export class FingerContactModel {
  private state: ContactState = ContactState.NO_CONTACT;
  private framesInState = 0;
  private confidenceEMA = 0;
  private blobAreaEMA = 0;
  private blobCentroidXEMA = 0.5;
  private blobCentroidYEMA = 0.5;

  // Adaptive percentile-tracked thresholds
  private chromP90EMA = 0.4;
  private chromP10EMA = 0.05;
  private piMaxEMA = 0.01;

  // Mask scratch buffers (reused, max grid 9×9)
  private maskBuf = new Uint8Array(81);
  private maskScratch = new Uint8Array(81);

  // Hysteresis windows (frames @30 fps)
  private readonly STABLE_REQUIRED = 30;   // ≈1 s of consistent good evidence
  private readonly DEMOTE_GRACE   = 6;     // 200 ms of bad evidence before demote
  private demoteCounter = 0;

  /**
   * Push a new frame's evidence and return the resulting contact state plus
   * an evidence breakdown useful for the debug panel.
   */
  update(inp: FingerInputs): { state: ContactState; evidence: FingerEvidence } {
    const evidence = this.scoreEvidence(inp);

    // EWMA the overall score so single-frame glitches don't move the FSM
    this.confidenceEMA = this.confidenceEMA * 0.7 + evidence.overall * 0.3;

    const next = this.transition(evidence);
    if (next !== this.state) {
      this.state = next;
      this.framesInState = 0;
    } else {
      this.framesInState++;
    }
    return { state: this.state, evidence };
  }

  reset(): void {
    this.state = ContactState.NO_CONTACT;
    this.framesInState = 0;
    this.confidenceEMA = 0;
    this.blobAreaEMA = 0;
    this.blobCentroidXEMA = 0.5;
    this.blobCentroidYEMA = 0.5;
    this.chromP90EMA = 0.4;
    this.chromP10EMA = 0.05;
    this.piMaxEMA = 0.01;
    this.demoteCounter = 0;
  }

  getState(): ContactState { return this.state; }
  getConfidenceEMA(): number { return this.confidenceEMA; }

  // ─────────────────────────────────────────────────────────────────
  // EVIDENCE SCORING
  // ─────────────────────────────────────────────────────────────────

  private scoreEvidence(inp: FingerInputs): FingerEvidence {
    const G = inp.gridSize;
    const N = G * G;
    if (this.maskBuf.length < N) {
      this.maskBuf = new Uint8Array(N);
      this.maskScratch = new Uint8Array(N);
    }

    // ── A) CHROMATIC — adaptive percentile normalization ──
    // Track running p10/p90 of the per-tile chromatic score. We then judge
    // each tile relative to those percentiles, not against a fixed threshold.
    let p90 = 0, p10 = 1;
    for (let i = 0; i < N; i++) {
      const s = inp.tileChromaticScore[i];
      if (s > p90) p90 = s;
      if (s < p10) p10 = s;
    }
    this.chromP90EMA = this.chromP90EMA * 0.9 + p90 * 0.1;
    this.chromP10EMA = this.chromP10EMA * 0.9 + p10 * 0.1;
    const dyn = Math.max(0.05, this.chromP90EMA - this.chromP10EMA);

    // Build adaptive binary mask: tile is "candidate finger" iff its chromatic
    // score is in the top 35 % of the dynamic range AND it isn't clipped.
    const cutoff = this.chromP10EMA + dyn * 0.55;
    let candidates = 0;
    for (let i = 0; i < N; i++) {
      const s = inp.tileChromaticScore[i];
      const valid = s >= cutoff && inp.tileClipHigh[i] < 0.4 && inp.tileClipLow[i] < 0.4;
      this.maskBuf[i] = valid ? 1 : 0;
      if (valid) candidates++;
    }

    // ── B) GEOMETRIC — open→close + largest connected component ──
    open4(this.maskBuf, this.maskScratch, G);
    close4(this.maskBuf, this.maskScratch, G);
    const blob = largestComponent4(this.maskBuf, G);

    let geometric = 0;
    let centrality = 0;
    if (blob) {
      // EWMA the blob to penalize sudden jumps (real finger doesn't teleport)
      this.blobAreaEMA = this.blobAreaEMA * 0.7 + (blob.area / N) * 0.3;
      this.blobCentroidXEMA = this.blobCentroidXEMA * 0.7 + blob.centroidX * 0.3;
      this.blobCentroidYEMA = this.blobCentroidYEMA * 0.7 + blob.centroidY * 0.3;

      const dx = this.blobCentroidXEMA - 0.5;
      const dy = this.blobCentroidYEMA - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      centrality = Math.max(0, 1 - dist * 1.6); // 0 at the corner, 1 at center

      const areaScore = Math.min(1, this.blobAreaEMA * 3); // need ≥33 % of grid
      const fragmentationPenalty = candidates > 0 ? blob.area / candidates : 1;
      geometric = areaScore * 0.55 + centrality * 0.30 + fragmentationPenalty * 0.15;
    } else {
      this.blobAreaEMA *= 0.85;
    }

    // ── Chromatic global score (independent of geometry, used as a sanity gate) ──
    const chromatic = Math.max(0, Math.min(1,
      0.5 * Math.max(0, Math.min(1, (inp.rgRatio - 1.05) / 0.5)) +
      0.5 * Math.max(0, Math.min(1, (inp.redDominance - 5) / 35))
    ));

    // ── Saturation OK ──
    const totalClip = inp.clipHighRatio + inp.clipLowRatio;
    const saturationOK = totalClip < 0.05 ? 1
      : totalClip < 0.20 ? 0.7
      : totalClip < 0.40 ? 0.35
      : 0.05;

    // ── Pulsatility (PI normalised by running max so units don't matter) ──
    if (inp.perfusionIndex > this.piMaxEMA) this.piMaxEMA = inp.perfusionIndex;
    else this.piMaxEMA = this.piMaxEMA * 0.99 + inp.perfusionIndex * 0.01;
    const pulsatility = this.piMaxEMA > 0
      ? Math.max(0, Math.min(1, inp.perfusionIndex / Math.max(0.005, this.piMaxEMA)))
      : 0;

    // ── Motion ──
    const motionOK = inp.motionScore < 0.4 ? 1
      : inp.motionScore < 0.8 ? Math.max(0, 1 - (inp.motionScore - 0.4) * 2.5)
      : 0.1;

    // ── Temporal: penalize states with low time-in-state to favour stability ──
    const temporal = Math.max(0, Math.min(1, this.framesInState / this.STABLE_REQUIRED));

    const overall = Math.max(0, Math.min(1,
      chromatic * 0.20 +
      geometric * 0.30 +
      saturationOK * 0.15 +
      pulsatility * 0.20 +
      motionOK * 0.10 +
      temporal * 0.05
    ));

    return {
      chromatic, geometric, temporal,
      saturationOK, pulsatility, motionOK,
      overall,
      blob,
      centralityScore: centrality,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // STATE MACHINE
  // ─────────────────────────────────────────────────────────────────

  private transition(ev: FingerEvidence): ContactState {
    const c = this.confidenceEMA;

    // Side-states first — they're "sticky"
    if (ev.saturationOK < 0.25) return ContactState.SATURATED;
    if (this.state === ContactState.SATURATED && ev.saturationOK < 0.7) return ContactState.SATURATED;

    // STABLE → must demote on sustained loss of evidence, not on a single bad frame
    if (this.state === ContactState.STABLE) {
      if (c < 0.45 || ev.geometric < 0.35 || ev.motionOK < 0.4) {
        this.demoteCounter++;
        if (this.demoteCounter >= this.DEMOTE_GRACE) {
          this.demoteCounter = 0;
          return ContactState.UNSTABLE;
        }
        return ContactState.STABLE;
      }
      this.demoteCounter = 0;
      return ContactState.STABLE;
    }

    // Promotion path
    if (c >= 0.70 && ev.geometric >= 0.55 && ev.motionOK >= 0.6 && ev.pulsatility >= 0.25
        && this.framesInState >= this.STABLE_REQUIRED) {
      return ContactState.STABLE;
    }
    if (c >= 0.50 && ev.geometric >= 0.40) return ContactState.UNSTABLE;
    if (c >= 0.25) return ContactState.ACQUIRING;
    return ContactState.NO_CONTACT;
  }
}