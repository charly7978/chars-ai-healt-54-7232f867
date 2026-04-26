import React, { useCallback, useEffect, useRef, useState } from 'react';
import CameraView, { type CameraViewHandle } from '@/components/CameraView';
import RealPPGMeter from '@/components/RealPPGMeter';
import ForensicDebugPanel from '@/components/ForensicDebugPanel';
import { useRealPPG } from '@/hooks/useRealPPG';
import { Heart, Power, Download } from 'lucide-react';

/**
 * Index — RealPPG single source of truth.
 * No fallbacks, no defaults, no preserved values.
 * Everything visible derives from snapshot.publication.canPublish.
 */
const Index: React.FC = () => {
  const cameraRef = useRef<CameraViewHandle | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [debugVisible, setDebugVisible] = useState(true);
  const sessionLogRef = useRef<unknown[]>([]);
  const [exportCount, setExportCount] = useState(0);

  const { snapshot, reset } = useRealPPG({ active: isMonitoring, videoEl, vibrate: true });

  // When monitoring turns on we wait one frame for CameraView to attach the
  // <video> and grab it through the imperative handle.
  useEffect(() => {
    if (!isMonitoring) { setVideoEl(null); return; }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const v = cameraRef.current?.getVideoElement?.() ?? null;
      if (v && v.videoWidth > 0) { setVideoEl(v); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [isMonitoring]);

  // Log every snapshot for forensic export — only the fields that matter.
  useEffect(() => {
    if (!isMonitoring || !snapshot.frame) return;
    sessionLogRef.current.push({
      t: snapshot.frame.tMs,
      idx: snapshot.frameIndex,
      fps: snapshot.fps,
      r: snapshot.frame.redLinear, g: snapshot.frame.greenLinear, b: snapshot.frame.blueLinear,
      rOD: snapshot.frame.redOD, gOD: snapshot.frame.greenOD, bOD: snapshot.frame.blueOD,
      clipH: snapshot.frame.clipHighRatio, clipL: snapshot.frame.clipLowRatio,
      uniformity: snapshot.frame.spatialUniformity, motion: snapshot.frame.motionProxy,
      opt: snapshot.optical.opticalContact, tissue: snapshot.optical.tissueCandidate,
      perf: snapshot.optical.perfusionCandidate, opt_reason: snapshot.optical.reason,
      src: snapshot.extracted.selectedSource, srcQ: snapshot.extracted.sourceQuality,
      filtered: snapshot.extracted.filteredValue,
      cardiac: snapshot.cardiac.cardiacEvidence, dom: snapshot.cardiac.dominantHz,
      specSQI: snapshot.cardiac.spectralSQI, peakSQI: snapshot.cardiac.peakSQI,
      cohere: snapshot.cardiac.channelCoherence, c_reason: snapshot.cardiac.reason,
      acc: snapshot.beat.acceptedBeat, bpmInst: snapshot.beat.bpmInstant,
      bpmMed: snapshot.beat.bpmMedian,
      pub: snapshot.publication.canPublish, pub_reason: snapshot.publication.reason,
      pubBPM: snapshot.publication.bpm,
    });
    if (sessionLogRef.current.length > 6000) sessionLogRef.current.splice(0, 1000);
    if (sessionLogRef.current.length % 30 === 0) setExportCount(sessionLogRef.current.length);
  }, [snapshot, isMonitoring]);

  const onStart = useCallback(() => {
    sessionLogRef.current = [];
    setExportCount(0);
    reset();
    setIsMonitoring(true);
  }, [reset]);

  const onStop = useCallback(() => {
    setIsMonitoring(false);
    reset();
  }, [reset]);

  const onExport = useCallback(() => {
    const data = sessionLogRef.current;
    if (data.length === 0) return;
    const blob = new Blob([JSON.stringify({
      session: `realppg_${Date.now()}`,
      created: new Date().toISOString(),
      samples: data,
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `realppg_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const bpmDisplay = snapshot.publication.canPublish && snapshot.publication.bpm
    ? snapshot.publication.bpm
    : null;

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-sm font-mono tracking-widest">REAL-PPG · CAMERA PULSE</h1>
        <button
          type="button"
          onClick={() => setDebugVisible(v => !v)}
          className="text-[10px] font-mono px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800"
        >
          {debugVisible ? 'HIDE DEBUG' : 'SHOW DEBUG'}
        </button>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-2 p-2">
        <section className="space-y-2 min-w-0">
          <div className="relative aspect-video w-full bg-black rounded overflow-hidden border border-zinc-800">
            <CameraView ref={cameraRef} isMonitoring={isMonitoring} />
            {!isMonitoring && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-zinc-500 text-xs font-mono">CAMERA OFF</p>
              </div>
            )}
          </div>

          <div className="rounded border border-zinc-800 p-2 bg-zinc-950">
            <RealPPGMeter snapshot={snapshot} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-zinc-800 bg-zinc-950 p-3 text-center">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Heart Rate</div>
              <div className={`text-3xl font-mono ${bpmDisplay ? 'text-emerald-300' : 'text-zinc-600'}`}>
                {bpmDisplay ?? '--'}
              </div>
              <div className="text-[10px] text-zinc-500">BPM</div>
            </div>
            <div className="rounded border border-zinc-800 bg-zinc-950 p-3 text-center">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Beats</div>
              <div className={`text-3xl font-mono ${snapshot.publication.canPublish ? 'text-emerald-300' : 'text-zinc-600'}`}>
                {snapshot.beat.beats.length}
              </div>
              <div className="text-[10px] text-zinc-500">accepted</div>
            </div>
          </div>

          <div className="flex gap-2">
            {!isMonitoring ? (
              <button
                type="button"
                onClick={onStart}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded bg-emerald-600 hover:bg-emerald-500 font-mono text-sm tracking-wider"
              >
                <Heart className="w-4 h-4" /> START
              </button>
            ) : (
              <button
                type="button"
                onClick={onStop}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded bg-red-600 hover:bg-red-500 font-mono text-sm tracking-wider"
              >
                <Power className="w-4 h-4" /> STOP
              </button>
            )}
            <button
              type="button"
              onClick={onExport}
              disabled={exportCount === 0}
              className="flex items-center justify-center gap-2 py-3 px-4 rounded bg-zinc-800 hover:bg-zinc-700 font-mono text-sm tracking-wider disabled:opacity-40"
            >
              <Download className="w-4 h-4" /> EXPORT
            </button>
          </div>
        </section>

        <aside className="min-w-0">
          {debugVisible && (
            <ForensicDebugPanel
              snapshot={snapshot}
              onExport={onExport}
              exportCount={exportCount}
            />
          )}
        </aside>
      </main>

      <footer className="px-3 py-1 text-[10px] text-zinc-500 font-mono border-t border-zinc-800">
        Real evidence only · No fallbacks · No fabricated values
      </footer>
    </div>
  );
};

export default Index;