import { HeartBeatProcessor } from '../modules/HeartBeatProcessor';

/**
 * Forensic-aware contact states.
 *
 * Legacy names ('NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT') are kept
 * so existing modules keep compiling. The new states give the forensic mode
 * granularity to distinguish "no optical contact at all" (camera looking at
 * air / objects / ambient light) from "finger present but very low perfusion"
 * (cold / shock / hypothermia) — the latter MUST NOT be silently rejected.
 */
export type ContactState =
  | 'NO_CONTACT'
  | 'UNSTABLE_CONTACT'
  | 'STABLE_CONTACT'
  | 'NO_OPTICAL_CONTACT'
  | 'OPTICAL_CONTACT_LOW_PERFUSION'
  | 'OPTICAL_CONTACT_GOOD_PERFUSION';

export interface ProcessedSignal {
  timestamp: number;
  rawValue: number;
  filteredValue: number;
  quality: number;
  fingerDetected: boolean;
  contactState: ContactState;
  motionArtifact?: boolean;
  roi: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  perfusionIndex?: number;
  rawRed?: number;
  rawGreen?: number;
  diagnostics?: {
    message: string;
    hasPulsatility: boolean;
    pulsatilityValue: number;
    // V8: telemetría extendida (todos opcionales, no rompen consumidores).
    textureEntropy?: number;
    coverageContiguity?: number;
    maskIoU?: number;
    trackerSigma?: number;
    piR?: number;
    piG?: number;
    piB?: number;
    vitalityCount?: number;
    bandpassMode?: 'NORMAL' | 'RESCUE';
    frameJump?: boolean;
  };
  /**
   * Forensic triple-gate verdict — the ONLY thing that authorises the UI
   * to render BPM, the PPG waveform, or any vital sign.
   *
   *   gate1_optical   : hardened hemoglobin signature + spatial texture
   *   gate2_spectral  : cardiac-band SNR ≥ 6 dB sustained 1.5 s
   *   gate3_morphology: 4 consecutive morphology-valid beats
   *   passAll         : AND of the three (frame-level go/no-go)
   *
   * `livenessReason` is a human-readable Spanish sentence describing why the
   * gate is closed (or 'OK' when open). UI surfaces it directly.
   */
  forensicGate?: {
    gate1_optical: boolean;
    gate2_spectral: boolean;
    gate3_morphology: boolean;
    passAll: boolean;
    cardiacSNRdB: number;
    spectralPeakHz: number;
    spectralConcentration: number;
    livenessReason: string;
    /**
     * OpticalEvidenceGate (gate físico independiente de morfología).
     * `opticalEvidence`=true significa que la cámara está físicamente
     * recibiendo señal compatible con tejido perfundido (no aire/objeto).
     */
    opticalEvidence?: boolean;
    opticalReason?: string;       // código RejectionCode: OK, CLIPPING_HIGH, ...
    opticalReasonText?: string;   // texto humano en español
    opticalMetrics?: {
      acDc: number;
      rOverGB: number;
      texture: number;
      clipHigh: number;
      clipLow: number;
      pi: number;
      meanR: number;
    } | null;
    /** AND duro de los 4 gates (3 + evidencia óptica). UI publica SOLO si true. */
    publicationGate?: boolean;
    /** Sample rate medido del span temporal real del buffer 10s. */
    effectiveSampleRate?: number;
    /** Segundos efectivos cubiertos por el buffer temporal. */
    bufferedSeconds?: number;
  };
}

export interface ProcessingError {
  code: string;
  message: string;
  timestamp: number;
}

export interface SignalProcessor {
  initialize: () => Promise<void>;
  start: () => void;
  stop: () => void;
  calibrate: () => Promise<boolean>;
  onSignalReady?: (signal: ProcessedSignal) => void;
  onError?: (error: ProcessingError) => void;
}

declare global {
  interface Window {
    heartBeatProcessor: HeartBeatProcessor;
  }
}
