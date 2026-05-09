/**
 * Anonymization / disociation utilities aligned with Argentina's Ley 25.326
 * on Personal Data Protection (datos personales sensibles, art. 7).
 *
 * Goal: produce a JSON-safe payload where direct identifiers are replaced by
 * deterministic, non-reversible hashes, and quasi-identifiers (age, height,
 * weight, geo) are generalized into bins. The output never contains plain
 * names, emails, document numbers or precise coordinates.
 *
 * The hashing primitive is FNV-1a 64-bit (a non-cryptographic but fast hash).
 * It is *not* a cryptographic guarantee against re-identification by a
 * resourceful adversary; it is a one-way mapping suitable for client-side
 * disociation before transport. For higher assurance, combine with a
 * server-side keyed HMAC.
 */

function fnv1a64(input: string, salt: string): string {
  // 64-bit FNV-1a using two 32-bit halves to stay JS-safe.
  let hHi = 0xcbf29ce4 >>> 0;
  let hLo = 0x84222325 >>> 0;
  const data = `${salt}::${input}`;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    hLo ^= c;
    // Multiply by FNV prime 0x100000001b3 split as (Hi=0x100, Lo=0x000001b3)
    const lo = (hLo * 0x1b3) >>> 0;
    const hi = (hHi * 0x1b3 + hLo * 0x100) >>> 0;
    hLo = lo;
    hHi = (hi + ((lo / 0x100000000) | 0)) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(hHi)}${hex(hLo)}`;
}

/** Generalize an integer age into a 10-year band, e.g. 38 -> "30-39". */
export function generalizeAge(age: number | null | undefined): string | null {
  if (age == null || !Number.isFinite(age) || age < 0) return null;
  const lower = Math.floor(age / 10) * 10;
  return `${lower}-${lower + 9}`;
}

/** Generalize a numeric value into fixed-size bins. */
export function generalizeNumeric(
  value: number | null | undefined,
  binSize: number,
): string | null {
  if (value == null || !Number.isFinite(value) || binSize <= 0) return null;
  const lower = Math.floor(value / binSize) * binSize;
  return `${lower}-${lower + binSize - 1}`;
}

/**
 * Hash a personal identifier (name, email, DNI, phone) with a per-install
 * salt. The salt should be persisted in localStorage on first run; it makes
 * cross-install re-identification much harder than a global salt.
 */
export function hashIdentifier(value: string, salt: string): string {
  return `id_${fnv1a64(value.trim().toLowerCase(), salt)}`;
}

/** Round a coordinate to ~1 km precision (3 decimals). */
export function generalizeCoordinate(coord: number | null | undefined): number | null {
  if (coord == null || !Number.isFinite(coord)) return null;
  return Math.round(coord * 1000) / 1000;
}

export interface RawSubject {
  readonly fullName?: string;
  readonly email?: string;
  readonly documentNumber?: string;
  readonly phone?: string;
  readonly age?: number;
  readonly heightCm?: number;
  readonly weightKg?: number;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface AnonymizedSubject {
  readonly subjectIdHash: string | null;
  readonly emailHash: string | null;
  readonly documentHash: string | null;
  readonly phoneHash: string | null;
  readonly ageBand: string | null;
  readonly heightBand: string | null;
  readonly weightBand: string | null;
  readonly latitudeApprox: number | null;
  readonly longitudeApprox: number | null;
}

/**
 * Apply deep anonymization to a subject payload before it leaves the device.
 *
 * @param raw   Raw subject data captured by the consent form.
 * @param salt  Per-install salt (read from localStorage; do NOT hard-code).
 */
export function anonymizeSubject(raw: RawSubject, salt: string): AnonymizedSubject {
  return {
    subjectIdHash: raw.fullName ? hashIdentifier(raw.fullName, salt) : null,
    emailHash: raw.email ? hashIdentifier(raw.email, salt) : null,
    documentHash: raw.documentNumber ? hashIdentifier(raw.documentNumber, salt) : null,
    phoneHash: raw.phone ? hashIdentifier(raw.phone, salt) : null,
    ageBand: generalizeAge(raw.age),
    heightBand: generalizeNumeric(raw.heightCm, 5),
    weightBand: generalizeNumeric(raw.weightKg, 5),
    latitudeApprox: generalizeCoordinate(raw.latitude),
    longitudeApprox: generalizeCoordinate(raw.longitude),
  };
}

const SALT_STORAGE_KEY = "privacy.install.salt.v1";

/** Get-or-create a per-install random salt, persisted in localStorage. */
export function getOrCreateInstallSalt(): string {
  try {
    const existing = localStorage.getItem(SALT_STORAGE_KEY);
    if (existing && existing.length >= 16) return existing;
    // crypto.getRandomValues is part of the Web Crypto API — not Math.random.
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let salt = "";
    for (let i = 0; i < buf.length; i++) {
      salt += buf[i].toString(16).padStart(2, "0");
    }
    localStorage.setItem(SALT_STORAGE_KEY, salt);
    return salt;
  } catch {
    // localStorage / crypto unavailable: fall back to an empty salt so the
    // hash still works, but warn the operator.
    return "";
  }
}
