/**
 * ROI TELEMETRY LOGGER
 *
 * Structured per-frame logger for the adaptive ROI + Liveness gate.
 * Records a compact ring buffer of frame-level telemetry so the operator
 * can EXPORT it (NDJSON) when the app says it isn't detecting pulses,
 * and a forensic engineer can re-trace exactly why each frame was
 * accepted or rejected by Gate-1 (optical liveness).
 *
 * Zero allocations on the hot path: writes go into pre-allocated typed
 * arrays. Reasons (strings) are interned in a small dictionary so the
 * per-frame slot only stores a uint16 index.
 */

const DEFAULT_CAPACITY = 36000; // ~10 min @ 60fps, ~20 min @ 30fps

export interface ROITelemetryRecord {
  t: number;            // ms (high-res timestamp)
  frame: number;        // monotonic frame counter
  cx: number;           // ROI center x (frame px)
  cy: number;           // ROI center y (frame px)
  sizePx: number;       // ROI side length (frame px)
  sizeFrac: number;     // ROI side as fraction of min(w,h)
  coverage: number;     // fraction of finger-tiles inside the ROI
  livenessPass: boolean;
  livenessReason: string;
  prepassRedDomMin: number;
  prepassRedMin: number;
  prepassSuccessRate: number;
  prepassMass: number;  // pre-pass weighted mass (0 = no finger evidence)
}

export class ROITelemetryLogger {
  private capacity: number;
  private size = 0;
  private head = 0;            // next write index
  private wrapped = false;

  // Numeric columns (Float32Array — small, fast, GC-free).
  private t: Float64Array;
  private frame: Float64Array;
  private cx: Float32Array;
  private cy: Float32Array;
  private sizePx: Float32Array;
  private sizeFrac: Float32Array;
  private coverage: Float32Array;
  private livenessPass: Uint8Array;
  private prepassRedDomMin: Float32Array;
  private prepassRedMin: Float32Array;
  private prepassSuccessRate: Float32Array;
  private prepassMass: Float32Array;

