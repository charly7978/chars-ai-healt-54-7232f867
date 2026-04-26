import { describe, it, expect } from "vitest";
import {
  applySnapshot,
  createInitialState,
  deriveStatus,
  DEFAULT_SR_DIAG_OPTIONS,
  type SRDiagState,
} from "../srDiagnosticsState";
import type { SampleRateEstimate } from "@/modules/signal-processing/timing/SampleRateEstimator";

function snap(partial: Partial<SampleRateEstimate> = {}): SampleRateEstimate {
  return {
    sampleRate: 30,
    valid: true,
    stalled: false,
    jitterCoV: 0.01,
    medianDeltaMs: 33.3,
    samplesObserved: 50,
    lastRejected: false,
    ...partial,
  };
}

function feed(states: SRDiagState[], snaps: SampleRateEstimate[], startAt = 1_000): SRDiagState {
  let s = states[0];
  let t = startAt;
  for (const sn of snaps) {
    s = applySnapshot(s, sn, t);
    t += 200;
  }
  return s;
}

describe("SR diagnostics state machine – status transitions", () => {
  it("starts in WARMING when estimator is not yet valid", () => {
    const s = createInitialState();
    const sn = snap({ valid: false, sampleRate: 0 });
    expect(deriveStatus(s, sn)).toBe("WARMING");
  });

  it("transitions WARMING → LOCKED on first valid snapshot", () => {
    const s0 = createInitialState();
    const s1 = applySnapshot(s0, snap(), 1000);
    expect(deriveStatus(s1, snap())).toBe("LOCKED");
    expect(s1.lastTrustedSR).toBeGreaterThan(0);
  });

  it("transitions LOCKED → STALLED on a stall snapshot", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap({ sampleRate: 29.8 }), 1000);
    expect(deriveStatus(s, snap({ sampleRate: 29.8 }))).toBe("LOCKED");

    const stallSnap = snap({ stalled: true, sampleRate: 29.8 });
    s = applySnapshot(s, stallSnap, 1500);
    expect(deriveStatus(s, stallSnap)).toBe("STALLED");
    // Last trusted SR is preserved for the UI to display.
    expect(s.lastTrustedSR).toBeCloseTo(29.8, 5);
  });

  it("transitions STALLED → RECOVERING when estimator clears stall", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap({ sampleRate: 30 }), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    // First non-stalled good frame after stall
    const ok = snap({ sampleRate: 29.9 });
    s = applySnapshot(s, ok, 1700);
    expect(deriveStatus(s, ok)).toBe("RECOVERING");
    expect(s.recoveryProgress).toBe(1);
  });

  it("transitions RECOVERING → LOCKED after `recoveryFrames` good deltas", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap(), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    for (let i = 0; i < DEFAULT_SR_DIAG_OPTIONS.recoveryFrames; i++) {
      s = applySnapshot(s, snap({ sampleRate: 30 }), 1700 + i * 200);
    }
    expect(s.wasStalled).toBe(false);
    expect(s.recoveryProgress).toBe(0);
    expect(deriveStatus(s, snap())).toBe("LOCKED");
  });

  it("does not advance recovery while estimator keeps rejecting samples", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap(), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    for (let i = 0; i < 5; i++) {
      s = applySnapshot(s, snap({ lastRejected: true }), 1700 + i * 200);
    }
    expect(s.wasStalled).toBe(true);
    expect(s.recoveryProgress).toBe(0);
  });

  it("re-enters STALLED if a second stall arrives mid-recovery", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap(), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    s = applySnapshot(s, snap(), 1700);
    s = applySnapshot(s, snap(), 1900);
    expect(s.recoveryProgress).toBe(2);
    s = applySnapshot(s, snap({ stalled: true }), 2100);
    expect(s.recoveryProgress).toBe(0);
    expect(s.wasStalled).toBe(true);
  });
});

