# Plan: Guardrail de transición dinámica + Toast de cambio de backpressure

## 1. Guardrail test — transición dinámica stride 3 ↔ 4

**Archivo nuevo:** `src/modules/signal-processing/__tests__/BackpressureTransition.test.ts`

Complementa el test existente `Backpressure.test.ts` (que compara sesiones independientes con stride forzado). Este nuevo test valida lo que pasa **dentro de una misma sesión** cuando el algoritmo cambia stride en caliente.

**Escenario:**
- Inicia sesión con `forceStride: 3`, alimenta ~10s de señal pulsátil sintética (72 BPM, 30 fps).
- Captura BPM y confianza estabilizados (ventana pre-switch).
- A mitad de sesión, llama a `setBackpressureConfig({ forceStride: 4 })` para simular el switch automático.
- Continúa alimentando otros ~10s con la misma señal.
- Captura BPM y confianza post-switch.
- Repite el switch inverso (4 → 3) y mide otra ventana.

**Invariantes verificados:**
- Drift de BPM mediano pre vs post switch < 4 bpm (ambas direcciones).
- Confianza media post-switch ≥ 80% de la pre-switch (no colapsa al transicionar).
- No se emiten señales con `NaN`/`Infinity` durante la transición.
- Ningún frame post-switch reporta `quality === 0` si pre-switch estaba estable.
- Verificación adicional: el switch no introduce un "salto" instantáneo > 8 bpm en los siguientes 5 frames (continuidad).

## 2. Toast efímero al cambiar pixelStride

**Objetivo:** notificar visualmente al usuario solo cuando el backpressure adaptativo (no el override manual) cambia el stride en caliente.

**Cambios:**

### a) `src/hooks/useSignalProcessor.ts`
- Añadir estado `currentStride` (number) actualizado vía polling ligero (cada 1s con `setInterval` mientras `isProcessing`) leyendo `getBackpressureState().pixelStride`.
- Exponerlo en el return del hook.

### b) `src/pages/Index.tsx`
- `useEffect` que observa cambios en `currentStride`:
  - Mantiene `prevStrideRef` para detectar transiciones.
  - Solo dispara toast si:
    - `isMonitoring === true` (medición activa).
    - El cambio NO viene de `forceStride` (lee config, ignora si `forceStride` está definido).
    - Han pasado >2s desde el inicio (evita toast en el arranque).
  - Toast con `sonner`:
    - **Stride sube (3→4, 4→5):** `toast.warning("⚡ Modo ahorro activado", { description: "Rendimiento bajo detectado, reduciendo muestreo (stride " + n + ")", duration: 3000 })`.
    - **Stride baja (4→3):** `toast.success("✓ Rendimiento restaurado", { description: "Muestreo completo activo (stride 3)", duration: 2500 })`.

**No se añade badge persistente** — el usuario eligió toast efímero. El stride actual sigue visible en el modal de Ajustes y en la telemetría.

## Detalles técnicos

- **Polling vs evento:** se usa polling 1s en el hook porque `PPGSignalProcessor` no expone callback de cambio de stride; agregar un emisor sería más invasivo. El polling es trivial (1 lectura síncrona/s).
- **Diferenciación auto vs manual:** se compara contra `getBackpressureConfig().forceStride`. Si está definido, el cambio es manual y no se notifica.
- **Sin cambios en lógica de procesamiento:** ni el algoritmo de adaptación ni el pipeline se tocan.
- **Sonner ya está montado** en el árbol (lo usa el resto de la app).

## Archivos afectados

- ✅ Nuevo: `src/modules/signal-processing/__tests__/BackpressureTransition.test.ts`
- ✏️ Editado: `src/hooks/useSignalProcessor.ts` (añadir `currentStride`)
- ✏️ Editado: `src/pages/Index.tsx` (efecto + toasts)

## Riesgos

- Bajo. El polling es de lectura pura, no muta estado del procesador. Los toasts solo aparecen en transiciones reales, evitando spam por las condiciones de gating (isMonitoring, no manual, ventana de gracia).
