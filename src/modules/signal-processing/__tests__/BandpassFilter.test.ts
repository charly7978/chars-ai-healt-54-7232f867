import { describe, it, expect } from 'vitest';
import { BandpassFilter } from '../BandpassFilter';

function generate(fs: number, freqs: { f: number; a: number }[], dc = 100, n = 1024): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = dc;
    for (const { f, a } of freqs) v += a * Math.sin(2 * Math.PI * f * (i / fs));
    out.push(v);
  }
  return out;
}

function rms(x: number[], from = 0): number {
  let s = 0; let n = 0;
  for (let i = from; i < x.length; i++) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
}

describe('BandpassFilter', () => {
  it('attenuates DC component (>0.99 reduction in steady state)', () => {
    const f = new BandpassFilter(30);
    const dc = generate(30, [], 200, 600);
    let last = 0;
    for (const v of dc) last = f.filter(v);
    // ignore transient: take last 200 samples
    const tail = dc.slice(400).map(v => f.filter(v));
    expect(Math.abs(last)).toBeLessThan(5);
    expect(rms(tail)).toBeLessThan(2);
  });

  it('passes a 1.2 Hz cardiac-band sine and rejects 10 Hz noise', () => {
    const fs = 30;
    const cardiac = generate(fs, [{ f: 1.2, a: 5 }], 120, 900);
    const noise = generate(fs, [{ f: 10, a: 5 }], 120, 900);
    const fc = new BandpassFilter(fs);
    const fn = new BandpassFilter(fs);
    const yc = cardiac.map(v => fc.filter(v));
    const yn = noise.map(v => fn.filter(v));
    // skip transient
    const rmsC = rms(yc, 300);
    const rmsN = rms(yn, 300);
    expect(rmsC).toBeGreaterThan(rmsN * 2.0);
  });

  it('handles non-finite input safely', () => {
    const f = new BandpassFilter(30);
    expect(f.filter(NaN)).toBe(0);
    expect(f.filter(Infinity)).toBe(0);
  });

  it('reset() returns filter to zero state', () => {
    const f = new BandpassFilter(30);
    for (let i = 0; i < 100; i++) f.filter(150 + Math.sin(i));
    f.reset();
    expect(f.filter(0)).toBe(0);
  });

  it('setSampleRate recomputes coefficients without throwing', () => {
    const f = new BandpassFilter(30);
    f.filter(120);
    expect(() => f.setSampleRate(60)).not.toThrow();
    expect(Number.isFinite(f.filter(120))).toBe(true);
  });
});