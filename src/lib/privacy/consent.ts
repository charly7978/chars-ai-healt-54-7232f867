/**
 * Informed-consent gate aligned with Argentina's Ley 25.326
 * (Protección de Datos Personales, art. 5: consentimiento previo, expreso e
 * informado para datos sensibles, art. 7).
 *
 * The consent record is stored locally with a version number so that any
 * change to the consent text invalidates prior consent and forces re-prompt.
 */

export const CONSENT_VERSION = "2026-05-09.v1";

const STORAGE_KEY = "privacy.consent.v1";

export interface ConsentRecord {
  readonly version: string;
  readonly acceptedAt: string;
  readonly acceptedDataProcessing: boolean;
  readonly acceptedBiometric: boolean;
}

export function getConsent(): ConsentRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConsentRecord;
    if (parsed.version !== CONSENT_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function recordConsent(): ConsentRecord {
  const record: ConsentRecord = {
    version: CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
    acceptedDataProcessing: true,
    acceptedBiometric: true,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Non-fatal: consent will be re-prompted next launch.
  }
  return record;
}

export function revokeConsent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
