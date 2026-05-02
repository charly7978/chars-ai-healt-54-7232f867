/**
 * ArrhythmiaProcessor — thin adapter over the unified ArrhythmiaDetector
 *
 * History: this file used to contain a *second* HRV/arrhythmia algorithm
 * (RMSSD + Shannon entropy + bespoke pNNx). Maintaining two competing
 * detectors caused contradictions in the UI ("ARRITMIA DETECTADA" from
 * one path, "SIN ARRITMIAS" from the other) and made forensic export
 * inconsistent.
 *
 * The single source of truth is now `modules/arrhythmia/ArrhythmiaDetector`
 * (peer-reviewed thresholds from Circulation 2024, JACC 2023, IEEE TBME
 * 2024). This adapter preserves the legacy
 *   { arrhythmiaStatus: 'ARRITMIA DETECTADA|N' | 'SIN ARRITMIAS|N' | 'CALIBRANDO...|N',
 *     lastArrhythmiaData: { timestamp, rmssd, rrVariation } | null }
 * shape so VitalSignsProcessor and the UI keep working unchanged.
 */
import { ArrhythmiaDetector, type ArrhythmiaEvidence } from '../arrhythmia/ArrhythmiaDetector';

const LEARNING_PERIOD_MS = 9_000;
const MIN_INTERVAL_BETWEEN_EVENTS_MS = 3_500;

export class ArrhythmiaProcessor {
  private detector = new ArrhythmiaDetector();
  private isLearningPhase = true;
  private startedAt = Date.now();
  private arrhythmiaCount = 0;
  private lastArrhythmiaTime = 0;
  private lastEvidence: ArrhythmiaEvidence | null = null;
  private onArrhythmiaDetection?: (isDetected: boolean) => void;
  private wasDetected = false;

  setArrhythmiaDetectionCallback(cb: (isDetected: boolean) => void): void {
    this.onArrhythmiaDetection = cb;
  }

  processRRData(rrData?: { intervals: number[]; lastPeakTime: number | null }): {
    arrhythmiaStatus: string;
    lastArrhythmiaData: { timestamp: number; rmssd: number; rrVariation: number } | null;
  } {
    const now = Date.now();
    if (now - this.startedAt > LEARNING_PERIOD_MS) this.isLearningPhase = false;

    if (this.isLearningPhase) {
      return { arrhythmiaStatus: `CALIBRANDO...|${this.arrhythmiaCount}`, lastArrhythmiaData: null };
    }

    let evidence: ArrhythmiaEvidence | null = null;
    if (rrData?.intervals && rrData.intervals.length > 0) {
      // Feed every fresh interval to the detector. The detector
      // throttles its internal analyses; we just supply samples.
      for (const rr of rrData.intervals.slice(-3)) {
        const ev = this.detector.processBeat(rr, now);
        if (ev) evidence = ev;
      }
    }

    if (evidence) this.lastEvidence = evidence;
    const isDetected = !!evidence?.detected;

    if (isDetected !== this.wasDetected) {
      this.wasDetected = isDetected;
      this.onArrhythmiaDetection?.(isDetected);
    }

    if (isDetected && now - this.lastArrhythmiaTime >= MIN_INTERVAL_BETWEEN_EVENTS_MS) {
      this.arrhythmiaCount++;
      this.lastArrhythmiaTime = now;
    }

    const status = isDetected
      ? `ARRITMIA DETECTADA|${this.arrhythmiaCount}`
      : `SIN ARRITMIAS|${this.arrhythmiaCount}`;

    const lastData = isDetected && evidence
      ? {
          timestamp: evidence.timestamp,
          rmssd: evidence.evidence.rmssd,
          rrVariation: evidence.evidence.cv,
        }
      : null;

    return { arrhythmiaStatus: status, lastArrhythmiaData: lastData };
  }

  reset(): void {
    this.detector.reset();
    this.isLearningPhase = true;
    this.startedAt = Date.now();
    this.arrhythmiaCount = 0;
    this.lastArrhythmiaTime = 0;
    this.lastEvidence = null;
    this.wasDetected = false;
    this.onArrhythmiaDetection?.(false);
  }
}