describe("SR diagnostics state machine – jitter robustness", () => {
  it("ignores brief rejected samples but still counts good ones during recovery", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap(), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    s = applySnapshot(s, snap(), 1700);                       // +1
    s = applySnapshot(s, snap({ lastRejected: true }), 1900); // ignored
    s = applySnapshot(s, snap(), 2100);                       // +1
    expect(s.recoveryProgress).toBe(2);
    expect(deriveStatus(s, snap())).toBe("RECOVERING");
  });

  it("freezes lastTrustedSR during the entire stall window", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap({ sampleRate: 31.2 }), 1000);
    expect(s.lastTrustedSR).toBeCloseTo(31.2, 5);
    // Many stalled snapshots arriving with garbage SR values must NOT update it.
    for (let i = 0; i < 8; i++) {
      s = applySnapshot(s, snap({ stalled: true, sampleRate: 99 }), 1500 + i * 200);
    }
    expect(s.lastTrustedSR).toBeCloseTo(31.2, 5);
  });
});

describe("SR diagnostics event log", () => {
  it("records stall_detected exactly once per stall episode", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap(), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    s = applySnapshot(s, snap({ stalled: true }), 1700);
    s = applySnapshot(s, snap({ stalled: true }), 1900);
    const stalls = s.events.filter(e => e.kind === "stall_detected");
    expect(stalls.length).toBe(1);
    expect(stalls[0].lastTrustedSR).toBeGreaterThan(0);
  });

  it("records recovery_started once and recovery_completed when threshold met", () => {
    let s = createInitialState();
    s = applySnapshot(s, snap({ sampleRate: 30 }), 1000);
    s = applySnapshot(s, snap({ stalled: true }), 1500);
    for (let i = 0; i < 6; i++) {
      s = applySnapshot(s, snap({ sampleRate: 30 }), 1700 + i * 200);
    }
    const kinds = s.events.map(e => e.kind);
    expect(kinds).toEqual(["stall_detected", "recovery_started", "recovery_completed"]);
    const completed = s.events[s.events.length - 1];
    expect(completed.recoveryFrames).toBe(6);
    expect(completed.lastTrustedSR).toBeCloseTo(30, 5);
  });

  it("caps the event log at maxEvents", () => {
    let s = createInitialState();
    const opts = { recoveryFrames: 2, maxEvents: 4 };
    // Trigger many stall/recovery cycles
    let t = 1000;
    s = applySnapshot(s, snap(), t); t += 200;
    for (let i = 0; i < 10; i++) {
      s = applySnapshot(s, snap({ stalled: true }), t, opts); t += 200;
      s = applySnapshot(s, snap(), t, opts); t += 200;
      s = applySnapshot(s, snap(), t, opts); t += 200;
    }
    expect(s.events.length).toBeLessThanOrEqual(4);
  });
});

describe("SR diagnostics – integration over a synthetic stream", () => {
  it("walks LOCKED → STALLED → RECOVERING → LOCKED across a realistic sequence", () => {
    let s = createInitialState();
    let t = 1000;
    let lastStatus = deriveStatus(s, snap({ valid: false, sampleRate: 0 }));
    const transitions: string[] = [];
    function step(sn: SampleRateEstimate) {
      s = applySnapshot(s, sn, t);
      t += 200;
      const status = deriveStatus(s, sn);
      if (status !== lastStatus) {
        transitions.push(status);
        lastStatus = status;
      }
    }
    // Warm up
    step(snap({ valid: false, sampleRate: 0 }));
    // Lock
    for (let i = 0; i < 3; i++) step(snap({ sampleRate: 30 }));
    // Stall
    for (let i = 0; i < 4; i++) step(snap({ stalled: true }));
    // Recover
    for (let i = 0; i < 8; i++) step(snap({ sampleRate: 30 }));

    expect(transitions).toEqual(["LOCKED", "STALLED", "RECOVERING", "LOCKED"]);
  });
});