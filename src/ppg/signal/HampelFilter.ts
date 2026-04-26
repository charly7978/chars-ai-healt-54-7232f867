/**
 * HAMPEL FILTER
 * 
 * Outlier detection and replacement using median absolute deviation (MAD).
 * 
 * Algorithm:
 * 1. Calculate median of window
 * 2. Calculate MAD = median(|x_i - median|)
 * 3. Detect outliers where |x_i - median| > threshold * MAD
 * 4. Replace outliers with median
 * 
 * Typical threshold: 3 * MAD (covers 99.7% of Gaussian data)
 */

export interface HampelFilterConfig {
  windowSize: number;
  threshold: number; // number of MADs
}

const DEFAULT_CONFIG: HampelFilterConfig = {
  windowSize: 5,
  threshold: 3.0,
};

export class HampelFilter {
  private config: HampelFilterConfig;
  private buffer: number[] = [];

  constructor(config: Partial<HampelFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a single sample
   */
  process(sample: number): number {
    this.buffer.push(sample);
    
    if (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
    
    // Need full window for filtering
    if (this.buffer.length < this.config.windowSize) {
      return sample;
    }
    
    const median = this.calculateMedian(this.buffer);
    const mad = this.calculateMAD(this.buffer, median);
    const threshold = this.config.threshold * mad;
    
    // Check if current sample is an outlier
    const deviation = Math.abs(sample - median);
    if (deviation > threshold) {
      return median; // Replace with median
    }
    
    return sample;
  }

  /**
   * Calculate median
   */
  private calculateMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Calculate Median Absolute Deviation (MAD)
   */
  private calculateMAD(values: number[], median: number): number {
    const deviations = values.map(v => Math.abs(v - median));
    return this.calculateMedian(deviations);
  }

  /**
   * Process an array of samples
   */
  processArray(samples: number[]): number[] {
    this.reset();
    return samples.map(s => this.process(s));
  }

  /**
   * Get outlier count from last window
   */
  getOutlierCount(): number {
    if (this.buffer.length < this.config.windowSize) return 0;
    
    const median = this.calculateMedian(this.buffer);
    const mad = this.calculateMAD(this.buffer, median);
    const threshold = this.config.threshold * mad;
    
    return this.buffer.filter(v => Math.abs(v - median) > threshold).length;
  }

  /**
   * Reset filter state
   */
  reset(): void {
    this.buffer = [];
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<HampelFilterConfig>): void {
    this.config = { ...this.config, ...config };
    this.reset();
  }

  /**
   * Get current configuration
   */
  getConfig(): HampelFilterConfig {
    return { ...this.config };
  }
}
