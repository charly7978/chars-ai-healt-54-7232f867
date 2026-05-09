
# Plan: Telemetría de rendimiento + cierre de optimizaciones del pipeline

## Objetivo
1. Persistir y enviar (con consentimiento) snapshots de `PerfTracker` para depurar en campo.
2. Cerrar las optimizaciones reales pendientes que hoy impiden que la app use el 100% del hardware/software.

Sin promesas vacías: solo lo que realmente mejora medición y rendimiento. No se altera la estética.

---

## Parte 1 — Telemetría de rendimiento (PerfTracker → Cloud)

### 1.1 Tabla `perf_snapshots` en Lovable Cloud
Migración con RLS (`auth.uid() = user_id`):
- `id uuid PK`, `user_id uuid`, `session_id text`, `created_at timestamptz`
- `fps numeric`, `jitter_ms numeric`, `dropped_estimate int`, `frames int`
- `stages jsonb` (mean/p50/p95/max/n por etapa)
- `device jsonb` (userAgent, hardwareConcurrency, deviceMemory, screen, dpr)
- `camera jsonb` (resolución real, frameRate, torch, exposureMode, settings reales)
- `pipeline jsonb` (sqi promedio, contactState ratios, activeSource, pressureState)
- `app_version text`, `consent_given bool`

### 1.2 Hook `usePerfTelemetry`
- Lee toggle de consentimiento de `localStorage` (`perf_telemetry_consent`).
- Cada 15 s (configurable) toma `ppgPerf.snapshot()` + métricas del pipeline.
- Buffer en `IndexedDB` cuando offline; flush al recuperar conexión.
- Envío vía `supabase.from('perf_snapshots').insert()` (RLS exige user logged-in; si no hay user → solo persiste local).
- Reset del tracker tras flush exitoso.

### 1.3 UI mínima de consentimiento
- Switch dentro de un panel de ajustes ya existente (sin cambiar la estética del monitor).
- Texto claro: "Enviar métricas anónimas de rendimiento para mejorar la app".
- Default: **off**.

### 1.4 Página/edge function opcional de inspección
- Edge function `perf-summary` (con verify_jwt) que devuelve agregados por device/sesión para debugging.

---

## Parte 2 — Cierre de optimizaciones reales del pipeline

Solo cosas que mueven la aguja. Nada cosmético.

### 2.1 Frame timing real con `VideoFrameCallbackMetadata`
- Verificar que `PPGSignalProcessor` reciba `mediaTime` del frame y lo use como `timestamp` (no `performance.now()` interno).
- Estimar `fs` real vía EWMA de `Δmediatime` y propagarlo a `BandpassFilter` (recoef cuando cambie >5%).

### 2.2 OffscreenCanvas + Web Worker para extracción ROI
- Mover el loop de píxeles (extracción RGB por tile + clipping ratio) a un Worker con `OffscreenCanvas` cuando el navegador lo soporte.
- Fallback: main thread como hoy.
- Beneficio: libera el hilo principal en móviles, reduce jitter.

### 2.3 Camera lock en fases con verificación real
- Tras `applyConstraints`, leer `track.getSettings()` y registrar qué quedó activo (exposureMode, focusMode, whiteBalanceMode, frameRate, iso si aplica).
- Si una fase falla, degradación silenciosa + log a telemetría.
- Exponer `cameraDiagnostics` al snapshot de telemetría.

### 2.4 Ring buffers Float32Array donde aún haya `push/shift`
- Auditar `PPGSignalProcessor` y `HeartBeatProcessor` para reemplazar arrays mutables en hot path.

### 2.5 Métricas instrumentadas (spans) ya en su sitio
- Confirmar `ppgPerf.start('roi')`, `'filter'`, `'sqi'`, `'peak'` envuelven cada etapa.
- Añadir span `'capture'` en `requestVideoFrameCallback` para medir copy de píxeles.

### 2.6 Backpressure
- Si `ppgPerf.snapshot().fps < 20` durante >3s, reducir tamaño de ROI fina (downscale 0.75) automáticamente; restaurar cuando vuelva a >25fps.
- Registrar evento en telemetría.

---

## Parte 3 — Verificación

- Tests unitarios nuevos:
  - `usePerfTelemetry`: flush, retry, respeto del toggle.
  - Backpressure: simulación de fps bajo activa downscale.
- Script `check:orphans` y CI ya existentes corren igual.
- QA manual: medición de 60s con consentimiento on → fila en `perf_snapshots`; con consentimiento off → 0 filas.

---

## Detalles técnicos

**Archivos a crear:**
- `supabase/migrations/<ts>_perf_snapshots.sql`
- `src/hooks/usePerfTelemetry.ts`
- `src/lib/perf/indexedDbBuffer.ts`
- `src/workers/roi.worker.ts` (si OffscreenCanvas disponible)
- `supabase/functions/perf-summary/index.ts` (opcional)

**Archivos a editar:**
- `src/utils/logger.ts` — método `drainSnapshot()` que devuelve y resetea atómicamente.
- `src/modules/signal-processing/PPGSignalProcessor.ts` — spans, fs real, hook al worker.
- `src/components/CameraView.tsx` — diagnostics y lock por fases.
- `src/pages/Index.tsx` — montar `usePerfTelemetry`, span `'capture'`, toggle.

**Sin tocar estética**: el toggle va en un panel de ajustes plegable existente; el monitor cardiaco no cambia.

**Privacidad**: nada de PII. user_id solo si está logueado; sin él, datos quedan en IndexedDB local.

---

## Lo que NO hago (para no inflar el plan)
- No prometo precisión clínica de SpO2/BP — eso no se arregla con telemetría.
- No agrego servicios externos (PostHog/Sentry) salvo que lo pidas explícitamente.
- No reescribo el HeartBeatProcessor — solo audito ring buffers en hot path.

¿Apruebo y arranco?
