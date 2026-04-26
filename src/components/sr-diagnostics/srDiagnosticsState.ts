/**
 * Pure state machine for the SR diagnostics panel.
 *
 * Decouples the UI (SRDiagnostics.tsx) from the transition logic so we can
 * unit-test LOCKED → WARMING → STALLED → RECOVERING → LOCKED transitions,
 * recovery progress accounting, and the event log without rendering React.
 *
 * This module performs zero allocations on the hot path beyond the explicit
 * event push (capped by `maxEvents`).
 */
import type { SampleRateEstimate } from "@/modules/signal-processing/timing/SampleRateEstimator";

export type SRStatus = "WARMING" | "LOCKED" | "STALLED" | "RECOVERING";

export type SREventKind = "stall_detected" | "recovery_started" | "recovery_completed" | "locked";

export interface SREvent {
  kind: SREventKind;
  /** Wall-clock time (ms). Caller injects to keep this pure. */
  at: number;
  /** Frozen "last trusted" SR at the moment of the event (Hz). 0 if unknown. */
  lastTrustedSR: number;
  /** For `recovery_completed`: how many frames of stable Δt were collected. */
  recoveryFrames?: number;
}

export interface SRDiagState {
  /** Whether we are currently in (or returning from) a stall. */
  wasStalled: boolean;
  /** Consecutive plausible deltas since stall ended (counts toward recovery). */
  recoveryProgress: number;
  /** Last SR considered trustworthy (frozen during stall). */
  lastTrustedSR: number;
  /** Capped, append-only ring of recent events (newest last). */
  events: SREvent[];
}

export interface SRDiagOptions {
  /** How many consecutive good deltas exit RECOVERING → LOCKED. */
  recoveryFrames: number;
  /** Hard cap on retained events. */
  maxEvents: number;
}

export const DEFAULT_SR_DIAG_OPTIONS: SRDiagOptions = {
  recoveryFrames: 6,
  maxEvents: 20,
};

export function createInitialState(): SRDiagState {
  return { wasStalled: false, recoveryProgress: 0, lastTrustedSR: 0, events: [] };
}

/**
 * Apply one estimator snapshot. Returns a NEW state object so React can
 * detect change cheaply, but inner arrays are reused unless mutated.
 */
export function applySnapshot(
  prev: SRDiagState,
  snap: SampleRateEstimate,
  now: number,
  opts: SRDiagOptions = DEFAULT_SR_DIAG_OPTIONS,
): SRDiagState {
  let { wasStalled, recoveryProgress, lastTrustedSR, events } = prev;

  // 1) Track last trusted SR while LOCKED (valid + not stalled).
  if (snap.valid && !snap.stalled) {
    lastTrustedSR = snap.sampleRate;
  }

  // 2) Stall transitions
  if (snap.stalled) {
    if (!wasStalled) {
      // LOCKED/WARMING → STALLED
      events = pushEvent(events, opts.maxEvents, {
        kind: "stall_detected",
        at: now,
        lastTrustedSR,
      });
    }
    wasStalled = true;
    recoveryProgress = 0;
  } else if (wasStalled) {
    // We were stalled, the estimator is no longer stalled.
    if (recoveryProgress === 0) {
      events = pushEvent(events, opts.maxEvents, {
        kind: "recovery_started",
        at: now,
        lastTrustedSR,
      });
    }
    if (snap.valid && !snap.lastRejected) {
      recoveryProgress = Math.min(opts.recoveryFrames, recoveryProgress + 1);
      if (recoveryProgress >= opts.recoveryFrames) {
        events = pushEvent(events, opts.maxEvents, {
          kind: "recovery_completed",
          at: now,
          lastTrustedSR,
          recoveryFrames: recoveryProgress,
        });
        wasStalled = false;
        recoveryProgress = 0;
      }
    }
  }

  return { wasStalled, recoveryProgress, lastTrustedSR, events };
}

/**
 * Map (state, snapshot) → status label. Pure / cheap; safe to call in render.
 */
export function deriveStatus(state: SRDiagState, snap: SampleRateEstimate): SRStatus {
  if (snap.stalled) return "STALLED";
  if (state.wasStalled) return "RECOVERING";
  if (snap.valid) return "LOCKED";
  return "WARMING";
}

function pushEvent(events: SREvent[], cap: number, ev: SREvent): SREvent[] {
  const next = events.length >= cap ? events.slice(1) : events.slice();
  next.push(ev);
  return next;
}