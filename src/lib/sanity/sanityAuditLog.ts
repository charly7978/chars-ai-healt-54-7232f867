import type { SanityVerdict } from "./vitalsSanity";

export interface AuditEntry {
  ts: number;
  sessionId: string;
  sample: number;
  windowSize: number;
  verdict: "OK" | "CONSTANT" | "REPETITIVE" | "ZERO_VARIANCE" | "OUT_OF_RANGE";
  detail?: string;
  bpmWindow: number[];
  thresholdsId: string;
}

const MAX_ENTRIES = 500;
const SNAPSHOT_CAP = 30;

let buffer: AuditEntry[] = [];
let sessionId = "no-session";
let thresholdsId = "default";

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
    detail = undefined;
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
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function getEntries(): AuditEntry[] {
  return buffer.slice();
}

export function getNegativeCount(): number {
  let n = 0;
  for (const e of buffer) if (e.verdict !== "OK") n++;
  return n;
}

export function clearLog(): void {
  buffer = [];
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

export function downloadJSON(filename = `sanity-audit-${Date.now()}.json`): void {
  const blob = new Blob([JSON.stringify(buffer, null, 2)], { type: "application/json" });
  triggerDownload(blob, filename);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadCSV(filename = `sanity-audit-${Date.now()}.csv`): void {
  const header = ["ts_iso", "session_id", "thresholds_id", "verdict", "sample", "window_size", "detail", "bpm_window"];
  const rows = buffer.map(e => [
    new Date(e.ts).toISOString(),
    e.sessionId,
    e.thresholdsId,
    e.verdict,
    e.sample.toFixed(3),
    e.windowSize,
    e.detail ?? "",
    e.bpmWindow.map(n => n.toFixed(2)).join("|"),
  ]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, filename);
}