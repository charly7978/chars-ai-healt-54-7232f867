
# Plan: Modo Forense — Pulso Real Verificable, Sin Datos Fantasma

## Diagnóstico honesto del problema actual

He auditado el pipeline completo (`PPGSignalProcessor.ts`, `HeartBeatProcessor.ts`, `useVitalSignsProcessor.ts`, `Index.tsx`). El problema real tiene **dos caras** y ambas son ciertas a la vez:

### 1. La app muestra valores "del aire" (FARSA real, lo confirmo)

- **SpO₂, presión, glucosa, lípidos** se calculan en `VitalSignsProcessor` aunque la señal PPG no provenga de un dedo vivo. Físicamente, **una sola cámara RGB con flash blanco no puede medir SpO₂, presión, glucosa ni colesterol con validez clínica.** Para SpO₂ se necesitan 2 longitudes de onda discretas (rojo + IR) y calibración por dispositivo; para presión se necesita calibración con tensiómetro; glucosa/lípidos no son medibles ópticamente con cámara de celular sin reactivos.
- El `BandpassFilter` (0.5–4 Hz) **inventa una onda sinusoidal a partir de cualquier ruido periódico** (parpadeo de luz, autoexposición, micro-movimientos). Por eso ves "ondas cardíacas" apuntando al aire.
- El `HeartBeatProcessor` reporta BPM cuando la autocorrelación encuentra periodicidad — y la encuentra incluso en ruido de cámara.

### 2. El "bloqueo de dedo" es excesivo y mata el caso forense (queja válida)

- `detectFingerInstant()` exige `r > 95`, `rgRatio > 1.28`, `redDominance > 28`, `coverage > 0.42`, `spatialUniformity > 0.42` para entrar en contacto. **Un dedo de persona herida con baja perfusión, frío, en shock o con hipotermia tiene perfusión muy baja y NO cumple esos umbrales** → la app dice "no hay dedo" y nunca mide.
- Además, `motionGated` y `pressureState='HIGH_PRESSURE'` bloquean la señal incluso cuando hay contacto real.

---

## Filosofía del rediseño (lo que voy a garantizar)

Voy a transformar la app en una **herramienta forense honesta** con dos modos:

| Modo | Qué muestra | Qué NO muestra |
|---|---|---|
| **MODO FORENSE (nuevo, default)** | Forma de onda PPG cruda + BPM + Índice de Perfusión + veredicto binario "PULSO DETECTADO / SIN PULSO" con nivel de confianza | Nada de SpO₂, presión, glucosa, lípidos |
| **MODO CIVIL (opcional, oculto)** | Lo anterior + estimaciones civiles con etiqueta `ESTIMACIÓN NO CLÍNICA` | — |

**Lo que SÍ es físicamente garantizable con cámara + flash y voy a hacer riguroso:**
1. **Presencia/ausencia de pulso cardíaco** vivo (esto es lo crítico forense).
2. **BPM** cuando hay pulso real (literatura: MAE < 3 bpm es estándar).
3. **Onda PPG cruda visualizable** (sirve al forense para inspección visual).
4. **Índice de Perfusión** real (AC/DC del canal rojo).

**Lo que voy a ELIMINAR de la UI por ser físicamente imposible con este hardware:**
- SpO₂, presión arterial, glucosa, colesterol/triglicéridos como números mostrados.
- (El código se conserva detrás de un flag `?civil=1` con etiqueta de "no clínico", pero la UI por defecto NO los muestra.)

---

## Cambios concretos a implementar

### A) `PPGSignalProcessor.ts` — Detección de dedo de DOS NIVELES + verificador anti-aire

Reemplazo el detector binario actual por un sistema de 3 estados con umbrales adaptativos:

1. **`NO_OPTICAL_CONTACT`** — La cámara ve aire/objeto/superficie sin firma de hemoglobina. Detectado por:
   - Brillo total fuera de rango plausible para piel iluminada por flash (`totalI < 80` o `totalI > 730`).
   - **Ausencia de firma de hemoglobina**: `R/(G+B) < 1.05` (la sangre absorbe G+B mucho más que R; esto es la firma óptica más rígida y la verifico SIEMPRE, incluso al aire libre).
   - Coverage < 0.15.

