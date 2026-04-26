# Plan de hardening forense máximo

Basado en auditoría real del repo. Aplicado al pie de la letra, sin excepción.

## 1. AUDITORÍA — qué SE elimina y qué NO se toca

### Eliminar (valores fisiológicos simulados / defaults falsos)
- **`src/hooks/useHealthAnalysis.ts` líneas 37–40**:
  ```ts
  heartRate: heartRate || 70,
  spo2: vitalSigns.spo2 || 97,
  systolic: vitalSigns.pressure?.systolic || 120,
  diastolic: vitalSigns.pressure?.diastolic || 80,
  ```
  → Cambiar a envío `null`/`undefined` cuando no hay medición real. La Edge Function ya valida.
  → Bloquear el botón de análisis IA si `publicationGate=false` o vitales=0.

### NO tocar (no son simulaciones, descartado tras auditoría)
- `BandpassFilter.ts:89` `Math.sin(w0)` → coeficiente biquad legítimo de DSP.
- `PPGSignalMeter.tsx:366,619` `Math.sin(now/100)` → alpha de animación de alerta visual (pulso UI), NO señal fisiológica.
- `placeholder=` en `Auth.tsx`/`input.tsx` → atributo HTML estándar.
- `PressureProxyEstimator.ts`/`SignalQualityEstimator.ts` comentarios "no simulation" → reales.

## 2. NUEVO MÓDULO: `src/modules/signal-processing/OpticalEvidenceGate.ts`

Gate físico-óptico independiente, sin morfología de dedo. Acepta/rechaza por **frame** según criterios físicos cuantificables:

```ts
export type RejectionCode =
  | 'OK'
  | 'CLIPPING_HIGH'        // >5% píxeles ROI con R≥250
  | 'CLIPPING_LOW'         // >5% píxeles ROI con R≤5
  | 'INSUFFICIENT_AC'      // AC/DC < 0.0015 (umbral físico de pulsatilidad)
  | 'NO_HEMOGLOBIN'        // R/(G+B) < 1.20  (no hay tejido perfundido)
  | 'FLAT_TEXTURE'         // stdR/meanR < 0.003 (superficie plana / aire)
  | 'OVEREXPOSED'          // mean(R) > 245
  | 'UNDEREXPOSED'         // mean(R) < 25
  | 'PERFUSION_DROP';      // PI cae >70% en <500ms (despegue de dedo)

export interface OpticalEvidence {
  accept: boolean;
  reason: RejectionCode;
  metrics: { acDc:number; rOverGB:number; texture:number; clipHigh:number; clipLow:number; pi:number };
}

export class OpticalEvidenceGate {
  evaluate(roi: ROIStats, history: { piWindow: number[] }): OpticalEvidence;
}
```

**Diferencia clave vs Gate1 actual**: no exige "morfología de dedo" ni umbrales arbitrarios de cobertura. Solo física óptica → permite operar sobre tejido herido, dedo frío, baja perfusión, sin bloquear. Bloquea SOLO cuando físicamente no hay evidencia (aire, mesa, luz, saturación).

## 3. PIPELINE sRGB → LINEAL → OPTICAL DENSITY

Modificar `PPGSignalProcessor.ts`:

```ts
// Conversión sRGB→lineal por canal (Rec. 709 / IEC 61966-2-1)
function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

// Optical Density: -log10((I+ε)/I0) donde I0 = DC móvil
const linR = srgbToLinear(meanR);
const od   = -Math.log10((linR + 1e-6) / Math.max(dcMovingAvg, 1e-6));
```

OD se vuelve la **fuente primaria** del SignalSourceRanker (proporcional a absorbancia de hemoglobina). Las fuentes RGB crudas quedan como candidatas auxiliares.

## 4. BUFFER CIRCULAR DE 10s POR TIMESTAMPS REALES

`PPGSignalProcessor.ts`:
- Agregar `samplesByTime: { t:number, od:number, r:number, g:number, b:number }[]` con eviction por edad: descartar muestras `> 10000ms` del `frameTimestamp` actual.
- Sample rate efectivo se mide del span real `(tNow - tOldest) / N`, NO de un nominal 30fps.
- Si gap entre frames > 80ms → marcar `frameJitter=true` y degradar SQI.

## 5. GATING DURO DE UI / AUDIO / VIBRACIÓN

