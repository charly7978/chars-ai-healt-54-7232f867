/**
 * SPECTRAL ANALYZER
 * 
 * Performs FFT/Welch analysis for spectral validation.
 */

export interface SpectralResult {
  peakHz: number;
  peakPower: number;
  totalPower: number;
  peakRatio: number;
  spectrum: number[];
}

export class SpectralAnalyzer {
  /**
   * Perform FFT and return power spectrum
   */
  fft(signal: number[]): number[] {
    const n = signal.length;
    const powerSpectrum = new Float64Array(n / 2);
    
    for (let k = 0; k < n / 2; k++) {
      let real = 0;
      let imag = 0;
      for (let i = 0; i < n; i++) {
        const angle = (2 * Math.PI * k * i) / n;
        real += signal[i] * Math.cos(angle);
        imag -= signal[i] * Math.sin(angle);
      }
      powerSpectrum[k] = (real * real + imag * imag) / (n * n);
    }
    
    return Array.from(powerSpectrum);
  }

  /**
   * Find dominant peak in frequency band
   */
  findPeak(spectrum: number[], sampleRate: number, minHz: number, maxHz: number): SpectralResult {
    const n = spectrum.length * 2;
    
    const minIndex = Math.floor((minHz * n) / sampleRate);
    const maxIndex = Math.ceil((maxHz * n) / sampleRate);
    
    let maxPower = 0;
    let peakIndex = 0;
    let totalPower = 0;
    
    for (let i = 0; i < spectrum.length; i++) {
      totalPower += spectrum[i];
      
      if (i >= minIndex && i <= maxIndex && spectrum[i] > maxPower) {
        maxPower = spectrum[i];
        peakIndex = i;
      }
    }
    
    const peakHz = (peakIndex * sampleRate) / n;
    const peakRatio = totalPower > 0 ? maxPower / totalPower : 0;
    
    return {
      peakHz,
      peakPower: maxPower,
      totalPower,
      peakRatio,
      spectrum,
    };
  }

  /**
   * Welch's method for better spectral estimation
   */
  welch(signal: number[], sampleRate: number, windowSize: number = 64, overlap: number = 32): SpectralResult {
    const segments: number[] = [];
    
    for (let i = 0; i < signal.length - windowSize; i += overlap) {
      segments.push(...signal.slice(i, i + windowSize));
    }
    
    const spectrum = this.fft(segments);
    return this.findPeak(spectrum, sampleRate, 0.5, 5.0);
  }
}
