/**
 * RING BUFFER
 * 
 * Fixed-size circular buffer for zero-allocation signal storage.
 */

export class RingBuffer<T extends number> {
  private buffer: Float64Array;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    this.buffer = new Float64Array(capacity);
  }

  /**
   * Push value into buffer
   */
  push(value: T): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.buffer.length;
    if (this.size < this.buffer.length) {
      this.size++;
    }
  }

  /**
   * Get value at index (0 = oldest, size-1 = newest)
   */
  get(index: number): T {
    if (index < 0 || index >= this.size) {
      throw new Error(`Index ${index} out of bounds [0, ${this.size})`);
    }
    const actualIndex = (this.head - this.size + index + this.buffer.length) % this.buffer.length;
    return this.buffer[actualIndex] as T;
  }

  /**
   * Get most recent value
   */
  latest(): T {
    if (this.size === 0) throw new Error('Buffer is empty');
    return this.get(this.size - 1);
  }

  /**
   * Get all values in order (oldest to newest)
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      result.push(this.get(i));
    }
    return result;
  }

  /**
   * Get current size
   */
  get length(): number {
    return this.size;
  }

  /**
   * Get capacity
   */
  get capacity(): number {
    return this.buffer.length;
  }

  /**
   * Check if buffer is full
   */
  isFull(): boolean {
    return this.size === this.buffer.length;
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /**
   * Calculate percentile
   */
  percentile(p: number): number {
    if (this.size === 0) return 0;
    const sorted = this.toArray().sort((a, b) => a - b);
    const index = Math.floor(p * (sorted.length - 1));
    return sorted[index];
  }

  /**
   * Calculate mean
   */
  mean(): number {
    if (this.size === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.size; i++) {
      sum += this.get(i);
    }
    return sum / this.size;
  }

  /**
   * Calculate standard deviation
   */
  std(): number {
    if (this.size === 0) return 0;
    const mean = this.mean();
    let sumSq = 0;
    for (let i = 0; i < this.size; i++) {
      const diff = this.get(i) - mean;
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq / this.size);
  }
}
