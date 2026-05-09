import { describe, it, expect } from 'vitest';
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

function median(arr: number[]): number {
  const a = [...arr].filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.floor(a.length / 2)];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

/**
 * Guardrail dinámico: simula un switch de stride EN CALIENTE dentro de la
 * misma sesión (lo que el backpressure adaptativo hace en producción) y
 * verifica que ni el BPM detectado ni la confianza colapsan al transicionar.
 */
describe('Backpressure dynamic transition guardrail', () => {
  const fs = 30;
  const targetBpm = 72;

  function runTransition(initial: 3 | 4, switchTo: 3 | 4) {
    const signals: ProcessedSignal[] = [];
    const proc = new PPGSignalProcessor((s) => signals.push(s));
    proc.setBackpressureConfig({ enabled: false, forceStride: initial });
    proc.start();
    const hb = new HeartBeatProcessor();

    const pre = { bpms: [] as number[], conf: [] as number[] };
    const post = { bpms: [] as number[], conf: [] as number[] };
    const justAfterSwitchBpms: number[] = [];
    const totalFrames = 600; // ~20s @ 30fps
    const switchFrame = 300;

    for (let i = 0; i < totalFrames; i++) {
      if (i === switchFrame) {
        proc.setBackpressureConfig({ enabled: false, forceStride: switchTo });
      }
      proc.processFrame(makePulseFrame(64, 64, i, targetBpm, fs));
      const last = signals[signals.length - 1];
      if (!last) continue;
      const r = hb.processSignal(last.filteredValue, i * (1000 / fs));

      // Pre-switch: ventana estabilizada antes de cambiar.
      if (i > 200 && i < switchFrame) {
        pre.bpms.push(r.bpm);
        pre.conf.push(r.confidence);
      }
      // Continuidad: 5 frames inmediatamente posteriores al switch.
      if (i >= switchFrame && i < switchFrame + 5) {
        justAfterSwitchBpms.push(r.bpm);
      }
      // Post-switch: ventana estabilizada tras transitorio.
      if (i > switchFrame + 100) {
        post.bpms.push(r.bpm);
        post.conf.push(r.confidence);
      }
    }
    proc.stop();
    return { signals, pre, post, justAfterSwitchBpms };
  }

  it('switching stride 3 -> 4 mid-session keeps BPM stable (< 4 bpm drift)', () => {
    const { pre, post } = runTransition(3, 4);
    const mPre = median(pre.bpms);
    const mPost = median(post.bpms);
    expect(mPre).toBeGreaterThan(0);
    expect(mPost).toBeGreaterThan(0);
    expect(Math.abs(mPre - mPost)).toBeLessThan(4);
  });

  it('switching stride 4 -> 3 mid-session keeps BPM stable (< 4 bpm drift)', () => {
    const { pre, post } = runTransition(4, 3);
    const mPre = median(pre.bpms);
    const mPost = median(post.bpms);
    expect(mPre).toBeGreaterThan(0);
    expect(mPost).toBeGreaterThan(0);
    expect(Math.abs(mPre - mPost)).toBeLessThan(4);
  });

  it('confidence does not collapse after stride 3 -> 4 switch', () => {
    const { pre, post } = runTransition(3, 4);
    const cPre = mean(pre.conf);
    const cPost = mean(post.conf);
    expect(cPost).toBeGreaterThanOrEqual(cPre * 0.8);
  });

  it('confidence does not collapse after stride 4 -> 3 switch', () => {
    const { pre, post } = runTransition(4, 3);
    const cPre = mean(pre.conf);
    const cPost = mean(post.conf);
    expect(cPost).toBeGreaterThanOrEqual(cPre * 0.8);
  });

  it('emits no NaN/Infinity during transition', () => {
    const { signals } = runTransition(3, 4);
    for (const s of signals) {
      expect(Number.isFinite(s.filteredValue)).toBe(true);
      expect(Number.isFinite(s.quality)).toBe(true);
    }
  });

  it('no instantaneous BPM jump > 8 bpm in first 5 frames after switch', () => {
    const { justAfterSwitchBpms } = runTransition(3, 4);
    const valid = justAfterSwitchBpms.filter((v) => Number.isFinite(v) && v > 0);
    if (valid.length >= 2) {
      const max = Math.max(...valid);
      const min = Math.min(...valid);
      expect(max - min).toBeLessThan(8);
    }
  });
});