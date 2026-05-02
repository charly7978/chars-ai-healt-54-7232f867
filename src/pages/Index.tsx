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
import { toast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  ForensicSessionRecorder,
  downloadForensicBundle,
} from "@/modules/forensic/ForensicSessionRecorder";

const NON_ALERT_RHYTHMS = new Set([
  'SIN ARRITMIAS',
  'SINUS_STABLE',
  'SINUS_VARIABLE',
  'CALIBRANDO...',
  'UNDETERMINED_LOW_QUALITY'
]);

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

  const measurementTimerRef = useRef<number | null>(null);
  const totalBeatsRef = useRef(0);
  const arrhythmiaBeatsRef = useRef(0);
  const lastArrhythmiaCountForBeatsRef = useRef(0);
  // ── Forensic session recorder (instantiated per session) ─────────────
  const recorderRef = useRef<ForensicSessionRecorder | null>(null);
  const [recorderTick, setRecorderTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [lastSeal, setLastSeal] = useState<{ sha: string; sessionId: string } | null>(null);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const lastTelemetryTapRef = useRef<number>(0);
  const [telemetryTick, setTelemetryTick] = useState(0);
  // ── ROI stability persistent-alert state ──────────────────────────────
  // Counts CONSECUTIVE accepted beats whose ROI stability score fell below
  // ROI_STABILITY_THRESHOLD. When the streak reaches ROI_STABILITY_BEATS_N
  // a persistent on-screen alert is raised and an audit entry is logged
  // into the telemetry ring buffer for later forensic review.
  const ROI_STABILITY_THRESHOLD = 0.55;       // [0..1] — below = "low"
  const ROI_STABILITY_BEATS_N = 5;            // consecutive beats to trigger
  const ROI_STABILITY_RECOVER_BEATS = 3;      // consecutive good beats to clear
  const ROI_AUDIT_LOG_MAX = 64;
  const lowStabilityStreakRef = useRef(0);
  const goodStabilityStreakRef = useRef(0);
  const lastBeatRoiScoreRef = useRef(1);
  const lastBeatDriftRef = useRef(0);
  const [roiAlertActive, setRoiAlertActive] = useState(false);
  const roiAuditLogRef = useRef<Array<{
    t: number;             // performance.now() at trigger/clear
    kind: 'TRIGGER' | 'CLEAR' | 'SAMPLE';
    roiScore: number;      // [0..1]
    drift: number;         // [0..1+]
    streak: number;        // streak length at the moment of the entry
    beatIndex: number;     // totalBeatsRef snapshot
  }>>([]);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number; } | null>(null);
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const frameTimestampHistoryRef = useRef<number[]>([]);

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
    if (!timestamp || !isFinite(timestamp)) return 30;
    const history = frameTimestampHistoryRef.current;
    if (history.length === 0 || timestamp > history[history.length - 1]) {
      history.push(timestamp);
      if (history.length > 24) history.shift();
    }
    if (history.length < 6) return 30;
    const deltas: number[] = [];
    for (let i = 1; i < history.length; i++) {
      const d = history[i] - history[i - 1];
      if (d >= 8 && d <= 120) deltas.push(d);
    }
    if (deltas.length < 4) return 30;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    return Math.max(15, Math.min(60, 1000 / Math.max(1, median)));
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
    getDebugInfo,
    getDroppedFrames,
  } = useSignalProcessor();
  
  const { 
    processSignal: processHeartBeat, 
    setArrhythmiaState,
    reset: resetHeartBeat,
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
    frameTimestampHistoryRef.current = [];
    lowStabilityStreakRef.current = 0;
    goodStabilityStreakRef.current = 0;
    lastBeatRoiScoreRef.current = 1;
    lastBeatDriftRef.current = 0;
    roiAuditLogRef.current = [];
    setRoiAlertActive(false);
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));
    // Spin up a fresh forensic recorder for this session.
    recorderRef.current = new ForensicSessionRecorder({ algorithmVersion: 'ppg-web/2026.05' });
    setLastSeal(null);
    startProcessing();
    setIsCameraOn(true);
    setIsMonitoring(true);
    if (measurementTimerRef.current) clearInterval(measurementTimerRef.current);
    measurementTimerRef.current = window.setInterval(() => setElapsedTime(prev => prev + 1), 1000);
    setIsCalibrating(true);
    startCalibration();
    setTimeout(() => setIsCalibrating(false), 3000);
  }, [isMonitoring, startProcessing, startCalibration, enterFullScreen]);

  const handleStreamReady = useCallback((stream: MediaStream) => {
    console.log('📹 Stream recibido');
    setCameraStream(stream);
    setTimeout(() => {
      const video = cameraRef.current?.getVideoElement();
      if (video && video.readyState >= 2) {
        console.log('✅ Video listo:', video.videoWidth, 'x', video.videoHeight);
        const diag = cameraRef.current?.getDiagnostics();
        if (diag && recorderRef.current) {
          recorderRef.current.attachCameraSnapshot({
            deviceLabel: diag.deviceLabel,
            cameraId: null,
            hasTorch: diag.hasTorch,
            torchActive: diag.torchActive,
            resolution: diag.resolution,
            realFrameRate: diag.realFrameRate,
            exposureLocked: diag.exposureLocked,
            wbLocked: diag.wbLocked,
            focusLocked: diag.focusLocked,
            isoValue: diag.isoValue,
            supportedConstraints: diag.supportedConstraints,
          });
        }
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
    frameTimestampHistoryRef.current = [];
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
    frameTimestampHistoryRef.current = [];
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
    lowStabilityStreakRef.current = 0;
    goodStabilityStreakRef.current = 0;
    lastBeatRoiScoreRef.current = 1;
    lastBeatDriftRef.current = 0;
    roiAuditLogRef.current = [];
    setRoiAlertActive(false);
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
    const contactState = (lastSignal as any).contactState || (lastSignal.fingerDetected ? 'STABLE_CONTACT' : 'NO_CONTACT');
    const positionQuality = getPositionQuality();
    const stableHumanSignal =
      contactState === 'STABLE_CONTACT' &&
      (lastSignal.quality || 0) >= 12 &&
      (lastSignal.perfusionIndex || 0) >= 0.005;

    const pressureOptimal = positionQuality.locked && !positionQuality.drifting && positionQuality.qualityScore >= 0.55;
    const sourceStability = Math.max(0, Math.min(1, positionQuality.qualityScore || 0));
    const sampleRate = estimateSampleRateFromFrames(lastSignal.timestamp);

    const heartBeatResult = processHeartBeat(
      signalValue,
      contactState,
      lastSignal.timestamp,
      {
        quality: lastSignal.quality,
        contactState,
        motionArtifact: lastSignal.motionArtifact,
        pressureState: pressureOptimal ? 'OPTIMAL_PRESSURE' : 'LOW_PRESSURE',
        clipHigh: 0,
        clipLow: 0,
        perfusionIndex: lastSignal.perfusionIndex,
        positionDrifting: positionQuality.drifting,
      }
    );

    setHeartbeatSignal(stableHumanSignal ? heartBeatResult.filteredValue : 0);

    if (!stableHumanSignal) {
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
    const smoothedBPM = applyEMA(emaRef.current.bpm, heartBeatResult.bpm);
    emaRef.current.bpm = smoothedBPM;
    setHeartRate(smoothedBPM);

    if (heartBeatResult.isPeak) {
      setBeatMarker(1);
      setTimeout(() => setBeatMarker(0), 300);
      totalBeatsRef.current++;
      const currentArrCount = vitalSigns.arrhythmiaCount || 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }

      // ── Per-beat ROI stability sampling ────────────────────────────
      // Re-uses the same formula as the HUD to keep one source of truth.
      const driftPenaltyBeat = Math.min(1, Math.max(0, (positionQuality.positionDrift || 0) / 0.30));
      const roiScoreBeat = Math.max(0, Math.min(1,
        (positionQuality.qualityScore || 0) * 0.7 +
        (positionQuality.locked ? 0.3 : 0) -
        driftPenaltyBeat * 0.4
      ));
      lastBeatRoiScoreRef.current = roiScoreBeat;
      lastBeatDriftRef.current = positionQuality.positionDrift || 0;

      if (roiScoreBeat < ROI_STABILITY_THRESHOLD) {
        lowStabilityStreakRef.current++;
        goodStabilityStreakRef.current = 0;
        if (
          !roiAlertActive &&
          lowStabilityStreakRef.current >= ROI_STABILITY_BEATS_N
        ) {
          setRoiAlertActive(true);
          const entry = {
            t: performance.now(),
            kind: 'TRIGGER' as const,
            roiScore: roiScoreBeat,
            drift: positionQuality.positionDrift || 0,
            streak: lowStabilityStreakRef.current,
            beatIndex: totalBeatsRef.current,
          };
          roiAuditLogRef.current.push(entry);
          if (roiAuditLogRef.current.length > ROI_AUDIT_LOG_MAX) {
            roiAuditLogRef.current.shift();
          }
          // Forensic console trace (kept terse, single line, structured).
          console.warn('[ROI-AUDIT] LOW_STABILITY_TRIGGER', entry);
        }
      } else {
        goodStabilityStreakRef.current++;
        if (
          roiAlertActive &&
          goodStabilityStreakRef.current >= ROI_STABILITY_RECOVER_BEATS
        ) {
          setRoiAlertActive(false);
          const entry = {
            t: performance.now(),
            kind: 'CLEAR' as const,
            roiScore: roiScoreBeat,
            drift: positionQuality.positionDrift || 0,
            streak: goodStabilityStreakRef.current,
            beatIndex: totalBeatsRef.current,
          };
          roiAuditLogRef.current.push(entry);
          if (roiAuditLogRef.current.length > ROI_AUDIT_LOG_MAX) {
            roiAuditLogRef.current.shift();
          }
          console.info('[ROI-AUDIT] STABILITY_RECOVERED', entry);
        }
        if (goodStabilityStreakRef.current >= ROI_STABILITY_RECOVER_BEATS) {
          lowStabilityStreakRef.current = 0;
        }
      }
    }

    if (heartBeatResult.rrData?.intervals) {
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    vitalSignsFrameCounter.current++;

    if (vitalSignsFrameCounter.current >= VITALS_PROCESS_EVERY_N_FRAMES) {
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

      setUpstreamContext({
        contactStable: stableHumanSignal,
        pressureOptimal,
        clipHighRatio: 0,
        sourceStability,
        avgBeatSQI: heartBeatResult.beatSQI || heartBeatResult.debug.lastBeatSQI || 0,
        beatCount: heartBeatResult.debug.beatsAccepted || heartBeatResult.rrData?.intervals.length || 0,
        sampleRate,
        detectorAgreement,
        rrStability,
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
  }, [lastSignal, isMonitoring, processHeartBeat, processVitalSigns, setArrhythmiaState, setRGBData, setUpstreamContext, getRGBStats, getPositionQuality, estimateSampleRateFromFrames, computeRRStability, applyEMA, vitalSigns.arrhythmiaCount]);

  useEffect(() => {
    if (isMonitoring && elapsedTime >= 60) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  useEffect(() => {
    // Drive HUD refresh (torch/ROI indicator) and telemetry panel from a single
    // low-frequency ticker. Active while measuring so the indicator stays live
    // even when the debug panel is closed.
    if (!isMonitoring) return;
    const id = window.setInterval(() => setTelemetryTick(t => (t + 1) & 0xffff), 300);
    return () => window.clearInterval(id);
  }, [isMonitoring]);

  const handleTelemetryTapZone = useCallback(() => {
    const now = performance.now();
    if (now - lastTelemetryTapRef.current < 350) {
      setShowTelemetry(s => !s);
      lastTelemetryTapRef.current = 0;
    } else {
      lastTelemetryTapRef.current = now;
    }
  }, []);

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

        {/* Invisible double-tap zone (top-left) to toggle the forensic telemetry panel */}
        <div
          onClick={handleTelemetryTapZone}
          className="absolute top-0 left-0 w-16 h-16 z-30"
          style={{ background: 'transparent' }}
          aria-hidden
        />

        {showTelemetry && isMonitoring && (() => {
          // Re-read on every telemetryTick re-render
          void telemetryTick;
          const dbg = (getDebugInfo?.() || {}) as any;
          const pq = getPositionQuality();
          const rgb = getRGBStats();
          const dropped = getDroppedFrames?.() ?? 0;
          const fmt = (v: any, d = 2) => typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—';
          const row = (k: string, v: any) => (
            <div className="flex justify-between gap-2 leading-tight">
              <span className="text-slate-400">{k}</span>
              <span className="text-emerald-300 font-mono">{v}</span>
            </div>
          );
          return (
            <div className="absolute top-12 left-2 right-2 z-30 max-w-[280px] bg-black/85 border border-emerald-500/30 rounded-md p-2 text-[10px] text-white font-mono shadow-2xl">
              <div className="text-emerald-400 font-bold tracking-wider mb-1">PPG TELEMETRY · WORKER</div>
              {row('contact', String(dbg.contactState ?? '—'))}
              {row('exported', String(dbg.exportedState ?? '—'))}
              {row('pressure', String(dbg.pressureState ?? '—'))}
              {row('source', `${dbg.activeSource ?? '—'} (stab ${fmt(dbg.sourceStability)})`)}
              {row('SQI', fmt(dbg.sqiGlobal, 0))}
              {row('PI', fmt(dbg.perfusionIndex, 4))}
              {row('clipHigh', fmt(dbg.clipHighRatio, 3))}
              {row('clipLow', fmt(dbg.clipLowRatio, 3))}
              {row('coverage', fmt(dbg.coverageRatio, 3))}
              {row('uniformity', fmt(dbg.spatialUniformity, 3))}
              {row('motion', fmt(dbg.motionScore, 3))}
              {row('FPS real', fmt(dbg.realFps, 1))}
              {row('proc ms', fmt(dbg.processingTimeMs, 2))}
              {row('dropped', String(dropped))}
              {row('locked', String(pq.locked))}
              {row('drift', fmt(pq.positionDrift, 3))}
              {row('ROI alert', roiAlertActive ? `ON (streak ${lowStabilityStreakRef.current})` : `off (low ${lowStabilityStreakRef.current}/good ${goodStabilityStreakRef.current})`)}
              {row('beat ROI', `${fmt(lastBeatRoiScoreRef.current, 2)} · drift ${fmt(lastBeatDriftRef.current, 2)}`)}
              {row('audit log', String(roiAuditLogRef.current.length))}
              {/* ── ROI audit timeline (last 16) ─────────────────────── */}
              {(() => {
                const log = roiAuditLogRef.current;
                const last = log.slice(-16);
                const now = performance.now();
                const current = log[log.length - 1];
                const copyCurrent = async () => {
                  if (!current) return;
                  const payload = JSON.stringify({
                    ...current,
                    isoTime: new Date(Date.now() - (now - current.t)).toISOString(),
                  }, null, 2);
                  try {
                    await navigator.clipboard.writeText(payload);
                    console.log('[ROI-AUDIT] copied', payload);
                  } catch (err) {
                    console.warn('[ROI-AUDIT] clipboard failed', err);
                  }
                };
                return (
                  <div className="mt-1 pt-1 border-t border-emerald-500/20">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-emerald-400 font-bold tracking-wider text-[9px]">ROI AUDIT · LAST 16</span>
                      <button
                        type="button"
                        onClick={copyCurrent}
                        disabled={!current}
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                        title="Copy current entry to clipboard"
                      >
                        COPY
                      </button>
                    </div>
                    {last.length === 0 ? (
                      <div className="text-slate-500 text-[9px] italic">no events yet</div>
                    ) : (
                      <>
                        <div className="flex gap-[2px] h-5 items-stretch">
                          {last.map((e, i) => {
                            const color =
                              e.kind === 'TRIGGER' ? 'bg-red-500'
                              : e.kind === 'CLEAR' ? 'bg-emerald-500'
                              : 'bg-slate-500';
                            const ageS = Math.max(0, (now - e.t) / 1000);
                            return (
                              <div
                                key={`${e.t}-${i}`}
                                className={`flex-1 ${color} rounded-sm opacity-80 hover:opacity-100`}
                                title={`${e.kind} · beat#${e.beatIndex} · score ${e.roiScore.toFixed(2)} · drift ${e.drift.toFixed(2)} · streak ${e.streak} · ${ageS.toFixed(1)}s ago`}
                              />
                            );
                          })}
                        </div>
                        {current && (
                          <div className="mt-1 text-[9px] leading-tight">
                            <div className="flex justify-between gap-2">
                              <span className={
                                current.kind === 'TRIGGER' ? 'text-red-400 font-bold'
                                : current.kind === 'CLEAR' ? 'text-emerald-400 font-bold'
                                : 'text-slate-400 font-bold'
                              }>
                                ▸ {current.kind}
                              </span>
                              <span className="text-slate-400">
                                beat#{current.beatIndex} · {((now - current.t) / 1000).toFixed(1)}s
                              </span>
                            </div>
                            <div className="flex justify-between gap-2 text-slate-500">
                              <span>score {current.roiScore.toFixed(2)} · drift {current.drift.toFixed(2)}</span>
                              <span>streak {current.streak}</span>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
              {row('R AC/DC', `${fmt(rgb.redAC, 2)} / ${fmt(rgb.redDC, 1)}`)}
              {row('G AC/DC', `${fmt(rgb.greenAC, 2)} / ${fmt(rgb.greenDC, 1)}`)}
              {row('R/G', fmt(rgb.rgRatio, 3))}
              {row('RoR', fmt(rgb.ratioOfRatios, 3))}
              <div className="mt-1 pt-1 border-t border-emerald-500/20 text-[9px] text-slate-500">
                doble-tap esquina sup-izq para ocultar
              </div>
            </div>
          );
        })()}

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

        {/* TORCH WATCHDOG + ROI STABILITY HUD ─────────────────────────────
            Sits below the guidance banner. Updates ~3 Hz via telemetryTick. */}
        {isMonitoring && (() => {
          void telemetryTick;
          const torch = cameraRef.current?.getTorchStatus?.() ?? {
            supported: false, active: false, watchdogActive: false,
            reArmCount: 0, lastReArmAt: 0, lastCheckAt: 0,
          };
          const pq = getPositionQuality();
          // ROI stability score: high quality + no drift = 1; clamp to [0,1].
          const driftPenalty = Math.min(1, Math.max(0, pq.positionDrift / 0.30));
          const roiScore = Math.max(0, Math.min(1,
            (pq.qualityScore || 0) * 0.7 + (pq.locked ? 0.3 : 0) - driftPenalty * 0.4
          ));
          const roiPct = Math.round(roiScore * 100);
          const driftPct = Math.round(Math.min(1, pq.positionDrift) * 100);
          const driftWarn = pq.drifting || driftPct >= 18;
          const driftCrit = pq.drifting && driftPct >= 28;

          // Torch tone:
          //   green  = supported + active + watchdog armed
          //   amber  = supported + active but recently re-armed (instability)
          //   red    = supported but currently OFF
          //   slate  = no torch hardware
          const recentReArm = torch.lastReArmAt > 0 && (performance.now() - torch.lastReArmAt) < 4000;
          const torchTone =
            !torch.supported ? 'slate' :
            !torch.active ? 'red' :
            recentReArm ? 'amber' : 'emerald';
          const torchToneCls =
            torchTone === 'emerald' ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' :
            torchTone === 'amber'   ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 animate-pulse' :
            torchTone === 'red'     ? 'bg-red-500/15 border-red-500/40 text-red-300 animate-pulse' :
                                      'bg-slate-500/15 border-slate-500/40 text-slate-300';

          const roiToneCls =
            driftCrit  ? 'bg-red-500/15 border-red-500/40 text-red-300 animate-pulse' :
            driftWarn  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' :
            roiPct >= 70 ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' :
                           'bg-slate-500/15 border-slate-500/40 text-slate-300';

          const torchLabel =
            !torch.supported ? 'NO TORCH' :
            !torch.active ? 'TORCH OFF' :
            torch.watchdogActive
              ? (recentReArm ? `TORCH RE-ARM ×${torch.reArmCount}` : `TORCH ✓ WD ×${torch.reArmCount}`)
              : 'TORCH ON';

          return (
            <div className="absolute top-9 left-0 right-0 z-20 flex justify-center gap-1.5 pointer-events-none">
              <div className={`px-2 py-0.5 rounded-md text-[9px] font-mono font-bold tracking-wider shadow border ${torchToneCls}`}>
                🔦 {torchLabel}
              </div>
              <div className={`px-2 py-0.5 rounded-md text-[9px] font-mono font-bold tracking-wider shadow border ${roiToneCls}`}>
                ROI {roiPct}% · DRIFT {driftPct}%
              </div>
              {driftCrit && (
                <div className="px-2 py-0.5 rounded-md text-[9px] font-mono font-bold tracking-wider shadow border bg-red-600/30 border-red-500/60 text-red-100 animate-pulse">
                  ⚠ ESTABILICE EL DEDO
                </div>
              )}
            </div>
          );
        })()}

        {/* PERSISTENT ROI-STABILITY ALERT ──────────────────────────────────
            Latches when N consecutive accepted beats fall below the ROI
            stability threshold. Stays on screen until ROI recovers for
            ROI_STABILITY_RECOVER_BEATS beats. Each transition is logged to
            roiAuditLogRef for forensic audit. */}
        {isMonitoring && roiAlertActive && (
          <div className="absolute top-16 left-0 right-0 z-30 flex justify-center pointer-events-none">
            <div className="px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-wider shadow-lg border bg-red-700/40 border-red-400/70 text-red-50 animate-pulse">
              ⚠ ROI INESTABLE · {ROI_STABILITY_BEATS_N}+ LATIDOS · ESTABILICE EL DEDO
              <span className="ml-2 opacity-80">
                score {Math.round(lastBeatRoiScoreRef.current * 100)}% ·
                drift {Math.round(Math.min(1, lastBeatDriftRef.current) * 100)}%
              </span>
            </div>
          </div>
        )}

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

          <div className="absolute inset-x-0 top-[55%] bottom-[60px] bg-black/10 px-4 py-6">
            <div className="grid grid-cols-3 gap-4 place-items-center">
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
    </div>
  );
};

export default Index;
