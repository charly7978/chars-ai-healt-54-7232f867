# Dependency Audit — Anti-Simulation

**Date:** 2026-05-09
**Scope:** All runtime and dev dependencies in `package.json`.
**Question:** ¿Alguna librería puede inyectar señales sintéticas, valores aleatorios "plausibles" o datos por defecto en el pipeline PPG?
**Result:** ✅ **Ninguna dependencia genera señales sintéticas en el pipeline médico.**

## Metodología

1. Inventario completo de `dependencies` y `devDependencies`.
2. Clasificación por categoría (UI, routing, backend client, build).
3. Verificación de que ninguna toca el camino crítico cámara → PPG → vitales.
4. Búsqueda en `src/` de `Math.random`, `mock`, `fake`, `dummy`, `synthetic`, `simulate` (resultado: 0 coincidencias en código de producción — ver `scripts/check-no-simulation.mjs`).

## Inventario y veredicto

### Runtime (`dependencies`)

| Paquete | Categoría | Toca pipeline PPG | Riesgo de simulación | Notas |
|---|---|---|---|---|
| `react`, `react-dom` | UI runtime | No | ✅ Ninguno | Solo render. |
| `react-router-dom` | Routing | No | ✅ Ninguno | |
| `@radix-ui/react-slot`, `@radix-ui/react-toast` | UI primitives | No | ✅ Ninguno | |
| `lucide-react` | Iconos SVG | No | ✅ Ninguno | Estático. |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate` | Styling | No | ✅ Ninguno | |
| `next-themes` | Theme switcher | No | ✅ Ninguno | |
| `sonner` | Toasts | No | ✅ Ninguno | |
| `@tanstack/react-query` | Cache de fetch | No (no se usa para signos vitales) | ✅ Ninguno | No produce datos por defecto. |
| `@supabase/supabase-js` | Backend client | Solo persistencia post-medición | ✅ Ninguno | No fabrica vitales; solo lee/escribe. |

### Build / dev (`devDependencies`)

| Paquete | Categoría | Riesgo |
|---|---|---|
| `vite`, `@vitejs/plugin-react-swc`, `lovable-tagger` | Build tooling | ✅ Ninguno (no entra al bundle de runtime médico). |
| `typescript`, `@types/*`, `eslint*`, `globals`, `typescript-eslint` | Tipado / lint | ✅ Ninguno. |
| `tailwindcss`, `postcss`, `autoprefixer` | CSS | ✅ Ninguno. |
| `vitest`, `@vitest/ui`, `jsdom` | Testing | ✅ Ninguno (excluido por el guardrail). |
| `@types/node` | Tipos | ✅ Ninguno. |

## Lo que **NO** está instalado (intencional)

Para mantener el pipeline puramente determinista a partir de píxeles reales, el proyecto **rechaza** las siguientes categorías:

- ❌ Generadores de datos: `faker`, `@faker-js/faker`, `chance`, `casual`.
- ❌ Mocks de red/datos: `msw`, `nock`, `sinon`, `jest-mock-extended`.
- ❌ Síntesis de señal/audio: `tone`, `osc-js`, `wavefile` (lectura sintetizada).
- ❌ Pseudo-random "seguros para UI": `nanoid` con seed sintético, `seedrandom`.
- ❌ Charting con sampling sintético por defecto (Recharts/Chart.js no se usan en la onda PPG; el monitor renderiza con `<canvas>` directamente).

Si en el futuro se necesita alguno (ej. `faker` para tests), debe quedar en `devDependencies` y nunca importarse desde `src/modules/**` ni desde `src/hooks/use{Signal,VitalSigns,HeartBeat}*`.

## Garantías automatizadas

1. **`scripts/check-no-simulation.mjs`** — escanea `src/` (excluyendo tests) y falla si encuentra `Math.random`, `mock`, `fake`, `dummy`, `synthetic`, `simulate`. Excepciones explícitas vía marcador `// anti-sim-allow: <razón>`.
2. **CI (`.github/workflows/ci.yml`)** — ejecuta `npm run check:no-sim` en cada push/PR. Build rojo si falla.
3. **Pre-commit hook (`.githooks/pre-commit`)** — bloquea commits con `Math.random` y keywords de simulación.
4. **Política de PR** — cualquier nueva dependencia debe agregarse a este informe con su categoría y justificación.

## Procedimiento para agregar una nueva dependencia

1. Justificar en el PR por qué es necesaria.
2. Confirmar que no toca `src/modules/signal-processing/**`, `src/modules/vital-signs/**` ni `src/components/CameraView.tsx`.
3. Actualizar la tabla de inventario en este documento.
4. Verificar que `npm run check:no-sim` y los tests pasan.

## Conclusión

El árbol de dependencias actual es **mínimo y auditado**. Ninguna librería puede contaminar el pipeline médico con valores sintéticos. El guardrail de CI bloquea automáticamente cualquier regresión.