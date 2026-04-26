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
}

interface Props {
  gate: ForensicGateSnapshot | null;
  visible: boolean;
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

const ForensicGateOverlay: React.FC<Props> = ({ gate, visible }) => {
  if (!visible) return null;

  const g1 = gate?.gate1_optical ?? null;
  const g2 = gate?.gate2_spectral ?? null;
  const g3 = gate?.gate3_morphology ?? null;
  const passAll = !!gate?.passAll;
  const snrDb = gate?.cardiacSNRdB ?? 0;
  const peakHz = gate?.spectralPeakHz ?? 0;
  const conc = gate?.spectralConcentration ?? 0;
  const reason = gate?.livenessReason ?? "ESPERANDO SEÑAL";
  const reasonShort = reason.length > 48 ? reason.slice(0, 47) + "…" : reason;
  const bpmEstimate = peakHz > 0 ? Math.round(peakHz * 60) : 0;

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
        {passAll ? "PULSO REAL DETECTADO" : "SIN PULSO VÁLIDO"}
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
        <div
          className="flex justify-between gap-2 pt-0.5 border-t border-zinc-700/60 mt-1"
          title={reason}
        >
          <span className="text-zinc-400 shrink-0">Razón</span>
          <span className="text-zinc-200 truncate text-right">{reasonShort}</span>
        </div>
      </div>

      <div className="mt-1.5 pt-1 border-t border-zinc-700/60 text-[9px] text-zinc-500 leading-tight">
        G1 firma hemoglobina · G2 SNR ≥ 6 dB · G3 morfología 4/4
      </div>
    </div>
  );
};

export default ForensicGateOverlay;