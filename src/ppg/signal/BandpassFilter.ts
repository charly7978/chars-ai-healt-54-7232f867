/**
 * BANDPASS FILTER
 * 
 * Biquad Butterworth bandpass filter for PPG signals.
 * 
 * Bands:
 * - Display: 0.4–5.0 Hz (24–300 BPM)
 * - HR: 0.7–4.0 Hz (42–240 BPM)
 * - Rescue: 0.5–8.0 Hz (narrower for CHROM/POS signals)
 * 
 * Recalculates coefficients with real sample rate.
 */

export type FilterMode = 'DISPLAY' | 'HR' | 'RESCUE';

export interface BandpassConfig {
  mode: FilterMode;
  sampleRate: number;
  lowCut: number; // Hz
  highCut: number; // Hz
}

const FILTER_BANDS: Record<FilterMode, { lowCut: number; highCut: number }> = {
  DISPLAY: { lowCut: 0.4, highCut: 5.0 },
  HR: { lowCut: 0.7, highCut: 4.0 },
  RESCUE: { lowCut: 0.5, highCut: 8.0 },
};

export class BandpassFilter {
  private config: BandpassConfig;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0; // Input history
  private x2 = 0; // Input history
  private y1 = 0; // Output history
  private y2 = 0; // Output history

  constructor(sampleRate: number = 30, mode: FilterMode = 'HR') {
    const band = FILTER_BANDS[mode];
    this.config = {
      mode,
      sampleRate,
      lowCut: band.lowCut,
      highCut: band.highCut,
    };
    this.calculateCoefficients();
  }

  /**
   * Calculate biquad coefficients for Butterworth bandpass
   */
  private calculateCoefficients(): void {
    const { sampleRate, lowCut, highCut } = this.config;
    
    // Normalize frequencies
    const omega1 = (2 * Math.PI * lowCut) / sampleRate;
    const omega2 = (2 * Math.PI * highCut) / sampleRate;
    
    // Bandwidth
    const bw = omega2 - omega1;
    const centerFreq = Math.sqrt(omega1 * omega2);
    
    // Quality factor
    const Q = centerFreq / bw;
    
    // Butterworth coefficients
    const alpha = Math.sin(centerFreq) / (2 * Q);
    const cosOmega = Math.cos(centerFreq);
    
    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosOmega;
    const a2 = 1 - alpha;
    
    // Normalize by a0
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  /**
   * Process a single sample (direct form II transposed)
   */
  process(sample: number): number {
    const output = this.b0 * sample + this.b1 * this.x1 + this.b2 * this.x2
                    - this.a1 * this.y1 - this.a2 * this.y2;
    
    // Update history
    this.x2 = this.x1;
    this.x1 = sample;
    this.y2 = this.y1;
    this.y1 = output;
    
    return output;
  }

  /**
   * Process an array of samples
   */
  processArray(samples: number[]): number[] {
    this.reset();
    return samples.map(s => this.process(s));
  }

  /**
   * Update sample rate and recalculate coefficients
   */
  setSampleRate(sampleRate: number): void {
    this.config.sampleRate = sampleRate;
    this.calculateCoefficients();
    this.reset();
  }

  /**
   * Change filter mode
   */
  setMode(mode: FilterMode): void {
    this.config.mode = mode;
    const band = FILTER_BANDS[mode];
    this.config.lowCut = band.lowCut;
    this.config.highCut = band.highCut;
    this.calculateCoefficients();
    this.reset();
  }

  /**
   * Reset filter state
   */
  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  /**
   * Get current configuration
   */
  getConfig(): BandpassConfig {
    return { ...this.config };
  }
}
