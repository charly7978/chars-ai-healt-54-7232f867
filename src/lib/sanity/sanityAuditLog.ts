import type { SanityVerdict, SanityMetrics } from "./vitalsSanity";

export interface AuditEntry {
  ts: number;
  sessionId: string;
  sample: number;
  windowSize: number;
  verdict: "OK" | "CONSTANT" | "REPETITIVE" | "ZERO_VARIANCE" | "OUT_OF_RANGE";
  detail?: string;
  bpmWindow: number[];
  thresholdsId: string;
  metrics?: SanityMetrics;
}

const MAX_ENTRIES = 500;          // in-memory current-session ring
const PERSIST_MAX = 2000;          // total cross-session retention in localStorage
const SNAPSHOT_CAP = 30;
const STORAGE_KEY = "sanity.audit.log.v2";
const PERSIST_DEBOUNCE_MS = 750;

let buffer: AuditEntry[] = [];
let persisted: AuditEntry[] = loadPersisted();
let sessionId = "no-session";
let thresholdsId = "default";
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadPersisted(): AuditEntry[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-PERSIST_MAX);
  } catch {
    return [];
  }
}

function schedulePersist(): void {
  if (typeof localStorage === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const trimmed = persisted.slice(-PERSIST_MAX);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      persisted = trimmed;
    } catch {
      // Quota exceeded — drop oldest half and retry once.
      try {
        persisted = persisted.slice(-Math.floor(PERSIST_MAX / 2));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      } catch { /* give up silently */ }
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function startSession(id: string, profileId: string): void {
  sessionId = id;
  thresholdsId = profileId;
  buffer = [];
}

export function setActiveProfile(profileId: string): void {
  thresholdsId = profileId;
}

export function recordVerdict(sample: number, verdict: SanityVerdict, window: number[]): void {
  let verdictTag: AuditEntry["verdict"];
  let detail: string | undefined;
  if (verdict.ok === false) {
    verdictTag = verdict.reason;
    detail = verdict.detail;
  } else {
    verdictTag = "OK";
  }
  const entry: AuditEntry = {
    ts: Date.now(),
    sessionId,
    sample,
    windowSize: window.length,
    verdict: verdictTag,
    detail,
    bpmWindow: window.length > SNAPSHOT_CAP ? window.slice(-SNAPSHOT_CAP) : window.slice(),
    thresholdsId,
    metrics: verdict.metrics,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  persisted.push(entry);
  if (persisted.length > PERSIST_MAX) persisted.splice(0, persisted.length - PERSIST_MAX);
  schedulePersist();
}

/** Current-session entries (in-memory ring). */
export function getEntries(): AuditEntry[] {
  return buffer.slice();
}

/** All persisted entries across sessions (capped at PERSIST_MAX). */
export function getPersistedEntries(): AuditEntry[] {
  return persisted.slice();
}

export function getNegativeCount(): number {
  let n = 0;
  for (const e of buffer) if (e.verdict !== "OK") n++;
  return n;
}

export function getPersistedNegativeCount(): number {
  let n = 0;
  for (const e of persisted) if (e.verdict !== "OK") n++;
  return n;
}

export function clearLog(): void {
  buffer = [];
}

/** Wipe persistent storage (keeps current in-memory session). */
export function clearPersistedLog(): void {
  persisted = [];
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickEntries(scope: "session" | "persisted"): AuditEntry[] {
  return scope === "persisted" ? persisted : buffer;
}

export function downloadJSON(filename = `sanity-audit-${Date.now()}.json`, scope: "session" | "persisted" = "session"): void {
  const data = pickEntries(scope);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  triggerDownload(blob, filename);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmt(n: number | undefined, digits = 4): string {
  return n === undefined || !Number.isFinite(n) ? "" : n.toFixed(digits);
}

export function downloadCSV(filename = `sanity-audit-${Date.now()}.csv`, scope: "session" | "persisted" = "session"): void {
  const data = pickEntries(scope);
  const header = [
    "ts_iso", "session_id", "thresholds_id", "verdict",
    "sample", "window_size", "detail",
    "metric_last", "metric_mean", "metric_min", "metric_max",
    "metric_span", "metric_variance", "metric_std",
    "metric_delta_std", "metric_mean_abs_delta",
    "bpm_window",
  ];
  const rows = data.map(e => {
    const m = e.metrics;
    return [
      new Date(e.ts).toISOString(),
      e.sessionId,
      e.thresholdsId,
      e.verdict,
      e.sample.toFixed(3),
      e.windowSize,
      e.detail ?? "",
      fmt(m?.last, 3),
      fmt(m?.mean, 3),
      fmt(m?.min, 3),
      fmt(m?.max, 3),
      fmt(m?.span, 4),
      fmt(m?.variance, 6),
      fmt(m?.std, 4),
      fmt(m?.deltaStd, 4),
      fmt(m?.meanAbsDelta, 4),
      e.bpmWindow.map(n => n.toFixed(2)).join("|"),
    ];
  });
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, filename);
}
