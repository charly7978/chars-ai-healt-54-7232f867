/**
 * Derivaciones hemodinámicas de la presión arterial.
 *
 * Estas fórmulas NO son una nueva medición: son cantidades estándar derivadas
 * de la SBP (sistólica) y DBP (diastólica) que sí son estimadas por el modelo
 * PWA real (`BloodPressureProcessor`). Se aíslan aquí para tener un único
 * punto verificable y poder citarlas en la UI sin duplicar código.
 *
 * Definiciones (referencia clínica):
 *  - PP  = Pulse Pressure          = SBP − DBP
 *  - MAP = Mean Arterial Pressure  ≈ DBP + (SBP − DBP) / 3
 *    (válida en frecuencias cardiacas en reposo; a HR muy altas se infraestima
 *     ligeramente — no es un sustituto de cateterización arterial.)
 *
 * Devuelve 0 cuando la entrada no es plausible para evitar alimentar la UI
 * con números derivados de ceros / NaN.
 */

export interface PressureInput {
  systolic: number;
  diastolic: number;
}

export interface DerivedPressure {
  /** mean arterial pressure (mmHg) */
  map: number;
  /** pulse pressure (mmHg) */
  pp: number;
  /** true cuando los inputs eran fisiológicamente coherentes */
  valid: boolean;
}

const MIN_SBP = 60;
const MAX_SBP = 240;
const MIN_DBP = 30;
const MAX_DBP = 160;

export function deriveMapAndPp({ systolic, diastolic }: PressureInput): DerivedPressure {
  const sbp = Number(systolic);
  const dbp = Number(diastolic);

  const ok =
    Number.isFinite(sbp) &&
    Number.isFinite(dbp) &&
    sbp >= MIN_SBP && sbp <= MAX_SBP &&
    dbp >= MIN_DBP && dbp <= MAX_DBP &&
    sbp > dbp;

  if (!ok) {
    return { map: 0, pp: 0, valid: false };
  }

  const pp = sbp - dbp;
  const map = dbp + pp / 3;

  return { map, pp, valid: true };
}

/** Texto corto para la UI explicando el origen del dato. */
export const PRESSURE_SOURCE_NOTE =
  'MAP/PP derivados de SBP/DBP estimadas por PWA (no medición independiente)';