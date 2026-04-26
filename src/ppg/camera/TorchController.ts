/**
 * TORCH CONTROLLER
 * 
 * Manages torch/flash state for rear camera.
 * 
 * Rules:
 * - Enable torch before measurement starts
 * - Keep torch alive with watchdog (re-apply every 2s)
 * - Disable torch only on stopMeasurement
 * - Report TORCH_UNAVAILABLE if not supported
 */

export interface TorchStatus {
  supported: boolean;
  active: boolean;
  lastCheckTime: number;
}

export class TorchController {
  private track: MediaStreamTrack | null = null;
  private status: TorchStatus = {
    supported: false,
    active: false,
    lastCheckTime: 0,
  };
  private watchdogInterval: number | null = null;
  private readonly WATCHDOG_INTERVAL_MS = 2000;

  /**
   * Attach video track for torch control
   */
  setTrack(track: MediaStreamTrack): void {
    this.track = track;
    this.checkSupport();
  }

  /**
   * Check if torch is supported by this track
   */
  private checkSupport(): void {
    if (!this.track) {
      this.status.supported = false;
      return;
    }

    const capabilities = this.track.getCapabilities?.() as any;
    this.status.supported = capabilities?.torch === true;
    this.status.lastCheckTime = performance.now();
  }

  /**
   * Enable torch on the track
   */
  async enable(): Promise<boolean> {
    if (!this.track) {
      console.warn('No track set for torch control');
      return false;
    }

    if (!this.status.supported) {
      console.warn('Torch not supported by device');
      return false;
    }

    try {
      await this.track.applyConstraints({
        advanced: [{ torch: true }] as any,
      });
      this.status.active = true;
      this.status.lastCheckTime = performance.now();
      return true;
    } catch (error) {
      console.error('Failed to enable torch:', error);
      this.status.active = false;
      return false;
    }
  }

  /**
   * Disable torch on the track
   */
  async disable(): Promise<void> {
    if (!this.track) return;

    try {
      await this.track.applyConstraints({
        advanced: [{ torch: false }] as any,
      });
      this.status.active = false;
      this.status.lastCheckTime = performance.now();
    } catch (error) {
      console.error('Failed to disable torch:', error);
    }
  }

  /**
   * Start watchdog to keep torch alive
   */
  startWatchdog(): void {
    if (this.watchdogInterval !== null) {
      clearInterval(this.watchdogInterval);
    }

    this.watchdogInterval = window.setInterval(async () => {
      if (!this.track) return;

      try {
        const settings = this.track.getSettings?.() as any;
        if (settings?.torch !== true && this.status.supported) {
          console.log('Torch watchdog: re-enabling torch');
          await this.enable();
        }
        this.status.lastCheckTime = performance.now();
      } catch (error) {
        console.warn('Torch watchdog check failed:', error);
      }
    }, this.WATCHDOG_INTERVAL_MS);
  }

  /**
   * Stop watchdog
   */
  stopWatchdog(): void {
    if (this.watchdogInterval !== null) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * Get current status
   */
  getStatus(): TorchStatus {
    return { ...this.status };
  }

  /**
   * Reset controller state
   */
  reset(): void {
    this.stopWatchdog();
    this.track = null;
    this.status = {
      supported: false,
      active: false,
      lastCheckTime: 0,
    };
  }
}
