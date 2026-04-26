
# Plan: Romper el deadlock forense y reconstruir el pipeline en 3 compuertas

## 1. Diagnóstico exacto del deadlock (confirmado en código)

En `src/pages/Index.tsx` el loop principal hace:

```
line 905: const odAccepted = forensicPass && !!fg.opticalEvidence;
line 936: if (ratioGuardActive || !odAccepted) { setHeartbeatSignal(0); return; }   // ← NO llama processHeartBeat
line 948: const heartBeatResult = processHeartBeat(...)                              // ← solo si odAccepted
line 974: setMorphologyGate(morphPass, ...)                                          // ← única forma de abrir gate3
```

Y en `PPGSignalProcessor.ts`:
- `gate3_morphology` (línea 653) se publica desde `this.gate3Pass`.
- `this.gate3Pass` SOLO se actualiza cuando alguien llama `setMorphologyGate()` (línea 164).
- `setMorphologyGate()` SOLO se llama después de `processHeartBeat()` (Index línea 974).

`forensicPass = passAll = gate1 && gate2 && gate3`.
→ Para abrir gate3 hace falta correr `processHeartBeat`.
→ Pero `processHeartBeat` está gateado por `forensicPass` (que necesita gate3).
→ **gate3 jamás se abre. La app jamás mide. Deadlock confirmado.**

A esto se suma que `forensicPass` también gobierna `setHeartbeatSignal()` (línea 968), `setHeartRate()` (línea 1014) y la limpieza de vitals — correcto que gobierne **publicación**, incorrecto que gobierne **alimentación del detector**.

## 2. Arquitectura objetivo (3 compuertas, sin ciclo)

```
CameraFrame
  → ACQUISITION_GATE   (cámara on)            → siempre que isMonitoring
  → RawRGBExtractor + sRGB→linear + OD         (ya implementado en PPGSignalProcessor)
  → AdaptiveROI + CandidatePPG                 (ya implementado)
  → OpticalEvidenceGate (gate1)                (ya implementado, NO depende de morfología)
  → SpectralSQI       (gate2 candidato)        (ya implementado)
  → PROCESSING_GATE   ← evidencia óptica + buffer + no clip extremo + OD computable
  → HeartBeatDetector (siempre que processing-gate abra)
  → MorphologyValidator → setMorphologyGate (cierra gate3)
  → PUBLICATION_GATE  = gate1 ∧ gate2 ∧ gate3 ∧ bpm>0 ∧ conf≥0.30
  → UI / beep / vibrate / waveform / vitals
```

Reglas duras:
- **PROCESSING_GATE NO depende de** `forensicPass`, `gate3_morphology`, `publicationGate`, ni de BPM.
- **PUBLICATION_GATE NO bloquea** la entrada del detector — solo bloquea salidas visibles, sonido y haptics.

## 3. Cambios concretos archivo por archivo

### 3.1 `src/pages/Index.tsx` — corregir el loop principal (líneas ~740–1170)

**Eliminar** la rama de bloqueo de líneas 936–946. **Reemplazar** por una nueva variable `processingAllowed` que NO incluya `forensicPass`:

```ts
// PROCESSING_GATE — habilita alimentar el detector. NO depende de morfología
// ni de forensicPass. Solo exige evidencia óptica mínima + buffer + señal OD.
const om = (fg as any)?.opticalMetrics;
const bufferedSeconds = (fg as any)?.bufferedSeconds ?? 0;
const processingAllowed =
  !!(fg as any)?.opticalEvidence &&        // hay tejido/transiluminación compatible
  om != null &&
  om.meanR >= 25 && om.meanR <= 245 &&     // ni negro ni blanco saturado
  om.clipHigh < 0.20 &&                    // sin clipping severo
  om.clipLow  < 0.20 &&
  bufferedSeconds >= 1.5 &&                // mínimo 1.5 s para que el detector arranque
  Number.isFinite(signalValue);            // OD/PPG candidato existe

if (!processingAllowed) {
  // Limpia UI de publicación, pero NO retorna sin alimentar al detector
  // si la única razón es que aún no se cumple morfología — eso es el job
  // de PUBLICATION_GATE, no de PROCESSING.
  setHeartbeatSignal(0);
  unstableFrameCounter.current++;
  if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD) {
    setHeartRate(0); setBeatMarker(0); setRRIntervals([]);
    clearPublishedVitals();           // helper nuevo
  }
  return;
}
```

**Llamar SIEMPRE a `processHeartBeat`** cuando `processingAllowed` (eliminar la dependencia de `odAccepted` para alimentación):