### `src/modules/HeartBeatProcessor.ts`
- Líneas 209–210: condicionar `this.vibrate()` y `this.playBeep()` a `accepted.publicationGate === true`. Añadir flag `setPublicationGate(pass: boolean)` que viene desde el hook.
- Línea 864: `vibrate()` retorna sin acción si `!publicationGate`.

### `src/pages/Index.tsx`
- Línea 1033: la vibración de arritmia solo si `forensicGate?.passAll && publicationGate`.
- Líneas 523, 586, 1062: vibraciones de inicio/fin/calibración → conservar (son UI feedback, no fisiológicas).
- Calcular `publicationGate = forensicGate?.passAll && opticalEvidence.accept && acceptedBeat`.

### `src/components/PPGSignalMeter.tsx`
- Añadir prop `publicationGate: boolean` y `rejectionReason: string`.
- Si `!publicationGate`: dibujar **línea base plana** (no la `value` recibida) y overlay del motivo exacto del rechazo (`reason` del OpticalEvidenceGate).
- El waveform solo refleja muestras donde `publicationGate=true` en el momento de su captura (marcar cada punto del CircularBuffer con flag `validated`).

## 6. MONITOR CARDÍACO PERFECCIONADO (representación 100% fiel)

`PPGSignalMeter.tsx`:
- Renderizar **señal filtrada validada** (no la cruda) con AGC adaptativo.
- Marcadores fiduciales completos por latido validado: pico sistólico, notch dicrótico, pico diastólico (ya extraídos por `FiducialDelineator`).
- Líneas verticales en cada `acceptedBeat` (no en cada peak candidato).
- Anotar IBI ms entre latidos consecutivos.
- Color por estado: validado=verde fosforescente, arritmia=rojo, no-publicable=gris transparente.
- Eje temporal escalado a sample rate **real** medido (no asumido).

## 7. UI: motivo exacto por frame cuando se rechaza

- `ForensicGateOverlay.tsx`: añadir línea "EVIDENCIA ÓPTICA: {reason}" con el código del `OpticalEvidenceGate` y los 6 metrics numéricos en vivo (acDc, rOverGB, texture, clipHigh, clipLow, PI).
- Cuando `!publicationGate`: barra superior roja "NO PUBLICAR — {reason}".

## 8. Verificación automatizada

Crear `scripts/audit-forensic.mjs`:
- Falla CI si encuentra `Math.random` en `src/modules/`.
- Falla CI si encuentra patrones `|| <número>` para BPM/SpO2/systolic/diastolic.
- Falla CI si `playBeep`/`navigator.vibrate` aparece sin guard `publicationGate`.

## 9. Archivos modificados

- **NUEVO** `src/modules/signal-processing/OpticalEvidenceGate.ts`
- `src/modules/signal-processing/PPGSignalProcessor.ts` (sRGB→lineal→OD, buffer 10s real, integración del gate)
- `src/modules/HeartBeatProcessor.ts` (gating audio+vibración)
- `src/hooks/useHeartBeatProcessor.ts` (propagar publicationGate)
- `src/hooks/useSignalProcessor.ts` (exponer opticalEvidence)
- `src/hooks/useHealthAnalysis.ts` (eliminar defaults 70/97/120/80)
- `src/pages/Index.tsx` (calcular publicationGate, pasarlo a UI, gating de alertas)
- `src/components/PPGSignalMeter.tsx` (prop publicationGate, render plana si false, fiduciales completos)
- `src/components/ForensicGateOverlay.tsx` (mostrar reason + métricas físicas)
- **NUEVO** `scripts/audit-forensic.mjs`
- `src/types/signal.d.ts` (tipos OpticalEvidence, publicationGate)

## 10. Resultado garantizado

- Aire/mesa/luz/objeto → `OpticalEvidence.accept=false` con razón física exacta visible. Onda plana, BPM `--`, sin beep, sin vibración, sin SpO2/BP/glucosa/lípidos, sin envío a IA.
- Dedo vivo con baja perfusión (herido, frío, shock) → puede pasar Gate1 óptico pero Gate2/3 deciden si publicar BPM. No se bloquea por "morfología de dedo".
- Pulso PPG real → los 3 gates + opticalEvidence todos en true → onda fiel filtrada con fiduciales completos, BPM real, beep+vibración solo en latidos validados, exportable.
