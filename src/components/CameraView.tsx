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
    let mounted = true;

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
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      await stopCamera();
      if (!mounted) { isStartingRef.current = false; return; }

      try {
        // PHASE 1
        const cameraId = await findMainBackCamera();

        // PHASE 2: Negotiate the highest forensically useful resolution we
        // can sustain. Profiles are tried top-down; the first one that
        // (a) opens AND (b) holds ≥ FPS floor over a 1.5 s probe wins.
        // Larger frames give the adaptive ROI more pixels → better SNR.
        type Rung = { w: number; h: number; fps: number; floor: number };
        const ladder: Rung[] = [
          { w: 1280, h: 720, fps: 30, floor: 24 },
          { w: 960,  h: 540, fps: 30, floor: 22 },
          { w: 640,  h: 480, fps: 30, floor: 20 },
          { w: 640,  h: 480, fps: 24, floor: 18 },
        ];

        const buildConstraints = (r: Rung): MediaTrackConstraints =>
          cameraId
            ? {
                deviceId: { exact: cameraId },
                width:  { ideal: r.w },
                height: { ideal: r.h },
                frameRate: { ideal: r.fps, max: r.fps },
              }
            : {
                facingMode: { ideal: 'environment' },
                width:  { ideal: r.w },
                height: { ideal: r.h },
                frameRate: { ideal: r.fps, max: r.fps },
              };

        // Sample real FPS by counting requestVideoFrameCallback hits over windowMs.
        // Falls back to track.getSettings().frameRate when rVFC is missing.
        const measureRealFps = async (
          videoEl: HTMLVideoElement,
          track: MediaStreamTrack,
          windowMs = 1500,
        ): Promise<number> => {
          if (!('requestVideoFrameCallback' in videoEl)) {
            return (track.getSettings() as any).frameRate ?? 0;
          }
          return new Promise<number>((resolve) => {
            const t0 = performance.now();
            let frames = 0;
            const tick = () => {
              frames++;
              const elapsed = performance.now() - t0;
              if (elapsed >= windowMs) {
                resolve((frames * 1000) / elapsed);
              } else {
                (videoEl as any).requestVideoFrameCallback(tick);
              }
            };
            (videoEl as any).requestVideoFrameCallback(tick);
            // Hard timeout in case the camera never delivers frames.
            setTimeout(() => resolve(0), windowMs + 500);
          });
        };

        let stream: MediaStream | null = null;
        let chosenRung: Rung | null = null;
        let fallbacks = 0;
        let downshiftedForFps = false;

        for (let i = 0; i < ladder.length; i++) {
          const rung = ladder[i];
          try {
            const candidate = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: buildConstraints(rung),
            });
            // Probe FPS only when the <video> element is ready to attach.
            if (videoRef.current) {
              videoRef.current.srcObject = candidate;
              await new Promise<void>((res) => {
                const v = videoRef.current!;
                v.onloadedmetadata = async () => { try { await v.play(); } catch {} res(); };
              });
              const fps = await measureRealFps(videoRef.current, candidate.getVideoTracks()[0]);
              console.log(`📊 Probe ${rung.w}x${rung.h}@${rung.fps} → measured ${fps.toFixed(1)} fps (floor ${rung.floor})`);
              if (fps >= rung.floor) {
                stream = candidate;
                chosenRung = rung;
                if (i > 0) downshiftedForFps = true;
                break;
              }
              // Below floor — discard and try next rung.
              candidate.getTracks().forEach(t => t.stop());
              fallbacks++;
              continue;
            }
            // No video element yet (component unmounting) — accept first open.
            stream = candidate;
            chosenRung = rung;
            break;
          } catch (err) {
            console.warn(`⚠️ Rung ${rung.w}x${rung.h}@${rung.fps} unavailable:`, (err as any)?.name || err);
            fallbacks++;
          }
        }

        if (!stream || !chosenRung) {
          throw new Error('No camera profile in fallback ladder could be opened.');
        }

        diagnosticsRef.current.activeProfile = `${chosenRung.w}x${chosenRung.h}@${chosenRung.fps}`;
        diagnosticsRef.current.fallbacksApplied = fallbacks;
        diagnosticsRef.current.downshiftedForFps = downshiftedForFps;

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

        onStreamReady?.(stream);
        isStartingRef.current = false;
      } catch (err) {
        console.error('❌ Camera error:', err);
        isStartingRef.current = false;
      }
    };

    if (isMonitoring) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      mounted = false;
      stopCamera();
    };
  }, [isMonitoring, onStreamReady]);

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