```ts
const heartBeatResult = processHeartBeat(
  signalValue, contactState, lastSignal.timestamp,
  {
    quality: lastSignal.quality, contactState,
    motionArtifact: lastSignal.motionArtifact || motionInfo.motionArtifact,
    pressureState: pressureOptimal ? 'OPTIMAL_PRESSURE' : 'LOW_PRESSURE',
    clipHigh: om.clipHigh, clipLow: om.clipLow,
    perfusionIndex: lastSignal.perfusionIndex,
    positionDrifting: positionQuality.drifting,
    publicationGate: false,            // ← FALSE aquí. Se calcula DESPUÉS.
  }
);

// ── Cierra gate3 con la verdad de la morfología SIEMPRE que el detector
// haya corrido. Esto es lo que rompe el deadlock. ──
const morphPass = !!(heartBeatResult as any).morphologyGatePass;
setMorphologyGate(morphPass, morphPass ? 'OK' : 'MORFOLOGÍA INSUFICIENTE');
```

**Calcular PUBLICATION_GATE después** del detector:

```ts
const publicationGate =
  !!(fg as any)?.opticalEvidence &&
  !!fg?.gate2_spectral &&
  morphPass &&
  heartBeatResult.bpm > 0 &&
  heartBeatResult.bpmConfidence >= 0.30;

// Re-feed al HeartBeatProcessor para que el PRÓXIMO beep/vibration esté
// autorizado. El processor expone setPublicationGate() (ya existe).
heartBeatProcessor.setPublicationGate(publicationGate);

if (!publicationGate) {
  setHeartbeatSignal(0);            // onda visible flat
  // mantener detector corriendo, sin publicar BPM
  unstableFrameCounter.current++;
  if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD) {
    setHeartRate(0); setBeatMarker(0); setRRIntervals([]);
    clearPublishedVitals();
  }
  return;
}

// === Solo aquí publicamos ===
unstableFrameCounter.current = 0;
setHeartbeatSignal(heartBeatResult.filteredValue);
setHeartRate(Math.round(heartBeatResult.bpm));
if (heartBeatResult.isPeak) { setBeatMarker(1); setTimeout(()=>setBeatMarker(0), 300); ... }
```

**Helper nuevo `clearPublishedVitals()`** (función local del componente) que pone a 0 spo2/glucose/pressure/lipids y `arrhythmiaCount="--"`.

**Vibración / beep**:
- En `Index.tsx` línea 1156: la vibración de arritmia ya está condicionada a `forensicPass && opticalEvidence`. Cambiar a `publicationGate`.
- En `HeartBeatProcessor.ts`: el método `setPublicationGate` ya existe y silencia beep/vibrate. Solo se cambia *cuándo* lo llamamos: ahora se setea **después** del cálculo del publicationGate del frame.
- Eliminar cualquier vibración inicial mal etiquetada (revisar `playStartupSound` / vibraciones de inicio en `Index.tsx`) — usar patrón distinto y que NO se confunda con pulso.

**Auto-relax y ratio guard**: el ratio-guard actual (línea 904) bloqueaba alimentación. Se mueve a `publicationGate` (no a `processingAllowed`). El detector debe correr siempre para que el ratio pueda mejorar.

### 3.2 `src/modules/signal-processing/PPGSignalProcessor.ts`

- En el cálculo de `passAll` (donde se compone `forensicGate`), exponer ya `opticalEvidence` y `opticalMetrics` (ya está). Sin cambios estructurales — solo asegurar que `bufferedSeconds` y `opticalMetrics` salen siempre, incluso cuando `passAll=false`. Verificar líneas ~640–660.
- Asegurar que `OpticalEvidenceGate` se evalúa **antes** y de forma **independiente** del beat result (ya es el caso).

### 3.3 `src/modules/HeartBeatProcessor.ts`

- Confirmar que `processSignal()` siempre procesa la muestra y siempre evalúa morfología/fiduciales aunque `publicationGate=false`. La única diferencia debe ser el silencio de beep + vibrate (ya implementado vía `setPublicationGate`).
- Asegurar que `morphologyGatePass` se publica en el resultado **siempre**, no condicionado a `publicationGate`. (Hoy `useHeartBeatProcessor.ts` ya re-deriva `morphologyGatePass`; verificar que se calcula sobre `recentAcceptedBeats` reales independientes de la publicación).

### 3.4 `src/hooks/useHeartBeatProcessor.ts`

- Quitar la línea `processorRef.current.setPublicationGate(!!upstreamContext?.publicationGate);` del comienzo del hook (línea ~95). El publication gate se setea desde `Index.tsx` por separado vía un nuevo método `setPublicationGate` expuesto por el hook (o seguimos pasándolo, pero entendiendo que el hook NO debe usar publicationGate como pre-condición de procesamiento — actualmente ya no lo hace, solo lo propaga).
- Mantener el cómputo de `morphologyGatePass` interno: se sigue calculando correctamente sobre `recentAcceptedBeats`.

### 3.5 `src/components/PPGSignalMeter.tsx`

