/**
 * EvidenceGate Unit Tests
 * 
 * Tests for the forensic-grade validation system.
 * Ensures fail-closed behavior and proper evidence validation.
 */

import { EvidenceGate, type SignalEvidence, type EvidenceResult } from '../EvidenceGate';

describe('EvidenceGate', () => {
  let gate: EvidenceGate;

  beforeEach(() => {
    gate = new EvidenceGate();
  });

  afterEach(() => {
    gate.clearFailureHistory();
  });

  // ── Valid Evidence Tests ──

  test('should pass with valid stable contact', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('VALID');
    expect(result.reason).toContain('All forensic checks passed');
  });

  // ── Fail-Closed Tests ──

  test('should block when no contact detected', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'NO_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('NO_CONTACT');
    expect(result.reason).toContain('No stable finger contact');
  });

  test('should block when contact is unstable', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'UNSTABLE',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('NO_CONTACT');
  });

  test('should block when saturation detected', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0.20, // > 0.15 threshold
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('SATURATION_DETECTED');
    expect(result.reason).toContain('saturat');
  });

  test('should block when FPS insufficient', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 10, // < 15 required
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('FPS_INSUFFICIENT');
    expect(result.reason).toContain('FPS');
  });

  test('should block when SQI insufficient', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 10, // < 24 required
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('SQI_INSUFFICIENT');
    expect(result.reason).toContain('Signal Quality');
  });

  test('should block when perfusion index insufficient', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.001, // < 0.003 required
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('SQI_INSUFFICIENT');
  });

  test('should block when temporally incoherent', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      temporalCoherence: {
        lastFrameDeltaMs: 100, // Too high jitter
        expectedDeltaMs: 33,
        jitterMs: 100, // > 50% of expected
      },
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('TEMPORALLY_INCOHERENT');
  });

  // ── Calibration Required Tests ──

  test('should require calibration for SpO2 output', () => {
    const baseEvidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const baseResult = gate.validate(baseEvidence);
    expect(baseResult.allowed).toBe(true);

    const biometricCheck = gate.canOutputBiometric(baseResult, 'spo2');
    expect(biometricCheck.allowed).toBe(false);
    expect(biometricCheck.outputLabel).toContain('UNCALIBRATED');
  });

  test('should require calibration for blood pressure output', () => {
    const baseEvidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const baseResult = gate.validate(baseEvidence);
    const biometricCheck = gate.canOutputBiometric(baseResult, 'bloodPressure');
    expect(biometricCheck.allowed).toBe(false);
  });

  test('should allow BPM without calibration', () => {
    const baseEvidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const baseResult = gate.validate(baseEvidence);
    const biometricCheck = gate.canOutputBiometric(baseResult, 'bpm');
    expect(biometricCheck.allowed).toBe(true);
  });

  test('should allow calibrated SpO2', () => {
    const baseEvidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: true, // Calibrated!
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const baseResult = gate.validate(baseEvidence);
    const biometricCheck = gate.canOutputBiometric(baseResult, 'spo2');
    expect(biometricCheck.allowed).toBe(true);
  });

  // ── Multiple Failures ──

  test('should report multiple failures', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'NO_CONTACT',
      saturationRatio: 0.20,
      fps: 10,
      sqi: 5,
      perfusionIndex: 0.001,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(false);
    expect(result.status).toBe('MULTIPLE_FAILURES');
    expect(result.technicalDetails.allFailures).toBeDefined();
    expect((result.technicalDetails.allFailures as string[]).length).toBeGreaterThan(1);
  });

  // ── Audit Trail ──

  test('should record failure history', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'NO_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    gate.validate(evidence);
    gate.validate(evidence);
    gate.validate(evidence);

    const history = gate.getFailureHistory();
    expect(history.length).toBe(3);
    expect(history[0].reason).toBe('NO_CONTACT');
  });

  test('should clear failure history', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'NO_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    gate.validate(evidence);
    gate.clearFailureHistory();

    const history = gate.getFailureHistory();
    expect(history.length).toBe(0);
  });

  // ── Edge Cases ──

  test('should handle edge case: exactly at thresholds', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0.15, // Exactly at threshold
      fps: 15, // Exactly at threshold
      sqi: 24, // Exactly at threshold
      perfusionIndex: 0.003, // Exactly at threshold
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    // At exact thresholds, should pass (>= threshold)
    expect(result.allowed).toBe(true);
  });

  test('should handle missing temporal coherence data', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      // No temporalCoherence provided
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.allowed).toBe(true);
    expect(result.status).toBe('VALID');
  });

  test('should include timestamp in result', () => {
    const evidence: SignalEvidence = {
      timestamp: Date.now(),
      contactState: 'STABLE_CONTACT',
      saturationRatio: 0,
      fps: 30,
      sqi: 50,
      perfusionIndex: 0.05,
      calibrationAvailable: {
        spo2: false,
        bloodPressure: false,
        glucose: false,
        lipids: false,
      },
    };

    const result = gate.validate(evidence);

    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.calibrationState).toBeDefined();
  });
});

// ── Test Summary ──
console.log('\n✓ EvidenceGate Tests: Fail-closed forensic validation system');
console.log('  - Validates signal quality before biometric output');
console.log('  - Requires calibration for estimation models');
console.log('  - Records audit trail of failures');
console.log('  - Blocks on: no contact, saturation, low FPS, low SQI, temporal incoherence');
