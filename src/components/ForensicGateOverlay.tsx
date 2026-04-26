import React from "react";

export interface ForensicGateSnapshot {
  gate1_optical: boolean;
  gate2_spectral: boolean;
  gate3_morphology: boolean;
  passAll: boolean;
  cardiacSNRdB: number;
  spectralPeakHz: number;
  spectralConcentration: number;
  livenessReason: string;
  // Optical Evidence Gate (físico, independiente de morfología).
  opticalEvidence?: boolean;
  opticalReason?: string;
  opticalReasonText?: string;
  opticalMetrics?: {
    acDc: number; rOverGB: number; texture: number;
    clipHigh: number; clipLow: number; pi: number; meanR: number;
  } | null;
  publicationGate?: boolean;
  effectiveSampleRate?: number;
  bufferedSeconds?: number;
  // Raw Gate-1 telemetry (mirrors the values driving the liveness decision).
  livenessRaw?: {
    rawR: number; rawG: number; rawB: number;
    totalI: number; absorption: number; redDom: number;
    texture: number; coverage: number;
    confirmCount: number; lostCount: number;
  };
}

export const FORENSIC_CADENCE_OPTIONS = [100, 150, 300, 500, 1000] as const;
export type ForensicCadenceMs = typeof FORENSIC_CADENCE_OPTIONS[number];

interface Props {
  gate: ForensicGateSnapshot | null;
  visible: boolean;
  onExport?: () => void;
  sampleCount?: number;
  cadenceMs?: ForensicCadenceMs;
  onCadenceChange?: (ms: ForensicCadenceMs) => void;
  validSamples?: number;
  noiseSamples?: number;
}

const pillBase =
  "flex-1 text-center px-2 py-1 rounded-md text-[10px] font-bold tracking-wide border";

function pillClass(state: boolean | null | undefined): string {
  if (state === true) return `${pillBase} bg-emerald-600/30 border-emerald-400/60 text-emerald-200`;
  if (state === false) return `${pillBase} bg-red-700/30 border-red-500/60 text-red-200`;
  return `${pillBase} bg-zinc-700/30 border-zinc-500/40 text-zinc-300`;
}

function snrClass(db: number): string {
  if (db >= 6) return "text-emerald-300";
  if (db >= 3) return "text-amber-300";
  return "text-red-300";
}

