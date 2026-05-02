/**
 * FORENSIC SESSION RECORDER
 * --------------------------------------------------------------------------
 * Pure-TS, zero-dependency recorder of an end-to-end PPG measurement session
 * for forensic / audit-grade traceability.
 *
 * Hard rules (mirrored from the project's "Medical Philosophy" core memory):
 *   - NEVER fabricates data. If a sample/beat/event is not pushed, it does
 *     not exist in the export.
 *   - NEVER masks invalid samples. `valid=false` samples are kept verbatim
 *     so an auditor can see WHEN the signal degraded.
 *   - All numeric fields are stored at full floating-point precision.
 *     Rounding is exclusively a presentation concern.
 *   - The exported bundle is sealed with a SHA-256 hash of its canonical
 *     JSON, computed via the WebCrypto SubtleCrypto API. The hash itself is
 *     embedded ONLY in the wrapper, never inside the payload it covers.
 *
 * Storage strategy:
 *   - Pre-allocated ring buffers for the high-frequency stream (samples)
 *     to keep the hot path allocation-free.
 *   - Append-only arrays for low-frequency streams (beats, events,
 *     state changes) which are bounded by physiology, not framerate.
 *   - Counters are kept separately so an export reflects "what happened"
 *     even after the ring buffer overwrites old samples.
 */

/* ───────────────────────── Data classes (TS port of the Kotlin spec) ──── */

export interface DeviceFingerprint {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  devicePixelRatio: number;
  screen: { width: number; height: number };
  language: string;
  timezone: string;
}

export interface CameraSnapshot {
  deviceLabel: string;
  cameraId: string | null;          // not always exposed in MediaStream API
  hasTorch: boolean;
  torchActive: boolean;
  resolution: { width: number; height: number };
  realFrameRate: number;
  exposureLocked: boolean;
  wbLocked: boolean;
  focusLocked: boolean;
  isoValue: number;
  supportedConstraints: string[];
}

export interface CameraFrameRecord {
  timestampMs: number;       // performance.now() at capture
  width: number;
  height: number;
  cameraId: string | null;
  exposureTimeNs: number | null;
  iso: number | null;
  frameDurationNs: number | null;
  redMean: number;
  greenMean: number;
  blueMean: number;
  redAcDc: number;
  greenAcDc: number;
  blueAcDc: number;
  clipHighRatio: number;
  clipLowRatio: number;
  roiCoverage: number;
}

export interface PpgSampleRecord {
  timestampMs: number;
  raw: number;
  filtered: number;
  displayValue: number;
  sqi: number;
  perfusionIndex: number;
  motionScore: number;
  valid: boolean;
}

export type BeatType =
  | 'NORMAL'
  | 'SUSPECT_PREMATURE'
  | 'SUSPECT_PAUSE'
  | 'SUSPECT_MISSED'
  | 'IRREGULAR'
  | 'INVALID_SIGNAL';

export interface BeatRecord {
  timestampMs: number;
  amplitude: number;
  rrMs: number | null;
  bpmInstant: number | null;
  quality: number;
  type: BeatType;
  reason: string;
}

export type SessionEventKind =
  | 'CONTACT_LOST'
  | 'CONTACT_REGAINED'
  | 'MOTION_HIGH'
  | 'CLIPPING_HIGH'
  | 'CLIPPING_LOW'
  | 'STATE_CHANGE'
  | 'TORCH_REARM'
  | 'ROI_ALERT_TRIGGER'
  | 'ROI_ALERT_CLEAR'
  | 'CALIBRATION_USED'
  | 'NOTE';

export interface SessionEvent {
  timestampMs: number;
  kind: SessionEventKind;
  detail: Record<string, number | string | boolean | null>;
}

export type MeasurementState =
  | 'NO_CONTACT'
  | 'CONTACT_PARTIAL'
  | 'WARMUP'
  | 'MEASURING'
  | 'DEGRADED'
  | 'INVALID'
  | 'CALIBRATION_REQUIRED';

export interface CalibrationProfileMeta {
  profileId: string;
  algorithmVersion: string;
  createdAt: string;
  notes?: string;
}

/* ───────────────────────── Ring buffer (pre-allocated, no GC) ─────────── */

