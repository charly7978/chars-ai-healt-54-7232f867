import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => CameraDiagnostics;
}

export interface CameraDiagnostics {
  deviceLabel: string;
  hasTorch: boolean;
  torchActive: boolean;
  realFrameRate: number;
  resolution: { width: number; height: number };
  exposureLocked: boolean;
  wbLocked: boolean;
  focusLocked: boolean;
  isoValue: number;
  supportedConstraints: string[];
  /** Profile rung the negotiator finally settled on (e.g. "1280x720@30"). */
  activeProfile: string;
  /** Number of rungs we had to descend before the stream stayed within FPS floor. */
  fallbacksApplied: number;
  /** True if a measured-FPS downshift happened after the initial open. */
  downshiftedForFps: boolean;
}

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  isMonitoring: boolean;
}

/**
 * CAMERA PPG V2 — PHASED CONSTRAINT APPLICATION
 * 
 * Phase 1: Find best back camera with torch
 * Phase 2: Open stream with stable base constraints
 * Phase 3: Activate torch
 * Phase 4: Lock fine controls (exposure, WB, focus, ISO) with graceful degradation
 * Phase 5: Export diagnostics for processor
 */
const CameraView = forwardRef<CameraViewHandle, CameraViewProps>(({
  onStreamReady,
  isMonitoring,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const stopTimerRef = useRef<number | null>(null);
  // Keep the latest onStreamReady in a ref so the main start/stop effect
  // does NOT re-run every time the parent re-renders with a new callback
  // identity. Re-running the effect tears down the MediaStream mid-probe,
  // which is exactly what was causing the camera to "open and close" and
  // corrupt the G1/G2/G3 extraction during the first seconds of capture.
  const onStreamReadyRef = useRef<typeof onStreamReady>(onStreamReady);
  useEffect(() => { onStreamReadyRef.current = onStreamReady; }, [onStreamReady]);
  // Continuous FPS watchdog — updates diagnostics.realFrameRate every ~2 s
  // so the diagnostics overlay reflects what the camera is actually delivering.
  const fpsWatchdogRef = useRef<{ frames: number; t0: number; rafId: number | null }>({
    frames: 0, t0: 0, rafId: null,
  });
  const diagnosticsRef = useRef<CameraDiagnostics>({
    deviceLabel: '',
    hasTorch: false,
    torchActive: false,
    realFrameRate: 30,
    resolution: { width: 0, height: 0 },
    exposureLocked: false,
    wbLocked: false,
    focusLocked: false,
    isoValue: 0,
    supportedConstraints: [],
    activeProfile: '',
    fallbacksApplied: 0,
    downshiftedForFps: false,
  });

  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getDiagnostics: () => ({ ...diagnosticsRef.current }),
  }), []);

  useEffect(() => {
    return () => {
      if (stopTimerRef.current !== null) {
        window.clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
      if (fpsWatchdogRef.current.rafId !== null) {
        cancelAnimationFrame(fpsWatchdogRef.current.rafId);
        fpsWatchdogRef.current.rafId = null;
      }
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      isStartingRef.current = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    const cancelScheduledStop = () => {
      if (stopTimerRef.current !== null) {
        window.clearTimeout(stopTimerRef.current);
        stopTimerRef.current = null;
      }
    };

    const stopCamera = async () => {
      // Stop the FPS watchdog first so it doesn't keep referencing a dead video.
      if (fpsWatchdogRef.current.rafId !== null) {
        cancelAnimationFrame(fpsWatchdogRef.current.rafId);
        fpsWatchdogRef.current.rafId = null;
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getVideoTracks()) {
          try {
            const caps = track.getCapabilities?.() as any;
            if (caps?.torch) {
              await track.applyConstraints({ advanced: [{ torch: false } as any] });
            }
          } catch {}
          track.stop();
        }
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      isStartingRef.current = false;
    };

    // PHASE 1: Find main back camera with torch
    const findMainBackCamera = async (): Promise<string | null> => {
      try {
        // Request minimal access first to get labels
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        tempStream.getTracks().forEach(t => t.stop());
        
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        console.log('📷 Cameras:', videoDevices.map(d => d.label || d.deviceId));

        // Try each back camera to find one with torch
        for (const device of videoDevices) {
          const label = device.label.toLowerCase();
          if (label.includes('back') || label.includes('rear') || label.includes('environment') ||
            label.includes('trasera') || label.includes('camera 0') || label.includes('camera0') ||
            videoDevices.length === 1) {
            try {
              const ts = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: device.deviceId } }
              });
              const track = ts.getVideoTracks()[0];
              const caps = track.getCapabilities?.() as any;
              const hasTorch = caps?.torch === true;
              ts.getTracks().forEach(t => t.stop());
              if (hasTorch) {
                console.log('✅ Main camera found:', device.label);
                diagnosticsRef.current.deviceLabel = device.label;
                return device.deviceId;
              }
            } catch {}
          }
        }

        // Fallback: any camera with torch
        for (const device of videoDevices) {
          try {
            const ts = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: device.deviceId } }
            });
            const track = ts.getVideoTracks()[0];
            const caps = track.getCapabilities?.() as any;
            ts.getTracks().forEach(t => t.stop());
            if (caps?.torch === true) {
              diagnosticsRef.current.deviceLabel = device.label;
              return device.deviceId;
            }
          } catch {}
        }
        return null;
      } catch {
        return null;
      }
    };

    const startCamera = async () => {
      cancelScheduledStop();
      if (isStartingRef.current) return;
      if (streamRef.current?.active) {
        onStreamReadyRef.current?.(streamRef.current);
        return;
      }
      isStartingRef.current = true;
      if (!mounted) { isStartingRef.current = false; return; }

      try {
        // Single-open path: no camera scanning, no profile probing, no
        // stop/start ladder. Those probes made mobile browsers visibly open
        // and close the camera before G1/G2/G3 could stabilize.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        });

        diagnosticsRef.current.activeProfile = 'environment@ideal-1280x720@30';
        diagnosticsRef.current.fallbacksApplied = 0;
        diagnosticsRef.current.downshiftedForFps = false;

        if (!mounted) { stream.getTracks().forEach(t => t.stop()); isStartingRef.current = false; return; }
        streamRef.current = stream;

        // The probe loop already attached the winning stream to <video> and
        // awaited loadedmetadata + play(). Re-assert srcObject as a no-op
        // safety net in case the element was swapped during teardown.
        if (videoRef.current && videoRef.current.srcObject !== stream) {
          videoRef.current.srcObject = stream;
          try { await videoRef.current.play(); } catch {}
        }

        const track = stream.getVideoTracks()[0];
        if (!track) { isStartingRef.current = false; return; }

        // Record supported constraints
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
        diagnosticsRef.current.supportedConstraints = Object.keys(supported).filter(k => (supported as any)[k]);

        // Record real settings
        const settings = track.getSettings() as any;
        diagnosticsRef.current.resolution = {
          width: settings.width || 0,
          height: settings.height || 0
        };
        diagnosticsRef.current.realFrameRate = settings.frameRate || 30;

        // PHASE 3: Activate torch
        await new Promise(r => setTimeout(r, 400));
        const caps = track.getCapabilities?.() as any;
        diagnosticsRef.current.hasTorch = caps?.torch === true;

        if (caps?.torch) {
          let torchOk = false;
          for (let attempt = 0; attempt < 5 && !torchOk; attempt++) {
            try {
              await track.applyConstraints({ advanced: [{ torch: true } as any] });
              torchOk = true;
              diagnosticsRef.current.torchActive = true;
              console.log('🔦 Torch ON');
            } catch {
              await new Promise(r => setTimeout(r, 250));
            }
          }
          if (!torchOk) console.warn('⚠️ Torch failed after 5 attempts');
        }

        // PHASE 4: Fine lock — apply each independently, log what succeeds
        await new Promise(r => setTimeout(r, 300));
        
        const tryConstraint = async (name: string, value: any): Promise<boolean> => {
          try {
            await track.applyConstraints({ advanced: [{ [name]: value } as any] });
            return true;
          } catch {
            return false;
          }
        };

        // Frame rate lock
        await tryConstraint('frameRate', 30);

        // Exposure
        if (caps?.exposureMode?.includes('manual')) {
          diagnosticsRef.current.exposureLocked = await tryConstraint('exposureMode', 'manual');
        } else if (caps?.exposureMode?.includes('continuous')) {
          await tryConstraint('exposureMode', 'continuous');
        }

        if (caps?.exposureCompensation) {
          const min = caps.exposureCompensation.min ?? -2;
          const max = caps.exposureCompensation.max ?? 2;
          const target = Math.max(min, Math.min(max, -0.35));
          await tryConstraint('exposureCompensation', target);
        }

        // White balance
        if (caps?.whiteBalanceMode?.includes('manual')) {
          diagnosticsRef.current.wbLocked = await tryConstraint('whiteBalanceMode', 'manual');
        }

        // ISO
        if (caps?.iso) {
          const minISO = caps.iso.min ?? 50;
          const maxISO = caps.iso.max ?? 400;
          const targetISO = Math.max(minISO, Math.min(maxISO, 140));
          if (await tryConstraint('iso', targetISO)) {
            diagnosticsRef.current.isoValue = targetISO;
          }
        }

        // Focus
        if (caps?.focusMode?.includes('manual')) {
          diagnosticsRef.current.focusLocked = await tryConstraint('focusMode', 'manual');
        } else if (caps?.focusMode?.includes('continuous')) {
          await tryConstraint('focusMode', 'continuous');
        }

        // Log final settings
        const finalSettings = track.getSettings() as any;
        console.log('📹 Camera ready:', finalSettings.width, 'x', finalSettings.height,
          '@', finalSettings.frameRate, 'fps',
          '| Torch:', diagnosticsRef.current.torchActive,
          '| Exp:', diagnosticsRef.current.exposureLocked,
          '| WB:', diagnosticsRef.current.wbLocked,
          '| ISO:', diagnosticsRef.current.isoValue);

        onStreamReadyRef.current?.(stream);
        isStartingRef.current = false;

        // Live FPS watchdog: count rVFC ticks over rolling 2 s windows and
        // store the rate in diagnostics.realFrameRate. Read-only — never
        // re-negotiates constraints mid-stream (too risky for the torch).
        const v = videoRef.current;
        if (v && 'requestVideoFrameCallback' in v) {
          fpsWatchdogRef.current = { frames: 0, t0: performance.now(), rafId: 0 };
          const tick = () => {
            if (!streamRef.current || !videoRef.current) return;
            fpsWatchdogRef.current.frames++;
            const elapsed = performance.now() - fpsWatchdogRef.current.t0;
            if (elapsed >= 2000) {
              const fps = (fpsWatchdogRef.current.frames * 1000) / elapsed;
              diagnosticsRef.current.realFrameRate = fps;
              fpsWatchdogRef.current.frames = 0;
              fpsWatchdogRef.current.t0 = performance.now();
            }
            (videoRef.current as any).requestVideoFrameCallback(tick);
          };
          (v as any).requestVideoFrameCallback(tick);
          // Stash a sentinel so stopCamera() knows to clear it; rAF id is
          // unused but kept for symmetry.
          fpsWatchdogRef.current.rafId = 1 as any;
        }
      } catch (err) {
        console.error('❌ Camera error:', err);
        isStartingRef.current = false;
      }
    };

    if (isMonitoring) {
      startCamera();
    } else {
      cancelScheduledStop();
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = null;
        stopCamera();
      }, 2500);
    }

    return () => {
      mounted = false;
    };
  // Intentionally depend ONLY on isMonitoring. onStreamReady is read via
  // ref so changing parent callbacks never restarts the camera mid-stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMonitoring]);

  return (
    <video
      ref={videoRef}
      playsInline
      muted
      autoPlay
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        opacity: 1,
        pointerEvents: "none",
      }}
    />
  );
});

CameraView.displayName = 'CameraView';
export default CameraView;
