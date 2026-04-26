
# Plan: Triple Gate Antifarsa + Modo Forense Puro

## Diagnóstico exacto de por qué la app sigue mostrando datos del aire

He auditado el pipeline completo después de los cambios anteriores. El gate de liveness por hemoglobina **ya existe** en `PPGSignalProcessor.ts` (líneas 25–33, 214–260), y la UI **ya zerea** SpO₂/BP/glucosa cuando el contacto óptico falla. **Pero hay tres fugas reales** que explican por qué seguís viendo ondas y BPM del aire:

### Fuga #1 — El umbral `R/(G+B) ≥ 1.05` es demasiado laxo
Con flash blanco encendido apuntando a una **superficie clara cualquiera** (mano humana sin tocar, pared, papel, mesa pulida, hasta el reflejo del propio teléfono en una superficie), el canal rojo se eleva por sobre G+B fácilmente porque la pantalla/flash blancos saturan el sensor con un sesgo natural hacia el rojo. **1.05 lo pasa cualquier cosa con flash.**

### Fuga #2 — El BPM se reporta con `bpmConfidence ≥ 0.12`
En `useHeartBeatProcessor.ts` línea 152: cualquier hipótesis de autocorrelación con confianza ≥ 12% pinta un número. La autocorrelación encuentra periodicidad incluso en el ruido de auto-exposición (típicamente 1–3 Hz) o en micro-vibraciones del operador. **0.12 es ruido.**

### Fuga #3 — No hay validación de banda cardíaca real
El `BandpassFilter` (0.5–4 Hz) **es generador de sinusoides** ante cualquier ruido de banda ancha. La única forma física de confirmar pulso es exigir que la **potencia espectral concentrada en 0.7–4 Hz supere por ≥ 6 dB la potencia fuera de banda**. Esto hoy no se verifica en ningún lado.

---

## La solución — TRIPLE GATE FÍSICO obligatorio

Para que aparezca **un solo número de BPM o un solo píxel de onda**, los tres gates deben pasar simultáneamente. Si cualquiera falla → cero salida, sin excepciones.

### GATE 1 — Firma óptica de hemoglobina endurecida + textura espacial
**Archivo: `PPGSignalProcessor.ts`**

Reemplazo los umbrales actuales por una verificación multi-criterio mucho más severa:

| Criterio | Umbral actual | Umbral nuevo (forense) |
|---|---|---|
| `R/(G+B)` | `≥ 1.05` | `≥ 1.35` (sangre absorbe G+B mucho más fuerte; piel/objeto NO llega a 1.35) |
| `R - (G+B)/2` | `≥ 6` | `≥ 18` (en unidades 0–255) |
| Brillo total | `[70, 740]` | `[180, 700]` (descarta penumbra y blow-out) |
| Coverage | `≥ 0.12` | `≥ 0.35` (el dedo cubre ≥ 35% del frame, no es luz colateral) |
| **NUEVO** Textura espacial | — | **`stdR_intratile / meanR ∈ [0.008, 0.06]`** (un dedo tiene micro-textura subdérmica; el aire/objeto liso da std≈0; el reflejo violento da std>0.06) |
| **NUEVO** Estabilidad temporal | — | **EWMA(R) sostenida 8 frames**, no transitoria (anti-parpadeo) |
| Confirmación | 4 frames | **12 frames (~400ms)** |
| Liberación | 8 frames | **6 frames (~200ms)** — fácil soltar, difícil entrar |

→ El aire, una pared, un dedo flotando sin presión, una luz, un papel, una mesa **NO PASAN**.

### GATE 2 — Pulsatilidad espectral en banda cardíaca
**Archivo nuevo: `src/modules/signal-processing/CardiacBandVerifier.ts`**

