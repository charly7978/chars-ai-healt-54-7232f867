import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraViewHandle } from "@/components/CameraView";

/**
 * usePpgCamera — Single source of truth for camera + torch + frame loop.
 *
 * Centralises everything that used to live as a tangle of refs in Index.tsx:
 *  • `isCameraOn` state that <CameraView/> binds to via `isMonitoring` prop
 *  • the rVFC-driven frame loop with stall detection (no setInterval / rAF poll)
 *  • event-driven dead-stream watchdog via track.ended / track.mute listeners
 *  • generation tokens so a stream bounce can never fire a stale callback
 *
 * The hook is deliberately UI-agnostic. It does not know what a "vital sign"
 * is. It just delivers `(imageData, frameTimestamp)` callbacks and exposes
 * the camera lifecycle as `start()` / `stop()` / `bounce()`.
 */

export interface PpgCameraOptions {
  /** Ref to the mounted <CameraView/> so we can read its <video> element. */
  cameraRef: React.RefObject<CameraViewHandle>;
  /** Called for every captured frame that wasn't dropped by the caller. */
  onFrame: (imageData: ImageData, frameTimestamp: number) => void;
  /**
   * Optional per-frame drop predicate (e.g. severe IMU motion). Returning true
   * skips the heavy `drawImage + getImageData + onFrame` work for that tick
   * while still bookkeeping rVFC timing.
   */
  shouldDropFrame?: (nowMs: number) => boolean;
  /** Called once per drop decision (true=drop, false=processed). */
  onFrameDecision?: (nowMs: number, dropped: boolean) => void;
  /** Soft cap for capture canvas width. Height scales to preserve AR. */
  maxCaptureWidth?: number;
  /** Min pixel dims so AdaptiveROIMask never receives a sub-resolution frame. */
  minCaptureWidth?: number;
  minCaptureHeight?: number;
  /** Inter-frame gap (ms) above which we log a soft-restart event. */
  stallMs?: number;
  /** Cooldown after a track.ended / track.mute event before re-arming. */
  bounceDelayMs?: number;
}

export interface PpgCameraApi {
  /** Bound to <CameraView isMonitoring={cameraOn} />. */
  cameraOn: boolean;
  /** Bound to <CameraView onStreamReady={onStreamReady} />. */
  onStreamReady: (stream: MediaStream) => void;
  /** Most recent MediaStream the platform handed us (for diagnostics). */
  stream: MediaStream | null;
  /** Open camera + frame loop. Idempotent. */
  start: () => void;
  /** Close camera + frame loop. Idempotent. */
  stop: () => void;
  /** Force a quick close→open cycle (used by external recovery logic). */
  bounce: (delayMs?: number) => void;
  /** Diagnostics — number of rVFC stalls auto-recovered this session. */
  getSoftRestartCount: () => number;
  /** ms timestamp of the last processed (or scheduled) frame. */
  getLastFrameAt: () => number;
}

const DEFAULTS = {
  maxCaptureWidth: 640,
  minCaptureWidth: 320,
  minCaptureHeight: 240,
  stallMs: 1500,
  bounceDelayMs: 800,
};

