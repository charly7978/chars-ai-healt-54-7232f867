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
