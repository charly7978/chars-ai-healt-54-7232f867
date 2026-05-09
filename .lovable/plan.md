## Objetivo

Construir desde cero un núcleo PPG profesional en `src/lib/ppg/` siguiendo la secuencia de 3 prompts (hardware → captura/ROI → DSP/Worker/Hook), con tipado estricto, degradación elegante en iOS Safari, zero-copy entre hilos y cero `any`/`Math.random`/sintéticos.

## Alcance (solo lo pedido)

Crear módulos nuevos y aislados bajo `src/lib/ppg/`. **No** se modifica el pipeline existente (`useSignalProcessor`, `HeartBeatProcessor`, `PPGSignalProcessor`, `BandpassFilter`, `Index.tsx`, etc.) — coexiste como un núcleo paralelo listo para futura integración. No se toca UI (monitor, displays, grilla) ni `CameraView.tsx`.

## Estructura final

```text
src/lib/ppg/
├── types.ts
├── camera/
│   ├── cameraCapabilities.ts
│   └── cameraController.ts
├── capture/
│   ├── frameLoop.ts
│   └── downsample.ts
├── detection/
│   └── fingerDetector.ts
├── roi/
│   └── adaptiveRoi.ts
├── signal/
│   ├── ringBuffer.ts
│   ├── filters.ts
│   ├── signalFusion.ts
│   └── sqi.ts
├── worker/
│   └── ppgWorker.ts
└── hooks/
    └── usePpgCapture.ts
```

## Fase 1 — Hardware y contratos (Prompt 1)

- **`types.ts`**
  - `PPG_CONFIG` (`as const`): `FPS_TARGET=30`, `DOWNSAMPLE={w:160,h:120}`, `ROI_GRID={cols:10,rows:8}`, `BANDPASS={lowHz:0.5,highHz:4.0}`, `RING_SECONDS=12`.
  - Tipos: `PpgCaptureState` (`'idle'|'starting'|'running'|'degraded'|'error'`), `FrameSample` (timestamp, mediaTime, presentedFrames, droppedFrames, fpsInstant, r/g/b medios del ROI, perfusión, fingerDetected, roiWeights `Float32Array`), `PpgSignalSnapshot` (filtered `Float32Array`, sqi, perfusionIndex, skewness, kurtosis, fpsActual).
  - Sin `any`. Sin clases.
- **`camera/cameraCapabilities.ts`**
  - `extractCapabilities(track: MediaStreamTrack): SafeCapabilities` y `extractSettings(...)` con narrowing seguro (`unknown` + type guards), nunca `any`.
- **`camera/cameraController.ts`**
  - Clase `CameraController` con array de fallbacks (`[1280x720@60, 1280x720@30, 640x480@30, facingMode:'environment']`) probados en cascada.
  - `applyTorch()` y `applyFocusManual()` cada uno en su propio `try/catch` aislado; un fallo NO aborta `start()`. Reporta `degraded=true` en el estado.
  - Devuelve `{ stream, track, state, capabilities }` listo para inyectar en `<video>`.

## Fase 2 — Bucle, downsample y ROI adaptativa (Prompt 2)

- **`capture/frameLoop.ts`**
  - Usa `video.requestVideoFrameCallback` si existe; fallback a `requestAnimationFrame` solo si no.
  - Calcula jitter real desde `metadata.mediaTime` y `presentedFrames`/`processingDuration`; expone `fpsInstant` y `droppedFrames`.
- **`capture/downsample.ts`**
  - `OffscreenCanvas` cuando esté disponible, si no `HTMLCanvasElement` oculto, ambos creados con `getContext('2d', { willReadFrequently: true })`.
  - Reutiliza el mismo `ImageData` / buffer entre frames (sin re-alloc).
- **`detection/fingerDetector.ts`**
  - Itera `Uint8ClampedArray` con índices planos (`i+=4`) y variables primitivas (`r`,`g`,`b`,`luma`); cero objetos en el loop.
  - Heurística: `r` dominante, ratios `r/g` y `r/b`, penaliza saturación (`r>252`) y oscuridad (`luma<20`); devuelve `fingerDetected:boolean` + score.
- **`roi/adaptiveRoi.ts`**
  - Particiona en `10x8` tiles; por tile calcula score = asimetría cromática − penalización clipping − penalización oscuridad.
  - **EMA** sobre los pesos por tile (`alpha≈0.2`) para evitar saltos. Devuelve `Float32Array` de pesos normalizados que ponderan el promedio RGB.

## Fase 3 — DSP, Worker y Hook React (Prompt 3)

- **`signal/ringBuffer.ts`**
  - Clase genérica sobre `Float32Array` preasignado: `push(v)`, `last(n)`, `snapshot(out)`, `length`. Nunca `push/shift` de Array.
- **`signal/filters.ts`**
  - Biquad bandpass (Direct Form I o TDF II) con coeficientes recomputables vía `setSampleRate(fs)` usando los **FPS reales** del `frameLoop`.
- **`signal/signalFusion.ts`**
  - PCA cerrado sobre matriz de covarianza 3×3 (R,G,B): media incremental, covarianza, eigenvalues por **Cardano** (cúbica deprimida), eigenvectores por eliminación; proyecta sobre el componente principal con signo alineado al canal verde. Sin librerías matemáticas externas.
- **`signal/sqi.ts`**
  - Calcula sobre la ventana filtrada: AC/DC (perfusión), **skewness**, **kurtosis**, SNR en banda 0.7–4 Hz vs fuera de banda; combina en `sqi ∈ [0,1]`.
- **`worker/ppgWorker.ts`**
  - Worker dedicado (Vite `?worker`). Recibe muestras vía `postMessage(buffer, [buffer])` (Transferable, zero-copy). Mantiene ring buffers, filtro, PCA, SQI. Emite `PpgSignalSnapshot` también con Transferables.
- **`hooks/usePpgCapture.ts`**
  - Orquesta `CameraController` → `frameLoop` → `downsample` → `adaptiveRoi`/`fingerDetector` (main thread, barato) → envía RGB ponderado al worker.
  - Estado React **throttled** a 5–10 Hz vía `requestAnimationFrame` + timestamp gate; el worker puede correr a 30/60 Hz internamente.
  - Cleanup completo en `useEffect` (stop track, cancel rVFC, terminate worker).

## Restricciones transversales (cumplidas en todo el plan)

- Tipado estricto: cero `any`, cero `// @ts-ignore`. Todos los DOM optionals vía type guards.
- Cero `Math.random`, cero `mock/fake/synthetic/simulate` → pasa el guardrail anti-simulación existente (`scripts/check-no-simulation.mjs`).
- Cero alocaciones en hot loops (píxeles, DSP). Buffers preasignados.
- `applyConstraints` siempre aislado; degradación a luz ambiental sin abortar.
- Zero-copy main↔worker con Transferables.
- Coeficientes de filtro recomputados con FPS real, nunca asumiendo 30.

## Fuera de alcance

- Integración con la UI actual (monitor, VitalSign, sanity log).
- Estimadores de SpO₂/PA/HRV (vendrán en fases posteriores).
- Tests unitarios (se pueden añadir si se solicita).

## Entregable

11 archivos nuevos bajo `src/lib/ppg/`, sin tocar nada existente, compilando con el `tsconfig` actual y pasando los scripts de CI anti-simulación.
