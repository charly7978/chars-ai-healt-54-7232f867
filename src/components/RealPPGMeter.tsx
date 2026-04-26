import React, { useEffect, useRef } from 'react';
import type { RealPPGSnapshot } from '@/modules/ppg/types';

interface Props {
  snapshot: RealPPGSnapshot;
}

/**
 * RealPPGMeter — paints ONLY snapshot.publication.waveform.
 * If publication.canPublish === false, draws a flat baseline and a status
 * banner with the rejection reason. There is no other source of pixels.
 */
const RealPPGMeter: React.FC<Props> = ({ snapshot }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width, h = c.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 30) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    if (!snapshot.publication.canPublish || snapshot.publication.waveform.length < 2) {
      ctx.strokeStyle = 'rgba(120,120,120,0.4)';
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
      return;
    }

    const wave = snapshot.publication.waveform;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < wave.length; i++) {
      if (wave[i] < mn) mn = wave[i];
      if (wave[i] > mx) mx = wave[i];
    }
    const range = Math.max(1e-6, mx - mn);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < wave.length; i++) {
      const x = (i / (wave.length - 1)) * w;
      const norm = (wave[i] - mn) / range;
      const y = h - norm * h * 0.85 - h * 0.075;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [snapshot]);

  const status = snapshot.publication.canPublish ? 'PULSO PPG VALIDADO' : 'SIN SEÑAL PPG VALIDADA';
  const reason = snapshot.publication.reason;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-mono">
        <span className={snapshot.publication.canPublish ? 'text-emerald-400' : 'text-zinc-400'}>
          {status}
        </span>
        <span className="text-zinc-500 truncate ml-2">{reason}</span>
      </div>
      <canvas ref={canvasRef} width={640} height={140} className="w-full h-32 block bg-black rounded" />
    </div>
  );
};

export default RealPPGMeter;