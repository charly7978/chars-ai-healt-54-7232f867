import { useEffect, useState, useCallback } from "react";
import type { FiducialParams } from "@/modules/beats/FiducialDelineator";
import { DEFAULT_FIDUCIAL_PARAMS } from "@/modules/beats/FiducialDelineator";

/**
 * Runtime controls for the FiducialDelineator.
 *
 * - Mutates the live processor params via setFiducialParams (effective on the
 *   very next processed beat).
 * - Shows the current morphology score & morphology validity from the most
 *   recent accepted beat so the operator sees the impact immediately.
 *
 * Lightweight, themed with semantic tokens, no extra dependencies.
 */
export interface FiducialTunerLiveStats {
  morphologyScore: number;       // 0–100 from latest accepted beat
  morphologyValidity: number;    // 0–1 from latest fiducials
  notchDepth: number;            // 0–1
  riseTimeMs: number;
  pulseWidth50Ms: number;
  reflectionIndex: number;
  beatsAnalyzed: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  getParams: () => FiducialParams | null;
  setParams: (patch: Partial<FiducialParams>) => void;
  liveStats: FiducialTunerLiveStats;
}

type SliderDef = {
  key: keyof FiducialParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  group: "search" | "plausibility" | "validity";
};

const SLIDERS: SliderDef[] = [
  // Search ranges
  { key: "footMaxLookbackMs",     label: "Foot lookback",     min: 200,  max: 1500, step: 10,   unit: "ms",  group: "search" },
  { key: "notchSearchEndMs",      label: "Notch search end",  min: 200,  max: 700,  step: 10,   unit: "ms",  group: "search" },
  { key: "notchTimeWindowMinMs",  label: "Notch ideal min",   min: 60,   max: 300,  step: 5,    unit: "ms",  group: "search" },
  { key: "notchTimeWindowMaxMs",  label: "Notch ideal max",   min: 200,  max: 600,  step: 5,    unit: "ms",  group: "search" },
  { key: "diastolicSearchEndMs",  label: "Diastolic search",  min: 150,  max: 600,  step: 10,   unit: "ms",  group: "search" },
  // Plausibility
  { key: "notchDepthMin",         label: "Notch depth min",   min: 0,    max: 0.30, step: 0.005,unit: "",    group: "plausibility" },
  { key: "notchDepthMax",         label: "Notch depth max",   min: 0.20, max: 0.95, step: 0.01, unit: "",    group: "plausibility" },
  { key: "notchBelowPeakFrac",    label: "Notch < peak (×amp)", min: 0,  max: 0.20, step: 0.005,unit: "",    group: "plausibility" },
  { key: "diastolicMinRiseFrac",  label: "Diast min rise",    min: 0,    max: 0.10, step: 0.002,unit: "",    group: "plausibility" },
  // Validity
  { key: "riseTimeIdealMinMs",    label: "Rise ideal min",    min: 30,   max: 200,  step: 5,    unit: "ms",  group: "validity" },
  { key: "riseTimeIdealMaxMs",    label: "Rise ideal max",    min: 150,  max: 500,  step: 5,    unit: "ms",  group: "validity" },
  { key: "riseTimeWideMinMs",     label: "Rise wide min",     min: 20,   max: 150,  step: 5,    unit: "ms",  group: "validity" },
  { key: "riseTimeWideMaxMs",     label: "Rise wide max",     min: 200,  max: 600,  step: 5,    unit: "ms",  group: "validity" },
  { key: "pulseWidth50MinMs",     label: "PW50 min",          min: 60,   max: 300,  step: 5,    unit: "ms",  group: "validity" },
  { key: "pulseWidth50MaxMs",     label: "PW50 max",          min: 300,  max: 800,  step: 5,    unit: "ms",  group: "validity" },
  { key: "reflectionIdxMin",      label: "Reflection min",    min: 0,    max: 0.6,  step: 0.01, unit: "",    group: "validity" },
  { key: "reflectionIdxMax",      label: "Reflection max",    min: 0.5,  max: 1.5,  step: 0.01, unit: "",    group: "validity" },
];

export const FiducialTuner = ({ open, onClose, getParams, setParams, liveStats }: Props) => {
  const [params, setParamsLocal] = useState<FiducialParams>(DEFAULT_FIDUCIAL_PARAMS);

  useEffect(() => {
    if (!open) return;
    const p = getParams();
    if (p) setParamsLocal(p);
  }, [open, getParams]);

  const update = useCallback((key: keyof FiducialParams, value: number) => {
    setParamsLocal(prev => {
      const next = { ...prev, [key]: value };
      setParams({ [key]: value } as Partial<FiducialParams>);
      return next;
    });
  }, [setParams]);

  const reset = useCallback(() => {
    setParamsLocal(DEFAULT_FIDUCIAL_PARAMS);
    setParams(DEFAULT_FIDUCIAL_PARAMS);
  }, [setParams]);

  if (!open) return null;

  const groups: Array<{ id: SliderDef["group"]; title: string }> = [
    { id: "search",       title: "Search ranges" },
    { id: "plausibility", title: "Plausibility" },
    { id: "validity",     title: "Validity scoring" },
  ];

  return (
    <div
      className="fixed inset-x-2 bottom-2 z-50 rounded-lg border border-border bg-card/95 backdrop-blur-md text-card-foreground shadow-xl max-h-[70vh] overflow-y-auto"
      style={{ fontSize: 11 }}
    >
      <div className="sticky top-0 flex items-center justify-between px-3 py-2 border-b border-border bg-card/95">
        <div className="font-semibold">Fiducial tuner</div>
        <div className="flex gap-2">
          <button
            onClick={reset}
            className="px-2 py-1 rounded border border-border hover:bg-muted"
          >Reset</button>
          <button
            onClick={onClose}
            className="px-2 py-1 rounded bg-primary text-primary-foreground"
          >Close</button>
        </div>
      </div>

      {/* Live stats — updated every frame from Index */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Stat label="MorphScore" value={liveStats.morphologyScore.toFixed(0)} unit="/100" />
        <Stat label="Validity"   value={liveStats.morphologyValidity.toFixed(2)} />
        <Stat label="Beats"      value={String(liveStats.beatsAnalyzed)} />
        <Stat label="Notch"      value={liveStats.notchDepth.toFixed(2)} />
        <Stat label="Rise"       value={liveStats.riseTimeMs.toFixed(0)} unit="ms" />
        <Stat label="PW50"       value={liveStats.pulseWidth50Ms.toFixed(0)} unit="ms" />
      </div>

      {groups.map(g => (
        <div key={g.id} className="px-3 py-2">
          <div className="font-semibold text-muted-foreground mb-1">{g.title}</div>
          <div className="space-y-2">
            {SLIDERS.filter(s => s.group === g.id).map(s => (
              <div key={s.key as string}>
                <div className="flex justify-between mb-0.5">
                  <span>{s.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {(params[s.key] as number).toFixed(s.step < 0.01 ? 3 : s.step < 1 ? 2 : 0)}{s.unit}
                  </span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key] as number}
                  onChange={(e) => update(s.key, parseFloat(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const Stat = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <div className="flex flex-col">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-semibold tabular-nums">
      {value}{unit ? <span className="text-muted-foreground font-normal">{unit}</span> : null}
    </span>
  </div>
);
