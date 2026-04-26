# PLAN — FASE 1: Detección de dedo + Extracción PPG al máximo

## Lo que ya tiene el repo (no reinventar)

- **`CameraView.tsx`**: cámara trasera con torch, ladder de resoluciones con probe FPS real, locks de exposure/WB/focus/ISO, watchdog FPS por `requestVideoFrameCallback`, diagnostics expuestos vía `getDiagnostics()`.
- **`PPGSignalProcessor.ts`**: sRGB→linear→OD, ventana temporal 10 s indexada por timestamp real, gates 1/2/3 (óptico / SNR cardíaco / morfología), bloque `LIVENESS` (6 condiciones), motion gating IMU, contact state machine extendida, EWMA de RGB, position lock.
- **`AdaptiveROIMask.ts`**: grilla 9×9, pre-pass 32×32 con auto-tune de umbrales, exclusión de clipping, EMA por tile, score multifactor, percentiles por frame, ROI re-centrada con EMA.
- **`SignalSourceRanker.ts`**: 8 fuentes (R, G, RG, absR, absG, diffRG, **CHROM**, **POS**), SQI compuesto, autocorr con interpolación parabólica, histéresis 90 frames.
- **`OpticalEvidenceGate.ts`**: gate físico configurable (clipping, exposición, R/(G+B), textura, AC/DC, perfusion drop).
- **`BandpassFilter.ts`**: HPF 0.4 Hz + LPF 10 Hz biquad, dual-EWMA detrend, notch adaptativo de aliased line frequency.
- **`Index.tsx`**: `requestVideoFrameCallback` con `frameTimestamp` real propagado al hook, `SampleRateEstimator`, motion classifier, calibración, recalibration watchdog.

> **Doctrina (no negociable)**: no hay mocks/random/simulación; "no reading > false reading"; cero-alloc en hot path; sin valores fisiológicos hardcodeados; `npm run ci:guard` debe quedar verde.

---

## PROMPT PARA CURSOR (copiar/pegar tal cual)

````
Actuá como principal engineer en smartphone contact-PPG. Vas a EVOLUCIONAR
los archivos EXISTENTES de este repo. PROHIBIDO: crear módulos paralelos,
duplicar lógica que ya vive en AdaptiveROIMask / OpticalEvidenceGate /
SignalSourceRanker / PPGSignalProcessor / BandpassFilter / CameraView,
Math.random, mocks, simulaciones, fake data, valores fisiológicos
hardcodeados, defaults clínicos. PROHIBIDO romper la API pública del hook
useSignalProcessor consumida por Index.tsx. `npm run ci:guard` debe quedar
verde tras CADA commit.

ALCANCE FASE 1 (NADA MÁS):
   1. detección de dedo / contact state
   2. extracción robusta de señal PPG cruda y filtrada
   3. SQI y telemetría asociada
   4. performance del hot path

NO TOCAR: HeartBeatProcessor, VitalSignsProcessor, BP/SpO2/Glucose/Lipids,
edge functions, UI principal salvo el debug overlay ya existente
(ForensicGateOverlay).

──────────────────────────────────────────────────────────────────────────
COMMIT 1 — CONNECTED-COMPONENTS EN EL PRE-PASS DE ROI
Archivo: src/modules/signal-processing/AdaptiveROIMask.ts

Hoy `estimateFingerBox` usa centroide ponderado: cualquier mancha roja
fuera del dedo (tela, luz, reflejo) lo arrastra. Cambiar a:

- Sobre el grid 32×32 ya existente, construir una máscara binaria
  Uint8Array(1024) con 1 cuando el píxel cumple los criterios actuales
  (redDom ≥ prepassRedDomMin, r ≥ prepassRedMin, banda de luminancia).
- Two-pass connected-components 8-connectivity, in-place, con
  Int16Array(1024) de labels y union-find por path-compression. Sin libs.
- Elegir la componente que MAXIMIZA `area_in_central_disk × Σ redDom`,
  donde central_disk = radio = 0.45·min(W,H) en coords del grid.
- Devolver bbox + centroide PESADO de esa componente.
- Si la componente ganadora no toca el centro o aspect ratio > 2.5:
  setear `box.mass = 0` (mantiene el fallback geométrico actual).
- Mantener TODO lo demás: EMA de centroide/tamaño, autotune del prepass,
  clamps a [0.5, 0.95]·minDim. Cero-alloc: scratch arrays como campos
  privados.

Test: `src/modules/signal-processing/__tests__/AdaptiveROIMask.cc.test.ts`
con 4 ImageData sintéticos:
  (a) dedo centrado → centroide ≈ centro, mass>0
  (b) dedo + parche rojo en esquina → centroide sigue al dedo (no al parche)
  (c) sólo parche rojo en esquina → mass = 0
  (d) dos dedos parciales → gana el que tiene más area_in_central_disk

