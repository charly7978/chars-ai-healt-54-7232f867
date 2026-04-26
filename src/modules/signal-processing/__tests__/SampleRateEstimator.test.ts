import { describe, it, expect } from "vitest";
import { SampleRateEstimator } from "../timing/SampleRateEstimator";

/**
 * Helpers ─────────────────────────────────────────────────────────────────
 */
function steadyStream(fps: number, count: number, start = 1000): number[] {
  const dt = 1000 / fps;
  return Array.from({ length: count }, (_, i) => start + i * dt);
}

function jitteredStream(fps: number, count: number, jitterMs: number, seed = 42): number[] {
  const dt = 1000 / fps;
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  const out: number[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += dt + rand() * 2 * jitterMs;
  }
  return out;
}

function streamWithDrops(fps: number, count: number, dropEvery: number): number[] {
  const dt = 1000 / fps;
  const out: number[] = [];
  let t = 1000;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t += (i % dropEvery === 0 && i > 0) ? dt * 2 : dt;
  }
  return out;
}

/**
 * Tests ───────────────────────────────────────────────────────────────────
 */
describe("SampleRateEstimator – steady stream", () => {
  it("converges to exact SR on clean 30 fps timestamps", () => {
    const est = new SampleRateEstimator();
    let snap;
    for (const t of steadyStream(30, 60)) snap = est.push(t);
    expect(snap!.valid).toBe(true);
    expect(snap!.stalled).toBe(false);
    expect(snap!.sampleRate).toBeGreaterThan(29.5);
    expect(snap!.sampleRate).toBeLessThan(30.5);
    expect(snap!.jitterCoV).toBeLessThan(0.01);
  });

  it("converges to exact SR on clean 60 fps timestamps", () => {
    const est = new SampleRateEstimator();
    let snap;
    for (const t of steadyStream(60, 80)) snap = est.push(t);
    expect(snap!.sampleRate).toBeGreaterThan(59);
    expect(snap!.sampleRate).toBeLessThan(60.5);
  });

  it("reports the default SR before enough samples are seen", () => {
    const est = new SampleRateEstimator({ defaultSR: 30 });
    const snap = est.push(1000);
    expect(snap.sampleRate).toBe(30);
    expect(snap.valid).toBe(false);
  });
});

describe("SampleRateEstimator – jitter & dropped frames", () => {
  it("stays within ±2 fps under heavy jitter (±5 ms @ 30 fps)", () => {
    const est = new SampleRateEstimator();
    let snap;
    for (const t of jitteredStream(30, 90, 5)) snap = est.push(t);
    expect(Math.abs(snap!.sampleRate - 30)).toBeLessThan(2);
  });

  it("survives periodic dropped frames", () => {
    const est = new SampleRateEstimator();
    let snap;
    for (const t of streamWithDrops(30, 90, 7)) snap = est.push(t);
    expect(snap!.sampleRate).toBeGreaterThan(28);
    expect(snap!.sampleRate).toBeLessThan(31);
  });

  it("rejects non-monotonic timestamps", () => {
    const est = new SampleRateEstimator();
    for (const t of steadyStream(30, 30)) est.push(t);
    const snap = est.push(500); // back-in-time
    expect(snap.lastRejected).toBe(true);
  });
});

