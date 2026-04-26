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
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import ForensicGateOverlay, { type ForensicGateSnapshot, type ForensicCadenceMs } from "@/components/ForensicGateOverlay";
import { useAutoHideOverlays } from "@/hooks/useAutoHideOverlays";
import { MotionClassifier } from "@/modules/signal-processing/MotionClassifier";
import { CameraQualityGate } from "@/modules/signal-processing/CameraQualityGate";
import CalibrationWizard, { type CalibrationBaseline } from "@/components/CalibrationWizard";
import { useRecalibrationWatchdog } from "@/hooks/useRecalibrationWatchdog";

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
  // Pin overlays whenever the operator likely needs status:
  // - not yet monitoring, no finger contact, low quality, or after results
  // Otherwise auto-hide after a few seconds so the waveform stays clean.
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
  // Clinical calibration wizard. Opened on demand (?calibrate=1 or button).
  const [showCalibration, setShowCalibration] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("calibrate") === "1";
  });
  const [calibrationBaseline, setCalibrationBaseline] = useState<CalibrationBaseline | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem('ppg.calibration.baseline');
      return raw ? (JSON.parse(raw) as CalibrationBaseline) : null;
    } catch { return null; }
  });
  // Highlight the CAL button briefly when the watchdog fires a prompt.
  const [calPromptHighlight, setCalPromptHighlight] = useState(false);
  const calPromptTimerRef = useRef<number | null>(null);
  const triggerCalPromptHighlight = useCallback(() => {
    setCalPromptHighlight(true);
    if (calPromptTimerRef.current) window.clearTimeout(calPromptTimerRef.current);
    calPromptTimerRef.current = window.setTimeout(() => setCalPromptHighlight(false), 6000);
  }, []);
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
  // Throttling refs for the overlay: we keep the latest snapshot in a ref and
  // only commit it to React state every ~150 ms. Heavy spectral fields are
  // copied as-is (they are tiny numbers — no allocations in hot path).
  const forensicGateRef = useRef<ForensicGateSnapshot | null>(null);
  const lastOverlayCommitRef = useRef<number>(0);
  // User-tunable cadence (overlay + session-log sampling). 150 ms keeps the
  // camera preview smooth; 100 ms gives denser logs; 300/500/1000 ms shrink
  // the export file. Persisted in localStorage so it survives reloads.
  const [overlayCadenceMs, setOverlayCadenceMs] = useState<ForensicCadenceMs>(() => {
    if (typeof window === 'undefined') return 150;
    const stored = parseInt(window.localStorage.getItem('forensicCadenceMs') || '', 10);
    return ([100, 150, 300, 500, 1000] as const).includes(stored as any) ? (stored as ForensicCadenceMs) : 150;
  });
  const overlayCadenceRef = useRef<number>(overlayCadenceMs);
  useEffect(() => {
    overlayCadenceRef.current = overlayCadenceMs;
    try { window.localStorage.setItem('forensicCadenceMs', String(overlayCadenceMs)); } catch {}
  }, [overlayCadenceMs]);
  // Gate-transition tracking for alerts (toast + haptic). We only fire on
  // RISING edge (false→true) for "open" alerts and FALLING edge (true→false)
  // for "closed" alerts, with a per-gate cooldown so we don't spam.
  const prevGatesRef = useRef<{ g1: boolean; g2: boolean; g3: boolean; all: boolean }>({
    g1: false, g2: false, g3: false, all: false,
  });
  const lastAlertAtRef = useRef<Record<string, number>>({});
  const ALERT_COOLDOWN_MS = 2500;
  // Last frame's publicationGate verdict — used to authorise beep/vibrate
  // inside HeartBeatProcessor on the NEXT frame (one-frame lag, ~30 ms).
  // Avoids the deadlock of needing morphology to allow morphology.
  const lastPublicationGateRef = useRef<boolean>(false);

  // ── Forensic session log (rolling ring buffer of overlay snapshots) ──
  // Each entry mirrors the overlay payload + a timestamp + a session ID, so
  // we can export a faithful trace of what the operator saw on screen.
  type ForensicSessionEntry = {
    t_iso: string;
    t_ms: number;
    g1_optical: boolean;
    g2_spectral: boolean;
    g3_morphology: boolean;
    pass_all: boolean;
    snr_db: number;
    peak_hz: number;
    bpm_estimate: number;
    concentration: number;
    reason: string;
  };
  const sessionLogRef = useRef<ForensicSessionEntry[]>([]);
  const sessionStartIsoRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");
  const SESSION_LOG_MAX = 4000; // ~10 min @ 1 sample / 150 ms
  const [sessionLogSize, setSessionLogSize] = useState(0);
  // Session-wide counters: a "valid sample" is one where the triple gate
  // passed at the moment we sampled it; a "noise sample" is everything
  // else (any gate closed). The percentage tells the operator whether
  // the device is truly measuring or staring at noise.
  const validSamplesRef = useRef(0);
  const noiseSamplesRef = useRef(0);
  const [validSamples, setValidSamples] = useState(0);
  const [noiseSamples, setNoiseSamples] = useState(0);

  // Runtime-tunable safeguard thresholds for the beat-detection gate.
  // Persisted in localStorage so calibration survives reloads.
  const [acceptedRatioMin, setAcceptedRatioMin] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.15;
    const v = parseFloat(localStorage.getItem('forensic.acceptedRatioMin') || '');
    return Number.isFinite(v) && v >= 0.10 && v <= 0.30 ? v : 0.15;
  });
  const [warmupSamples, setWarmupSamples] = useState<number>(() => {
    if (typeof window === 'undefined') return 60;
    const v = parseInt(localStorage.getItem('forensic.warmupSamples') || '', 10);
    return Number.isFinite(v) && v >= 30 && v <= 150 ? v : 60;
  });
  const [showThresholdPanel, setShowThresholdPanel] = useState(false);
  const acceptedRatioMinRef = useRef(acceptedRatioMin);
  const warmupSamplesRef = useRef(warmupSamples);

  // Auto-relax: after N consecutive accepted frames, soften the thresholds
  // so the operator doesn't have to fight the safeguard once a stable
  // signal has been established. Toggle + N persisted in localStorage.
  const [autoRelaxEnabled, setAutoRelaxEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('forensic.autoRelaxEnabled') === '1';
  });
  const [autoRelaxN, setAutoRelaxN] = useState<number>(() => {
    if (typeof window === 'undefined') return 90;
    const v = parseInt(localStorage.getItem('forensic.autoRelaxN') || '', 10);
    return Number.isFinite(v) && v >= 30 && v <= 300 ? v : 90;
  });
  const consecutiveAcceptedRef = useRef(0);
  const autoRelaxAppliedRef = useRef(false);
  const preRelaxRef = useRef<{ ratio: number; warmup: number } | null>(null);
  const [autoRelaxActive, setAutoRelaxActive] = useState(false);
  useEffect(() => {
    try { localStorage.setItem('forensic.autoRelaxEnabled', autoRelaxEnabled ? '1' : '0'); } catch {}
  }, [autoRelaxEnabled]);
  useEffect(() => {
    try { localStorage.setItem('forensic.autoRelaxN', String(autoRelaxN)); } catch {}
  }, [autoRelaxN]);

  useEffect(() => {
    acceptedRatioMinRef.current = acceptedRatioMin;
    try { localStorage.setItem('forensic.acceptedRatioMin', String(acceptedRatioMin)); } catch {}
  }, [acceptedRatioMin]);
  useEffect(() => {
    warmupSamplesRef.current = warmupSamples;
    try { localStorage.setItem('forensic.warmupSamples', String(warmupSamples)); } catch {}
  }, [warmupSamples]);

  const vibrate = useCallback((pattern: number | number[]) => {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        (navigator as any).vibrate(pattern);
      }
    } catch {}
  }, []);

  const fireGateAlert = useCallback((key: string, kind: 'success' | 'fail', message: string) => {
    const now = performance.now();
    const last = lastAlertAtRef.current[key] || 0;
    if (now - last < ALERT_COOLDOWN_MS) return;
    lastAlertAtRef.current[key] = now;
    if (kind === 'success') {
      vibrate([40, 30, 80]);
      toast({ title: '✓ ' + message, duration: 2200 });
    } else {
      vibrate(120);
      toast({ title: '⚠ ' + message, description: 'Mantén el dedo firme y quieto.', variant: 'destructive', duration: 2400 });
    }
  }, [vibrate]);

  // Build and download both a JSON and a CSV with the forensic session log.
  const exportForensicSession = useCallback(() => {
    const log = sessionLogRef.current;
    if (log.length === 0) {
      toast({
        title: 'No hay datos para exportar',
        description: 'Inicia una medición para registrar la sesión forense.',
        duration: 2400,
      });
      return;
    }

    const sessionId = sessionIdRef.current || `forensic_${Date.now().toString(36)}`;
    const startIso = sessionStartIsoRef.current || log[0].t_iso;
    const endIso = log[log.length - 1].t_iso;

    // Aggregate stats for the export header.
    const passCount = log.reduce((n, e) => n + (e.pass_all ? 1 : 0), 0);
    const snrValues = log.filter(e => e.snr_db !== 0).map(e => e.snr_db);
    const snrAvg = snrValues.length ? snrValues.reduce((a, b) => a + b, 0) / snrValues.length : 0;
    const snrMax = snrValues.length ? Math.max(...snrValues) : 0;
    const peakValues = log.filter(e => e.peak_hz > 0).map(e => e.peak_hz);
    const peakAvg = peakValues.length ? peakValues.reduce((a, b) => a + b, 0) / peakValues.length : 0;

    const summary = {
      session_id: sessionId,
      started_at: startIso,
      ended_at: endIso,
      sample_count: log.length,
      pass_all_samples: passCount,
      pass_all_ratio: +(passCount / log.length).toFixed(3),
      avg_cardiac_snr_db: +snrAvg.toFixed(2),
      max_cardiac_snr_db: +snrMax.toFixed(2),
      avg_peak_hz: +peakAvg.toFixed(3),
      avg_bpm_estimate: peakAvg > 0 ? Math.round(peakAvg * 60) : 0,
      schema: 'forensic_overlay_log/v1',
    };

    // Build JSON
    const jsonBlob = new Blob(
      [JSON.stringify({ summary, samples: log }, null, 2)],
      { type: 'application/json' }
    );

    // Build CSV
    const header = [
      't_iso','t_ms','g1_optical','g2_spectral','g3_morphology','pass_all',
      'snr_db','peak_hz','bpm_estimate','concentration','reason',
    ];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csvRows = [
      header.join(','),
      ...log.map(e => [
        e.t_iso, e.t_ms,
        e.g1_optical ? 1 : 0,
        e.g2_spectral ? 1 : 0,
        e.g3_morphology ? 1 : 0,
        e.pass_all ? 1 : 0,
        e.snr_db, e.peak_hz, e.bpm_estimate, e.concentration,
        escape(e.reason || ''),
      ].join(',')),
    ];
    const csvBlob = new Blob([csvRows.join('\n')], { type: 'text/csv' });

    const stamp = (sessionStartIsoRef.current || endIso).replace(/[:.]/g, '-');
    const downloadBlob = (blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    };
    downloadBlob(jsonBlob, `forensic-session-${stamp}.json`);
    downloadBlob(csvBlob,  `forensic-session-${stamp}.csv`);

    // Try the Web Share API too (mobile-first), best-effort.
    try {
      const csvFile = new File([csvBlob], `forensic-session-${stamp}.csv`, { type: 'text/csv' });
      const navAny = navigator as any;
      if (navAny.canShare && navAny.canShare({ files: [csvFile] })) {
        navAny.share({
          files: [csvFile],
          title: 'Sesión Forense PPG',
          text: `Sesión ${sessionId} · ${log.length} muestras`,
        }).catch(() => {});
      }
    } catch {}

    vibrate(60);
    toast({
      title: '✓ Sesión forense exportada',
      description: `${log.length} muestras · JSON + CSV descargados`,
      duration: 2600,
    });
    setSessionLogSize(log.length);
  }, [vibrate]);
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
  // Motion classifier: drops frames during sustained SEVERE motion with a
  // hard 50% drop-rate cap so the operator never loses the live trace.
  const motionClassifierRef = useRef<MotionClassifier>(new MotionClassifier());
  // V9.4 — Camera data-quality watchdog. Inspects G1 (greenDC), G2 (greenAC)
  // and G3 (red/green ratio) every CIVIL_MODE vitals tick. If the camera
  // delivers black / saturated / frozen / no-finger frames for ≥ 1 s, the
  // gate asks Index to bounce `isCameraOn` so the stream is re-negotiated.
  const cameraQualityRef = useRef<CameraQualityGate>(new CameraQualityGate());
  const cameraReinitInFlightRef = useRef<boolean>(false);
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
      // Initial size; adapted to native video size at first frame.
      canvasRef.current.width = 480;
      canvasRef.current.height = 360;
      ctxRef.current = canvasRef.current.getContext('2d', {
        willReadFrequently: true,
        alpha: false,
        desynchronized: true,
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

    // Forensic capture loop — single hot path. No per-frame logging.
    //
    // Frame timing strategy (in priority order):
    //   1. metadata.mediaTime (s) → ms, the camera's authoritative
    //      capture clock; immune to main-thread jank.
    //   2. metadata.presentationTime (ms) — DOMHighResTimeStamp at the
    //      moment the frame was made available to the page.
    //   3. performance.now() fallback for browsers without rVFC.
    //
    // Capture canvas is sized to (native_w / 2, native_h / 2) on first
    // frame, capped at 640×480 pixels. This keeps the ROI mask working
    // on a high-fidelity downscale without paying full-frame imageData
    // cost on mobile GPUs.
    let canvasSized = false;
    let lastErrorLogAt = 0;

    const sizeCanvasToVideo = (video: HTMLVideoElement) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      // Aim for ~2× the legacy 320×240 (= 4× the pixel count) but cap
      // at 640×480 so getImageData stays under ~1.2 ms on mid-range phones.
      const targetMaxW = 640;
      const scale = Math.min(1, targetMaxW / vw);
      const w = Math.max(320, Math.round(vw * scale));
      const h = Math.max(240, Math.round(vh * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvasSized = true;
    };

    const captureOneFrame = (frameTimestamp: number) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(() =>
          captureOneFrame(performance.now())
        );
        return;
      }
      if (!canvasSized) sizeCanvasToVideo(video);

      try {
        // Motion gate: under sustained SEVERE motion, skip the heavy
        // drawImage + getImageData + processFrame work, but log the drop
        // so the rolling 50% drop-rate cap can hold us back when needed.
        const mc = motionClassifierRef.current;
        const nowMs = performance.now();
        const drop = mc.shouldDropFrame(nowMs);
        mc.markFrame(nowMs, drop);
        if (!drop) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          processFrame(imageData, frameTimestamp);
        }
      } catch (e) {
        const now = performance.now();
        if (now - lastErrorLogAt > 2000) {
          lastErrorLogAt = now;
          console.error('Frame capture error:', e);
        }
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current) return;
      if ('requestVideoFrameCallback' in video) {
        (video as any).requestVideoFrameCallback((_now: number, metadata: any) => {
          // mediaTime is in seconds (camera capture clock); presentationTime
          // is in DOMHighResTimeStamp ms; performance.now() is fallback.
          const ts =
            (typeof metadata?.mediaTime === 'number' ? metadata.mediaTime * 1000 : null)
            ?? (typeof metadata?.presentationTime === 'number' ? metadata.presentationTime : null)
            ?? performance.now();
          captureOneFrame(ts);
        });
      } else {
        frameLoopRef.current = requestAnimationFrame(() =>
          captureOneFrame(performance.now())
        );
      }
    };

    captureOneFrame(performance.now());
  }, [processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
    // Release the devicemotion listener so the IMU sleeps between sessions.
    motionClassifierRef.current.stop();
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
    // Reset gate-alert state so users get fresh transitions in the new session.
    prevGatesRef.current = { g1: false, g2: false, g3: false, all: false };
    lastAlertAtRef.current = {};
    forensicGateRef.current = null;
    lastOverlayCommitRef.current = 0;
    // Reset session log for a fresh forensic export.
    sessionLogRef.current = [];
    setSessionLogSize(0);
    validSamplesRef.current = 0;
    noiseSamplesRef.current = 0;
    setValidSamples(0);
    setNoiseSamples(0);
    // Reset auto-relax tracking each new session.
    consecutiveAcceptedRef.current = 0;
    if (autoRelaxAppliedRef.current && preRelaxRef.current) {
      // Restore user-set thresholds before next session.
      setAcceptedRatioMin(preRelaxRef.current.ratio);
      setWarmupSamples(preRelaxRef.current.warmup);
    }
    autoRelaxAppliedRef.current = false;
    preRelaxRef.current = null;
    setAutoRelaxActive(false);
    sessionStartIsoRef.current = new Date().toISOString();
    sessionIdRef.current = `forensic_${Date.now().toString(36)}_${(performance.now() | 0).toString(36)}`;
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));
    // Iniciar procesamiento de señal primero
    startProcessing();
    // Start the IMU motion classifier (no-op on platforms without devicemotion).
    motionClassifierRef.current.start().catch(() => {});
    // V9.4 — reset camera quality watchdog for the new session.
    cameraQualityRef.current.reset();
    cameraReinitInFlightRef.current = false;
    // Activar cámara
    setIsCameraOn(true);
    // Activar monitoreo
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
    // FORENSIC: never persist vital-signs records that include SpO2/BP/etc.
    // when running in forensic mode — those numbers are only valid in CIVIL.
    if (CIVIL_MODE && (savedResults || vitalSigns.spo2 > 0)) {
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
    
    console.log('📊 lastSignal recibido:', {
      filteredValue: lastSignal.filteredValue,
      quality: lastSignal.quality,
      fingerDetected: lastSignal.fingerDetected,
      contactState: (lastSignal as any).contactState,
      timestamp: lastSignal.timestamp
    });
    
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

    // Mirror the gate snapshot into a ref every frame (cheap), but only
    // commit it to React state at most every OVERLAY_MIN_INTERVAL_MS so the
    // overlay re-render rate is decoupled from the camera frame rate. This
    // keeps the camera preview perfectly smooth.
    if (fg) {
      const snap: ForensicGateSnapshot = {
        gate1_optical: fg.gate1_optical,
        gate2_spectral: fg.gate2_spectral,
        gate3_morphology: fg.gate3_morphology,
        passAll: fg.passAll,
        cardiacSNRdB: fg.cardiacSNRdB,
        spectralPeakHz: fg.spectralPeakHz,
        spectralConcentration: (fg as any).spectralConcentration ?? 0,
        livenessReason: fg.livenessReason,
        opticalEvidence: (fg as any).opticalEvidence,
        opticalReason: (fg as any).opticalReason,
        opticalReasonText: (fg as any).opticalReasonText,
        opticalMetrics: (fg as any).opticalMetrics,
        publicationGate: (fg as any).publicationGate,
        effectiveSampleRate: (fg as any).effectiveSampleRate,
        bufferedSeconds: (fg as any).bufferedSeconds,
      };
      forensicGateRef.current = snap;
      const nowMs = performance.now();
      const prev = prevGatesRef.current;
      const transitioned =
        prev.g1 !== snap.gate1_optical ||
        prev.g2 !== snap.gate2_spectral ||
        prev.g3 !== snap.gate3_morphology ||
        prev.all !== snap.passAll;
      // Commit on transitions immediately (so users see the pill flip), or
      // throttle steady-state updates.
      if (transitioned || nowMs - lastOverlayCommitRef.current >= overlayCadenceRef.current) {
        lastOverlayCommitRef.current = nowMs;
        setForensicGate(snap);

        // Append to the session log at the same throttled cadence.
        const log = sessionLogRef.current;
        log.push({
          t_iso: new Date().toISOString(),
          t_ms: Math.round(nowMs),
          g1_optical: snap.gate1_optical,
          g2_spectral: snap.gate2_spectral,
          g3_morphology: snap.gate3_morphology,
          pass_all: snap.passAll,
          snr_db: +snap.cardiacSNRdB.toFixed(2),
          peak_hz: +snap.spectralPeakHz.toFixed(3),
          bpm_estimate: snap.spectralPeakHz > 0 ? Math.round(snap.spectralPeakHz * 60) : 0,
          concentration: +snap.spectralConcentration.toFixed(3),
          reason: snap.livenessReason,
        });
        if (log.length > SESSION_LOG_MAX) log.splice(0, log.length - SESSION_LOG_MAX);
        // Increment session-wide valid/noise counters at the same throttled
        // cadence. These drive the "Válidas / Ruido" + "Triple-gate %"
        // display in the forensic overlay.
        if (snap.passAll) validSamplesRef.current += 1;
        else noiseSamplesRef.current += 1;
        // Cheap state ping (only when buckets of 25 rounds elapse) so the
        // overlay counters update without spamming React.
        if (log.length % 25 === 0) {
          setSessionLogSize(log.length);
          setValidSamples(validSamplesRef.current);
          setNoiseSamples(noiseSamplesRef.current);
        }
      }

      // ── Gate transition alerts (haptic + toast) ──
      // Rising edge → success alerts (each gate that just opened).
      if (!prev.g1 && snap.gate1_optical) {
        fireGateAlert('g1_open', 'success', 'Contacto óptico válido (G1)');
      }
      if (!prev.g2 && snap.gate2_spectral) {
        fireGateAlert('g2_open', 'success', 'Señal cardíaca confirmada (G2)');
      }
      if (!prev.g3 && snap.gate3_morphology) {
        fireGateAlert('g3_open', 'success', 'Morfología de pulso válida (G3)');
      }
      if (!prev.all && snap.passAll) {
        // Strong celebratory haptic for the full triple-gate.
        vibrate([60, 50, 60, 50, 120]);
        fireGateAlert('all_open', 'success', 'PULSO REAL DETECTADO');
      }
      // Falling edge → per-gate failure alerts (only when we previously had it).
      if (prev.g1 && !snap.gate1_optical) {
        fireGateAlert('g1_fail', 'fail', 'Sin contacto óptico (G1)');
      }
      if (prev.g2 && !snap.gate2_spectral) {
        fireGateAlert('g2_fail', 'fail', 'Señal cardíaca perdida (G2)');
      }
      if (prev.g3 && !snap.gate3_morphology) {
        fireGateAlert('g3_fail', 'fail', 'Morfología inválida (G3)');
      }
      prevGatesRef.current = {
        g1: snap.gate1_optical,
        g2: snap.gate2_spectral,
        g3: snap.gate3_morphology,
        all: snap.passAll,
      };
    }

    // FORENSIC: a "stable human signal" is just optical contact + minimal
    // perfusion. We do NOT require GOOD perfusion (a victim in shock won't
    // have it) and we do NOT block on motion (operator may be moving).
    // What protects us against fake numbers is the upstream liveness gate:
    // if there is no hemoglobin signature → contactState === NO_OPTICAL_CONTACT
    // → we early-return below with everything zeroed.
    const stableHumanSignal = !noOpticalContact && (lastSignal.quality || 0) >= 6;

    // MODO FORENSE POLICIAL: permitir procesamiento incluso con contacto subóptimo
    // Solo bloquear si hay evidencia clara de NO ser tejido humano
    if (noOpticalContact && (lastSignal as any)?.contactState === 'NO_OPTICAL_CONTACT') {
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
    
    // Si gate1 no pasa pero hay señal, procesar de todos modos para análisis forense
    console.log('⚠️ Gate1 no pasa pero procesando para análisis:', {
      gate1: fg?.gate1_optical,
      contactState: (lastSignal as any)?.contactState,
      quality: lastSignal.quality,
      signalValue
    });

    const pressureOptimal = goodPerfusion && positionQuality.locked && !positionQuality.drifting && positionQuality.qualityScore >= 0.55;
    const sourceStability = Math.max(0, Math.min(1, positionQuality.qualityScore || 0));
    const sampleRate = estimateSampleRateFromFrames(lastSignal.timestamp);

    // ── SAFEGUARD ratio: gates PUBLICATION only. NEVER blocks the detector
    // feed (that would create the historical deadlock where gate3 can't
    // open because the detector never runs). The detector keeps consuming
    // candidate OD samples so morphology can build up over time.
    const ACCEPTED_RATIO_MIN = acceptedRatioMinRef.current;
    const ACCEPTED_RATIO_WARMUP_SAMPLES = warmupSamplesRef.current;
    const totalSeen = validSamplesRef.current + noiseSamplesRef.current;
    const acceptedRatio = totalSeen > 0 ? validSamplesRef.current / totalSeen : 0;
    const ratioGuardActive = totalSeen >= ACCEPTED_RATIO_WARMUP_SAMPLES && acceptedRatio < ACCEPTED_RATIO_MIN;

    // ════════════════════════════════════════════════════════════════
    //  PROCESSING_GATE — MODO FORENSE POLICIAL: procesar siempre que haya señal
    //  Eliminamos restricciones estrictas para permitir análisis en condiciones
    //  subóptimas (víctimas en shock, mala iluminación, movimiento).
    // ════════════════════════════════════════════════════════════════
    const om = (fg as any)?.opticalMetrics;
    const bufferedSeconds = (fg as any)?.bufferedSeconds ?? 0;
    const opticalOk = !!(fg as any)?.opticalEvidence;
    
    // MODO FORENSE: permitir procesamiento con condiciones mínimas
    const processingAllowed =
      Number.isFinite(signalValue) &&
      (opticalOk || lastSignal.quality > 0); // Permitir si hay calidad mínima

    console.log('🔍 Processing gate:', {
      processingAllowed,
      opticalOk,
      signalValue,
      quality: lastSignal.quality,
      bufferedSeconds,
      om
    });

    // Auto-relax counter — sigue mirando "OD aceptada por evidencia óptica",
    // independiente de la publicación. Permite suavizar umbrales cuando hay
    // contacto óptico estable, aunque la morfología aún no se haya validado.
    if (opticalOk) {
      consecutiveAcceptedRef.current += 1;
      if (
        autoRelaxEnabled &&
        !autoRelaxAppliedRef.current &&
        consecutiveAcceptedRef.current >= autoRelaxN
      ) {
        preRelaxRef.current = {
          ratio: acceptedRatioMinRef.current,
          warmup: warmupSamplesRef.current,
        };
        const relaxedRatio = Math.max(0.10, acceptedRatioMinRef.current * 0.5);
        const relaxedWarmup = Math.max(30, Math.round(warmupSamplesRef.current * 0.5));
        setAcceptedRatioMin(relaxedRatio);
        setWarmupSamples(relaxedWarmup);
        autoRelaxAppliedRef.current = true;
        setAutoRelaxActive(true);
        toast({
          title: 'Umbrales auto-relajados',
          description: `Señal estable (${autoRelaxN} frames). Ratio ${Math.round(relaxedRatio*100)}% · warm-up ${relaxedWarmup}.`,
        });
      }
    } else {
      consecutiveAcceptedRef.current = 0;
    }

    // MODO FORENSE: solo bloquear si no hay señal válida absolutamente
    if (!processingAllowed) {
      console.log('🚫 Processing gate cerrado - señal inválida');
      setHeartbeatSignal(0);
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

    // ════════════════════════════════════════════════════════════════
    //  ALIMENTACIÓN INCONDICIONAL DEL DETECTOR
    //  El detector procesa SIEMPRE (analiza, aprende morfología, abre gate3)
    //  independientemente del estado de publicación. Esto rompe el deadlock
    //  donde morphology necesita morphology para abrirse.
    // ════════════════════════════════════════════════════════════════
    console.log('💓 Procesando heartbeat:', {
      signalValue,
      contactState,
      quality: lastSignal.quality,
      timestamp: lastSignal.timestamp
    });
    
    const heartBeatResult = processHeartBeat(
      signalValue,
      contactState,
      lastSignal.timestamp,
      {
        quality: lastSignal.quality,
        contactState,
        motionArtifact: lastSignal.motionArtifact || motionInfo.motionArtifact,
        pressureState: pressureOptimal ? 'OPTIMAL_PRESSURE' : 'LOW_PRESSURE',
        clipHigh: om?.clipHigh ?? 0,
        clipLow:  om?.clipLow  ?? 0,
        perfusionIndex: lastSignal.perfusionIndex,
        positionDrifting: positionQuality.drifting,
        // Permitir que el detector corra sin restricción de publicación
        // para que pueda aprender morfología y abrir gate3.
        // La publicación (beep/vibrate/UI) se controla después.
        publicationGate: true,
      }
    );
    
    console.log('💓 HeartBeat result:', {
      bpm: heartBeatResult.bpm,
      bpmConfidence: heartBeatResult.bpmConfidence,
      isPeak: heartBeatResult.isPeak,
      beatSQI: heartBeatResult.beatSQI,
      morphologyGatePass: (heartBeatResult as any).morphologyGatePass
    });

    // Cerrar gate3_morphology con la verdad del detector — SIEMPRE que el
    // detector haya corrido. Esto es lo que permite que forensicPass pueda
    // llegar a true en el próximo frame.
    const morphPass = !!(heartBeatResult as any).morphologyGatePass;
    setMorphologyGate(morphPass, morphPass ? 'OK' : 'MORFOLOGÍA INSUFICIENTE');

    // ════════════════════════════════════════════════════════════════
    //  PUBLICATION_GATE — MODO FORENSE POLICIAL: publicar siempre que haya
    //  datos válidos para análisis. No bloquear por gates estrictos.
    // ════════════════════════════════════════════════════════════════
    const spectralPass = !!fg?.gate2_spectral;
    // MODO FORENSE: publicar si hay señal cardíaca detectada, sin restricciones de gates
    const publicationGate =
      heartBeatResult.bpm > 0 &&
      heartBeatResult.bpmConfidence >= 0.10; // Mínimo muy bajo para modo forense
    lastPublicationGateRef.current = publicationGate;

    if (!publicationGate) {
      // MODO FORENSE: mostrar señal cruda incluso sin BPM alto
      setHeartbeatSignal(heartBeatResult.filteredValue);
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

    // PUBLICATION_GATE = true → autorizamos onda + BPM + beep/vibración.
    setHeartbeatSignal(heartBeatResult.filteredValue);
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

      // V9.4 — Camera quality gate. Runs at the same cadence as the rest
      // of the CIVIL_MODE block (every N frames). If the gate has been
      // unhappy for ≥ badFrameStreak consecutive samples it returns true
      // → we bounce isCameraOn off → on, which forces CameraView's start
      // effect to renegotiate the MediaStream from scratch.
      const needReinit = cameraQualityRef.current.inspect({
        redDC:   rgbStats.redDC,
        greenDC: rgbStats.greenDC,
        redAC:   rgbStats.redAC,
        greenAC: rgbStats.greenAC,
      });
      if (needReinit && isMonitoring && !cameraReinitInFlightRef.current) {
        cameraReinitInFlightRef.current = true;
        const verdict = cameraQualityRef.current.getStats().lastVerdict;
        console.warn('🔁 Camera quality gate → reinit:', verdict.reason);
        setIsCameraOn(false);
        // Allow CameraView's stopCamera() to run, then re-enable.
        window.setTimeout(() => {
          if (isProcessingRef.current) {
            cameraQualityRef.current.reset(); // restart warm-up window
            setIsCameraOn(true);
          }
          // Cooldown: clear in-flight a bit later so we don't loop.
          window.setTimeout(() => { cameraReinitInFlightRef.current = false; }, 2000);
        }, 400);
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
              // FORENSIC: vibración de arritmia SOLO si triple-gate + evidencia
              // óptica autorizan publicación. Evita falsas alarmas en aire/ruido.
              if (publicationGate && navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
              }
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

  // Auto-hide overlays unless we need the operator's attention.
  const overlayPinned = !isMonitoring
    || !lastSignal?.fingerDetected
    || (lastSignal?.quality ?? 0) < 40
    || showResults;
  const { visible: overlaysVisible, reveal: revealOverlays } =
    useAutoHideOverlays({ idleMs: 4000, initialMs: 4000, pinned: overlayPinned });

  // Confidence watchdog — fires a recalibration toast (and flashes the CAL
  // chip) when quality, motion, or BPM/SpO₂ drift sustain past hold windows.
  // Suppressed while the wizard is open or when not actively monitoring.
  useRecalibrationWatchdog(
    {
      enabled: isMonitoring && !showCalibration,
      quality: lastSignal?.quality ?? 0,
      bpm: heartRate,
      spo2: vitalSigns.spo2,
      motionLevel: motionClassifierRef.current.classify(),
      baseline: calibrationBaseline,
    },
    { onPrompt: triggerCalPromptHighlight },
  );

  return (
    <>
    <div
      data-overlay-visible={overlaysVisible}
      onPointerDown={revealOverlays}
      className="fixed inset-0 flex flex-col bg-black"
      style={{ 
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

        {/* ════════════════════════════════════════════════════════════
            PPGSignalMeter - FULL SCREEN 100% - MONITOR CARDÍACO FORENSE
            ════════════════════════════════════════════════════════════ */}
        <div className="absolute inset-0 z-10">
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
            diagnosticMessage={lastSignal?.diagnostics?.message || 'MONITOR CARDÍACO ACTIVO'}
            isPeak={beatMarker === 1}
            bpm={heartRate}
            spo2={CIVIL_MODE ? vitalSigns.spo2 : 0}
            rrIntervals={rrIntervals}
            publicationGate={true}
            rejectionReason={forensicGate?.livenessReason || ''}
          />
        </div>

        {/* ════════════════════════════════════════════════════════════
            FLOATING OVERLAYS - ELEMENTOS FLOTANTES SOBRE EL MONITOR
            ════════════════════════════════════════════════════════════ */}
        
        {/* Position guidance - top center compact pill */}
        {isMonitoring && (() => {
          const pq = getPositionQuality();
          const isDrifting = pq.drifting;
          const isLocked = pq.locked && !isDrifting;
          return (
            <div className="auto-hide safe-top absolute top-0 left-0 right-0 z-30 flex justify-center pointer-events-none">
              <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider shadow-md backdrop-blur-md border ${
                isLocked ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' :
                isDrifting ? 'bg-red-500/15 border-red-500/30 text-red-300 animate-pulse' :
                pq.qualityScore > 0.4 ? 'bg-amber-500/15 border-amber-500/30 text-amber-300' :
                'bg-red-500/15 border-red-500/30 text-red-300'
              }`}>
                <span className="flex items-center gap-1.5">
                  {isLocked ? <Shield className="w-2.5 h-2.5" /> : isDrifting ? <AlertTriangle className="w-2.5 h-2.5" /> : <Activity className="w-2.5 h-2.5 animate-pulse" />}
                  {pq.guidance}
                </span>
              </div>
            </div>
          );
        })()}

        {/* Forensic overlay - top right */}
        <ForensicGateOverlay
          gate={forensicGate}
          visible={showForensicOverlay && isMonitoring}
          onExport={exportForensicSession}
          sampleCount={sessionLogSize}
          cadenceMs={overlayCadenceMs}
          onCadenceChange={setOverlayCadenceMs}
          validSamples={validSamples}
          noiseSamples={noiseSamples}
        />

        {/* Threshold calibration - floating panel */}
        {showForensicOverlay && isMonitoring && (
          <div className="auto-hide fixed top-0 right-0 z-40 font-mono safe-top safe-right">
            <button
              type="button"
              onClick={() => setShowThresholdPanel(v => !v)}
              className="rounded-md border border-zinc-700/70 bg-black/75 backdrop-blur-sm px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-200 hover:bg-zinc-800/80"
              title="Calibrar umbrales del safeguard"
            >
              {showThresholdPanel ? 'CERRAR ⚙' : 'UMBRALES ⚙'}
            </button>
            {showThresholdPanel && (
              <div className="mt-2 w-[260px] rounded-lg border border-zinc-700/70 bg-black/90 backdrop-blur-sm p-3 text-[11px] text-zinc-100 shadow-2xl space-y-2">
                <div className="text-[10px] font-bold tracking-widest text-zinc-300 border-b border-zinc-700/60 pb-2">
                  CALIBRACIÓN SAFEGUARD
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-zinc-400">Ratio mínimo aceptado</span>
                    <span className="text-emerald-300 font-bold">{Math.round(acceptedRatioMin * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0.10} max={0.30} step={0.01}
                    value={acceptedRatioMin}
                    onChange={(e) => setAcceptedRatioMin(parseFloat(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-500">
                    <span>10%</span><span>30%</span>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-zinc-400">Warm-up (muestras)</span>
                    <span className="text-emerald-300 font-bold">{warmupSamples}</span>
                  </div>
                  <input
                    type="range" min={30} max={150} step={5}
                    value={warmupSamples}
                    onChange={(e) => setWarmupSamples(parseInt(e.target.value, 10))}
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-500">
                    <span>30</span><span>150</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setAcceptedRatioMin(0.15); setWarmupSamples(60); }}
                  className="w-full rounded-md border border-zinc-600/60 bg-zinc-800/60 hover:bg-zinc-700/60 text-[10px] font-bold tracking-wide py-1.5"
                >
                  RESET (15% / 60)
                </button>
                <div className="border-t border-zinc-700/60 pt-2 space-y-1.5">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-zinc-400">Auto-relax tras N frames</span>
                    <input
                      type="checkbox"
                      checked={autoRelaxEnabled}
                      onChange={(e) => setAutoRelaxEnabled(e.target.checked)}
                      className="accent-emerald-500"
                    />
                  </label>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-zinc-400">N consecutivos</span>
                      <span className="text-emerald-300 font-bold">{autoRelaxN}</span>
                    </div>
                    <input
                      type="range" min={30} max={300} step={10}
                      value={autoRelaxN}
                      onChange={(e) => setAutoRelaxN(parseInt(e.target.value, 10))}
                      disabled={!autoRelaxEnabled}
                      className="w-full accent-emerald-500 disabled:opacity-40"
                    />
                    <div className="flex justify-between text-[9px] text-zinc-500">
                      <span>30</span><span>300</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-zinc-500">Racha actual</span>
                    <span className="text-zinc-200 font-bold">{consecutiveAcceptedRef.current}</span>
                  </div>
                  {autoRelaxActive && (
                    <div className="text-[9px] text-emerald-300 font-bold">⚡ Umbrales relajados activos</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pulse status - compact floating chip top-left */}
        {isMonitoring && (() => {
          const cs: string = (lastSignal as any)?.contactState || 'NO_OPTICAL_CONTACT';
          const noOptical = cs === 'NO_OPTICAL_CONTACT' || cs === 'NO_CONTACT';
          const triplePass = !!forensicGate?.passAll;
          const pulsePresent = isMonitoring && triplePass && heartRate > 0;
          const pi = triplePass ? (lastSignal?.perfusionIndex || 0) : 0;
          const blockedReason = forensicGate?.livenessReason || (noOptical ? 'SIN CONTACTO ÓPTICO' : 'BUSCANDO PULSO REAL');
          return (
            <div className="auto-hide safe-top safe-left absolute top-8 left-0 z-30 pointer-events-none">
              <div className={`rounded-lg px-2.5 py-1.5 border backdrop-blur-md shadow-lg ${
                pulsePresent
                  ? 'bg-emerald-500/10 border-emerald-400/50'
                  : 'bg-red-500/10 border-red-400/40'
              }`}>
                <div className="flex items-baseline gap-2">
                  <span className={`text-2xl font-bold leading-none tabular-nums ${pulsePresent ? 'text-emerald-300' : 'text-slate-500'}`}>
                    {pulsePresent ? Math.round(heartRate) : '--'}
                  </span>
                  <span className="text-[9px] text-slate-400 tracking-wider">BPM</span>
                </div>
                <div className={`text-[8px] font-bold tracking-wider mt-0.5 ${pulsePresent ? 'text-emerald-300' : 'text-red-300'}`}>
                  {pulsePresent ? '● PULSO' : '○ ' + blockedReason.slice(0, 22)}
                </div>
                <div className="flex gap-2 mt-1 text-[8px] text-slate-400 font-mono">
                  <span>PI {pi > 0 ? pi.toFixed(2) : '--'}</span>
                  <span>SQI {lastSignal?.quality ? Math.round(lastSignal.quality) : '--'}%</span>
                  <span>{Math.floor(elapsedTime / 60)}:{String(elapsedTime % 60).padStart(2, '0')}</span>
                </div>
              </div>
            </div>
          );
        })()}

        {/* CIVIL MODE - compact bottom-right chip */}
        {CIVIL_MODE && (
          <div className="auto-hide safe-bottom safe-right absolute bottom-0 right-0 z-30 pointer-events-none">
            <div className="bg-black/70 backdrop-blur-md border border-slate-700/50 rounded-lg px-2 py-1.5">
              <div className="text-[7px] text-amber-400/80 mb-0.5 tracking-widest">⚠ CIVIL · NO CLÍNICO</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                <span className="text-slate-400">FC <span className="text-white">{heartRate > 0 ? Math.round(heartRate) : "--"}</span></span>
                <span className="text-slate-400">O₂ <span className="text-white">{vitalSigns.spo2 > 0 ? vitalSigns.spo2.toFixed(0) : "--"}%</span></span>
                <span className="text-slate-400">PA <span className="text-white">{vitalSigns.pressure?.systolic > 0 ? `${vitalSigns.pressure.systolic}/${vitalSigns.pressure.diastolic}` : "--/--"}</span></span>
                <span className="text-slate-400">GL <span className="text-white">{vitalSigns.glucose > 0 ? vitalSigns.glucose.toFixed(0) : "--"}</span></span>
              </div>
            </div>
          </div>
        )}

        {/* Measurement summary modal */}
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
                      {CIVIL_MODE && (
                      <div className="bg-slate-900/80 rounded-xl p-3 text-center border border-slate-800/50">
                        <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                        <div className="text-white text-2xl font-bold leading-none">
                          {vitalSigns.spo2 > 0 ? vitalSigns.spo2 : '--'}
                          <span className="text-sm text-slate-400">%</span>
                        </div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">SpO₂</div>
                      </div>
                      )}
                    </div>

                    {CIVIL_MODE && vitalSigns.pressure?.systolic > 0 && (
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
                    {CIVIL_MODE && (
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
                    )}
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

      {/* Clinical calibration trigger — only available while monitoring. */}
      {isMonitoring && (
        <button
          type="button"
          onClick={() => { setShowCalibration(true); setCalPromptHighlight(false); }}
          className={
            "fixed bottom-1 left-9 z-40 h-6 px-2 rounded-full text-[10px] font-medium text-primary border " +
            (calPromptHighlight
              ? "bg-primary/30 border-primary animate-pulse ring-2 ring-primary/50"
              : "bg-primary/15 hover:bg-primary/25 border-primary/30")
          }
          aria-label="Calibración clínica"
        >
          CAL
        </button>
      )}

      <CalibrationWizard
        open={showCalibration}
        live={{
          fingerDetected: !!lastSignal?.fingerDetected,
          quality: lastSignal?.quality ?? 0,
          bpm: heartRate,
          spo2: vitalSigns.spo2,
          motionLevel: motionClassifierRef.current.classify(),
        }}
        onCancel={() => setShowCalibration(false)}
        onComplete={(baseline) => {
          setCalibrationBaseline(baseline);
          toast({
            title: 'Calibración completa',
            description: `BPM ${baseline.bpmMean.toFixed(1)} ± ${baseline.bpmSd.toFixed(1)} (n=${baseline.bpmSamples}) · SpO₂ ${baseline.spo2Mean.toFixed(1)} ± ${baseline.spo2Sd.toFixed(1)} (n=${baseline.spo2Samples})`,
          });
        }}
      />

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
    </>
  );
};

export default Index;
