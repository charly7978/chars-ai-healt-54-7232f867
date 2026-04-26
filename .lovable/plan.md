
# V9 — ROI con tracker temporal, selección de máscara por SNR, alineación temporal estricta y rechazo/re-pesado por movimiento

Cierre técnico de los cuatro frentes pedidos. Cero mocks, cero random, cero clamping fisiológico de salidas. Cero-alloc en hot path. `npm run ci:guard` verde.

---

## Estado actual (verificado en código)

Ya implementado en V8 — **no se duplica**:
- `AdaptiveROIMask`: connected-components 8-conn, `textureEntropy`, `coverageContiguity`, `maskIoU` (Jaccard real), `trackerSigma` (EMA del residual del centroide), pre-pass auto-tuned, EMA del centroide ROI.
- `PPGSignalProcessor`: timing estricto con `frameTimestamp` real (descarte de duplicados `dt<5ms`, `frameJump` para `dt>80ms`), DC mediana 5 s por canal, vitality count cross-channel, bandpass dual NORMAL/RESCUE con auto-switch por streak CHROM/POS, contiguity-block, liveness adaptativo por fototipo, soft-penalty `motionScore`/`trackerSigma` sobre SQI.
- `BandpassFilter`: modos NORMAL (0.4–10 Hz) y RESCUE (0.5–8 Hz) con `setMode()` O(1) sin reset de estado.
- `SignalSourceRanker`: 8 fuentes (R/G/RG/absR/absG/diffRG/CHROM/POS), SQI por fuente con autocorr + parabólica, hysteresis 90 frames.

Lo que **falta** y este plan resuelve:
1. Tracker temporal real (Kalman 1D) en lugar de la EMA actual del centroide.
2. Máscara dinámica que **maximice SNR** vía pesos top-K por tile-PI (la propuesta V8 quedó documentada en `.lovable/plan.md` pero no se aplicó al ranker).
3. **Selección de máscara por SNR por canal y por ventana** (R/G independientes, no solo "tile-PI" agregado).
4. Módulo dedicado de **rechazo/re-pesado por movimiento** que actúa sobre la actualización del ranker y de los baselines (no solo sobre la calidad final publicada), preservando el requisito forense de no hacer hard-gate permanente.

---

## Cambios por archivo

### 1) `src/modules/signal-processing/AdaptiveROIMask.ts` — Tracker Kalman + tile-PI por canal + pesos top-K

**Reemplazar EMA del centroide por Kalman 1D** sobre `(cx, cy, sizePx)`:
- Estado `[pos, vel]` por dimensión (3 filtros independientes), `Q=0.5 px²`, `R = 4·(1 + clipHighRatio) px²`.
- Predict cada frame; rechazo de observación si `|obs − predict| > 3·sqrt(P+R)` (mantiene predict, sin contaminación por glare flicker).
- Mantener compatibilidad: `roiBox.cx/cy/sizePx` siguen siendo los outputs suavizados; `trackerSigma` ahora reporta `sqrt(P)` real del Kalman, no EMA del residual.

**Tile-PI Welford incremental por canal R y G** (ventana 60 frames):
- Por cada uno de los 81 tiles, mantener acumuladores `meanG/M2G/meanR/M2R/n` Welford → `tilePI_R = sqrt(varR)/meanR`, `tilePI_G = sqrt(varG)/meanG`.
- Buffers `Float64Array(81)` reutilizables, cero-alloc.

**Selección de máscara dinámica por SNR (núcleo del pedido)**:
- Computar score por tile = `tilePI_canal · centerBias · (mismaCC ? 1 : 0.4)` (penaliza tiles fuera de la mayor componente conexa 8-conn ya calculada).
- Reordenar tiles, elegir top-K=25.
- Producir DOS sets de pesos (uno por canal): `topKWeightsR`, `topKWeightsG` vía `softmax(score/τ)` con `τ=0.15`. La máscara efectiva por canal es distinta — esto es lo que **maximiza SNR por canal**.
- Recomputar `rawRed` como Σ(weightR · tileMeanR) y `rawGreen` como Σ(weightG · tileMeanG); `rawBlue` mantiene promedio uniforme (no se usa para PPG dominante).

**Output extendido en `ROIMaskResult`**:
```ts
topKTilePI_R: number;        // mediana del top-K por canal R
topKTilePI_G: number;        // mediana del top-K por canal G
topKWeightsR: Float64Array;  // referencia read-only al scratch interno
topKWeightsG: Float64Array;  // idem
tileMeanRArr: Float64Array;  // promedios por tile (necesarios para CHROM/POS top-K)
tileMeanGArr: Float64Array;
tileMeanBArr: Float64Array;
kalmanCovariance: number;    // P del Kalman, motion-proxy independiente
```