──────────────────────────────────────────────────────────────────────────
COMMIT 2 — SHANNON-ENTROPY TEXTURE EN G + COVERAGE CONTIGUITY
Archivo: src/modules/signal-processing/AdaptiveROIMask.ts
       + src/modules/signal-processing/PPGSignalProcessor.ts

(2.a) En AdaptiveROIMask devolver dos campos nuevos en `ROIMaskResult`:
  - `textureEntropy: number` (bits, 0..4): entropía de Shannon sobre
    histograma de 16 bins del canal G en píxeles válidos del fine ROI.
    Implementación: Int32Array(16) reusable, p_i = c_i/Σ, H = −Σ p log2 p.
    Saltar el cálculo si validPixels < 200 → devolver 0.
  - `coverageContiguity: number` (0..1): fracción de tiles 9×9 con
    `score ≥ fingerThreshold` que pertenecen a la mayor componente
    conexa 8-conn del coverageMap. Reutilizar el algoritmo de CC del
    commit 1 (extraerlo a helper privado `connectedComponents8(mask, w, h)`).

(2.b) En PPGSignalProcessor:
  - Reemplazar `textureProxy = 1 - spatialUniformity` por
    `textureEntropy` venido del ROI. Banda válida: `[1.6, 3.9]` bits.
  - Agregar a LIVENESS un sexto requisito implícito: `coverageContiguity ≥ 0.55`.
    Si falla, registrar `lastLivenessReason = 'COBERTURA FRAGMENTADA — REPOSICIONE EL DEDO'`.
  - Exponer `textureEntropy`, `coverageContiguity` en `diagnostics` del
    frame emitido y en `ForensicGateOverlay` (sumar dos chips).
  - Mantener LIVENESS.CONFIRM_FRAMES y RELEASE_FRAMES sin cambios.

Justificación (citar en JSDoc): Wang et al. Sensors 2020 — la entropía
espacial G discrimina piel real (crestas dactilares ⇒ 1.6–3.9 bits) de
superficies planas (<1.5) y reflejos (>3.9). Contiguity bloquea el caso
"manchas rojas dispersas" que connected-components no llega a filtrar
en el grid 9×9.

──────────────────────────────────────────────────────────────────────────
COMMIT 3 — PERFUSION INDEX POR CANAL + GATE VITAL
Archivo: src/modules/signal-processing/PPGSignalProcessor.ts

- Calcular PI por canal sobre los buffers existentes (redBuf, greenBuf,
  blueBuf) en ventana de 3 s (90 muestras a 30 fps; usar `bufferedSeconds`
  real, no nominal):
    piX = (p95(X) − p5(X)) / mean(X)
  RingBuffer ya tiene `percentile` y `mean`; cero-alloc.
- Devolver `piR`, `piG`, `piB` en `diagnostics`.
- Nuevo criterio para promover `fingerDetected = true`:
  además de los actuales, exigir
    `piR > 0.0015 && piG > 0.0010` durante ≥10 frames consecutivos.
  Mantener un contador independiente del de liveness: `vitalityCount`,
  con release de 90 frames (3 s) para no perder al dedo en una breath
  hold.
- Justificación (Allen 2007, Physiol Meas): bloquea cuerpos sin pulso
  (cadáver, prótesis, juguete) sin penalizar perfusión baja real
  (frío/shock). Threshold G < threshold R porque la pulsatilidad verde
  ronda el 60% de la roja en piel clara y ~80% en piel oscura — esto
  permite que el gate también funcione en fototipos altos.

──────────────────────────────────────────────────────────────────────────
COMMIT 4 — LIVENESS ADAPTATIVO POR FOTOTIPO / PERFUSIÓN BAJA
Archivo: src/modules/signal-processing/PPGSignalProcessor.ts

LIVENESS hoy asume torch sobre piel media. Hacerlo ADAPTATIVO:

- Detectar el régimen "stress mode" cuando, durante ≥3 s seguidos,
  `prepassSuccessRate < 0.30` Y `textureEntropy ∈ [1.6, 3.9]` Y
  `coverageContiguity ≥ 0.55` (es decir: hay UN dedo cohesionado pero
  la firma roja es débil — fototipo VI / cianosis / shock).
- En stress mode, BAJAR temporalmente:
    LIVENESS.RED_OVER_GB_MIN: 16 → 10
    LIVENESS.ABSORPTION_MIN  : 1.30 → 1.18
  Restaurar a default cuando la condición cesa por ≥3 s.
- Loguear cada transición en ROITelemetryLogger con tag
  "LIVENESS_ADAPT" (campos: from, to, reason).
- NO tocar el resto de los gates.

Justificación: Bent et al., npj Digital Medicine 2020 — sesgo demostrado
de PPG en piel oscura. La contramedida es bajar umbrales de R/(G+B)
SOLO cuando otros gates físicos confirman tejido cohesionado.

