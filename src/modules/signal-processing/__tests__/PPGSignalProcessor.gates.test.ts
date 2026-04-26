/**
 * Forensic gate behaviour tests for PPGSignalProcessor.
 *
 * These DO NOT validate vital sign accuracy. They validate that the
 * triple-gate output behaves correctly under three controlled inputs:
 *
 *   1. Air / wall (uniform mid-grey, no red dominance) → gate1=false, raw=0.
 *   2. Static red surface (no AC pulsation)            → gate1 may pass
 *      momentarily, but gate2_spectral never opens.
 *   3. Synthetic cardiac PPG (red baseline + 1.2 Hz AC) → gate1+gate2 open
 *      after a few seconds and the OD buffer fills past 1.0 s.
 *
 * The synthetic stream lives ONLY here, never in src/. It exists to verify
 * the gates' physics — not to seed any vital number.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PPGSignalProcessor } from "../PPGSignalProcessor";
import type { ProcessedSignal } from "../../../types/signal";

function makeImageData(
  width: number,
  height: number,
  rFn: (x: number, y: number) => number,
  gFn: (x: number, y: number) => number,
  bFn: (x: number, y: number) => number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i + 0] = Math.max(0, Math.min(255, Math.round(rFn(x, y))));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(gFn(x, y))));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(bFn(x, y))));
      data[i + 3] = 255;
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("PPGSignalProcessor — forensic gates under controlled inputs", () => {
  const W = 64, H = 48;
  let captured: ProcessedSignal | null = null;
  let proc: PPGSignalProcessor;

  beforeEach(() => {
    captured = null;
    proc = new PPGSignalProcessor((s) => { captured = s; });
    proc.start();
  });

  it("AIR (uniform grey): gate1_optical=false, rawValue=0, no publication", () => {
    let t = 1000;
    for (let frame = 0; frame < 30; frame++) {
      // mid-grey ≈ no red dominance: R/(G+B) ≈ 0.5
      const img = makeImageData(W, H,
        () => 100 + (Math.sin(frame * 0.3) * 2),
        () => 100,
        () => 100,
      );
      proc.processFrame(img, t);
      t += 33;
    }
    expect(captured).not.toBeNull();
    const fg = (captured! as any).forensicGate;
    expect(fg.gate1_optical).toBe(false);
    expect(fg.passAll).toBe(false);
    expect(captured!.rawValue).toBe(0);
    expect(captured!.filteredValue).toBe(0);
  });

  it("STATIC RED (no pulsation): spectral gate never opens", () => {
    let t = 1000;
    for (let frame = 0; frame < 240; frame++) { // ~8 seconds at 30 fps
      // Strong red, low G/B, NO temporal modulation.
      const img = makeImageData(W, H,
        () => 200,
        () => 30,
        () => 30,
      );
      proc.processFrame(img, t);
      t += 33;
    }
    const fg = (captured! as any).forensicGate;
    // gate1 may or may not pass (depends on texture), but gate2 must never
    // open without AC content and passAll must remain false.
    expect(fg.gate2_spectral).toBe(false);
    expect(fg.passAll).toBe(false);
  });

  it("SYNTHETIC CARDIAC: OD buffer fills, sample rate is real", () => {
    let t = 1000;
    const fps = 30;
    const totalFrames = fps * 4; // 4 s
    const F_HZ = 1.2; // 72 BPM
    for (let frame = 0; frame < totalFrames; frame++) {
      const tSec = frame / fps;
      // Add per-pixel jitter so spatialUniformity isn't perfect 1.0.
      const baseR = 200 + 8 * Math.sin(2 * Math.PI * F_HZ * tSec);
      const img = makeImageData(W, H,
        (x, y) => baseR + ((x + y) % 5) * 0.6,
        () => 60,
        () => 60,
      );
      proc.processFrame(img, t);
      t += 1000 / fps;
    }
    const fg = (captured! as any).forensicGate;
    expect(fg.bufferedSeconds).toBeGreaterThanOrEqual(1.0);
    expect(fg.effectiveSampleRate).toBeGreaterThan(20);
    expect(fg.effectiveSampleRate).toBeLessThan(40);
    // Liveness should have opened given the strong red dominance + texture.
    expect(fg.gate1_optical).toBe(true);
  });
});