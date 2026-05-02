// NOTE: The legacy HeartBeatProcessor module was removed. The optimized
// implementation lives at modules/HeartBeatProcessorOptimized.ts and is
// instantiated through useHeartBeatProcessorOptimized. We deliberately
// avoid exposing it on `window` because doing so encouraged duplicate
// instances bypassing the React lifecycle.

export type ContactState = 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';

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
  /** Real measured frame-rate at the moment this sample was produced. */
  sampleRate?: number;
  fingerPosition?: 'TIP' | 'FLAT' | 'UNKNOWN';  // TIP=punta, FLAT=acostado
  diagnostics?: {
    message: string;
    hasPulsatility: boolean;
    pulsatilityValue: number;
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

// (window.heartBeatProcessor removed — see comment above.)
