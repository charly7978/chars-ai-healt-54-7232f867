import { describe, it, expect } from 'vitest';
import { RealPPGFrameEngine } from '../RealPPGFrameEngine';

/**
 * NEGATIVE TESTS — under no scenario should the engine publish BPM/waveform
 * for non-PPG inputs.
 */

function solidFrame(r: number, g: number, b: number, w = 80, h = 80): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    arr[i * 4] = r;
    arr[i * 4 + 1] = g;
    arr[i * 4 + 2] = b;
    arr[i * 4 + 3] = 255;
  }
  return arr;
}

function noiseFrame(seed: number, w = 80, h = 80): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    // deterministic LCG, not Math.random
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    arr[i * 4] = s & 0xff;
    arr[i * 4 + 1] = (s >> 8) & 0xff;
    arr[i * 4 + 2] = (s >> 16) & 0xff;
    arr[i * 4 + 3] = 255;
  }
  return arr;
}

function feedFor(engine: RealPPGFrameEngine, frames: number, factory: (i: number) => Uint8ClampedArray) {
  let last;
  for (let i = 0; i < frames; i++) {
    last = engine.processFrame(factory(i), 80, 80, i * 33.33);
  }
  return last!;
}

describe('RealPPGFrameEngine — negative cases', () => {
  it('air (black frames) never publishes', () => {
    const eng = new RealPPGFrameEngine();
    const snap = feedFor(eng, 60, () => solidFrame(0, 0, 0));
    expect(snap.publication.canPublish).toBe(false);
    expect(snap.publication.bpm).toBeNull();
    expect(snap.publication.waveform.length).toBe(0);
    expect(snap.optical.opticalContact).toBe(false);
  });

  it('white overexposed frames never publish', () => {
    const eng = new RealPPGFrameEngine();
    const snap = feedFor(eng, 60, () => solidFrame(255, 255, 255));
    expect(snap.publication.canPublish).toBe(false);
    expect(snap.publication.bpm).toBeNull();
  });

  it('static red sheet (constant red, no AC) never publishes', () => {
    const eng = new RealPPGFrameEngine();
    const snap = feedFor(eng, 90, () => solidFrame(220, 50, 40));
    expect(snap.publication.canPublish).toBe(false);
    expect(snap.publication.bpm).toBeNull();
    // perfusion candidate must be false (no AC)
    expect(snap.optical.perfusionCandidate).toBe(false);
  });

  it('pure noise never publishes', () => {
    const eng = new RealPPGFrameEngine();
    const snap = feedFor(eng, 120, (i) => noiseFrame(i + 1));
    expect(snap.publication.canPublish).toBe(false);
  });

  it('vibration is forbidden when canPublish=false', () => {
    const eng = new RealPPGFrameEngine();
    const snap = feedFor(eng, 60, () => solidFrame(220, 50, 40));
    expect(snap.vibrationAllowed).toBe(false);
  });

  it('reset clears state', () => {
    const eng = new RealPPGFrameEngine();
    feedFor(eng, 30, (i) => noiseFrame(i + 1));
    eng.reset();
    const snap = eng.processFrame(solidFrame(0, 0, 0), 80, 80, 0);
    expect(snap.frameIndex).toBe(1);
    expect(snap.publication.canPublish).toBe(false);
  });
});