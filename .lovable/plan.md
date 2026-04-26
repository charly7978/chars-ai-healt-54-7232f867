Plan de corrección forense máxima

Objetivo: que la app no vuelva a dibujar onda cardíaca, BPM, SpO2 ni otros valores cuando la cámara está mirando aire, objetos, superficies, luz o ruido. No puedo prometer una certificación forense/regulatoria desde una cámara web móvil sin validación clínica formal, pero sí puedo endurecer el software para que en modo forense solo muestre pulso cuando exista evidencia PPG real y validada por los 3 gates.

Cambios propuestos

1. Cierre total de salida clínica en modo forense
- El modo por defecto será solo detector de pulso PPG: estado de pulso, BPM validado y métricas técnicas.
- Ocultar/eliminar del flujo forense SpO2, presión, glucosa, colesterol, análisis AI y resultados civiles que puedan sugerir medición clínica.
- Evitar guardado de mediciones civiles si no hubo triple gate completo.
- El canvas/monitor dejará de mostrar panel de SpO2 en modo forense; solo mostrará pulso/BPM/SQI técnico o `SIN PULSO VALIDADO`.

2. Triple gate como única autoridad de UI
- Toda salida visible dependerá de `forensicGate.passAll`:
  - Gate 1: firma óptica compatible con dedo/tejido bajo flash.
  - Gate 2: potencia cardíaca real con SNR/frecuencia pico/concentración espectral.
  - Gate 3: morfología de latidos válida y repetida.
- Si cualquier gate falla: onda = 0, BPM = `--`, beats = 0, RR = vacío, no vitals, no análisis.
- Ajustar el panel principal para usar `passAll`, no solo `heartRate > 0` ni `fingerDetected`.

3. Endurecer Gate 1 para “no medir aire” sin convertirlo en un bloqueo ciego de dedo
- Mantener “vía libre” de cámara: la cámara sigue viendo y el overlay explica exactamente qué falta.
- No se bloqueará la cámara; se bloqueará únicamente la publicación de números si no hay evidencia óptica.
- Recalibrar Gate 1 para usar la ROI gruesa y fina correctamente, porque ahora algunos umbrales pueden ser demasiado rígidos o inconsistentes:
  - firma rojo/hemoglobina sobre ROI válida, no píxeles saturados;
  - cobertura mínima real;
  - rechazo de superficie plana, reflejo, clipping y luz directa;
  - razón específica en pantalla.

4. Endurecer Gate 2 sin cálculos pesados por frame
- Mantener el verificador Goertzel, pero evitar asignaciones innecesarias en cada evaluación.
- Validar que el tiempo real del frame llegue correctamente al verificador.
- Si SNR, pico cardíaco o concentración no son suficientes: no hay onda ni BPM.

5. Corregir Gate 3 para morfología verdaderamente fisiológica
- Gate 3 no dependerá de “algún pico” aislado.
- Requerir latidos recientes con:
  - morfología suficiente,
  - fiduciales plausibles cuando estén disponibles,
  - rise time dentro de rango humano,
  - RR estable dentro de tolerancia,
  - detector agreement suficiente.
- El feedback `setMorphologyGate(...)` seguirá siendo tipado, sin `window` globals.
- Si no hay 4 latidos válidos recientes: Gate 3 cerrado y razón clara.

6. El monitor no dibujará falsas ondas
- Modificar `PPGSignalMeter` para que en modo forense no dibuje señal ni paneles vitales salvo si `forensicPass` es true.
- Cuando no pase el triple gate, el canvas mostrará línea plana/estado bloqueado y razón, no una onda generada por ruido.
- Remover visualmente SpO2 del canvas en modo forense.

7. Overlay forense más contundente
- Ampliar overlay para mostrar:
  - G1/G2/G3 pass/fail,
  - razón del gate cerrado,
  - SNR dB,
  - pico Hz/BPM,
  - concentración,
  - estado `PULSO VALIDADO` / `NO PUBLICAR VALORES`.
- Mantener cadencia configurable para no afectar fluidez.

8. Export forense solo con contexto de validez
- El JSON/CSV exportará `pass_all` y razones por muestra.
- Añadir resumen: porcentaje de muestras con triple gate completo, SNR promedio/máximo, BPM estimado solo en muestras válidas.
- No exportar valores clínicos en modo forense.

9. Verificación técnica
- Ejecutar TypeScript/build/test disponibles.
- Buscar que no queden usos de `window.__...` ni rutas de UI que muestren BPM/onda/vitales si `passAll=false`.
- Revisar especialmente `Index.tsx`, `PPGSignalMeter.tsx`, `PPGSignalProcessor.ts`, `HeartBeatProcessor.ts` y tipos.

Archivos principales a tocar
- `src/pages/Index.tsx`
- `src/components/PPGSignalMeter.tsx`
- `src/components/ForensicGateOverlay.tsx`
- `src/modules/signal-processing/PPGSignalProcessor.ts`
- `src/modules/signal-processing/CardiacBandVerifier.ts`
- `src/hooks/useHeartBeatProcessor.ts`
- `src/types/signal.d.ts` / `src/types/beat.ts` si hace falta tipar el gate sin `any`

Resultado esperado
- Aire/mesa/pared/luz/ruido: pantalla muestra `SIN PULSO VALIDADO`, todos los números en `--`, onda plana, razón técnica visible.
- Dedo/tejido sin pulsatilidad suficiente: contacto óptico puede aparecer, pero Gate 2/3 bloquean BPM/onda.
- Pulso PPG real sostenido: los 3 gates pasan, se habilita onda/BPM y se registra/exporta como muestra válida.