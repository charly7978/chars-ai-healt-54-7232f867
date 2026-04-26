/**
 * CameraQualityGate
 * --------------------------------------------------------------------------
 * Detects degenerate camera output ("bad G1/G2/G3 extraction") and asks the
 * caller to reinitialise the camera stream. G1/G2/G3 here mean:
 *
 *   G1 = mean green DC level   (must be in a forensically usable band)
 *   G2 = green AC amplitude    (proxy for pulsatility — must be non-zero)
 *   G3 = R/G perfusion ratio   (sanity check that the lens is covered)
 *
 * Failure modes the gate catches:
 *   • Black frame  (G1 ≈ 0)        → camera failed to expose
 *   • Saturated    (G1 ≥ 250)      → flash washed out everything
 *   • Dead AC      (G2 ≈ 0)        → frozen / duplicate frames
 *   • Wrong scene  (G3 < 0.2)      → finger off lens, looking at room
 *
 * The gate is forensic — it never *fakes* a good signal. It only signals
 * "please reopen the stream"; the caller decides whether to honour it.
 */

export interface CameraQualityInputs {
  redDC: number;       // 0..255
  greenDC: number;     // 0..255 (G1)
  redAC: number;       // raw AC magnitude
  greenAC: number;     // raw AC magnitude (G2)
}

export interface CameraQualityConfig {
  /** Frames the gate must see consistently bad before recommending reinit. */
  badFrameStreak: number;
  /** Cool-down in ms between two consecutive reinit recommendations. */
  reinitCooldownMs: number;
  /** G1 (greenDC) must lie inside [min, max] — outside = exposure broken. */
  greenDcMin: number;
  greenDcMax: number;
  /** G2 (greenAC) below this for `badFrameStreak` frames = frozen camera. */
  greenAcMin: number;
  /** G3 (redDC / greenDC) below this = lens not covered by finger. */
  rgRatioMin: number;
}

const DEFAULT: CameraQualityConfig = {
  // V9.5 — Forensic gate must be permissive enough to NOT fight the rest
  // of the pipeline. The previous defaults (1 s streak, greenAC ≥ 0.05)
  // were re-initing the camera in a loop on perfectly valid finger
  // contact, which is why "no signal" was reported. We now require a
  // 4 s sustained bad streak and only flag truly degenerate cases
  // (BLACK / SATURATED / NO_FINGER). Frozen-frame detection keeps a
  // very low AC threshold so short stalls don't trigger reinit.
  badFrameStreak: 120,        // ~4 s @ 30 fps
  reinitCooldownMs: 15000,
  greenDcMin: 4,
  greenDcMax: 252,
  greenAcMin: 0.005,
  rgRatioMin: 0.15,
};

export type CameraQualityVerdict =
  | { ok: true;  reason: 'OK' }
  | { ok: false; reason: 'BLACK' | 'SATURATED' | 'FROZEN' | 'NO_FINGER' | 'INVALID' };

export interface CameraSignalHealth {
  reason: CameraQualityVerdict['reason'];
  message: string;
  failing: string[];
  g1: { label: 'G1'; value: number; ok: boolean; failure: 'BLACK' | 'SATURATED' | 'INVALID' | null };
  g2: { label: 'G2'; value: number; ok: boolean; failure: 'FROZEN' | 'INVALID' | null };
  g3: { label: 'G3'; value: number; ok: boolean; failure: 'NO_FINGER' | 'INVALID' | null };
  framesSeen: number;
  badStreak: number;
  warmupRemainingMs: number;
  shouldReinitialize: boolean;
}

export class CameraQualityGate {
  private cfg: CameraQualityConfig = { ...DEFAULT };
  private badStreak = 0;
  private lastReinitAt = 0;
  private framesSeen = 0;
  private framesBad = 0;
  private lastVerdict: CameraQualityVerdict = { ok: true, reason: 'OK' };
  private lastInput: CameraQualityInputs = { redDC: 0, greenDC: 0, redAC: 0, greenAC: 0 };
  /** Wall-clock of the most recent reset() — used as warm-up anchor. */
  private warmupStart = performance.now();
  /** No reinit recommendations during the first warmupMs after reset. */
  private warmupMs = 5000;

