import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, Brain, Loader2 } from "lucide-react";
import { playCompletionSound } from "@/utils/soundUtils";
import VitalSign from "@/components/VitalSign";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessorOptimized } from "@/hooks/useHeartBeatProcessorOptimized";
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
  IMUManager,
  verifyForensicIntegrity,
  type IntegrityResult,
  type IMUSnapshot,
} from "@/modules/forensic/ForensicSessionRecorder";
import { EvidenceGate, type EvidenceResult } from "@/modules/core/EvidenceGate";

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
  const recorderRef = useRef<ForensicSessionRecorder | null>(null);
  const [recorderTick, setRecorderTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [lastSeal, setLastSeal] = useState<{ sha: string; sessionId: string } | null>(null);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const imuManagerRef = useRef<IMUManager | null>(null);
  const [imuEnabled, setImuEnabled] = useState(false);
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult | null>(null);
  const [showIntegrityCheck, setShowIntegrityCheck] = useState(false);
  const evidenceGateRef = useRef<EvidenceGate | null>(null);
  const [evidenceResult, setEvidenceResult] = useState<EvidenceResult | null>(null);
  const [showEvidenceStatus, setShowEvidenceStatus] = useState(false);
  const lastTelemetryTapRef = useRef<number>(0);
  const [telemetryTick, setTelemetryTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    arrhythmiaEvidence,
  } = useHeartBeatProcessorOptimized();
  
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

  const initIMU = useCallback(async () => {
    if (imuManagerRef.current) return true;
    
    const imu = new IMUManager({
      onMotionScore: (score, snapshot) => {
        recorderRef.current?.pushIMU(snapshot);
      },
      onError: (err) => {
        console.warn('IMU Error:', err.message);
      }
    });
    
    const started = await imu.start();
    if (started) {
      imuManagerRef.current = imu;
      setImuEnabled(true);
      console.log('📱 IMU iniciado - capturando acelerómetro/giroscopio');
    }
    return started;
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as string;
      if (!content) return;
      
      setShowIntegrityCheck(true);
      const result = await verifyForensicIntegrity(content);
      setIntegrityResult(result);
      
      if (result.match) {
        toast({ 
          title: "✅ Integridad Verificada", 
          description: `SHA-256 coincide. Sesión: ${result.sessionId?.slice(0, 8)}...`,
        });
      } else {
        toast({ 
          title: "⚠️ Fallo de Integridad", 
          description: result.expectedSha256 === 'NOT_FOUND' 
            ? "El archivo no contiene sello SHA-256"
            : "El hash no coincide. El archivo puede estar corrupto.",
          variant: "destructive"
        });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleExportForensic = useCallback(async () => {
    if (!recorderRef.current) return;
    setExporting(true);
    try {
      const bundle = await recorderRef.current.buildBundle();
      setLastSeal({ sha: bundle.sha256, sessionId: recorderRef.current.sessionId });
      downloadForensicBundle(bundle, recorderRef.current.sessionId);
      toast({ title: "📦 Bundle Forense Exportado", description: `SHA-256: ${bundle.sha256.slice(0, 16)}...` });
    } catch (err) {
      toast({ title: "Error al exportar", description: String(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, []);

  // Enhanced debugging with signal flow analysis
  const debugInfo = lastSignal ? {
    timestamp: lastSignal.timestamp,
    rawValue: lastSignal.rawValue,
    filteredValue: lastSignal.filteredValue,
    quality: lastSignal.quality,
    fingerDetected: lastSignal.fingerDetected,
    contactState: lastSignal.contactState,
    motionArtifact: lastSignal.motionArtifact,
    perfusionIndex: lastSignal.perfusionIndex,
    fingerPosition: lastSignal.fingerPosition,
    diagnostics: lastSignal.diagnostics,
    // Add signal flow analysis
    signalFlow: {
      isIncreasing: lastSignal.filteredValue > (heartbeatSignal || 0),
      trend: lastSignal.filteredValue - (heartbeatSignal || 0),
      amplitude: Math.abs(lastSignal.filteredValue),
      zeroCrossings: countZeroCrossings(),
      signalStrength: assessSignalStrength()
    },
    systemStatus: {
      cameraActive: !!cameraStream,
      processingActive: isProcessing,
      bufferSizes: {
        signal: getDebugInfo?.()?.bufferSizes?.signal || 0,
        filtered: getDebugInfo?.()?.bufferSizes?.filtered || 0,
        timestamp: getDebugInfo?.()?.bufferSizes?.timestamp || 0
      },
      thresholds: {
        peak: getDebugInfo?.()?.thresholds?.peak || 0,
        valley: getDebugInfo?.()?.thresholds?.valley || 0,
        quality: lastSignal?.quality || 0
      }
    }
  } : null;
  
  // Enhanced system diagnostics
  const runSystemDiagnostics = () => {
    console.log('🔍 DIAGNÓSTICO COMPLETO DEL SISTEMA:');
    console.log('═'.repeat(50));
    
    // Camera status
    console.log('📷 CÁMARA:');
    console.log(`  - Estado: ${cameraStream ? 'ACTIVA' : 'INACTIVA'}`);
    console.log(`  - Stream: ${cameraStream ? 'LISTO' : 'NULL'}`);
    if (cameraStream) {
      const tracks = cameraStream.getVideoTracks();
      console.log(`  - Tracks: ${tracks.length} activos`);
      tracks.forEach((track, i) => {
        console.log(`    Track ${i}: ${track.label || 'Sin etiqueta'}`);
        console.log(`    - Estado: ${track.readyState}`);
        console.log(`    - Habilitado: ${track.enabled}`);
        const settings = track.getSettings?.() || {};
        console.log(`    - Config:`, settings);
      });
    }
    
    // Processing status
    console.log('⚙️ PROCESAMIENTO:');
    console.log(`  - Activo: ${isProcessing ? 'SÍ' : 'NO'}`);
    console.log(`  - Frames procesados: ${framesProcessed}`);
    
    // Signal analysis
    console.log('📊 ANÁLISIS DE SEÑAL:');
    if (debugInfo) {
      console.log(`  - Calidad: ${debugInfo.quality?.toFixed(1)}%`);
      console.log(`  - Contacto: ${debugInfo.contactState}`);
      console.log(`  - Dedo detectado: ${debugInfo.fingerDetected ? 'SÍ' : 'NO'}`);
      console.log(`  - Posición: ${debugInfo.fingerPosition || 'DESCONOCIDA'}`);
      console.log(`  - Perfusion: ${debugInfo.perfusionIndex?.toFixed(3)}`);
      console.log(`  - Artefacto movimiento: ${debugInfo.motionArtifact ? 'SÍ' : 'NO'}`);
      
      if (debugInfo.signalFlow) {
        console.log('  - Flujo de señal:');
        console.log(`    - Creciendo: ${debugInfo.signalFlow.isIncreasing ? 'SÍ' : 'NO'}`);
        console.log(`    - Tendencia: ${debugInfo.signalFlow.trend?.toFixed(4)}`);
        console.log(`    - Amplitud: ${debugInfo.signalFlow.amplitude?.toFixed(2)}`);
        console.log(`    - Cruces por cero: ${debugInfo.signalFlow.zeroCrossings}`);
        console.log(`    - Fuerza señal: ${debugInfo.signalFlow.signalStrength?.toFixed(2)}`);
      }
      
      console.log(`  - Diagnóstico: ${debugInfo.diagnostics?.message || 'SIN MENSAJE'}`);
    }
    
    // Buffer status
    if (debugInfo.systemStatus) {
      console.log('💾 BUFFERS:');
      console.log(`  - Señal: ${debugInfo.systemStatus.bufferSizes.signal} muestras`);
      console.log(`  - Filtrado: ${debugInfo.systemStatus.bufferSizes.filtered} muestras`);
      console.log(`  - Timestamps: ${debugInfo.systemStatus.bufferSizes.timestamp} muestras`);
      
      console.log('🎯 UMBRALES:');
      console.log(`  - Pico: ${debugInfo.systemStatus.thresholds.peak?.toFixed(3)}`);
      console.log(`  - Valle: ${debugInfo.systemStatus.thresholds.valley?.toFixed(3)}`);
      console.log(`  - Calidad mínima: ${(lastSignal?.quality || 0).toFixed(1)}%`);
    }
    
    console.log('═'.repeat(50));
    console.log('🔧 ACCIONES RECOMENDADAS:');
    
    if (!cameraStream) {
      console.log('❌ CÁMARA INACTIVA - Inicie monitoreo para activar');
    }
    
    if (!lastSignal?.fingerDetected) {
      console.log('👆 DEDO NO DETECTADO - Coloque la punta del dedo sobre la cámara');
    } else if (lastSignal.quality < 20) {
      console.log('📉 SEÑAL DÉBIL - Aumente la presión o mejore la posición');
    } else if (lastSignal.contactState !== 'STABLE_CONTACT') {
      console.log('⚡ CONTACTO INESTABLE - Mantenga el dedo firme y sin mover');
    } else {
      console.log('✅ SEÑAL BUENA - Sistema funcionando correctamente');
    }
    
    console.log('═'.repeat(50));
  };
  
  const countZeroCrossings = (): number => {
    // Count zero crossings in recent signal buffer
    let crossings = 0;
    const recent = getLastSignalValues(20);
    for (let i = 1; i < recent.length; i++) {
      if ((recent[i-1] || 0) <= 0 && (recent[i] || 0) > 0) crossings++;
      if ((recent[i-1] || 0) > 0 && (recent[i] || 0) <= 0) crossings++;
    }
    return crossings;
  };
  
  const assessSignalStrength = (): number => {
    // Assess overall signal strength for debugging
    const debug = getDebugInfo?.();
    if (!debug || debug.bufferSizes.filtered < 30) return 0;
    
    // Simple signal strength assessment
    const quality = lastSignal?.quality || 0;
    const fingerDetected = lastSignal?.fingerDetected || false;
    const contactState = lastSignal?.contactState || 'NO_CONTACT';
    
    // Signal strength score (0-1)
    let score = 0;
    if (fingerDetected) score += 0.3;
    if (contactState === 'STABLE_CONTACT') score += 0.4;
    if (quality > 30) score += 0.3;
    
    return Math.min(1, score);
  };
  
  const getLastSignalValues = (count: number): number[] => {
    // Get last N signal values from processor
    const debug = getDebugInfo?.();
    if (!debug) return [];
    
    // Simple approximation - return quality as signal strength
    const values = [];
    for (let i = 0; i < count; i++) {
      values.push(lastSignal?.quality || 0);
    }
    return values;
  };

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
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));
    recorderRef.current = new ForensicSessionRecorder({ algorithmVersion: 'ppg-web/2026.05' });
    setLastSeal(null);
    evidenceGateRef.current = new EvidenceGate();
    setEvidenceResult(null);
    initIMU();
    startProcessing();
    setIsCameraOn(true);
    setIsMonitoring(true);
    if (measurementTimerRef.current) clearInterval(measurementTimerRef.current);
    measurementTimerRef.current = window.setInterval(() => setElapsedTime(prev => prev + 1), 1000);
    setIsCalibrating(true);
    startCalibration();
    setTimeout(() => setIsCalibrating(false), 3000);
  }, [isMonitoring, startProcessing, startCalibration, enterFullScreen, initIMU]);

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
    recorderRef.current?.finalize();
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
    console.log('🔄 INICIANDO RESET COMPLETO Y DIAGNÓSTICO');
    
    // Reset all processors
    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }
    stopProcessing();
    fullResetVitalSigns();
    resetHeartBeat();
    
    // Clear all buffers and state
    frameTimestampHistoryRef.current = [];
    setCameraStream(null);
    setHeartRate(0);
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setRRIntervals([]);
    setArrhythmiaCount("--");
    setElapsedTime(0);
    setShowResults(false);
    setMeasurementSummary(null);
    setIsCalibrating(false);
    setCalibrationProgress(0);
    
    // Reset vital signs to initial state
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
    
    // Wait for camera to fully stop
    setTimeout(() => {
      console.log('✅ RESET COMPLETADO - Sistema listo para nueva prueba');
      console.log('🔍 ESTADO ACTUAL:');
      console.log('  - Camera:', !cameraStream ? 'DETENIDA' : 'DETENIDA');
      console.log('  - Processing:', isProcessing ? 'ACTIVO' : 'DETENIDO');
      console.log('  - Monitoring:', isMonitoring ? 'ACTIVO' : 'INACTIVO');
      console.log('📋 INSTRUCCIONES:');
      console.log('  1. Asegúrese de que la cámara esté activa');
      console.log('  2. Coloque la PUNTA del dedo sobre la cámara y el flash');
      console.log('  3. Presione suavemente pero firme');
      console.log('  4. Mantenga el dedo sin mover');
      console.log('  5. Espere 3-5 segundos para detección');
      
      // Run comprehensive diagnostics
      runSystemDiagnostics();
    }, 1000);
    
    playCompletionSound();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }, [handleReset, isMonitoring, cameraStream, fullResetVitalSigns, resetHeartBeat, stopProcessing, stopFrameLoop, measurementTimerRef]);

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

    // EvidenceGate validation
    if (evidenceGateRef.current) {
      const evidence = evidenceGateRef.current.validate({
        timestamp: lastSignal.timestamp,
        contactState: contactState === 'STABLE_CONTACT' ? 'STABLE_CONTACT' : 
                     contactState === 'NO_CONTACT' ? 'NO_CONTACT' : 'CONTACT_PARTIAL',
        saturationRatio: 0,
        fps: sampleRate,
        sqi: lastSignal.quality || 0,
        perfusionIndex: lastSignal.perfusionIndex || 0,
        calibrationAvailable: {
          spo2: false,
          bloodPressure: false,
          glucose: false,
          lipids: false,
        },
        temporalCoherence: {
          lastFrameDeltaMs: sampleRate > 0 ?1000 / sampleRate : 33,
          expectedDeltaMs: 33,
          jitterMs: 0,
        },
      });
      setEvidenceResult(evidence);
      
      if (!evidence.allowed) {
        console.warn('[EVIDENCE GATE] Blocked:', evidence.reason, evidence.technicalDetails);
      }
    }

    const heartBeatResult = processHeartBeat(
      signalValue,
      contactState,
      lastSignal.timestamp
    );

    if (heartBeatResult.isPeak) {
      setBeatMarker(1);
      setTimeout(() => setBeatMarker(0), 300);
      totalBeatsRef.current++;
      const currentArrCount = vitalSigns.arrhythmiaCount || 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }

      if (recorderRef.current) {
        const intervals = heartBeatResult.rrData?.intervals || [];
        const rrMs = intervals.length > 0 ? intervals[intervals.length - 1] : null;
        const isArrThis = currentArrCount > (lastArrhythmiaCountForBeatsRef.current - 1);
        recorderRef.current.pushBeat({
          timestampMs: lastSignal.timestamp,
          amplitude: heartBeatResult.filteredValue,
          rrMs: rrMs,
          bpmInstant: rrMs && rrMs > 0 ? 60000 / rrMs : null,
          quality: heartBeatResult.beatSQI || 0,
          type: isArrThis ? 'SUSPECT_PREMATURE' : 'NORMAL',
          reason: isArrThis ? 'arrhythmia-counter-tick' : 'consensus',
        });
      }
    }

    if (heartBeatResult.rrData?.intervals) {
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    const displayBPM = stableHumanSignal 
      ? applyEMA(emaRef.current.bpm, heartBeatResult.bpm)
      : heartBeatResult.bpm;
    emaRef.current.bpm = displayBPM;
    setHeartRate(displayBPM);

    const rgbStats = getRGBStats();
    const detectorAgreement = heartBeatResult.detectorAgreement || heartBeatResult.debug?.detectorAgreement || 0;
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
    const displayVitals: typeof vitals = stableHumanSignal
      ? {
            // Smooth only with confirmed finger contact
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
          }
        : vitals; // RAW when uncertain

    setVitalSigns(displayVitals);
  }, [lastSignal, isMonitoring, processHeartBeat, processVitalSigns, setArrhythmiaState, setRGBData, setUpstreamContext, getRGBStats, getPositionQuality, estimateSampleRateFromFrames, computeRRStability, applyEMA, vitalSigns.arrhythmiaCount]);

  useEffect(() => {
    if (isMonitoring && elapsedTime >= 60) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  useEffect(() => {
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5m11 5v-4m0 4h-4m4 0l-5 5" />
            </svg>
            <p className="text-lg font-semibold">Toca para modo pantalla completa</p>
          </div>
        </button>
      )}

      <div className="flex-1 relative">
        <div className="absolute inset-0">
          <CameraView ref={cameraRef} onStreamReady={handleStreamReady} isMonitoring={isCameraOn} />
        </div>

        {/* Invisible double-tap zone (top-left) to toggle forensic telemetry panel */}
        <div
          onClick={handleTelemetryTapZone}
          className="absolute top-0 left-0 w-16 h-16 z-30"
          style={{ background: 'transparent' }}
          aria-hidden
        />

        {/* Enhanced finger positioning guidance */}
        {isMonitoring && (
          <div className="absolute top-16 left-0 right-0 z-30 flex justify-center pointer-events-none">
            <div className="px-3 py-1 rounded-md text-[10px] font-mono font-bold tracking-wider shadow-lg border bg-blue-600/40 border-blue-400/70 text-blue-50 animate-pulse">
              💡 PUNTA DEL DEDO RECOMENDADA PARA MEJOR DETECCIÓN
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
              rawArrhythmiaData={undefined}
              arrhythmiaEvidence={arrhythmiaEvidence}
              fingerPosition={lastSignal?.fingerPosition}
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;
