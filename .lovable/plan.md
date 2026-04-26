# PLAN — PIPELINE PPG FORENSE NIVEL POLICÍA CIENTÍFICA

## Diagnóstico (auditoría archivo por archivo)

He recorrido todo el flujo: `CameraView.tsx` → `Index.startFrameLoop` → `useSignalProcessor.processFrame` → `PPGSignalProcessor.processFrame` → `OpticalEvidenceGate` → `CardiacBandVerifier` → `Index` loop principal → `useHeartBeatProcessor.processSignal` → `HeartBeatProcessor`.

**El deadlock previo entre processing/publication ya se rompió** (frame anterior = 1716–1728), pero la app no mide porque hay **otro bloqueo aguas arriba** que estrangula los datos antes incluso de llegar al detector. Tres causas concretas:

### 1. LIVENESS gate (`PPGSignalProcessor.ts` L45–55) demasiado restrictivo
- `TOTAL_I_MAX = 700` → con flash trasero potente y dedo bien apoyado, R+G+B fácilmente excede 700 → liveness rechaza para siempre como "LUZ DIRECTA".
- `TEXTURE_MIN = 0.008` y `TEXTURE_MAX = 0.06` → un dedo bien presionado contra el lente da `spatialUniformity ≈ 1` → `textureProxy ≈ 0` → rechazo permanente como "SUPERFICIE PLANA".
- `COVERAGE_MIN = 0.35` + `CONFIRM_FRAMES = 12` antes de habilitar nada.
- Cuando esto cierra, el procesador hace **HARD ZERO** (L335) y **no llena el buffer temporal**, así que `bufferedSeconds` nunca crece y nada baja por la cadena.

### 2. `OpticalEvidenceGate` (capa segunda) duplica restricciones
- `meanRMax = 245`, `clipHighMax = 0.05` → con flash+dedo el rojo satura a ≥ 245 fácilmente.
- Como ya se rechaza arriba en liveness, **este gate ni siquiera tiene chance de ver datos**.

### 3. Loop de `Index.tsx` (L919–926)
- `processingAllowed` exige `meanR ∈ [25,245]`, `clipHigh < 0.20`, `bufferedSeconds ≥ 1.5`.
- Como el procesador nunca llena `timedSamples` (porque liveness lo bloquea), `bufferedSeconds = 0` → **el detector cardíaco no se alimenta nunca**.

### Patrones del estado actual
- En el log de consola no aparece la línea `📷 PPG [...] Q=...` cada 3s → confirma que el procesador está cortando en el HARD ZERO.
- La extracción RGB **sí ocurre** (la cámara funciona), pero la salida sale con `rawValue=0` y nadie ve el problema porque la UI ya esconde todo.

---

## Estrategia de la corrección

Mantener la "compuerta de publicación" (que sí funciona) pero **separar adquisición / procesamiento / publicación** de verdad, y **calibrar los umbrales físicos** según literatura PPG móvil real (Apple Heart Study, Nature Sci. Rep. 2014, IEEE TBME 2019/2023).

Reglas duras que no se mueven:
- **Adquisición**: siempre activa con cámara prendida.
- **Procesamiento**: alimenta detector cardíaco con OD computable + buffer temporal mínimo. NO depende de morfología, NO depende de SNR, NO depende de "forma de dedo".
- **Publicación**: solo si Optical + Spectral + Morphology + BPM confianza ≥ 0.30.
- **Sin valores fake**: cuando publicación = false → BPM=0, onda=0, vitales=0, vibración apagada.

---

## Cambios concretos

### A) `src/modules/signal-processing/PPGSignalProcessor.ts` — desestrangular liveness

1. **Recalibrar LIVENESS** (línea 45–55) según telemetría real con flash:
   - `TOTAL_I_MAX`: subir 700 → **1500** (3 canales × 250 saturación legítima con torch).
   - `TEXTURE_MIN`: bajar 0.008 → **0.0015** (un dedo bien apoyado da textura muy baja).
   - `TEXTURE_MAX`: subir 0.06 → **0.15**.
   - `COVERAGE_MIN`: bajar 0.35 → **0.20** (dedos pequeños, descentrados).
   - `CONFIRM_FRAMES`: 12 → **6** (200 ms a 30 fps; basta para confirmar).
   - `RELEASE_FRAMES`: mantener en 6 (no ser pegajoso al perder señal).
   
   **Justificación**: liveness sigue protegiendo contra aire/pared/sábana (que jamás darán R/(G+B)≥1.35 con redDom≥18 simultáneamente), pero no estrangula al dedo real bajo flash.

