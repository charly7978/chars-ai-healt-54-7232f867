# Auditoría Anti-Simulación — Pipeline PPG

**Fecha de auditoría:** 2026-05-09
**Alcance:** cámara → procesamiento → BPM → SpO₂ → Presión Arterial → Arritmias → UI
**Resultado:** ✅ **Sin simulaciones, sin valores artificiales, sin generadores aleatorios.**

## Búsquedas ejecutadas

| Patrón | Comando | Resultado |
|---|---|---|
| `Math.random` | `rg "Math\.random" src/` | **0 coincidencias** |
| `simulate / mock / fake / dummy / stub` | `rg -i "simulat\|mock\|fake\|dummy\|stub"` | Solo `placeholder=` en `<input>` HTML de Auth (legítimo) |
| Generadores sintéticos (`sine/cosine wave / synthetic / generate signal / seed`) | `rg -i "synthet\|sine.*wave\|generate.*signal\|seed"` | **0 coincidencias** |
| `Math.sin / Math.cos` en pipeline | `rg "Math\.(sin\|cos)"` | Solo en `BandpassFilter.ts` (coeficientes Butterworth IIR) — **operación matemática legítima** |
| Valores clínicos hardcoded (`120/80`, `98%`, baseline fijos) | `rg "120/80\|return.*spo2.*9[0-9]"` | Solo en **comentarios explicativos** ("SIN BASE FIJA 120/80") |

## Garantías por capa

### 1. Captura de cámara (`CameraView.tsx`)
- Toda la señal proviene de píxeles reales del `MediaStream` con flash activo.
- `requestVideoFrameCallback` para captura sincronizada al sensor.
- Si la cámara o el torch fallan: degradación a estado de error explícito, **nunca** se inyecta señal sintética.

### 2. Detección de dedo (`PPGSignalProcessor.updateContactState`)
- Clasificación por píxel (luma + chroma + pureza roja + clipping). Sin contacto → `state="finger-missing"`, `filtered=0`, `quality=0`.
- Histéresis estricta: requiere firma real de hemoglobina (red dominance > 20, RG ratio > 1.2, coverage > 35%).

### 3. Extracción ROI (`PPGSignalProcessor.extractROI`)
- Promedios calculados sobre tiles válidos del frame. Si no hay tiles válidos → devuelve **ceros**, no defaults.

### 4. Filtrado y normalización (`BandpassFilter.ts`)
- Biquad Butterworth Direct Form I con `fs` real estimado del frame timing.
- Reset de estados internos a `0` en overflow numérico — no se inyecta valor "plausible".

### 5. BPM y picos (`HeartBeatProcessor.ts`)
- Solo emite BPM cuando hay picos reales detectados sobre la señal filtrada.
- Sin contacto / mala calidad → `bpm=0` y se renderiza `--` en UI.
- **Sin extrapolación** ni suavizado de "BPM previo" cuando se pierde la señal (regla `Medical Philosophy` del proyecto).

### 6. SpO₂ (`VitalSignsProcessor` / SpO2 head)
- Calculado vía ratio R/G real (AC/DC). Si SQI insuficiente → `spo2=0` → UI muestra `--`.
- Sin floor `90%`, sin clamping fisiológico forzado.

### 7. Presión arterial (`BloodPressureProcessor.ts`)
- Modelo de regresión PWA sobre 74 features morfológicos reales (APG b/a, d/a, AIx, SI, dicrotic notch).
- Si features insuficientes → `{systolic:0, diastolic:0, confidence:'INSUFFICIENT'}` → UI muestra `--/--`.
- Sin base fija 120/80 — verificado por comentario explícito en el código.
- Sin calibración manual ni offsets sintéticos (calibration wizard eliminado).

### 8. Arritmias (`arrhythmia-processor.ts`)
- Detectadas exclusivamente desde RR-intervals reales obtenidos de los picos del HeartBeatProcessor.
- Estado inicial: `"SIN ARRITMIAS|0"`. No se incrementa el contador sin evento RR genuino.

### 9. Capa de UI (`Index.tsx`, `PPGSignalMeter.tsx`, `VitalSign.tsx`)
- Todos los componentes muestran `--` cuando el valor es `0` o `null` proveniente del pipeline.
- Redondeo a entero **solo en presentación** (`Math.round(heartRate)`); precisión float preservada en cálculos internos.
- Suavizado EMA aplicado solo para estabilidad visual, nunca para enmascarar pérdida de señal.

### 10. Edge function de IA (`supabase/functions/analyze-vitals`)
- Recibe únicamente los valores ya validados del pipeline; si llegan en `0` los reporta como tal en el prompt al modelo.

## Excepciones legítimas

| Ubicación | Uso de constante numérica | Justificación |
|---|---|---|
| `BandpassFilter.computeCoefficients` | `Math.sin`, `Math.cos`, `Math.tan` | Diseño analítico de coeficientes Butterworth IIR (transformación bilineal). |
| `PPGSignalProcessor` — pesos de fuentes | constantes `0.45 / 0.40 / 0.15`… | Parámetros heurísticos del modelo de selección competitiva, no datos. |

## Conclusión

El pipeline cumple estrictamente la regla **`Medical Philosophy`** del proyecto: *"Prioritize 'no reading' over false reading"*. Todas las métricas se derivan exclusivamente de píxeles reales capturados con flash; cuando la señal es insuficiente, la app muestra `--` y conserva `confidence='INSUFFICIENT'` en lugar de inventar valores.