const ForensicGateOverlay: React.FC<Props> = ({
  gate, visible, onExport, sampleCount, cadenceMs, onCadenceChange,
  validSamples = 0, noiseSamples = 0,
}) => {
  if (!visible) return null;

  const g1 = gate?.gate1_optical ?? null;
  const g2 = gate?.gate2_spectral ?? null;
  const g3 = gate?.gate3_morphology ?? null;
  const passAll = !!gate?.passAll;
  const snrDb = gate?.cardiacSNRdB ?? 0;
  const peakHz = gate?.spectralPeakHz ?? 0;
  const conc = gate?.spectralConcentration ?? 0;
  const reason = gate?.livenessReason ?? "ESPERANDO SEÑAL";
  // OpticalEvidenceGate (gate físico independiente de morfología).
  const opticalOk = gate?.opticalEvidence ?? null;
  const opticalText = gate?.opticalReasonText ?? '—';
  const om = gate?.opticalMetrics ?? null;
  const effSr = gate?.effectiveSampleRate ?? 0;
  const bufSec = gate?.bufferedSeconds ?? 0;
  const lr = gate?.livenessRaw;
  // Make the failing gate explicit so the operator never wonders why pulse
  // is not being shown. (Gate 1 = optical, Gate 2 = spectral, Gate 3 = morph.)
  let prefix = '';
  if (g1 === false) prefix = 'G1 ÓPTICA · ';
  else if (g2 === false) prefix = 'G2 ESPECTRAL · ';
  else if (g3 === false) prefix = 'G3 MORFOLOGÍA · ';
  const fullReason = prefix + reason;
  const reasonShort = fullReason.length > 60 ? fullReason.slice(0, 59) + "…" : fullReason;
  const bpmEstimate = peakHz > 0 ? Math.round(peakHz * 60) : 0;
  const totalSamples = validSamples + noiseSamples;
  const validPct = totalSamples > 0 ? (validSamples / totalSamples) * 100 : 0;
  const validPctStr = totalSamples > 0 ? validPct.toFixed(1) + '%' : '—';
  const validPctClass =
    totalSamples === 0 ? 'text-zinc-400'
    : validPct >= 60 ? 'text-emerald-300'
    : validPct >= 25 ? 'text-amber-300'
    : 'text-red-300';

  return (
    <div
      className="fixed top-2 right-2 z-50 w-[280px] pointer-events-none select-none rounded-lg border border-zinc-700/70 bg-black/75 backdrop-blur-sm p-2 font-mono text-[11px] text-zinc-100 shadow-xl"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between mb-1.5 px-0.5">
        <span className="text-[10px] font-bold tracking-widest text-zinc-300">
          FORENSIC GATE
        </span>
        <span
          className={
            "text-[10px] font-bold px-1.5 py-0.5 rounded " +
            (passAll
              ? "bg-emerald-500/20 text-emerald-200"
              : "bg-red-500/20 text-red-200")
          }
        >
          {passAll ? "OK" : "BLOQUEADO"}
        </span>
      </div>

      <div className="flex gap-1 mb-2">
        <div className={pillClass(g1)} title="Gate 1 — firma óptica de hemoglobina">G1 ÓPTICA</div>
        <div className={pillClass(g2)} title="Gate 2 — SNR cardíaca ≥ 6 dB durante 1.5 s">G2 ESPECTRAL</div>
        <div className={pillClass(g3)} title="Gate 3 — 4 latidos morfológicamente válidos">G3 MORFOLOGÍA</div>
      </div>

      <div
        className={
          "text-center text-[11px] font-bold py-1 mb-2 rounded " +
          (passAll
            ? "bg-emerald-600/20 text-emerald-200"
            : "bg-red-700/20 text-red-200")
        }
      >
        {passAll ? "PULSO REAL DETECTADO" : "NO PUBLICAR VALORES — SIN PULSO VÁLIDO"}
      </div>

      <div className="space-y-0.5 px-0.5">
        <div className="flex justify-between">
          <span className="text-zinc-400">SNR cardíaca</span>
          <span className={snrClass(snrDb)}>{snrDb.toFixed(1)} dB</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Pico</span>
          <span className="text-zinc-100">
            {peakHz > 0 ? `${peakHz.toFixed(2)} Hz (≈${bpmEstimate} BPM)` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Concentración</span>
          <span className="text-zinc-100">{Math.round(conc * 100)}%</span>
        </div>
        <div className="flex justify-between pt-1 mt-1 border-t border-zinc-700/60">
          <span className="text-zinc-400">Válidas / Ruido</span>
          <span className="text-zinc-100">
            <span className="text-emerald-300">{validSamples}</span>
            <span className="text-zinc-500"> / </span>
            <span className="text-red-300">{noiseSamples}</span>
          </span>
        </div>
        <div className="flex justify-between" title="Porcentaje de muestras con triple-gate (G1+G2+G3) completo durante la sesión">
          <span className="text-zinc-400">Triple-gate %</span>
          <span className={validPctClass + ' font-bold'}>{validPctStr}</span>
        </div>
        <div
          className="flex justify-between gap-2 pt-0.5 border-t border-zinc-700/60 mt-1"
          title={fullReason}
        >
          <span className="text-zinc-400 shrink-0">Razón</span>
          <span className="text-zinc-200 truncate text-right">{reasonShort}</span>
        </div>
      </div>

      <div className="mt-1.5 pt-1 border-t border-zinc-700/60 text-[9px] text-zinc-500 leading-tight">
        G1 firma hemoglobina · G2 SNR ≥ 6 dB · G3 morfología 4/4
      </div>

      {/* ─── OpticalEvidenceGate (físico, sin morfología) ────────── */}
      <div className="mt-1.5 pt-1 border-t border-zinc-700/60">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-bold tracking-widest text-zinc-300">EVIDENCIA ÓPTICA</span>
          <span className={
            "text-[9px] font-bold px-1 py-0.5 rounded " +
            (opticalOk === true ? "bg-emerald-500/20 text-emerald-200"
             : opticalOk === false ? "bg-red-500/20 text-red-200"
             : "bg-zinc-600/20 text-zinc-300")
          }>
            {opticalOk === true ? "ACEPTADA" : opticalOk === false ? "RECHAZADA" : "—"}
          </span>
        </div>
        <div className="text-[10px] text-zinc-300 truncate" title={opticalText}>{opticalText}</div>
        {om && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 mt-1 text-[9px] text-zinc-400">
            <div className="flex justify-between"><span>AC/DC</span><span className="text-zinc-100">{om.acDc.toFixed(4)}</span></div>
            <div className="flex justify-between"><span>R/(G+B)</span><span className="text-zinc-100">{om.rOverGB.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Textura</span><span className="text-zinc-100">{om.texture.toFixed(3)}</span></div>
            <div className="flex justify-between"><span>PI</span><span className="text-zinc-100">{(om.pi * 100).toFixed(2)}%</span></div>
            <div className="flex justify-between"><span>Clip↑</span><span className="text-zinc-100">{(om.clipHigh * 100).toFixed(1)}%</span></div>
            <div className="flex justify-between"><span>Clip↓</span><span className="text-zinc-100">{(om.clipLow * 100).toFixed(1)}%</span></div>
            <div className="flex justify-between"><span>meanR</span><span className="text-zinc-100">{om.meanR.toFixed(0)}</span></div>
            <div className="flex justify-between"><span>SR ef.</span><span className="text-zinc-100">{effSr.toFixed(1)}Hz</span></div>
          </div>
        )}
        <div className="text-[9px] text-zinc-500 mt-1">Buffer real: {bufSec.toFixed(1)}s / 10.0s</div>
      </div>

      {/* ─── Gate 1 raw telemetry (why liveness opens/closes) ─── */}
      {lr && (
        <div className="mt-1.5 pt-1 border-t border-zinc-700/60">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold tracking-widest text-zinc-300">CRUDO G1</span>
            <span className="text-[9px] text-zinc-500">{lr.confirmCount}↑ / {lr.lostCount}↓</span>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] text-zinc-400">
            <div className="flex justify-between"><span>R</span><span className="text-zinc-100">{lr.rawR.toFixed(0)}</span></div>
            <div className="flex justify-between"><span>G</span><span className="text-zinc-100">{lr.rawG.toFixed(0)}</span></div>
            <div className="flex justify-between"><span>B</span><span className="text-zinc-100">{lr.rawB.toFixed(0)}</span></div>
            <div className="flex justify-between"><span>ΣI</span><span className="text-zinc-100">{lr.totalI.toFixed(0)}</span></div>
            <div className="flex justify-between" title="R/(G+B) — firma de hemoglobina (≥1.30)"><span>R/(G+B)</span><span className={lr.absorption >= 1.30 ? 'text-emerald-300' : 'text-red-300'}>{lr.absorption.toFixed(2)}</span></div>
            <div className="flex justify-between" title="redDom = R - (G+B)/2 (≥16)"><span>redDom</span><span className={lr.redDom >= 16 ? 'text-emerald-300' : 'text-red-300'}>{lr.redDom.toFixed(0)}</span></div>
            <div className="flex justify-between" title="textura sub-tile (banda 0.0015–0.15)"><span>texture</span><span className={lr.texture >= 0.0015 && lr.texture <= 0.15 ? 'text-emerald-300' : 'text-red-300'}>{lr.texture.toFixed(3)}</span></div>
            <div className="flex justify-between" title="cobertura (≥0.20)"><span>cover</span><span className={lr.coverage >= 0.20 ? 'text-emerald-300' : 'text-red-300'}>{(lr.coverage * 100).toFixed(0)}%</span></div>
          </div>
        </div>
      )}

      {onCadenceChange && (
        <div className="pointer-events-auto mt-2 flex items-center justify-between gap-1">
          <span className="text-[9px] text-zinc-400 tracking-wide">CADENCIA</span>
          <div className="flex gap-0.5">
            {FORENSIC_CADENCE_OPTIONS.map(ms => {
              const active = cadenceMs === ms;
              return (
                <button
                  key={ms}
                  type="button"
                  onClick={() => onCadenceChange(ms)}
                  className={
                    "px-1.5 py-0.5 rounded text-[9px] font-bold border transition-colors " +
                    (active
                      ? "bg-emerald-600/40 border-emerald-400/70 text-emerald-100"
                      : "bg-zinc-700/30 border-zinc-600/40 text-zinc-300 hover:bg-zinc-600/40")
                  }
                  title={`Una muestra cada ${ms} ms`}
                >
                  {ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {onExport && (
        <button
          type="button"
          onClick={onExport}
          className="pointer-events-auto mt-2 w-full rounded-md border border-emerald-500/50 bg-emerald-600/20 hover:bg-emerald-600/35 active:bg-emerald-600/50 text-emerald-100 text-[10px] font-bold tracking-wide py-1.5 transition-colors"
        >
          EXPORTAR SESIÓN FORENSE
          {typeof sampleCount === "number" && sampleCount > 0 && (
            <span className="ml-1 text-emerald-300/80 font-normal">({sampleCount})</span>
          )}
        </button>
      )}
    </div>
  );
};

export default ForensicGateOverlay;