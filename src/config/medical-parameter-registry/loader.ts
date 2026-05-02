/**
 * Medical Parameter Registry Loader
 * 
 * Loads and validates biomedical parameters from configuration files.
 * All parameters are versioned, sourced, and justified.
 * 
 * CRITICAL: No hardcoded values in this file. All numeric constants
 * must come from defaults.json or runtime configuration.
 */

import defaultParams from './defaults.json';

export interface CalibrationModel {
  modelType: 'population' | 'device_specific' | 'subject_calibrated' | 'research_only';
  coefficients: Record<string, number>;
  referenceCenters?: Record<string, number>;
  validationStatus: 'validated' | 'pending_validation' | 'research_only' | 'deprecated';
  source: string;
  citation: string;
  justification: string;
  version: string;
  requiresCalibration: boolean;
  outputLabel: string;
  limits?: Record<string, number>;
}

export interface EvidenceGateConfig {
  strictMode: boolean;
  requiredConditions: string[];
  calibrationRequiredFor: string[];
  failureMode: 'zero_output' | 'null_output' | 'error_state' | 'last_valid';
  showDiagnostics: boolean;
}

export interface MedicalParameters {
  schemaVersion: string;
  lastUpdated: string;
  reviewedBy: string;
  signalProcessing: {
    fps: { min: number; max: number; target: number; source: string; justification: string };
    contactDetection: {
      fingerConfirmFrames: number;
      fingerLostFrames: number;
      stableContactThreshold: number;
      unstableGraceFrames: number;
      source: string;
      justification: string;
    };
    clippingThresholds: {
      highSaturation: number;
      lowSaturation: number;
      highClipThreshold: number;
      saturatedClipThreshold: number;
      source: string;
      justification: string;
    };
    roi: {
      stride: number;
      gridSize: number;
      coverageThreshold: number;
      source: string;
      justification: string;
    };
    buffers: {
      ringBufferSize: number;
      frameTimeBufferSize: number;
      maxRRIntervals: number;
      maxAcceptedBeats: number;
      templateWindow: number;
      source: string;
      justification: string;
    };
  };
  calibrationModels: {
    spo2: CalibrationModel;
    bloodPressure: CalibrationModel;
    glucose: CalibrationModel;
    lipids: CalibrationModel;
  };
  qualityThresholds: {
    signalQualityIndex: {
      high: number;
      medium: number;
      low: number;
      minimal: number;
      sufficient: number;
      source: string;
      justification: string;
    };
    perfusionIndex: {
      min: number;
      target: number;
      sufficient: number;
      source: string;
      justification: string;
    };
    beatDetection: {
      minConfidence: number;
      templateCorrelationThreshold: number;
      source: string;
      justification: string;
    };
  };
  physiologicalLimits: {
    bpm: { min: number; max: number; source: string; justification: string };
    rrInterval: {
      minMs: number;
      maxMs: number;
      hardRefractoryMs: number;
      softRefractoryMs: number;
      maxBeatAgeMs: number;
      source: string;
      justification: string;
    };
    spo2: { min: number; max: number; source: string; justification: string };
  };
  filtering: {
    bandpass: {
      lowCutoffHz: number;
      highCutoffHz: number;
      source: string;
      justification: string;
    };
    ema: {
      rgbAlpha: number;
      coverageAlpha: number;
      bpmAlphaStable: number;
      bpmAlphaHighChange: number;
      valueAlphaStable: number;
      valueAlphaDynamic: number;
      source: string;
      justification: string;
    };
  };
  evidenceGate: EvidenceGateConfig;
}

class ParameterRegistry {
  private params: MedicalParameters;
  private loadedAt: Date;

  constructor() {
    this.params = this.validateAndLoad(defaultParams as any);
    this.loadedAt = new Date();
  }

  private validateAndLoad(raw: any): MedicalParameters {
    // Basic validation - in production, use JSON schema validation
    if (!raw.schemaVersion || !raw.parameters) {
      throw new Error('Invalid parameter file: missing schemaVersion or parameters');
    }

    // Transform flat structure to typed structure
    return {
      schemaVersion: raw.schemaVersion,
      lastUpdated: raw.lastUpdated,
      reviewedBy: raw.reviewedBy,
      signalProcessing: raw.parameters.signalProcessing,
      calibrationModels: raw.parameters.calibrationModels,
      qualityThresholds: raw.parameters.qualityThresholds,
      physiologicalLimits: raw.parameters.physiologicalLimits,
      filtering: raw.parameters.filtering,
      evidenceGate: raw.parameters.evidenceGate,
    };
  }

  getAll(): MedicalParameters {
    return this.params;
  }

  getCalibrationModel(modelName: keyof MedicalParameters['calibrationModels']): CalibrationModel {
    const model = this.params.calibrationModels[modelName];
    if (!model) {
      throw new Error(`Unknown calibration model: ${modelName}`);
    }
    return model;
  }

  getQualityThreshold(thresholdName: keyof MedicalParameters['qualityThresholds']): any {
    return this.params.qualityThresholds[thresholdName];
  }

  getPhysiologicalLimit(limitName: keyof MedicalParameters['physiologicalLimits']): any {
    return this.params.physiologicalLimits[limitName];
  }

  getSignalProcessingParam(paramPath: string): any {
    const parts = paramPath.split('.');
    let value: any = this.params.signalProcessing;
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) {
        throw new Error(`Unknown signal processing parameter: ${paramPath}`);
      }
    }
    return value;
  }

  getEvidenceGateConfig(): EvidenceGateConfig {
    return this.params.evidenceGate;
  }

  getMetadata(): { loadedAt: Date; schemaVersion: string; lastUpdated: string; reviewedBy: string } {
    return {
      loadedAt: this.loadedAt,
      schemaVersion: this.params.schemaVersion,
      lastUpdated: this.params.lastUpdated,
      reviewedBy: this.params.reviewedBy,
    };
  }

  /**
   * Check if a biometric output requires calibration
   */
  requiresCalibration(outputType: string): boolean {
    return this.params.evidenceGate.calibrationRequiredFor.includes(outputType);
  }

  /**
   * Get the output label for uncalibrated measurements
   */
  getUncalibratedLabel(modelName: keyof MedicalParameters['calibrationModels']): string {
    const model = this.getCalibrationModel(modelName);
    return model.outputLabel;
  }
}

// Singleton instance
export const parameterRegistry = new ParameterRegistry();

// Convenience exports for direct access
export const getCalibrationModel = (model: keyof MedicalParameters['calibrationModels']) => 
  parameterRegistry.getCalibrationModel(model);

export const getQualityThreshold = (threshold: keyof MedicalParameters['qualityThresholds']) => 
  parameterRegistry.getQualityThreshold(threshold);

export const getPhysiologicalLimit = (limit: keyof MedicalParameters['physiologicalLimits']) => 
  parameterRegistry.getPhysiologicalLimit(limit);

export const getSignalProcessingParam = (path: string) => 
  parameterRegistry.getSignalProcessingParam(path);

export const getEvidenceGateConfig = () => 
  parameterRegistry.getEvidenceGateConfig();

export default parameterRegistry;