### 2) `src/modules/signal-processing/SignalSourceRanker.ts` — Proyecciones top-K + re-pesado por movimiento

**Firma extendida (backward compatible)**:
```ts
update(
  rawR, rawG, rawB, baseR, baseG, baseB,
  redPI, greenPI, clipHigh, motionArtifact,
  // NUEVO opcional:
  weights?: { wR: Float64Array; wG: Float64Array;
              tR: Float64Array; tG: Float64Array; tB: Float64Array } | null,
  motionWeight?: number  // 0..1, default 1; <1 reduce contribución al SQI
)
```

- Cuando `weights` está presente: CHROM y POS usan **medias ponderadas top-K** en lugar de RGB ROI uniforme. Las otras 6 fuentes mantienen RGB uniforme (correcto canal-wise).
- `motionWeight < 1`: NO bloquea actualización (forense), pero:
  - Aplica factor `motionWeight` a `bestAutoCorr` antes del scoring (latidos durante movimiento pesan menos sin descartar el frame).
  - Extiende hysteresis efectiva: `HYSTERESIS_FRAMES * (2 - motionWeight)` para evitar source-switching durante movimiento.
- **Bonus físico**: cuando `bestLag ∈ [10, 50]` Y fuente activa ∈ {CHROM, POS} → `+8` (refuerza proyecciones que cancelan glare).

### 3) `src/modules/signal-processing/MotionRejection.ts` — NUEVO módulo dedicado

Pequeño módulo (≈80 LOC) que **fusiona** todas las señales de movimiento en un único `motionWeight ∈ [0,1]` y un `rejectionState`. No reemplaza `MotionClassifier` (IMU); lo **complementa** con el motion-proxy óptico del Kalman + el `maskIoU`.

```ts
export type MotionRejectionState =
  | 'STILL'           // weight 1.0
  | 'MICRO_DRIFT'     // weight 0.8 — suaviza, no descarta
  | 'SLIDING'         // weight 0.4 — re-pesa fuerte, congela baselines
  | 'BURST_MOTION';   // weight 0.15 — solo se mantiene predict del Kalman

export interface MotionRejectionInputs {
  imuScore: number;        // motionScore EWMA del PPGSignalProcessor (0..3+)
  trackerSigma: number;    // sqrt(P) Kalman en px
  maskIoU: number;         // Jaccard frame-to-frame
  centroidJumpPx: number;  // |obs − predict| del Kalman este frame
}

export class MotionRejection {
  classify(in: MotionRejectionInputs): { state, weight, freezeBaselines: boolean }
}
```

**Reglas (sin clamping fisiológico, solo pesos internos)**:
- `BURST_MOTION` si `centroidJumpPx > 12` (rechazo dura) Y `imuScore > 1.6` → `weight=0.15`, `freezeBaselines=true`.
- `SLIDING` si `maskIoU < 0.55` durante observación previa O `trackerSigma > 6` → `weight=0.4`, `freezeBaselines=true`.
- `MICRO_DRIFT` si `trackerSigma ∈ [2.5, 6]` O `imuScore ∈ [0.6, 0.95]` → `weight=0.8`, no congela.
- Resto → `STILL`, `weight=1.0`.

**Hysteresis**: una vez en SLIDING/BURST, exigir 6 frames consecutivos de STILL para volver, evita oscilación en el límite.

### 4) `src/modules/signal-processing/PPGSignalProcessor.ts` — Integración

- Instanciar `MotionRejection`. Cada frame:
  ```ts
  const mr = this.motionRejection.classify({
    imuScore: this.motionScore,
    trackerSigma: roi.trackerSigma,
    maskIoU: roi.maskIoU,
    centroidJumpPx: /* del último predict del Kalman */,
  });
  ```
- Si `mr.freezeBaselines === true`: NO actualizar `redDcMedianBuf/greenDcMedianBuf/blueDcMedianBuf`, NO actualizar EWMA de baselines. Esto preserva el DC de antes del deslizamiento.
- Pasar `mr.weight` como `motionWeight` al ranker.
- Pasar pesos top-K + tileMeans a `sourceRanker.update(...)`.
- SQI final: reemplazar la fórmula soft-penalty actual por `qFinal = qBase · mr.weight^0.5` (Bhattacharyya-style attenuation, más suave que el producto lineal previo y físicamente justificable como reducción de evidencia).
- Telemetría: agregar `diagnostics.motionRejectionState` y `diagnostics.motionWeight`.

