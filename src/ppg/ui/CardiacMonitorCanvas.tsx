/**
 * CARDIAC MONITOR CANVAS
 * 
 * Full-screen cardiac monitor with high-DPI canvas.
 * 
 * Rules:
 * - position: fixed, inset: 0, width: 100vw, height: 100dvh
 * - Cardiac monitor is the main background
 * - Waveform should be large, sharp, edge-to-edge
 * - High-DPI canvas: canvas.width = clientWidth * devicePixelRatio
 * - Display G3 primary, G2 secondary
 * - Beat markers, baseline, temporal scale
 * - SQI in corner
 */

import React, { useRef, useEffect, useCallback } from 'react';

export interface WaveformData {
  g3: number[];
  g2: number[];
  beats: number[];
  sampleRate: number;
}

export interface CardiacMonitorProps {
  waveform: WaveformData;
  sqi: number;
  state: string;
}

export const CardiacMonitorCanvas: React.FC<CardiacMonitorProps> = ({
  waveform,
  sqi,
  state,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * dpr;
    const height = canvas.clientHeight * dpr;

    // Set canvas size for high-DPI
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      ctx.scale(dpr, dpr);
    }

    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, clientWidth, clientHeight);

    // Draw grid
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    const gridSize = 50;
    
    for (let x = 0; x < clientWidth; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, clientHeight);
      ctx.stroke();
    }
    
    for (let y = 0; y < clientHeight; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(clientWidth, y);
      ctx.stroke();
    }

    // Draw baseline
    const baselineY = clientHeight / 2;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(clientWidth, baselineY);
    ctx.stroke();

    // Draw G2 (secondary, dim)
    if (waveform.g2.length > 1) {
      ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      const xStep = clientWidth / waveform.g2.length;
      const yScale = clientHeight * 0.3;
      
      for (let i = 0; i < waveform.g2.length; i++) {
        const x = i * xStep;
        const y = baselineY - waveform.g2[i] * yScale;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Draw G3 (primary, bright)
    if (waveform.g3.length > 1) {
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 3;
      ctx.beginPath();
      
      const xStep = clientWidth / waveform.g3.length;
      const yScale = clientHeight * 0.4;
      
      for (let i = 0; i < waveform.g3.length; i++) {
        const x = i * xStep;
        const y = baselineY - waveform.g3[i] * yScale;
        
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Draw beat markers
    if (waveform.beats.length > 0) {
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      
      const xStep = clientWidth / waveform.g3.length;
      
      waveform.beats.forEach(beatIndex => {
        const x = beatIndex * xStep;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, clientHeight);
        ctx.stroke();
      });
    }

    // Draw SQI in corner
    ctx.fillStyle = '#fff';
    ctx.font = '14px monospace';
    ctx.fillText(`SQI: ${sqi.toFixed(2)}`, 10, 20);
    
    // Draw state
    ctx.fillStyle = sqi > 0.65 ? '#00ff00' : '#ff0000';
    ctx.fillText(state, 10, 40);

    // Draw temporal scale
    ctx.fillStyle = '#666';
    ctx.font = '12px monospace';
    const duration = waveform.g3.length / waveform.sampleRate;
    ctx.fillText(`${duration.toFixed(1)}s`, clientWidth - 50, clientHeight - 10);

  }, [waveform, sqi, state]);

  useEffect(() => {
    const animate = () => {
      draw();
      animationRef.current = requestAnimationFrame(animate);
    };
    
    animationRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100dvh',
        zIndex: 0,
      }}
    />
  );
};
