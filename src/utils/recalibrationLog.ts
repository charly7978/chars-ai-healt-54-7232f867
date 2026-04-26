import type { MotionLevel } from '@/modules/signal-processing/MotionClassifier';

/**
 * recalibrationLog
 * ----------------
 * Process-wide singleton ring buffer that records every recalibration
 * prompt fired by the watchdog (and any other source that wants to
 * announce a confidence-loss event).
 *
 * Designed for forensic auditability:
 *   - immutable timestamp (ISO + monotonic perf clock)
 *   - reason code + human label
 *   - metrics snapshot AT the moment the prompt fired
 *   - bounded buffer (LOG_CAP) with FIFO eviction, so it never leaks memory
 *   - subscribe/snapshot/download API for the operator UI
 */

export type RecalibrationReason = 'quality' | 'motion' | 'bpm_drift' | 'spo2_drift';

export const recalibrationReasonLabel: Record<RecalibrationReason, string> = {
  quality:    'Calidad de señal degradada',
  motion:     'Movimiento sostenido detectado',
  bpm_drift:  'Frecuencia cardíaca alejada de la línea base',
  spo2_drift: 'SpO₂ alejada de la línea base',
};

export interface RecalibrationLogEntry {
  id: string;
  isoTimestamp: string;
  perfTimestamp: number;
  reason: RecalibrationReason;
  reasonLabel: string;
  metrics: {
    quality: number;
    bpm: number;
    spo2: number;
    motionLevel: MotionLevel;
    baselineBpmMean: number | null;
    baselineSpo2Mean: number | null;
    baselineQualityMean: number | null;
  };
}

const LOG_CAP = 50;

let buffer: RecalibrationLogEntry[] = [];
const subscribers = new Set<(entries: ReadonlyArray<RecalibrationLogEntry>) => void>();

const notify = () => {
  // Hand out a frozen shallow copy so subscribers can't mutate the buffer.
  const snap = Object.freeze(buffer.slice());
  for (const fn of subscribers) {
    try { fn(snap); } catch {}
  }
};

export const recalibrationLog = {
  add(entry: Omit<RecalibrationLogEntry, 'id' | 'isoTimestamp' | 'perfTimestamp' | 'reasonLabel'>): RecalibrationLogEntry {
    const now = performance.now();
    const full: RecalibrationLogEntry = {
      ...entry,
      id: `cal_${Date.now().toString(36)}_${(now | 0).toString(36)}`,
      isoTimestamp: new Date().toISOString(),
      perfTimestamp: now,
      reasonLabel: recalibrationReasonLabel[entry.reason],
    };
    buffer.push(full);
    if (buffer.length > LOG_CAP) buffer = buffer.slice(buffer.length - LOG_CAP);
    notify();
    return full;
  },

  snapshot(): ReadonlyArray<RecalibrationLogEntry> {
    return Object.freeze(buffer.slice());
  },

  size(): number {
    return buffer.length;
  },

  clear(): void {
    buffer = [];
    notify();
  },

  subscribe(fn: (entries: ReadonlyArray<RecalibrationLogEntry>) => void): () => void {
    subscribers.add(fn);
    // Immediately push current snapshot so the subscriber doesn't have to
    // separately call snapshot() on mount.
    fn(this.snapshot());
    return () => { subscribers.delete(fn); };
  },

  /**
   * Triggers a browser download of the full log as NDJSON (one entry per
   * line). Returns the filename used so the caller can surface it in a toast.
   */
  download(): string {
    if (typeof window === 'undefined') return '';
    const ndjson = buffer.map(e => JSON.stringify(e)).join('\n');
    const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `recalibration-log-${ts}.ndjson`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return filename;
  },
};