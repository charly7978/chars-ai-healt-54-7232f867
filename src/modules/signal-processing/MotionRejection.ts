/**
 * MotionRejection — V9
 * --------------------
 * Fusión de tres señales ortogonales de movimiento en un único peso
 * `motionWeight ∈ [0,1]` y un estado discreto `MotionRejectionState`.
 * Complementa al `MotionClassifier` (IMU) sumando dos proxies ópticos:
 *
 *   - trackerSigma   : sqrt(P) del Kalman 1D del centroide ROI
 *   - centroidJumpPx : magnitud de la observación rechazada por outlier-gate
 *   - maskIoU        : Jaccard frame-to-frame de la máscara binaria 9×9
 *
 * Reglas (sin clamping fisiológico — solo pesos internos):
 *   BURST_MOTION  centroidJumpPx > 12 ∧ imuScore > 1.6   weight 0.15
 *   SLIDING       maskIoU<0.55  ∨  trackerSigma>6        weight 0.40
 *   MICRO_DRIFT   trackerSigma∈[2.5,6] ∨ imu∈[0.6,0.95]  weight 0.80
 *   STILL         resto                                  weight 1.00
 *
 * Hysteresis: una vez en SLIDING/BURST se exigen 6 frames consecutivos
 * STILL para volver. Evita oscilación en el límite del umbral.
 *
 * Forensic: NUNCA bloquea publicación. Sólo re-pesa SQI, congela baselines
 * cuando hay deslizamiento, y reduce contribución al ranker. El operador
 * siempre ve la traza viva con calidad honesta.
 */

export type MotionRejectionState =
  | 'STILL'
  | 'MICRO_DRIFT'
  | 'SLIDING'
  | 'BURST_MOTION';

export interface MotionRejectionInputs {
  imuScore: number;        // EWMA RMS aceleración + giroscopio (0..3+)
  trackerSigma: number;    // sqrt(P) Kalman ROI en px
  maskIoU: number;         // Jaccard temporal en grid 9x9
  centroidJumpPx: number;  // |observación − predict| del Kalman este frame
}

export interface MotionRejectionResult {
  state: MotionRejectionState;
  weight: number;
  freezeBaselines: boolean;
}

/**
 * V9.1 — Configurable clamping + dual hysteresis.
 *
 * Two failure modes were observed in borderline motion:
 *   1. State flicker  : trackerSigma oscillating around 2.5 px or imuScore
 *      around 0.6 toggled STILL ↔ MICRO_DRIFT every frame, making the
 *      published weight visibly chatter (1.00 → 0.80 → 1.00 → …).
 *   2. Weight chatter : even when state is stable, switching causes a hard
 *      step in the SQI multiplier downstream → audible/visible jitter on
 *      the trace and the BPM display.
 *
 * Fix:
 *   - `upgradeConfirmFrames`  : need N consecutive worse-than-current
 *                               candidates before escalating from STILL.
 *   - `weightSmoothingAlpha`  : 1-pole low-pass on the materialised weight
 *                               (alpha=1 → instant, current default 0.35).
 *   - `weightClampMin/Max`    : hard floor/ceiling so the smoother can't
 *                               drift outside the operationally safe band.
 */
