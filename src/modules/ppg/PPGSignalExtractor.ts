import { CardiacBandpass } from './BandpassFilter';
import { RingBuffer } from './RingBuffer';
import type { ExtractedPPG, FrameStats } from './types';

/**
 * PPGSignalExtractor
 * ------------------
 * Builds candidate PPG sources from per-frame stats and bandpasses the
 * winner. Sources:
 *   - GREEN_OD : detrended green optical density
 *   - RED_OD   : detrended red optical density (best with finger+flash)
 *   - CHROM    : POS/CHROM-like X = 3*r - 2*g, Y = 1.5*r + g - 1.5*b on
 *                normalized linear channels — robust to broadband illuminant
 *                drift.
 *
 * The active source is chosen by short-window quality score every ~1 s with
 * hysteresis (must beat the incumbent by 15% to switch).
 */

const WINDOW_S = 4; // seconds for AC/DC and source quality

export class PPGSignalExtractor {
  private bp = new CardiacBandpass(0.5, 4.0);
  private greenOD = new RingBuffer(512);
  private redOD = new RingBuffer(512);
  private chrom = new RingBuffer(512);
  private greenAC = new RingBuffer(512);
  private redAC = new RingBuffer(512);
  private blueAC = new RingBuffer(512);

  private greenLinearDC = 0;
  private redLinearDC = 0;
  private blueLinearDC = 0;
  private dcInit = false;

  private active: ExtractedPPG['selectedSource'] = 'NONE';
  private framesSinceSwitch = 0;

  reset(): void {
    this.bp = new CardiacBandpass(0.5, 4.0);
    this.greenOD.reset(); this.redOD.reset(); this.chrom.reset();
    this.greenAC.reset(); this.redAC.reset(); this.blueAC.reset();
    this.greenLinearDC = 0; this.redLinearDC = 0; this.blueLinearDC = 0;
    this.dcInit = false;
    this.active = 'NONE';
    this.framesSinceSwitch = 0;
  }

  process(frame: FrameStats, fs: number): ExtractedPPG {
    if (fs > 0) this.bp.setSampleRate(fs);

    // Slow DC tracking (per channel) for AC/DC computation.
    const a = this.dcInit ? 0.02 : 1.0;
    this.greenLinearDC += a * (frame.greenLinear - this.greenLinearDC);
    this.redLinearDC += a * (frame.redLinear - this.redLinearDC);
    this.blueLinearDC += a * (frame.blueLinear - this.blueLinearDC);
    this.dcInit = true;

    const greenAC = frame.greenLinear - this.greenLinearDC;
    const redAC = frame.redLinear - this.redLinearDC;
    const blueAC = frame.blueLinear - this.blueLinearDC;
    this.greenAC.push(greenAC);
    this.redAC.push(redAC);
    this.blueAC.push(blueAC);

    this.greenOD.push(frame.greenOD);
    this.redOD.push(frame.redOD);

    // CHROM-like: build on normalized linear channels.
    const sum = frame.redLinear + frame.greenLinear + frame.blueLinear + 1e-6;
    const rn = frame.redLinear / sum;
    const gn = frame.greenLinear / sum;
    const bn = frame.blueLinear / sum;
    const X = 3 * rn - 2 * gn;
    const Y = 1.5 * rn + gn - 1.5 * bn;
    const chrom = X - 0.5 * Y;
    this.chrom.push(chrom);

    const piRed = this.acdc(this.redAC, this.redLinearDC);
    const piGreen = this.acdc(this.greenAC, this.greenLinearDC);
    const piBlue = this.acdc(this.blueAC, this.blueLinearDC);

    const qGreen = this.sourceQuality(this.greenOD);
    const qRed = this.sourceQuality(this.redOD);
    const qChrom = this.sourceQuality(this.chrom);

    type Cand = { name: ExtractedPPG['selectedSource']; q: number; raw: number };
    const candidates: Cand[] = [
      { name: 'GREEN_OD', q: qGreen, raw: this.greenOD.last() },
      { name: 'RED_OD',   q: qRed,   raw: this.redOD.last() },
      { name: 'CHROM',    q: qChrom, raw: this.chrom.last() },
    ];
    candidates.sort((a, b) => b.q - a.q);
    const top = candidates[0];

    // Hysteresis: only switch if beating incumbent by 15% AND we have at
    // least 1 second on the previous source.
    let chosen = top;
    if (this.active !== 'NONE' && this.framesSinceSwitch < 30) {
      const inc = candidates.find(c => c.name === this.active);
      if (inc && top.q < inc.q * 1.15) chosen = inc;
    }
    if (chosen.name !== this.active) {
      this.active = chosen.name;
      this.framesSinceSwitch = 0;
      this.bp.reset();
    } else {
      this.framesSinceSwitch++;
    }

    const filtered = this.bp.process(chosen.raw);

    return {
      rawSelected: chosen.raw,
      filteredValue: filtered,
      selectedSource: this.active,
      acdc: { red: piRed, green: piGreen, blue: piBlue },
      perfusionIndex: { red: piRed, green: piGreen, blue: piBlue },
      sampleRate: fs,
      sourceQuality: chosen.q,
    };
  }

  private acdc(ac: RingBuffer, dc: number): number {
    if (ac.size() < 16 || dc <= 1e-4) return 0;
    const arr = ac.toArray();
    const n = arr.length;
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s += arr[i]; s2 += arr[i] * arr[i]; }
    const mean = s / n;
    const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    return std / dc;
  }

  private sourceQuality(buf: RingBuffer): number {
    if (buf.size() < 32) return 0;
    const arr = buf.toArray();
    const n = arr.length;
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { s += arr[i]; s2 += arr[i] * arr[i]; }
    const mean = s / n;
    const variance = Math.max(0, s2 / n - mean * mean);
    if (variance < 1e-10) return 0;
    // Quick "periodic-ness" proxy: zero-crossing rate near a plausible band.
    let zc = 0;
    for (let i = 1; i < n; i++) {
      const a = arr[i - 1] - mean;
      const b = arr[i] - mean;
      if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) zc++;
    }
    const zcr = zc / n;
    // Clamp variance to a workable range; reward periodic mid-zcr signals.
    const ampScore = Math.tanh(Math.sqrt(variance) * 200);
    const zcrScore = Math.max(0, 1 - Math.abs(zcr - 0.08) / 0.08);
    return Math.max(0, Math.min(1, 0.6 * ampScore + 0.4 * zcrScore));
  }
}