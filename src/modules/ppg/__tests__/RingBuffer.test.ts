import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../RingBuffer';

describe('RingBuffer', () => {
  it('fills and reports size correctly', () => {
    const r = new RingBuffer(4);
    expect(r.size()).toBe(0);
    r.push(1); r.push(2); r.push(3);
    expect(r.size()).toBe(3);
    expect(r.toArray()).toEqual([1, 2, 3]);
  });

  it('wraps in chronological order', () => {
    const r = new RingBuffer(3);
    [1, 2, 3, 4, 5].forEach(v => r.push(v));
    expect(r.isFull()).toBe(true);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.last()).toBe(5);
  });

  it('mean ignores empty', () => {
    const r = new RingBuffer(4);
    expect(r.mean()).toBe(0);
    [2, 4, 6].forEach(v => r.push(v));
    expect(r.mean()).toBeCloseTo(4, 5);
  });

  it('reset clears state', () => {
    const r = new RingBuffer(3);
    [1, 2, 3].forEach(v => r.push(v));
    r.reset();
    expect(r.size()).toBe(0);
    expect(r.toArray()).toEqual([]);
  });
});