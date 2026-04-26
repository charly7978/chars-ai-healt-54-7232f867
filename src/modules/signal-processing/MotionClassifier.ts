/**
 * MotionClassifier
 * ----------------
 * Frame-level motion gating for forensic PPG capture.
 *
 * Subscribes to the DeviceMotion API (acelerómetro + giroscopio) and computes
 * a rolling EWMA of |Δaccel| + 0.4·|gyroRate|. Classifies the current motion
 * envelope into 4 levels and exposes a `shouldDropFrame()` decision used by
 * the capture loop to suppress frames that are unsalvageable while still
 * letting the operator see the live waveform.
 *
 * Forensic constraint (see PPGSignalProcessor.ts): motion must NEVER be a
 * permanent hard gate. We enforce this with a max-drop-rate cap of 50% over
 * any rolling 1 s window — even under sustained severe motion, the operator
 * still receives ~15 fps so the UI never freezes.
 */

export type MotionLevel = 'STILL' | 'MICRO_MOTION' | 'MODERATE_MOTION' | 'SEVERE_MOTION';

export interface MotionState {
  level: MotionLevel;
  score: number;          // EWMA score, ~0..3+
  imuActive: boolean;     // true once we've received ≥1 devicemotion event
  eventCount: number;
  droppedFramesLastSec: number;
  totalFramesLastSec: number;
}

export class MotionClassifier {
  // Thresholds tuned to match PPGSignalProcessor's existing motion model
  // (MOTION_THRESH=0.6, MOTION_HIGH_THRESH=0.95, MOTION_GATE_THRESH=1.6).
  private readonly MICRO_THRESH = 0.35;
  private readonly MODERATE_THRESH = 0.95;
  private readonly SEVERE_THRESH = 1.8;

  // Sustained-severe debounce: only start dropping after motion has been
  // SEVERE for at least 250 ms (≈ 8 frames @30 fps). Stops the classifier
  // from punishing a single jerk.
  private readonly SEVERE_HOLD_MS = 250;
  private severeSinceTs: number | null = null;

  // Max-drop-rate cap: never drop more than 50% of frames over any 1 s
  // rolling window (forensic: operator must always see the live trace).
  private readonly DROP_CAP_RATIO = 0.5;
  private readonly WINDOW_MS = 1000;
  private frameLog: Array<{ ts: number; dropped: boolean }> = [];

  private score = 0;
  private lastAccel = { x: 0, y: 0, z: 0 };
  private hasLastAccel = false;
  private eventCount = 0;
  private listenerActive = false;

  private readonly handleEvent = (ev: DeviceMotionEvent) => {
    this.eventCount++;
    const ax = ev.accelerationIncludingGravity?.x ?? 0;
    const ay = ev.accelerationIncludingGravity?.y ?? 0;
    const az = ev.accelerationIncludingGravity?.z ?? 0;
    let dAccel = 0;
    if (this.hasLastAccel) {
      const dx = ax - this.lastAccel.x;
      const dy = ay - this.lastAccel.y;
      const dz = az - this.lastAccel.z;
      dAccel = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.lastAccel = { x: ax, y: ay, z: az };
    this.hasLastAccel = true;

    const rr = ev.rotationRate;
    const gx = rr?.alpha ?? 0;
    const gy = rr?.beta ?? 0;
    const gz = rr?.gamma ?? 0;
    // rotationRate is in deg/s; scale ~1/100 so it lives in same range as accel delta
    const gyroMag = Math.sqrt(gx * gx + gy * gy + gz * gz) / 100;

    const instant = dAccel + 0.4 * gyroMag;
    // EWMA, α=0.18 → ~250 ms time constant at typical 60 Hz devicemotion.
    this.score = this.score * 0.82 + instant * 0.18;
  };

  async start(): Promise<void> {
    if (this.listenerActive) return;
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return;
    try {
      const reqPerm = (DeviceMotionEvent as any).requestPermission;
      if (typeof reqPerm === 'function') {
        const granted = await reqPerm();
        if (granted !== 'granted') return;
      }
      window.addEventListener('devicemotion', this.handleEvent, { passive: true });
      this.listenerActive = true;
    } catch {
      // Silently degrade — main pipeline already handles missing IMU
    }
  }

  stop(): void {
    if (!this.listenerActive) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this.handleEvent);
    }
    this.listenerActive = false;
    this.score = 0;
    this.hasLastAccel = false;
    this.severeSinceTs = null;
    this.frameLog.length = 0;
  }

  classify(): MotionLevel {
    if (this.score >= this.SEVERE_THRESH) return 'SEVERE_MOTION';
    if (this.score >= this.MODERATE_THRESH) return 'MODERATE_MOTION';
    if (this.score >= this.MICRO_THRESH) return 'MICRO_MOTION';
    return 'STILL';
  }

  /**
   * Frame-level decision: should the capture loop SKIP processFrame()?
   *
   * Returns true only when:
   *   1. motion is currently SEVERE
   *   2. it has been SEVERE for at least SEVERE_HOLD_MS (debounce)
   *   3. dropping this frame keeps the rolling drop-rate ≤ DROP_CAP_RATIO
   *
   * The caller MUST call markFrame(dropped) immediately after to keep the
   * rolling-window stats honest.
   */
  shouldDropFrame(nowMs: number): boolean {
    const level = this.classify();
    if (level !== 'SEVERE_MOTION') {
      this.severeSinceTs = null;
      return false;
    }
    if (this.severeSinceTs === null) {
      this.severeSinceTs = nowMs;
      return false;
    }
    if (nowMs - this.severeSinceTs < this.SEVERE_HOLD_MS) return false;

    // Enforce the 50%/1s drop cap
    this.pruneOlder(nowMs);
    const total = this.frameLog.length;
    if (total < 4) return true; // not enough history; allow drop
    const dropped = this.frameLog.reduce((n, f) => n + (f.dropped ? 1 : 0), 0);
    // If dropping THIS frame would push us over the cap, keep it.
    return (dropped + 1) / (total + 1) <= this.DROP_CAP_RATIO;
  }

  markFrame(nowMs: number, dropped: boolean): void {
    this.frameLog.push({ ts: nowMs, dropped });
    this.pruneOlder(nowMs);
  }

  private pruneOlder(nowMs: number): void {
    const cutoff = nowMs - this.WINDOW_MS;
    while (this.frameLog.length > 0 && this.frameLog[0].ts < cutoff) {
      this.frameLog.shift();
    }
  }

  getState(nowMs: number = performance.now()): MotionState {
    this.pruneOlder(nowMs);
    const total = this.frameLog.length;
    const dropped = this.frameLog.reduce((n, f) => n + (f.dropped ? 1 : 0), 0);
    return {
      level: this.classify(),
      score: this.score,
      imuActive: this.listenerActive && this.eventCount > 0,
      eventCount: this.eventCount,
      droppedFramesLastSec: dropped,
      totalFramesLastSec: total,
    };
  }
}