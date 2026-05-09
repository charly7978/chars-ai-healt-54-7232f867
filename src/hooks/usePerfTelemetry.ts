import { useCallback, useEffect, useRef } from 'react';
import { ppgPerf } from '@/utils/logger';
import { supabase } from '@/integrations/supabase/client';
import { bufferSnapshot, drainBuffer, deleteIds } from '@/lib/perf/indexedDbBuffer';

const CONSENT_KEY = 'perf_telemetry_consent';
const APP_VERSION = '1.0.0';

export function getPerfConsent(): boolean {
  try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
}

export function setPerfConsent(value: boolean): void {
  try { localStorage.setItem(CONSENT_KEY, value ? '1' : '0'); } catch {}
}

function deviceInfo() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const scr = typeof screen !== 'undefined' ? screen : null;
  return {
    userAgent: nav?.userAgent ?? 'unknown',
    hardwareConcurrency: nav?.hardwareConcurrency ?? 0,
    deviceMemory: (nav as any)?.deviceMemory ?? 0,
    screen: scr ? { w: scr.width, h: scr.height } : null,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  };
}

export interface PerfContextProvider {
  getCamera: () => Record<string, unknown>;
  getPipeline: () => Record<string, unknown>;
}

/**
 * Hook que envía periódicamente snapshots de PerfTracker a Lovable Cloud
 * cuando el usuario dio consentimiento explícito y está autenticado.
 * Si no hay red o sesión, los snapshots se persisten en IndexedDB y se
 * reintentan en el próximo ciclo o al recuperar conectividad.
 */
export function usePerfTelemetry(opts: {
  enabled: boolean;
  intervalMs?: number;
  context?: PerfContextProvider;
}) {
  const { enabled, intervalMs = 15000, context } = opts;
  const sessionIdRef = useRef<string>(`s_${Date.now().toString(36)}`);
  const flushingRef = useRef<boolean>(false);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const consent = getPerfConsent();
      if (!consent) return;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        // Sin sesión: bufferizar para reintento posterior
        const snap = ppgPerf.drainSnapshot();
        if (snap.frames > 0) {
          await bufferSnapshot({
            session_id: sessionIdRef.current,
            fps: snap.fps,
            jitter_ms: snap.jitterMs,
            dropped_estimate: snap.droppedEstimate,
            frames: snap.frames,
            stages: snap.stages,
            device: deviceInfo(),
            camera: context?.getCamera() ?? {},
            pipeline: context?.getPipeline() ?? {},
            app_version: APP_VERSION,
            consent_given: true,
          });
        }
        return;
      }

      // Reintentar items pendientes
      const pending = await drainBuffer();
      if (pending.length) {
        const rows = pending.map((p) => ({ ...(p.payload as object), user_id: user.id }));
        const { error } = await supabase.from('perf_snapshots').insert(rows as any);
        if (!error) await deleteIds(pending.map((p) => p.id));
      }

      // Enviar snapshot actual
      const snap = ppgPerf.drainSnapshot();
      if (snap.frames === 0) return;

      const row = {
        user_id: user.id,
        session_id: sessionIdRef.current,
        fps: snap.fps,
        jitter_ms: snap.jitterMs,
        dropped_estimate: snap.droppedEstimate,
        frames: snap.frames,
        stages: snap.stages,
        device: deviceInfo(),
        camera: context?.getCamera() ?? {},
        pipeline: context?.getPipeline() ?? {},
        app_version: APP_VERSION,
        consent_given: true,
      };
      const { error } = await supabase.from('perf_snapshots').insert(row as any);
      if (error) {
        await bufferSnapshot(row);
      }
    } catch {
      /* nunca romper el pipeline por telemetría */
    } finally {
      flushingRef.current = false;
    }
  }, [context]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => { void flush(); }, intervalMs);
    const onOnline = () => { void flush(); };
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', onOnline);
      void flush();
    };
  }, [enabled, intervalMs, flush]);

  return { sessionId: sessionIdRef.current, flushNow: flush };
}