class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private size = 0;
  constructor(public readonly capacity: number) {
    this.buf = new Array(capacity);
  }
  push(v: T): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }
  toArray(): T[] {
    const out: T[] = new Array(this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buf[(start + i) % this.capacity] as T;
    }
    return out;
  }
  clear(): void {
    this.head = 0;
    this.size = 0;
    // intentionally NOT reallocating buf — keeps memory hot.
  }
  count(): number { return this.size; }
  droppedCount(totalPushed: number): number {
    return Math.max(0, totalPushed - this.capacity);
  }
}

/* ───────────────────────── Recorder ───────────────────────────────────── */

export interface RecorderConfig {
  algorithmVersion: string;
  sampleRingCapacity?: number;   // default 60 fps × 120 s = 7200
  frameRingCapacity?: number;    // default 60 fps × 120 s = 7200
  beatLimit?: number;            // hard cap on stored beats
  eventLimit?: number;
}

export interface SessionTickMetrics {
  fpsInstant: number;
  jitterMs: number;
  framesProcessed: number;
  framesDropped: number;
}

export class ForensicSessionRecorder {
  readonly sessionId: string;
  readonly algorithmVersion: string;
  readonly startedAtMs: number;       // performance.now()
  readonly startedAtIso: string;      // wall-clock ISO
  private endedAtMs: number | null = null;
  private endedAtIso: string | null = null;

  private device: DeviceFingerprint;
  private camera: CameraSnapshot | null = null;
  private calibration: CalibrationProfileMeta | null = null;

  // High-frequency ring buffers
  private samples: RingBuffer<PpgSampleRecord>;
  private frames: RingBuffer<CameraFrameRecord>;
  // Append-only (bounded) for human-rate streams
  private beats: BeatRecord[] = [];
  private events: SessionEvent[] = [];
  private states: { tMs: number; state: MeasurementState }[] = [];

  // Counters that survive ring overwrite
  private totalSamples = 0;
  private validSamples = 0;
  private rejectedSamples = 0;
  private totalFrames = 0;

  // Rolling stats
  private fpsSum = 0;
  private fpsTicks = 0;
  private jitterSum = 0;

  private readonly cfg: Required<RecorderConfig>;

  constructor(cfg: RecorderConfig) {
    this.cfg = {
      sampleRingCapacity: 7200,
      frameRingCapacity: 7200,
      beatLimit: 4000,        // ~33 min at 120bpm
      eventLimit: 2000,
      ...cfg,
    };
    this.algorithmVersion = cfg.algorithmVersion;
    this.sessionId = ForensicSessionRecorder.makeSessionId();
    this.startedAtMs = performance.now();
    this.startedAtIso = new Date().toISOString();
    this.samples = new RingBuffer<PpgSampleRecord>(this.cfg.sampleRingCapacity);
    this.frames = new RingBuffer<CameraFrameRecord>(this.cfg.frameRingCapacity);
    this.device = ForensicSessionRecorder.captureDeviceFingerprint();
  }

  /* ─────────────── public ingestion API (hot-path safe) ─────────────── */

  attachCameraSnapshot(snap: CameraSnapshot): void { this.camera = snap; }
  attachCalibration(p: CalibrationProfileMeta | null): void { this.calibration = p; }

  pushFrame(f: CameraFrameRecord): void {
    this.totalFrames += 1;
    this.frames.push(f);
  }

  pushSample(s: PpgSampleRecord): void {
    this.totalSamples += 1;
    if (s.valid) this.validSamples += 1; else this.rejectedSamples += 1;
    this.samples.push(s);
  }

  pushBeat(b: BeatRecord): void {
    if (this.beats.length >= this.cfg.beatLimit) return;
    this.beats.push(b);
  }

  pushEvent(kind: SessionEventKind, detail: SessionEvent['detail'] = {}): void {
    if (this.events.length >= this.cfg.eventLimit) return;
    this.events.push({ timestampMs: performance.now() - this.startedAtMs, kind, detail });
  }

  pushStateChange(state: MeasurementState): void {
    const last = this.states[this.states.length - 1];
    const tMs = performance.now() - this.startedAtMs;
    if (last && last.state === state) return;
    this.states.push({ tMs, state });
    this.pushEvent('STATE_CHANGE', { state });
  }

  pushTick(m: SessionTickMetrics): void {
    if (Number.isFinite(m.fpsInstant)) {
      this.fpsSum += m.fpsInstant;
      this.fpsTicks += 1;
    }
    if (Number.isFinite(m.jitterMs)) this.jitterSum += m.jitterMs;
  }

  finalize(): void {
    if (this.endedAtMs != null) return;
    this.endedAtMs = performance.now();
    this.endedAtIso = new Date().toISOString();
  }