export interface MotionRejectionConfig {
  recoverFrames: number;            // frames of STILL needed to leave SLIDING/BURST
  upgradeConfirmFrames: number;     // frames needed to escalate from STILL
  weightSmoothingAlpha: number;     // 0..1, EMA on materialised weight
  weightClampMin: number;           // hard floor on published weight
  weightClampMax: number;           // hard ceiling on published weight
  weightStill: number;
  weightMicroDrift: number;
  weightSliding: number;
  weightBurst: number;
  /**
   * V9.2 — auto-tuning.
   * When `autoTune=true`, `upgradeConfirmFrames` and `weightSmoothingAlpha`
   * are recomputed every frame from the std-dev of `trackerSigma` over the
   * last `autoTuneWindow` frames. The fields above act as the *baseline*
   * (used as default when σ(trackerSigma) is small). The tuner blends them
   * toward the `…High` ceiling as σ grows past `autoTuneSigmaTrigger`.
   *
   * Semantics:
   *   - High σ(trackerSigma) → finger drifting/twitching → longer confirm
   *     streak + slower weight EMA → suppress flicker.
   *   - Low σ(trackerSigma)  → finger stable → shorter confirm + faster
   *     EMA → responsive to a real motion event.
   */
  autoTune: boolean;
  autoTuneWindow: number;            // frames to estimate σ(trackerSigma)
  autoTuneSigmaTrigger: number;      // px std-dev that starts blending toward High
  autoTuneSigmaSaturate: number;     // px std-dev where blend reaches 1.0
  upgradeConfirmFramesHigh: number;  // ceiling under high variability
  weightSmoothingAlphaLow: number;   // EMA alpha under high variability (slower → smaller)
  /**
   * V9.3 — IMU jitter input.
   * The auto-tuner also estimates σ(imuScore) over the same window. The
   * final blend factor is `max(t_sigma, t_imu)` so whichever channel is
   * jitterier dominates the tuning — device shake without optical drift
   * (e.g. handheld at arm's length) still slows the EMA and lengthens the
   * confirmation streak.
   */
  autoTuneImuTrigger: number;        // imuScore std-dev that starts blending
  autoTuneImuSaturate: number;       // imuScore std-dev where blend reaches 1.0
  /**
   * V9.4 — input validation.
   * Hard physical bounds on `imuScore` before it enters the σ buffer.
   * Anything NaN / Infinity / outside [min,max] is rejected (the buffer
   * keeps its previous value), so a single bad sensor frame can't blow up
   * the std and force effUpgradeFrames → 8 / effAlpha → 0.10.
   */
  imuScoreMin: number;
  imuScoreMax: number;
  /**
   * V9.4 — percentile-based blending.
   * Linear σ-std blending is sensitive to outliers (a single 9 px tracker
   * jump dominates a 30-frame window). When `usePercentileBlend=true` we
   * compute the 50th and 90th percentile of the buffered σ instead, and
   * blend between them using an interpolation factor where p50 ≈ trigger
   * and p90 ≈ saturate. Outliers can't pull the blend past p90.
   */
  usePercentileBlend: boolean;
}

const DEFAULT_CONFIG: MotionRejectionConfig = {
  recoverFrames: 6,
  upgradeConfirmFrames: 3,
  weightSmoothingAlpha: 0.35,
  weightClampMin: 0.05,
  weightClampMax: 1.00,
  weightStill: 1.00,
  weightMicroDrift: 0.80,
  weightSliding: 0.40,
  weightBurst: 0.15,
  autoTune: true,
  autoTuneWindow: 30,
  autoTuneSigmaTrigger: 1.0,
  autoTuneSigmaSaturate: 4.0,
  upgradeConfirmFramesHigh: 8,
  weightSmoothingAlphaLow: 0.10,
  autoTuneImuTrigger: 0.15,
  autoTuneImuSaturate: 0.80,
  imuScoreMin: 0,
  imuScoreMax: 4,
  usePercentileBlend: true,
};

export class MotionRejection {
  private state: MotionRejectionState = 'STILL';
  private stillStreak = 0;
  private upgradeStreak = 0;
  private smoothedWeight = 1.0;
  private cfg: MotionRejectionConfig = { ...DEFAULT_CONFIG };

  // V9.2 — circular buffer of recent trackerSigma observations for auto-tune.
  private sigmaBuf = new Float64Array(64);
  private sigmaIdx = 0;
  private sigmaCount = 0;
  // V9.3 — parallel buffer of recent imuScore observations.
  private imuBuf = new Float64Array(64);
  private imuIdx = 0;
  private imuCount = 0;
  // Effective (post-tuning) values used by the current frame; exposed for
  // telemetry so the operator can see what the auto-tuner picked.
  private effUpgradeFrames = DEFAULT_CONFIG.upgradeConfirmFrames;
  private effAlpha = DEFAULT_CONFIG.weightSmoothingAlpha;
  // V9.4 — count of imuScore samples rejected by the input validator.
  // Surfaced via getTuning() so a flaky IMU shows up in CI telemetry.
  private rejectedImuCount = 0;
  // V9.5 — last per-frame blend factors (optical, IMU, max). Updated by
  // `recomputeTuning()` and exposed via getTuning() so external loggers
  // can correlate tuning switches with downstream artefacts (BPM blips,
  // SQI dips, etc.) on a frame-by-frame basis.
  private lastTOpt = 0;
  private lastTImu = 0;
  private lastTBlend = 0;

