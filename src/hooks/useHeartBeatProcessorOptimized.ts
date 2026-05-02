/**
 * useHeartBeatProcessorOptimized
 * 
 * Hook for optimized cardiac signal processing with:
 * - Kalman-filtered BPM estimation
 * - Adaptive double-threshold peak detection
 * - Butterworth 4th-order bandpass filtering
 * - Multi-method fusion (temporal + spectral)
 * 
 * Based on literature 2023-2025:
 * - MDPI Sensors 2024: Butterworth Filtering optimization
 * - ScienceDirect 2024: Adaptive threshold peak detection
 * - IEEE 2023: POS chrominance-based rPPG
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { HeartBeatProcessorOptimized } from '../modules/HeartBeatProcessorOptimized';
import { ArrhythmiaDetector, type ArrhythmiaEvidence } from '../modules/arrhythmia/ArrhythmiaDetector';
import type { ContactState } from '../types/signal';
import type { HeartBeatResult } from '../types/beat';

export const useHeartBeatProcessorOptimized = () => {
  const processorRef = useRef<HeartBeatProcessorOptimized | null>(null);
  const arrhythmiaDetectorRef = useRef<ArrhythmiaDetector | null>(null);
  const [currentBPM, setCurrentBPM] = useState<number>(0);
  const [confidence, setConfidence] = useState<number>(0);
  const [signalQuality, setSignalQuality] = useState<number>(0);
  const [arrhythmiaEvidence, setArrhythmiaEvidence] = useState<ArrhythmiaEvidence | null>(null);
  const [lastResult, setLastResult] = useState<HeartBeatResult | null>(null);

  const sessionIdRef = useRef<string>('');
  const processingStateRef = useRef<'IDLE' | 'ACTIVE' | 'RESETTING'>('IDLE');
  const lastProcessTimeRef = useRef<number>(0);
  const processedSignalsRef = useRef<number>(0);
  const noContactFramesRef = useRef<number>(0);
  const NO_CONTACT_RESET_THRESHOLD = 90;

  // Initialize processor
  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `hb_opt_${t}_${p}`;
    
    processorRef.current = new HeartBeatProcessorOptimized();
    arrhythmiaDetectorRef.current = new ArrhythmiaDetector();
    processingStateRef.current = 'ACTIVE';
    
    console.log('[useHeartBeatProcessorOptimized] Initialized with Kalman filtering, adaptive thresholds, and arrhythmia detection');

    return () => {
      if (processorRef.current) {
        processorRef.current.dispose();
        processorRef.current = null;
      }
      processingStateRef.current = 'IDLE';
    };
  }, []);

  const processSignal = useCallback((
    value: number,
    contactState: ContactState = 'STABLE_CONTACT',
    timestamp?: number,
    upstreamContext?: {
      quality?: number;
      contactState?: string;
      motionArtifact?: boolean;
      pressureState?: string;
      clipHigh?: number;
      clipLow?: number;
      activeSource?: string;
      perfusionIndex?: number;
      rawRed?: number;
      rawGreen?: number;
      rawBlue?: number;
      positionDrifting?: boolean;
    }
  ): HeartBeatResult => {
    if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
      return makeEmptyResult(currentBPM);
    }

    const currentTime = timestamp ?? performance.now();

    // Handle no-contact state
    if (contactState === 'NO_CONTACT') {
      noContactFramesRef.current += 1;
      if (noContactFramesRef.current >= NO_CONTACT_RESET_THRESHOLD) {
        processorRef.current.reset();
      }
      setCurrentBPM(0);
      setConfidence(0);
      setSignalQuality(0);
      return makeEmptyResult(0);
    }

    // Rate limiting: max ~83Hz processing (12ms minimum interval)
    if (currentTime - lastProcessTimeRef.current < 12) {
      return lastResult ?? makeEmptyResult(currentBPM);
    }
    lastProcessTimeRef.current = currentTime;

    noContactFramesRef.current = 0;
    processedSignalsRef.current++;

    // Process with optimized processor
    const result = processorRef.current.processSignal(value, timestamp, {
      quality: upstreamContext?.quality,
      contactState: upstreamContext?.contactState ?? contactState,
      motionArtifact: upstreamContext?.motionArtifact,
      perfusionIndex: upstreamContext?.perfusionIndex,
      rawRed: upstreamContext?.rawRed,
      rawGreen: upstreamContext?.rawGreen,
      rawBlue: upstreamContext?.rawBlue,
    });

    setLastResult(result);

    // Analyze arrhythmia if beat detected with valid RR interval
    if (arrhythmiaDetectorRef.current && result.isPeak && result.rrData?.intervals?.length > 0) {
      const lastRR = result.rrData.intervals[result.rrData.intervals.length - 1];
      const evidence = arrhythmiaDetectorRef.current.processBeat(lastRR, currentTime);
      if (evidence) {
        setArrhythmiaEvidence(evidence);
      }
    }

    // Update state with hysteresis to prevent flickering
    const roundedSQI = Math.round(result.sqi);
    setSignalQuality(roundedSQI);

    // BPM confidence threshold: require >0.15 confidence for display
    if (result.bpm > 0 && result.bpmConfidence >= 0.15) {
      // Apply hysteresis: don't update if small change
      const bpmDiff = Math.abs(result.bpm - currentBPM);
      if (bpmDiff > 1 || currentBPM === 0) {
        setCurrentBPM(Math.round(result.bpm));
      }
      setConfidence(result.bpmConfidence);
    } else if (result.bpmConfidence > 0) {
      // Low confidence: show reduced confidence but keep last BPM briefly
      setConfidence(result.bpmConfidence * 0.5);
    }

    return result;
  }, [currentBPM, lastResult]);

  const reset = useCallback(() => {
    if (processingStateRef.current === 'RESETTING') return;
    processingStateRef.current = 'RESETTING';

    if (processorRef.current) processorRef.current.reset();
    if (arrhythmiaDetectorRef.current) arrhythmiaDetectorRef.current.reset();

    setCurrentBPM(0);
    setConfidence(0);
    setSignalQuality(0);
    setArrhythmiaEvidence(null);
    setLastResult(null);
    lastProcessTimeRef.current = 0;
    processedSignalsRef.current = 0;
    noContactFramesRef.current = 0;

    processingStateRef.current = 'ACTIVE';
  }, []);

  // Get current arrhythmia status for UI
  const getArrhythmiaStatus = useCallback((): ArrhythmiaEvidence | null => {
    return arrhythmiaEvidence;
  }, [arrhythmiaEvidence]);

  // Legacy compatibility - arrhythmia detection is now automatic
  const setArrhythmiaState = useCallback((_isDetected: boolean) => {
    // No-op: detection is automatic via ArrhythmiaDetector
  }, []);

  // Export RR intervals for HRV analysis
  const getRRIntervals = useCallback((): number[] => {
    return processorRef.current?.getRRIntervals() ?? [];
  }, []);

  return {
    currentBPM,
    confidence,
    signalQuality,
    arrhythmiaEvidence,
    processSignal,
    reset,
    setArrhythmiaState,
    getArrhythmiaStatus,
    getRRIntervals,
    debugInfo: {
      sessionId: sessionIdRef.current,
      processingState: processingStateRef.current,
      processedSignals: processedSignalsRef.current,
      processor: 'HeartBeatProcessorOptimized',
      features: ['KalmanFilter', 'AdaptiveThreshold', 'Butterworth4thOrder', 'TemplateMatching', 'ArrhythmiaDetection'],
    },
  };
};

function makeEmptyResult(bpm: number): HeartBeatResult {
  return {
    bpm,
    bpmConfidence: 0,
    isPeak: false,
    filteredValue: 0,
    arrhythmiaCount: 0,
    sqi: 0,
    beatSQI: 0,
    rrData: { intervals: [], lastPeakTime: null },
    hypothesis: null,
    detectorAgreement: 0,
    rejectionReason: '',
    beatFlags: null,
    debug: {
      instantBpm: 0,
      medianRRBpm: 0,
      autocorrBpm: 0,
      spectralBpm: 0,
      lastBeatSQI: 0,
      detectorAgreement: 0,
      expectedRR: 0,
      refractoryState: 'open',
      beatsAccepted: 0,
      beatsRejected: 0,
      lastRejectionReason: '',
      doublePeakCount: 0,
      missedBeatCount: 0,
      suspiciousCount: 0,
      templateCorrelation: 0,
      morphologyScore: 0,
      consecutivePeaks: 0,
      recentAcceptedBeats: [],
    },
  };
}

export default useHeartBeatProcessorOptimized;