  /* ─────────────── snapshot for live UI (no allocation per call) ─────── */

  liveStats(): {
    sessionId: string;
    durationS: number;
    samples: number;
    valid: number;
    rejected: number;
    droppedSamples: number;
    frames: number;
    droppedFrames: number;
    beats: number;
    events: number;
    fpsAvg: number;
    jitterAvg: number;
  } {
    const now = this.endedAtMs ?? performance.now();
    return {
      sessionId: this.sessionId,
      durationS: (now - this.startedAtMs) / 1000,
      samples: this.totalSamples,
      valid: this.validSamples,
      rejected: this.rejectedSamples,
      droppedSamples: this.samples.droppedCount(this.totalSamples),
      frames: this.totalFrames,
      droppedFrames: this.frames.droppedCount(this.totalFrames),
      beats: this.beats.length,
      events: this.events.length,
      fpsAvg: this.fpsTicks > 0 ? this.fpsSum / this.fpsTicks : 0,
      jitterAvg: this.fpsTicks > 0 ? this.jitterSum / this.fpsTicks : 0,
    };
  }

  /* ─────────────── export bundle ─────────────────────────────────────── */

  async buildBundle(): Promise<{ json: string; csv: ExportCsvSet; sha256: string; }> {
    if (this.endedAtMs == null) this.finalize();

    const stats = this.liveStats();
    const samplesArr = this.samples.toArray();
    const framesArr = this.frames.toArray();

    const payload = {
      schema: 'forensic-ppg-session/v1',
      sessionId: this.sessionId,
      algorithmVersion: this.algorithmVersion,
      startedAt: { ms: this.startedAtMs, iso: this.startedAtIso },
      endedAt:   { ms: this.endedAtMs,   iso: this.endedAtIso },
      durationS: stats.durationS,
      device: this.device,
      camera: this.camera,
      calibration: this.calibration,
      counters: {
        totalFrames: this.totalFrames,
        droppedFramesFromRing: stats.droppedFrames,
        totalSamples: this.totalSamples,
        validSamples: this.validSamples,
        rejectedSamples: this.rejectedSamples,
        droppedSamplesFromRing: stats.droppedSamples,
        beats: this.beats.length,
        events: this.events.length,
      },
      timing: {
        fpsAvg: stats.fpsAvg,
        jitterAvgMs: stats.jitterAvg,
      },
      states: this.states,
      events: this.events,
      beats: this.beats,
      samples: samplesArr,        // last N inside ring
      frames: framesArr,          // last N inside ring
    };

    const json = canonicalStringify(payload);
    const sha256 = await sha256Hex(json);

    const csv: ExportCsvSet = {
      samplesCsv: samplesToCsv(samplesArr),
      beatsCsv: beatsToCsv(this.beats),
      eventsCsv: eventsToCsv(this.events),
      reportTxt: humanReport(payload, sha256),
    };

    return { json, csv, sha256 };
  }

  /* ─────────────── helpers ──────────────────────────────────────────── */

  private static makeSessionId(): string {
    // Real cryptographic UUID. Never Math.random.
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as Crypto).randomUUID();
    }
    // Fallback using getRandomValues — still cryptographically strong.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  private static captureDeviceFingerprint(): DeviceFingerprint {
    const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number };
    return {
      userAgent: nav.userAgent ?? '',
      platform: (nav as any).platform ?? '',
      hardwareConcurrency: nav.hardwareConcurrency ?? 0,
      deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      screen: typeof window !== 'undefined'
        ? { width: window.screen?.width ?? 0, height: window.screen?.height ?? 0 }
        : { width: 0, height: 0 },
      language: nav.language ?? '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
}

/* ───────────────────────── Export helpers ──────────────────────────── */

export interface ExportCsvSet {
  samplesCsv: string;
  beatsCsv: string;
  eventsCsv: string;
  reportTxt: string;
}

/** RFC-8785-flavored canonical JSON: stable key ordering, no whitespace. */
function canonicalStringify(value: unknown): string {
  const seen = new WeakSet();
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) throw new Error('cycle');
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const keys = Object.keys(v).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function samplesToCsv(rows: PpgSampleRecord[]): string {
  const head = 'timestampMs,raw,filtered,displayValue,sqi,perfusionIndex,motionScore,valid';
  const body = rows.map(r => [
    r.timestampMs, r.raw, r.filtered, r.displayValue,
    r.sqi, r.perfusionIndex, r.motionScore, r.valid ? 1 : 0,
  ].map(csvEscape).join(','));
  return [head, ...body].join('\n');
}