describe("SampleRateEstimator – stall detection", () => {
  it("freezes SR when a single huge gap (>gapTimeoutMs) appears", () => {
    const est = new SampleRateEstimator({ gapTimeoutMs: 200 });
    const ts = steadyStream(30, 60);
    let snap;
    for (const t of ts) snap = est.push(t);
    const trustedBefore = snap!.sampleRate;

    // Inject a 500 ms gap (camera paused)
    const lastT = ts[ts.length - 1];
    snap = est.push(lastT + 500);
    expect(snap.stalled).toBe(true);
    // SR remains the last trusted value
    expect(snap.sampleRate).toBeCloseTo(trustedBefore, 5);
  });

  it("freezes SR when no new timestamp arrives for stallTimeoutMs", () => {
    const est = new SampleRateEstimator({ stallTimeoutMs: 400 });
    let snap;
    for (const t of steadyStream(30, 60)) snap = est.push(t);
    const trustedBefore = snap!.sampleRate;

    // Push a NEW frame whose wall-clock far exceeds the timeout.
    snap = est.push(5000, 10000); // wallClock - lastTimestamp = 10000-... > 400
    expect(snap.stalled).toBe(true);
    expect(snap.sampleRate).toBeCloseTo(trustedBefore, 5);
  });

  it("recovers from stall once enough good consecutive deltas arrive", () => {
    const est = new SampleRateEstimator({ gapTimeoutMs: 200, recoveryFrames: 4 });
    for (const t of steadyStream(30, 40)) est.push(t);
    let t = 5000; // huge gap from last (~2300 ms)
    est.push(t); // big gap → stall
    expect(est.read().stalled).toBe(true);
    // Resume clean 30 fps
    for (let i = 0; i < 10; i++) {
      t += 1000 / 30;
      est.push(t);
    }
    const snap = est.read();
    expect(snap.stalled).toBe(false);
    expect(snap.sampleRate).toBeGreaterThan(28);
    expect(snap.sampleRate).toBeLessThan(31.5);
  });

  it("never updates SR while stalled (delineation stays stable)", () => {
    const est = new SampleRateEstimator({ gapTimeoutMs: 200 });
    let snap;
    for (const t of steadyStream(30, 60)) snap = est.push(t);
    const sr = snap!.sampleRate;
    // Generate a big gap and then keep pushing equally-bad frames.
    let t = 5000;
    snap = est.push(t);
    expect(snap.stalled).toBe(true);
    for (let i = 0; i < 3; i++) {
      t += 1000;
      snap = est.push(t);
    }
    // Still stalled, SR hasn't moved.
    expect(snap.stalled).toBe(true);
    expect(snap.sampleRate).toBeCloseTo(sr, 5);
  });
});

describe("SampleRateEstimator – auto calibration", () => {
  it("computes a low jitterCoV on a clean stream and recommends widest tolerances", () => {
    const est = new SampleRateEstimator();
    for (const t of steadyStream(30, 90)) est.push(t);
    const cal = est.computeCalibration();
    expect(cal.jitterCoV).toBeLessThan(0.05);
    expect(cal.recommendedMadFactor).toBe(3.0);
    expect(cal.acceptedSamples).toBeGreaterThan(50);
  });

  it("computes a high jitterCoV on a noisy stream and tightens MAD factor", () => {
    const est = new SampleRateEstimator();
    for (const t of jitteredStream(30, 120, 8)) est.push(t);
    const cal = est.computeCalibration();
    expect(cal.jitterCoV).toBeGreaterThan(0.10);
    expect(cal.recommendedMadFactor).toBeLessThanOrEqual(2.5);
    expect(cal.recommendedWindow).toBeGreaterThan(40);
  });

  it("applyCalibration() changes the active options", () => {
    const est = new SampleRateEstimator({ windowSize: 60, madFactor: 3 });
    for (const t of jitteredStream(30, 120, 8)) est.push(t);
    const before = est.getOptions();
    const cal = est.applyCalibration();
    const after = est.getOptions();
    expect(cal.acceptedSamples).toBeGreaterThan(50);
    expect(after.madFactor).not.toBe(before.madFactor);
  });
});

describe("SampleRateEstimator – delineation stability under variable FPS", () => {
  it("SR drift across windows stays small (< 2 Hz) on jittered + drop stream", () => {
    const est = new SampleRateEstimator();
    const stream = [
      ...jitteredStream(30, 60, 4),
      ...streamWithDrops(30, 60, 8).map(t => t + 60_000), // continue after a virtual minute
    ];
    const samples: number[] = [];
    for (const t of stream) {
      const s = est.push(t);
      if (s.valid && !s.stalled) samples.push(s.sampleRate);
    }
    const lastWindow = samples.slice(-30);
    const min = Math.min(...lastWindow);
    const max = Math.max(...lastWindow);
    expect(max - min).toBeLessThan(2);
  });
});