  // V9.5 — per-device IMU baseline calibration. The baseline collector
  // gathers `imuScore` samples while the user is asked to hold the phone
  // still for ~2 s. The mean + std of those samples become the device's
  // *quiet floor*, and the auto-tune trigger/saturate are shifted to sit
  // a configurable number of std-devs above that floor — this stops a
  // device with a noisier IMU (or a different driver) from constantly
  // tripping the IMU branch of the tuner.
  private calibrating = false;
  private calibBuf: number[] = [];
  private calibStartedAt = 0;
  private calibBaseline: { mean: number; std: number; n: number; updatedAt: number } | null = null;
  private calibAppliedTrigger: number | null = null;
  private calibAppliedSaturate: number | null = null;

  /** Per-device calibration tuning constants (frozen — no need to expose). */
  private static readonly CAL_DURATION_MS = 2000;
  private static readonly CAL_MIN_SAMPLES = 30;
  private static readonly CAL_MAX_SAMPLES = 600;
  /** Trigger sits at mean + this many std-devs above the quiet floor. */
  private static readonly CAL_TRIGGER_K = 2.0;
  /** Saturate sits at mean + this many std-devs above the quiet floor. */
  private static readonly CAL_SATURATE_K = 6.0;

  /** Patch any subset of the config; unspecified fields keep current values. */
  setConfig(patch: Partial<MotionRejectionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    // Resize the σ buffer if the tuning window changed.
    const w = Math.max(4, Math.min(256, this.cfg.autoTuneWindow));
    if (this.sigmaBuf.length !== w) {
      this.sigmaBuf = new Float64Array(w);
      this.sigmaIdx = 0;
      this.sigmaCount = 0;
    }
    if (this.imuBuf.length !== w) {
      this.imuBuf = new Float64Array(w);
      this.imuIdx = 0;
      this.imuCount = 0;
    }
  }

  getConfig(): MotionRejectionConfig {
    return { ...this.cfg };
  }

  /** Telemetry — what the auto-tuner is currently using. */
  getTuning(): {
    upgradeConfirmFrames: number;
    weightSmoothingAlpha: number;
    sigmaStd: number;
    imuStd: number;
    sigmaP50: number;
    sigmaP90: number;
    rejectedImu: number;
    tOpt: number;
    tImu: number;
    tBlend: number;
    tDominant: 'OPTICAL' | 'IMU' | 'TIE';
    calibrating: boolean;
    calibration: {
      hasBaseline: boolean;
      baselineMean: number;
      baselineStd: number;
      samples: number;
      appliedTrigger: number | null;
      appliedSaturate: number | null;
      updatedAt: number;
    };
  } {
    const tOpt = this.lastTOpt;
    const tImu = this.lastTImu;
    const eps = 1e-6;
    const tDominant: 'OPTICAL' | 'IMU' | 'TIE' =
      Math.abs(tOpt - tImu) < eps ? 'TIE' : (tOpt > tImu ? 'OPTICAL' : 'IMU');
    return {
      upgradeConfirmFrames: this.effUpgradeFrames,
      weightSmoothingAlpha: this.effAlpha,
      sigmaStd: this.computeStd(this.sigmaBuf, this.sigmaCount),
      imuStd:   this.computeStd(this.imuBuf,   this.imuCount),
      sigmaP50: this.percentile(this.sigmaBuf, this.sigmaCount, 0.50),
      sigmaP90: this.percentile(this.sigmaBuf, this.sigmaCount, 0.90),
      rejectedImu: this.rejectedImuCount,
      tOpt, tImu, tBlend: this.lastTBlend, tDominant,
      calibrating: this.calibrating,
      calibration: {
        hasBaseline: this.calibBaseline !== null,
        baselineMean: this.calibBaseline?.mean ?? 0,
        baselineStd:  this.calibBaseline?.std  ?? 0,
        samples:      this.calibBaseline?.n    ?? 0,
        appliedTrigger:  this.calibAppliedTrigger,
        appliedSaturate: this.calibAppliedSaturate,
        updatedAt:    this.calibBaseline?.updatedAt ?? 0,
      },
    };
  }

  // -- V9.5 per-device calibration API -----------------------------------

