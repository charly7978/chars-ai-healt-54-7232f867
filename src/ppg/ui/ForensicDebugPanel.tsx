/**
 * FORENSIC DEBUG PANEL
 * 
 * Drawer with detailed forensic metrics.
 * 
 * Sections:
 * - RAW CAMERA: videoWidth/Height, fps, torch, track, frameIndex, lastFrameAge
 * - ROI: x/y/w/h, validPixelRatio, saturationRatio, darkRatio, means, redDominance, score, state
 * - SIGNAL: G1/G2/G3, AC/DC, perfusionProxy, motionProxy, spectralPeakHz/Ratio
 * - BEATS: beatsValid, lastRR, BPM_time, BPM_freq, rejects
 * - PUBLICATION: canPublishBpm/SpO2, blockReasons, currentStatus, published values
 */

import React, { useState } from 'react';

export interface ForensicDebugData {
  camera: {
    videoWidth: number;
    videoHeight: number;
    fpsMedian: number;
    fpsInstant: number;
    torchSupported: boolean;
    torchActive: boolean;
    trackLabel: string;
    frameIndex: number;
    lastFrameAgeMs: number;
  };
  roi: {
    x: number;
    y: number;
    width: number;
    height: number;
    validPixelRatio: number;
    saturationRatio: number;
    darkRatio: number;
    redMean: number;
    greenMean: number;
    blueMean: number;
    redDominance: number;
    roiScore: number;
    state: string;
  };
  signal: {
    g1: number;
    g2: number;
    g3: number;
    acR: number;
    acG: number;
    acB: number;
    dcR: number;
    dcG: number;
    dcB: number;
    perfusionProxy: number;
    motionProxy: number;
    spectralPeakHz: number;
    spectralPeakRatio: number;
  };
  beats: {
    beatsValid: number;
    lastRR: number;
    bpmTime: number;
    bpmFreq: number;
    refractoryRejects: number;
    prominenceRejects: number;
    morphologyRejects: number;
  };
  publication: {
    canPublishBpm: boolean;
    canPublishSpo2: boolean;
    blockReasons: string[];
    currentStatus: string;
    publishedBpm: number | null;
    publishedSpo2: number | null;
  };
}

export const ForensicDebugPanel: React.FC<{
  data: ForensicDebugData;
  visible: boolean;
  onClose: () => void;
}> = ({ data, visible, onClose }) => {
  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: 400,
        height: '100dvh',
        background: 'rgba(0, 0, 0, 0.95)',
        backdropFilter: 'blur(10px)',
        zIndex: 100,
        overflow: 'auto',
        padding: 20,
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#fff',
      }}
    >
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          background: '#ff0000',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '8px 16px',
          cursor: 'pointer',
        }}
      >
        Close
      </button>

      <h2 style={{ marginTop: 40, marginBottom: 20 }}>FORENSIC DEBUG</h2>

      {/* RAW CAMERA */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ color: '#00ff00', marginBottom: 8 }}>RAW CAMERA</h3>
        <div>videoWidth: {data.camera.videoWidth}</div>
        <div>videoHeight: {data.camera.videoHeight}</div>
        <div>fpsMedian: {data.camera.fpsMedian.toFixed(1)}</div>
        <div>fpsInstant: {data.camera.fpsInstant.toFixed(1)}</div>
        <div>torchSupported: {data.camera.torchSupported ? 'YES' : 'NO'}</div>
        <div>torchActive: {data.camera.torchActive ? 'YES' : 'NO'}</div>
        <div>trackLabel: {data.camera.trackLabel}</div>
        <div>frameIndex: {data.camera.frameIndex}</div>
        <div>lastFrameAgeMs: {data.camera.lastFrameAgeMs.toFixed(0)}</div>
      </div>

      {/* ROI */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ color: '#00ff00', marginBottom: 8 }}>ROI</h3>
        <div>x: {data.roi.x}</div>
        <div>y: {data.roi.y}</div>
        <div>width: {data.roi.width}</div>
        <div>height: {data.roi.height}</div>
        <div>validPixelRatio: {(data.roi.validPixelRatio * 100).toFixed(1)}%</div>
        <div>saturationRatio: {(data.roi.saturationRatio * 100).toFixed(1)}%</div>
        <div>darkRatio: {(data.roi.darkRatio * 100).toFixed(1)}%</div>
        <div>redMean: {data.roi.redMean.toFixed(1)}</div>
        <div>greenMean: {data.roi.greenMean.toFixed(1)}</div>
        <div>blueMean: {data.roi.blueMean.toFixed(1)}</div>
        <div>redDominance: {data.roi.redDominance.toFixed(2)}</div>
        <div>roiScore: {data.roi.roiScore.toFixed(3)}</div>
        <div>state: {data.roi.state}</div>
      </div>

      {/* SIGNAL */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ color: '#00ff00', marginBottom: 8 }}>SIGNAL</h3>
        <div>G1: {data.signal.g1.toFixed(4)}</div>
        <div>G2: {data.signal.g2.toFixed(4)}</div>
        <div>G3: {data.signal.g3.toFixed(4)}</div>
        <div>AC_R: {data.signal.acR.toFixed(4)}</div>
        <div>AC_G: {data.signal.acG.toFixed(4)}</div>
        <div>AC_B: {data.signal.acB.toFixed(4)}</div>
        <div>DC_R: {data.signal.dcR.toFixed(4)}</div>
        <div>DC_G: {data.signal.dcG.toFixed(4)}</div>
        <div>DC_B: {data.signal.dcB.toFixed(4)}</div>
        <div>perfusionProxy: {data.signal.perfusionProxy.toFixed(4)}</div>
        <div>motionProxy: {data.signal.motionProxy.toFixed(4)}</div>
        <div>spectralPeakHz: {data.signal.spectralPeakHz.toFixed(2)}</div>
        <div>spectralPeakRatio: {data.signal.spectralPeakRatio.toFixed(3)}</div>
      </div>

      {/* BEATS */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ color: '#00ff00', marginBottom: 8 }}>BEATS</h3>
        <div>beatsValid: {data.beats.beatsValid}</div>
        <div>lastRR: {data.beats.lastRR.toFixed(0)} ms</div>
        <div>BPM_time: {data.beats.bpmTime.toFixed(0)}</div>
        <div>BPM_freq: {data.beats.bpmFreq.toFixed(0)}</div>
        <div>refractoryRejects: {data.beats.refractoryRejects}</div>
        <div>prominenceRejects: {data.beats.prominenceRejects}</div>
        <div>morphologyRejects: {data.beats.morphologyRejects}</div>
      </div>

      {/* PUBLICATION */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ color: '#00ff00', marginBottom: 8 }}>PUBLICATION</h3>
        <div>canPublishBpm: {data.publication.canPublishBpm ? 'YES' : 'NO'}</div>
        <div>canPublishSpo2: {data.publication.canPublishSpo2 ? 'YES' : 'NO'}</div>
        <div>currentStatus: {data.publication.currentStatus}</div>
        <div>publishedBpm: {data.publication.publishedBpm ?? 'null'}</div>
        <div>publishedSpo2: {data.publication.publishedSpo2 ?? 'null'}</div>
        <div style={{ marginTop: 8, color: '#ff6666' }}>blockReasons:</div>
        {data.publication.blockReasons.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {data.publication.blockReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        ) : (
          <div style={{ color: '#00ff00' }}>None</div>
        )}
      </div>
    </div>
  );
};
