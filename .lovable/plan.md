
# ROI adaptativa con seguimiento temporal + extracción PPG alineada por timestamps con rechazo de movimiento

## Objetivo
Cerrar dos frentes simultáneos sobre el pipeline ya parcialmente refactorizado:

1. **Máscara ROI dinámica con seguimiento temporal** que maximice SNR sobre piel real (no fondo, glare ni reflejos), usando los nuevos campos `textureEntropy` y `coverageContiguity` ya emitidos por `AdaptiveROIMask`, sumando un **tracker Kalman 1D** del centroide y un **mask-IoU temporal** (Jaccard) que penalice deformaciones bruscas.
2. **Pipeline de extracción re-alineado por `frameTimestamp` real** (de `requestVideoFrameCallback.metadata.mediaTime`), con **rechazo de artefactos por movimiento** integrado al SQI multi-fuente como soft-penalty (no hard-gate, requisito forense), detección de frames duplicados/saltados, y **dual bandpass** conmutado por estabilidad de fuente activa.

Sin mocks, sin random, sin clamping fisiológico de salidas. Cero-alloc en hot path. Todo passes `npm run ci:guard`.

---

## Cambios por archivo

### 1) `src/modules/signal-processing/AdaptiveROIMask.ts` — Tracker temporal + máscara dinámica SNR
- **Tracker Kalman 1D** sobre `(cx, cy, sizePx)` del bounding box: estado `[pos, vel]`, observación = box CC del frame, ruido proceso `Q=0.5 px²`, ruido observación `R = 4 px² · (1 + clipHighRatio)`. Provee `roiBox.cx/cy/sizePx` suavizado; cuando la observación queda fuera de `±3σ` del predict, se rechaza ese frame y se mantiene el predict (handles glare flicker y micro-temblor).
- **Mask-IoU temporal**: hoy `maskStability` mide Hamming. Re-definir `maskStability = |M_t ∩ M_{t-1}| / |M_t ∪ M_{t-1}|` (Jaccard real) y exportar `maskIoU` separado para que SQI lo consuma directo.
- **Tile-level SNR weighting** (núcleo de "máscara que maximiza SNR"): por cada finger-tile, mantener `tileGreenAC` y `tileGreenDC` con varianza Welford incremental (window 60 frames). Calcular `tilePI = √var(G)/mean(G)`, reordenar tiles por `tilePI · centerBias · contiguityFlag`, y reemplazar el promedio uniforme por **promedio ponderado top-K=25 tiles** con pesos `softmax(tilePI/τ)`. Exportar pesos como `Float64Array` para que SignalSourceRanker los use.
- **Output extendido en `ROIMaskResult`**: añadir `maskIoU`, `topKTilePI` (mediana del top-K), `trackerSigma` (σ del Kalman como motion-proxy óptico independiente del IMU), `topKWeights: Float64Array` (referencia al scratch interno, read-only por contrato).

### 2) `src/modules/signal-processing/SignalSourceRanker.ts` — Block-wise CHROM/POS top-K (Commit 5)
- Añadir argumento opcional `topKWeights: Float64Array | null` a `update(...)`. Si presente, proyectar **CHROM/POS sobre la media ponderada de los top-25 tiles** (necesita además los promedios RGB por tile — extender la firma para recibir `tileR/G/B: Float64Array | null` o mantener compatibilidad limitándolo a un escalar de "boost factor" si pasar tiles enteros implica rework grande; decidir en implementación por menor invasividad).
- Mantener fórmulas R/G/RG/absR/absG/diffRG sin tocar (canal-wise promedio ROI ya es correcto).
- Bonus de SNR cuando `bestLag` cae en banda 0.7–3.5 Hz Y la fuente activa es CHROM/POS (refuerza estabilidad de proyecciones que cancelan glare).

