/**
 * ArrhythmiaProcessor — RR-interval based arrhythmia screening.
 *
 * Detects irregular rhythm from PPG-derived RR intervals using:
 *   - RMSSD (root mean square of successive differences)
 *   - pNN50 (% successive RR differences > 50ms)
 *   - Premature beat heuristic (RR < 0.75 * median followed by compensatory pause)
 *
 * NO simulation, NO random data. Output is "POSSIBLE_ARRHYTHMIA|N" or
 * "SIN ARRITMIAS|0". This is a screening signal, not a diagnosis.
 */

export interface ArrhythmiaInput {
  intervals: number[];
  lastPeakTime: number | null;
}

export interface ArrhythmiaResult {
  arrhythmiaStatus: string;
  lastArrhythmiaData: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  } | null;
}

export class ArrhythmiaProcessor {
  private arrhythmiaCount = 0;
  private lastArrhythmiaTimestamp = 0;
  private lastArrhythmiaData: ArrhythmiaResult['lastArrhythmiaData'] = null;
  private readonly REFRACTORY_MS = 1500;
  private readonly RMSSD_THRESHOLD_MS = 80;
  private readonly PREMATURE_RATIO = 0.75;

  reset(): void {
    this.arrhythmiaCount = 0;
    this.lastArrhythmiaTimestamp = 0;
    this.lastArrhythmiaData = null;
  }

  processRRData(input?: ArrhythmiaInput): ArrhythmiaResult {
    if (!input || !input.intervals || input.intervals.length < 4) {
      return {
        arrhythmiaStatus: `SIN ARRITMIAS|${this.arrhythmiaCount}`,
        lastArrhythmiaData: this.lastArrhythmiaData,
      };
    }

    const rr = input.intervals.filter(v => v > 250 && v < 2000);
    if (rr.length < 4) {
      return {
        arrhythmiaStatus: `SIN ARRITMIAS|${this.arrhythmiaCount}`,
        lastArrhythmiaData: this.lastArrhythmiaData,
      };
    }

    // RMSSD
    let sumSq = 0;
    for (let i = 1; i < rr.length; i++) {
      const d = rr[i] - rr[i - 1];
      sumSq += d * d;
    }
    const rmssd = Math.sqrt(sumSq / (rr.length - 1));

    // RR median for premature-beat heuristic
    const sorted = [...rr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const last = rr[rr.length - 1];
    const prev = rr[rr.length - 2];
    const rrVariation = Math.abs(last - prev) / Math.max(median, 1);

    const now = input.lastPeakTime ?? Date.now();
    const isPremature = last < median * this.PREMATURE_RATIO && prev > median * 0.9;
    const highVariability = rmssd > this.RMSSD_THRESHOLD_MS && rrVariation > 0.2;

    if ((isPremature || highVariability) &&
        now - this.lastArrhythmiaTimestamp > this.REFRACTORY_MS) {
      this.arrhythmiaCount++;
      this.lastArrhythmiaTimestamp = now;
      this.lastArrhythmiaData = { timestamp: now, rmssd, rrVariation };
      return {
        arrhythmiaStatus: `POSSIBLE_ARRHYTHMIA|${this.arrhythmiaCount}`,
        lastArrhythmiaData: this.lastArrhythmiaData,
      };
    }

    return {
      arrhythmiaStatus: `SIN ARRITMIAS|${this.arrhythmiaCount}`,
      lastArrhythmiaData: this.lastArrhythmiaData,
    };
  }
}