──────────────────────────────────────────────────────────────────────────
COMMIT 5 — CHROM/POS BLOQUE-WISE (top-K tiles)
Archivo: src/modules/signal-processing/SignalSourceRanker.ts
       + src/modules/signal-processing/PPGSignalProcessor.ts

- En SignalSourceRanker.update(...) aceptar un parámetro extra opcional:
    `tilesRGB?: { r: Float64Array; g: Float64Array; b: Float64Array; score: Float64Array; n: number }`
  (mantener overload antiguo: si no viene, usar el RGB medio actual).
- Cuando venga, calcular CHROM y POS por tile sobre los TOP-25 tiles
  por score (ordenar copia en sortScratch reutilizable). Promediar las 25
  proyecciones para obtener `chromVal` y `posVal`. NO tocar las otras 6
  fuentes (R, G, RG, absR, absG, diffRG).
- En PPGSignalProcessor, después de `roiMask.process`, exponer los tiles
  smR/smG/smB (ya existen como `tileMeanR/G/B`) vía un getter
  `getSmoothedTiles()` y pasarlos al ranker.
- Cero-alloc: vectores devueltos son referencias a campos privados;
  no copiar.

Justificación: McDuff et al. 2023 (skin-mask weighted CHROM) — proyectar
sobre los tiles de mayor score en lugar del promedio espacial sube ~3–6
dB de SNR bajo micro-movimiento porque elimina tiles glare/borde.

──────────────────────────────────────────────────────────────────────────
COMMIT 6 — DC TRACKING ROBUSTO (mediana 5 s) + BANDPASS DUAL
Archivo: src/modules/signal-processing/BandpassFilter.ts
       + src/modules/signal-processing/PPGSignalProcessor.ts

(6.a) BandpassFilter: añadir un MODO dual conmutable
  - Banda normal (default): HPF 0.4 Hz, LPF 10 Hz (ya implementado).
  - Banda rescate: HPF 0.5 Hz, LPF 8 Hz, recomputar coeficientes solo si
    cambia el modo. Switch O(1) entre dos juegos de B/A precomputados.
  - API pública: `setMode('NORMAL' | 'RESCUE')`. Exponer `getMode()`.

(6.b) PPGSignalProcessor: invocar `setMode('RESCUE')` cuando el
  `SignalSourceRanker.getActiveSource()` ∈ {CHROM, POS} durante ≥5 s
  (recuento por frames del ranker). Volver a NORMAL cuando vuelva a
  R/G/RG ≥ 5 s. Cero alloc.

(6.c) `odDcMovingAvg` (que hoy es media exponencial 0.02) reemplazarlo
  por una MEDIANA RODANTE de 5 s sobre OD. Implementación: ring de 150
  muestras + insertion-sort O(n) por inserción/remoción (n ≤ 150;
  ~0.1 ms/frame en mobile). Dejar el viejo como fallback los primeros 60
  frames (warm-up).

Justificación: Berkaya 2018 — la mediana es ~5× más robusta a
artefactos transitorios que la media móvil para DC tracking en PPG.
La banda dual mantiene morfología en operación normal y prioriza SNR
cuando el ranker ya delegó en proyecciones (señal ya degradada).

──────────────────────────────────────────────────────────────────────────
COMMIT 7 — AUTO-EXPOSURE FEEDBACK LOOP
Archivos: src/components/CameraView.tsx
        + src/modules/signal-processing/ExposureController.ts (nuevo)

- Crear ExposureController con API:
    constructor(track: MediaStreamTrack)
    notify(metrics: { meanR: number; clipHigh: number; meanRMin: number; meanRMax: number; tNow: number }): void
    stop(): void
- Lógica:
  * Si `clipHigh > 0.20` durante ≥1 s → bajar `exposureCompensation` un
    paso (paso = (caps.max-caps.min)/16, clamp a caps).
  * Si `meanR < 80` durante ≥1 s → subir un paso.
  * Histéresis: nunca dos cambios en menos de 800 ms.
  * Si tras 5 s `meanR ∉ [120, 220]`, intentar TOGGLE TORCH una sola
    vez por sesión (con histéresis 3 s antes de revertir).
  * PROHIBIDO tocar focus/WB (ya están locked en Phase 4 actual).
  * PROHIBIDO cambiar resolución (rompería SampleRateEstimator).
- En CameraView: instanciar tras Phase 4, exponer en diagnostics
  `exposureControllerActive: boolean`.
- En PPGSignalProcessor: pasarle al controller `meanR` del ROI y
  `clipHighRatio` cada frame vía un callback opcional ya existente
  (o `EventTarget` tipado si no hay; sin window globals).
- Loguear cada cambio en ROITelemetryLogger tag "EXPOSURE".