Sobre los últimos 6 segundos del canal rojo crudo (sin pasabanda), calculo:
- Potencia espectral en banda cardíaca **`P_in = ∑ |X(f)|² para f ∈ [0.7, 4.0] Hz`** (Goertzel sobre 32 frecuencias, eficiente, sin FFT completa).
- Potencia fuera de banda **`P_out = ∑ |X(f)|² para f ∈ [0.05, 0.5] ∪ [5, 8] Hz`**.
- **SNR cardíaca = 10·log₁₀(P_in / P_out)`**.
- Pico dominante **`f_peak`** dentro de banda + ancho de pico (energía concentrada).

**Output gates pasan solo si:**
- `SNR ≥ 6 dB` sostenida 1.5 s.
- `f_peak ∈ [0.7, 3.5] Hz` (42–210 BPM, banda fisiológica forense extendida).
- **Concentración espectral**: ≥ 60% de `P_in` está en una ventana de ±0.3 Hz alrededor de `f_peak` (un latido real es estrecho; el ruido es ancho).
- **Estabilidad de `f_peak`**: cambio < 0.4 Hz entre dos ventanas consecutivas (un latido real no salta de 60 a 180 BPM en 1.5s).

### GATE 3 — Validación morfológica fiducial de los últimos latidos
**Archivo: `HeartBeatProcessor.ts` + `useHeartBeatProcessor.ts`**

Aprovecho el `FiducialDelineator` ya presente. **Solo se reporta BPM si los últimos 4 latidos consecutivos cumplen TODOS:**
- `morphologyValidity ≥ 0.55` (el detector ya lo expone).
- `riseTimeMs ∈ [60, 350]` (subida sistólica plausible).
- Pendiente sistólica positiva clara y pendiente diastólica negativa identificable.
- IBI ∈ [285ms, 1430ms] (banda 42–210 BPM, consistente con Gate 2).
- Coeficiente de variación de los últimos 4 IBI < 0.35 (anti-ruido aleatorio).

Subo `bpmConfidence` mínimo de **0.12 → 0.45**.

---

## Salida unificada — la API forense

Expongo desde `PPGSignalProcessor` un nuevo objeto en cada `ProcessedSignal`:

```typescript
forensicGate: {
  gate1_optical: boolean;     // firma hemoglobina + textura
  gate2_spectral: boolean;    // SNR cardíaca ≥ 6 dB
  gate3_morphology: boolean;  // 4 latidos morfológicamente válidos
  passAll: boolean;           // AND de los tres
  cardiacSNRdB: number;
  spectralPeakHz: number;
  livenessReason: string;     // mensaje técnico para UI
}
```

**Regla absoluta en `Index.tsx`:**
- Si `passAll === false` → `heartbeatSignal=0`, `heartRate=0`, `rrIntervals=[]`, **onda PPG en cero plano** (no se dibuja sinusoide).
- El `PPGSignalMeter` recibe explícitamente `value=0` cuando los gates no pasan.
- Nunca se ejecuta `processHeartBeat` si gate1+gate2 no pasan (corte aguas arriba, no solo en UI).

---

## Eliminación total de vitales no medibles

Voy a **borrar del repo y de la UI**:
- `useVitalSignsProcessor` ya no se invoca desde `Index.tsx`.
- Componente `<VitalSign>` solo se usa para FC (queda) — el resto se elimina del JSX.
- El bloque `CIVIL_MODE` y todas las cards de SpO₂/presión/glucosa/lípidos se eliminan.
- El estado `vitalSigns` se reduce a `{ arrhythmiaCount, arrhythmiaStatus, signalQuality, measurementConfidence }`.
- El flag `?civil=1` se retira (era una puerta trasera al engaño).
- Los módulos `SpO2Processor`, `BloodPressureProcessor`, `GlucoseResearchProcessor`, `LipidResearchProcessor` quedan en disco pero **desconectados del pipeline** (no se importan desde el árbol activo) — preserva el trabajo histórico sin contaminar el producto. Si querés que los borre físicamente, me lo decís y los elimino.

---

## UI Forense definitiva (pantalla principal)

Tres bloques únicos, en orden:

1. **Banner permanente**:
   > `MODO FORENSE — DETECTOR DE PULSO PPG. NO MIDE OXIGENACIÓN, PRESIÓN, GLUCOSA NI LÍPIDOS.`

2. **Card "PULSO" central** (grande, alto contraste):
   - Estado: `● PULSO DETECTADO` (verde, glow) / `○ SIN PULSO` (rojo) / `… BUSCANDO PULSO` (ámbar, durante warmup de gates).
   - **BPM** grande + confianza textual (`ALTA / MEDIA / BAJA`).
   - **Tiempo sin pulso** (cronómetro) — útil forense.
   - **Razón técnica** cuando no hay pulso: "SIN CONTACTO ÓPTICO" / "SIN PULSATILIDAD CARDÍACA" / "MORFOLOGÍA NO VÁLIDA".

3. **Onda PPG cruda** (`PPGSignalMeter`) — solo se anima cuando `passAll === true`. Si no, línea base plana en cero, no sinusoides falsas.

4. **Diagnóstico técnico colapsable** (debajo, opcional para el operador): SNR cardíaca dB, pico Hz, índice de perfusión, calidad de señal, frame rate real.

---

## Qué se elimina de bloqueos excesivos (vía libre operativa)

- Sin sesión obligatoria de 60 s — monitoreo continuo hasta detener.
- Sin calibración previa de 3 s — los gates son auto-validantes en cuanto se cumplen.
- Sin EMA suavizando el BPM — respuesta real instantánea.
- Sin `motionGated` destructivo — el movimiento solo penaliza SQI, no bloquea.
- Sin `STABLE_CONTACT` como pre-requisito — `OPTICAL_CONTACT_LOW_PERFUSION` es suficiente para procesar.
- Sin `pressureState === HIGH_PRESSURE` como bloqueo — solo penaliza SQI.

El operador forense puede apuntar la cámara al dedo en cualquier condición; **lo único que decide si hay output es la física verificada por los tres gates**, no temporizadores ni umbrales arbitrarios.

---

## Lo que NO voy a tocar (preservar lo bueno)

- `CameraView.tsx` y locks de cámara (exposición, ISO, WB, focus, torch) — ya está sólido.
- `SampleRateEstimator`, `FiducialDelineator`, `SignalSourceRanker`, `AdaptiveROIMask` — base técnica que se aprovecha al 100%.
- Tests existentes — se mantienen verdes, agrego nuevos para los gates.
- Auth y persistencia Supabase — sin cambios.

---

## Archivos que voy a tocar

| Archivo | Cambio |
|---|---|
| `src/modules/signal-processing/PPGSignalProcessor.ts` | Endurecer LIVENESS (Gate 1), integrar CardiacBandVerifier (Gate 2), exponer `forensicGate` en `ProcessedSignal` |
| `src/modules/signal-processing/CardiacBandVerifier.ts` *(nuevo)* | Goertzel SNR cardíaca + concentración + estabilidad de pico |
| `src/modules/signal-processing/__tests__/CardiacBandVerifier.test.ts` *(nuevo)* | Tests con señales sintéticas (pulso real, ruido blanco, parpadeo, sinusoide pura) |
| `src/modules/HeartBeatProcessor.ts` | Gate 3 morfología obligatorio, `bpmConfidence` mínimo 0.45, banda 42–210 BPM |
| `src/types/beat.ts` | Agregar `pulseDetected`, `pulseConfidence` al resultado |
| `src/types/signal.d.ts` | Agregar `forensicGate` al `ProcessedSignal` |
| `src/hooks/useHeartBeatProcessor.ts` | Subir umbral, exponer `pulseDetected`/`pulseConfidence` |
| `src/pages/Index.tsx` | UI forense pura, eliminar `useVitalSignsProcessor`, eliminar bloque CIVIL, eliminar timer 60s y calibración 3s, gating duro en cero cuando `!passAll` |
| `src/components/ForensicPulsePanel.tsx` *(nuevo)* | Card de pulso + cronómetro + razón técnica |
| `src/components/PPGSignalMeter.tsx` | Forzar línea base plana cuando `value=0` (anti-sinusoide-fantasma) |

---

## Resultado esperado y verificable

| Escenario | Resultado |
|---|---|
| Apuntar al aire / pared / mesa / luz | `SIN PULSO — SIN CONTACTO ÓPTICO`. Cero onda. Cero BPM. **No hay manera física de pasar Gate 1.** |
| Dedo flotando sin tocar el lente | `SIN PULSO — SIN CONTACTO ÓPTICO` (coverage < 35%). |
| Dedo apoyado pero sin flujo (post-mortem, torniquete) | Gate 1 pasa, Gate 2 falla → `SIN PULSO — SIN PULSATILIDAD CARDÍACA`. Cero BPM. Onda plana. |
| Dedo de persona viva con perfusión normal | Pulso detectado en < 4 segundos, BPM real, onda visible, confianza ALTA. |
| Dedo de persona viva con baja perfusión (shock, hipotermia) | Si hay aunque sea un pulso débil con SNR ≥ 6 dB y morfología válida → reportado con confianza MEDIA/BAJA y onda visible. **No se bloquea por baja perfusión.** |
| Movimiento del operador | Penaliza SQI pero no bloquea — los gates físicos siguen decidiendo. |

Cero ondas del aire. Cero BPM del aire. Cero SpO₂/BP/glucosa/lípidos en pantalla. **Solo verdad física verificada.**

Aprobá el plan y lo implemento en una pasada limpia, eliminando todo el código obsoleto que actualmente permite las fugas.
