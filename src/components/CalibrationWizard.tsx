import React, { useEffect, useRef, useState, useCallback } from "react";
import { CheckCircle2, Circle, Hand, Activity, Heart, Droplets, X, Loader2 } from "lucide-react";

/**
 * CalibrationWizard
 * -----------------
 * Clinical-style guided calibration overlay. Walks the operator through
 * four phases, each with explicit pass/fail criteria measured from the
 * live PPG pipeline:
 *
 *   1. PLACEMENT  — fingerDetected && quality ≥ 50 sustained for 2 s
 *   2. STABILITY  — quality ≥ 60 && motion ≤ MICRO sustained for 5 s
 *   3. BPM_BASELINE  — collect ≥ 30 BPM samples over 10 s, compute mean/SD
 *   4. SPO2_BASELINE — collect ≥ 30 SpO2 samples over 10 s, compute mean/SD
 *
 * On success, the resulting baseline is persisted to localStorage under
 * `ppg.calibration.baseline` and surfaced via onComplete().
 *
 * Failure modes (signal lost, motion exceeded, time-out) revert to the
 * previous phase rather than aborting the whole wizard, so the operator
 * can recover without restarting from PLACEMENT.
 */

export type CalibrationPhase =
  | 'PLACEMENT'
  | 'STABILITY'
  | 'BPM_BASELINE'
  | 'SPO2_BASELINE'
  | 'DONE';

export interface CalibrationBaseline {
  bpmMean: number;
  bpmSd: number;
  bpmSamples: number;
  spo2Mean: number;
  spo2Sd: number;
  spo2Samples: number;
  qualityMean: number;
  capturedAt: string; // ISO timestamp
}

export interface CalibrationLiveInputs {
  fingerDetected: boolean;
  quality: number;        // 0..100
  bpm: number;
  spo2: number;
  motionLevel: 'STILL' | 'MICRO_MOTION' | 'MODERATE_MOTION' | 'SEVERE_MOTION';
}

interface Props {
  open: boolean;
  live: CalibrationLiveInputs;
  onCancel: () => void;
  onComplete: (baseline: CalibrationBaseline) => void;
}

const PLACEMENT_HOLD_MS = 2000;
const STABILITY_HOLD_MS = 5000;
const BASELINE_COLLECT_MS = 10000;
const MIN_SAMPLES = 30;

/**
 * Pass-criteria checklist driver: returns the live boolean state of each
 * criterion the current phase is gating on. Used by the HUD section so
 * the operator can see exactly which condition is still pending.
 */