2. **`OPTICAL_CONTACT_LOW_PERFUSION`** — Hay un dedo (firma de hemoglobina presente) pero perfusión muy baja (forense: dedo frío, shock, hipotermia, post-mortem reciente). Umbrales:
   - `R/(G+B) > 1.05`, coverage > 0.20, `r > 40` (mucho más permisivo que el actual).
   - **Aquí SÍ se procesa la señal** y se reporta BPM si aparece. La app NO bloquea.

3. **`OPTICAL_CONTACT_GOOD_PERFUSION`** — Dedo con perfusión normal. Umbrales actuales conservados.

**Nuevo: verificador anti-aire ("liveness óptico")** — agrego un módulo `OpticalLivenessVerifier` que decide si el sujeto delante de la cámara puede ser un dedo vivo o no, **independientemente de la perfusión**:
- Firma espectral roja sostenida (R dominante > 8 unidades, EWMA 2s).
- Respuesta esperable al flash (intensidad total dentro del rango de piel iluminada).
- Estabilidad espacial mínima (no es un patrón cambiante de luz ambiente).
- Si NO hay firma óptica → la app reporta `SIN PULSO — SIN CONTACTO ÓPTICO` y bloquea TODO el output numérico (incluido BPM e onda).

### B) `HeartBeatProcessor.ts` — Validador de pulso fisiológico

Añado un gate **anti-falso-positivo** antes de reportar BPM:

- **Validación de morfología obligatoria**: solo se reporta BPM si los últimos 5 latidos pasan por `FiducialDelineator` y muestran morfología PPG plausible (`morphologyValidity > 0.45`, `riseTimeMs ∈ [60ms, 350ms]`, presencia de pendiente sistólica clara). Esto rechaza periodicidad por ruido de cámara, parpadeo de luz, autoexposición.
- **BPM en banda fisiológica extendida para forense**: 25–220 bpm (incluye bradicardias profundas de hipotermia/agonía). Actualmente está en 30–200 implícito.
- **Confianza mínima absoluta** (`bpmConfidence ≥ 0.30` con al menos 4 latidos validados morfológicamente) antes de mostrar el número. Si no la alcanza → muestro "BUSCANDO PULSO…" (no un número fantasma).
- **Indicador binario explícito** `pulseDetected: boolean` + `pulseConfidence: 'HIGH'|'MEDIUM'|'LOW'|'NONE'` expuesto al UI.

### C) `Index.tsx` — UI Forense honesta

1. **Eliminar de la UI principal** los `<VitalSign>` de SpO₂, presión, glucosa, lípidos. Sustituirlos por:
   - **Card grande**: `PULSO DETECTADO / SIN PULSO` con código de color (verde/rojo) y nivel de confianza.
   - **BPM** grande + intervalo de confianza.
   - **Índice de Perfusión** numérico (útil clínicamente, esto SÍ es real).
   - **Forma de onda PPG cruda** (`PPGSignalMeter`) — el forense puede inspeccionarla visualmente.
   - **Tiempo sin pulso** (cronómetro) — útil forense.
2. **Eliminar el motion gate destructivo** (`motionGated` con `MOTION_GATE_THRESH = 1.6`). En vez de suspender extracción, lo bajo a una penalización suave de SQI. El forense puede mover el teléfono mientras examina al sujeto.
3. **Eliminar el `pressureState === 'HIGH_PRESSURE'` como bloqueante** — en escena forense la presión sobre el dedo del sujeto es impredecible.
4. **Eliminar `STABLE_CONTACT` como gate**: tan pronto haya `OPTICAL_CONTACT_*`, la app procesa y reporta. Sin contadores de 40 frames esperando estabilidad.
5. **Eliminar la lógica de `lastValidResults`** que recuerda y reescupe valores pasados aunque no haya señal.
6. **Eliminar `applyEMA` para BPM** — en forense se necesita la respuesta real, no un promedio amortiguado de 5 lecturas.
7. **Eliminar el modo de calibración obligatorio de 3s** — empieza a reportar pulso desde el primer latido validado.
8. **Eliminar la sesión obligatoria de 60s** — modo continuo hasta que el usuario decida parar.

