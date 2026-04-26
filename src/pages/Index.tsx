import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, Brain, Loader2 } from "lucide-react";
import { playCompletionSound } from "@/utils/soundUtils";
import VitalSign from "@/components/VitalSign";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement } from "@/hooks/useSaveMeasurement";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { VitalSignsResult } from "@/modules/vital-signs/VitalSignsProcessor";
import { FiducialTuner, type FiducialTunerLiveStats } from "@/components/FiducialTuner";
import { SampleRateEstimator } from "@/modules/signal-processing/timing/SampleRateEstimator";
import { SRDiagnostics } from "@/components/SRDiagnostics";
import { toast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";
import ForensicGateOverlay, { type ForensicGateSnapshot } from "@/components/ForensicGateOverlay";

const NON_ALERT_RHYTHMS = new Set([
  'SIN ARRITMIAS',
  'SINUS_STABLE',
  'SINUS_VARIABLE',
  'CALIBRANDO...',
  'UNDETERMINED_LOW_QUALITY'
]);

// FORENSIC MODE: civil (clinical-style) vitals are hidden by default.
// They can be re-enabled with ?civil=1 (kept behind a flag, NOT clinical).
const CIVIL_MODE = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('civil') === '1';
// FORENSIC MODE: bypass the mandatory 60s auto-finalize (continuous monitoring).
const FORENSIC_MODE = !CIVIL_MODE;

const Index = () => {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [vitalSigns, setVitalSigns] = useState<VitalSignsResult>({
    spo2: 0,
    glucose: 0,
    pressure: { systolic: 0, diastolic: 0, confidence: 'INSUFFICIENT' as const, featureQuality: 0 },
    arrhythmiaCount: 0,
    arrhythmiaStatus: "SIN ARRITMIAS|0",
    lipids: { totalCholesterol: 0, triglycerides: 0 },
    isCalibrating: false,
    calibrationProgress: 0,
    lastArrhythmiaData: undefined,
    signalQuality: 0,
    measurementConfidence: 'INVALID'
  });
  const [heartRate, setHeartRate] = useState(0);
  const [heartbeatSignal, setHeartbeatSignal] = useState(0);
  const [beatMarker, setBeatMarker] = useState(0);
  const [arrhythmiaCount, setArrhythmiaCount] = useState<string | number>("--");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rrIntervals, setRRIntervals] = useState<number[]>([]);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [measurementSummary, setMeasurementSummary] = useState<{
    totalBeats: number;
    arrhythmiaBeats: number;
    normalPercent: number;
  } | null>(null);

  // ── Fiducial tuner (dev/research panel) ──────────────────────────────────
  // Toggle by triple-tapping the BPM card, or via ?tuner=1 URL flag.
  const [showFiducialTuner, setShowFiducialTuner] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("tuner") === "1";
  });
  // Independent toggle for the SR diagnostics panel: ?srDiag=1
  const [showSRDiag, setShowSRDiag] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("srDiag") === "1";
  });
  // Forensic gate overlay: visible by default in FORENSIC_MODE; can be forced
  // via ?forensic=1 or hidden via ?forensic=0 regardless of mode.
  const [showForensicOverlay] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const v = new URLSearchParams(window.location.search).get("forensic");
    if (v === "1") return true;
    if (v === "0") return false;
    return FORENSIC_MODE;
  });
  const [forensicGate, setForensicGate] = useState<ForensicGateSnapshot | null>(null);
  const [fiducialLive, setFiducialLive] = useState<FiducialTunerLiveStats>({
    morphologyScore: 0,
    morphologyValidity: 0,
    notchDepth: 0,
    riseTimeMs: 0,
    pulseWidth50Ms: 0,
    reflectionIndex: 0,
    beatsAnalyzed: 0,
  });
  const fiducialBeatsCountRef = useRef(0);

  const measurementTimerRef = useRef<number | null>(null);
  const totalBeatsRef = useRef(0);
  const arrhythmiaBeatsRef = useRef(0);
  const lastArrhythmiaCountForBeatsRef = useRef(0);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number; } | null>(null);
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const frameTimestampHistoryRef = useRef<number[]>([]);
  // Cached/last-trusted sample rate, used to keep delineation stable when
  // frame timestamps are momentarily missing, sparse or jittery.
  const cachedSampleRateRef = useRef<number>(30);
  const cachedSampleRateValidRef = useRef<boolean>(false);

  // Auto-calibrating SR estimator with stall detection.
  const srEstimatorRef = useRef<SampleRateEstimator>(new SampleRateEstimator());
  // Timestamp (ms, performance.now) when the current monitoring session started.
  const srCalibrationStartRef = useRef<number>(0);
  const srCalibrationDoneRef = useRef<boolean>(false);
  const SR_CALIBRATION_DURATION_MS = 4000; // ~4 s of timestamps to fingerprint jitter

  const EMA_ALPHA = 0.3;
  const emaRef = useRef({
    bpm: 0, spo2: 0, systolic: 0, diastolic: 0,
    glucose: 0, cholesterol: 0, triglycerides: 0,
  });

  const applyEMA = useCallback((prev: number, next: number): number => {
    if (next === 0) return 0;
    if (prev === 0) return next;
    return Math.round(prev * (1 - EMA_ALPHA) + next * EMA_ALPHA);
  }, []);

  const estimateSampleRateFromFrames = useCallback((timestamp?: number): number => {
    // Fallback: if no valid timestamp, use performance.now() so we still feed
    // a real monotonic clock instead of cold-starting at the default SR.
    const ts = (typeof timestamp === 'number' && isFinite(timestamp))
      ? timestamp
      : performance.now();

    const est = srEstimatorRef.current.push(ts, performance.now());

    // Auto-calibration: after ~4s of timestamps, derive a window/MAD that
    // matches the device's actual jitter and freeze the recommendation.
    if (!srCalibrationDoneRef.current) {
      if (srCalibrationStartRef.current === 0) {
        srCalibrationStartRef.current = performance.now();
      } else if (performance.now() - srCalibrationStartRef.current >= SR_CALIBRATION_DURATION_MS) {
        const cal = srEstimatorRef.current.applyCalibration();
        if (cal.acceptedSamples >= 8) {
          srCalibrationDoneRef.current = true;
        }
      }
    }

    // Mirror state into the legacy refs (other parts of Index still read them).
    cachedSampleRateRef.current = est.sampleRate;
    cachedSampleRateValidRef.current = est.valid;
    return est.sampleRate;
  }, []);

  const computeRRStability = useCallback((intervals: number[]): number => {
    if (!intervals || intervals.length < 3) return 0;
    const recent = intervals.slice(-8);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, rr) => sum + (rr - mean) ** 2, 0) / recent.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    return Math.max(0, Math.min(1, 1 - cv * 2));
  }, []);

  const { 
    startProcessing, 
    stopProcessing, 
    lastSignal, 
    processFrame, 
    isProcessing, 
    framesProcessed,
    getRGBStats,
    getPositionQuality,
    getMotionInfo,
    setMorphologyGate,
  } = useSignalProcessor();
  
  const { 
    processSignal: processHeartBeat, 
    setArrhythmiaState,
    reset: resetHeartBeat,
    setFiducialParams,
    getFiducialParams,
  } = useHeartBeatProcessor();
  
  const { 
    processSignal: processVitalSigns, 
    setRGBData,
    setUpstreamContext,
    reset: resetVitalSigns,
    fullReset: fullResetVitalSigns,
    hasValidPressureEstimate,
    lastValidResults,
    startCalibration,
    forceCalibrationCompletion,
    getCalibrationProgress
  } = useVitalSignsProcessor();
  
  const { saveMeasurement } = useSaveMeasurement();
  const { analysis, isAnalyzing, analyzeVitals, clearAnalysis } = useHealthAnalysis();
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 320;
      canvasRef.current.height = 240;
      ctxRef.current = canvasRef.current.getContext('2d', { 
        willReadFrequently: true,
        alpha: false 
      });
    }
  }, []);

  const enterFullScreen = async () => {
    if (isFullscreen) return;
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if ((docEl as any).webkitRequestFullscreen) {
        await (docEl as any).webkitRequestFullscreen();
      }
      if (screen.orientation?.lock) {
        await screen.orientation.lock('portrait').catch(() => {});
      }
      setIsFullscreen(true);
    } catch (err) {
      console.log('Error pantalla completa:', err);
    }
  };
  
  const exitFullScreen = () => {
    if (!isFullscreen) return;
    try {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
      screen.orientation?.unlock();
      setIsFullscreen(false);
    } catch {}
  };

  useEffect(() => {
    const timer = setTimeout(() => enterFullScreen(), 1000);
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const preventScroll = (e: Event) => e.preventDefault();
    document.body.addEventListener('touchmove', preventScroll, { passive: false });
    document.body.addEventListener('scroll', preventScroll, { passive: false });
    return () => {
      document.body.removeEventListener('touchmove', preventScroll);
      document.body.removeEventListener('scroll', preventScroll);
    };
  }, []);

  useEffect(() => {
    if (lastValidResults && !isMonitoring) {
      setVitalSigns(lastValidResults);
      setShowResults(true);
    }
  }, [lastValidResults, isMonitoring]);

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) {
      isProcessingRef.current = false;
      return;
    }

    const captureOneFrame = (nowOrMetadata?: number | any) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(() => captureOneFrame());
        return;
      }

      let frameTimestamp: number | undefined;
      if (typeof nowOrMetadata === 'object' && nowOrMetadata?.mediaTime != null) {
        frameTimestamp = performance.now();
      } else if (typeof nowOrMetadata === 'number') {
        frameTimestamp = nowOrMetadata;
      } else {
        frameTimestamp = performance.now();
      }

      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        processFrame(imageData, frameTimestamp);
      } catch {}
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current) return;
      if ('requestVideoFrameCallback' in video) {
        (video as any).requestVideoFrameCallback((now: number, metadata: any) => captureOneFrame(metadata?.presentationTime ?? now));
      } else {
        frameLoopRef.current = requestAnimationFrame(() => captureOneFrame(performance.now()));
      }
    };
    
    console.log('🎬 Capture started (rVFC with real timestamps)');
    captureOneFrame(performance.now());
  }, [processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, []);

  const startMonitoring = useCallback(() => {
    if (isMonitoring) return;
    console.log('🚀 Iniciando monitoreo...');
    if (navigator.vibrate) navigator.vibrate([200]);
    enterFullScreen();
    setShowResults(false);
    setMeasurementSummary(null);
    setElapsedTime(0);
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    frameTimestampHistoryRef.current = []; cachedSampleRateValidRef.current = false; cachedSampleRateRef.current = 30; srEstimatorRef.current.reset(); srCalibrationStartRef.current = 0; srCalibrationDoneRef.current = false;
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));
    startProcessing();
    setIsCameraOn(true);
    setIsMonitoring(true);
    if (measurementTimerRef.current) clearInterval(measurementTimerRef.current);
    measurementTimerRef.current = window.setInterval(() => setElapsedTime(prev => prev + 1), 1000);
    setIsCalibrating(true);
    startCalibration();
    // FORENSIC: skip the 3s "calibration" gate. Start reporting pulse from
    // the first morphology-validated beat. CIVIL keeps the legacy 3s window.
    if (FORENSIC_MODE) setIsCalibrating(false);
    else setTimeout(() => setIsCalibrating(false), 3000);
  }, [isMonitoring, startProcessing, startCalibration, enterFullScreen]);

  const handleStreamReady = useCallback((stream: MediaStream) => {
    console.log('📹 Stream recibido');
    setCameraStream(stream);
    setTimeout(() => {
      const video = cameraRef.current?.getVideoElement();
      if (video && video.readyState >= 2) {
        console.log('✅ Video listo:', video.videoWidth, 'x', video.videoHeight);
        startFrameLoop();
      } else {
        const checkReady = setInterval(() => {
          const v = cameraRef.current?.getVideoElement();
          if (v && v.readyState >= 2 && v.videoWidth > 0) {
            clearInterval(checkReady);
            console.log('✅ Video listo (retry):', v.videoWidth, 'x', v.videoHeight);
            startFrameLoop();
          }
        }, 100);
        setTimeout(() => clearInterval(checkReady), 5000);
      }
    }, 500);
  }, [startFrameLoop]);

  const finalizeMeasurement = useCallback(async () => {
    if (!isMonitoring) return;
    console.log('🛑 Finalizando medición...');
    playCompletionSound();
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);
    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }
    stopProcessing();
    if (isCalibrating) forceCalibrationCompletion();
    const savedResults = resetVitalSigns();
    if (savedResults || vitalSigns.spo2 > 0) {
      const dataToSave = savedResults || vitalSigns;
      await saveMeasurement({
        heartRate,
        vitalSigns: dataToSave,
        signalQuality: lastSignal?.quality || 0
      });
    }
    setIsCameraOn(false);
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setIsMonitoring(false);
    setIsCalibrating(false);
    frameTimestampHistoryRef.current = []; cachedSampleRateValidRef.current = false; cachedSampleRateRef.current = 30; srEstimatorRef.current.reset(); srCalibrationStartRef.current = 0; srCalibrationDoneRef.current = false;
    if (savedResults) setVitalSigns(savedResults);
    setShowResults(true);
    const total = totalBeatsRef.current;
    const arrBeats = arrhythmiaBeatsRef.current;
    setMeasurementSummary({
      totalBeats: total,
      arrhythmiaBeats: arrBeats,
      normalPercent: total > 0 ? Math.round(((total - arrBeats) / total) * 100) : 100
    });
    setElapsedTime(0);
    setCalibrationProgress(0);
    console.log('✅ Medición finalizada y guardada');
  }, [isMonitoring, isCalibrating, cameraStream, stopFrameLoop, stopProcessing, forceCalibrationCompletion, resetVitalSigns, saveMeasurement, heartRate, vitalSigns, lastSignal]);

  const handleReset = useCallback(() => {
    console.log('🔄 Reset completo...');
    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }
    stopProcessing();
    fullResetVitalSigns();
    resetHeartBeat();
    emaRef.current = { bpm: 0, spo2: 0, systolic: 0, diastolic: 0, glucose: 0, cholesterol: 0, triglycerides: 0 };
    frameTimestampHistoryRef.current = []; cachedSampleRateValidRef.current = false; cachedSampleRateRef.current = 30; srEstimatorRef.current.reset(); srCalibrationStartRef.current = 0; srCalibrationDoneRef.current = false;
    setIsCameraOn(false);
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setIsMonitoring(false);
    setShowResults(false);
    setMeasurementSummary(null);
    setIsCalibrating(false);
    setElapsedTime(0);
    setHeartRate(0);
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    unstableFrameCounter.current = 0;
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setRRIntervals([]);
    setVitalSigns({ 
      spo2: 0,
      glucose: 0,
      pressure: { systolic: 0, diastolic: 0, confidence: 'INSUFFICIENT' as const, featureQuality: 0 },
      arrhythmiaCount: 0,
      arrhythmiaStatus: "SIN ARRITMIAS|0",
      lipids: { totalCholesterol: 0, triglycerides: 0 },
      isCalibrating: false,
      calibrationProgress: 0,
      lastArrhythmiaData: undefined,
      signalQuality: 0,
      measurementConfidence: 'INVALID'
    });
    setArrhythmiaCount("--");
    lastArrhythmiaData.current = null;
    setCalibrationProgress(0);
    arrhythmiaDetectedRef.current = false;
    console.log('✅ Reset completado');
  }, [cameraStream, stopFrameLoop, stopProcessing, fullResetVitalSigns, resetHeartBeat]);

  const vitalSignsFrameCounter = useRef<number>(0);
  const unstableFrameCounter = useRef<number>(0);
  const UNSTABLE_ZERO_THRESHOLD = 15;
  const VITALS_PROCESS_EVERY_N_FRAMES = 3;
  
  useEffect(() => {
    if (!lastSignal || !isMonitoring) return;
    
    const signalValue = lastSignal.filteredValue;
    const contactState = (lastSignal as any).contactState || (lastSignal.fingerDetected ? 'OPTICAL_CONTACT_GOOD_PERFUSION' : 'NO_OPTICAL_CONTACT');
    const noOpticalContact = contactState === 'NO_OPTICAL_CONTACT' || contactState === 'NO_CONTACT';
    const goodPerfusion = contactState === 'OPTICAL_CONTACT_GOOD_PERFUSION' || contactState === 'STABLE_CONTACT';
    const positionQuality = getPositionQuality();
    const motionInfo = getMotionInfo();

    // ════════════════════════════════════════════════════════════
    //  FORENSIC TRIPLE GATE — single source of truth for the UI.
    //  If passAll is false → zero everything. No waveform, no BPM, no
    //  vitals. This is what physically prevents "measuring the air".
    // ════════════════════════════════════════════════════════════
    const fg = (lastSignal as any).forensicGate as
      | { passAll: boolean; gate1_optical: boolean; gate2_spectral: boolean; gate3_morphology: boolean; livenessReason: string; cardiacSNRdB: number; spectralPeakHz: number }
      | undefined;
    const forensicPass = !!fg?.passAll;

    // Mirror the gate snapshot into state so the overlay re-renders in sync
    // with each emitted signal frame (no extra timers, no hot-path cost).
    if (fg) {
      setForensicGate({
        gate1_optical: fg.gate1_optical,
        gate2_spectral: fg.gate2_spectral,
        gate3_morphology: fg.gate3_morphology,
        passAll: fg.passAll,
        cardiacSNRdB: fg.cardiacSNRdB,
        spectralPeakHz: fg.spectralPeakHz,
        spectralConcentration: (fg as any).spectralConcentration ?? 0,
        livenessReason: fg.livenessReason,
      });
    }

    // FORENSIC: a "stable human signal" is just optical contact + minimal
    // perfusion. We do NOT require GOOD perfusion (a victim in shock won't
    // have it) and we do NOT block on motion (operator may be moving).
    // What protects us against fake numbers is the upstream liveness gate:
    // if there is no hemoglobin signature → contactState === NO_OPTICAL_CONTACT
    // → we early-return below with everything zeroed.
    const stableHumanSignal = !noOpticalContact && (lastSignal.quality || 0) >= 6;

    if (noOpticalContact || !fg?.gate1_optical) {
      // Hard forensic zero — never invent waveforms or numbers from air.
      setHeartbeatSignal(0);
      setHeartRate(0);
      setBeatMarker(0);
      setRRIntervals([]);
      vitalSignsFrameCounter.current = 0;
      if (vitalSigns.spo2 !== 0 || vitalSigns.glucose !== 0 ||
          vitalSigns.pressure.systolic !== 0 || vitalSigns.pressure.diastolic !== 0) {
        setVitalSigns(prev => ({
          ...prev,
          spo2: 0, glucose: 0,
          pressure: { systolic: 0, diastolic: 0, confidence: 'INSUFFICIENT' as const, featureQuality: 0 },
          arrhythmiaCount: 0, arrhythmiaStatus: "SIN ARRITMIAS|0",
          lipids: { totalCholesterol: 0, triglycerides: 0 },
          lastArrhythmiaData: undefined,
          signalQuality: 0,
          measurementConfidence: 'INVALID',
        }));
      }
      return;
    }

    const pressureOptimal = goodPerfusion && positionQuality.locked && !positionQuality.drifting && positionQuality.qualityScore >= 0.55;
    const sourceStability = Math.max(0, Math.min(1, positionQuality.qualityScore || 0));
    const sampleRate = estimateSampleRateFromFrames(lastSignal.timestamp);

    const heartBeatResult = processHeartBeat(
      signalValue,
      contactState,
      lastSignal.timestamp,
      {
        quality: lastSignal.quality,
        contactState,
        motionArtifact: lastSignal.motionArtifact || motionInfo.motionArtifact,
        pressureState: pressureOptimal ? 'OPTIMAL_PRESSURE' : 'LOW_PRESSURE',
        clipHigh: 0,
        clipLow: 0,
        perfusionIndex: lastSignal.perfusionIndex,
        positionDrifting: positionQuality.drifting,
      }
    );

    // Gate #2 (spectral) must be open for the waveform to be drawn at all.
    setHeartbeatSignal(forensicPass ? heartBeatResult.filteredValue : 0);

    // Push Gate #3 (morphology) verdict back into the processor so the next
    // emitted signal frame carries the truthful triple-gate state.
    const morphPass = !!(heartBeatResult as any).morphologyGatePass;
    // Typed feedback path through the signal-processor hook — no globals.
    setMorphologyGate(morphPass, morphPass ? 'OK' : 'MORFOLOGÍA INSUFICIENTE');

    if (!forensicPass) {
      unstableFrameCounter.current++;
      if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD) {
        setHeartRate(0);
        vitalSignsFrameCounter.current = 0;
        setBeatMarker(0);
        setRRIntervals([]);
        setArrhythmiaCount("--");
        if (arrhythmiaDetectedRef.current) {
          arrhythmiaDetectedRef.current = false;
          setArrhythmiaState(false);
        }
        setVitalSigns(prev => (
          prev.measurementConfidence === 'INVALID' && prev.spo2 === 0 && prev.glucose === 0 && prev.pressure.systolic === 0 && prev.pressure.diastolic === 0
            ? prev
            : {
                ...prev,
                spo2: 0,
                glucose: 0,
                pressure: { systolic: 0, diastolic: 0, confidence: 'INSUFFICIENT' as const, featureQuality: 0 },
                arrhythmiaCount: 0,
                arrhythmiaStatus: "SIN ARRITMIAS|0",
                lipids: { totalCholesterol: 0, triglycerides: 0 },
                lastArrhythmiaData: undefined,
                signalQuality: 0,
                measurementConfidence: 'INVALID'
              }
        ));
      }
      return;
    }

    unstableFrameCounter.current = 0;
    // FORENSIC: report the real instantaneous BPM (no EMA), but only when
    // the heartbeat processor has enough morphology-validated confidence.
    // Otherwise keep showing 0 → "BUSCANDO PULSO".
    const forensicBpmOk = heartBeatResult.bpm > 0 && heartBeatResult.bpmConfidence >= 0.30;
    if (forensicBpmOk) {
      setHeartRate(Math.round(heartBeatResult.bpm));
      emaRef.current.bpm = heartBeatResult.bpm;
    } else if (!goodPerfusion) {
      // In low-perfusion mode, don't display stale BPM either.
      setHeartRate(0);
    }

    if (heartBeatResult.isPeak) {
      setBeatMarker(1);
      setTimeout(() => setBeatMarker(0), 300);
      totalBeatsRef.current++;
      const currentArrCount = vitalSigns.arrhythmiaCount || 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }
    }

    if (heartBeatResult.rrData?.intervals) {
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    vitalSignsFrameCounter.current++;

    // FORENSIC: only run civil vitals (SpO2/BP/glucose/lipids) when explicitly
    // enabled via ?civil=1. By default the forensic operator only sees pulse.
    if (CIVIL_MODE && vitalSignsFrameCounter.current >= VITALS_PROCESS_EVERY_N_FRAMES) {
      vitalSignsFrameCounter.current = 0;
      const rgbStats = getRGBStats();
      const detectorAgreement = heartBeatResult.detectorAgreement || heartBeatResult.debug.detectorAgreement || 0;
      const rrStability = computeRRStability(heartBeatResult.rrData?.intervals || []);
      const beatInputs = heartBeatResult.debug.recentAcceptedBeats && heartBeatResult.debug.recentAcceptedBeats.length > 0
        ? heartBeatResult.debug.recentAcceptedBeats.slice(-12).map((beat) => ({
            ibiMs: beat.ibiMs,
            beatSQI: beat.beatSQI,
            morphologyScore: beat.morphologyScore,
            detectorAgreement: beat.detectorAgreement,
            amplitude: beat.amplitude,
            flags: {
              isWeak: beat.flags.isWeak,
              isPremature: beat.flags.isPremature,
              isSuspicious: beat.flags.isSuspicious,
              isDoublePeak: beat.flags.isDoublePeak,
            }
          }))
        : undefined;

      // Live tuner stats: pick the most recent beat that has fiducials
      // attached. Updates immediately when params change because morphology
      // boost is recomputed on the next pending fiducial evaluation.
      if (showFiducialTuner) {
        const accepted = heartBeatResult.debug.recentAcceptedBeats;
        if (accepted && accepted.length > 0) {
          for (let i = accepted.length - 1; i >= 0; i--) {
            const b: any = accepted[i];
            if (b.fiducials) {
              fiducialBeatsCountRef.current = accepted.length;
              setFiducialLive({
                morphologyScore: b.morphologyScore || 0,
                morphologyValidity: b.fiducials.morphologyValidity || 0,
                notchDepth: b.fiducials.notchDepth || 0,
                riseTimeMs: b.fiducials.riseTimeMs || 0,
                pulseWidth50Ms: b.fiducials.pulseWidth50Ms || 0,
                reflectionIndex: b.fiducials.reflectionIndex || 0,
                beatsAnalyzed: accepted.length,
              });
              break;
            }
          }
        }
      }

      setUpstreamContext({
        contactStable: stableHumanSignal,
        pressureOptimal,
        clipHighRatio: (lastSignal as any).clipHighRatio ?? 0,
        sourceStability,
        avgBeatSQI: heartBeatResult.beatSQI || heartBeatResult.debug.lastBeatSQI || 0,
        beatCount: heartBeatResult.debug.beatsAccepted || heartBeatResult.rrData?.intervals.length || 0,
        sampleRate,
        detectorAgreement,
        rrStability,
        motionScore: motionInfo.motionScore,
        motionArtifact: motionInfo.motionArtifact,
      });

      if (rgbStats.redDC > 0 && rgbStats.greenDC > 0) {
        setRGBData({
          redAC: rgbStats.redAC,
          redDC: rgbStats.redDC,
          greenAC: rgbStats.greenAC,
          greenDC: rgbStats.greenDC
        });
      }

      const usableRRData = heartBeatResult.rrData && heartBeatResult.rrData.intervals.length >= 2 && heartBeatResult.bpmConfidence > 0.18
        ? heartBeatResult.rrData
        : undefined;

      const vitals = processVitalSigns(lastSignal.filteredValue, usableRRData, beatInputs);

      const e = emaRef.current;
      const smoothed: typeof vitals = {
        ...vitals,
        spo2: applyEMA(e.spo2, vitals.spo2),
        glucose: applyEMA(e.glucose, vitals.glucose),
        pressure: {
          ...vitals.pressure,
          systolic: applyEMA(e.systolic, vitals.pressure.systolic),
          diastolic: applyEMA(e.diastolic, vitals.pressure.diastolic),
        },
        lipids: {
          totalCholesterol: applyEMA(e.cholesterol, vitals.lipids.totalCholesterol),
          triglycerides: applyEMA(e.triglycerides, vitals.lipids.triglycerides),
        },
      };
      e.spo2 = smoothed.spo2;
      e.glucose = smoothed.glucose;
      e.systolic = smoothed.pressure.systolic;
      e.diastolic = smoothed.pressure.diastolic;
      e.cholesterol = smoothed.lipids.totalCholesterol;
      e.triglycerides = smoothed.lipids.triglycerides;

      setVitalSigns(smoothed);

      if (usableRRData && vitals.measurementConfidence !== 'INVALID') {
        const arrhythmiaStatus = vitals.arrhythmiaStatus;
        if (arrhythmiaStatus) {
          lastArrhythmiaData.current = vitals.lastArrhythmiaData || null;
          const parts = arrhythmiaStatus.split('|');
          const rhythmLabel = vitals.rhythm?.label || parts[0] || 'SIN ARRITMIAS';
          const count = parseInt(parts[1] || '0', 10) || 0;
          setArrhythmiaCount(count > 0 ? count : rhythmLabel.split('_').join(' '));

          const isArrhythmiaDetected = !NON_ALERT_RHYTHMS.has(rhythmLabel);
          if (isArrhythmiaDetected !== arrhythmiaDetectedRef.current) {
            arrhythmiaDetectedRef.current = isArrhythmiaDetected;
            setArrhythmiaState(isArrhythmiaDetected);

            if (isArrhythmiaDetected) {
              if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
              toast({
                title: `⚠️ ${rhythmLabel.split('_').join(' ')}`,
                description: count > 0 ? `Eventos detectados: ${count}` : 'Ritmo irregular detectado',
                variant: "destructive",
                duration: 4000
              });
            }
          }
        }
      }
    }
  }, [lastSignal, isMonitoring, processHeartBeat, processVitalSigns, setArrhythmiaState, setRGBData, setUpstreamContext, getRGBStats, getPositionQuality, getMotionInfo, estimateSampleRateFromFrames, computeRRStability, applyEMA, vitalSigns.arrhythmiaCount, showFiducialTuner]);

  useEffect(() => {
    // FORENSIC MODE: continuous monitoring — never auto-finalize.
    if (CIVIL_MODE && isMonitoring && elapsedTime >= 60) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  useEffect(() => {
    if (!isCalibrating) return;
    const interval = setInterval(() => {
      const currentProgress = getCalibrationProgress();
      setCalibrationProgress(currentProgress);
      if (currentProgress >= 100) {
        clearInterval(interval);
        setIsCalibrating(false);
        if (navigator.vibrate) navigator.vibrate([100]);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isCalibrating, getCalibrationProgress]);

  const handleToggleMonitoring = () => {
    if (isMonitoring) finalizeMeasurement();
    else startMonitoring();
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ 
      height: '100svh',
      width: '100vw',
      maxWidth: '100vw',
      maxHeight: '100svh',
      overflow: 'hidden',
      touchAction: 'none',
      userSelect: 'none',
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none'
    }}>
      {!isFullscreen && (
        <button onClick={enterFullScreen} className="fixed inset-0 z-50 w-full h-full flex items-center justify-center bg-black/90 text-white">
          <div className="text-center p-4 bg-primary/20 rounded-lg backdrop-blur-sm">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5m11 5v-4m0 4h-4m4 0l-5-5" />
            </svg>
            <p className="text-lg font-semibold">Toca para modo pantalla completa</p>
          </div>
        </button>
      )}

      <div className="flex-1 relative">
        <div className="absolute inset-0">
          <CameraView ref={cameraRef} onStreamReady={handleStreamReady} isMonitoring={isCameraOn} />
        </div>

        <ForensicGateOverlay gate={forensicGate} visible={showForensicOverlay && isMonitoring} />

        {isMonitoring && (() => {
          const pq = getPositionQuality();
          const isDrifting = pq.drifting;
          const isLocked = pq.locked && !isDrifting;
          const showGuidance = !isLocked || isDrifting;
          return showGuidance || isLocked ? (
            <div className="absolute top-1 left-0 right-0 z-20 flex justify-center pointer-events-none">
              <div className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wider shadow-lg backdrop-blur-md border ${
                isLocked ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' :
                isDrifting ? 'bg-red-500/20 border-red-500/40 text-red-300 animate-pulse' :
                pq.qualityScore > 0.4 ? 'bg-amber-500/20 border-amber-500/40 text-amber-300' :
                'bg-red-500/20 border-red-500/40 text-red-300'
              }`}>
                <span className="flex items-center gap-1.5">
                  {isLocked ? <Shield className="w-3 h-3" /> : isDrifting ? <AlertTriangle className="w-3 h-3" /> : <Activity className="w-3 h-3 animate-pulse" />}
                  {pq.guidance}
                </span>
              </div>
            </div>
          ) : null;
        })()}

        <div className="relative z-10 h-full">
          <div className="flex-1 h-full">
            <PPGSignalMeter 
              value={heartbeatSignal}
              quality={lastSignal?.quality || 0}
              isFingerDetected={lastSignal?.fingerDetected || false}
              onStartMeasurement={handleToggleMonitoring}
              onReset={handleReset}
              isMonitoring={isMonitoring}
              arrhythmiaStatus={vitalSigns.arrhythmiaStatus}
              rawArrhythmiaData={lastArrhythmiaData.current}
              preserveResults={showResults}
              diagnosticMessage={lastSignal?.diagnostics?.message}
              isPeak={beatMarker === 1}
              bpm={heartRate}
              spo2={vitalSigns.spo2}
              rrIntervals={rrIntervals}
            />
          </div>

          {/* ════════════════════════════════════════════════════════════
              FORENSIC PULSE PANEL — the only thing the operator sees by
              default. Shows: PULSO DETECTADO / SIN PULSO + BPM + PI.
              No SpO2/BP/glucose/lipids unless ?civil=1 is passed.
              ════════════════════════════════════════════════════════════ */}
          {(() => {
            const cs: string = (lastSignal as any)?.contactState || 'NO_OPTICAL_CONTACT';
            const noOptical = cs === 'NO_OPTICAL_CONTACT' || cs === 'NO_CONTACT';
            const pulsePresent = isMonitoring && !noOptical && heartRate > 0;
            const pi = lastSignal?.perfusionIndex || 0;
            return (
              <div className="absolute inset-x-0 top-[55%] bottom-[60px] px-3 py-4 flex flex-col items-center justify-start gap-3 pointer-events-none">
                {/* Forensic banner — always visible while monitoring */}
                {isMonitoring && (
                  <div className="px-3 py-1 rounded-md bg-slate-900/80 border border-slate-700 text-[10px] text-slate-300 tracking-wider text-center max-w-[95%]">
                    MODO FORENSE — DETECTOR DE PULSO PPG. NO MIDE SPO₂ / PRESIÓN / GLUCOSA / LÍPIDOS.
                  </div>
                )}
                <div className={`w-[92%] rounded-xl px-4 py-3 border-2 backdrop-blur-sm ${
                  pulsePresent
                    ? 'bg-emerald-500/10 border-emerald-400 shadow-[0_0_24px_rgba(16,185,129,0.35)]'
                    : 'bg-red-500/10 border-red-400'
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className={`text-xs font-bold tracking-widest ${pulsePresent ? 'text-emerald-300' : 'text-red-300'}`}>
                        {pulsePresent ? '● PULSO DETECTADO' : '○ SIN PULSO'}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {noOptical
                          ? (lastSignal?.diagnostics?.message || 'SIN CONTACTO ÓPTICO')
                          : (cs === 'OPTICAL_CONTACT_LOW_PERFUSION' ? 'CONTACTO — BAJA PERFUSIÓN' : 'CONTACTO ESTABLE')}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`text-3xl font-bold leading-none ${pulsePresent ? 'text-emerald-300' : 'text-slate-500'}`}>
                        {heartRate > 0 ? Math.round(heartRate) : '--'}
                      </div>
                      <div className="text-[9px] text-slate-400 tracking-wider mt-0.5">BPM</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-slate-700/50">
                    <div className="flex-1">
                      <div className="text-[8px] text-slate-500 tracking-wider">ÍNDICE DE PERFUSIÓN</div>
                      <div className="text-sm font-mono text-slate-200">{pi > 0 ? pi.toFixed(2) : '--'}</div>
                    </div>
                    <div className="flex-1">
                      <div className="text-[8px] text-slate-500 tracking-wider">CALIDAD SEÑAL</div>
                      <div className="text-sm font-mono text-slate-200">{lastSignal?.quality ? Math.round(lastSignal.quality) : '--'}</div>
                    </div>
                    <div className="flex-1">
                      <div className="text-[8px] text-slate-500 tracking-wider">TIEMPO</div>
                      <div className="text-sm font-mono text-slate-200">{Math.floor(elapsedTime / 60)}:{String(elapsedTime % 60).padStart(2, '0')}</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* CIVIL MODE — legacy clinical-style vitals (research only). */}
          {CIVIL_MODE && (
          <div className="absolute inset-x-0 top-[70%] bottom-[60px] bg-black/10 px-4 py-3">
            <div className="text-[9px] text-amber-400 mb-1 tracking-widest text-center">⚠ CIVIL — ESTIMACIONES NO CLÍNICAS</div>
            <div className="grid grid-cols-3 gap-2 place-items-center">
              <VitalSign label="FRECUENCIA CARDÍACA" value={heartRate > 0 ? Math.round(heartRate) : "--"} unit="BPM" highlighted={showResults} />
              <VitalSign label="SPO2" value={vitalSigns.spo2 > 0 ? vitalSigns.spo2 : "--"} unit="%" highlighted={showResults} />
              <VitalSign 
                label="PRESIÓN ARTERIAL"
                value={vitalSigns.pressure && vitalSigns.pressure.systolic > 0 ? `${vitalSigns.pressure.systolic}/${vitalSigns.pressure.diastolic}` : "--/--"}
                unit="mmHg"
                highlighted={showResults}
                confidenceLevel={vitalSigns.pressure?.confidence}
                featureQuality={vitalSigns.pressure?.featureQuality}
              />
              <VitalSign label="GLUCOSA (EST.)" value={vitalSigns.glucose > 0 ? vitalSigns.glucose : "--"} unit="mg/dL" highlighted={showResults} />
              <VitalSign 
                label="COLEST./TRIGL. (EST.)"
                value={vitalSigns.lipids?.totalCholesterol > 0 || vitalSigns.lipids?.triglycerides > 0 ? `${vitalSigns.lipids?.totalCholesterol || "--"}/${vitalSigns.lipids?.triglycerides || "--"}` : "--/--"}
                unit="mg/dL"
                highlighted={showResults}
              />
              <VitalSign label="ARRITMIAS" value={vitalSigns.arrhythmiaStatus || "SIN ARRITMIAS|0"} highlighted={showResults} />
            </div>
          </div>
          )}

          {showResults && measurementSummary && (() => {
            const { totalBeats, arrhythmiaBeats, normalPercent } = measurementSummary;
            const normalBeats = totalBeats - arrhythmiaBeats;
            const avgBpm = heartRate > 0 ? Math.round(heartRate) : '--';
            const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
            const statusText = vitalSigns.rhythm?.label ? vitalSigns.rhythm.label.split('_').join(' ') : (normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA');
            const statusIcon = normalPercent >= 95 ? CheckCircle2 : AlertTriangle;
            const StatusIcon = statusIcon;
            
            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
                <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-sm w-[92%] shadow-2xl overflow-hidden">
                  <div className={`px-4 py-3 bg-${statusColor}-500/10 border-b border-slate-800`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={`w-5 h-5 text-${statusColor}-400`} />
                        <div>
                          <h3 className="text-white text-sm font-bold tracking-wide">MEDICIÓN COMPLETADA</h3>
                          <p className={`text-${statusColor}-400 text-[10px] font-semibold tracking-wider`}>{statusText}</p>
                        </div>
                      </div>
                      <button onClick={() => setMeasurementSummary(null)} className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors">
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  <div className="p-4 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-slate-900/80 rounded-xl p-3 text-center border border-slate-800/50">
                        <Heart className="w-4 h-4 text-red-400 mx-auto mb-1" fill="currentColor" />
                        <div className="text-white text-2xl font-bold leading-none">{avgBpm}</div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">BPM PROMEDIO</div>
                      </div>
                      <div className="bg-slate-900/80 rounded-xl p-3 text-center border border-slate-800/50">
                        <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                        <div className="text-white text-2xl font-bold leading-none">
                          {vitalSigns.spo2 > 0 ? vitalSigns.spo2 : '--'}
                          <span className="text-sm text-slate-400">%</span>
                        </div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">SpO₂</div>
                      </div>
                    </div>

                    {vitalSigns.pressure?.systolic > 0 && (
                      <div className="bg-slate-900/80 rounded-xl p-3 border border-slate-800/50 flex items-center gap-3">
                        <Shield className="w-5 h-5 text-blue-400" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <div className="text-slate-500 text-[9px] font-medium">PRESIÓN ARTERIAL</div>
                            {vitalSigns.pressure.confidence && vitalSigns.pressure.confidence !== 'INSUFFICIENT' && (
                              <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${
                                vitalSigns.pressure.confidence === 'HIGH' ? 'bg-emerald-500/20 text-emerald-400' :
                                vitalSigns.pressure.confidence === 'MEDIUM' ? 'bg-yellow-500/20 text-yellow-400' :
                                'bg-orange-500/20 text-orange-400'
                              }`}>
                                {vitalSigns.pressure.confidence}
                              </span>
                            )}
                          </div>
                          <div className="text-white text-lg font-bold">
                            {vitalSigns.pressure.systolic}/{vitalSigns.pressure.diastolic}
                            <span className="text-xs text-slate-500 ml-1">mmHg</span>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="bg-slate-900/80 rounded-xl p-3 border border-slate-800/50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-slate-400 text-[10px] font-semibold tracking-wide">ANÁLISIS DE RITMO</span>
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span className="text-slate-500 text-[9px]">30s</span>
                        </div>
                      </div>
                      <div className="mb-2">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-emerald-400 text-[9px] font-medium">■ Normales</span>
                          <span className="text-white text-xs font-bold">{normalBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-1000 ease-out" style={{ width: `${totalBeats > 0 ? (normalBeats / totalBeats) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-red-400 text-[9px] font-medium">■ Arrítmicos</span>
                          <span className="text-white text-xs font-bold">{arrhythmiaBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-red-600 to-red-400' : 'bg-slate-700'}`} style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-center gap-4 pt-1">
                      <div className="relative w-16 h-16">
                        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#1e293b" strokeWidth="3" />
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" className={`${statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400'}`} strokeWidth="3" strokeDasharray={`${normalPercent}, 100`} strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className={`text-sm font-bold ${statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400'}`}>{normalPercent}%</span>
                        </div>
                      </div>
                      <div>
                        <div className="text-white text-xs font-semibold">Ritmo Normal</div>
                        <div className="text-slate-500 text-[9px]">{totalBeats} latidos analizados</div>
                        <div className={`text-[10px] font-semibold mt-0.5 ${statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400'}`}>{statusText}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        analyzeVitals({ heartRate, vitalSigns, quality: lastSignal?.quality || 0 });
                        setShowAIAnalysis(true);
                      }}
                      disabled={isAnalyzing}
                      className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-sm transition-all disabled:opacity-50"
                    >
                      {isAnalyzing ? <><Loader2 className="w-4 h-4 animate-spin" /> Analizando...</> : <><Brain className="w-4 h-4" /> Análisis AI de Salud</>}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {showAIAnalysis && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
              <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-sm w-[92%] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-purple-500/10 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <h3 className="text-white text-sm font-bold">Análisis AI de Salud</h3>
                  </div>
                  <button onClick={() => { setShowAIAnalysis(false); clearAnalysis(); }} className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors">
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {isAnalyzing ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                      <p className="text-slate-400 text-sm">Analizando tus signos vitales...</p>
                    </div>
                  ) : analysis ? (
                    <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">{analysis}</div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <p className="text-slate-500 text-sm">No se pudo generar el análisis.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hidden long-press toggle in the corner — opens the fiducial tuner. */}
      <button
        aria-label="Open fiducial tuner"
        onClick={() => setShowFiducialTuner(v => !v)}
        className="fixed bottom-1 left-1 z-40 w-6 h-6 rounded-full bg-muted/40 hover:bg-muted text-[10px] text-muted-foreground"
      >·</button>

      <FiducialTuner
        open={showFiducialTuner}
        onClose={() => setShowFiducialTuner(false)}
        getParams={getFiducialParams}
        setParams={setFiducialParams}
        liveStats={fiducialLive}
      />

      {/* SR diagnostics — shown when the fiducial tuner is open OR when the
          ?srDiag=1 URL flag is active (independent from the tuner). */}
      <SRDiagnostics
        estimator={srEstimatorRef.current}
        hidden={!showFiducialTuner && !showSRDiag}
      />
    </div>
  );
};

export default Index;
