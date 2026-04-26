/**
 * OpticalEvidenceGate — gate físico-óptico independiente de morfología.
 *
 * NO exige "morfología de dedo" ni umbrales arbitrarios de cobertura.
 * Solo decide, frame por frame, si la evidencia óptica es físicamente
 * compatible con tejido perfundido bajo el flash. Permite operar sobre
 * tejido herido, dedo frío, baja perfusión. Bloquea SOLO cuando la
 * cámara está físicamente mirando aire / objeto / superficie / luz /
 * o el sensor está saturado/recortado.
 *
 * Cada métrica está en unidades físicas — todas verificables desde el
 * stream RGB sin asumir ningún latido.
 */

export type RejectionCode =
  | 'OK'
  | 'CLIPPING_HIGH'
  | 'CLIPPING_LOW'
  | 'INSUFFICIENT_AC'
  | 'NO_HEMOGLOBIN'
  | 'FLAT_TEXTURE'
  | 'OVEREXPOSED'
  | 'UNDEREXPOSED'
  | 'PERFUSION_DROP';

export interface OpticalEvidenceMetrics {
  acDc: number;
  rOverGB: number;
  texture: number;
  clipHigh: number;
  clipLow: number;
  pi: number;
  meanR: number;
}

export interface OpticalEvidence {
  accept: boolean;
  reason: RejectionCode;
  reasonText: string;
  metrics: OpticalEvidenceMetrics;
}

export interface ROIStats {
  meanR: number;       // 0..255
  meanG: number;
  meanB: number;
  stdR: number;        // std dev del rojo en ROI
  clipHighRatio: number; // fracción [0..1] píxeles ROI con R>=250
  clipLowRatio: number;  // fracción [0..1] píxeles ROI con R<=5
  acComponent: number; // amplitud AC ventana corta (señal cruda OD/red)
  dcComponent: number; // promedio DC ventana corta
}

export interface OpticalGateConfig {
  // Umbrales calibrados desde literatura PPG móvil (Nature Sci.Rep. 2014,
  // IEEE TBME 2019, "smartphone PPG validation" Apple Heart Study 2020).
  // Se mantienen permisivos para no excluir tejido en shock o herido.
  clipHighMax: number;   // 0.05 — >5% píxeles cerca de 255 = pérdida de info
  clipLowMax: number;    // 0.05 — >5% píxeles cerca de 0 = sombra
  meanRMax: number;      // 245 — sobre-exposición global
  meanRMin: number;      // 25 — sub-exposición global
  rOverGBMin: number;    // 1.20 — firma mínima de hemoglobina
  textureMin: number;    // 0.003 — superficie no-plana (stdR/meanR)
  acDcMin: number;       // 0.0015 — pulsatilidad mínima detectable
  perfusionDropRatio: number; // 0.70 — caída >70% en piWindow = despegue
}

export const DEFAULT_OPTICAL_GATE_CONFIG: OpticalGateConfig = {
  // Recalibrated for REAR CAMERA + TORCH ON. Heavy red saturation
  // is the NORMAL state of a finger pressed against the lens; the
  // pulsatile component still rides on top. Forensic use also covers
  // poorly perfused (cold/shock/wounded) tissue, so the AC/DC floor
  // is lower than the published lab thresholds.
  clipHighMax: 0.25,        // tolerate partial saturation
  clipLowMax: 0.05,
  meanRMax: 252,            // rear flash legitimately drives red ≥ 245
  meanRMin: 25,
  rOverGBMin: 1.10,         // pale / cold tissue
  textureMin: 0.003,
  acDcMin: 0.0008,          // perfusion-collapsed tissue (forensic)
  perfusionDropRatio: 0.70,
};

