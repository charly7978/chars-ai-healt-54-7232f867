/**
 * Calibration Manager
 * 
 * Manages device-specific calibration profiles for PPG biometric estimation.
 * Stores calibration data in localStorage for persistence across sessions.
 * 
 * Supports calibration for:
 * - SpO2 (requires reference pulse oximeter reading)
 * - Blood Pressure (requires cuff reference)
 * - Glucose (requires glucometer reference)
 * - Lipids (requires lab reference)
 */

import { parameterRegistry } from '@/config/medical-parameter-registry/loader';

export type CalibrationType = 'spo2' | 'bloodPressure' | 'glucose' | 'lipids';

export interface CalibrationPoint {
  timestamp: number;
  referenceValue: number;  // Known reference reading
  estimatedValue: number;  // PPG estimation at time of calibration
  rawFeatures: Record<string, number>;  // PPG features used
  confidence: number;
  notes?: string;
}

export interface CalibrationProfile {
  deviceId: string;
  deviceName: string;
  calibrationType: CalibrationType;
  createdAt: number;
  updatedAt: number;
  points: CalibrationPoint[];
  coefficients: Record<string, number>;  // Adjusted from population baseline
  offset: number;  // Simple offset calibration
  scale: number;   // Scale factor calibration
  rmse: number;    // Root mean square error vs reference
  sampleCount: number;
  isValid: boolean;
}

export interface CalibrationSession {
  id: string;
  type: CalibrationType;
  deviceId: string;
  startTime: number;
  readings: Array<{
    timestamp: number;
    reference: number;
    estimated: number;
  }>;
}

const STORAGE_KEY = 'ppg_calibration_profiles';
const SESSION_KEY = 'ppg_calibration_session';

/**
 * CalibrationManager - Manages device calibration profiles
 */
export class CalibrationManager {
  private profiles: Map<string, CalibrationProfile> = new Map();
  private currentSession: CalibrationSession | null = null;

  constructor() {
    this.loadProfiles();
  }

