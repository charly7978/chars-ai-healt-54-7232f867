/**
 * Motion gate built on the DeviceMotion API.
 *
 * Computes a continuous motionScore in [0, 1] from accelerometer + gyroscope
 * samples. 0 = perfectly still, 1 = strong motion. The score combines:
 *   - Linear acceleration jerk (derivative of |a|).
 *   - Rotation rate magnitude.
 *
 * Both signals are smoothed with an exponential moving average so brief
 * spikes (a single jitter event) do not flap the gate. The gate is
 * intentionally a deterministic signal-processing filter — no ML, no random.
 *
 * iOS Safari requires `DeviceMotionEvent.requestPermission()`; call
 * `MotionGate.requestPermission()` from a user gesture before `start()`.
 */

export interface MotionGateOptions {
  /** EMA smoothing for instantaneous score (0..1, higher = more reactive). */
  readonly emaAlpha: number;
  /** Acceleration magnitude (m/s²) at which jerk term saturates to 1. */
  readonly accelSaturation: number;
  /** Rotation rate (deg/s) at which rotation term saturates to 1. */
  readonly rotationSaturation: number;
  /** Score above which the gate reports motionExcessive=true. */
  readonly excessiveThreshold: number;
}

export const DEFAULT_MOTION_OPTIONS: MotionGateOptions = {
  emaAlpha: 0.25,
  accelSaturation: 4.0,
  rotationSaturation: 90,
  excessiveThreshold: 0.45,
};

export class MotionGate {
  private readonly opt: MotionGateOptions;
  private score = 0;
  private lastAccelMag = 0;
  private lastTs = 0;
  private listening = false;
  private readonly handler = (ev: DeviceMotionEvent): void => this.onSample(ev);

  constructor(options: Partial<MotionGateOptions> = {}) {
    this.opt = { ...DEFAULT_MOTION_OPTIONS, ...options };
  }

  /** Request iOS permission. No-op on Android/desktop. */
  static async requestPermission(): Promise<boolean> {
    const Ctor = (globalThis as unknown as {
      DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
    }).DeviceMotionEvent;
    if (Ctor && typeof Ctor.requestPermission === "function") {
      try {
        const result = await Ctor.requestPermission();
        return result === "granted";
      } catch {
        return false;
      }
    }
    return true;
  }

  start(): void {
    if (this.listening) return;
    if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;
    window.addEventListener("devicemotion", this.handler);
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    window.removeEventListener("devicemotion", this.handler);
    this.listening = false;
    this.score = 0;
    this.lastAccelMag = 0;
    this.lastTs = 0;
  }

  /** Current motion score in [0, 1]. 0 = still. */
  get motionScore(): number {
    return this.score;
  }

  /** True when the gate considers motion strong enough to invalidate PPG. */
  get motionExcessive(): boolean {
    return this.score >= this.opt.excessiveThreshold;
  }

  private onSample(ev: DeviceMotionEvent): void {
    const a = ev.accelerationIncludingGravity ?? ev.acceleration;
    const r = ev.rotationRate;
    const ts = performance.now();
    const dt = this.lastTs > 0 ? Math.max(0.005, (ts - this.lastTs) / 1000) : 0.05;
    this.lastTs = ts;

    let accelTerm = 0;
    if (a) {
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      const az = a.z ?? 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      const jerk = Math.abs(mag - this.lastAccelMag) / dt;
      this.lastAccelMag = mag;
      accelTerm = Math.min(1, jerk / this.opt.accelSaturation);
    }

    let rotTerm = 0;
    if (r) {
      const rx = r.alpha ?? 0;
      const ry = r.beta ?? 0;
      const rz = r.gamma ?? 0;
      const rotMag = Math.sqrt(rx * rx + ry * ry + rz * rz);
      rotTerm = Math.min(1, rotMag / this.opt.rotationSaturation);
    }

    const instant = Math.max(accelTerm, rotTerm);
    const a0 = this.opt.emaAlpha;
    this.score = this.score * (1 - a0) + instant * a0;
  }
}

/** Process-wide singleton for components that just want a shared score. */
let sharedInstance: MotionGate | null = null;
export function getSharedMotionGate(): MotionGate {
  if (!sharedInstance) sharedInstance = new MotionGate();
  return sharedInstance;
}
