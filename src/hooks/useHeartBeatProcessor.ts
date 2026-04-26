import { useState, useEffect, useCallback, useRef } from 'react';
import { HeartBeatProcessor } from '../modules/HeartBeatProcessor';
import type { ContactState } from '../types/signal';
import type { HeartBeatResult } from '../types/beat';
import type { FiducialParams } from '../modules/beats/FiducialDelineator';

/**
 * HOOK DE PROCESAMIENTO CARDÍACO V2
 * 
 * - Expone richer beat results (beatSQI, hypothesis, flags, debug)
 * - Alineado con ContactState del PPGSignalProcessor
 * - Pasa upstream context al procesador
 */
export const useHeartBeatProcessor = () => {
  const processorRef = useRef<HeartBeatProcessor | null>(null);
  const [currentBPM, setCurrentBPM] = useState<number>(0);
  const [confidence, setConfidence] = useState<number>(0);
  const [signalQuality, setSignalQuality] = useState<number>(0);

  const sessionIdRef = useRef<string>('');
  const processingStateRef = useRef<'IDLE' | 'ACTIVE' | 'RESETTING'>('IDLE');
  const lastProcessTimeRef = useRef<number>(0);
  const processedSignalsRef = useRef<number>(0);
  const noContactFramesRef = useRef<number>(0);
  const NO_CONTACT_RESET_THRESHOLD = 90;

  const currentBPMRef = useRef(0);
  const confidenceRef = useRef(0);
  const signalQualityRef = useRef(0);

  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `hb_${t}_${p}`;
    processorRef.current = new HeartBeatProcessor();
    processingStateRef.current = 'ACTIVE';

    return () => {
      if (processorRef.current) {
        processorRef.current.dispose();
        processorRef.current = null;
      }
      processingStateRef.current = 'IDLE';
    };
  }, []);

  currentBPMRef.current = currentBPM;
  confidenceRef.current = confidence;
  signalQualityRef.current = signalQuality;

  const emptyResult = (bpm: number): HeartBeatResult => ({
    bpm, bpmConfidence: 0, isPeak: false,
    filteredValue: 0, arrhythmiaCount: 0, sqi: 0, beatSQI: 0,
    rrData: { intervals: [], lastPeakTime: null },
    hypothesis: null, detectorAgreement: 0,
    rejectionReason: '', beatFlags: null,
    debug: {
      instantBpm: 0, medianRRBpm: 0, autocorrBpm: 0, spectralBpm: 0,
      lastBeatSQI: 0, detectorAgreement: 0, expectedRR: 0,
      refractoryState: 'open', beatsAccepted: 0, beatsRejected: 0,
      lastRejectionReason: '', doublePeakCount: 0, missedBeatCount: 0,
      suspiciousCount: 0, templateCorrelation: 0, morphologyScore: 0,
      consecutivePeaks: 0,
    },
  });

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
      positionDrifting?: boolean;
    }
  ): HeartBeatResult => {
    if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
      return emptyResult(currentBPMRef.current);
    }

    const currentTime = timestamp ?? performance.now();

    if (contactState === 'NO_CONTACT') {
      noContactFramesRef.current += 1;
      if (noContactFramesRef.current >= NO_CONTACT_RESET_THRESHOLD) {
        processorRef.current.reset();
      }
      if (currentBPMRef.current !== 0) setCurrentBPM(0);
      if (confidenceRef.current !== 0) setConfidence(0);
      if (signalQualityRef.current !== 0) setSignalQuality(0);
      return emptyResult(0);
    }

    if (currentTime - lastProcessTimeRef.current < 12) {
      return emptyResult(currentBPMRef.current);
    }
    lastProcessTimeRef.current = currentTime;

    noContactFramesRef.current = 0;
    processedSignalsRef.current++;

    const result = processorRef.current.processSignal(value, timestamp, upstreamContext);
    const roundedSQI = Math.round(result.sqi);

    setSignalQuality(roundedSQI);

    // FORENSIC GATE #3 (morphology): only publish BPM if the last 4 accepted
    // beats are morphologically valid AND fused confidence is high enough.
    // 0.12 was noise-prone; 0.45 forces real, periodic, well-shaped beats.
    const recent = result.debug.recentAcceptedBeats || [];
    const last4 = recent.slice(-4);
    const morphologyOk =
      last4.length >= 4 &&
      last4.every(b => (b.morphologyScore || 0) >= 0.55 &&
                       (b.fiducials?.riseTimeMs ?? 0) >= 60 &&
                       (b.fiducials?.riseTimeMs ?? 9999) <= 350);
    const bpmOk = result.bpm > 0 && result.bpmConfidence >= 0.45 && morphologyOk;

    if (bpmOk) {
      setCurrentBPM(Math.round(result.bpm));
      setConfidence(result.bpmConfidence);
    } else if (result.bpmConfidence > 0) {
      setConfidence(result.bpmConfidence);
    }

    // Re-export the morphology verdict on the result so callers can use it
    // directly without re-deriving the rule.
    (result as any).pulseDetected = bpmOk;
    (result as any).pulseConfidence = bpmOk
      ? (result.bpmConfidence >= 0.7 ? 'HIGH' : result.bpmConfidence >= 0.55 ? 'MEDIUM' : 'LOW')
      : 'NONE';
    (result as any).morphologyGatePass = morphologyOk;

    return result;
  }, []);

  const reset = useCallback(() => {
    if (processingStateRef.current === 'RESETTING') return;
    processingStateRef.current = 'RESETTING';

    if (processorRef.current) processorRef.current.reset();

    setCurrentBPM(0);
    setConfidence(0);
    setSignalQuality(0);
    lastProcessTimeRef.current = 0;
    processedSignalsRef.current = 0;
    noContactFramesRef.current = 0;

    processingStateRef.current = 'ACTIVE';
  }, []);

  const setArrhythmiaState = useCallback((_isArrhythmiaDetected: boolean) => {}, []);

  const setFiducialParams = useCallback((patch: Partial<FiducialParams>) => {
    processorRef.current?.setFiducialParams(patch);
  }, []);

  const getFiducialParams = useCallback((): FiducialParams | null => {
    return processorRef.current?.getFiducialParams() ?? null;
  }, []);

  return {
    currentBPM,
    confidence,
    signalQuality,
    processSignal,
    reset,
    setArrhythmiaState,
    setFiducialParams,
    getFiducialParams,
    debugInfo: {
      sessionId: sessionIdRef.current,
      processingState: processingStateRef.current,
      processedSignals: processedSignalsRef.current,
    },
  };
};