  /**
   * Load all calibration profiles from localStorage
   */
  private loadProfiles(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        this.profiles = new Map(Object.entries(parsed));
        console.log(`[CALIBRATION] Loaded ${this.profiles.size} profiles`);
      }
    } catch (err) {
      console.error('[CALIBRATION] Failed to load profiles:', err);
    }
  }

  /**
   * Save all profiles to localStorage
   */
  private saveProfiles(): void {
    try {
      const obj = Object.fromEntries(this.profiles);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (err) {
      console.error('[CALIBRATION] Failed to save profiles:', err);
    }
  }

  /**
   * Get profile key for a device and calibration type
   */
  private getProfileKey(deviceId: string, type: CalibrationType): string {
    return `${deviceId}_${type}`;
  }

  /**
   * Get existing calibration profile
   */
  getProfile(deviceId: string, type: CalibrationType): CalibrationProfile | null {
    return this.profiles.get(this.getProfileKey(deviceId, type)) || null;
  }

  /**
   * Check if device has valid calibration for type
   */
  hasCalibration(deviceId: string, type: CalibrationType): boolean {
    const profile = this.getProfile(deviceId, type);
    return profile?.isValid && profile.sampleCount >= 3;
  }

  /**
   * Get all profiles for a device
   */
  getDeviceProfiles(deviceId: string): CalibrationProfile[] {
    return Array.from(this.profiles.values())
      .filter(p => p.deviceId === deviceId);
  }

  /**
   * Get all unique device IDs with calibration
   */
  getCalibratedDevices(): string[] {
    const devices = new Set<string>();
    for (const profile of this.profiles.values()) {
      if (profile.isValid) {
        devices.add(profile.deviceId);
      }
    }
    return Array.from(devices);
  }

  /**
   * Start a new calibration session
   */
  startSession(type: CalibrationType, deviceId: string, deviceName: string): CalibrationSession {
    const session: CalibrationSession = {
      id: `cal_${Date.now()}`,
      type,
      deviceId,
      startTime: Date.now(),
      readings: [],
    };
    
    this.currentSession = session;
    
    // Save session to localStorage for recovery
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (err) {
      console.error('[CALIBRATION] Failed to save session:', err);
    }

    console.log(`[CALIBRATION] Started ${type} session for ${deviceName} (${deviceId})`);
    return session;
  }

  /**
   * Add a reading to current calibration session
   */
  addReading(reference: number, estimated: number): boolean {
    if (!this.currentSession) {
      console.warn('[CALIBRATION] No active session');
      return false;
    }

    this.currentSession.readings.push({
      timestamp: Date.now(),
      reference,
      estimated,
    });

    // Update stored session
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.currentSession));
    } catch (err) {
      console.error('[CALIBRATION] Failed to update session:', err);
    }

    return true;
  }

  /**
   * Complete calibration session and save profile
   */
  completeSession(deviceName: string): CalibrationProfile | null {
    if (!this.currentSession) {
      console.warn('[CALIBRATION] No active session to complete');
      return null;
    }

    const { deviceId, type, readings } = this.currentSession;

    if (readings.length < 3) {
      console.warn('[CALIBRATION] Insufficient readings (need 3+)', readings.length);
      return null;
    }

    // Calculate calibration coefficients
    const refMean = readings.reduce((sum, r) => sum + r.reference, 0) / readings.length;
    const estMean = readings.reduce((sum, r) => sum + r.estimated, 0) / readings.length;
    
    // Simple linear regression for offset and scale
    let numerator = 0;
    let denominator = 0;
    
    for (const r of readings) {
      const refDiff = r.reference - refMean;
      const estDiff = r.estimated - estMean;
      numerator += refDiff * estDiff;
      denominator += estDiff * estDiff;
    }
    
    const scale = denominator > 0 ? numerator / denominator : 1.0;
    const offset = refMean - scale * estMean;

    // Calculate RMSE
    let rmse = 0;
    for (const r of readings) {
      const corrected = r.estimated * scale + offset;
      rmse += (corrected - r.reference) ** 2;
    }
    rmse = Math.sqrt(rmse / readings.length);

    // Get population baseline coefficients from registry
    const config = parameterRegistry.getCalibrationModel(type);
    const baselineCoefficients = { ...config.coefficients };

    // Create profile
    const profile: CalibrationProfile = {
      deviceId,
      deviceName,
      calibrationType: type,
      createdAt: this.currentSession.startTime,
      updatedAt: Date.now(),
      points: readings.map(r => ({
        timestamp: r.timestamp,
        referenceValue: r.reference,
        estimatedValue: r.estimated,
        rawFeatures: {},  // Would be populated by caller
        confidence: 0.8,
      })),
      coefficients: baselineCoefficients,
      offset,
      scale,
      rmse,
      sampleCount: readings.length,
      isValid: rmse < this.getMaxAcceptableRMSE(type),
    };

    // Save profile
    this.profiles.set(this.getProfileKey(deviceId, type), profile);
    this.saveProfiles();

    // Clear session
    this.currentSession = null;
    localStorage.removeItem(SESSION_KEY);

    console.log(`[CALIBRATION] Completed ${type} calibration:`, {
      deviceId,
      samples: readings.length,
      offset: offset.toFixed(2),
      scale: scale.toFixed(3),
      rmse: rmse.toFixed(2),
    });

    return profile;
  }

  /**
   * Cancel current calibration session
   */
  cancelSession(): void {
    this.currentSession = null;
    localStorage.removeItem(SESSION_KEY);
    console.log('[CALIBRATION] Session cancelled');
  }

  /**
   * Get current active session
   */
  getCurrentSession(): CalibrationSession | null {
    return this.currentSession;
  }

  /**
   * Apply calibration to estimated value
   */
  applyCalibration(deviceId: string, type: CalibrationType, estimated: number): number {
    const profile = this.getProfile(deviceId, type);
    if (!profile?.isValid) return estimated;
    
    return estimated * profile.scale + profile.offset;
  }

  /**
   * Get calibration status for display
   */
  getCalibrationStatus(deviceId: string, type: CalibrationType): {
    isCalibrated: boolean;
    sampleCount: number;
    rmse: number;
    lastCalibrated: number | null;
  } {
    const profile = this.getProfile(deviceId, type);
    
    return {
      isCalibrated: profile?.isValid && profile.sampleCount >= 3,
      sampleCount: profile?.sampleCount || 0,
      rmse: profile?.rmse || 0,
      lastCalibrated: profile?.updatedAt || null,
    };
  }

  /**
   * Delete a calibration profile
   */
  deleteProfile(deviceId: string, type: CalibrationType): boolean {
    const key = this.getProfileKey(deviceId, type);
    const existed = this.profiles.has(key);
    this.profiles.delete(key);
    this.saveProfiles();
    return existed;
  }

  /**
   * Export all calibration data
   */
  exportCalibrationData(): string {
    return JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      profiles: Object.fromEntries(this.profiles),
    }, null, 2);
  }

  /**
   * Import calibration data
   */
  importCalibrationData(jsonData: string): boolean {
    try {
      const data = JSON.parse(jsonData);
      
      if (data.profiles) {
        for (const [key, profile] of Object.entries(data.profiles)) {
          this.profiles.set(key, profile as CalibrationProfile);
        }
        this.saveProfiles();
        console.log(`[CALIBRATION] Imported ${Object.keys(data.profiles).length} profiles`);
        return true;
      }
    } catch (err) {
      console.error('[CALIBRATION] Import failed:', err);
    }
    return false;
  }

  /**
   * Get maximum acceptable RMSE for calibration type
   */
  private getMaxAcceptableRMSE(type: CalibrationType): number {
    switch (type) {
      case 'spo2': return 4.0;  // ±4% SpO2
      case 'bloodPressure': return 15.0;  // ±15 mmHg
      case 'glucose': return 25.0;  // ±25 mg/dL
      case 'lipids': return 30.0;  // ±30 mg/dL
      default: return 20.0;
    }
  }

  /**
   * Get human-readable calibration type name
   */
  static getCalibrationTypeName(type: CalibrationType): string {
    const names: Record<CalibrationType, string> = {
      spo2: 'SpO2 (Oximetría)',
      bloodPressure: 'Presión Arterial',
      glucose: 'Glucosa',
      lipids: 'Lípidos',
    };
    return names[type];
  }

  /**
   * Get calibration instructions
   */
  static getCalibrationInstructions(type: CalibrationType): string {
    const instructions: Record<CalibrationType, string> = {
      spo2: '1. Use un oxímetro de pulso de referencia médica\n2. Coloque ambos dispositivos en el mismo dedo\n3. Espere 30s para estabilización\n4. Anote el valor de referencia\n5. Tome 3-5 lecturas separadas',
      bloodPressure: '1. Use un tensiómetro de brazo calibrado\n2. Mida primero con el tensiómetro\n3. Inmediatamente después con la app\n4. Repita 3-5 veces con diferentes valores\n5. Varíe entre reposo y ligera actividad',
      glucose: '1. Use un glucometro de referencia\n2. Toma glucemia capilar simultánea\n3. Registre nivel de glucosa\n4. Repita en diferentes momentos (ayunas, postprandial)\n5. Mínimo 5 lecturas recomendadas',
      lipids: '1. Requiere valores de laboratorio\n2. Compare con análisis sanguíneo reciente\n3. Ingrese valores de colesterol total y triglicéridos\n4. Repita con diferentes perfiles lipídicos\n5. Nota: Menos preciso que otros biomarcadores',
    };
    return instructions[type];
  }
}

// Singleton instance
export const calibrationManager = new CalibrationManager();

export default calibrationManager;
