import type { Beat, BeatDetectorState } from './types';

/**
 * BeatDetector
 * ------------
 * Adaptive peak detection on the bandpassed PPG, gated by:
 *   - cardiac evidence flag from validator
 *   - dynamic refractory derived from current dominantHz / bpmMedian
 *   - amplitude vs running median + MAD
 *   - rising-slope confirmation
 *   - RR plausibility window
 *
 * Returns acceptedBeat=true ONLY on the frame the new beat is confirmed.
 */

const HIST = 12;

export class BeatDetector {
  private prev = 0;
  private lastSign = 0;
  private peakCandidate: { t: number; v: number; slope: number } | null = null;
  private lastBeatTimeMs: number | null = null;
  private samples: number[] = [];
  private times: number[] = [];
  private beats: Beat[] = [];
  private rejectReason = '';

  reset(): void {
    this.prev = 0; this.lastSign = 0; this.peakCandidate = null;
    this.lastBeatTimeMs = null; this.samples = []; this.times = [];
    this.beats = []; this.rejectReason = '';
  }

  /**
   * Feed one bandpassed sample.
   * cardiacOk gate: do not produce beats unless validator agrees.
   * dominantHz lets us compute a refractory window.
   */
  process(value: number, tMs: number, cardiacOk: boolean, dominantHz: number): BeatDetectorState {
    this.samples.push(value);
    this.times.push(tMs);
    if (this.samples.length > 600) {
      this.samples.shift(); this.times.shift();
    }

    let acceptedBeat = false;
    this.rejectReason = '';

    if (!cardiacOk) {
      this.rejectReason = 'NO_CARDIAC_EVIDENCE';
      this.peakCandidate = null;
      this.lastSign = Math.sign(value - this.prev);
      this.prev = value;
      return this.snapshot(false);
    }

    const slope = value - this.prev;
    const sign = Math.sign(slope);

    // Detect zero-derivative crossing from positive to negative → peak.
    if (this.lastSign > 0 && sign <= 0) {
      this.peakCandidate = { t: tMs, v: this.prev, slope };
      this.tryAcceptCandidate(dominantHz);
      acceptedBeat = this.beats.length > 0
        && this.beats[this.beats.length - 1].tMs === this.peakCandidate?.t;
    }

    this.lastSign = sign;
    this.prev = value;
    return this.snapshot(acceptedBeat);
  }

  private tryAcceptCandidate(dominantHz: number): void {
    const cand = this.peakCandidate;
    if (!cand) return;

    // Amplitude vs robust threshold (median + 1.5 * MAD on recent samples).
    const w = this.samples.slice(-Math.min(this.samples.length, 90));
    if (w.length < 8) { this.rejectReason = 'NOT_ENOUGH_SAMPLES'; return; }
    const sorted = [...w].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const devs = w.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = devs[Math.floor(devs.length / 2)];
    const thresh = med + 1.4 * mad;
    if (cand.v < thresh) { this.rejectReason = 'BELOW_THRESHOLD'; return; }

    // Refractory based on current dominant frequency (or last RR).
    const expectedRR = dominantHz > 0 ? 1000 / dominantHz : 800;
    const refractory = Math.max(280, expectedRR * 0.55);

    if (this.lastBeatTimeMs !== null) {
      const rr = cand.t - this.lastBeatTimeMs;
      if (rr < refractory) { this.rejectReason = 'REFRACTORY'; return; }
      if (rr < 280 || rr > 2200) { this.rejectReason = 'IMPLAUSIBLE_RR'; return; }
      const beat: Beat = { tMs: cand.t, amplitude: cand.v, rrMs: rr, beatSQI: this.beatSQI(cand.v, mad) };
      this.beats.push(beat);
    } else {
      const beat: Beat = { tMs: cand.t, amplitude: cand.v, rrMs: 0, beatSQI: this.beatSQI(cand.v, mad) };
      this.beats.push(beat);
    }
    if (this.beats.length > HIST) this.beats.shift();
    this.lastBeatTimeMs = cand.t;
  }

  private beatSQI(amp: number, mad: number): number {
    if (mad <= 0) return 0;
    return Math.max(0, Math.min(1, (amp / (mad * 4))));
  }

  private snapshot(acceptedBeat: boolean): BeatDetectorState {
    const last = this.beats.length ? this.beats[this.beats.length - 1] : null;
    let bpmInstant: number | null = null;
    let bpmMedian: number | null = null;
    if (last && last.rrMs > 0) bpmInstant = Math.round(60000 / last.rrMs);
    if (this.beats.length >= 4) {
      const rrs = this.beats.filter(b => b.rrMs > 0).map(b => b.rrMs).sort((a, b) => a - b);
      if (rrs.length >= 3) {
        const m = rrs[Math.floor(rrs.length / 2)];
        bpmMedian = Math.round(60000 / m);
      }
    }
    return {
      acceptedBeat,
      lastBeat: last,
      beats: this.beats.slice(),
      bpmInstant,
      bpmMedian,
      rejectReason: this.rejectReason,
    };
  }
}