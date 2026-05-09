/**
 * Controlador de cámara con degradación progresiva.
 * - Selecciona cámara trasera con torch.
 * - Aplica constraints en fases tolerantes a fallos.
 * - Lock de exposureMode/whiteBalanceMode/focusMode cuando estén disponibles.
 */
export interface CameraDiagnostics {
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings | null;
  torchSupported: boolean;
  torchEnabled: boolean;
  appliedAdvanced: Record<string, unknown> | null;
}

export class CameraController {
  private stream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  public diag: CameraDiagnostics = {
    capabilities: null,
    settings: null,
    torchSupported: false,
    torchEnabled: false,
    appliedAdvanced: null,
  };

  async initialize(): Promise<MediaStream> {
    const ladder: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, min: 24, max: 30 } } },
      { audio: false, video: { facingMode: "environment", width: { ideal: 480 }, height: { ideal: 360 } } },
      { audio: false, video: true },
    ];
    let lastErr: unknown = null;
    for (const c of ladder) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        this.videoTrack = this.stream.getVideoTracks()[0] ?? null;
        this.extractMetadata();
        await this.optimizeSettings();
        return this.stream;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("Imposible inicializar cámara");
  }

  private extractMetadata(): void {
    if (!this.videoTrack) return;
    this.diag.capabilities = this.videoTrack.getCapabilities ? this.videoTrack.getCapabilities() : null;
    this.diag.settings = this.videoTrack.getSettings ? this.videoTrack.getSettings() : null;
    this.diag.torchSupported = !!(this.diag.capabilities as any)?.torch;
  }

  private async optimizeSettings(): Promise<void> {
    if (!this.videoTrack) return;
    const caps: any = this.diag.capabilities ?? {};
    const adv: any = {};
    if (caps.focusMode?.includes("continuous")) adv.focusMode = "continuous";
    else if (caps.focusMode?.includes("manual")) adv.focusMode = "manual";
    if (caps.exposureMode?.includes("continuous")) adv.exposureMode = "continuous";
    if (caps.whiteBalanceMode?.includes("continuous")) adv.whiteBalanceMode = "continuous";
    if (Object.keys(adv).length > 0) {
      try {
        await this.videoTrack.applyConstraints({ advanced: [adv] });
        this.diag.appliedAdvanced = adv;
      } catch {
        this.diag.appliedAdvanced = null;
      }
    }
  }

  async setTorch(enabled: boolean): Promise<boolean> {
    if (!this.videoTrack || !this.diag.torchSupported) return false;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: enabled } as any] });
      this.diag.torchEnabled = enabled;
      return true;
    } catch {
      this.diag.torchEnabled = false;
      return false;
    }
  }

  stop(): void {
    if (this.videoTrack) {
      this.setTorch(false).catch(() => {});
      try { this.videoTrack.stop(); } catch {}
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch {} }
    }
    this.stream = null;
    this.videoTrack = null;
  }
}
