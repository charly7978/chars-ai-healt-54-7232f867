/**
 * Lightweight typed ring buffer for hot-path numeric streams.
 * Zero allocation per push.
 */
export class RingBuffer {
  private buf: Float32Array;
  private idx = 0;
  private filled = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  push(v: number): void {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  size(): number { return this.filled; }
  isFull(): boolean { return this.filled === this.capacity; }

  /** Copy values in chronological order into a fresh array. */
  toArray(): number[] {
    const out = new Array<number>(this.filled);
    if (this.filled < this.capacity) {
      for (let i = 0; i < this.filled; i++) out[i] = this.buf[i];
    } else {
      for (let i = 0; i < this.capacity; i++) {
        out[i] = this.buf[(this.idx + i) % this.capacity];
      }
    }
    return out;
  }

  /** Most recent value (or 0 when empty — caller must check size). */
  last(): number {
    if (this.filled === 0) return 0;
    const i = (this.idx - 1 + this.capacity) % this.capacity;
    return this.buf[i];
  }

  reset(): void { this.idx = 0; this.filled = 0; this.buf.fill(0); }

  /** Compute mean over current window. */
  mean(): number {
    if (this.filled === 0) return 0;
    let s = 0;
    for (let i = 0; i < this.filled; i++) s += this.buf[i];
    return s / this.filled;
  }
}