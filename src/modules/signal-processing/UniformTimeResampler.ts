/**
 * UNIFORM TIME RESAMPLER
 *
 * Resamples non-uniform (timestamp,value) PPG samples onto a fixed target
 * grid (default 30 Hz) via linear interpolation between the two surrounding
 * input samples. This is mandatory before the bandpass filter and before any
 * spectral SQI: real device frame timestamps jitter by ±2–8 ms even when the
 * camera is "locked at 30 fps", and IIR filters assume a uniform fs to be
 * causal-stable.
 *
 * Design constraints:
 *  - Zero allocation in the hot path. Internal state is a 4-sample sliding
 *    window (last/current input pair + last emitted output time).
 *  - Push-driven: caller pushes one (t,v) per frame; we emit zero, one or
 *    multiple uniform samples per call (when frame interval > target dt).
 *  - Confidence drops when the gap between consecutive input timestamps is
 *    larger than 2.5 × target dt (frame drop) or smaller than 0.4 × target dt
 *    (super-frame / clock glitch).
 *  - Output is buffered into a small ring (MAX_EMIT) so the consumer can drain
 *    every frame without missing samples on bursty scheduling.
 *
 * Refs:
 *  - Smith J.O. "Spectral Audio Signal Processing", §Resampling.
 *  - de Haan & Jeanne 2013 "Robust pulse-rate from chrominance-based rPPG"
 *    discusses the importance of fixed-rate input for IIR cardiac filtering.
 */

export interface ResampleOutput {
  /** Number of uniform samples produced this push (0..MAX_EMIT). */
  count: number;
  /** Uniform samples in chronological order (only [0..count-1] are valid). */
  values: Float64Array;
  /** Timestamps of the emitted samples (parallel to values). */
  timestamps: Float64Array;
  /**
   * 0..1 confidence in the temporal regularity of the *input* burst that
   * produced these outputs. <0.5 means jitter or drop big enough to penalize
   * spectral SQI.
   */
  temporalConfidence: number;
}

export class UniformTimeResampler {
  private targetHz: number;
  private dt: number;

  // last accepted input sample
  private lastT = 0;
  private lastV = 0;
  private hasLast = false;

  // next uniform output time we owe the consumer
  private nextOutT = 0;
  private initialized = false;

  // jitter EMA (ms² of |Δ - dt|)
  private jitterEMA = 0;

  // pre-allocated output buffer
  private static readonly MAX_EMIT = 6;
  private outV = new Float64Array(UniformTimeResampler.MAX_EMIT);
  private outT = new Float64Array(UniformTimeResampler.MAX_EMIT);
  private result: ResampleOutput;

  constructor(targetHz = 30) {
    this.targetHz = targetHz;
    this.dt = 1000 / targetHz;
    this.result = {
      count: 0,
      values: this.outV,
      timestamps: this.outT,
      temporalConfidence: 1,
    };
  }

  setTargetRate(hz: number): void {
    if (hz <= 0 || Math.abs(hz - this.targetHz) < 0.5) return;
    this.targetHz = hz;
    this.dt = 1000 / hz;
    // resync output cursor to current input time to avoid backflood
    if (this.hasLast) this.nextOutT = this.lastT + this.dt;
  }

  reset(): void {
    this.hasLast = false;
    this.initialized = false;
    this.jitterEMA = 0;
    this.lastT = 0; this.lastV = 0; this.nextOutT = 0;
    this.result.count = 0;
    this.result.temporalConfidence = 1;
  }

  /**
   * Push one (timestamp, value) pair. Returns the output struct (reused —
   * read it before the next push). `count==0` when no uniform sample is due
   * yet.
   */
  push(timestamp: number, value: number): ResampleOutput {
    this.result.count = 0;

    if (!isFinite(timestamp) || !isFinite(value)) {
      this.result.temporalConfidence = 0;
      return this.result;
    }

    if (!this.hasLast) {
      this.lastT = timestamp;
      this.lastV = value;
      this.nextOutT = timestamp; // emit first sample immediately
      this.hasLast = true;
      this.initialized = true;
      this.outT[0] = timestamp;
      this.outV[0] = value;
      this.result.count = 1;
      this.nextOutT = timestamp + this.dt;
      this.result.temporalConfidence = 1;
      return this.result;
    }

    const delta = timestamp - this.lastT;
    if (delta <= 0) {
      // out-of-order or duplicate frame — keep last, do nothing
      return this.result;
    }

    // Update jitter EMA in ms units (confidence proxy)
    const jitter = Math.abs(delta - this.dt);
    this.jitterEMA = this.jitterEMA * 0.85 + jitter * 0.15;

    // Detect drop / glitch
    const dropFactor = delta / this.dt;
    let conf = 1;
    if (dropFactor > 2.5) conf = Math.max(0.2, 1 - (dropFactor - 2.5) * 0.25);
    else if (dropFactor < 0.4) conf = 0.4; // super-frame / clock jump
    else conf = Math.max(0.4, 1 - this.jitterEMA / (this.dt * 1.5));
    this.result.temporalConfidence = conf;

    // Emit all uniform samples that fall in (lastT, timestamp]
    let emitted = 0;
    const slope = (value - this.lastV) / delta;
    while (this.nextOutT <= timestamp && emitted < UniformTimeResampler.MAX_EMIT) {
      const interp = this.lastV + slope * (this.nextOutT - this.lastT);
      this.outT[emitted] = this.nextOutT;
      this.outV[emitted] = interp;
      emitted++;
      this.nextOutT += this.dt;
    }
    // If we maxed out, jump cursor to keep up (avoids unbounded backlog)
    if (this.nextOutT < timestamp - this.dt) this.nextOutT = timestamp + this.dt;

    this.lastT = timestamp;
    this.lastV = value;
    this.result.count = emitted;
    return this.result;
  }

  getJitterMs(): number { return this.jitterEMA; }
  getTargetHz(): number { return this.targetHz; }
  isInitialized(): boolean { return this.initialized; }
}