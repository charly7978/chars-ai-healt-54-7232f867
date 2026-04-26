import { useEffect, useState, useRef } from "react";
import type { SampleRateEstimator, SampleRateEstimate } from "@/modules/signal-processing/timing/SampleRateEstimator";

/**
 * Compact diagnostics panel for the SampleRateEstimator.
 * - Polls the estimator at ~5 Hz (cheap, no re-renders during signal hot path).
 * - Shows: SR (Hz), valid flag, stall state, last trusted SR, jitter (CoV),
 *   median Δt, samples observed, and a recovery bar that fills as plausible
 *   deltas come back after a stall.
 */
interface Props {
  estimator: SampleRateEstimator;
  recoveryFrames?: number; // expected, used to render the bar (defaults 6)
  hidden?: boolean;
}

export const SRDiagnostics = ({ estimator, recoveryFrames = 6, hidden }: Props) => {
  const [snap, setSnap] = useState<SampleRateEstimate>(() => estimator.read());
  // Track recovery: count consecutive non-stalled good reads after a stall.
  const wasStalledRef = useRef(false);
  const recoveryRef = useRef(0);
  const lastTrustedSRRef = useRef(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      const s = estimator.read();

      // Maintain recovery counter
      if (s.stalled) {
        wasStalledRef.current = true;
        recoveryRef.current = 0;
      } else if (wasStalledRef.current) {
        if (s.valid && !s.lastRejected) {
          recoveryRef.current = Math.min(recoveryFrames, recoveryRef.current + 1);
          if (recoveryRef.current >= recoveryFrames) {
            wasStalledRef.current = false;
          }
        }
      }

      // Track the last trusted SR (frozen value during stall)
      if (s.valid && !s.stalled) lastTrustedSRRef.current = s.sampleRate;

      setSnap(s);
    }, 200);
    return () => window.clearInterval(id);
  }, [estimator, recoveryFrames]);

  if (hidden) return null;

  const recovering = wasStalledRef.current && !snap.stalled;
  const statusColor = snap.stalled
    ? "bg-destructive text-destructive-foreground"
    : recovering
      ? "bg-yellow-500 text-black"
      : snap.valid
        ? "bg-emerald-500 text-black"
        : "bg-muted text-muted-foreground";

  const statusLabel = snap.stalled
    ? "STALLED"
    : recovering
      ? "RECOVERING"
      : snap.valid
        ? "LOCKED"
        : "WARMING";

  return (
    <div
      className="fixed bottom-2 right-2 z-40 rounded-md border border-border bg-card/95 backdrop-blur-md text-card-foreground shadow-lg px-2.5 py-2 text-[10px] leading-tight"
      style={{ minWidth: 180 }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold">SR Diagnostics</span>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
        <span className="text-muted-foreground">SR</span>
        <span className="text-right font-semibold">{snap.sampleRate.toFixed(2)} Hz</span>

        <span className="text-muted-foreground">Last trusted</span>
        <span className="text-right">
          {lastTrustedSRRef.current > 0 ? `${lastTrustedSRRef.current.toFixed(2)} Hz` : "—"}
        </span>

        <span className="text-muted-foreground">Median Δt</span>
        <span className="text-right">{snap.medianDeltaMs > 0 ? `${snap.medianDeltaMs.toFixed(1)} ms` : "—"}</span>

        <span className="text-muted-foreground">Jitter (CoV)</span>
        <span className="text-right">{snap.jitterCoV > 0 ? snap.jitterCoV.toFixed(3) : "—"}</span>

        <span className="text-muted-foreground">Frames seen</span>
        <span className="text-right">{snap.samplesObserved}</span>
      </div>

      {/* Recovery progress bar (visible while recovering OR fully stalled) */}
      {(snap.stalled || recovering) && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-muted-foreground">Recovery</span>
            <span className="tabular-nums text-muted-foreground">
              {snap.stalled ? "0" : recoveryRef.current}/{recoveryFrames}
            </span>
          </div>
          <div className="h-1.5 rounded bg-muted overflow-hidden">
            <div
              className={`h-full transition-all ${snap.stalled ? "bg-destructive" : "bg-yellow-500"}`}
              style={{
                width: `${snap.stalled ? 0 : (recoveryRef.current / recoveryFrames) * 100}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
