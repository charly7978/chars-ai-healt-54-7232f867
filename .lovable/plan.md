## Objetivo

Extender el guardrail de sanidad de vitales (`VitalsSanityChecker`) con:
1. **Log auditable y descargable** de cada veredicto.
2. **Umbrales configurables** desde un archivo JSON / settings, con presets por modo de monitoreo.

Sin tocar el pipeline de señal. Cambios acotados a `src/lib/sanity/*` y a la integración en `src/pages/Index.tsx`.

---

## 1. Log de veredictos auditable

**Nuevo:** `src/lib/sanity/sanityAuditLog.ts`

- Singleton ligero (ring buffer de 500 entradas, configurable) que registra cada llamada a `push()` del checker.
- Estructura por entrada:
  ```ts
  {
    ts: number;            // epoch ms
    sessionId: string;     // generado al iniciar medición
    sample: number;        // valor BPM crudo
    windowSize: number;    // tamaño actual del buffer
    verdict: 'OK' | 'CONSTANT' | 'REPETITIVE' | 'ZERO_VARIANCE' | 'OUT_OF_RANGE';
    detail?: string;
    bpmWindow: number[];   // snapshot de los últimos N samples (capado a 30)
    thresholdsId: string;  // qué preset estaba activo
  }
  ```
- API:
  - `record(entry)` — append con drop-oldest.
  - `clear()` — reinicio por sesión.
  - `getAll()` — lectura para UI/debug.
  - `downloadJSON(filename?)` — `Blob` + `URL.createObjectURL` → `<a download>`.
  - `downloadCSV(filename?)` — flatten para Excel/auditoría rápida.

**Modificación:** `VitalsSanityChecker.push()` invocará el log si se le inyecta un `onVerdict` callback (inyección, no acoplamiento duro), preservando su pureza para tests.

**UI:** botón discreto **"Descargar log de auditoría"** en el panel de ajustes existente (no en el monitor cardíaco). Muestra contador `(n)` solo si hay veredictos negativos en la sesión.

---

## 2. Umbrales configurables

**Nuevo:** `src/lib/sanity/sanityProfiles.ts`

- Tipo `SanityProfile` = `VitalsSanityOptions & { id: string; label: string; description: string }`.
- Presets built-in:
  - `default` — actuales (window 30, tol 0.5, std 0.05, 30–220 BPM).
  - `strict` — clínico (window 45, tol 0.3, 40–180).
  - `permissive` — ejercicio/arritmia (window 20, tol 1.0, std 0.02, 30–230).
  - `research` — ventana grande, sin out-of-range agresivo.
- Carga de overrides desde:
  1. `localStorage["sanity.profile.custom"]` (objeto JSON parcial que mergea sobre el preset activo).
  2. Fetch opcional de `public/sanity-thresholds.json` al boot (si existe → mergea como preset `external`).
- Selector de preset persistido en `localStorage["sanity.profile.active"]`.

**Hook:** `src/lib/sanity/useSanityProfile.ts`
- Devuelve `{ profile, setProfile, profiles, updateCustom }`.
- Reinstancia el `VitalsSanityChecker` cuando cambia el profile (vía `useMemo`/`useEffect` en `Index.tsx`).

**UI mínima** dentro del modal de Ajustes existente:
- `<select>` con los presets.
- `<details>` colapsable con los valores efectivos (read-only) + textarea para JSON custom.
- Validación: si el JSON es inválido → toast de error y se descarta.

---

## 3. Integración en `src/pages/Index.tsx`

- Reemplazar el `new VitalsSanityChecker()` actual por el resultado del hook.
- Pasar `onVerdict` que llama al `sanityAuditLog.record(...)`.
- En `startMonitoring`: `sanityAuditLog.clear()` + nuevo `sessionId`.
- En `stopMonitoring`/`handleReset`: dejar el log disponible para descarga (no se borra hasta el próximo start).

---

## Archivos

- ➕ `src/lib/sanity/sanityAuditLog.ts`
- ➕ `src/lib/sanity/sanityProfiles.ts`
- ➕ `src/lib/sanity/useSanityProfile.ts`
- ✏️ `src/lib/sanity/vitalsSanity.ts` — añadir `onVerdict` callback opcional, sin cambiar lógica.
- ✏️ `src/pages/Index.tsx` — usar hook, registrar veredictos, botón de descarga, selector de preset.
- ➕ `public/sanity-thresholds.json` (opcional, vacío por defecto, documenta el formato).

---

## Detalles técnicos

- **Sin dependencias nuevas** (Blob/URL nativos, sin `file-saver`).
- **Anti-sim compliant**: el log es pasivo, no genera valores; los presets solo restringen detección.
- **CSV escaping**: comillas dobles + escape de `"` por duplicación.
- **Tamaño del buffer** configurable vía profile (`auditLogSize`, default 500).
- **Privacidad**: el log vive en memoria; solo se descarga si el usuario pulsa el botón.

## Riesgos

- Bajo. La inyección del callback en `vitalsSanity.ts` es retrocompatible (parámetro opcional). Los profiles se reducen a un objeto de opciones que ya acepta el constructor.