  /**
   * Begin collecting an IMU baseline. The caller should ask the user to
   * hold the phone still; classify() will accumulate imuScore samples
   * during the next CAL_DURATION_MS (or until CAL_MAX_SAMPLES) and then
   * derive autoTuneImuTrigger / autoTuneImuSaturate from the quiet floor.
   */
  startImuCalibration(nowMs = performance.now()): void {
    this.calibrating = true;
    this.calibBuf.length = 0;
    this.calibStartedAt = nowMs;
  }

  /** Abort an in-flight calibration without touching the applied baseline. */
  cancelImuCalibration(): void {
    this.calibrating = false;
    this.calibBuf.length = 0;
  }

  /**
   * Force-load a previously persisted baseline (e.g. from localStorage).
   * `updatedAt` is taken from the snapshot so the operator can see how
   * fresh the calibration is.
   */
  loadBaseline(snapshot: { mean: number; std: number; n: number; updatedAt: number }): void {
    if (
      !Number.isFinite(snapshot.mean) || !Number.isFinite(snapshot.std) ||
      snapshot.n <= 0 || snapshot.std < 0
    ) return;
    this.calibBaseline = { ...snapshot };
    this.applyBaselineToConfig();
  }

  /** Map the captured baseline into the `cfg.autoTuneImu*` knobs. */
  private applyBaselineToConfig(): void {
    if (!this.calibBaseline) return;
    const { mean, std } = this.calibBaseline;
    // Anchor at quiet floor + K·σ. Always clamp below the physical max so
    // we never silently disable the tuner on a very loud device.
    const trig = Math.min(
      this.cfg.imuScoreMax,
      Math.max(0, mean + MotionRejection.CAL_TRIGGER_K  * std),
    );
    const sat  = Math.min(
      this.cfg.imuScoreMax,
      Math.max(trig + 1e-3, mean + MotionRejection.CAL_SATURATE_K * std),
    );
    this.cfg = { ...this.cfg, autoTuneImuTrigger: trig, autoTuneImuSaturate: sat };
    this.calibAppliedTrigger  = trig;
    this.calibAppliedSaturate = sat;
  }

