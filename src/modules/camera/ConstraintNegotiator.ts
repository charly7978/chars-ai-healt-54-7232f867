/**
 * ConstraintNegotiator
 * --------------------
 * Phased, capability-aware negotiation of MediaStreamTrack constraints for
 * finger-PPG capture. Each phase is applied independently; failures degrade
 * gracefully and are recorded for forensic telemetry.
 *
 * Design goals (mobile, hot path friendly):
 *  - Zero allocations in steady state (single result object reused per session)
 *  - No throw on partial failures — every applyConstraints is wrapped
 *  - Honest reporting: only flags as "locked" what the device actually accepted
 */

export interface NegotiationReport {
  supportedConstraints: string[];
  capabilities: Record<string, unknown>;
  finalSettings: Record<string, unknown>;
  applied: {
    frameRate: boolean;
    exposureMode: 'manual' | 'continuous' | 'none';
    exposureCompensation: number | null;
    whiteBalanceMode: 'manual' | 'continuous' | 'none';
    iso: number | null;
    focusMode: 'manual' | 'continuous' | 'none';
    torch: boolean;
  };
  failures: string[];
}

const TARGET_FPS = 30;
const TARGET_ISO = 100;
const TARGET_EXPOSURE_COMP = -0.5;

async function tryApply(
  track: MediaStreamTrack,
  name: string,
  value: unknown,
  failures: string[],
): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [{ [name]: value } as any] });
    return true;
  } catch {
    failures.push(name);
    return false;
  }
}

export class ConstraintNegotiator {
  /**
   * Run the phased negotiation against an already-open video track.
   * The caller is responsible for stream lifecycle.
   */
  static async negotiate(track: MediaStreamTrack): Promise<NegotiationReport> {
    const failures: string[] = [];
    const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
    const supportedConstraints = Object.keys(supported).filter(k => (supported as any)[k]);
    const caps = (track.getCapabilities?.() as any) ?? {};

    const report: NegotiationReport = {
      supportedConstraints,
      capabilities: caps,
      finalSettings: {},
      applied: {
        frameRate: false,
        exposureMode: 'none',
        exposureCompensation: null,
        whiteBalanceMode: 'none',
        iso: null,
        focusMode: 'none',
        torch: false,
      },
      failures,
    };

    // Phase A — Frame rate lock (stabilizes sample rate estimation)
    report.applied.frameRate = await tryApply(track, 'frameRate', TARGET_FPS, failures);

    // Phase B — Torch (ignore here, CameraView handles torch lifecycle/watchdog)

    // Phase C — Exposure mode (prefer manual for PPG)
    if (Array.isArray(caps.exposureMode)) {
      if (caps.exposureMode.includes('manual') && await tryApply(track, 'exposureMode', 'manual', failures)) {
        report.applied.exposureMode = 'manual';
      } else if (caps.exposureMode.includes('continuous') && await tryApply(track, 'exposureMode', 'continuous', failures)) {
        report.applied.exposureMode = 'continuous';
      }
    }

    // Phase D — Exposure compensation (slightly negative → more headroom against saturation)
    if (caps.exposureCompensation) {
      const min = caps.exposureCompensation.min ?? -2;
      const max = caps.exposureCompensation.max ?? 2;
      const target = Math.max(min, Math.min(max, TARGET_EXPOSURE_COMP));
      if (await tryApply(track, 'exposureCompensation', target, failures)) {
        report.applied.exposureCompensation = target;
      }
    }

    // Phase E — White balance lock
    if (Array.isArray(caps.whiteBalanceMode)) {
      if (caps.whiteBalanceMode.includes('manual') && await tryApply(track, 'whiteBalanceMode', 'manual', failures)) {
        report.applied.whiteBalanceMode = 'manual';
      } else if (caps.whiteBalanceMode.includes('continuous') && await tryApply(track, 'whiteBalanceMode', 'continuous', failures)) {
        report.applied.whiteBalanceMode = 'continuous';
      }
    }

    // Phase F — ISO (low ISO → better SNR under torch)
    if (caps.iso) {
      const minISO = caps.iso.min ?? 50;
      const maxISO = caps.iso.max ?? 800;
      const target = Math.max(minISO, Math.min(maxISO, TARGET_ISO));
      if (await tryApply(track, 'iso', target, failures)) {
        report.applied.iso = target;
      }
    }

    // Phase G — Focus
    if (Array.isArray(caps.focusMode)) {
      if (caps.focusMode.includes('manual') && await tryApply(track, 'focusMode', 'manual', failures)) {
        report.applied.focusMode = 'manual';
      } else if (caps.focusMode.includes('continuous') && await tryApply(track, 'focusMode', 'continuous', failures)) {
        report.applied.focusMode = 'continuous';
      }
    }

    // Snapshot final settings
    try {
      report.finalSettings = (track.getSettings?.() as any) ?? {};
    } catch {
      report.finalSettings = {};
    }

    return report;
  }
}