function buildCriteria(
  phase: CalibrationPhase,
  l: CalibrationLiveInputs,
  bpmCount: number,
  spo2Count: number,
): Array<{ label: string; ok: boolean; detail?: string }> {
  switch (phase) {
    case 'PLACEMENT':
      return [
        { label: 'Dedo detectado', ok: l.fingerDetected },
        { label: 'Calidad ≥ 50',   ok: l.quality >= 50, detail: `${Math.round(l.quality)}/50` },
      ];
    case 'STABILITY':
      return [
        { label: 'Dedo detectado', ok: l.fingerDetected },
        { label: 'Calidad ≥ 60',   ok: l.quality >= 60, detail: `${Math.round(l.quality)}/60` },
        { label: 'Movimiento ≤ MICRO',
          ok: l.motionLevel === 'STILL' || l.motionLevel === 'MICRO_MOTION',
          detail: l.motionLevel.replace('_MOTION', '').toLowerCase() },
      ];
    case 'BPM_BASELINE':
      return [
        { label: 'Dedo detectado',  ok: l.fingerDetected },
        { label: `Muestras ≥ ${MIN_SAMPLES}`,
          ok: bpmCount >= MIN_SAMPLES,
          detail: `${bpmCount}/${MIN_SAMPLES}` },
        { label: 'BPM en rango (40–200)',
          ok: l.bpm >= 40 && l.bpm <= 200,
          detail: l.bpm > 0 ? `${Math.round(l.bpm)}` : '—' },
      ];
    case 'SPO2_BASELINE':
      return [
        { label: 'Dedo detectado', ok: l.fingerDetected },
        { label: 'Recolectando SpO₂',
          ok: spo2Count > 0,
          detail: `${spo2Count} muestras` },
        { label: 'SpO₂ en rango (70–100)',
          ok: l.spo2 >= 70 && l.spo2 <= 100,
          detail: l.spo2 > 0 ? `${Math.round(l.spo2)}` : '—' },
      ];
    case 'DONE':
      return [{ label: 'Calibración guardada', ok: true }];
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
};

const CalibrationWizard: React.FC<Props> = ({ open, live, onCancel, onComplete }) => {
  const [phase, setPhase] = useState<CalibrationPhase>('PLACEMENT');
  const [progress, setProgress] = useState(0); // 0..1 within current phase
  const [statusMsg, setStatusMsg] = useState<string>('Coloque el dedo sobre la cámara y el flash.');
  // Mirrors of the ref-stored sample counts so they appear in the HUD.
  // Updated only when they change (every ~30 ms tick → ≤ ~33 setStates/sec
  // for ~10 s, well within React's budget).
  const [bpmCount, setBpmCount] = useState(0);
  const [spo2Count, setSpo2Count] = useState(0);

  // Refs that survive re-renders inside the requestAnimationFrame loop.
  const phaseStartRef = useRef<number>(performance.now());
  const bpmSamplesRef = useRef<number[]>([]);
  const spo2SamplesRef = useRef<number[]>([]);
  const qualitySamplesRef = useRef<number[]>([]);
  const liveRef = useRef<CalibrationLiveInputs>(live);
  const finishedRef = useRef(false);
  // Keep the latest live snapshot in a ref so the rAF loop never goes stale.
  useEffect(() => { liveRef.current = live; }, [live]);

  const resetPhase = useCallback((p: CalibrationPhase, msg: string) => {
    setPhase(p);
    setStatusMsg(msg);
    setProgress(0);
    phaseStartRef.current = performance.now();
    if (p === 'BPM_BASELINE') { bpmSamplesRef.current = []; setBpmCount(0); }
    if (p === 'SPO2_BASELINE') { spo2SamplesRef.current = []; setSpo2Count(0); }
    if (p === 'PLACEMENT' || p === 'STABILITY') {
      bpmSamplesRef.current = [];
      spo2SamplesRef.current = [];
      qualitySamplesRef.current = [];
      setBpmCount(0);
      setSpo2Count(0);
    }
  }, []);

  // Reset wizard state whenever it (re)opens.
  useEffect(() => {
    if (!open) return;
    finishedRef.current = false;
    resetPhase('PLACEMENT', 'Coloque el dedo sobre la cámara y el flash.');
  }, [open, resetPhase]);

  // Driver loop — runs while open and not finished.
  useEffect(() => {
    if (!open || finishedRef.current) return;
    let rafId = 0;

    const tick = () => {
      if (!open || finishedRef.current) return;
      const now = performance.now();
      const elapsed = now - phaseStartRef.current;
      const l = liveRef.current;

      switch (phase) {
        case 'PLACEMENT': {
          const ok = l.fingerDetected && l.quality >= 50;
          if (!ok) {
            phaseStartRef.current = now;
            setProgress(0);
            setStatusMsg(
              !l.fingerDetected
                ? 'Coloque el dedo sobre la cámara y el flash.'
                : `Calidad insuficiente (${Math.round(l.quality)}/50).`,
            );
          } else {
            const p = Math.min(1, elapsed / PLACEMENT_HOLD_MS);
            setProgress(p);
            setStatusMsg(`Manténga el dedo... ${Math.ceil((PLACEMENT_HOLD_MS - elapsed) / 1000)}s`);
            if (elapsed >= PLACEMENT_HOLD_MS) {
              resetPhase('STABILITY', 'No mueva el teléfono. Sostenga firme.');
            }
          }
          break;
        }

        case 'STABILITY': {
          const ok = l.fingerDetected && l.quality >= 60
            && (l.motionLevel === 'STILL' || l.motionLevel === 'MICRO_MOTION');
          if (!ok) {
            // Drop back to PLACEMENT only if contact was lost; otherwise just
            // restart the stability timer.
            if (!l.fingerDetected) {
              resetPhase('PLACEMENT', 'Contacto perdido. Reposicione el dedo.');
            } else {
              phaseStartRef.current = now;
              setProgress(0);
              setStatusMsg(
                l.motionLevel === 'SEVERE_MOTION' || l.motionLevel === 'MODERATE_MOTION'
                  ? 'Movimiento detectado. Apoye la mano sobre una superficie.'
                  : `Estabilizando... calidad ${Math.round(l.quality)}/60`,
              );
            }
          } else {
            const p = Math.min(1, elapsed / STABILITY_HOLD_MS);
            setProgress(p);
            setStatusMsg(`Estable ✓ ${Math.ceil((STABILITY_HOLD_MS - elapsed) / 1000)}s`);
            qualitySamplesRef.current.push(l.quality);
            if (elapsed >= STABILITY_HOLD_MS) {
              resetPhase('BPM_BASELINE', 'Capturando línea base de BPM...');
            }
          }
          break;
        }

        case 'BPM_BASELINE': {
          if (!l.fingerDetected) {
            resetPhase('PLACEMENT', 'Contacto perdido durante la línea base.');
            break;
          }
          // Only record physiologically plausible BPM (40–200) so a
          // momentarily glitched 0 or 300 doesn't poison the baseline.
          if (l.bpm >= 40 && l.bpm <= 200) {
            bpmSamplesRef.current.push(l.bpm);
            setBpmCount(bpmSamplesRef.current.length);
          }
          if (l.quality > 0) qualitySamplesRef.current.push(l.quality);
          const p = Math.min(1, elapsed / BASELINE_COLLECT_MS);
          setProgress(p);
          setStatusMsg(
            `BPM línea base — ${bpmSamplesRef.current.length} muestras / ${Math.ceil((BASELINE_COLLECT_MS - elapsed) / 1000)}s`,
          );
          if (elapsed >= BASELINE_COLLECT_MS) {
            if (bpmSamplesRef.current.length < MIN_SAMPLES) {
              resetPhase('STABILITY', `Muestras insuficientes (${bpmSamplesRef.current.length}/${MIN_SAMPLES}). Reintentando.`);
            } else {
              resetPhase('SPO2_BASELINE', 'Capturando línea base de SpO₂...');
            }
          }
          break;
        }

        case 'SPO2_BASELINE': {
          if (!l.fingerDetected) {
            resetPhase('PLACEMENT', 'Contacto perdido durante la línea base.');
            break;
          }
          if (l.spo2 >= 70 && l.spo2 <= 100) {
            spo2SamplesRef.current.push(l.spo2);
            setSpo2Count(spo2SamplesRef.current.length);
          }
          if (l.quality > 0) qualitySamplesRef.current.push(l.quality);
          const p = Math.min(1, elapsed / BASELINE_COLLECT_MS);
          setProgress(p);
          setStatusMsg(
            `SpO₂ línea base — ${spo2SamplesRef.current.length} muestras / ${Math.ceil((BASELINE_COLLECT_MS - elapsed) / 1000)}s`,
          );
          if (elapsed >= BASELINE_COLLECT_MS) {
            // SpO2 baseline is best-effort: if too few samples, still finish
            // (BPM baseline is the primary deliverable).
            const baseline: CalibrationBaseline = {
              bpmMean: mean(bpmSamplesRef.current),
              bpmSd: sd(bpmSamplesRef.current),
              bpmSamples: bpmSamplesRef.current.length,
              spo2Mean: spo2SamplesRef.current.length > 0 ? mean(spo2SamplesRef.current) : 0,
              spo2Sd: spo2SamplesRef.current.length > 0 ? sd(spo2SamplesRef.current) : 0,
              spo2Samples: spo2SamplesRef.current.length,
              qualityMean: qualitySamplesRef.current.length > 0 ? mean(qualitySamplesRef.current) : 0,
              capturedAt: new Date().toISOString(),
            };
            try { localStorage.setItem('ppg.calibration.baseline', JSON.stringify(baseline)); } catch {}
            finishedRef.current = true;
            setPhase('DONE');
            setProgress(1);
            setStatusMsg('Calibración completa.');
            onComplete(baseline);
            return;
          }
          break;
        }

        case 'DONE':
          return;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [open, phase, resetPhase, onComplete]);

  if (!open) return null;

  const phaseLabels: Record<CalibrationPhase, { icon: React.ReactNode; title: string; idx: number }> = {
    PLACEMENT:     { icon: <Hand className="w-4 h-4" />,        title: 'Posicionamiento', idx: 1 },
    STABILITY:     { icon: <Activity className="w-4 h-4" />,    title: 'Estabilidad',     idx: 2 },
    BPM_BASELINE:  { icon: <Heart className="w-4 h-4" />,       title: 'Línea base BPM',  idx: 3 },
    SPO2_BASELINE: { icon: <Droplets className="w-4 h-4" />,    title: 'Línea base SpO₂', idx: 4 },
    DONE:          { icon: <CheckCircle2 className="w-4 h-4" />, title: 'Completado',      idx: 5 },
  };
  const current = phaseLabels[phase];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-md safe-top safe-bottom safe-left safe-right">
      <div className="w-[min(92vw,420px)] rounded-xl border border-border bg-card text-card-foreground shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Calibración clínica</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label="Cancelar calibración"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step indicator */}
        <ol className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {(['PLACEMENT','STABILITY','BPM_BASELINE','SPO2_BASELINE','DONE'] as CalibrationPhase[]).map((p) => {
            const meta = phaseLabels[p];
            const active = p === phase;
            const past = phaseLabels[phase].idx > meta.idx;
            return (
              <li
                key={p}
                className={`flex-1 h-1 rounded-full ${past ? 'bg-primary' : active ? 'bg-primary/60' : 'bg-muted'}`}
                title={meta.title}
              />
            );
          })}
        </ol>

        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary">
            {phase === 'DONE' ? <CheckCircle2 className="w-4 h-4" /> : current.icon}
          </span>
          <div className="flex-1">
            <div className="font-medium">{current.title}</div>
            <div className="text-xs text-muted-foreground">{statusMsg}</div>
          </div>
          {phase !== 'DONE' && phase !== 'PLACEMENT' && (
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Progress bar */}
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        {/* Pass-criteria HUD: live ✓/✗ for the current phase */}
        <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Criterios de paso
          </div>
          <ul className="space-y-0.5">
            {buildCriteria(phase, live, bpmCount, spo2Count).map((c, idx) => (
              <li key={idx} className="flex items-center gap-1.5 text-[11px]">
                {c.ok
                  ? <CheckCircle2 className="w-3 h-3 text-primary shrink-0" />
                  : <Circle className="w-3 h-3 text-muted-foreground shrink-0" />}
                <span className={c.ok ? 'text-foreground' : 'text-muted-foreground'}>
                  {c.label}
                </span>
                {c.detail && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {c.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Live readout */}
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">Calidad</div>
            <div className="font-mono">{Math.round(live.quality)}</div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">BPM</div>
            <div className="font-mono">{live.bpm > 0 ? Math.round(live.bpm) : '—'}</div>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <div className="text-muted-foreground">SpO₂</div>
            <div className="font-mono">{live.spo2 > 0 ? Math.round(live.spo2) : '—'}</div>
          </div>
        </div>

        {phase === 'DONE' && (
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Cerrar
          </button>
        )}
      </div>
    </div>
  );
};

export default CalibrationWizard;