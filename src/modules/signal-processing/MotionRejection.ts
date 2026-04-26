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
};

export class MotionRejection {
  private state: MotionRejectionState = 'STILL';
  private stillStreak = 0;
  private upgradeStreak = 0;
  private smoothedWeight = 1.0;
  private cfg: MotionRejectionConfig = { ...DEFAULT_CONFIG };

  /** Patch any subset of the config; unspecified fields keep current values. */
  setConfig(patch: Partial<MotionRejectionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  getConfig(): MotionRejectionConfig {
    return { ...this.cfg };
  }

  classify(input: MotionRejectionInputs): MotionRejectionResult {
    const { imuScore, trackerSigma, maskIoU, centroidJumpPx } = input;

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
      if (this.upgradeStreak >= this.cfg.upgradeConfirmFrames) {
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
    const a = Math.max(0, Math.min(1, this.cfg.weightSmoothingAlpha));
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
  }
}