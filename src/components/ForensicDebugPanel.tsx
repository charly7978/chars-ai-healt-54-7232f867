import React from 'react';
import type { RealPPGSnapshot } from '@/modules/ppg/types';

interface Props {
  snapshot: RealPPGSnapshot;
  onExport: () => void;
  exportCount: number;
}

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex justify-between gap-2 leading-tight">
    <span className="text-zinc-400">{label}</span>
    <span className="text-zinc-100 font-mono text-right">{value}</span>
  </div>
);

const ForensicDebugPanel: React.FC<Props> = ({ snapshot, onExport, exportCount }) => {
  const f = snapshot.frame;
  const o = snapshot.optical;
  const e = snapshot.extracted;
  const c = snapshot.cardiac;
  const b = snapshot.beat;
  const p = snapshot.publication;

  return (
    <div className="text-[10px] text-zinc-200 bg-black/85 border border-zinc-700 rounded-md p-2 space-y-2 font-mono">
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-widest text-zinc-300">FORENSIC DEBUG</span>
        <span className={p.canPublish ? 'text-emerald-300' : 'text-red-300'}>
          {p.canPublish ? 'CAN PUBLISH' : 'BLOCKED'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">Frame</div>
          <Row label="idx" value={snapshot.frameIndex} />
          <Row label="fps" value={snapshot.fps.toFixed(1)} />
          <Row label="ROI" value={f ? `${f.roi.w}×${f.roi.h}` : '—'} />
          <Row label="px" value={f?.roi.pixels ?? 0} />
        </div>
        <div className="space-y-0.5">
          <div className="text-[9px] uppercase tracking-wider text-zinc-500">RGB lin</div>
          <Row label="R" value={f?.redLinear.toFixed(3) ?? '—'} />
          <Row label="G" value={f?.greenLinear.toFixed(3) ?? '—'} />
          <Row label="B" value={f?.blueLinear.toFixed(3) ?? '—'} />
          <Row label="clipH" value={f ? (f.clipHighRatio * 100).toFixed(1) + '%' : '—'} />
        </div>
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">Optical Gate</div>
        <Row label="contact" value={o.opticalContact ? '✓' : '✗'} />
        <Row label="tissue" value={o.tissueCandidate ? '✓' : '✗'} />
        <Row label="perf" value={o.perfusionCandidate ? '✓' : '✗'} />
        <Row label="R/G" value={o.metrics.rgRatio.toFixed(2)} />
        <Row label="PI R" value={(o.metrics.perfusionIndexRed * 100).toFixed(2) + '%'} />
        <Row label="PI G" value={(o.metrics.perfusionIndexGreen * 100).toFixed(2) + '%'} />
        <Row label="reason" value={<span className="text-amber-300">{o.reason}</span>} />
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">Extractor</div>
        <Row label="src" value={e.selectedSource} />
        <Row label="srcQ" value={e.sourceQuality.toFixed(2)} />
        <Row label="fs" value={e.sampleRate.toFixed(1) + ' Hz'} />
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">Cardiac</div>
        <Row label="evidence" value={c.cardiacEvidence ? '✓' : '✗'} />
        <Row label="domHz" value={c.dominantHz.toFixed(2)} />
        <Row label="bpm?" value={c.bpmCandidate ?? '—'} />
        <Row label="specSQI" value={c.spectralSQI.toFixed(2)} />
        <Row label="peakSQI" value={c.peakSQI.toFixed(2)} />
        <Row label="cohere" value={c.channelCoherence.toFixed(2)} />
        <Row label="reason" value={<span className="text-amber-300">{c.reason}</span>} />
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wider text-zinc-500">Beats / Publication</div>
        <Row label="beats" value={b.beats.length} />
        <Row label="bpmInst" value={b.bpmInstant ?? '—'} />
        <Row label="bpmMed" value={b.bpmMedian ?? '—'} />
        <Row label="vibrate" value={snapshot.vibrationAllowed ? '✓' : '✗'} />
        <Row label="canPub" value={p.canPublish ? '✓' : '✗'} />
        <Row label="bpm pub" value={p.bpm ?? '—'} />
        <Row label="reason" value={<span className="text-amber-300 truncate inline-block max-w-[140px]">{p.reason}</span>} />
      </div>

      <button
        type="button"
        onClick={onExport}
        className="w-full mt-1 rounded bg-emerald-600/30 border border-emerald-500/60 text-emerald-100 py-1 text-[10px] font-bold tracking-wide hover:bg-emerald-600/50"
      >
        EXPORT SESSION ({exportCount})
      </button>
    </div>
  );
};

export default ForensicDebugPanel;