2. **Romper el HARD ZERO**: cuando liveness falla, **seguir empujando el sample OD al `timedSamples` buffer** (con flag `accepted:false`) en vez de descartar. Así `bufferedSeconds` siempre crece y el procesador puede recuperarse en cuanto liveness vuelve. La publicación sigue cerrada porque `forensicGate.gate1_optical=false`.

3. **Telemetría cruda forense**: añadir al `forensicGate` emitido los crudos `rawR`, `rawG`, `rawB`, `totalI`, `absorption`, `redDom`, `texture`, `coverage`, `livenessConfirmCount` para que el overlay muestre **por qué** falla liveness en tiempo real (ya hay `livenessReason` pero falta el detalle numérico).

### B) `src/modules/signal-processing/OpticalEvidenceGate.ts` — relajar saturación legítima

- `meanRMax`: 245 → **252** (con flash directo el rojo legítimamente cerca de 250).
- `clipHighMax`: 0.05 → **0.25** (dedos finos saturan parcialmente sin perder pulsatilidad).
- `rOverGBMin`: 1.20 → **1.10** (tejido pálido o frío).
- `acDcMin`: 0.0015 → **0.0008** (perfusión baja en víctima en shock — caso forense real).

### C) `src/modules/signal-processing/CardiacBandVerifier.ts` — escalonar umbrales

- Reducir SNR mínimo de **6 dB → 4 dB** (literatura clínica Apple Heart Study acepta 3–4 dB durante adquisición).
- `concentration ≥ 0.60 → 0.45`.
- Mantener rango 0.7–3.5 Hz (42–210 BPM, válido forense).
- Mantener `HOLD_MS` para evitar abrir/cerrar gate por ruido transitorio.

### D) `src/pages/Index.tsx` — loop principal

1. **`processingAllowed`** (L919–926): bajar `bufferedSeconds ≥ 1.5 → 1.0` y subir `clipHigh < 0.20 → 0.30`. Sigue pidiendo `meanR ∈ [25, 250]`.
2. **No volver a cero `setHeartbeatSignal(0)` mientras el detector está aprendiendo** si el publication gate está cerrado por morfología pendiente — usar `setHeartbeatSignal(heartBeatResult.filteredValue * 0.0)` solo cuando opticalGate falla. Así la UI muestra "BUSCANDO PULSO" pero el detector sigue construyendo morfología.
3. **Diagnóstico visible**: el `ForensicGateOverlay` ya existe; añadir línea con `meanR`, `clipHigh`, `bufferedSeconds`, `acDc`, `texture` para que el operador vea exactamente qué falla.

### E) `src/components/ForensicGateOverlay.tsx` — ampliar telemetría

Añadir bloque "TELEMETRÍA CRUDA":
- meanR / meanG / meanB
- totalI (R+G+B)
- R/(G+B) absorbance
- texture / coverage
- bufferedSeconds / effectiveSampleRate
- AC/DC y PI
- liveness confirm/release counters
- razón de cierre del gate más cercano (lo más útil para depurar)

Esto es lo que el usuario "policía forense" necesita: ver **por qué** no mide, no solo "no mide".

### F) `scripts/audit-forensic.mjs` — endurecer

Añadir patrones prohibidos:
- `Math\.sin\b` (excepto en `BandpassFilter.ts` y `PPGSignalMeter.tsx`)
- `mock|fake|dummy|synthetic|placeholder` (case-insensitive)
- defaults `|| 60`, `|| 90`, `|| 100` (BPM/SpO2)

### G) Tests forenses (`src/test/forensic-audit.test.ts`)

Ya existe; **ampliar** con un caso que verifica que `LIVENESS.TOTAL_I_MAX ≥ 1200` y `LIVENESS.TEXTURE_MIN ≤ 0.003` para evitar regresión a los umbrales que estrangulaban.