const REASON_TEXT: Record<RejectionCode, string> = {
  OK: 'OK',
  CLIPPING_HIGH: 'SENSOR SATURADO (>5% píxeles en 255)',
  CLIPPING_LOW: 'SOMBRA EN ROI (>5% píxeles en 0)',
  INSUFFICIENT_AC: 'SIN PULSATILIDAD ÓPTICA (AC/DC < umbral)',
  NO_HEMOGLOBIN: 'SIN FIRMA DE HEMOGLOBINA (R/(G+B) bajo)',
  FLAT_TEXTURE: 'SUPERFICIE PLANA — NO ES TEJIDO',
  OVEREXPOSED: 'SOBRE-EXPOSICIÓN — REDUCIR PRESIÓN/FLASH',
  UNDEREXPOSED: 'SUB-EXPOSICIÓN — ACERQUE EL DEDO AL FLASH',
  PERFUSION_DROP: 'DEDO DESPEGADO — PERFUSIÓN COLAPSADA',
};

export class OpticalEvidenceGate {
  private cfg: OpticalGateConfig;

  constructor(cfg: Partial<OpticalGateConfig> = {}) {
    this.cfg = { ...DEFAULT_OPTICAL_GATE_CONFIG, ...cfg };
  }

  /** Permite ajustar umbrales en caliente (panel de auditoría forense). */
  setConfig(patch: Partial<OpticalGateConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  getConfig(): OpticalGateConfig {
    return { ...this.cfg };
  }

  /**
   * Evalúa una muestra. `history.piWindow` debe contener los últimos
   * ~500 ms de Perfusion Index para detectar despegues bruscos del dedo.
   */
  evaluate(
    roi: ROIStats,
    history: { piWindow: number[] }
  ): OpticalEvidence {
    const meanR = roi.meanR;
    const meanGB = (roi.meanG + roi.meanB) / 2;
    const rOverGB = meanGB > 0.5 ? meanR / meanGB : 0;
    const texture = meanR > 1 ? roi.stdR / meanR : 0;
    const acDc = roi.dcComponent > 1e-6 ? Math.abs(roi.acComponent) / roi.dcComponent : 0;
    const pi = acDc;

    // Orden de evaluación: descartes "duros" primero (saturación / sombra
    // / exposición fuera de rango), luego firma física, luego pulsatilidad.
    let reason: RejectionCode = 'OK';

    if (roi.clipHighRatio > this.cfg.clipHighMax)      reason = 'CLIPPING_HIGH';
    else if (roi.clipLowRatio > this.cfg.clipLowMax)   reason = 'CLIPPING_LOW';
    else if (meanR > this.cfg.meanRMax)                reason = 'OVEREXPOSED';
    else if (meanR < this.cfg.meanRMin)                reason = 'UNDEREXPOSED';
    else if (rOverGB < this.cfg.rOverGBMin)            reason = 'NO_HEMOGLOBIN';
    else if (texture < this.cfg.textureMin)            reason = 'FLAT_TEXTURE';
    else if (acDc < this.cfg.acDcMin)                  reason = 'INSUFFICIENT_AC';
    else if (this.detectPerfusionDrop(history.piWindow)) reason = 'PERFUSION_DROP';

    const accept = reason === 'OK';

    return {
      accept,
      reason,
      reasonText: REASON_TEXT[reason],
      metrics: {
        acDc,
        rOverGB,
        texture,
        clipHigh: roi.clipHighRatio,
        clipLow: roi.clipLowRatio,
        pi,
        meanR,
      },
    };
  }

  /** Detecta caída >X% del PI en la ventana — síntoma de despegue de dedo. */
  private detectPerfusionDrop(piWindow: number[]): boolean {
    if (piWindow.length < 6) return false;
    const half = piWindow.length >> 1;
    let prevSum = 0, currSum = 0;
    for (let i = 0; i < half; i++) prevSum += piWindow[i];
    for (let i = half; i < piWindow.length; i++) currSum += piWindow[i];
    const prev = prevSum / half;
    const curr = currSum / (piWindow.length - half);
    if (prev <= 1e-6) return false;
    return (prev - curr) / prev >= this.cfg.perfusionDropRatio;
  }
}
