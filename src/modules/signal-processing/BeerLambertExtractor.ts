/**
 * BEER-LAMBERT CANDIDATE EXTRACTOR
 *
 * Generates physically-grounded PPG candidates from already-linearized RGB
 * (post-RadiometricProcessor) plus the per-channel running baseline (DC).
 *
 * Why these candidates and not more "exotic" ones?
 *  - G_abs / R_abs : absorbance −log(I/Iref) — natural Beer-Lambert pulse.
 *    Removes multiplicative illumination drift, equivalent to PI in dB units.
 *  - G_norm / R_norm : (Iref - I) / Iref — first-order linearization of the
 *    same quantity, more robust at low DC where log is unstable.
 *  - RG_abs_blend  : PI-weighted blend of R_abs and G_abs. G usually dominates
 *    SNR, R helps when fingertip is dark/melanin-rich.
 *  - log_ratio     : log(R/G) − log(Rref/Gref). Cancels overall illumination,
 *    useful as a chromaticity-style candidate that is insensitive to torch
 *    flicker affecting both channels equally.
 *
 * All outputs are unit-less and in roughly the same dynamic range so the
 * downstream ranker can compare them with a single SQI scale.
 */

export interface BLCandidates {
  G_abs: number;
  R_abs: number;
  RG_abs_blend: number;
  G_norm: number;
  R_norm: number;
  log_ratio: number;
}

const EPS = 1e-4;

export class BeerLambertExtractor {
  /**
   * @param lR linearized red,    0..255 (post-radiometric)
   * @param lG linearized green,  0..255
   * @param baseR running red baseline (DC)
   * @param baseG running green baseline (DC)
   * @param redPI perfusion index of red channel
   * @param greenPI perfusion index of green channel
   */
  compute(
    lR: number, lG: number,
    baseR: number, baseG: number,
    redPI = 0, greenPI = 0,
  ): BLCandidates {
    if (baseR < 5 || baseG < 5) {
      // Channels not yet warmed up — return zeros instead of NaN
      return { G_abs: 0, R_abs: 0, RG_abs_blend: 0, G_norm: 0, R_norm: 0, log_ratio: 0 };
    }

    const G_abs = -Math.log((lG + EPS) / (baseG + EPS)) * 2000;
    const R_abs = -Math.log((lR + EPS) / (baseR + EPS)) * 2000;
    const G_norm = (baseG - lG) / baseG * 3200;
    const R_norm = (baseR - lR) / baseR * 3200;

    // PI-weighted blend (emphasises whichever channel currently has more
    // pulsatility). Falls back to balanced 0.5/0.5 when no PI info yet.
    const piSum = redPI + greenPI;
    let wG = 0.6, wR = 0.4;
    if (piSum > 1e-4) {
      wG = Math.min(0.85, Math.max(0.25, greenPI / piSum));
      wR = 1 - wG;
    }
    const RG_abs_blend = G_abs * wG + R_abs * wR;

    // Chromaticity log-ratio with reference normalisation
    const log_ratio = (Math.log((lR + EPS) / (lG + EPS)) - Math.log((baseR + EPS) / (baseG + EPS))) * 2000;

    return { G_abs, R_abs, RG_abs_blend, G_norm, R_norm, log_ratio };
  }
}