  setConfig(patch: Partial<CameraQualityConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Per-frame inspection. Returns `true` when the host should reinit camera. */
  inspect(input: CameraQualityInputs, nowMs = performance.now()): boolean {
    this.framesSeen++;
    this.lastInput = input;
    const verdict = this.classify(input);
    this.lastVerdict = verdict;

    if (verdict.ok) {
      this.badStreak = 0;
      return false;
    }
    this.badStreak++;
    this.framesBad++;

    // Warm-up window after reset/reinit: never recommend another reinit,
    // just keep classifying so telemetry is honest.
    if (nowMs - this.warmupStart < this.warmupMs) return false;

    if (this.badStreak < this.cfg.badFrameStreak) return false;
    if (nowMs - this.lastReinitAt < this.cfg.reinitCooldownMs) return false;
    // Do NOT bounce the camera for normal operator states. NO_FINGER and
    // low early AC (FROZEN) should guide the user / accumulate signal, not
    // tear down the stream repeatedly. Only hard camera-output failures may
    // trigger an automatic recovery.
    if (!['BLACK', 'SATURATED', 'INVALID'].includes(verdict.reason)) return false;

    this.lastReinitAt = nowMs;
    this.badStreak = 0;
    return true;
  }

  private classify(i: CameraQualityInputs): CameraQualityVerdict {
    if (
      !Number.isFinite(i.greenDC) || !Number.isFinite(i.redDC) ||
      !Number.isFinite(i.greenAC) || !Number.isFinite(i.redAC)
    ) return { ok: false, reason: 'INVALID' };

    if (i.greenDC < this.cfg.greenDcMin)            return { ok: false, reason: 'BLACK' };
    if (i.greenDC > this.cfg.greenDcMax)            return { ok: false, reason: 'SATURATED' };
    if (i.greenAC < this.cfg.greenAcMin)            return { ok: false, reason: 'FROZEN' };

    const rg = i.greenDC > 0 ? i.redDC / i.greenDC : 0;
    if (rg < this.cfg.rgRatioMin)                   return { ok: false, reason: 'NO_FINGER' };

    return { ok: true, reason: 'OK' };
  }

  /** Telemetry — exposed for the debug panel and CI artifacts. */
  getStats(): {
    framesSeen: number;
    framesBad: number;
    badStreak: number;
    lastVerdict: CameraQualityVerdict;
    lastReinitAt: number;
  } {
    return {
      framesSeen: this.framesSeen,
      framesBad: this.framesBad,
      badStreak: this.badStreak,
      lastVerdict: this.lastVerdict,
      lastReinitAt: this.lastReinitAt,
    };
  }

  getSignalHealth(nowMs = performance.now()): CameraSignalHealth {
    const i = this.lastInput;
    const invalid = !Number.isFinite(i.greenDC) || !Number.isFinite(i.redDC) ||
      !Number.isFinite(i.greenAC) || !Number.isFinite(i.redAC);
    const rg = i.greenDC > 0 ? i.redDC / i.greenDC : 0;
    const g1Failure = invalid ? 'INVALID' : i.greenDC < this.cfg.greenDcMin ? 'BLACK' : i.greenDC > this.cfg.greenDcMax ? 'SATURATED' : null;
    const g2Failure = invalid ? 'INVALID' : i.greenAC < this.cfg.greenAcMin ? 'FROZEN' : null;
    const g3Failure = invalid ? 'INVALID' : rg < this.cfg.rgRatioMin ? 'NO_FINGER' : null;
    const failing = [g1Failure && `G1:${g1Failure}`, g2Failure && `G2:${g2Failure}`, g3Failure && `G3:${g3Failure}`].filter(Boolean) as string[];
    const warmupRemainingMs = Math.max(0, this.warmupMs - (nowMs - this.warmupStart));
    const hardFailure = ['BLACK', 'SATURATED', 'INVALID'].includes(this.lastVerdict.reason);
    const shouldReinitialize = hardFailure && warmupRemainingMs === 0 && this.badStreak >= this.cfg.badFrameStreak &&
      nowMs - this.lastReinitAt >= this.cfg.reinitCooldownMs;

    return {
      reason: this.lastVerdict.reason,
      message: this.toMessage(this.lastVerdict.reason, failing, shouldReinitialize),
      failing,
      g1: { label: 'G1', value: i.greenDC, ok: !g1Failure, failure: g1Failure },
      g2: { label: 'G2', value: i.greenAC, ok: !g2Failure, failure: g2Failure },
      g3: { label: 'G3', value: rg, ok: !g3Failure, failure: g3Failure },
      framesSeen: this.framesSeen,
      badStreak: this.badStreak,
      warmupRemainingMs,
      shouldReinitialize,
    };
  }

  private toMessage(reason: CameraQualityVerdict['reason'], failing: string[], shouldReinitialize: boolean): string {
    if (reason === 'OK') return 'G1/G2/G3 dentro de rango';
    const action = shouldReinitialize ? ' · reinicio de cámara preparado' : ' · manteniendo stream activo';
    return `${failing.join(' + ') || reason}${action}`;
  }

  reset(): void {
    this.badStreak = 0;
    this.framesSeen = 0;
    this.framesBad = 0;
    this.lastVerdict = { ok: true, reason: 'OK' };
    this.warmupStart = performance.now();
    // lastReinitAt is intentionally preserved so the cooldown still applies
    // across short-lived reset() calls (e.g. between sessions).
  }
}