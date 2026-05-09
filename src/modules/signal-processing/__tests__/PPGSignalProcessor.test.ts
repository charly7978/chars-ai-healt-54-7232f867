import { describe, it, expect, beforeEach } from 'vitest';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import type { ProcessedSignal } from '../../../types/signal';

// Polyfill ImageData if not in jsdom env
const ImageDataCtor: typeof ImageData =
  (globalThis as any).ImageData ??
  class {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data; this.width = w; this.height = h;
    }
  } as any;
(globalThis as any).ImageData = ImageDataCtor;

function makeFrame(w: number, h: number, r: number, g: number, b: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return new ImageDataCtor(data, w, h);
}

describe('PPGSignalProcessor', () => {
  let proc: PPGSignalProcessor;
  let signals: ProcessedSignal[] = [];

  beforeEach(() => {
    signals = [];
    proc = new PPGSignalProcessor((s) => signals.push(s));
    proc.start();
  });

  it('reports NO_CONTACT and quality=0 on dark/empty frames', () => {
    for (let i = 0; i < 10; i++) proc.processFrame(makeFrame(64, 64, 5, 5, 5));
    expect(signals.length).toBeGreaterThan(0);
    const last = signals[signals.length - 1];
    expect(last.contactState).toBe('NO_CONTACT');
    expect(last.quality).toBe(0);
    expect(last.fingerDetected).toBe(false);
    expect(last.filteredValue).toBe(0);
  });

  it('never emits NaN/Infinity in filteredValue or quality', () => {
    // Simulate noisy red-dominant pulsatile signal
    for (let i = 0; i < 200; i++) {
      const pulse = Math.round(180 + 8 * Math.sin(2 * Math.PI * 1.2 * (i / 30)));
      proc.processFrame(makeFrame(64, 64, pulse, 90, 70));
    }
    for (const s of signals) {
      expect(Number.isFinite(s.filteredValue)).toBe(true);
      expect(Number.isFinite(s.quality)).toBe(true);
      expect(s.quality).toBeGreaterThanOrEqual(0);
      expect(s.quality).toBeLessThanOrEqual(100);
    }
  });

  it('progresses contact state when red-dominant pulsatile signal is fed', () => {
    for (let i = 0; i < 120; i++) {
      const pulse = Math.round(180 + 6 * Math.sin(2 * Math.PI * 1.2 * (i / 30)));
      proc.processFrame(makeFrame(64, 64, pulse, 95, 75));
    }
    const states = new Set(signals.map(s => s.contactState));
    // At minimum should leave NO_CONTACT and reach UNSTABLE or STABLE
    expect(states.has('UNSTABLE_CONTACT') || states.has('STABLE_CONTACT')).toBe(true);
  });

  it('stop() halts emission of new signals', () => {
    proc.processFrame(makeFrame(64, 64, 200, 80, 60));
    proc.stop();
    const before = signals.length;
    proc.processFrame(makeFrame(64, 64, 200, 80, 60));
    expect(signals.length).toBe(before);
  });

  it('rejects oversaturated (blown out) frames as NO_CONTACT', () => {
    for (let i = 0; i < 30; i++) proc.processFrame(makeFrame(64, 64, 255, 255, 255));
    const last = signals[signals.length - 1];
    expect(last.contactState).toBe('NO_CONTACT');
  });
});