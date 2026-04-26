import type { CardiacEvidence } from './types';

/**
 * CardiacSignalValidator
 * ----------------------
 * Confirms a candidate PPG signal carries real cardiac content via:
 *   - dominant spectral peak inside 0.7–3.5 Hz (42–210 BPM)
 *   - cardiac-band power vs total power (spectralSQI)
 *   - peak prominence (peakSQI)
 *   - cross-channel coherence between green and red AC
 *
 * Spectrum is computed via Goertzel scan over a coarse grid — much cheaper
 * than a full FFT for this band.
 */

const F_LOW = 0.7;
const F_HIGH = 3.5;
const STEP = 0.05;        // ~3 BPM resolution
const MIN_WINDOW_S = 6;

function goertzel(samples: number[], fs: number, freq: number): number {
  const N = samples.length;
  const k = Math.round(N * freq / fs);
  const w = (2 * Math.PI / N) * k;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let q0 = 0, q1 = 0, q2 = 0;
  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1; q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

export class CardiacSignalValidator {
  evaluate(filtered: number[], greenAC: number[], redAC: number[], fs: number): CardiacEvidence {
    if (fs < 5 || filtered.length < fs * MIN_WINDOW_S) {
      return {
        cardiacEvidence: false, spectralSQI: 0, peakSQI: 0,
        channelCoherence: 0, dominantHz: 0, bpmCandidate: null,
        reason: 'INSUFFICIENT_WINDOW',
      };
    }

    const n = filtered.length;
    let dom = 0;
    let domPow = 0;
    let totalPow = 0;

    // Total power across cardiac band + small DC reference up to F_HIGH+0.5.
    for (let f = F_LOW; f <= F_HIGH + 1e-6; f += STEP) {
      const p = goertzel(filtered, fs, f);
      totalPow += p;
      if (p > domPow) { domPow = p; dom = f; }
    }

    // Out-of-band reference: 0.1 and 5 Hz to estimate noise floor.
    const noisePow = goertzel(filtered, fs, 0.15) + goertzel(filtered, fs, 5.0);
    const spectralSQI = totalPow > 0
      ? Math.max(0, Math.min(1, (domPow / Math.max(totalPow, 1e-9))
          * (domPow / Math.max(domPow + noisePow, 1e-9))))
      : 0;

    // Peak prominence: dominant vs second-best in band.
    let secondPow = 0;
    for (let f = F_LOW; f <= F_HIGH + 1e-6; f += STEP) {
      if (Math.abs(f - dom) < 0.15) continue;
      const p = goertzel(filtered, fs, f);
      if (p > secondPow) secondPow = p;
    }
    const peakSQI = domPow > 0 ? Math.max(0, Math.min(1, 1 - secondPow / domPow)) : 0;

    // Channel coherence: zero-lag Pearson between green AC and red AC over
    // the same window. Real PPG should show modest positive correlation
    // (often inverted depending on illumination geometry — we take |r|).
    const m = Math.min(greenAC.length, redAC.length, n);
    let coherence = 0;
    if (m >= fs * 4) {
      const g = greenAC.slice(greenAC.length - m);
      const r = redAC.slice(redAC.length - m);
      let sg = 0, sr = 0;
      for (let i = 0; i < m; i++) { sg += g[i]; sr += r[i]; }
      const mg = sg / m, mr = sr / m;
      let num = 0, dg = 0, drr = 0;
      for (let i = 0; i < m; i++) {
        const a = g[i] - mg, b = r[i] - mr;
        num += a * b; dg += a * a; drr += b * b;
      }
      const denom = Math.sqrt(dg * drr);
      if (denom > 1e-12) coherence = Math.abs(num / denom);
    }

    const bpm = dom > 0 ? dom * 60 : 0;
    const cardiacEvidence = spectralSQI >= 0.18 && peakSQI >= 0.30 && coherence >= 0.20
      && bpm >= 42 && bpm <= 210;

    let reason = 'CARDIAC_OK';
    if (!cardiacEvidence) {
      if (spectralSQI < 0.18) reason = 'WEAK_CARDIAC_BAND';
      else if (peakSQI < 0.30) reason = 'NON_PROMINENT_PEAK';
      else if (coherence < 0.20) reason = 'NO_CHANNEL_COHERENCE';
      else reason = 'OUT_OF_HUMAN_BPM';
    }

    return {
      cardiacEvidence,
      spectralSQI,
      peakSQI,
      channelCoherence: coherence,
      dominantHz: dom,
      bpmCandidate: cardiacEvidence ? Math.round(bpm) : null,
      reason,
    };
  }
}