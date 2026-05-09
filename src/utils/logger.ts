/**
 * Logger con niveles + métricas de rendimiento.
 * - Niveles configurables vía VITE_LOG_LEVEL ('debug' | 'info' | 'warn' | 'error' | 'silent').
 * - PerfTracker mide latencia por etapa, fps efectivo y jitter de
 *   requestVideoFrameCallback usando metadata.mediaTime cuando está disponible.
 * - No introduce overhead notable: contadores y buffers ring de tamaño fijo.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

function resolveLevel(): LogLevel {
  try {
    const env = (import.meta as any)?.env?.VITE_LOG_LEVEL as LogLevel | undefined;
    if (env && env in ORDER) return env;
  } catch {}
  return 'info';
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, scope: string, args: unknown[]) {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const tag = `[${level.toUpperCase()}][${scope}]`;
  const fn = level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : level === 'debug' ? console.debug
    : console.log;
  fn(tag, ...args);
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit('debug', scope, a),
    info: (...a: unknown[]) => emit('info', scope, a),
    warn: (...a: unknown[]) => emit('warn', scope, a),
    error: (...a: unknown[]) => emit('error', scope, a),
  };
}

/* ---------------- Performance metrics ---------------- */

const RING = 120;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

class Ring {
  private buf = new Float32Array(RING);
  private idx = 0;
  private filled = 0;
  push(v: number) {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % RING;
    if (this.filled < RING) this.filled++;
  }
  stats() {
    if (this.filled === 0) return { mean: 0, p50: 0, p95: 0, max: 0, n: 0 };
    const arr = Array.from(this.buf.slice(0, this.filled)).sort((a, b) => a - b);
    const sum = arr.reduce((s, v) => s + v, 0);
    return {
      mean: sum / arr.length,
      p50: arr[Math.floor(arr.length * 0.5)],
      p95: arr[Math.floor(arr.length * 0.95)],
      max: arr[arr.length - 1],
      n: arr.length,
    };
  }
  reset() { this.filled = 0; this.idx = 0; }
}

export class PerfTracker {
  private stages = new Map<string, Ring>();
  private frameDeltas = new Ring();
  private lastFrameT = 0;
  private lastMediaTime = 0;
  private droppedEstimate = 0;
  private frames = 0;

  /** Inicia un span; retorna función para cerrarlo y registrar la latencia. */
  start(stage: string): () => number {
    const t0 = now();
    return () => {
      const dt = now() - t0;
      let r = this.stages.get(stage);
      if (!r) { r = new Ring(); this.stages.set(stage, r); }
      r.push(dt);
      return dt;
    };
  }

  /** Registra un frame de cámara. metadata es el VideoFrameCallbackMetadata si existe. */
  markFrame(metadata?: { mediaTime?: number; presentationTime?: number }) {
    this.frames++;
    const t = now();
    if (this.lastFrameT > 0) {
      this.frameDeltas.push(t - this.lastFrameT);
    }
    this.lastFrameT = t;

    // Estimación de frames perdidos vía mediaTime (segundos del media stream).
    const mt = metadata?.mediaTime;
    if (typeof mt === 'number' && this.lastMediaTime > 0) {
      const expectedDelta = 1 / 30; // baseline; estimador conservador
      const realDelta = mt - this.lastMediaTime;
      if (realDelta > expectedDelta * 1.8) {
        this.droppedEstimate += Math.round(realDelta / expectedDelta) - 1;
      }
    }
    if (typeof mt === 'number') this.lastMediaTime = mt;
  }

  snapshot() {
    const fd = this.frameDeltas.stats();
    const fps = fd.mean > 0 ? 1000 / fd.mean : 0;
    const jitter = fd.p95 - fd.p50;
    const stages: Record<string, ReturnType<Ring['stats']>> = {};
    this.stages.forEach((r, k) => { stages[k] = r.stats(); });
    return {
      frames: this.frames,
      fps,
      frameDeltaMs: fd,
      jitterMs: jitter,
      droppedEstimate: this.droppedEstimate,
      stages,
    };
  }

  reset() {
    this.stages.clear();
    this.frameDeltas.reset();
    this.lastFrameT = 0;
    this.lastMediaTime = 0;
    this.droppedEstimate = 0;
    this.frames = 0;
  }

  /** Devuelve un snapshot y resetea atómicamente. Útil para flush periódico. */
  drainSnapshot() {
    const s = this.snapshot();
    this.reset();
    return s;
  }
}

/** Singleton compartido para el pipeline PPG. */
export const ppgPerf = new PerfTracker();