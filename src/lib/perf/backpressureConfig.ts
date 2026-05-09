/**
 * Configuración persistente del backpressure adaptativo (pixelStride).
 *
 * Permite al usuario desactivarlo o ajustar umbrales por dispositivo desde la
 * UI de Ajustes. Se guarda en localStorage para sobrevivir entre sesiones.
 *
 * Filosofía: el default replica el comportamiento histórico del procesador
 * (low<20 / high>=25 / sustain 3s / maxStride 4). Cualquier cambio del
 * usuario es opt-in y no afecta la frecuencia temporal de muestreo.
 */

export interface BackpressureConfig {
  /** Si false, el procesador queda fijado a `forceStride` (o 3 si no está). */
  enabled: boolean;
  /** fps por debajo del cual se cuenta tiempo en "low" antes de subir stride. */
  lowFpsThreshold: number;
  /** fps a partir del cual se cuenta tiempo en "high" para volver a stride bajo. */
  highFpsThreshold: number;
  /** Tiempo sostenido (ms) en zona low/high antes de cambiar stride. */
  sustainMs: number;
  /** Stride máximo permitido cuando hay backpressure (>=3). */
  maxStride: number;
  /** Stride forzado (si se define, ignora la lógica adaptativa). */
  forceStride?: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  enabled: true,
  lowFpsThreshold: 20,
  highFpsThreshold: 25,
  sustainMs: 3000,
  maxStride: 4,
};

const KEY = 'ppg_backpressure_config_v1';

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Sanea cualquier objeto parcial y lo devuelve completo y consistente. */
export function sanitizeBackpressureConfig(input: Partial<BackpressureConfig> | undefined | null): BackpressureConfig {
  const d = DEFAULT_BACKPRESSURE_CONFIG;
  const cfg: BackpressureConfig = {
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : d.enabled,
    lowFpsThreshold: clampNum(input?.lowFpsThreshold, 5, 60, d.lowFpsThreshold),
    highFpsThreshold: clampNum(input?.highFpsThreshold, 6, 60, d.highFpsThreshold),
    sustainMs: clampInt(input?.sustainMs, 250, 30000, d.sustainMs),
    maxStride: clampInt(input?.maxStride, 3, 8, d.maxStride),
  };
  if (cfg.highFpsThreshold <= cfg.lowFpsThreshold) {
    cfg.highFpsThreshold = cfg.lowFpsThreshold + 1;
  }
  if (typeof input?.forceStride === 'number') {
    cfg.forceStride = clampInt(input.forceStride, 3, cfg.maxStride, 3);
  }
  return cfg;
}

export function loadBackpressureConfig(): BackpressureConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_BACKPRESSURE_CONFIG };
    return sanitizeBackpressureConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BACKPRESSURE_CONFIG };
  }
}

export function saveBackpressureConfig(cfg: BackpressureConfig): void {
  try { localStorage.setItem(KEY, JSON.stringify(sanitizeBackpressureConfig(cfg))); } catch {}
}

export function resetBackpressureConfig(): BackpressureConfig {
  try { localStorage.removeItem(KEY); } catch {}
  return { ...DEFAULT_BACKPRESSURE_CONFIG };
}