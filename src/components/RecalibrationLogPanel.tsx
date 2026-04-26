import React, { useEffect, useState, useCallback } from 'react';
import { Download, Trash2, ChevronDown, ChevronUp, ListOrdered } from 'lucide-react';
import { recalibrationLog, type RecalibrationLogEntry } from '@/utils/recalibrationLog';
import { toast } from '@/hooks/use-toast';

/**
 * RecalibrationLogPanel
 * ---------------------
 * Operator-visible event log of recalibration prompts. Lives as a small
 * fixed pill at the bottom-right that expands into a scrollable list with
 * download (NDJSON) and clear actions. Subscribes to the singleton log so
 * it updates instantly when a new event arrives.
 */

const fmtTime = (iso: string) => {
  // Show local HH:MM:SS — full ISO is preserved in the JSON download.
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
};

const reasonColor: Record<string, string> = {
  quality:    'text-amber-500',
  motion:     'text-orange-500',
  bpm_drift:  'text-rose-500',
  spo2_drift: 'text-sky-500',
};

const RecalibrationLogPanel: React.FC<{ visible: boolean }> = ({ visible }) => {
  const [entries, setEntries] = useState<ReadonlyArray<RecalibrationLogEntry>>(recalibrationLog.snapshot());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    return recalibrationLog.subscribe(setEntries);
  }, []);

  const handleDownload = useCallback(() => {
    if (entries.length === 0) {
      toast({ title: 'Sin eventos', description: 'No hay prompts registrados.', duration: 2000 });
      return;
    }
    const filename = recalibrationLog.download();
    toast({ title: 'Log exportado', description: filename, duration: 2200 });
  }, [entries.length]);

  const handleClear = useCallback(() => {
    recalibrationLog.clear();
    toast({ title: 'Log vacío', duration: 1500 });
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-1 right-1 z-40 safe-bottom safe-right">
      {expanded ? (
        <div className="w-[min(92vw,360px)] max-h-[40vh] flex flex-col rounded-lg border border-border bg-card/95 backdrop-blur-md text-card-foreground shadow-xl">
          <header className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border">
            <span className="flex items-center gap-1 text-xs font-medium">
              <ListOrdered className="w-3.5 h-3.5" />
              Eventos recalibración
              <span className="text-[10px] text-muted-foreground">({entries.length})</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
                aria-label="Descargar log"
                title="Descargar NDJSON"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
                aria-label="Limpiar log"
                title="Limpiar"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
                aria-label="Colapsar"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          </header>
          <ul className="flex-1 overflow-y-auto text-[11px] divide-y divide-border">
            {entries.length === 0 && (
              <li className="px-2 py-3 text-center text-muted-foreground">
                Sin eventos todavía.
              </li>
            )}
            {entries.slice().reverse().map((e) => (
              <li key={e.id} className="px-2 py-1.5 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-medium ${reasonColor[e.reason] ?? 'text-foreground'}`}>
                    {e.reasonLabel}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {fmtTime(e.isoTimestamp)}
                  </span>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground flex flex-wrap gap-x-2">
                  <span>SQI {Math.round(e.metrics.quality)}</span>
                  <span>BPM {e.metrics.bpm > 0 ? Math.round(e.metrics.bpm) : '—'}</span>
                  <span>SpO₂ {e.metrics.spo2 > 0 ? Math.round(e.metrics.spo2) : '—'}</span>
                  <span>mov {e.metrics.motionLevel.replace('_MOTION', '').toLowerCase()}</span>
                  {e.metrics.baselineBpmMean !== null && (
                    <span>Δbpm {(e.metrics.bpm - e.metrics.baselineBpmMean).toFixed(1)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 h-6 px-2 rounded-full bg-card/80 border border-border text-[10px] font-medium text-foreground hover:bg-card backdrop-blur-md"
          aria-label="Abrir log de recalibración"
        >
          <ListOrdered className="w-3 h-3" />
          LOG
          <span className="text-muted-foreground">({entries.length})</span>
          <ChevronUp className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};

export default RecalibrationLogPanel;