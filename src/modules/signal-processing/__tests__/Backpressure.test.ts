import { describe, it, expect, beforeEach } from 'vitest';
import { PPGSignalProcessor } from '../PPGSignalProcessor';
import { HeartBeatProcessor } from '../../HeartBeatProcessor';
import type { ProcessedSignal } from '../../../types/signal';

const ImageDataCtor: typeof ImageData =
  (globalThis as any).ImageData ??
  class {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data; this.width = w; this.height = h;
    }
  } as any;
(globalThis as any).ImageData = ImageDataCtor;

/**
 * Genera un frame red-dominant pulsátil. Patrón espacialmente uniforme para
 * que stride 3 vs 4 produzca prácticamente el mismo promedio (la diferencia
 * sólo afecta el coste, no la señal).
 */
function makePulseFrame(w: number, h: number, t: number, bpm: number, fs: number): ImageData {
  const phase = 2 * Math.PI * (bpm / 60) * (t / fs);
  const pulse = Math.round(180 + 10 * Math.sin(phase));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = pulse;
    data[i * 4 + 1] = 95;
    data[i * 4 + 2] = 75;
    data[i * 4 + 3] = 255;
  }
  return new ImageDataCtor(data, w, h);
}

function runSession(stride: 3 | 4): { bpms: number[]; confidences: number[]; signals: ProcessedSignal[] } {
  const signals: ProcessedSignal[] = [];
  const proc = new PPGSignalProcessor((s) => signals.push(s));
  proc.setBackpressureConfig({ enabled: false, forceStride: stride });
  proc.start();

  const hb = new HeartBeatProcessor();
  const bpms: number[] = [];
  const confidences: number[] = [];
  const fs = 30;
  const targetBpm = 72;

  for (let i = 0; i < 600; i++) {
    proc.processFrame(makePulseFrame(64, 64, i, targetBpm, fs));
    const last = signals[signals.length - 1];
    if (!last) continue;
    const r = hb.processSignal(last.filteredValue, i * (1000 / fs));
    if (i > 300) {
      bpms.push(r.bpm);
      confidences.push(r.confidence);
    }
  }
  proc.stop();
  return { bpms, confidences, signals };
}

function median(arr: number[]): number {
  const a = [...arr].filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor(a.length / 2)];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

describe('Backpressure guardrail — pixelStride 3 vs 4', () => {
  let s3: ReturnType<typeof runSession>;
  let s4: ReturnType<typeof runSession>;

  beforeEach(() => {
    s3 = runSession(3);
    s4 = runSession(4);
  });

  it('emits finite quality and filteredValue under both strides', () => {
    for (const s of [...s3.signals, ...s4.signals]) {
      expect(Number.isFinite(s.filteredValue)).toBe(true);
      expect(Number.isFinite(s.quality)).toBe(true);
      expect(s.quality).toBeGreaterThanOrEqual(0);
      expect(s.quality).toBeLessThanOrEqual(100);
    }
  });

  it('detected BPM stays close (< 4 bpm drift) when stride switches 3 -> 4', () => {
    const m3 = median(s3.bpms);
    const m4 = median(s4.bpms);
    expect(m3).toBeGreaterThan(0);
    expect(m4).toBeGreaterThan(0);
    expect(Math.abs(m3 - m4)).toBeLessThan(4);
  });

  it('average HR confidence does not collapse with stride 4 vs 3', () => {
    const c3 = mean(s3.confidences);
    const c4 = mean(s4.confidences);
    // Stride 4 puede ser ligeramente más ruidoso pero NO debe degradar
    // la confianza más allá de un margen razonable.
    expect(c4).toBeGreaterThanOrEqual(c3 * 0.85);
  });

  it('stride config is respected end-to-end', () => {
    const proc = new PPGSignalProcessor(() => {});
    proc.setBackpressureConfig({ enabled: false, forceStride: 4 });
    expect(proc.getBackpressureState().pixelStride).toBe(4);
    proc.setBackpressureConfig({ enabled: false, forceStride: 3 });
    expect(proc.getBackpressureState().pixelStride).toBe(3);
    // Disabled sin forceStride → vuelve a baseline 3
    proc.setBackpressureConfig({ enabled: false, forceStride: undefined });
    expect(proc.getBackpressureState().pixelStride).toBe(3);
  });
});