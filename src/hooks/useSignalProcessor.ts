
import { useState, useEffect, useCallback, useRef } from 'react';
import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import { ProcessedSignal, ProcessingError } from '../types/signal';
import {
  loadBackpressureConfig,
  saveBackpressureConfig,
  type BackpressureConfig,
} from '../lib/perf/backpressureConfig';

/**
 * HOOK ÚNICO Y DEFINITIVO - ELIMINADAS TODAS LAS DUPLICIDADES
 * Sistema completamente unificado con prevención absoluta de múltiples instancias
 */
export const useSignalProcessor = () => {
  const processorRef = useRef<PPGSignalProcessor | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [error, setError] = useState<ProcessingError | null>(null);
  const [framesProcessed, setFramesProcessed] = useState(0);
  const [currentStride, setCurrentStride] = useState<number>(3);
  
  // CONTROL ÚNICO DE INSTANCIA - PREVENIR DUPLICIDADES ABSOLUTAMENTE
  const instanceLock = useRef<boolean>(false);
  const sessionIdRef = useRef<string>("");
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');
  
  // INICIALIZACIÓN ÚNICA Y DEFINITIVA
  useEffect(() => {
    // BLOQUEO DE MÚLTIPLES INSTANCIAS
    if (instanceLock.current || initializationState.current !== 'IDLE') {
      return;
    }
    
    instanceLock.current = true;
    initializationState.current = 'INITIALIZING';
    
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `sig_${t}_${p}`;

    // CALLBACKS ÚNICOS SIN MEMORY LEAKS
    const onSignalReady = (signal: ProcessedSignal) => {
      if (initializationState.current !== 'READY') return;
      
      setLastSignal(signal);
      setError(null);
      // CRÍTICO: Limitar contador para evitar números infinitos que afectan rendimiento
      setFramesProcessed(prev => (prev + 1) % 10000);
    };

    const onError = (error: ProcessingError) => {
      console.error(`Error procesador: ${error.code}`);
      setError(error);
    };

    // CREAR PROCESADOR ÚNICO
    try {
      processorRef.current = new PPGSignalProcessor(onSignalReady, onError);
      // Aplicar configuración persistida del backpressure
      try { processorRef.current.setBackpressureConfig(loadBackpressureConfig()); } catch {}
      initializationState.current = 'READY';
    } catch (err) {
      initializationState.current = 'ERROR';
      instanceLock.current = false;
    }
    
    return () => {
      if (processorRef.current) {
        processorRef.current.stop();
        processorRef.current = null;
      }
      initializationState.current = 'IDLE';
      instanceLock.current = false;
    };
  }, []);

  // INICIO ÚNICO SIN DUPLICIDADES
  const startProcessing = useCallback(() => {
    if (!processorRef.current || initializationState.current !== 'READY') {
      return;
    }

    if (isProcessing) {
      return;
    }
    
    setIsProcessing(true);
    setFramesProcessed(0);
    setError(null);
    
    processorRef.current.start();
  }, [isProcessing]);

  // PARADA ÚNICA Y LIMPIA - SIN DEPENDER DE isProcessing STATE
  const stopProcessing = useCallback(() => {
    if (!processorRef.current) {
      return;
    }
    
    // Primero detener el procesador, luego actualizar estado
    processorRef.current.stop();
    setIsProcessing(false);
    setLastSignal(null);
    setFramesProcessed(0);
  }, []);

  // CALIBRACIÓN ÚNICA
  const calibrate = useCallback(async () => {
    if (!processorRef.current || initializationState.current !== 'READY') {
      return false;
    }

    try {
      const success = await processorRef.current.calibrate();
      return success;
    } catch (error) {
      return false;
    }
  }, []);

  // PROCESAMIENTO DE FRAME ÚNICO
  const processFrame = useCallback((imageData: ImageData) => {
    if (!processorRef.current || initializationState.current !== 'READY' || !isProcessing) {
      return;
    }
    
    try {
      processorRef.current.processFrame(imageData);
    } catch (error) {
      // Error silenciado para rendimiento
    }
  }, [isProcessing]);

  // OBTENER ESTADÍSTICAS RGB REALES PARA SpO2
  const getRGBStats = useCallback(() => {
    if (!processorRef.current) {
      return {
        redAC: 0,
        redDC: 0,
        greenAC: 0,
        greenDC: 0,
        rgRatio: 0,
        ratioOfRatios: 0
      };
    }
    return processorRef.current.getRGBStats();
  }, []);

  // Estado de backpressure (stride adaptativo + fps estimado) para telemetría
  const getBackpressureState = useCallback(() => {
    if (!processorRef.current) return { pixelStride: 3, estimatedSampleRate: 0, activeSource: 'RG' };
    return processorRef.current.getBackpressureState();
  }, []);

  const getBackpressureConfig = useCallback((): BackpressureConfig => {
    if (!processorRef.current) return loadBackpressureConfig();
    return processorRef.current.getBackpressureConfig();
  }, []);

  const setBackpressureConfig = useCallback((partial: Partial<BackpressureConfig>): BackpressureConfig => {
    const cfg = processorRef.current
      ? processorRef.current.setBackpressureConfig(partial)
      : { ...loadBackpressureConfig(), ...partial };
    saveBackpressureConfig(cfg);
    return cfg;
  }, []);

  // Polling ligero (1 Hz) del stride activo durante la medición. Permite a la
  // UI reaccionar a cambios automáticos del backpressure adaptativo sin tocar
  // el hot path del procesador.
  useEffect(() => {
    if (!isProcessing) return;
    const tick = () => {
      if (!processorRef.current) return;
      try {
        const s = processorRef.current.getBackpressureState().pixelStride;
        setCurrentStride((prev) => (prev !== s ? s : prev));
      } catch {}
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isProcessing]);

  return {
    isProcessing,
    lastSignal,
    error,
    framesProcessed,
    currentStride,
    startProcessing,
    stopProcessing,
    calibrate,
    processFrame,
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    setBackpressureConfig,
    debugInfo: {
      sessionId: sessionIdRef.current,
      initializationState: initializationState.current,
      instanceLocked: instanceLock.current
    }
  };
};
