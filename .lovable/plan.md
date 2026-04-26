Voy a corregirlo en dos frentes inseparables: primero despejar la pantalla para que el monitor cardíaco sea realmente el fondo 100%, y segundo endurecer/ajustar la extracción PPG real para que no se quede bloqueada por umbrales o gates contradictorios.

Plan de implementación

1. Rediseñar la pantalla como monitor 100%
- Convertir `PPGSignalMeter` en el lienzo principal absoluto de toda la pantalla, sin paneles grandes dentro del canvas que tapen la onda.
- Eliminar del canvas los bloques redundantes que hoy ocupan área útil: panel superior grande, panel derecho de SpO2 en modo forense, panel morfológico inferior, historial de latidos grande, leyenda y banner grande.
- Mantener solo la onda, grid, escala mínima y marcadores esenciales, maximizando el área de trazado.
- Mover la información crítica a overlays HTML compactos y translúcidos: BPM/estado, calidad/SQI, fuente activa, presión, razón de bloqueo.
- Hacer que controles `INICIAR/DETENER` y `RESET` sean botones flotantes pequeños, no una barra fija de 48px tapando el monitor.

2. Reorganizar overlays por importancia
- Crear una estructura visual tipo cockpit:
```text
┌──────────────────────────────┐
│  mini estado/contacto/BPM     │
│                              │
│                              │
│     MONITOR PPG 100%          │
│       onda + grid             │
│                              │
│  controles compactos          │
└──────────────────────────────┘
```
- Ocultar o colapsar `ForensicGateOverlay` por defecto para que no tape el monitor; dejarlo accesible con botón `DEBUG`.
- Reemplazar el panel de umbrales flotante grande por un panel desplegable compacto solo cuando debug esté activo.
- Mantener información técnica, pero sin invadir la onda.

3. Corregir captura y timing de frames
- Cambiar el canvas de procesamiento de `320x240` a una resolución interna mayor y adaptativa según el video real, con límite móvil seguro para rendimiento.
- Usar correctamente `requestVideoFrameCallback(now, metadata)` y pasar `metadata.presentationTime`/`expectedDisplayTime` convertido a milisegundos cuando exista; fallback con `performance.now()`.
- Eliminar `console.log` por frame, porque genera jank y puede arruinar la detección en móviles.
- Medir tiempo de captura/procesamiento sin contaminar el hot path.

4. Arreglar la detección de dedo/liveness que está bloqueando señal real
- Revisar los gates que hoy pueden impedir detección aun con dedo: `LIVENESS`, `OpticalEvidenceGate`, `coverage`, `texture`, `AC/DC`, `clipHigh`, `gate2`, `gate3`.
- Separar claramente:
  - contacto óptico real del dedo,
  - calidad de pulsatilidad,
  - autorización final de publicación.
- Evitar que el monitor se quede en `NO PULSO` mientras sí hay contacto óptico pero aún no hay morfología suficiente.
- Hacer el modo de visualización de señal más útil: mostrar señal PPG cruda/filtrada cuando hay contacto óptico real, aunque BPM todavía esté en adquisición, sin inventar BPM.
- Mantener la filosofía de no falsear lecturas: si no hay latido validado, no publicar BPM, pero sí permitir ver la onda real de adquisición.

5. Mejorar ROI adaptativo para cobertura real
- Reducir el ROI fine cuando haya buena masa de dedo para evitar mezclar bordes negros/flash saturado.
- Cambiar el cálculo de `coverageRatio` para que represente cobertura dentro del ROI adaptado, no castigar injustamente por una grilla demasiado grande.
- Suavizar el centroide y tamaño, pero permitir reubicación más rápida si el dedo está fuera del centro.
- Exportar ROI real (`x/y/width/height`) en `ProcessedSignal` para overlay/debug futuro.

6. Ajustar presión y clipping sin bloquear dedos reales
- Distinguir saturación local tolerable de saturación global destructiva.
- Penalizar `HIGH_PRESSURE`, pero no matar la adquisición si todavía hay AC/DC útil.
- Actualizar mensajes: “reduzca presión”, “cubra lente”, “mueva dedo al centro”, “mantenga quieto”, según causa real.

7. Validación final
- Ejecutar build limpio.
- Ejecutar pruebas unitarias/instrumentación existentes.
- Ejecutar auditoría forense contra simulaciones/fakes.
- Revisar que no haya `Math.random`, mocks ni datos fisiológicos simulados.
- Entregar resumen de archivos cambiados y evidencia de verificación.

Archivos principales a modificar
- `src/components/PPGSignalMeter.tsx`
- `src/pages/Index.tsx`
- `src/modules/signal-processing/PPGSignalProcessor.ts`
- `src/modules/signal-processing/AdaptiveROIMask.ts`
- `src/modules/signal-processing/OpticalEvidenceGate.ts`
- `src/types/signal.d.ts`

Criterio de éxito
- El monitor cardíaco ocupa visualmente el 100% de la pantalla.
- Los elementos no tapan la onda; solo quedan overlays compactos y controlados.
- La app diferencia “contacto óptico adquirido” de “BPM validado”.
- La señal real puede verse durante adquisición sin publicar BPM falso.
- La detección deja de depender de umbrales visuales demasiado restrictivos que bloquean dedos reales bajo flash.
- Build, tests y auditoría pasan sin errores.