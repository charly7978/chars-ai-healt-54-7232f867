import { useEffect, useState } from "react";
import type { SampleRateEstimator, SampleRateEstimate } from "@/modules/signal-processing/timing/SampleRateEstimator";
import {
  applySnapshot,
  createInitialState,
  deriveStatus,
  type SRDiagState,
  type SREvent,
} from "./sr-diagnostics/srDiagnosticsState";

/**
 * Compact diagnostics panel for the SampleRateEstimator.
 * - Polls the estimator at ~5 Hz (cheap, no re-renders during signal hot path).
 * - Shows: SR (Hz), valid flag, stall state, last trusted SR, jitter (CoV),
 *   median Δt, samples observed, and a recovery bar that fills as plausible
 *   deltas come back after a stall.
 * - Emits an event log entry whenever the state machine transitions across
 *   stall/recovery boundaries so devs can audit camera silence in real time.
 */
interface Props {
  estimator: SampleRateEstimator;
  recoveryFrames?: number; // expected, used to render the bar (defaults 6)
  maxEvents?: number;
  hidden?: boolean;
}

export const SRDiagnostics = ({ estimator, recoveryFrames = 6, maxEvents = 12, hidden }: Props) => {
  const [snap, setSnap] = useState<SampleRateEstimate>(() => estimator.read());
  const [diag, setDiag] = useState<SRDiagState>(() => createInitialState());

  useEffect(() => {
    const id = window.setInterval(() => {
      const s = estimator.read();
      setSnap(s);
      setDiag(prev => applySnapshot(prev, s, Date.now(), { recoveryFrames, maxEvents }));
    }, 200);
    return () => window.clearInterval(id);
  }, [estimator, recoveryFrames, maxEvents]);

  if (hidden) return null;

  const status = deriveStatus(diag, snap);
  const statusColor =
    status === "STALLED"
      ? "bg-destructive text-destructive-foreground"
      : status === "RECOVERING"
        ? "bg-yellow-500 text-black"
        : status === "LOCKED"
          ? "bg-emerald-500 text-black"
          : "bg-muted text-muted-foreground";

  return (
    <div
      className="fixed bottom-2 right-2 z-40 rounded-md border border-border bg-card/95 backdrop-blur-md text-card-foreground shadow-lg px-2.5 py-2 text-[10px] leading-tight"
      style={{ minWidth: 200, maxWidth: 240 }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold">SR Diagnostics</span>
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${statusColor}`}>
          {status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
        <span className="text-muted-foreground">SR</span>
        <span className="text-right font-semibold">{snap.sampleRate.toFixed(2)} Hz</span>

        <span className="text-muted-foreground">Last trusted</span>
        <span className="text-right">
          {diag.lastTrustedSR > 0 ? `${diag.lastTrustedSR.toFixed(2)} Hz` : "—"}
        </span>

        <span className="text-muted-foreground">Median Δt</span>
        <span className="text-right">{snap.medianDeltaMs > 0 ? `${snap.medianDeltaMs.toFixed(1)} ms` : "—"}</span>

        <span className="text-muted-foreground">Jitter (CoV)</span>
        <span className="text-right">{snap.jitterCoV > 0 ? snap.jitterCoV.toFixed(3) : "—"}</span>

        <span className="text-muted-foreground">Frames seen</span>
        <span className="text-right">{snap.samplesObserved}</span>
      </div>

      {/* Recovery progress bar (visible while recovering OR fully stalled) */}
      {(snap.stalled || diag.wasStalled) && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-muted-foreground">Recovery</span>
            <span className="tabular-nums text-muted-foreground">
              {snap.stalled ? 0 : diag.recoveryProgress}/{recoveryFrames}
            </span>
          </div>
          <div className="h-1.5 rounded bg-muted overflow-hidden">
            <div
              className={`h-full transition-all ${snap.stalled ? "bg-destructive" : "bg-yellow-500"}`}
              style={{
                width: `${snap.stalled ? 0 : (diag.recoveryProgress / recoveryFrames) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Event log */}
      {diag.events.length > 0 && (
        <div className="mt-1.5 border-t border-border pt-1">
          <div className="text-muted-foreground mb-0.5">Events</div>
          <ul className="space-y-0.5 max-h-24 overflow-y-auto pr-1">
            {diag.events.slice().reverse().map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="flex items-baseline gap-1">
                <span className="tabular-nums text-muted-foreground shrink-0">
                  {formatTime(ev.at)}
                </span>
                <span className={eventColor(ev)}>{eventLabel(ev)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function eventLabel(ev: SREvent): string {
  const sr = ev.lastTrustedSR > 0 ? `${ev.lastTrustedSR.toFixed(1)}Hz` : "—";
  switch (ev.kind) {
    case "stall_detected": return `STALL · last ${sr}`;
    case "recovery_started": return `Recovering · last ${sr}`;
    case "recovery_completed": return `Recovered · ${ev.recoveryFrames}f · ${sr}`;
    case "locked": return `LOCKED · ${sr}`;
  }
}

function eventColor(ev: SREvent): string {
  switch (ev.kind) {
    case "stall_detected": return "text-destructive font-semibold";
    case "recovery_started": return "text-yellow-500";
    case "recovery_completed": return "text-emerald-500 font-semibold";
    case "locked": return "text-emerald-500";
  }
}
