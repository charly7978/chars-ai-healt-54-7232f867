# Pipeline Optimizations — Closing notes

Estado al cerrar la fase de optimización pedida sobre la telemetría ya habilitada.

## ✅ Implementado en esta fase (cuidadoso, contenido)

### 1. Backpressure adaptativo (pixel stride)
- Archivo: `src/modules/signal-processing/PPGSignalProcessor.ts`
- Se introduce `pixelStride` (3 → 4) que controla el muestreo espacial dentro
  del ROI. **No** altera la frecuencia temporal (cada frame se procesa igual),
  sólo reduce el coste del bucle de píxeles cuando el dispositivo no llega a
  20 fps sostenidos durante > 3s. Cuando el fps se recupera (≥ 25 fps por
  > 3s) vuelve a stride 3.
- El estado se expone vía `getBackpressureState()` y se incluye en cada
  snapshot de `usePerfTelemetry` bajo `pipeline.backpressure`. Eso permite
  medir en producción cuántos dispositivos entran en backpressure y cuánto
  tiempo permanecen.

### 2. Reducción de asignaciones en hot path
- Se reemplaza `Array.from({...}, () => ({...}))` por frame por un buffer de
  tiles reutilizable (`tileBuffer`). Evita ~25 objetos/frame de basura GC.
- `tileConfidence` ya era array fijo. Resto del hot path ya estaba acotado.

## ⏸ Diferido conscientemente (no rompemos lo que funciona)

### OffscreenCanvas + Web Worker para extracción ROI
**Por qué no lo hacemos ahora:**
1. Implica volver el contrato de `processFrame` asíncrono y atravesar postMessage
   con `ImageData` (o transferir `OffscreenCanvas`), lo que cambia la
   arquitectura de captura en `Index.tsx` y de procesamiento en
   `PPGSignalProcessor`.
2. El backpressure adaptativo ya cubre el escenario de "dispositivo lento" sin
   cambiar la arquitectura. La telemetría dirá si esto es suficiente.
3. iOS Safari tiene historial irregular con `OffscreenCanvas` y
   `requestVideoFrameCallback` desde Worker; un fallback robusto requiere
   verificación caso por caso.
4. La medición clínica de 60s tiene precedencia sobre la microoptimización.

**Cuándo activar:** si la telemetría muestra `fps < 22` con `pixelStride === 4`
en una fracción significativa (>15%) de sesiones, recién ahí justifica el
trabajo y el riesgo. Hoy no hay datos que lo demuestren.

### Ring buffers Float32Array para `redBuffer` / `filteredBuffer` / etc.
**Por qué no lo hacemos ahora:**
1. Múltiples consumidores hacen `slice(-N)` y operaciones de orden sobre estos
   buffers. Migrar a un ring de typed array obliga a reescribir cada
   `slice/sort/reduce` con una vista lógica desordenada.
2. El coste real del `push/shift` con N=300 elementos es marginal frente al
   bucle de píxeles (que sí optimizamos arriba).
3. Riesgo alto / beneficio bajo para cerrar antes de tener métricas.

**Cuándo activar:** si la telemetría muestra que las etapas `derivatives` o
`sqi` superan p95 > 5ms de forma consistente, refactorizamos esos buffers en
una segunda iteración aislada con sus propios tests.

## Verificación

- Sin cambios de tipo en la API pública del procesador.
- Sin nuevos warnings TS.
- `getBackpressureState()` agregado de forma aditiva, defensivo si el processor
  aún no se inicializó.
- El bucle de captura en `Index.tsx` no cambia.