function beatsToCsv(rows: BeatRecord[]): string {
  const head = 'timestampMs,amplitude,rrMs,bpmInstant,quality,type,reason';
  const body = rows.map(r => [
    r.timestampMs, r.amplitude, r.rrMs ?? '', r.bpmInstant ?? '',
    r.quality, r.type, r.reason,
  ].map(csvEscape).join(','));
  return [head, ...body].join('\n');
}

function eventsToCsv(rows: SessionEvent[]): string {
  const head = 'timestampMs,kind,detail';
  const body = rows.map(r => [
    r.timestampMs, r.kind, JSON.stringify(r.detail),
  ].map(csvEscape).join(','));
  return [head, ...body].join('\n');
}

function humanReport(p: any, sha: string): string {
  return [
    'FORENSIC PPG SESSION REPORT',
    '===========================',
    `Session ID:        ${p.sessionId}`,
    `Algorithm version: ${p.algorithmVersion}`,
    `Started:           ${p.startedAt.iso}`,
    `Ended:             ${p.endedAt.iso}`,
    `Duration (s):      ${p.durationS.toFixed(3)}`,
    `SHA-256:           ${sha}`,
    '',
    'Device',
    `  UA:              ${p.device.userAgent}`,
    `  Platform:        ${p.device.platform}`,
    `  Cores:           ${p.device.hardwareConcurrency}`,
    `  RAM (GB):        ${p.device.deviceMemoryGb ?? 'n/a'}`,
    `  DPR:             ${p.device.devicePixelRatio}`,
    `  Screen:          ${p.device.screen.width}×${p.device.screen.height}`,
    `  Locale/TZ:       ${p.device.language} / ${p.device.timezone}`,
    '',
    'Camera',
    p.camera ? `  Label:           ${p.camera.deviceLabel}` : '  (not captured)',
    p.camera ? `  Resolution:      ${p.camera.resolution.width}×${p.camera.resolution.height} @ ${p.camera.realFrameRate} fps` : '',
    p.camera ? `  Torch:           supported=${p.camera.hasTorch} active=${p.camera.torchActive}` : '',
    p.camera ? `  Locks:           exp=${p.camera.exposureLocked} wb=${p.camera.wbLocked} focus=${p.camera.focusLocked} iso=${p.camera.isoValue}` : '',
    '',
    'Counters',
    `  Frames:          total=${p.counters.totalFrames} dropped(ring)=${p.counters.droppedFramesFromRing}`,
    `  Samples:         total=${p.counters.totalSamples} valid=${p.counters.validSamples} rejected=${p.counters.rejectedSamples} dropped(ring)=${p.counters.droppedSamplesFromRing}`,
    `  Beats:           ${p.counters.beats}`,
    `  Events:          ${p.counters.events}`,
    `  FPS avg:         ${p.timing.fpsAvg.toFixed(2)}`,
    `  Jitter avg (ms): ${p.timing.jitterAvgMs.toFixed(2)}`,
    '',
    'Calibration',
    p.calibration
      ? `  Profile: ${p.calibration.profileId} (algo ${p.calibration.algorithmVersion}, ${p.calibration.createdAt})`
      : '  none — vitals requiring calibration must be reported as CALIBRATION_REQUIRED',
  ].filter(Boolean).join('\n');
}

/* ───────────────────────── Browser download helper ────────────────── */

export function downloadForensicBundle(
  bundle: { json: string; csv: ExportCsvSet; sha256: string },
  sessionId: string,
): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `ppg-session_${sessionId}_${stamp}`;
  const wrapper = JSON.stringify({
    sealed: true,
    sha256: bundle.sha256,
    payload: JSON.parse(bundle.json),  // pretty for download readability
  }, null, 2);
  triggerDownload(`${base}.json`,        wrapper,             'application/json');
  triggerDownload(`${base}.samples.csv`, bundle.csv.samplesCsv, 'text/csv');
  triggerDownload(`${base}.beats.csv`,   bundle.csv.beatsCsv,   'text/csv');
  triggerDownload(`${base}.events.csv`,  bundle.csv.eventsCsv,  'text/csv');
  triggerDownload(`${base}.report.txt`,  bundle.csv.reportTxt + `\n\nSHA-256 (canonical JSON payload): ${bundle.sha256}\n`, 'text/plain');
}

function triggerDownload(filename: string, data: string, mime: string): void {
  const blob = new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 250);
}
