/**
 * SAVITZKY-GOLAY FILTER
 * 
 * Polynomial smoothing filter for visual smoothing.
 * 
 * Note: This is for visual smoothing only, NOT for inventing peaks.
 * Beat detection should use the bandpass-filtered signal.
 * 
 * Parameters:
 * - windowSize: odd number, typically 5-15
 * - polynomialOrder: typically 2 or 3
 */

export interface SavitzkyGolayConfig {
  windowSize: number;
  polynomialOrder: number;
}

const DEFAULT_CONFIG: SavitzkyGolayConfig = {
  windowSize: 7,
  polynomialOrder: 2,
};

export class SavitzkyGolay {
  private config: SavitzkyGolayConfig;
  private coefficients: number[] = [];
  private buffer: number[] = [];

  constructor(config: Partial<SavitzkyGolayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.validateConfig();
    this.calculateCoefficients();
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    if (this.config.windowSize % 2 === 0) {
      throw new Error('Window size must be odd');
    }
    if (this.config.polynomialOrder >= this.config.windowSize) {
      throw new Error('Polynomial order must be less than window size');
    }
  }

  /**
   * Calculate Savitzky-Golay coefficients
   */
  private calculateCoefficients(): void {
    const { windowSize, polynomialOrder } = this.config;
    const halfWindow = Math.floor(windowSize / 2);
    
    // Build design matrix
    const J: number[][] = [];
    for (let i = -halfWindow; i <= halfWindow; i++) {
      const row: number[] = [];
      for (let j = 0; j <= polynomialOrder; j++) {
        row.push(Math.pow(i, j));
      }
      J.push(row);
    }
    
    // Calculate J^T * J
    const JTJ: number[][] = [];
    for (let i = 0; i <= polynomialOrder; i++) {
      JTJ[i] = [];
      for (let j = 0; j <= polynomialOrder; j++) {
        let sum = 0;
        for (let k = 0; k < windowSize; k++) {
          sum += J[k][i] * J[k][j];
        }
        JTJ[i][j] = sum;
      }
    }
    
    // Invert JTJ (Gaussian elimination)
    const inv = this.matrixInverse(JTJ);
    
    // Calculate coefficients for center point (convolution weights)
    this.coefficients = [];
    for (let i = 0; i < windowSize; i++) {
      let sum = 0;
      for (let j = 0; j <= polynomialOrder; j++) {
        sum += inv[j][0] * J[i][j];
      }
      this.coefficients.push(sum);
    }
  }

  /**
   * Matrix inversion (Gaussian elimination)
   */
  private matrixInverse(matrix: number[][]): number[][] {
    const n = matrix.length;
    const augmented: number[][] = matrix.map((row, i) => [
      ...row,
      ...Array(n).fill(0).map((_, j) => (i === j ? 1 : 0))
    ]);
    
    // Forward elimination
    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = k;
        }
      }
      
      // Swap rows
      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];
      
      // Eliminate column
      for (let k = i + 1; k < n; k++) {
        const factor = augmented[k][i] / augmented[i][i];
        for (let j = i; j < 2 * n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }
    
    // Back substitution
    for (let i = n - 1; i >= 0; i--) {
      for (let k = i - 1; k >= 0; k--) {
        const factor = augmented[k][i] / augmented[i][i];
        for (let j = i; j < 2 * n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
      
      // Normalize row
      const divisor = augmented[i][i];
      for (let j = 0; j < 2 * n; j++) {
        augmented[i][j] /= divisor;
      }
    }
    
    // Extract inverse
    return augmented.map(row => row.slice(n));
  }

  /**
   * Process a single sample (returns 0 until buffer is full)
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
    
    // Apply convolution
    let sum = 0;
    for (let i = 0; i < this.config.windowSize; i++) {
      sum += this.coefficients[i] * this.buffer[i];
    }
    
    return sum;
  }

  /**
   * Process an array of samples
   */
  processArray(samples: number[]): number[] {
    this.reset();
    return samples.map(s => this.process(s));
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
  setConfig(config: Partial<SavitzkyGolayConfig>): void {
    this.config = { ...this.config, ...config };
    this.validateConfig();
    this.calculateCoefficients();
    this.reset();
  }

  /**
   * Get current configuration
   */
  getConfig(): SavitzkyGolayConfig {
    return { ...this.config };
  }
}
