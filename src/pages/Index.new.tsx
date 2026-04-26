/**
 * INDEX PAGE - NEW ARCHITECTURE
 * 
 * Simplified page using the new PPG pipeline.
 * 
 * - Uses usePpgEngine as single source of truth
 * - CardiacMonitorCanvas full screen
 * - FloatingVitalsOverlay for vitals
 * - ForensicDebugPanel for diagnostics
 * - No processing in UI components
 */

import React, { useRef, useState, useEffect } from 'react';
import { usePpgEngine } from '@/ppg';
import { CardiacMonitorCanvas } from '@/ppg/ui/CardiacMonitorCanvas';
import { FloatingVitalsOverlay, ControlOverlay } from '@/ppg/ui/FloatingVitalsOverlay';
import { ForensicDebugPanel } from '@/ppg/ui/ForensicDebugPanel';

const Index = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showDebug, setShowDebug] = useState(false);
  
  const { start, stop, reset, setVideoElement, state, engineState } = usePpgEngine();

  // Set video element when available
  useEffect(() => {
    if (videoRef.current) {
      setVideoElement(videoRef.current);
    }
  }, [setVideoElement]);

  const handleStart = async () => {
    await start();
  };

  const handleStop = () => {
    stop();
  };

  const handleReset = () => {
    reset();
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100dvh', overflow: 'hidden' }}>
      {/* Hidden video element for capture */}
      <video
        ref={videoRef}
        style={{ display: 'none' }}
        playsInline
        muted
        autoPlay
      />

      {/* Full-screen cardiac monitor */}
      <CardiacMonitorCanvas
        waveform={{
          g3: engineState.waveform,
          g2: engineState.waveform.map((v, i) => v * 0.5), // Dimmed G2
          beats: engineState.beats.map(b => b.index),
          sampleRate: engineState.cameraStatus.fps || 30,
        }}
        sqi={engineState.sqi?.overall || 0}
        state={state}
      />

      {/* Floating vitals overlay */}
      <FloatingVitalsOverlay
        bpm={engineState.bpm}
        spo2={engineState.spo2}
        sqi={engineState.sqi?.overall || 0}
        perfusionProxy={0} // TODO: from engineState
        canPublish={engineState.publication?.canPublishBpm || false}
        state={state}
        onStart={handleStart}
        onStop={handleStop}
        isMonitoring={state === 'measuring' || state === 'ppg_valid'}
      />

      {/* Control buttons */}
      <ControlOverlay
        onStart={handleStart}
        onStop={handleStop}
        isMonitoring={state === 'measuring' || state === 'ppg_valid'}
      />

      {/* Debug toggle button */}
      <button
        onClick={() => setShowDebug(!showDebug)}
        style={{
          position: 'fixed',
          top: 20,
          left: 20,
          background: 'rgba(0, 0, 0, 0.6)',
          color: '#fff',
          border: '1px solid #333',
          borderRadius: 8,
          padding: '8px 16px',
          cursor: 'pointer',
          zIndex: 20,
          fontFamily: 'monospace',
        }}
      >
        {showDebug ? 'Hide Debug' : 'Debug'}
      </button>

      {/* Forensic debug panel */}
      <ForensicDebugPanel
        visible={showDebug}
        onClose={() => setShowDebug(false)}
        data={{
          camera: {
            videoWidth: engineState.cameraStatus.videoWidth,
            videoHeight: engineState.cameraStatus.videoHeight,
            fpsMedian: engineState.cameraStatus.fps,
            fpsInstant: engineState.cameraStatus.fps,
            torchSupported: true, // TODO: from engineState
            torchActive: engineState.cameraStatus.torchActive,
            trackLabel: 'rear',
            frameIndex: engineState.debug.frameIndex,
            lastFrameAgeMs: engineState.debug.lastFrameAgeMs,
          },
          roi: {
            x: engineState.roi?.x || 0,
            y: engineState.roi?.y || 0,
            width: engineState.roi?.width || 0,
            height: engineState.roi?.height || 0,
            validPixelRatio: 0.8, // TODO: from engineState
            saturationRatio: 0.1,
            darkRatio: 0.05,
            redMean: engineState.rawChannels?.r || 0,
            greenMean: engineState.rawChannels?.g || 0,
            blueMean: engineState.rawChannels?.b || 0,
            redDominance: 1.5,
            roiScore: 0.8,
            state: 'PPG_VALID',
          },
          signal: {
            g1: engineState.g1,
            g2: engineState.g2,
            g3: engineState.g3,
            acR: 0,
            acG: 0,
            acB: 0,
            dcR: 0,
            dcG: 0,
            dcB: 0,
            perfusionProxy: 0,
            motionProxy: 0,
            spectralPeakHz: 1.2,
            spectralPeakRatio: 0.5,
          },
          beats: {
            beatsValid: engineState.beats.length,
            lastRR: engineState.beats.length > 1 ? engineState.beats[engineState.beats.length - 1].rrInterval : 0,
            bpmTime: engineState.bpm || 0,
            bpmFreq: engineState.bpm || 0,
            refractoryRejects: 0,
            prominenceRejects: 0,
            morphologyRejects: 0,
          },
          publication: {
            canPublishBpm: engineState.publication?.canPublishBpm || false,
            canPublishSpo2: engineState.publication?.canPublishSpo2 || false,
            blockReasons: engineState.publication?.blockReasons || [],
            currentStatus: engineState.publication?.currentStatus || state,
            publishedBpm: engineState.bpm,
            publishedSpo2: engineState.spo2,
          },
        }}
      />
    </div>
  );
};

export default Index;
