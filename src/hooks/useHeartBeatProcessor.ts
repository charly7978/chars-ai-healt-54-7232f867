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
      // Forense: triple-gate + evidencia óptica. SOLO con esto en true se
      // permiten beep, vibración y publicación de waveform/BPM.
      publicationGate?: boolean;
    }
  ): HeartBeatResult => {
    if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
      return emptyResult(currentBPMRef.current);
    }

    // Propaga la verdad de publicación al núcleo del beat processor para
    // que el feedback sensorial (beep + vibrate) NUNCA se dispare sin
    // evidencia óptica + 3 gates.
    processorRef.current.setPublicationGate(!!upstreamContext?.publicationGate);

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

    // FORENSIC GATE #3 (morphology): only authorise pulse if the last 4
    // accepted beats are morphologically valid AND the fused confidence is
    // high enough AND the inter-beat-interval is physiologically stable.
    // This is the gate that prevents the app from "finding a heart rate" in
    // pure noise or in weak optical signals.
    const recent = result.debug.recentAcceptedBeats || [];
    const last4 = recent.slice(-4);
    const morphologyShapesOk =
      last4.length >= 4 &&
      last4.every(b => {
        const morphology = (b.morphologyScore || 0);
        const rise = b.fiducials?.riseTimeMs;
        const validity = b.fiducials?.morphologyValidity;
        const detector = b.detectorAgreement || 0;
        // morphologyScore is on a 0..100 scale upstream — accept ≥35.
        const morphOk = morphology >= 35;
        // If fiducials were computable, demand human rise time + validity.
        // If not yet computed (rare on first 4 beats), don't reject for that.
        const riseOk = rise == null ? true : (rise >= 60 && rise <= 350);
        const validityOk = validity == null ? true : validity >= 0.30;
        const detectorOk = detector >= 0.5;
        return morphOk && riseOk && validityOk && detectorOk;
      });
    // RR stability: coefficient of variation of last 4 IBIs must be < 0.30
    // (real human pulse ≈ 0.02–0.15; pure noise is wildly higher).
    let rrStableOk = false;
    if (last4.length >= 4) {
      const ibis = last4.map(b => b.ibiMs).filter(v => v > 0);
      if (ibis.length >= 4) {
        const mean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
        const variance = ibis.reduce((s, v) => s + (v - mean) * (v - mean), 0) / ibis.length;
        const cv = mean > 0 ? Math.sqrt(variance) / mean : 9;
        rrStableOk = cv < 0.30 && mean >= 300 && mean <= 1800;
      }
    }
    const morphologyOk = morphologyShapesOk && rrStableOk;
    const bpmOk = result.bpm > 0 && result.bpmConfidence >= 0.40 && morphologyOk;

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
