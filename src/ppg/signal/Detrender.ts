/**
 * DETRENDER
 * 
 * Removes slow baseline drift from PPG signals.
 * 
 * Methods:
 * - Moving average (simple)
 * - EWMA (exponentially weighted moving average)
 * - Median filter (robust to outliers)
 * 
 * The detrended signal = original - baseline
 */

export type DetrendMethod = 'moving_average' | 'ewma' | 'median';

export interface DetrenderConfig {
  method: DetrendMethod;
  windowSize: number; // for moving average and median
  alpha: number; // for EWMA
}

const DEFAULT_CONFIG: DetrenderConfig = {
  method: 'ewma',
  windowSize: 60, // ~2 seconds at 30fps
  alpha: 0.02, // ~5 second time constant
};

export class Detrender {
  private config: DetrenderConfig;
  private buffer: number[] = [];
  private ewmaState = 0;
  private initialized = false;

  constructor(config: Partial<DetrenderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Detrend a single sample
   */
  process(sample: number): number {
    const baseline = this.calculateBaseline(sample);
    return sample - baseline;
  }

  /**
   * Calculate baseline using configured method
   */
  private calculateBaseline(sample: number): number {
    switch (this.config.method) {
      case 'moving_average':
        return this.movingAverageBaseline(sample);
      case 'ewma':
        return this.ewmaBaseline(sample);
      case 'median':
        return this.medianBaseline(sample);
      default:
        return this.ewmaBaseline(sample);
    }
  }

  /**
   * Moving average baseline
   */
  private movingAverageBaseline(sample: number): number {
    this.buffer.push(sample);
    if (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
    
    const sum = this.buffer.reduce((a, b) => a + b, 0);
    return sum / this.buffer.length;
  }

  /**
   * EWMA baseline
   */
  private ewmaBaseline(sample: number): number {
    if (!this.initialized) {
      this.ewmaState = sample;
      this.initialized = true;
      return sample;
    }
    
    this.ewmaState = this.ewmaState + this.config.alpha * (sample - this.ewmaState);
    return this.ewmaState;
  }

  /**
   * Median baseline (robust to outliers)
   */
  private medianBaseline(sample: number): number {
    this.buffer.push(sample);
    if (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
    
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Detrend an array of samples
   */
  processArray(samples: number[]): number[] {
    this.reset();
    return samples.map(s => this.process(s));
  }

  /**
   * Reset detrender state
   */
  reset(): void {
    this.buffer = [];
    this.ewmaState = 0;
    this.initialized = false;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<DetrenderConfig>): void {
    this.config = { ...this.config, ...config };
    this.reset();
  }

  /**
   * Get current configuration
   */
  getConfig(): DetrenderConfig {
    return { ...this.config };
  }
}
