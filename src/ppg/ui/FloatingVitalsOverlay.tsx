/**
 * FLOATING VITALS OVERLAY
 * 
 * Minimal, transparent overlay for vital signs.
 * 
 * Rules:
 * - Minimal, floating, transparent
 * - Don't cover cardiac activity
 * - Show BPM only if published
 * - Show SpO2 only if calibrated and published
 * - Show SQI, perfusionProxy
 * - ROI mini preview optional
 */

import React from 'react';

export interface FloatingVitalsProps {
  bpm: number | null;
  spo2: number | null;
  sqi: number;
  perfusionProxy: number;
  canPublish: boolean;
  state: string;
  onStart: () => void;
  onStop: () => void;
  isMonitoring: boolean;
}

export const FloatingVitalsOverlay: React.FC<FloatingVitalsProps> = ({
  bpm,
  spo2,
  sqi,
  perfusionProxy,
  canPublish,
  state,
  onStart,
  onStop,
  isMonitoring,
}) => {
  return (
    <div
      style={{
        position: 'fixed',
        top: 20,
        right: 20,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        pointerEvents: 'none',
      }}
    >
      {/* BPM Card */}
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(10px)',
          borderRadius: 12,
          padding: 16,
          minWidth: 120,
          pointerEvents: 'auto',
        }}
      >
        <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>BPM</div>
        <div
          style={{
            color: bpm !== null && canPublish ? '#00ff00' : '#ff0000',
            fontSize: 36,
            fontWeight: 'bold',
            fontFamily: 'monospace',
          }}
        >
          {bpm !== null && canPublish ? bpm : '--'}
        </div>
      </div>

      {/* SpO2 Card */}
      {spo2 !== null && (
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(10px)',
            borderRadius: 12,
            padding: 16,
            minWidth: 120,
            pointerEvents: 'auto',
          }}
        >
          <div style={{ color: '#888', fontSize: 12, marginBottom: 4 }}>SpO2</div>
          <div
            style={{
              color: '#00bfff',
              fontSize: 36,
              fontWeight: 'bold',
              fontFamily: 'monospace',
            }}
          >
            {spo2.toFixed(0)}%
          </div>
        </div>
      )}

      {/* SQI */}
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(10px)',
          borderRadius: 12,
          padding: 12,
          minWidth: 120,
          pointerEvents: 'auto',
        }}
      >
        <div style={{ color: '#888', fontSize: 12 }}>SQI</div>
        <div
          style={{
            color: sqi > 0.65 ? '#00ff00' : '#ff0000',
            fontSize: 20,
            fontWeight: 'bold',
            fontFamily: 'monospace',
          }}
        >
          {sqi.toFixed(2)}
        </div>
      </div>

      {/* Perfusion */}
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(10px)',
          borderRadius: 12,
          padding: 12,
          minWidth: 120,
          pointerEvents: 'auto',
        }}
      >
        <div style={{ color: '#888', fontSize: 12 }}>Perfusion</div>
        <div
          style={{
            color: '#fff',
            fontSize: 16,
            fontFamily: 'monospace',
          }}
        >
          {perfusionProxy.toFixed(4)}
        </div>
      </div>

      {/* State */}
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(10px)',
          borderRadius: 12,
          padding: 12,
          minWidth: 120,
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            color: '#fff',
            fontSize: 12,
            fontFamily: 'monospace',
            textTransform: 'uppercase',
          }}
        >
          {state}
        </div>
      </div>
    </div>
  );
};

// Control buttons overlay (bottom)
export const ControlOverlay: React.FC<{
  onStart: () => void;
  onStop: () => void;
  isMonitoring: boolean;
}> = ({ onStart, onStop, isMonitoring }) => {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        gap: 16,
      }}
    >
      <button
        onClick={isMonitoring ? onStop : onStart}
        style={{
          background: isMonitoring ? '#ff0000' : '#00ff00',
          color: '#000',
          border: 'none',
          borderRadius: 50,
          padding: '16px 48px',
          fontSize: 18,
          fontWeight: 'bold',
          cursor: 'pointer',
          textTransform: 'uppercase',
        }}
      >
        {isMonitoring ? 'Stop' : 'Start'}
      </button>
    </div>
  );
};