### D) `VitalSignsProcessor` — Encapsular y desconectar de la UI principal

- En modo forense (default), el procesador de vitales NO se invoca.
- El procesador se conserva intacto detrás de `?civil=1` con etiqueta visible `ESTIMACIÓN NO CLÍNICA — REQUIERE CALIBRACIÓN` para el modo civil opcional.

### E) Banner forense honesto

En la pantalla principal, banner pequeño permanente:
> **MODO FORENSE — Detector de pulso por PPG. Validez: presencia de pulso cardíaco y BPM. NO mide oxigenación, presión, glucosa ni lípidos.**

---

## Lo que NO voy a hacer (y por qué)

- **No voy a "garantizar grado forense legal"**: la app es una herramienta de tamizaje y de inspección visual de onda PPG. La declaración legal de muerte la hace el médico forense con criterios clínicos (rigidez, livideces, ECG, etc.). Lo que sí garantizo: detección **honesta y verificable** de presencia/ausencia de pulso PPG con confianza explícita, sin falsos positivos por ruido de cámara.
- **No voy a inventar SpO₂/presión/glucosa/lípidos** desde la cámara sin calibración — eso es exactamente la "farsa" que estás denunciando.

---

## Archivos que voy a tocar

- **`src/modules/signal-processing/PPGSignalProcessor.ts`** — detector de dedo de 3 estados, gate de liveness óptico, eliminación de motion gate destructivo.
- **`src/modules/signal-processing/OpticalLivenessVerifier.ts`** *(nuevo)* — verificador de firma de hemoglobina sostenida.
- **`src/modules/HeartBeatProcessor.ts`** — gate de morfología obligatorio para reportar BPM, banda 25–220, `pulseDetected` + `pulseConfidence`.
- **`src/types/beat.ts`** — añadir `pulseDetected`, `pulseConfidence` al `HeartBeatResult`.
- **`src/types/signal.d.ts`** — añadir `'NO_OPTICAL_CONTACT' | 'OPTICAL_CONTACT_LOW_PERFUSION' | 'OPTICAL_CONTACT_GOOD_PERFUSION'` al `ContactState`.
- **`src/pages/Index.tsx`** — UI forense, quitar VitalSigns de la UI principal, quitar EMA de BPM, quitar timer de 60s, quitar calibración 3s, quitar gates excesivos.
- **`src/components/ForensicPulsePanel.tsx`** *(nuevo)* — card "PULSO DETECTADO / SIN PULSO" + BPM + PI + cronómetro.
- **`src/hooks/useHeartBeatProcessor.ts`** — exponer `pulseDetected` y `pulseConfidence`.

## Lo que NO toco
- Cámara (`CameraView.tsx`): ya está bien — selección de cámara trasera, torch, locks de exposición/ISO/WB/focus. Solo confirmo que sigue funcionando.
- `SampleRateEstimator`, `FiducialDelineator`, `SignalSourceRanker`, `AdaptiveROIMask`: la base técnica ya implementada se mantiene y se aprovecha al 100%.
- Tests existentes: se mantienen verdes.

---

## Resultado esperado

Después de aplicar:

- Apuntar al aire / a una mesa / a una luz → **`SIN PULSO — SIN CONTACTO ÓPTICO`**, cero números, cero ondas falsas.
- Dedo de persona viva normal → pulso detectado en < 3 segundos, BPM real, onda visible.
- Dedo de persona con baja perfusión (hipotermia, shock, herida grave) → si hay pulso por mínimo que sea, lo detecta y reporta con confianza `LOW` o `MEDIUM` y muestra la onda; el forense decide.
- Sin pulso en sujeto → `SIN PULSO` sostenido, cronómetro de tiempo sin pulso visible.
- **Cero SpO₂/presión/glucosa/lípidos** en la UI por defecto. Cero farsa.

Aprobá el plan y lo implemento en una sola pasada limpia, eliminando código obsoleto y bloqueos sobrantes.
