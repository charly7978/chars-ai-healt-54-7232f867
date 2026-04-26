import type { FrameStats, OpticalGateResult } from './types';

/**
 * OpticalEvidenceGate
 * -------------------
 * Decides whether the camera is currently looking at a SOURCE COMPATIBLE
 * with PPG (perfused tissue under direct illumination), without using any
 * "looks like a finger" classifier. Pure radiometric reasoning:
 *
 *   - DC must be high enough to be illuminated tissue (flash-on contact)
 *     but not saturated white.
 *   - Red channel must dominate green and blue (hemoglobin absorbs G+B
 *     much more than R under broad-spectrum flash).
 *   - Clipping (high/low) must be small.
 *   - Spatial uniformity must be "tissue-like" (not perfectly flat like a
 *     painted wall AND not chaotic like a textured cloth).
 *   - The signal has to PERSIST across N frames before it counts as
 *     "opticalContact" (avoids spurious flashes).
 *
 * This is intentionally not a hard "finger detector": the cardiac stage
 * (CardiacSignalValidator) is the one that proves there is real PPG.
 */

const REQUIRED_CONTACT_FRAMES = 8;

export class OpticalEvidenceGate {
  private contactFrames = 0;

  reset(): void { this.contactFrames = 0; }

  evaluate(f: FrameStats, perfusionIndexRed: number, perfusionIndexGreen: number): OpticalGateResult {
    const rgRatio = f.greenLinear > 1e-4 ? f.redLinear / f.greenLinear : 0;
    const rbRatio = f.blueLinear > 1e-4 ? f.redLinear / f.blueLinear : 0;

    // 1. DC range: tissue under flash sits in a clearly bright region but
    //    not full-white. Below 0.10 linear ≈ basically dark/air.
    const dcOk = f.redLinear > 0.10 && f.redLinear < 0.985;
    // 2. Red dominance — characteristic of hemoglobin absorption with white flash.
    //    Pure red object on a sheet typically also has high R/G but tends to
    //    saturate red AND have R/B closer to 1; we require both ratios > 1.6.
    const redDom = rgRatio > 1.6 && rbRatio > 1.8;
    // 3. Clipping budget.
    const clipOk = f.clipHighRatio < 0.35 && f.clipLowRatio < 0.05;
    // 4. Spatial uniformity must be in a tissue-like range.
    //    < 0.55  → too textured (cloth, table, hand seen far away)
    //    > 0.995 → painted screen / perfectly flat surface
    const uniformOk = f.spatialUniformity > 0.55 && f.spatialUniformity < 0.998;

    const opticalFrameOk = dcOk && redDom && clipOk && uniformOk;
    if (opticalFrameOk) this.contactFrames = Math.min(this.contactFrames + 1, 240);
    else this.contactFrames = Math.max(0, this.contactFrames - 2);

    const opticalContact = this.contactFrames >= REQUIRED_CONTACT_FRAMES;

    // tissueCandidate = optical contact AND ratios in physiological band
    const tissueCandidate = opticalContact && rgRatio > 1.8 && rgRatio < 12;
    // perfusionCandidate = some real AC variability (any channel)
    const perfusionCandidate = perfusionIndexRed > 0.0008 || perfusionIndexGreen > 0.0008;

    let reason = 'OPTICAL_CONTACT_OK';
    if (!dcOk) reason = f.redLinear <= 0.10 ? 'NO_OPTICAL_CONTACT_DARK' : 'OVERSATURATED';
    else if (!redDom) reason = 'NO_HEMOGLOBIN_SIGNATURE';
    else if (!clipOk) reason = 'EXCESSIVE_CLIPPING';
    else if (!uniformOk) reason = f.spatialUniformity <= 0.55 ? 'NON_UNIFORM_SCENE' : 'FLAT_SURFACE_LIKE_SCREEN';
    else if (!opticalContact) reason = 'WAITING_OPTICAL_STABILITY';
    else if (!tissueCandidate) reason = 'NOT_TISSUE_LIKE_RATIOS';
    else if (!perfusionCandidate) reason = 'NO_AC_PERFUSION_YET';

    // Aggregate score for UI / SQI mixing.
    const components = [
      dcOk ? 1 : 0,
      redDom ? 1 : 0,
      clipOk ? 1 : 0,
      uniformOk ? 1 : 0,
      opticalContact ? 1 : 0,
      tissueCandidate ? 1 : 0,
      perfusionCandidate ? 1 : 0,
    ];
    const score = components.reduce((a, b) => a + b, 0) / components.length;

    return {
      opticalContact,
      tissueCandidate,
      perfusionCandidate,
      reason,
      score,
      metrics: {
        redDC: f.redLinear,
        rgRatio,
        rbRatio,
        perfusionIndexRed,
        perfusionIndexGreen,
        clipHighRatio: f.clipHighRatio,
        clipLowRatio: f.clipLowRatio,
        spatialUniformity: f.spatialUniformity,
        motionProxy: f.motionProxy,
        framesContact: this.contactFrames,
      },
    };
  }
}