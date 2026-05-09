/**
 * Pre-allocated circular buffer over `Float32Array`.
 *
 * Never uses `Array.push` / `Array.shift` for hot-path signal storage. The
 * GC must not run during capture: every write is a single indexed assignment.
 */
export class RingBuffer {
  readonly capacity: number;
  private readonly data: Float32Array;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("RingBuffer capacity must be > 0");
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  get length(): number {
    return this.size;
  }

  /**
   * Copy chronological samples into `out`. Returns the number of samples
   * copied. `out` must be at least `min(length, out.length)` long.
   */
  snapshot(out: Float32Array): number {
    const n = Math.min(this.size, out.length);
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) {
      out[i] = this.data[(start + i) % this.capacity];
    }
    return n;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.data.fill(0);
  }
}
