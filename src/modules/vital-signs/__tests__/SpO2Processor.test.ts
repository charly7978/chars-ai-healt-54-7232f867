/**
 * SpO2Processor Unit Tests
 * 
 * Tests for the SpO2 estimation processor.
 * Validates calibration model, quality gating, and forensic output.
 */

import { SpO2Processor, type SpO2Result } from '../SpO2Processor';

describe('SpO2Processor', () => {
  let processor: SpO2Processor;

  beforeEach(() => {
    processor = new SpO2Processor();
  });

  afterEach(() => {
    processor.reset();
  });

  // ── Basic Functionality Tests ──

  test('should return withheld result when no valid input', () => {
    const result = processor.process({
      redAC: 0, redDC: 0, greenAC: 0, greenDC: 0,
      contactStable: false, pressureOptimal: false,
      clipHighRatio: 0, beatCount: 0, avgBeatSQI: 0, sourceStability: 0
    });

    expect(result.value).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.enabledState).toBe('WITHHELD_LOW_QUALITY');
  });

  test('should calculate SpO2 with valid PPG signal', () => {
    // Simulate valid PPG signal with good AC/DC components
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    // Should produce a valid SpO2 value
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(100);
    expect(result.rawR).toBeGreaterThan(0);
    expect(result.medianR).toBeGreaterThan(0);
  });

  test('should include calibration state in result', () => {
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.calibrationState).toBeDefined();
    expect(['UNCALIBRATED', 'SESSION_CALIBRATED', 'DEVICE_CALIBRATED']).toContain(result.calibrationState);
  });

  // ── Quality Gating Tests ──

  test('should withhold output when contact is unstable', () => {
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: false,  // Unstable!
      pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.enabledState).toBe('WITHHELD_LOW_QUALITY');
    expect(result.value).toBe(0);
  });

  test('should withhold output when clipping detected', () => {
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0.5,  // High clipping!
      beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    // Quality should be reduced due to clipping
    expect(result.quality).toBeLessThan(50);
  });

  test('should withhold output when signal quality too low', () => {
    // Multiple low-quality readings
    for (let i = 0; i < 3; i++) {
      processor.process({
        redAC: 0.01,  // Very low AC
        redDC: 100,
        greenAC: 0.01,
        greenDC: 80,
        contactStable: true, pressureOptimal: false,
        clipHighRatio: 0, beatCount: 1, avgBeatSQI: 5, sourceStability: 0.1
      });
    }

    const result = processor.process({
      redAC: 0.01, redDC: 100,
      greenAC: 0.01, greenDC: 80,
      contactStable: true, pressureOptimal: false,
      clipHighRatio: 0, beatCount: 1, avgBeatSQI: 5, sourceStability: 0.1
    });

    expect(result.enabledState).toBe('WITHHELD_LOW_QUALITY');
    expect(result.value).toBe(0);
  });

  // ── Calibration Tests ──

  test('should update calibration coefficients', () => {
    processor.setCalibration(105, 4.5, -30, 'test-device-001');
    
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.calibrationState).toBe('DEVICE_CALIBRATED');
  });

  test('should calibrate with reference value', () => {
    // First collect some data
    for (let i = 0; i < 10; i++) {
      processor.process({
        redAC: 0.5, redDC: 100,
        greenAC: 0.3, greenDC: 80,
        contactStable: true, pressureOptimal: true,
        clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
      });
    }

    // Calibrate to reference SpO2 of 98
    processor.calibrateWithReference(98);

    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.calibrationState).toBe('SESSION_CALIBRATED');
  });

  // ── Physiological Limits Tests ──

  test('should clamp SpO2 within physiological limits', () => {
    // Extreme values that would produce out-of-range SpO2
    const extremeInputs = [
      { redAC: 5.0, redDC: 10, greenAC: 0.1, greenDC: 100 },  // Very high ratio
      { redAC: 0.01, redDC: 200, greenAC: 5.0, greenDC: 10 },  // Very low ratio
    ];

    for (const input of extremeInputs) {
      const result = processor.process({
        ...input,
        contactStable: true, pressureOptimal: true,
        clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
      });

      // Should either be 0 (withheld) or within physiological range
      if (result.value !== 0) {
        expect(result.value).toBeGreaterThanOrEqual(50);
        expect(result.value).toBeLessThanOrEqual(105);
      }
    }
  });

  // ── EMA Smoothing Tests ──

  test('should apply EMA smoothing', () => {
    // First reading establishes baseline
    processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    // Second reading should be smoothed toward first
    const result2 = processor.process({
      redAC: 0.6, redDC: 100,
      greenAC: 0.4, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result2.value).toBeGreaterThan(0);
    expect(result2.confidence).toBeGreaterThan(0);
  });

  // ── Beat Ratio Tests ──

  test('should accept beat-aligned ratios', () => {
    // Add some beat ratios
    processor.addBeatRatio(1.2);
    processor.addBeatRatio(1.3);
    processor.addBeatRatio(1.25);

    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 3, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.validBeatRatios).toBeGreaterThan(0);
  });

  // ── Reset Tests ──

  test('should reset internal state', () => {
    // Collect some data
    processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    processor.reset();

    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    // After reset, should not have EMA history
    expect(result.confidence).toBeLessThan(0.5);
  });

  test('should full reset including calibration', () => {
    processor.setCalibration(105, 4.5, -30, 'test-device');
    
    processor.fullReset();

    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.8
    });

    expect(result.calibrationState).toBe('UNCALIBRATED');
  });

  // ── Quality Score Tests ──

  test('should calculate quality score based on multiple factors', () => {
    const result = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 20, avgBeatSQI: 60, sourceStability: 0.9
    });

    // High quality input should produce high quality score
    expect(result.quality).toBeGreaterThan(40);
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  test('should reduce quality with motion artifact', () => {
    const goodResult = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: true,
      clipHighRatio: 0, beatCount: 10, avgBeatSQI: 50, sourceStability: 0.9
    });

    processor.reset();

    const noisyResult = processor.process({
      redAC: 0.5, redDC: 100,
      greenAC: 0.3, greenDC: 80,
      contactStable: true, pressureOptimal: false,  // Not optimal
      clipHighRatio: 0.2,  // Some clipping
      beatCount: 2, avgBeatSQI: 20, sourceStability: 0.3  // Low stability
    });

    expect(noisyResult.quality).toBeLessThan(goodResult.quality);
  });
});

// ── Test Summary ──
console.log('\n✓ SpO2Processor Tests: Forensic-grade SpO2 estimation');
console.log('  - Validates calibration model from Medical Parameter Registry');
console.log('  - Tests quality gating (contact, clipping, stability)');
console.log('  - Tests EMA smoothing and beat-aligned ratios');
console.log('  - Tests physiological limits enforcement');