Justificación: Apple HIG / Google CameraX — sin este loop, en piel oscura
o flash débil el sensor sub-expone, `meanR` cae bajo 80, y todos los
gates físicos disparan falsos negativos aunque haya pulso.

──────────────────────────────────────────────────────────────────────────
COMMIT 8 — TELEMETRÍA EXTENDIDA EN OVERLAY FORENSE
Archivo: src/components/ForensicGateOverlay.tsx
       + src/types/signal.d.ts (extender ProcessedSignal.diagnostics)

Sumar al overlay (sin romper layout existente) chips:
  - textureEntropy (bits, 1 decimal)
  - coverageContiguity (%, entero)
  - piR / piG / piB (%, 2 decimales)
  - exposure step actual (entero, signo)
  - bandpass mode (NORMAL/RESCUE)
  - active source (ya existe, dejarlo)
  - prepassRedDomMin / prepassRedMin actuales (ya existen via telemetry)
Throttle con el mismo mecanismo de 150 ms ya implementado.

──────────────────────────────────────────────────────────────────────────
REQUISITOS TRANSVERSALES (no negociables)

1. Cero-alloc en hot path: nada de Map, Object.entries, .map/.filter
   dentro de processFrame o computeSQI. Reutilizar Float64Array/Int32Array.
2. Timing: usar `frameTimestamp` real ya propagado por
   `useSignalProcessor.processFrame(imageData, frameTimestamp)`. Si no
   viene, fallback a `performance.now()` (NUNCA Date.now).
3. Sample rate: respetar el `SampleRateEstimator` ya integrado en
   `Index.tsx`. Si el estimador cambia >1.2 fps, llamar a
   `bandpassFilter.setSampleRate(rate)` (ya existe). NO resetear estado.
4. Cada nuevo threshold debe ser una constante nombrada con cita de
   literatura en JSDoc (Apple Heart Study 2020, Nature Sci.Rep. 2014,
   IEEE TBME 2019/2023, de Haan TBME 2013, Wang TBME 2017, McDuff 2023,
   Bent npj Digit Med 2020, Berkaya 2018, Allen Physiol Meas 2007).
5. Cada commit con su Vitest en __tests__ hermano. `npm run ci:guard`
   verde antes de pasar al siguiente commit.
6. Actualizar memorias:
   - mem://procesamiento-senal/extraccion-senal-ppg-v2 (resumen nuevo)
   - mem://procesamiento-senal/deteccion-dedo-y-estabilidad-v2 (resumen nuevo)
   - mem://camera/configuracion-y-activacion-nativa (sumar ExposureController)
7. Actualizar `docs/medical-validation.md` sección "Finger detection &
   raw PPG extraction" con los 8 commits y su racional.

ENTREGABLES AL TERMINAR:
  (a) Diff resumido por archivo.
  (b) Salida de `npm run ci:guard`.
  (c) Lista de los 8 commits con sus tests pasando.
  (d) Antes/después en SQI medio sobre un video de prueba que dejes
      cargado en /test/fixtures (si no existe, usar la grabación
      sintética que genere el test del commit 1).
````

---

## Por qué este conjunto exacto y por qué en este orden

1. **CC primero** — sin él, el resto de mejoras siguen viendo "dedo + ruido rojo del fondo" como un único blob.
2. **Texture entropy + contiguity** — completa la triada física (firma + cohesión + textura) que LIVENESS necesita para no depender únicamente de R/(G+B).
3. **PI por canal** — el primer gate biológico (no óptico) del pipeline; bloquea cadáver/silicona sin matar perfusión baja.
4. **Liveness adaptativo** — solo seguro DESPUÉS de 1+2+3, porque baja umbrales solo cuando los otros gates ya confirmaron tejido.
5. **CHROM/POS bloque-wise** — mejora la fuente proyectada SIN tocar las clásicas R/G/RG (preserva lo que ya funciona).
6. **DC mediana + bandpass dual** — protege contra artefactos transitorios y permite "modo rescate" cuando el ranker ya cedió a proyecciones.
7. **Auto-exposure loop** — cierra el lazo de control que CameraView abre en Phase 4 pero no mantiene en runtime.
8. **Telemetría** — sin observabilidad nueva, lo anterior es invisible.

## Lo que NO hace este plan (a propósito, según workspace-knowledge)

- No toca BPM/SpO2/BP/glucosa/colesterol — son fases siguientes.
- No introduce ML on-device — fuera de scope de Fase 1.
- No introduce dependencias nuevas (no opencv, no tf.js).
- No rompe API pública del hook `useSignalProcessor`.
- No cambia diseño visual salvo chips nuevos en el overlay forense ya existente.

Aprobá este plan y aplico los 8 commits en una sola tirada quirúrgica, archivo por archivo, con sus tests y `ci:guard` verde.