### 5) `src/types/signal.d.ts` — campos opcionales

```ts
diagnostics?: {
  // ... existentes ...
  motionRejectionState?: 'STILL' | 'MICRO_DRIFT' | 'SLIDING' | 'BURST_MOTION';
  motionWeight?: number;
  topKTilePI_R?: number;
  topKTilePI_G?: number;
  kalmanCovariance?: number;
}
```

### 6) `src/hooks/useSignalProcessor.ts` — surface

Exponer `getMotionRejection()` (mismo patrón que `getMotionInfo()`).

### 7) `src/components/ForensicGateOverlay.tsx` — chips nuevos

Segunda fila, tabular-nums, mismo estilo:
- `MR` (motionRejectionState, con color: STILL=verde, MICRO=ámbar, SLIDING=naranja, BURST=rojo).
- `MW` (motionWeight 0–1).
- `K-σ` (sqrt(P) del Kalman en px).
- `PI-R/G top-K` (tilePI top-K mediana por canal — visualiza la calidad de la máscara dinámica seleccionada).

### 8) Tests Vitest

Nuevos archivos:
- `src/modules/signal-processing/__tests__/AdaptiveROIMask.kalman.test.ts`:
  - Secuencia de 100 boxes con jitter gaussiano σ=2 px → `kalmanCovariance` converge a < 4 px².
  - Outlier de +20 px en frame 50 → rechazado (predict mantenido, error de output < 3 px).
  - Cambio sostenido de centroide (rampa) → tracker se adapta en ≤ 15 frames.
- `src/modules/signal-processing/__tests__/MotionRejection.test.ts`:
  - Inputs STILL → weight 1.0.
  - centroidJumpPx=15, imuScore=2.0 → BURST, freeze=true.
  - maskIoU=0.4 sostenido 10 frames → SLIDING.
  - Hysteresis: tras BURST, no vuelve a STILL hasta 6 frames quietos.
- `src/modules/signal-processing/__tests__/SignalSourceRanker.weights.test.ts`:
  - Mismo input RGB con pesos uniformes vs top-K skewed → CHROM/POS difieren, R/G/RG idénticas.
  - `motionWeight=0.3` reduce SQI de la fuente activa ≥ 30% sin causar source-switch dentro de hysteresis.

Extender:
- `PPGSignalProcessor.gates.test.ts`: caso movimiento brusco → `quality` baja, pero `forensicGate` no se cierra por motion (preserva carácter forense).

### 9) `scripts/audit-forensic.mjs` — sin cambios

Los nuevos campos (`motionWeight`, `topKWeights`) son determinísticos, sin `Math.random` ni clamping fisiológico de salidas. Allowlist intacta.

---

## Garantías

- **Cero `Math.random`, cero mocks, cero clamping fisiológico** en BPM/SpO₂/PA. Solo pesos internos (Kalman, softmax, motion attenuation).
- **Cero-alloc en hot path**: Kalman = 9 floats; tile-PI Welford reutiliza Float64Array(81) ya existentes; `MotionRejection` mantiene 6 ints de estado; `topKWeightsR/G` son scratch del ROI mask.
- **Backward compatible**: `ROIMaskResult` solo añade campos; `SignalSourceRanker.update()` añade args opcionales (call-sites previos siguen compilando); `ProcessedSignal.diagnostics` solo opcionales.
- **Forense preservado**: `MotionRejection` re-pesa pero NO bloquea publicación. El operador siempre ve la traza viva, con calidad honesta.

## Orden de aplicación

1. `AdaptiveROIMask`: Kalman 1D + tile-PI Welford por canal R/G + selección top-K por canal + nuevos campos en `ROIMaskResult`.
2. `MotionRejection.ts` nuevo + sus tests unitarios.
3. `SignalSourceRanker.update(...)` acepta `weights` y `motionWeight`; CHROM/POS usan proyección top-K cuando hay pesos.
4. `PPGSignalProcessor` cablea Kalman → MotionRejection → ranker → baselines (freeze condicional) → SQI atenuado.
5. `signal.d.ts` + `useSignalProcessor` + `ForensicGateOverlay` (chips MR/MW/K-σ/PI-RG topK).
6. Tests + `npm run ci:guard` verde.