### 3) `src/modules/signal-processing/PPGSignalProcessor.ts` — Liveness adaptativo + timing real + motion-aware
- **Reemplazar `textureProxy = 1 - spatialUniformity`** por uso directo de `roi.textureEntropy` con banda piel real `[1.6, 3.9]` bits. Legacy queda de fallback solo cuando `textureEntropy === 0`.
- **Bloqueo por contigüidad**: si `roi.coverageContiguity < 0.55` durante ≥6 frames consecutivos, degradar `exportedContactState` a `UNSTABLE_CONTACT` aunque el resto de gates pasen. Evita publicar señal de parches dispersos.
- **Liveness adaptativo por fototipo (Commit 4)**: cuando `textureEntropy ∈ [2.0, 3.5]` Y `coverageContiguity ≥ 0.75` Y `maskIoU ≥ 0.85` (tres gates ortogonales fuertes), permitir bajar `RED_OVER_GB_MIN` de 16 → 10 y `ABSORPTION_MIN` de 1.30 → 1.18. Rescata Fitzpatrick V-VI sin abrir la puerta a pared/fondo (que fallan entropy o contiguity).
- **Perfusion Index por canal (Commit 3)**: ventana de 3 s sobre `redBuf`/`greenBuf`/`blueBuf` (longitud = `3 · estimatedSampleRate`). Calcular `piR = (p95-p5)/median`, idem `piG`, `piB`. `vitalityCount = (piR > 0.0015) + (piG > 0.0010) + (piB > 0.0006)`. Bloquear publicación numérica cuando `vitalityCount < 2`.
- **Timing real estricto**: confirmar que `processFrame(imageData, frameTimestamp)` ya recibe `mediaTime` desde `Index.tsx` (auditar). `dtMs = timestamp - lastFrameTime`. Frames duplicados (`dtMs < 5 ms`) → descartar early-return. Saltos (`dtMs > 80 ms`) → marcar `frameJump=true`, **no** llamar `bandpassFilter.applyBandpass` (preserva estado), publicar `quality *= 0.5` y `diagnostics.frameJump=true`.
- **Motion-aware SQI soft-penalty**: pasar `motionScore` y `trackerSigma` a `computeGlobalSQI()` (o aplicar fuera): `qFinal = qBase · (1 - 0.6·min(1, motionScore)) · (1 - 0.4·min(1, trackerSigma/8))`. Mantener `motionGated = false` (requisito forense). Publicar señal aún con movimiento, pero con calidad realmente baja.
- **Bandpass dual auto-switch (Commit 6.b)**: contador `chromPosStreak`. Cuando `sourceRanker.getActiveSource() ∈ {CHROM, POS}` por ≥150 frames (~5 s @30fps), `bandpassFilter.setMode('RESCUE')`. Cuando vuelve a otras fuentes por ≥90 frames (~3 s), `'NORMAL'`. Sin reset de estado.
- **DC mediana 5 s (Commit 6.c)**: añadir `redDcMedianBuf = new RingBuffer(150)` (idem G, B), push de `roi.rawRed` cada frame válido. Cuando `length ≥ 90`, reemplazar `this.redBaseline` por `redDcMedianBuf.percentile(0.5, length)`. Robusto a clip-high transitorios (glare) que hoy contaminan EWMA y arrastran absR/absG durante segundos.

### 4) `src/modules/signal-processing/BandpassFilter.ts` — sin cambios (ya tiene `setMode` del turno previo)

### 5) `src/components/ForensicGateOverlay.tsx` — Telemetría extendida (Commit 8)
- Añadir 6 chips: `ENT` (textureEntropy: rojo <1.6, verde 1.6–3.9, ámbar >3.9), `CTG` (contiguity: rojo <0.55, ámbar 0.55–0.75, verde ≥0.75), `IoU` (maskIoU), `PI-R/G/B` (perfusion index por canal), `BP` (NORMAL/RESCUE), `TRK σ` (trackerSigma).
- Layout: segunda fila de chips compacta debajo de la actual; mismo estilo `tabular-nums`, sin tocar tipografía/colores existentes.

### 6) `src/types/signal.d.ts` — Extender `ProcessedSignal.diagnostics`
- Campos opcionales: `textureEntropy?`, `coverageContiguity?`, `maskIoU?`, `piR?`, `piG?`, `piB?`, `vitalityCount?`, `bandpassMode?`, `trackerSigma?`, `frameJump?`. Solo opcionales → no rompe consumidores existentes.

### 7) `src/hooks/useSignalProcessor.ts` — Surface mínimo
- Exponer `getBandpassMode()` y `getTrackerSigma()`, equivalentes al patrón ya existente con `getMotionInfo`/`getPositionQuality`. Usados por overlay.

### 8) Tests Vitest
- `__tests__/AdaptiveROIMask.tracker.test.ts`: secuencia de boxes con jitter ±2 px → Kalman suaviza σ<1 px; outlier ±15 px → rechazo (mantiene predict).
- `__tests__/PPGSignalProcessor.timing.test.ts`: `dt=33.3 ms` → `estimatedSampleRate ≈ 30`; duplicado `dt=2 ms` → frame descartado; salto `dt=120 ms` → `frameJump=true` + quality halved.
- `__tests__/SignalSourceRanker.topK.test.ts`: `topKWeights` no nulo → CHROM/POS reflejan proyección ponderada.
- Extender `PPGSignalProcessor.gates.test.ts`: fototipo alto (`redDom=12, absorption=1.20, entropy=2.8, contiguity=0.80, IoU=0.90`) → Liveness PASS modo rescue; pared roja (`redDom=20, absorption=1.5, entropy=0.8, contiguity=0.30`) → Liveness FAIL.

### 9) `scripts/audit-forensic.mjs` — sin cambios (los nuevos campos no introducen patrones prohibidos)

---

## Garantías
- **Cero `Math.random`, cero mocks, cero clamping fisiológico** en valores de salida (sólo en pesos internos del Kalman/softmax — nunca en BPM/SpO₂/PA).
- **Cero-alloc en hot path**: Kalman = 6 floats; tile-PI usa Float64Array existente; ring buffers reutilizados.
- **Backward compatible**: `ROIMaskResult` sólo añade campos; `SignalSourceRanker.update()` añade arg opcional; `ProcessedSignal.diagnostics` añade opcionales.
- **Verificación final**: `npm run ci:guard` (audit-forensic + vitest + lint + build) verde antes de cerrar.

## Orden de aplicación
1. Tracker Kalman + maskIoU + tile-PI + topK weights en `AdaptiveROIMask.ts`.
2. SignalSourceRanker acepta topK weights (CHROM/POS).
3. PPGSignalProcessor: integra entropy/contiguity/IoU/PI, liveness adaptativo, timing real estricto, motion-aware SQI, bandpass auto-switch, mediana DC.
4. Types + hook surface.
5. Overlay extendido.
6. Tests + ci:guard verde.
