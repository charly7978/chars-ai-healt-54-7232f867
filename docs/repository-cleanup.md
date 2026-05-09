# Auditoría de Depuración del Repositorio

**Fecha:** 2026-05-09
**Objetivo:** repositorio sin archivos huérfanos, código duplicado ni APIs obsoletas.

## Archivos eliminados

| Archivo | Motivo |
|---|---|
| `src/components/CameraPreview.tsx` | Componente obsoleto, reemplazado por `CameraView.tsx`. Cero importadores. |
| `src/components/MonitorButton.tsx` | Botón legacy no usado en ningún lado. |
| `src/utils/qualityUtils.ts` | Utilidad sin importadores; lógica de calidad vive en `PPGSignalProcessor`. |
| `src/lib/ppg/**` (12 archivos) | Librería duplicada de la lógica ya implementada en `PPGSignalProcessor` / `BandpassFilter`. Sin cablear. |
| API `setArrhythmiaState` (no-op) en `useHeartBeatProcessor` | Era función vacía; las arritmias se gestionan en `ArrhythmiaProcessor`. Eliminadas también las 3 llamadas en `Index.tsx`. |

## Mapa de dependencias actual (limpio)

```
CameraView (MediaStream + torch)
   │ requestVideoFrameCallback
   ▼
useSignalProcessor → PPGSignalProcessor
   │   • extractROI (5×5 tiles, exclusión de saturados)
   │   • multi-source (R / G / RG)
   │   • BandpassFilter (Butterworth 0.3–5 Hz IIR)
   │   • SQI unificado, perfusion index, contact state
   ▼
ProcessedSignal
   │
   ├─► useHeartBeatProcessor → HeartBeatProcessor (peak detection, BPM)
   │
   └─► useVitalSignsProcessor → VitalSignsProcessor
           ├─ SpO2 (R/G ratio)
           ├─ BloodPressureProcessor (PWA + 74 features)
           ├─ PPGFeatureExtractor (cycles, RR variability)
           └─ ArrhythmiaProcessor (RR intervals)
   ▼
Index.tsx (UI)
   ├─► PPGSignalMeter (oscilloscope canvas, full-screen)
   ├─► VitalSign × N (con `--` cuando valor = 0)
   └─► useSaveMeasurement (Supabase persist al finalizar 60s)
```

## Verificación tras limpieza

- `rg "CameraPreview|MonitorButton|qualityUtils|lib/ppg|setArrhythmiaState"` → **0 referencias** en `src/`.
- Build TypeScript sin errores.
- Cada archivo restante en `src/` está importado por al menos otro archivo (excepto `App.tsx` y `main.tsx` que son entry-points, y los `.d.ts` que son ambient types).

## Inventario final (38 archivos `.ts/.tsx`)

- **Páginas:** `Index.tsx`, `Auth.tsx`, `NotFound.tsx`
- **Componentes:** `CameraView`, `PPGSignalMeter`, `VitalSign` + UI primitives (button, card, input, toast, sonner, toaster)
- **Hooks:** `useSignalProcessor`, `useHeartBeatProcessor`, `useVitalSignsProcessor`, `useHealthAnalysis`, `useSaveMeasurement`, `use-toast`
- **Módulos signal-processing:** `PPGSignalProcessor`, `BandpassFilter`
- **Módulos vital-signs:** `VitalSignsProcessor`, `BloodPressureProcessor`, `PPGFeatureExtractor`, `arrhythmia-processor`
- **Módulos:** `HeartBeatProcessor`
- **Utils:** `arrhythmiaUtils`, `soundUtils`, `CircularBuffer`, `lib/utils`
- **Tipos:** `signal.d.ts`, `media-stream.d.ts`, `screen-orientation.d.ts`, `vite-env.d.ts`
- **Integración:** `supabase/client.ts`, `supabase/types.ts`

No queda código duplicado, obsoleto, ni APIs no-op. El cableado es lineal y unidireccional.
