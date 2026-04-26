# Auditoría Forense del Repositorio — Archivo por Archivo

## Evidencia de revisión

Inventario completo: **133 archivos** en el repo (excluyendo `node_modules`, `.git`, `dist`).
De esos: **92 archivos fuente/config** + 2 migraciones SQL + lockfiles + assets.

He auditado cada archivo `.ts/.tsx/.js/.json/.md/.css/.html/.toml/.yml` con tres pasadas:

1. **Búsqueda de patrones obsoletos** (`deprecated|legacy|obsolete|TODO|FIXME|HACK|mock|fake|simulate`) en todo `src/`, `scripts/`, `supabase/`. Resultado: solo 3 menciones de "legacy" en `Index.tsx` (comentarios descriptivos, no código muerto).
2. **Forensic audit existente** (`scripts/audit-forensic.mjs` + `src/test/forensic-audit.test.ts`) — el repo ya está blindado contra `Math.random`, defaults fisiológicos, `mock/fake/synthetic`, etc. **0 violaciones activas** fuera de allowlist documentada.
3. **Detección de archivos huérfanos** — para cada archivo fuente busqué su nombre como import en el resto del repo. Resultado: **8 archivos sin un solo import**.

## Hallazgos — Archivos huérfanos confirmados (BASURA, eliminar)

| # | Archivo | LOC | Razón |
|---|---|---|---|
| 1 | `src/pages/Auth.tsx` | 109 | Página de login/registro Supabase nunca enrutada (`App.tsx` solo monta `/` → `Index` y `*` → `NotFound`). Importa `useToast` que tampoco se usa. |
| 2 | `src/components/CameraPreview.tsx` | 73 | Componente de preview alternativo. El sistema usa `CameraView.tsx`. Cero imports. |
| 3 | `src/components/MonitorButton.tsx` | 30 | Botón obsoleto. Cero imports. |
| 4 | `src/components/ui/card.tsx` | 79 | Componente shadcn/ui no usado por ninguna pantalla. |
| 5 | `src/components/ui/sonner.tsx` | 29 | Toaster alternativo (sonner). El proyecto usa `@/hooks/use-toast` (radix). Cero imports. |
| 6 | `src/components/ui/toaster.tsx` | 33 | Toaster radix nunca montado en `App.tsx`. Cero imports. |
| 7 | `src/components/ui/use-toast.ts` | 5 | Re-export trivial de `@/hooks/use-toast`. Solo `Index.tsx` lo importa **y se puede redirigir** al hook real, eliminando el shim. |
| 8 | `src/utils/qualityUtils.ts` | 44 | Util de calidad legacy. La calidad real vive en `SignalQualityEstimator.ts` + `qualityUtils` no aparece en ningún import. |

**Total a eliminar: ~402 LOC de código muerto.**

## Hallazgos — Sin basura detectada

Los **84 archivos restantes** están todos referenciados y pertenecen al pipeline forense activo:

- **Pipeline DSP** (`src/modules/signal-processing/*` — 12 archivos): todos importados por `PPGSignalProcessor.ts` o tests.
- **Vital signs** (`src/modules/vital-signs/*` — 6 archivos): orquestados por `VitalSignsProcessor.ts`.
- **Biomarkers research** (`GlucoseResearchProcessor`, `LipidResearchProcessor`): usados por `VitalSignsProcessor`.
- **Hooks** (`useSignalProcessor`, `useVitalSignsProcessor`, `useHeartBeatProcessor`, `useHealthAnalysis`, `useSaveMeasurement`, `use-toast`): todos consumidos por `Index.tsx` o entre sí.
- **UI** (`PPGSignalMeter`, `VitalSign`, `CameraView`, `ForensicGateOverlay`, `FiducialTuner`, `SRDiagnostics`, `ui/button`, `ui/input`, `ui/toast`): todos montados en `Index.tsx`.
- **Tests** (4 archivos): `forensic-audit`, `srDiagnosticsState`, `PPGSignalProcessor.gates`, `SampleRateEstimator` — todos en suite vitest activa.
- **Configs** (`vite`, `vitest`, `tailwind`, `tsconfig*`, `eslint`, `postcss`, `components.json`): necesarios para build.
- **Supabase** (`client.ts`, `types.ts`, `config.toml`, edge function `analyze-vitals`, 2 migraciones): backend activo.

## Acciones a ejecutar

1. **Eliminar 8 archivos huérfanos** listados arriba.
2. **Reemplazar 1 import** en `src/pages/Index.tsx`:
   - `from "@/components/ui/use-toast"` → `from "@/hooks/use-toast"` (elimina el shim sin romper nada).
3. **Verificación post-cleanup**:
   - `bun run build` → debe compilar sin errores.
   - `node scripts/audit-forensic.mjs` → debe seguir verde.
   - `bunx vitest run` → los 33 tests deben seguir pasando.
   - Re-ejecutar el detector de huérfanos para confirmar 0 archivos sin import.

## Lo que NO voy a tocar (justificación forense)

- **`HeartBeatProcessor.ts`, `PPGSignalProcessor.ts`, `OpticalEvidenceGate.ts`, etc.**: núcleo del pipeline ya endurecido en mensajes previos.
- **Comentarios "legacy" en `Index.tsx`**: son notas descriptivas sobre estructura UI, no código muerto.
- **`docs/medical-validation.md`, `README.md`, `.workspace/AGENTS.md`**: documentación viva.
- **Migraciones SQL**: historial inmutable de Supabase.
- **`bun.lockb`, `package-lock.json`**: lockfiles necesarios.

## Resultado esperado

- Repo pasa de 92 → 84 archivos fuente útiles.
- –402 LOC de código muerto.
- Sin pérdida funcional (los 8 archivos no se usan en runtime ni en tests).
- Forensic audit y suite de tests siguen verdes.
