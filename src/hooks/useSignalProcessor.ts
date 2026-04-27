import { useState, useEffect, useCallback, useRef } from 'react';
import type { ProcessedSignal, ProcessingError } from '../types/signal';

/**
 * SIGNAL PROCESSOR HOOK V3 — WEB WORKER EDITION
 *
 * Public API is preserved (drop-in replacement for the legacy in-thread hook).
 * All heavy work (ROI mask, AC/DC, ranker, bandpass, SQI) runs in the worker.
 * The main thread only:
 *   - posts ImageData (transferable buffer when possible) with a sequence id
 *   - tracks one-in-flight backpressure
 *   - mirrors processor outputs to React state
 *
 * Telemetry queries (RGB stats, position quality, debug info) are answered
 * with the LAST snapshot the worker pushed, so consumers stay synchronous.
 */
export const useSignalProcessor = () => {
  const workerRef = useRef<Worker | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const seqRef = useRef<number>(0);
  const droppedRef = useRef<number>(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [error, setError] = useState<ProcessingError | null>(null);
  const [framesProcessed, setFramesProcessed] = useState(0);

  const sessionIdRef = useRef<string>('');

  // Cached telemetry snapshots (synchronous reads for UI/perf).
  const rgbStatsRef = useRef({ redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, rgRatio: 0, ratioOfRatios: 0 });
  const posQualityRef = useRef({
    locked: false, drifting: false, spatialUniformity: 0, centerCoverage: 0,
    positionDrift: 0, guidance: 'COLOQUE SU DEDO', qualityScore: 0,
  });
  const debugInfoRef = useRef<any>({});

  const processingRef = useRef(false);

  // Periodic snapshot ticker for telemetry refresh from worker
  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `sig_${t}_${p}`;

    const worker = new Worker(new URL('../workers/ppgWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<any>) => {
      const msg = e.data;
      switch (msg?.type) {
        case 'READY':
          break;
        case 'SIGNAL': {
          setLastSignal(msg.signal as ProcessedSignal);
          setError(null);
          setFramesProcessed(prev => (prev + 1) % 10000);
          break;
        }
        case 'FRAME_DONE':
          inFlightRef.current = false;
          break;
        case 'ERROR':
          setError(msg.error as ProcessingError);
          inFlightRef.current = false;
          break;
        case 'RGB':
          rgbStatsRef.current = msg.stats;
          break;
        case 'POS':
          posQualityRef.current = msg.quality;
          break;
        case 'DEBUG':
          debugInfoRef.current = msg.info;
          break;
      }
    };

    worker.onerror = (ev) => {
      setError({
        code: 'WORKER_FATAL',
        message: ev.message || 'PPG worker crashed',
        timestamp: Date.now(),
      });
      inFlightRef.current = false;
    };

    worker.postMessage({ type: 'INIT', sessionId: sessionIdRef.current });

    // Telemetry snapshot loop — cheap, decoupled from frame rate.
    const tickerId = window.setInterval(() => {
      if (!workerRef.current || !processingRef.current) return;
      workerRef.current.postMessage({ type: 'GET_RGB' });
      workerRef.current.postMessage({ type: 'GET_POS' });
      workerRef.current.postMessage({ type: 'GET_DEBUG' });
    }, 200);

    return () => {
      window.clearInterval(tickerId);
      try { worker.postMessage({ type: 'STOP' }); } catch {}
      worker.terminate();
      workerRef.current = null;
      inFlightRef.current = false;
    };
  }, []);

  const startProcessing = useCallback(() => {
    if (!workerRef.current) return;
    if (isProcessing) return;
    seqRef.current = 0;
    droppedRef.current = 0;
    inFlightRef.current = false;
    setFramesProcessed(0);
    setError(null);
    processingRef.current = true;
    workerRef.current.postMessage({ type: 'START' });
    setIsProcessing(true);
  }, [isProcessing]);

  const stopProcessing = useCallback(() => {
    if (!workerRef.current) return;
    workerRef.current.postMessage({ type: 'STOP' });
    processingRef.current = false;
    setIsProcessing(false);
    setLastSignal(null);
    inFlightRef.current = false;
  }, []);

  const calibrate = useCallback(async () => {
    if (!workerRef.current) return false;
    workerRef.current.postMessage({ type: 'CALIBRATE' });
    return true;
  }, []);

  /**
   * Feed a frame into the worker.
   * Backpressure: if the worker is still processing the previous frame, drop this one.
   * We TRANSFER the underlying buffer to avoid a copy across the worker boundary.
   * We pass a defensive copy of the buffer to keep ImageData usable elsewhere if needed.
   */
  const processFrame = useCallback((imageData: ImageData, frameTimestamp?: number) => {
    if (!workerRef.current || !processingRef.current) return;
    if (inFlightRef.current) {
      droppedRef.current++;
      return;
    }
    inFlightRef.current = true;
    seqRef.current++;
    // Copy the pixel buffer so we can transfer it without invalidating the canvas's ImageData.
    const copy = new Uint8ClampedArray(imageData.data);
    workerRef.current.postMessage(
      {
        type: 'FRAME',
        data: copy,
        width: imageData.width,
        height: imageData.height,
        ts: frameTimestamp ?? performance.now(),
        seq: seqRef.current,
      },
      [copy.buffer]
    );
  }, []);

  const getRGBStats = useCallback(() => rgbStatsRef.current, []);
  const getPositionQuality = useCallback(() => posQualityRef.current, []);
  const getDebugInfo = useCallback(() => debugInfoRef.current, []);
  const getDroppedFrames = useCallback(() => droppedRef.current, []);

  return {
    isProcessing,
    lastSignal,
    error,
    framesProcessed,
    startProcessing,
    stopProcessing,
    calibrate,
    processFrame,
    getRGBStats,
    getPositionQuality,
    getDebugInfo,
    getDroppedFrames,
    debugInfo: {
      sessionId: sessionIdRef.current,
      workerActive: !!workerRef.current,
      backend: 'worker',
    },
  };
};
