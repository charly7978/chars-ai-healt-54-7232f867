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

export class MotionRejection {
  private state: MotionRejectionState = 'STILL';
  private stillStreak = 0;
  private readonly RECOVER_FRAMES = 6;

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

    // Hysteresis hacia abajo (recovery): si estamos en SLIDING/BURST,
    // exigimos RECOVER_FRAMES candidaturas STILL consecutivas para salir.
    if (this.state === 'BURST_MOTION' || this.state === 'SLIDING') {
      if (candidate === 'STILL') {
        this.stillStreak++;
        if (this.stillStreak < this.RECOVER_FRAMES) {
          // No salimos todavía — mantenemos el estado severo.
          return this.materialize(this.state);
        }
        // Streak suficiente → permitir transición a STILL.
        this.state = 'STILL';
        this.stillStreak = 0;
        return this.materialize(this.state);
      }
      // Cualquier otra cosa rompe el streak.
      this.stillStreak = 0;
      // Permitimos escalar a un estado igual o más severo.
      const order: Record<MotionRejectionState, number> = {
        STILL: 0, MICRO_DRIFT: 1, SLIDING: 2, BURST_MOTION: 3,
      };
      if (order[candidate] >= order[this.state]) this.state = candidate;
      return this.materialize(this.state);
    }

    // Estado base no severo — transición libre.
    this.state = candidate;
    this.stillStreak = candidate === 'STILL' ? this.stillStreak + 1 : 0;
    return this.materialize(this.state);
  }

  private materialize(state: MotionRejectionState): MotionRejectionResult {
    switch (state) {
      case 'BURST_MOTION':
        return { state, weight: 0.15, freezeBaselines: true };
      case 'SLIDING':
        return { state, weight: 0.40, freezeBaselines: true };
      case 'MICRO_DRIFT':
        return { state, weight: 0.80, freezeBaselines: false };
      default:
        return { state: 'STILL', weight: 1.00, freezeBaselines: false };
    }
  }

  getState(): MotionRejectionState { return this.state; }

  reset(): void {
    this.state = 'STILL';
    this.stillStreak = 0;
  }
}