  /** Internal — called from classify() while calibration is in progress. */
  private feedCalibration(imuScore: number, nowMs: number): void {
    if (!this.calibrating) return;
    if (Number.isFinite(imuScore) &&
        imuScore >= this.cfg.imuScoreMin &&
        imuScore <= this.cfg.imuScoreMax) {
      this.calibBuf.push(imuScore);
    }
    const elapsed = nowMs - this.calibStartedAt;
    const enough = this.calibBuf.length >= MotionRejection.CAL_MIN_SAMPLES;
    const done = (elapsed >= MotionRejection.CAL_DURATION_MS && enough) ||
                 this.calibBuf.length >= MotionRejection.CAL_MAX_SAMPLES;
    if (!done) return;

    const n = this.calibBuf.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.calibBuf[i];
    const mean = sum / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = this.calibBuf[i] - mean; v += d * d; }
    const std = Math.sqrt(v / n);
    this.calibBaseline = { mean, std, n, updatedAt: nowMs };
    this.calibrating = false;
    this.calibBuf.length = 0;
    this.applyBaselineToConfig();
  }

  /** Generic std over the first `count` slots of `buf`. */
  private computeStd(buf: Float64Array, count: number): number {
    if (count < 4) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) sum += buf[i];
    const mean = sum / count;
    let v = 0;
    for (let i = 0; i < count; i++) {
      const d = buf[i] - mean;
      v += d * d;
    }
    return Math.sqrt(v / count);
  }
  // Back-compat shim — older call sites (and tests) used computeSigmaStd().
  private computeSigmaStd(): number {
    return this.computeStd(this.sigmaBuf, this.sigmaCount);
  }
  /**
   * V9.4 — percentile via in-place copy + sort. Cheap for the small
   * windows we use (≤ 256 samples) and avoids dragging in a quickselect.
   * Returns 0 when there isn't enough data to be meaningful.
   */
  private percentile(buf: Float64Array, count: number, p: number): number {
    if (count < 4) return 0;
    const tmp = new Float64Array(count);
    for (let i = 0; i < count; i++) tmp[i] = buf[i];
    tmp.sort();
    const rank = Math.max(0, Math.min(count - 1, p * (count - 1)));
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return tmp[lo];
    const frac = rank - lo;
    return tmp[lo] * (1 - frac) + tmp[hi] * frac;
  }

  private recomputeTuning(): void {
    if (!this.cfg.autoTune) {
      this.effUpgradeFrames = this.cfg.upgradeConfirmFrames;
      this.effAlpha = this.cfg.weightSmoothingAlpha;
      return;
    }
    // Two independent jitter channels — optical (trackerSigma) and IMU
    // (imuScore). Each is mapped through its own [trigger, saturate] band
    // into a [0,1] blend factor; we take the max so whichever channel is
    // most chaotic governs the tuning.
    //
    // V9.4: optical channel can use percentile-based blending (robust to
    // outliers) instead of std-based. p50 ≈ trigger maps to t=0; p90 ≈
    // saturate maps to t=1. A single 9 px outlier can't push p90 around.
    let tOpt: number;
    if (this.cfg.usePercentileBlend) {
      const p50 = this.percentile(this.sigmaBuf, this.sigmaCount, 0.50);
      const p90 = this.percentile(this.sigmaBuf, this.sigmaCount, 0.90);
      const loO = this.cfg.autoTuneSigmaTrigger;
      const hiO = Math.max(loO + 1e-3, this.cfg.autoTuneSigmaSaturate);
      // p50 below trigger → quiet; p90 above saturate → noisy. Map the
      // distance of (p90 − p50) past (hi − lo) as the blend factor.
      const span = Math.max(1e-3, hiO - loO);
      const drift = Math.max(0, p50 - loO) / span;     // bulk drift
      const tail  = Math.max(0, p90 - hiO) / span;     // outlier tail
      tOpt = Math.max(0, Math.min(1, drift + 0.5 * tail));
    } else {
      const sOpt = this.computeStd(this.sigmaBuf, this.sigmaCount);
      const loO = this.cfg.autoTuneSigmaTrigger;
      const hiO = Math.max(loO + 1e-3, this.cfg.autoTuneSigmaSaturate);
      tOpt = Math.max(0, Math.min(1, (sOpt - loO) / (hiO - loO)));
    }

    const sImu = this.computeStd(this.imuBuf, this.imuCount);
    const loI = this.cfg.autoTuneImuTrigger;
    const hiI = Math.max(loI + 1e-3, this.cfg.autoTuneImuSaturate);
    const tImu = Math.max(0, Math.min(1, (sImu - loI) / (hiI - loI)));

    const t = Math.max(tOpt, tImu);
    // V9.5 — cache the per-frame blend factors so getTuning() can surface
    // them and external loggers can correlate switches with artefacts.
    this.lastTOpt = tOpt;
    this.lastTImu = tImu;
    this.lastTBlend = t;
    // Higher variability → MORE confirm frames, SMALLER alpha (slower EMA).
    const baseFrames = this.cfg.upgradeConfirmFrames;
    const highFrames = Math.max(baseFrames, this.cfg.upgradeConfirmFramesHigh);
    this.effUpgradeFrames = Math.round(baseFrames + (highFrames - baseFrames) * t);
    const baseAlpha = this.cfg.weightSmoothingAlpha;
    const lowAlpha = Math.min(baseAlpha, this.cfg.weightSmoothingAlphaLow);
    this.effAlpha = baseAlpha + (lowAlpha - baseAlpha) * t;
  }

  classify(input: MotionRejectionInputs): MotionRejectionResult {
    const { imuScore, trackerSigma, maskIoU, centroidJumpPx } = input;

    // Push the new observations into both circular buffers and recompute the
    // effective tuning BEFORE applying hysteresis this frame.
    // V9.4 — input validation: trackerSigma must be a finite non-negative
    // number, imuScore must be finite and inside the configured physical
    // band. Bad samples are dropped (buffer index does not advance) so a
    // single garbage frame can't pollute the std / percentile estimates.
    if (Number.isFinite(trackerSigma) && trackerSigma >= 0) {
      this.sigmaBuf[this.sigmaIdx] = trackerSigma;
      this.sigmaIdx = (this.sigmaIdx + 1) % this.sigmaBuf.length;
      if (this.sigmaCount < this.sigmaBuf.length) this.sigmaCount++;
    }
    const imuOk =
      Number.isFinite(imuScore) &&
      imuScore >= this.cfg.imuScoreMin &&
      imuScore <= this.cfg.imuScoreMax;
    if (imuOk) {
      this.imuBuf[this.imuIdx] = imuScore;
      this.imuIdx = (this.imuIdx + 1) % this.imuBuf.length;
      if (this.imuCount < this.imuBuf.length) this.imuCount++;
    } else {
      this.rejectedImuCount++;
    }
    this.recomputeTuning();

    // Detección instantánea (antes de aplicar hysteresis).
    let candidate: MotionRejectionState;
    if (centroidJumpPx > 12 && imuScore > 1.6) {
      candidate = 'BURST_MOTION';
    } else if (maskIoU < 0.55 || trackerSigma > 6) {
      candidate = 'SLIDING';
    } else if (
      (trackerSigma >= 2.5 && trackerSigma <= 6) ||
      (imuScore >= 0.6 && imuScore <= 0.95)
    ) {
      candidate = 'MICRO_DRIFT';
    } else {
      candidate = 'STILL';
    }

    const order: Record<MotionRejectionState, number> = {
      STILL: 0, MICRO_DRIFT: 1, SLIDING: 2, BURST_MOTION: 3,
    };

    // Hysteresis hacia abajo (recovery): si estamos en SLIDING/BURST,
    // exigimos RECOVER_FRAMES candidaturas STILL consecutivas para salir.
    if (this.state === 'BURST_MOTION' || this.state === 'SLIDING') {
      if (candidate === 'STILL') {
        this.stillStreak++;
        if (this.stillStreak < this.cfg.recoverFrames) {
          // No salimos todavía — mantenemos el estado severo.
          return this.materialize(this.state);
        }
        // Streak suficiente → permitir transición a STILL.
        this.state = 'STILL';
        this.stillStreak = 0;
        this.upgradeStreak = 0;
        return this.materialize(this.state);
      }
      // Cualquier otra cosa rompe el streak.
      this.stillStreak = 0;
      // Permitimos escalar a un estado igual o más severo.
      if (order[candidate] >= order[this.state]) this.state = candidate;
      return this.materialize(this.state);
    }

    // Estado base no severo — aplicamos hysteresis de subida para evitar
    // que UN solo frame ruidoso eleve el estado y produzca chatter en el
    // peso. Sólo escalamos tras `upgradeConfirmFrames` frames consecutivos
    // con candidato peor o igual al objetivo.
    if (order[candidate] > order[this.state]) {
      this.upgradeStreak++;
      if (this.upgradeStreak >= this.effUpgradeFrames) {
        this.state = candidate;
        this.upgradeStreak = 0;
      }
    } else {
      this.upgradeStreak = 0;
      this.state = candidate;
    }
    this.stillStreak = this.state === 'STILL' ? this.stillStreak + 1 : 0;
    return this.materialize(this.state);
  }

  private materialize(state: MotionRejectionState): MotionRejectionResult {
    let target: number;
    let freeze: boolean;
    switch (state) {
      case 'BURST_MOTION': target = this.cfg.weightBurst;      freeze = true;  break;
      case 'SLIDING':      target = this.cfg.weightSliding;    freeze = true;  break;
      case 'MICRO_DRIFT':  target = this.cfg.weightMicroDrift; freeze = false; break;
      default:             target = this.cfg.weightStill;      freeze = false; break;
    }
    // EMA low-pass on the materialised weight → eliminates step changes on
    // every state transition. Then hard clamp to the configurable band.
    const a = Math.max(0, Math.min(1, this.effAlpha));
    this.smoothedWeight = this.smoothedWeight * (1 - a) + target * a;
    const w = Math.min(
      this.cfg.weightClampMax,
      Math.max(this.cfg.weightClampMin, this.smoothedWeight),
    );
    return { state, weight: w, freezeBaselines: freeze };
  }

  getState(): MotionRejectionState { return this.state; }

  reset(): void {
    this.state = 'STILL';
    this.stillStreak = 0;
    this.upgradeStreak = 0;
    this.smoothedWeight = this.cfg.weightStill;
    this.sigmaIdx = 0;
    this.sigmaCount = 0;
    this.imuIdx = 0;
    this.imuCount = 0;
    this.rejectedImuCount = 0;
    this.effUpgradeFrames = this.cfg.upgradeConfirmFrames;
    this.effAlpha = this.cfg.weightSmoothingAlpha;
  }
}