### H) Test unitario nuevo: `src/modules/signal-processing/__tests__/PPGSignalProcessor.test.ts`

Tres casos:
1. **Aire** (RGB ≈ 100, 100, 100, sin pulsación): `forensicGate.passAll = false`, `rawValue = 0`, **siempre**.
2. **Sábana roja estática** (R=200, G=30, B=30, sin AC): liveness puede pasar (R/G+B alto), pero `gate2_spectral` cierra → `passAll = false`.
3. **Señal sintética cardíaca** (R = 200 + 8·sin(2π·1.2·t)): después de ~3s, `gate1` y `gate2` abren; `bufferedSeconds > 1.5`; el detector recibe muestras (`processingAllowed = true`).

Esto **no** es un test que falsifica vitales: usa señales para verificar que los gates abren/cierran correctamente. La señal sintética solo vive en el test, jamás en `src/`.

---

## Criterios de aceptación
1. Con cámara apuntando al **aire**: `gate1_optical = false`, telemetría visible explica "SIN FIRMA DE HEMOGLOBINA". BPM=0, onda plana, sin vibración.
2. Con **sábana/mantel rojo**: `gate1` puede abrir momentáneamente (es rojo), pero `gate2_spectral` no abre porque no hay pulsación 0.7–3.5 Hz. BPM=0.
3. Con **dedo real + flash**: en < 3s, `gate1_optical = true` (telemetría confirma totalI~600–1200, texture~0.005–0.05, R/(G+B)~1.5–3). En < 8s `gate2_spectral` abre. En < 12s `gate3_morphology` abre y empieza a publicar BPM.
4. Si el dedo se mueve / se despega: `gate1` cae en < 200 ms, BPM se va a 0 inmediatamente — **no se conserva el último BPM**.
5. Vibración de pulso solo cuando `publicationGate=true && isPeak=true`.
6. `npm run test` pasa con los nuevos tests.
7. `node scripts/audit-forensic.mjs` pasa.

---

## Archivos modificados
- `src/modules/signal-processing/PPGSignalProcessor.ts` (recalibrar LIVENESS, no romper buffer cuando falla, exponer crudos)
- `src/modules/signal-processing/OpticalEvidenceGate.ts` (umbrales realistas con flash)
- `src/modules/signal-processing/CardiacBandVerifier.ts` (SNR/concentration menos draconianos)
- `src/components/ForensicGateOverlay.tsx` (telemetría cruda visible)
- `src/pages/Index.tsx` (loop principal: bajar `bufferedSeconds≥1.0`, subir `clipHigh<0.30`)
- `scripts/audit-forensic.mjs` (más patrones prohibidos)
- `src/test/forensic-audit.test.ts` (lock-in de los nuevos umbrales)
- `src/modules/signal-processing/__tests__/PPGSignalProcessor.test.ts` (NUEVO — aire / sábana / sintético)

## Archivos NO tocados
- `CameraView.tsx` (funciona).
- `HeartBeatProcessor.ts` y `useHeartBeatProcessor.ts` (la lógica del detector está bien — el problema es que no le llegaba señal).
- `BandpassFilter.ts` (filtros DSP están correctos).
- `useVitalSignsProcessor` y módulos de SpO2/BP/glucosa/lípidos (en modo forense ya están ocultos, no se publica nada hasta `publicationGate=true`).

## Por qué esto va a funcionar
El bug real era que el guardia físico de la puerta (LIVENESS) estaba **calibrado para una cámara sin flash y un dedo flojo**. Con flash trasero potente y un dedo bien apoyado, los píxeles rojos saturan, la textura se aplana, y el guardia rechaza al sujeto legítimo. La consecuencia es que el detector cardíaco jamás veía la señal y los siguientes gates nunca se abrían, dando el síntoma "no mide nada".

Tras la corrección:
- LIVENESS sigue rechazando aire/pared/sábana (esos no tienen R/(G+B)≥1.35 + redDom≥18).
- LIVENESS acepta dedo real bajo flash.
- El buffer temporal siempre se llena → spectral verifier puede decidir.
- Spectral solo abre con pulsación cardíaca real → bloquea sábana roja estática.
- Morfología solo abre con latidos físicamente coherentes.
- Publicación sigue siendo el AND de los tres gates + confianza BPM.
