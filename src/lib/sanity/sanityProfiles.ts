import type { VitalsSanityOptions } from "./vitalsSanity";

export interface SanityProfile {
  id: string;
  label: string;
  description: string;
  options: Required<Omit<VitalsSanityOptions, "onVerdict">>;
}

const ACTIVE_KEY = "sanity.profile.active";
const CUSTOM_KEY = "sanity.profile.custom";

export const SANITY_PROFILES: SanityProfile[] = [
  {
    id: "default",
    label: "Por defecto",
    description: "Balance general — uso clínico estándar (30–220 BPM).",
    options: { windowSize: 30, minSamples: 12, constantTolerance: 0.5, repetitiveStdMin: 0.05, min: 30, max: 220 },
  },
  {
    id: "strict",
    label: "Estricto (clínico)",
    description: "Tolerancias menores, rango fisiológico acotado (40–180 BPM).",
    options: { windowSize: 45, minSamples: 18, constantTolerance: 0.3, repetitiveStdMin: 0.08, min: 40, max: 180 },
  },
  {
    id: "permissive",
    label: "Permisivo (ejercicio/arritmia)",
    description: "Ventana corta y mayor tolerancia a oscilaciones (30–230 BPM).",
    options: { windowSize: 20, minSamples: 8, constantTolerance: 1.0, repetitiveStdMin: 0.02, min: 30, max: 230 },
  },
  {
    id: "research",
    label: "Investigación",
    description: "Ventana grande, rango amplio — ideal para análisis offline.",
    options: { windowSize: 60, minSamples: 24, constantTolerance: 0.8, repetitiveStdMin: 0.03, min: 25, max: 240 },
  },
];

export function getActiveProfileId(): string {
  try { return localStorage.getItem(ACTIVE_KEY) || "default"; } catch { return "default"; }
}

export function setActiveProfileId(id: string): void {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* noop */ }
}

export function getCustomOverrides(): Partial<VitalsSanityOptions> {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

export function setCustomOverrides(overrides: Partial<VitalsSanityOptions> | null): void {
  try {
    if (!overrides || Object.keys(overrides).length === 0) localStorage.removeItem(CUSTOM_KEY);
    else localStorage.setItem(CUSTOM_KEY, JSON.stringify(overrides));
  } catch { /* noop */ }
}

/** Resolve effective options = preset + custom overrides (custom wins). */
export function resolveProfile(id: string = getActiveProfileId()): {
  profile: SanityProfile;
  effective: Required<Omit<VitalsSanityOptions, "onVerdict">>;
} {
  const profile = SANITY_PROFILES.find(p => p.id === id) ?? SANITY_PROFILES[0];
  const overrides = getCustomOverrides();
  const effective = { ...profile.options, ...overrides } as Required<Omit<VitalsSanityOptions, "onVerdict">>;
  return { profile, effective };
}