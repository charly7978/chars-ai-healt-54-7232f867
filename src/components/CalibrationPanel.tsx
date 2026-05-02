/**
 * Calibration Panel Component
 * 
 * UI for device-specific calibration of PPG biometric estimation.
 * Allows users to calibrate SpO2, BP, glucose, and lipids with reference values.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { 
  calibrationManager, 
  CalibrationManager,
  type CalibrationType, 
  type CalibrationProfile 
} from '@/modules/calibration/CalibrationManager';
import { 
  Activity, 
  Heart, 
  Droplet, 
  Beaker, 
  ChevronDown, 
  ChevronUp, 
  CheckCircle2, 
  AlertCircle,
  Trash2,
  Save,
  Plus
} from 'lucide-react';

interface CalibrationPanelProps {
  deviceId: string;
  deviceName: string;
  isOpen: boolean;
  onClose: () => void;
}

const CALIBRATION_TYPES: CalibrationType[] = ['spo2', 'bloodPressure', 'glucose', 'lipids'];

const TYPE_CONFIG: Record<CalibrationType, {
  icon: React.ElementType;
  label: string;
  unit: string;
  color: string;
  min: number;
  max: number;
}> = {
  spo2: {
    icon: Heart,
    label: 'SpO2',
    unit: '%',
    color: 'text-red-400',
    min: 70,
    max: 100,
  },
  bloodPressure: {
    icon: Activity,
    label: 'Presión Arterial',
    unit: 'mmHg',
    color: 'text-blue-400',
    min: 80,
    max: 200,
  },
  glucose: {
    icon: Droplet,
    label: 'Glucosa',
    unit: 'mg/dL',
    color: 'text-cyan-400',
    min: 50,
    max: 400,
  },
  lipids: {
    icon: Beaker,
    label: 'Lípidos',
    unit: 'mg/dL',
    color: 'text-amber-400',
    min: 50,
    max: 500,
  },
};

export const CalibrationPanel: React.FC<CalibrationPanelProps> = ({
  deviceId,
  deviceName,
  isOpen,
  onClose,
}) => {
  const [selectedType, setSelectedType] = useState<CalibrationType>('spo2');
  const [profiles, setProfiles] = useState<Record<CalibrationType, CalibrationProfile | null>>({
    spo2: null,
    bloodPressure: null,
    glucose: null,
    lipids: null,
  });
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [referenceValue, setReferenceValue] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [sessionReadings, setSessionReadings] = useState<Array<{ ref: number; est: number }>>([]);
  const [expandedType, setExpandedType] = useState<CalibrationType | null>(null);

  // Load profiles
  useEffect(() => {
    const loadProfiles = () => {
      const newProfiles: Record<CalibrationType, CalibrationProfile | null> = {
        spo2: null,
        bloodPressure: null,
        glucose: null,
        lipids: null,
      };
      
      for (const type of CALIBRATION_TYPES) {
        newProfiles[type] = calibrationManager.getProfile(deviceId, type);
      }
      
      setProfiles(newProfiles);
    };

    if (isOpen) {
      loadProfiles();
    }
  }, [deviceId, isOpen]);

  // Start calibration session
  const startCalibration = useCallback((type: CalibrationType) => {
    calibrationManager.startSession(type, deviceId, deviceName);
    setSelectedType(type);
    setIsCalibrating(true);
    setReferenceValue('');
    setEstimatedValue('');
    setSessionReadings([]);
  }, [deviceId, deviceName]);

  // Add reading to session
  const addReading = useCallback(() => {
    const ref = parseFloat(referenceValue);
    const est = parseFloat(estimatedValue);

    if (isNaN(ref) || isNaN(est)) return;

    const success = calibrationManager.addReading(ref, est);
    if (success) {
      setSessionReadings(prev => [...prev, { ref, est }]);
      setReferenceValue('');
      setEstimatedValue('');
    }
  }, [referenceValue, estimatedValue]);

  // Complete calibration
  const completeCalibration = useCallback(() => {
    const profile = calibrationManager.completeSession(deviceName);
    if (profile) {
      setProfiles(prev => ({ ...prev, [profile.calibrationType]: profile }));
    }
    setIsCalibrating(false);
    setSessionReadings([]);
  }, [deviceName]);

  // Cancel calibration
  const cancelCalibration = useCallback(() => {
    calibrationManager.cancelSession();
    setIsCalibrating(false);
    setSessionReadings([]);
  }, []);

  // Delete profile
  const deleteProfile = useCallback((type: CalibrationType) => {
    if (confirm(`¿Eliminar calibración de ${TYPE_CONFIG[type].label}?`)) {
      calibrationManager.deleteProfile(deviceId, type);
      setProfiles(prev => ({ ...prev, [type]: null }));
    }
  }, [deviceId]);

  // Export calibration data
  const exportData = useCallback(() => {
    const data = calibrationManager.exportCalibrationData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calibration_${deviceId}_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [deviceId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-lg w-[92%] max-h-[90vh] shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 bg-gradient-to-r from-purple-500/10 to-blue-500/10 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-purple-400" />
            <h3 className="text-white text-sm font-bold">Calibración del Dispositivo</h3>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors"
          >
            <span className="text-slate-400 text-lg">×</span>
          </button>
        </div>

        {/* Device Info */}
        <div className="px-4 py-2 bg-slate-900/50 border-b border-slate-800">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider">Dispositivo</div>
          <div className="text-sm text-slate-300 font-medium">{deviceName}</div>
          <div className="text-[9px] text-slate-500 font-mono">ID: {deviceId.slice(0, 16)}...</div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {isCalibrating ? (
            // Calibration Session UI
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-white font-medium">
                <Activity className="w-4 h-4 text-purple-400" />
                Calibrando: {TYPE_CONFIG[selectedType].label}
              </div>

              {/* Instructions */}
              <div className="bg-slate-900/50 rounded-lg p-3 text-[11px] text-slate-400 leading-relaxed whitespace-pre-line">
                {CalibrationManager.getCalibrationInstructions(selectedType)}
              </div>

              {/* Input Form */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1">
                    Valor de Referencia ({TYPE_CONFIG[selectedType].unit})
                  </label>
                  <input
                    type="number"
                    value={referenceValue}
                    onChange={(e) => setReferenceValue(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500/50"
                    placeholder="Ej: 98"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1">
                    Valor Estimado (APP)
                  </label>
                  <input
                    type="number"
                    value={estimatedValue}
                    onChange={(e) => setEstimatedValue(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500/50"
                    placeholder="Ej: 95"
                  />
                </div>
              </div>

              {/* Add Button */}
              <button
                onClick={addReading}
                disabled={!referenceValue || !estimatedValue}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-all"
              >
                <Plus className="w-4 h-4" />
                Agregar Lectura ({sessionReadings.length + 1})
              </button>

              {/* Readings List */}
              {sessionReadings.length > 0 && (
                <div className="bg-slate-900/50 rounded-lg p-3">
                  <div className="text-[10px] text-slate-500 mb-2">Lecturas:</div>
                  <div className="space-y-1">
                    {sessionReadings.map((reading, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-slate-400">#{i + 1}</span>
                        <span className="text-slate-300">
                          Ref: {reading.ref} → Est: {reading.est}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Complete/Cancel */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={completeCalibration}
                  disabled={sessionReadings.length < 3}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-all"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Completar ({sessionReadings.length}/3)
                </button>
                <button
                  onClick={cancelCalibration}
                  className="flex-1 py-2.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium transition-all"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            // Calibration List UI
            <>
              {CALIBRATION_TYPES.map((type) => {
                const profile = profiles[type];
                const config = TYPE_CONFIG[type];
                const Icon = config.icon;
                const isExpanded = expandedType === type;
                const status = calibrationManager.getCalibrationStatus(deviceId, type);

                return (
                  <div 
                    key={type}
                    className="bg-slate-900/50 rounded-lg overflow-hidden"
                  >
                    {/* Header */}
                    <button
                      onClick={() => setExpandedType(isExpanded ? null : type)}
                      className="w-full px-3 py-3 flex items-center justify-between hover:bg-slate-800/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Icon className={`w-4 h-4 ${config.color}`} />
                        <div className="text-left">
                          <div className="text-sm text-white font-medium">{config.label}</div>
                          <div className="text-[10px] text-slate-500">
                            {status.isCalibrated ? (
                              <span className="text-emerald-400">
                                ✓ Calibrado ({status.sampleCount} muestras, RMSE: {status.rmse.toFixed(1)})
                              </span>
                            ) : (
                              <span className="text-amber-400">
                                ⚠ Sin calibrar ({status.sampleCount} muestras)
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {status.isCalibrated && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteProfile(type);
                            }}
                            className="p-1.5 rounded hover:bg-red-500/20 text-slate-500 hover:text-red-400 transition-colors"
                            title="Eliminar calibración"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-slate-500" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-slate-500" />
                        )}
                      </div>
                    </button>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-3">
                        {profile ? (
                          <div className="space-y-2 text-xs">
                            <div className="flex justify-between">
                              <span className="text-slate-500">Offset:</span>
                              <span className="text-slate-300 font-mono">{profile.offset.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Scale:</span>
                              <span className="text-slate-300 font-mono">{profile.scale.toFixed(3)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Muestras:</span>
                              <span className="text-slate-300">{profile.sampleCount}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">RMSE:</span>
                              <span className={profile.rmse < 10 ? 'text-emerald-400' : 'text-amber-400'}>
                                {profile.rmse.toFixed(2)} {config.unit}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-500">Actualizado:</span>
                              <span className="text-slate-400">
                                {new Date(profile.updatedAt).toLocaleDateString()}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500 leading-relaxed">
                            {CalibrationManager.getCalibrationInstructions(type)}
                          </div>
                        )}

                        <button
                          onClick={() => startCalibration(type)}
                          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-purple-600/80 hover:bg-purple-600 text-white text-xs font-medium transition-all"
                        >
                          {profile ? 'Recalibrar' : 'Iniciar Calibración'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Export Button */}
              <button
                onClick={exportData}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-all"
              >
                <Save className="w-4 h-4" />
                Exportar Datos de Calibración
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CalibrationPanel;