  // Reason interning.
  private reasonIdx: Uint16Array;
  private reasonDict: string[] = [];
  private reasonMap = new Map<string, number>();

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.frame = new Float64Array(capacity);
    this.cx = new Float32Array(capacity);
    this.cy = new Float32Array(capacity);
    this.sizePx = new Float32Array(capacity);
    this.sizeFrac = new Float32Array(capacity);
    this.coverage = new Float32Array(capacity);
    this.livenessPass = new Uint8Array(capacity);
    this.prepassRedDomMin = new Float32Array(capacity);
    this.prepassRedMin = new Float32Array(capacity);
    this.prepassSuccessRate = new Float32Array(capacity);
    this.prepassMass = new Float32Array(capacity);
    this.reasonIdx = new Uint16Array(capacity);
  }

  private internReason(reason: string): number {
    const cached = this.reasonMap.get(reason);
    if (cached !== undefined) return cached;
    // Cap dictionary at 65535 (uint16) — extremely unlikely in practice.
    if (this.reasonDict.length >= 0xffff) return 0;
    const idx = this.reasonDict.length;
    this.reasonDict.push(reason);
    this.reasonMap.set(reason, idx);
    return idx;
  }

  record(rec: ROITelemetryRecord): void {
    const i = this.head;
    this.t[i] = rec.t;
    this.frame[i] = rec.frame;
    this.cx[i] = rec.cx;
    this.cy[i] = rec.cy;
    this.sizePx[i] = rec.sizePx;
    this.sizeFrac[i] = rec.sizeFrac;
    this.coverage[i] = rec.coverage;
    this.livenessPass[i] = rec.livenessPass ? 1 : 0;
    this.prepassRedDomMin[i] = rec.prepassRedDomMin;
    this.prepassRedMin[i] = rec.prepassRedMin;
    this.prepassSuccessRate[i] = rec.prepassSuccessRate;
    this.prepassMass[i] = rec.prepassMass;
    this.reasonIdx[i] = this.internReason(rec.livenessReason || '');
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    if (!this.wrapped) this.size = this.head;
    else this.size = this.capacity;
  }

  count(): number { return this.size; }

  /** Iterate records in chronological order. */
  *iter(): Generator<ROITelemetryRecord> {
    if (this.size === 0) return;
    const start = this.wrapped ? this.head : 0;
    for (let n = 0; n < this.size; n++) {
      const i = (start + n) % this.capacity;
      yield {
        t: this.t[i],
        frame: this.frame[i],
        cx: this.cx[i],
        cy: this.cy[i],
        sizePx: this.sizePx[i],
        sizeFrac: this.sizeFrac[i],
        coverage: this.coverage[i],
        livenessPass: this.livenessPass[i] === 1,
        livenessReason: this.reasonDict[this.reasonIdx[i]] || '',
        prepassRedDomMin: this.prepassRedDomMin[i],
        prepassRedMin: this.prepassRedMin[i],
        prepassSuccessRate: this.prepassSuccessRate[i],
        prepassMass: this.prepassMass[i],
      };
    }
  }

  /** Recent N records (for live debug overlays). */
  recent(n: number): ROITelemetryRecord[] {
    if (this.size === 0) return [];
    const take = Math.min(n, this.size);
    const out: ROITelemetryRecord[] = [];
    const start = (this.head - take + this.capacity) % this.capacity;
    for (let k = 0; k < take; k++) {
      const i = (start + k) % this.capacity;
      out.push({
        t: this.t[i],
        frame: this.frame[i],
        cx: this.cx[i],
        cy: this.cy[i],
        sizePx: this.sizePx[i],
        sizeFrac: this.sizeFrac[i],
        coverage: this.coverage[i],
        livenessPass: this.livenessPass[i] === 1,
        livenessReason: this.reasonDict[this.reasonIdx[i]] || '',
        prepassRedDomMin: this.prepassRedDomMin[i],
        prepassRedMin: this.prepassRedMin[i],
        prepassSuccessRate: this.prepassSuccessRate[i],
        prepassMass: this.prepassMass[i],
      });
    }
    return out;
  }

  /** Newline-delimited JSON — one record per line. */
  exportNDJSON(): string {
    const lines: string[] = [];
    for (const r of this.iter()) {
      lines.push(JSON.stringify({
        t: +r.t.toFixed(2),
        frame: r.frame,
        cx: +r.cx.toFixed(2),
        cy: +r.cy.toFixed(2),
        sizePx: +r.sizePx.toFixed(1),
        sizeFrac: +r.sizeFrac.toFixed(4),
        coverage: +r.coverage.toFixed(4),
        livenessPass: r.livenessPass,
        livenessReason: r.livenessReason,
        prepassRedDomMin: r.prepassRedDomMin,
        prepassRedMin: r.prepassRedMin,
        prepassSuccessRate: +r.prepassSuccessRate.toFixed(4),
        prepassMass: +r.prepassMass.toFixed(2),
      }));
    }
    return lines.join('\n');
  }

  /** Aggregate summary for quick UX feedback. */
  summary(): {
    samples: number;
    pass: number;
    fail: number;
    passRate: number;
    topReasons: { reason: string; count: number }[];
  } {
    let pass = 0;
    const counts = new Map<string, number>();
    for (const r of this.iter()) {
      if (r.livenessPass) pass++;
      else {
        const k = r.livenessReason || '(sin razón)';
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    const topReasons = Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return {
      samples: this.size,
      pass,
      fail: this.size - pass,
      passRate: this.size > 0 ? pass / this.size : 0,
      topReasons,
    };
  }

  /** Trigger a browser download of the current buffer as NDJSON. */
  download(filename = `roi-telemetry-${Date.now()}.ndjson`): void {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    const ndjson = this.exportNDJSON();
    const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  clear(): void {
    this.size = 0;
    this.head = 0;
    this.wrapped = false;
    this.reasonDict.length = 0;
    this.reasonMap.clear();
  }
}