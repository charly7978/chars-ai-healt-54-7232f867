import { useEffect, useRef } from 'react';
import { toast } from '@/hooks/use-toast';
import type { CalibrationBaseline } from '@/components/CalibrationWizard';
import type { MotionLevel } from '@/modules/signal-processing/MotionClassifier';

/**
 * useRecalibrationWatchdog
 * ------------------------
 * Continuously watches the live PPG monitoring signals and fires a single
 * "recalibrar" toast when confidence degrades for a sustained window.
 *
 * Trigger conditions (any one, sustained ≥ HOLD_MS):
 *   1. quality drop  — quality ≥ Q_DROP below baseline.qualityMean
 *                       (or below ABS_Q_FLOOR if no baseline yet)
 *   2. motion spike  — motionLevel ∈ {MODERATE, SEVERE}
 *   3. BPM drift     — |bpm − baseline.bpmMean|  > max(BPM_ABS, 3σ)
 *   4. SpO₂ drift    — |spo2 − baseline.spo2Mean| > max(SPO2_ABS, 3σ)
 *
 * Self-suppresses while the calibration wizard is open and enforces a
 * COOLDOWN_MS gap between consecutive prompts. The toast carries an
 * onAction() callback that opens the wizard.
 */

export interface RecalibrationInputs {
  enabled: boolean;          // typically `isMonitoring && !showCalibration`
  quality: number;           // 0..100
  bpm: number;
  spo2: number;
  motionLevel: MotionLevel;
  baseline: CalibrationBaseline | null;
}

export interface UseRecalibrationWatchdogOpts {
  onPrompt: () => void;      // called when the toast's action button is pressed
}

const HOLD_MS = 4000;         // sustained-degradation window
const MOTION_HOLD_MS = 3000;  // motion is faster to fire (more disruptive)
const COOLDOWN_MS = 25000;    // min gap between prompts

const ABS_Q_FLOOR = 35;       // quality floor when no baseline exists
const Q_DROP = 20;            // quality drop vs baseline that counts as degraded
const BPM_ABS = 15;           // absolute BPM drift floor (bpm)
const SPO2_ABS = 4;           // absolute SpO₂ drift floor (%)

type Reason = 'quality' | 'motion' | 'bpm_drift' | 'spo2_drift';

const reasonLabel: Record<Reason, string> = {
  quality:    'Calidad de señal degradada',
  motion:     'Movimiento sostenido detectado',
  bpm_drift:  'Frecuencia cardíaca alejada de la línea base',
  spo2_drift: 'SpO₂ alejada de la línea base',
};

export function useRecalibrationWatchdog(
  inputs: RecalibrationInputs,
  opts: UseRecalibrationWatchdogOpts,
) {
  // Latest inputs go through a ref so the polling effect always sees fresh
  // data without re-subscribing on every render.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const onPromptRef = useRef(opts.onPrompt);
  onPromptRef.current = opts.onPrompt;

  // Per-reason "since" timestamps. Reset to null when the condition clears.
  const sinceRef = useRef<Record<Reason, number | null>>({
    quality: null, motion: null, bpm_drift: null, spo2_drift: null,
  });
  const lastPromptAtRef = useRef<number>(0);

  useEffect(() => {
    if (!inputs.enabled) {
      // Reset all timers when watchdog is disabled (e.g. monitoring stopped
      // or the wizard opened) so we don't carry stale "since" timestamps.
      sinceRef.current = { quality: null, motion: null, bpm_drift: null, spo2_drift: null };
      return;
    }

    const intervalId = window.setInterval(() => {
      const i = inputsRef.current;
      if (!i.enabled) return;
      const now = performance.now();

      // ── 1. quality ────────────────────────────────────────────────
      const qFloor = i.baseline
        ? Math.max(20, i.baseline.qualityMean - Q_DROP)
        : ABS_Q_FLOOR;
      const qBad = i.quality > 0 && i.quality < qFloor;
      sinceRef.current.quality = qBad
        ? (sinceRef.current.quality ?? now)
        : null;

      // ── 2. motion ─────────────────────────────────────────────────
      const motionBad = i.motionLevel === 'MODERATE_MOTION' || i.motionLevel === 'SEVERE_MOTION';
      sinceRef.current.motion = motionBad
        ? (sinceRef.current.motion ?? now)
        : null;

      // ── 3. BPM drift (only if we have a baseline) ────────────────
      let bpmBad = false;
      if (i.baseline && i.baseline.bpmSamples >= 10 && i.bpm >= 30 && i.bpm <= 220) {
        const tol = Math.max(BPM_ABS, 3 * i.baseline.bpmSd);
        bpmBad = Math.abs(i.bpm - i.baseline.bpmMean) > tol;
      }
      sinceRef.current.bpm_drift = bpmBad
        ? (sinceRef.current.bpm_drift ?? now)
        : null;

      // ── 4. SpO₂ drift ────────────────────────────────────────────
      let spo2Bad = false;
      if (i.baseline && i.baseline.spo2Samples >= 10 && i.spo2 >= 70 && i.spo2 <= 100) {
        const tol = Math.max(SPO2_ABS, 3 * i.baseline.spo2Sd);
        spo2Bad = Math.abs(i.spo2 - i.baseline.spo2Mean) > tol;
      }
      sinceRef.current.spo2_drift = spo2Bad
        ? (sinceRef.current.spo2_drift ?? now)
        : null;

      // Cooldown gate.
      if (now - lastPromptAtRef.current < COOLDOWN_MS) return;

      // Pick the first reason whose hold-window has elapsed.
      const fired: Reason | null = (() => {
        const s = sinceRef.current;
        if (s.motion && now - s.motion >= MOTION_HOLD_MS) return 'motion';
        if (s.quality && now - s.quality >= HOLD_MS) return 'quality';
        if (s.bpm_drift && now - s.bpm_drift >= HOLD_MS) return 'bpm_drift';
        if (s.spo2_drift && now - s.spo2_drift >= HOLD_MS) return 'spo2_drift';
        return null;
      })();
      if (!fired) return;

      lastPromptAtRef.current = now;
      // Reset all timers so we don't immediately re-fire on the next tick.
      sinceRef.current = { quality: null, motion: null, bpm_drift: null, spo2_drift: null };

      toast({
        title: 'Recalibración recomendada',
        description: `${reasonLabel[fired]}. Toque CAL para recalibrar.`,
        duration: 6000,
      });
      // Light haptic so the operator notices on a noisy scene.
      try { navigator.vibrate?.([60, 40, 60]); } catch {}
      // Surface the prompt callback so the host can highlight the CAL button
      // (the toast itself doesn't get an inline button to keep UI noise low).
      onPromptRef.current?.();
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [inputs.enabled]);
}