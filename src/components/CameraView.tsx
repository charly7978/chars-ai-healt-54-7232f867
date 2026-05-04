import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { ConstraintNegotiator, type NegotiationReport } from "@/modules/camera/ConstraintNegotiator";
import { FrameTimingEstimator, type FrameTiming } from "@/modules/camera/FrameTimingEstimator";

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => CameraDiagnostics;
  getTorchStatus: () => TorchStatus;
  /** Push a frame metadata sample (rVFC) and get the latest timing snapshot. */
  pushFrameTiming: (metadata?: any) => FrameTiming;
  /** Read-only timing snapshot without mutating the estimator state. */
  getFrameTiming: () => { fps: number; droppedCount: number; frameCount: number };
  /** Last constraint negotiation report (capabilities + what was actually applied). */
  getNegotiationReport: () => NegotiationReport | null;
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
  /** Cumulative dropped frame count from the timing estimator. */
  droppedFrames?: number;
  /** Source of the last timing sample (rvfc-mediaTime preferred). */
  timingSource?: FrameTiming['source'];
}

export interface TorchStatus {
  supported: boolean;
  active: boolean;
  watchdogActive: boolean;
  reArmCount: number;
  lastReArmAt: number; // performance.now()
  lastCheckAt: number;
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
  const torchWatchdogRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);
  const timingRef = useRef<FrameTimingEstimator>(new FrameTimingEstimator());
  const negotiationRef = useRef<NegotiationReport | null>(null);
  const lastTimingSourceRef = useRef<FrameTiming['source']>('performance.now');
  const torchStatusRef = useRef<TorchStatus>({
    supported: false,
    active: false,
    watchdogActive: false,
    reArmCount: 0,
    lastReArmAt: 0,
    lastCheckAt: 0,
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
  });

  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getDiagnostics: () => {
      const snap = timingRef.current.snapshot();
      return {
        ...diagnosticsRef.current,
        realFrameRate: snap.fps > 0 ? snap.fps : diagnosticsRef.current.realFrameRate,
        droppedFrames: snap.droppedCount,
        timingSource: lastTimingSourceRef.current,
      };
    },
    getTorchStatus: () => ({ ...torchStatusRef.current }),
    pushFrameTiming: (metadata?: any) => {
      const t = timingRef.current.push(metadata);
      lastTimingSourceRef.current = t.source;
      return t;
    },
    getFrameTiming: () => timingRef.current.snapshot(),
    getNegotiationReport: () => negotiationRef.current,
  }), []);

  useEffect(() => {
    let mounted = true;

    const stopCamera = async () => {
      if (torchWatchdogRef.current != null) {
        window.clearInterval(torchWatchdogRef.current);
        torchWatchdogRef.current = null;
      }
      torchStatusRef.current = {
        ...torchStatusRef.current,
        watchdogActive: false,
        active: false,
      };
      if (wakeLockRef.current) {
        try { await wakeLockRef.current.release(); } catch {}
        wakeLockRef.current = null;
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

        // PHASE 2: Open stream with stable base
        const baseConstraints: MediaTrackConstraints = cameraId
          ? {
              deviceId: { exact: cameraId },
              width: { ideal: 640, max: 960 },
              height: { ideal: 480, max: 720 },
              frameRate: { ideal: 30, min: 24, max: 30 }
            }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 640, max: 960 },
              height: { ideal: 480, max: 720 },
              frameRate: { ideal: 30, min: 25, max: 30 }
            };

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: baseConstraints });
        } catch {
          console.warn('Fallback to simple constraints');
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }
          });
        }

        if (!mounted) { stream.getTracks().forEach(t => t.stop()); isStartingRef.current = false; return; }
        streamRef.current = stream;

        // Connect video
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await new Promise<void>((resolve) => {
            const video = videoRef.current!;
            video.onloadedmetadata = async () => {
              try { await video.play(); } catch {}
              resolve();
            };
          });
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

        torchStatusRef.current = {
          supported: diagnosticsRef.current.hasTorch,
          active: diagnosticsRef.current.torchActive,
          watchdogActive: false,
          reArmCount: 0,
          lastReArmAt: 0,
          lastCheckAt: performance.now(),
        };

        // PHASE 4: Fine lock — apply each independently, log what succeeds
        await new Promise(r => setTimeout(r, 300));
        const report = await ConstraintNegotiator.negotiate(track);
        negotiationRef.current = report;
        diagnosticsRef.current.exposureLocked = report.applied.exposureMode === 'manual';
        diagnosticsRef.current.wbLocked = report.applied.whiteBalanceMode === 'manual';
        diagnosticsRef.current.focusLocked = report.applied.focusMode === 'manual';
        if (report.applied.iso != null) diagnosticsRef.current.isoValue = report.applied.iso;

        // Reset frame timing estimator at the start of every session.
        timingRef.current.reset();

        const finalSettings = (report.finalSettings as any) || (track.getSettings() as any);
        console.log('📹 Camera ready:', finalSettings.width, 'x', finalSettings.height,
          '@', finalSettings.frameRate, 'fps',
          '| Torch:', diagnosticsRef.current.torchActive,
          '| Exp:', report.applied.exposureMode,
          '| WB:', report.applied.whiteBalanceMode,
          '| Focus:', report.applied.focusMode,
          '| ISO:', diagnosticsRef.current.isoValue,
          '| Failures:', report.failures);

        // PHASE 5: Anti-flicker hardening — keep torch ON and re-apply if the
        // OS or browser turns it off opportunistically (common on mid-range
        // Android devices when battery saver / thermal throttling kicks in).
        if (diagnosticsRef.current.hasTorch) {
          torchWatchdogRef.current = window.setInterval(async () => {
            const t = streamRef.current?.getVideoTracks()[0];
            if (!t || t.readyState !== 'live') return;
            const s = (t.getSettings?.() as any) || {};
            torchStatusRef.current.lastCheckAt = performance.now();
            if (s.torch === false) {
              try {
                await t.applyConstraints({ advanced: [{ torch: true } as any] });
                diagnosticsRef.current.torchActive = true;
                torchStatusRef.current.active = true;
                torchStatusRef.current.reArmCount += 1;
                torchStatusRef.current.lastReArmAt = performance.now();
                console.log('🔦 Torch re-armed by watchdog');
              } catch {
                torchStatusRef.current.active = false;
              }
            } else if (s.torch === true) {
              torchStatusRef.current.active = true;
            }
          }, 1500);
          torchStatusRef.current.watchdogActive = true;
        }

        // Acquire a screen wake lock so the OS doesn't dim/sleep mid-measurement.
        try {
          if ('wakeLock' in navigator) {
            wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
          }
        } catch {}

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