- Mantener: cuando `publicationGate=false`, dibuja línea base 0 + banner de razón.
- Añadir un modo **diagnóstico** opcional (?diag=1) que dibuje en gris claro la `candidatePPG` (no validada) bajo la línea base, marcada como "NO VALIDADA". Esto deja ver al operador que la cámara sí está extrayendo señal aunque no se publique. No se confunde con la onda real porque el color y la etiqueta son distintos.

### 3.6 `src/components/ForensicGateOverlay.tsx`

Añadir 3 indicadores nuevos:
1. **PROCESSING** (verde si `processingAllowed`, gris si no).
2. **PUBLICATION** (verde si `publicationGate`, ámbar si processing-on pero pub-off, rojo si processing-off).
3. **bufferedSeconds** + **meanR** + **AC/DC** ya están — solo etiquetar con umbrales.

Esto le permite al usuario ver exactamente en qué etapa se atasca.

### 3.7 Auditoría de simulaciones / fallbacks

Correr `scripts/audit-forensic.mjs` (ya existe) y extender la lista de patrones prohibidos para cubrir: `Math.sin`, `mock`, `simulate`, `placeholder`, `fake`, `dummy`, `demo`, `defaultVitals`, `synthetic`. Reportar matches y eliminarlos del pipeline real.

Búsqueda inicial a hacer:
```
rg -n "Math\.(random|sin)|mock|simulate|fake|dummy|placeholder|defaultVitals|synthetic|demo" src/
```
Listar resultados, clasificar (real vs comentario vs nombre de variable benigno) y eliminar/aislar lo que toque la cadena de signos vitales.

## 4. Tests / harness manual

Añadir `src/__tests__/forensic-gates.spec.ts` con casos sintéticos sobre el gating (no sobre la cámara real):

| Caso | Optical | Spectral | Morph | bpm | publicationGate esperado |
|---|---|---|---|---|---|
| A. Aire | false | false | false | 0 | **false** |
| B. Sábana roja (rojo alto sin AC) | true | false | false | 0 | **false** |
| C. Dedo real estable | true | true | true | 75 | **true** |
| D. Dedo movido (morph rota) | true | true | false | 60 | **false** |
| E. Cámara tapada negra (clipLow alto) | false | – | – | 0 | **false** + processingAllowed=false |
| F. Saturación blanca (clipHigh alto) | false | – | – | 0 | **false** + processingAllowed=false |

Y un harness manual documentado en `docs/forensic-validation.md` con los pasos para reproducir A–F en el dispositivo real.

## 5. Criterios de aceptación

1. Con `?forensic=1` y dedo humano real: en ≤ 8 s, los 3 gates abren, BPM aparece, onda dibuja.
2. Con cámara apuntando a aire/sábana/mantel rojo: BPM=0, onda flat, vibración silenciosa, overlay muestra qué gate falló.
3. El detector se alimenta SIEMPRE que `processingAllowed=true` (verificable por logs `beatsAccepted` creciendo aunque `publicationGate=false`).
4. `morphologyGatePass` se computa con OD real, no con el resultado de `forensicPass`.
5. Al perder señal, BPM/SpO2/BP/glucose/lipids vuelven a 0 (no se mantiene el último valor).
6. Vibración de pulso solo en `isPeak && publicationGate`.
7. `scripts/audit-forensic.mjs` pasa sin violaciones.

## 6. Resumen de archivos a tocar

- **`src/pages/Index.tsx`** — refactor del loop (líneas 740–1170): eliminar `odAccepted`-as-gate, introducir `processingAllowed` + `publicationGate` separados, helper `clearPublishedVitals`, mover ratio-guard a publication.
- **`src/hooks/useHeartBeatProcessor.ts`** — desacoplar `setPublicationGate` de la entrada de `processSignal`; el detector siempre procesa.
- **`src/modules/HeartBeatProcessor.ts`** — confirmar (no cambiar lógica) que beep/vibrate son lo único condicionado a publicationGate.
- **`src/modules/signal-processing/PPGSignalProcessor.ts`** — exponer `bufferedSeconds` y `opticalMetrics` siempre (ya lo hace; verificación).
- **`src/components/PPGSignalMeter.tsx`** — modo diagnóstico opcional para ver candidato no publicado.
- **`src/components/ForensicGateOverlay.tsx`** — añadir píldoras PROCESSING / PUBLICATION.
- **`scripts/audit-forensic.mjs`** — extender patrones (`Math.sin`, `mock`, `simulate`, `fake`, `dummy`, `placeholder`, `synthetic`).
- **`src/__tests__/forensic-gates.spec.ts`** — tests A–F.
- **`docs/forensic-validation.md`** — harness manual.

Sin duplicación de pipelines: se conserva `useSignalProcessor` + `PPGSignalProcessor` como única fuente de verdad. No se introducen nuevos procesadores paralelos.