export function usePpgCamera(opts: PpgCameraOptions): PpgCameraApi {
  const {
    cameraRef,
    onFrame,
    shouldDropFrame,
    onFrameDecision,
  } = opts;
  const maxCaptureWidth = opts.maxCaptureWidth ?? DEFAULTS.maxCaptureWidth;
  const minCaptureWidth = opts.minCaptureWidth ?? DEFAULTS.minCaptureWidth;
  const minCaptureHeight = opts.minCaptureHeight ?? DEFAULTS.minCaptureHeight;
  const stallMs = opts.stallMs ?? DEFAULTS.stallMs;
  const bounceDelayMs = opts.bounceDelayMs ?? DEFAULTS.bounceDelayMs;

  const [cameraOn, setCameraOn] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);

  // Latest callbacks in refs so the frame-loop closure stays stable across
  // parent re-renders (otherwise startFrameLoop would tear down/restart on
  // every render, exactly what we're trying to fix).
  const onFrameRef = useRef(onFrame);
  const shouldDropRef = useRef(shouldDropFrame);
  const onFrameDecisionRef = useRef(onFrameDecision);
  useEffect(() => { onFrameRef.current = onFrame; }, [onFrame]);
  useEffect(() => { shouldDropRef.current = shouldDropFrame; }, [shouldDropFrame]);
  useEffect(() => { onFrameDecisionRef.current = onFrameDecision; }, [onFrameDecision]);

  // Lifecycle intent — true between start() and stop(). Read by event handlers
  // and the auto-bounce path so they don't re-arm a stopped camera.
  const monitoringIntentRef = useRef(false);
  // Generation token: any in-flight rVFC callback compares against this and
  // exits if it's stale (stop() bumps the counter).
  const frameLoopGenerationRef = useRef(0);
  // Whether the loop is currently armed. Idempotency guard for startFrameLoop.
  const isProcessingRef = useRef(false);
  // rAF fallback handle for browsers without rVFC.
  const rafIdRef = useRef<number | null>(null);

  // Diagnostics
  const lastFrameAtRef = useRef<number>(0);
  const softRestartCountRef = useRef<number>(0);

  // Capture canvas — created once, reused across sessions to avoid alloc churn.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  if (typeof document !== "undefined" && !canvasRef.current) {
    const c = document.createElement("canvas");
    c.width = minCaptureWidth;
    c.height = minCaptureHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      canvasRef.current = c;
      ctxRef.current = ctx;
    }
  }

  // Track listener cleanup for the currently-bound stream.
  const trackListenersCleanupRef = useRef<(() => void) | null>(null);
  const detachTrackListeners = () => {
    if (trackListenersCleanupRef.current) {
      trackListenersCleanupRef.current();
      trackListenersCleanupRef.current = null;
    }
  };

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    frameLoopGenerationRef.current++;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;
    const generation = ++frameLoopGenerationRef.current;

    let canvasSized = false;
    let lastErrorLogAt = 0;

    const sizeCanvasToVideo = (video: HTMLVideoElement) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, maxCaptureWidth / vw);
      const w = Math.max(minCaptureWidth, Math.round(vw * scale));
      const h = Math.max(minCaptureHeight, Math.round(vh * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvasSized = true;
    };

    const captureOneFrame = (frameTimestamp: number) => {
      if (!isProcessingRef.current || generation !== frameLoopGenerationRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        scheduleNext(video ?? null);
        return;
      }
      if (!canvasSized) sizeCanvasToVideo(video);

      const nowMs = performance.now();
      const prevFrameAt = lastFrameAtRef.current;
      if (prevFrameAt > 0 && nowMs - prevFrameAt > stallMs) {
        // rVFC chain stalled and recovered on its own. No restart needed.
        softRestartCountRef.current++;
        console.warn(
          "🔄 rVFC stall recovered:",
          (nowMs - prevFrameAt).toFixed(0),
          "ms gap (#",
          softRestartCountRef.current,
          ")",
        );
      }
      lastFrameAtRef.current = nowMs;

      try {
        const drop = shouldDropRef.current?.(nowMs) ?? false;
        onFrameDecisionRef.current?.(nowMs, drop);
        if (!drop) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          onFrameRef.current(imageData, frameTimestamp);
        }
      } catch (e) {
        if (nowMs - lastErrorLogAt > 2000) {
          lastErrorLogAt = nowMs;
          console.error("Frame capture error:", e);
        }
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement | null) => {
      if (!isProcessingRef.current || generation !== frameLoopGenerationRef.current) return;
      const v = video ?? cameraRef.current?.getVideoElement() ?? null;
      if (!v) return;
      if ("requestVideoFrameCallback" in v) {
        (v as unknown as {
          requestVideoFrameCallback: (cb: (now: number, metadata: { mediaTime?: number; presentationTime?: number }) => void) => number;
        }).requestVideoFrameCallback((_now, metadata) => {
          if (!isProcessingRef.current || generation !== frameLoopGenerationRef.current) return;
          const ts =
            (typeof metadata?.mediaTime === "number" ? metadata.mediaTime * 1000 : null)
            ?? (typeof metadata?.presentationTime === "number" ? metadata.presentationTime : null)
            ?? performance.now();
          captureOneFrame(ts);
        });
      } else {
        rafIdRef.current = requestAnimationFrame(() =>
          captureOneFrame(performance.now()),
        );
      }
    };

    scheduleNext(null);
  }, [cameraRef, maxCaptureWidth, minCaptureWidth, minCaptureHeight, stallMs]);

  const onStreamReady = useCallback(
    (incoming: MediaStream) => {
      setStream(incoming);
      detachTrackListeners();

      const tracks = incoming.getVideoTracks();
      const onDead = (reason: string) => () => {
        if (!monitoringIntentRef.current) return;
        console.warn("🎥 Track event:", reason, "— bouncing camera");
        setCameraOn(false);
        window.setTimeout(() => {
          if (monitoringIntentRef.current) {
            setCameraOn(true);
            lastFrameAtRef.current = performance.now();
          }
        }, bounceDelayMs);
      };
      const handlers: Array<() => void> = [];
      tracks.forEach((track) => {
        const ended = onDead(`track.ended (${track.label || "video"})`);
        const muted = onDead(`track.muted (${track.label || "video"})`);
        track.addEventListener("ended", ended);
        track.addEventListener("mute", muted);
        handlers.push(() => {
          track.removeEventListener("ended", ended);
          track.removeEventListener("mute", muted);
        });
      });
      trackListenersCleanupRef.current = () => handlers.forEach((fn) => fn());

      // Wait one tick for the <video> element to publish dimensions, then
      // arm the frame loop. We deliberately don't poll — rVFC will fire
      // when the first real frame arrives.
      window.setTimeout(() => {
        const video = cameraRef.current?.getVideoElement();
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          startFrameLoop();
        } else {
          // Last-resort short retry window for browsers slow to publish
          // metadata. This is the *only* setInterval in the camera path.
          const checkReady = window.setInterval(() => {
            const v = cameraRef.current?.getVideoElement();
            if (v && v.readyState >= 2 && v.videoWidth > 0) {
              window.clearInterval(checkReady);
              startFrameLoop();
            }
          }, 100);
          window.setTimeout(() => window.clearInterval(checkReady), 5000);
        }
      }, 500);
    },
    [bounceDelayMs, cameraRef, startFrameLoop],
  );

  const start = useCallback(() => {
    monitoringIntentRef.current = true;
    detachTrackListeners();
    lastFrameAtRef.current = performance.now();
    softRestartCountRef.current = 0;
    setCameraOn(true);
  }, []);

  const stop = useCallback(() => {
    monitoringIntentRef.current = false;
    stopFrameLoop();
    detachTrackListeners();
    setCameraOn(false);
    setStream(null);
  }, [stopFrameLoop]);

  const bounce = useCallback((delayMs: number = bounceDelayMs) => {
    if (!monitoringIntentRef.current) return;
    setCameraOn(false);
    window.setTimeout(() => {
      if (monitoringIntentRef.current) {
        setCameraOn(true);
        lastFrameAtRef.current = performance.now();
      }
    }, delayMs);
  }, [bounceDelayMs]);

  // Final cleanup on unmount — the parent component unmounting should not
  // leak the rVFC chain or the track listeners.
  useEffect(() => {
    return () => {
      monitoringIntentRef.current = false;
      stopFrameLoop();
      detachTrackListeners();
    };
  }, [stopFrameLoop]);

  return {
    cameraOn,
    onStreamReady,
    stream,
    start,
    stop,
    bounce,
    getSoftRestartCount: () => softRestartCountRef.current,
    getLastFrameAt: () => lastFrameAtRef.current,
  };
}