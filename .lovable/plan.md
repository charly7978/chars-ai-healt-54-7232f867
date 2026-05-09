# Plan: Pipeline PPG Profesional — Detección + Extracción de nivel forense

## Objetivo
Integrar el pipeline avanzado descrito (Adaptive ROI, PCA fusion, SQI por momentos, Web Worker aislado, frame timing real, exposure classifier, ring buffers Float32) **sin romper** lo que ya funciona (BPM detection, VitalSignsProcessor, BP, UI estética actual). Monitor cardíaco a 100% pantalla mostrando toda la actividad incluidas arritmias. Cero simulación.

## Alcance estricto (NO tocar)
- Estética visual de PPGSignalMeter (oscilloscope look ya aprobado) — solo ajustar a 100vh/100vw.
- BloodPressureProcessor, VitalSignsProcessor, arrhythmia-processor — siguen siendo consumidores aguas abajo.
- Auth, Supabase, save measurement, edge function de IA.
- HeartBeatProcessor (se conecta como consumidor del nuevo pipeline).

## Cambios técnicos

### 1. Nueva capa `src/lib/ppg/` (módulos puros, tree-shakeables)
```
src/lib/ppg/
  types.ts                      # PpgCaptureState, FrameSample, PpgSignalSnapshot, PPG_CONFIG
  camera/
    cameraController.ts         # Constraints en fases, torch tolerante, lock exposure/WB/focus
    cameraCapabilities.ts       # Serializa caps/settings para diagnóstico
  capture/
    frameLoop.ts                # rVFC con metadata.presentedFrames + jitter tracking
    downsample.ts               # Canvas 160x120 willReadFrequently:true
  detection/
    fingerDetector.ts           # Heurística píxel a píxel: luma/chroma/rn/clipping
    exposureClassifier.ts       # too-dark/too-bright/too-much-pressure/etc
  roi/
    adaptiveRoi.ts              # Grid 10x8, EMA α=0.15, top-30% tiles, center prior
  signal/
    ringBuffer.ts               # FloatRingBuffer pre-asignado
    normalization.ts            # AC/DC + log Beer-Lambert con τ=2.0s
    filters.ts                  # Biquad Butterworth Direct Form I, fs dinámico
    signalFusion.ts             # PCA cerrado vía Cardano (eigendecomp 3x3 O(1))
    sqi.ts                      # Skewness + Kurtosis + PI + clip penalty (Welford)
  worker/
    ppgWorker.ts                # Orquesta detection→ROI→normalize→filter→PCA→SQI
```

### 2. Integración con código existente
- **`CameraView.tsx`**: refactor interno usando `CameraController` nuevo, manteniendo mismo API (`onStreamReady`, `isMonitoring`, ref). No cambia UI.
- **`PPGSignalProcessor.ts`**: convertir en **adapter** que recibe `PpgSignalSnapshot` del worker y emite el `ProcessedSignal` que ya esperan los hooks downstream. Mantiene firma pública (`processFrame`, `getRGBStats`, `start`, `stop`, `calibrate`, `onSignalReady`).
- **`useSignalProcessor.ts`**: añade hook interno que arranca el worker en lugar de procesar en el main thread; `processFrame(imageData)` queda como fallback. Mismo retorno público.
- **`Index.tsx`**: usar `requestVideoFrameCallback` con `metadata.mediaTime` (ya existe parcialmente); pasar timestamp real al pipeline.
- **`HeartBeatProcessor`** y **`VitalSignsProcessor`** consumen `lastSignal.filteredValue` y RGB stats — **sin cambios** salvo asegurar conexión.

### 3. Monitor cardíaco a pantalla completa
- `PPGSignalMeter.tsx`: ajustar contenedor a `fixed inset-0 w-screen h-screen` con canvas que ocupe 100% del viewport. Mantener estética eléctrica oscilloscope, paneles BPM/SpO2 superpuestos.
- Renderizar **toda** la actividad: trazo continuo + marcadores de pico + overlay rojo en arritmias (ya existe lógica `isArrhythmia`).
- Verificar que `Index.tsx` no lo encierre en un wrapper que limite tamaño.

### 4. Garantías anti-simulación
- Toda fuente numérica viene de píxeles reales del frame.
- Si `fingerScore < 0.55` o SQI < umbral → emit `state: "finger-missing"` y `filtered: 0`, **no** se rellena con valores plausibles.
- BPM/SpO2/BP se ocultan en UI cuando snapshot.state ≠ "signal-locked".

## Detalles técnicos por archivo

**`worker/ppgWorker.ts`** — pipeline por mensaje:
1. recibir `{data, width, height, t, targetFps}`
2. `computeFingerMetrics` → fingerScore + RGB global
3. `AdaptiveRoiSelector.computeRoi` → roiRgb ponderado
4. push a 3 `FloatRingBuffer` (R,G,B) de capacidad `fps*BUFFER_SECONDS`
5. `NormalizationPipeline.process(roiRgb)` → AC/DC + logNorm
6. recompute Biquad coefficients si `|fs - lastFs| > 2 Hz`
7. `BiquadFilter.process(logNorm.g)` (canal por defecto)
8. cada N=15 frames: `PcaSignalFusion` sobre últimos 6s → channel selection
9. `SqiEvaluator.compute` sobre buffer filtrado
10. `classifyExposure` para hint
11. `postMessage` snapshot

**`PPGSignalProcessor.ts` (adapter)**:
- Mantiene interfaz pública.
- Internamente: spawn worker, recibe snapshots, emite `ProcessedSignal { timestamp, rawValue: snapshot.raw.r, filteredValue: snapshot.filtered, quality: snapshot.sqi, fingerDetected: snapshot.fingerScore>0.55, roi:{...} }`.
- `getRGBStats()` devuelve buffers ring para SpO2.

**Arritmias**: el `arrhythmia-processor` y `HeartBeatProcessor` siguen recibiendo `filteredValue` continuo → detectan picos y arritmias como hoy. El monitor las pinta en rojo (ya implementado).

## Verificación post-implementación
1. Build OK (TypeScript estricto).
2. Sin frame en cámara → snapshot.state="finger-missing", filtered=0, BPM oculto.
3. Con dedo → state=signal-locked en <5s, SQI>50, BPM aparece.
4. Monitor ocupa 100vh×100vw.
5. Arritmias se pintan rojo cuando arrhythmiaStatus contiene "ARRITMIA".
6. Sin valores fake (logs muestran ceros cuando no hay contacto).

## Lo que NO se hace en esta tarea
- Cambios a BP, SpO2, glucosa, lípidos (ya migrados en commits anteriores).
- Rediseño visual del oscilloscope (solo full-screen).
- Validación clínica formal.
