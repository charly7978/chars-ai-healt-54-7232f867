import { useCallback, useEffect, useRef, useState } from "react";
import { CameraController } from "../camera/cameraController";
import { FrameLoop } from "../capture/frameLoop";
import { FrameDownsampler } from "../capture/downsample";
import { AdaptiveRoi } from "../roi/adaptiveRoi";
import { classifyFrame } from "../detection/fingerDetector";
import {
  PPG_CONFIG,
  type CameraDiagnostics,
  type PpgCaptureState,
  type PpgSignalSnapshot,
} from "../types";
import type { WorkerOutboundSnapshot } from "../worker/ppgWorker";
import PpgWorker from "../worker/ppgWorker?worker";
import {
  getPpgRuntimeConfig,
  subscribePpgRuntimeConfig,
} from "../config/ppgRuntimeConfig";

export interface UsePpgCaptureOptions {
  readonly video: HTMLVideoElement | null;
  readonly active: boolean;
}

export interface UsePpgCaptureResult {
  readonly state: PpgCaptureState;
  readonly diagnostics: CameraDiagnostics | null;
  readonly fingerDetected: boolean;
  readonly fpsInstant: number;
  readonly snapshot: PpgSignalSnapshot | null;
  readonly error: string | null;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * React orchestrator that wires the camera stream into the worker pipeline.
 *
 * Heavy work (PCA + bandpass + SQI) runs in the worker. The hook only updates
 * React state at most `STATE_THROTTLE_HZ` times per second to avoid render
 * thrash, even if the worker emits at the camera FPS.
 */
export function usePpgCapture(
  options: UsePpgCaptureOptions,
): UsePpgCaptureResult {
  const { video, active } = options;

  const [state, setState] = useState<PpgCaptureState>("idle");
  const [diagnostics, setDiagnostics] = useState<CameraDiagnostics | null>(
    null,
  );
  const [fingerDetected, setFingerDetected] = useState(false);
  const [fpsInstant, setFpsInstant] = useState(0);
  const [snapshot, setSnapshot] = useState<PpgSignalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<CameraController | null>(null);
  const loopRef = useRef<FrameLoop | null>(null);
  const downsamplerRef = useRef<FrameDownsampler | null>(null);
  const roiRef = useRef<AdaptiveRoi | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const lastUiUpdateRef = useRef(0);
  const fingerRef = useRef(false);
  const fpsRef = useRef(0);
  const configRef = useRef(getPpgRuntimeConfig());

  const stop = useCallback(async () => {
    loopRef.current?.stop();
    loopRef.current = null;
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (controllerRef.current) {
      await controllerRef.current.stop();
      controllerRef.current = null;
    }
    downsamplerRef.current = null;
    roiRef.current = null;
    setState("idle");
    setFingerDetected(false);
    setFpsInstant(0);
    setSnapshot(null);
  }, []);

  const start = useCallback(async () => {
    if (!video) {
      setError("Video element not ready.");
      return;
    }
    setError(null);
    setState("starting");
    try {
      const controller = new CameraController();
      controllerRef.current = controller;
      const result = await controller.start();
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch {
        // iOS may reject play() until a user gesture; the loop still runs.
      }
      setDiagnostics(result.diagnostics);

      const downsampler = new FrameDownsampler();
      downsamplerRef.current = downsampler;
      const cfg = configRef.current;
      const roi = new AdaptiveRoi(cfg.roi.cols, cfg.roi.rows);
      roiRef.current = roi;

      const worker = new PpgWorker();
      workerRef.current = worker;
      worker.postMessage({ type: "config", sqi: cfg.sqi });
      worker.addEventListener("message", (ev: MessageEvent<WorkerOutboundSnapshot>) => {
        const data = ev.data;
        if (!data || data.type !== "snapshot") return;
        const truncated = data.filtered.slice(0, data.samples);
        const next: PpgSignalSnapshot = {
          filtered: truncated,
          sqi: data.sqi,
          perfusionIndex: data.perfusionIndex,
          skewness: data.skewness,
          kurtosis: data.kurtosis,
          fpsActual: data.fpsActual,
        };
        const now = performance.now();
        const minInterval = 1000 / PPG_CONFIG.STATE_THROTTLE_HZ;
        if (now - lastUiUpdateRef.current < minInterval) return;
        lastUiUpdateRef.current = now;
        setSnapshot(next);
        setFingerDetected(fingerRef.current);
        setFpsInstant(fpsRef.current);
      });

      const loop = new FrameLoop(video, (timing) => {
        const ds = downsamplerRef.current;
        const region = roiRef.current;
        const w = workerRef.current;
        if (!ds || !region || !w) return;
        const rgba = ds.capture(video);
        const detection = classifyFrame(rgba, configRef.current.finger);
        const aggregate = region.process(rgba, ds.width, ds.height);
        fingerRef.current = detection.fingerDetected;
        fpsRef.current = timing.fpsInstant;

        const payload = new Float32Array(4);
        payload[0] = aggregate.weightedR;
        payload[1] = aggregate.weightedG;
        payload[2] = aggregate.weightedB;
        payload[3] = timing.fpsInstant;
        w.postMessage({ type: "sample", payload }, [payload.buffer]);
      });
      loopRef.current = loop;
      loop.start();

      setState(result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Capture failed.");
      setState("error");
      await stop();
    }
  }, [video, stop]);

  useEffect(() => {
    if (active) void start();
    return () => {
      void stop();
    };
    // start/stop intentionally re-run when dependencies change.
  }, [active, start, stop]);

  // React to runtime tuning without restarting the camera.
  useEffect(() => {
    return subscribePpgRuntimeConfig((next) => {
      configRef.current = next;
      roiRef.current?.setGrid(next.roi.cols, next.roi.rows);
      workerRef.current?.postMessage({ type: "config", sqi: next.sqi });
    });
  }, []);

  return {
    state,
    diagnostics,
    fingerDetected,
    fpsInstant,
    snapshot,
    error,
    start,
    stop,
  };
}
