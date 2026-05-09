/**
 * Ring buffer pre-asignado en Float32Array.
 * Cero asignaciones por frame en el hot path.
 */
export class FloatRingBuffer {
  private buffer: Float32Array;
  private capacity: number;
  private head: number = 0;
  private count: number = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
  }

  push(value: number): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  size(): number { return this.count; }
  isFull(): boolean { return this.count === this.capacity; }

  /** O(N) snapshot cronológico — solo cuando se necesita */
  getOrdered(out?: Float32Array): Float32Array {
    const target = out && out.length === this.count ? out : new Float32Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      target[i] = this.buffer[(start + i) % this.capacity];
    }
    return target;
  }

  last(): number {
    if (this.count === 0) return 0;
    return this.buffer[(this.head - 1 + this.capacity) % this.capacity];
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.fill(0);
  }
}
