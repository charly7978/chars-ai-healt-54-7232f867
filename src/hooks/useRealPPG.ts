import { useEffect, useRef, useState, useCallback } from 'react';
import { RealPPGFrameEngine } from '@/modules/ppg/RealPPGFrameEngine';
import { createEmptySnapshot, type RealPPGSnapshot } from '@/modules/ppg/types';

/**
 * useRealPPG
 * ----------
 * Connects an HTMLVideoElement (rear camera + flash) to the RealPPG engine.
 * Uses requestVideoFrameCallback when available; falls back to requestAnimationFrame.
 * No defaults: snapshot.publication.canPublish drives all UI consumption.
 */

export interface UseRealPPGOptions {
  active: boolean;
  videoEl: HTMLVideoElement | null;
  /** Allow vibration on accepted beat (default true). */
  vibrate?: boolean;
}

export function useRealPPG({ active, videoEl, vibrate = true }: UseRealPPGOptions) {
  const engineRef = useRef<RealPPGFrameEngine>(new RealPPGFrameEngine());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rvfcIdRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const stopRef = useRef(false);
  const [snapshot, setSnapshot] = useState<RealPPGSnapshot>(() => createEmptySnapshot());
  const lastUiCommitRef = useRef(0);

  const reset = useCallback(() => {
    engineRef.current.reset();
    setSnapshot(createEmptySnapshot());
  }, []);

  useEffect(() => {
    if (!active || !videoEl) return;
    stopRef.current = false;
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      ctxRef.current = canvasRef.current.getContext('2d', { willReadFrequently: true });
    }

    const processOne = (tsMs: number) => {
      if (stopRef.current) return;
      const v = videoEl;
      const c = canvasRef.current!;
      const ctx = ctxRef.current!;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (vw === 0 || vh === 0) return;
      // Downscale for speed: cap shorter side to 240 px.
      const scale = Math.min(1, 240 / Math.min(vw, vh));
      const w = Math.max(8, Math.floor(vw * scale));
      const h = Math.max(8, Math.floor(vh * scale));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      try { ctx.drawImage(v, 0, 0, w, h); } catch { return; }
      let img: ImageData;
      try { img = ctx.getImageData(0, 0, w, h); } catch { return; }
      const snap = engineRef.current.processFrame(img.data, w, h, tsMs);

      if (vibrate && snap.vibrationAllowed) {
        try { (navigator as any).vibrate?.(20); } catch {}
      }

      // Throttle React commits to ~60 ms.
      const now = performance.now();
      if (now - lastUiCommitRef.current >= 60) {
        lastUiCommitRef.current = now;
        setSnapshot(snap);
      }
    };

    const hasRVFC = typeof (videoEl as any).requestVideoFrameCallback === 'function';
    if (hasRVFC) {
      const cb = (_now: number, meta: any) => {
        if (stopRef.current) return;
        const t = meta?.mediaTime ? performance.now() : performance.now();
        processOne(t);
        rvfcIdRef.current = (videoEl as any).requestVideoFrameCallback(cb);
      };
      rvfcIdRef.current = (videoEl as any).requestVideoFrameCallback(cb);
    } else {
      const tick = () => {
        if (stopRef.current) return;
        processOne(performance.now());
        rafIdRef.current = requestAnimationFrame(tick);
      };
      rafIdRef.current = requestAnimationFrame(tick);
    }

    return () => {
      stopRef.current = true;
      if (rvfcIdRef.current != null && (videoEl as any).cancelVideoFrameCallback) {
        try { (videoEl as any).cancelVideoFrameCallback(rvfcIdRef.current); } catch {}
      }
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rvfcIdRef.current = null; rafIdRef.current = null;
    };
  }, [active, videoEl, vibrate]);

  return { snapshot, reset };
}