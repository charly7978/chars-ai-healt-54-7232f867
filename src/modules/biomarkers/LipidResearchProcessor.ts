/**
 * LIPID RESEARCH PROCESSOR
 * 
 * ⚠️ RESEARCH-GRADE ONLY - NOT FOR CLINICAL DIAGNOSIS ⚠️
 * 
 * This module provides an OPTICAL PROXY estimation of lipids from PPG
 * morphology features. It does NOT measure blood lipids directly.
 * 
 * ALL parameters loaded from Medical Parameter Registry.
 * 
 * References (see defaults.json for citations):
 * - Ferizoli et al. 2024: Area-related features as strongest correlators
 * - Arguello-Prada et al. 2025: Pulse width multi-level + AI
 */

import { getCalibrationModel, getQualityThreshold } from '@/config/medical-parameter-registry/loader';

export interface LipidResult {
  totalCholesterol: number;
  triglycerides: number;
  confidence: number;       // 0-1
  trend: 'RISING' | 'FALLING' | 'STABLE' | 'UNKNOWN';
  researchMode: boolean;    // always true
  enabledState: 'RESEARCH_ONLY' | 'ENABLED_LOW_CONFIDENCE' | 'WITHHELD_LOW_QUALITY';
  featureCount: number;
  modelVersion: string;
}

interface CycleInput {
  stiffnessIndex: number;
  augmentationIndex: number;
  areaRatio: number;
  dicroticDepth: number;
  pwvProxy: number;
  pw50Ms: number;
  pw75Ms: number;
  pw25Ms: number;
  diastolicTimeMs: number;
}

export class LipidResearchProcessor {
  // Configuration from Medical Parameter Registry
  private config = getCalibrationModel('lipids');
  private qualityConfig = getQualityThreshold('signalQualityIndex');

  private cholHistory: number[] = [];
  private trigHistory: number[] = [];
  private readonly HISTORY_SIZE = 15;
  private lastChol = 0;
  private lastTrig = 0;
  private readonly EMA_ALPHA = 0.18;
  private isCalibrated = false;
  private cholOffset = 0;
  private trigOffset = 0;

  process(input: {
    cycleFeatures: CycleInput | null;
    hr: number;
    rrVar: { sdnn: number; rmssd: number; cv: number };
    piGreen: number;
    contactStable: boolean;
    signalQuality: number;
  }): LipidResult {
    const withheld: LipidResult = {
      totalCholesterol: 0, triglycerides: 0, confidence: 0,
      trend: 'UNKNOWN', researchMode: true,
      enabledState: 'WITHHELD_LOW_QUALITY', featureCount: 0, modelVersion: 'pop_v1',
    };

    if (!input.cycleFeatures || !input.contactStable || input.signalQuality < 15) {
      return withheld;
    }

    const f = input.cycleFeatures;

    let featureCount = 0;
    if (f.stiffnessIndex > 0) featureCount++;
    if (f.augmentationIndex > 0) featureCount++;
    if (f.areaRatio > 0) featureCount++;
    if (f.dicroticDepth > 0) featureCount++;
    if (f.pw50Ms > 0) featureCount++;
    if (f.diastolicTimeMs > 0) featureCount++;
    if (input.rrVar.sdnn > 0) featureCount++;
    if (input.piGreen > 0) featureCount++;

    if (featureCount < 4) return withheld;

    // ── Cholesterol model ──
    // Use coefficients from Medical Parameter Registry
    const cholCoeff = this.config.cholesterolCoefficients!;
    const ref = this.config.referenceCenters!;
    let chol = cholCoeff.intercept;
    chol += (f.stiffnessIndex - ref.stiffnessIndex) * cholCoeff.stiffnessIndex;
    chol += (f.augmentationIndex - ref.augmentationIndex) * cholCoeff.augmentationIndex;
    if (f.areaRatio > 0) chol += (f.areaRatio - ref.areaRatio) * cholCoeff.areaRatio;
    chol += (ref.dicroticDepth - f.dicroticDepth) * cholCoeff.dicroticDepth;
    if (f.pwvProxy > 0) chol += (f.pwvProxy - ref.pwvProxy) * cholCoeff.pwvProxy;
    if (f.pw50Ms > 0) chol += (ref.pw50Ms - f.pw50Ms) * cholCoeff.pw50Ms;
    if (f.pw25Ms > 0 && f.pw75Ms > 0) chol += (ref.pw75_25 - f.pw75Ms / f.pw25Ms) * cholCoeff.pw75_25;
    chol += (input.hr - ref.hr) * cholCoeff.hr;
    if (input.rrVar.sdnn > 0) chol += Math.max(0, (ref.sdnn - input.rrVar.sdnn)) * cholCoeff.sdnn;
    chol += this.cholOffset;

    // ── Triglycerides model ──
    // Use coefficients from Medical Parameter Registry
    const trigCoeff = this.config.triglyceridesCoefficients!;
    let trig = trigCoeff.intercept;
    if (f.pw50Ms > 0) trig += (f.pw50Ms - ref.pw50Ms) * trigCoeff.pw50Ms;
    if (f.diastolicTimeMs > 0) trig += (f.diastolicTimeMs - ref.diastolicTimeMs) * trigCoeff.diastolicTimeMs;
    if (input.piGreen > 0) trig += (ref.piGreen - input.piGreen) * trigCoeff.piGreen;
    trig += (input.hr - ref.hr) * trigCoeff.hr;
    trig += (f.stiffnessIndex - ref.stiffnessIndex) * trigCoeff.stiffnessIndex;
    if (input.rrVar.sdnn > 0 && input.rrVar.sdnn < ref.sdnn) trig += (ref.sdnn - input.rrVar.sdnn) * trigCoeff.sdnn;
    trig += this.trigOffset;

    // Reject impossible
    if (chol < 60 || chol > 500) return withheld;
    if (trig < 30 || trig > 600) trig = Math.max(30, Math.min(600, trig));

    // EMA
    if (this.lastChol > 0) {
      chol = this.lastChol * (1 - this.EMA_ALPHA) + chol * this.EMA_ALPHA;
      trig = this.lastTrig * (1 - this.EMA_ALPHA) + trig * this.EMA_ALPHA;
    }
    this.lastChol = chol;
    this.lastTrig = trig;

    // History + trend
    this.cholHistory.push(chol);
    this.trigHistory.push(trig);
    if (this.cholHistory.length > this.HISTORY_SIZE) this.cholHistory.shift();
    if (this.trigHistory.length > this.HISTORY_SIZE) this.trigHistory.shift();

    // Confidence
    let confidence = 0;
    confidence += Math.min(0.2, featureCount * 0.025);
    confidence += Math.min(0.15, input.signalQuality / 100 * 0.15);
    confidence += this.isCalibrated ? 0.15 : 0;
    confidence += input.piGreen > 0.5 ? 0.05 : 0;
    if (!this.isCalibrated) confidence = Math.min(0.45, confidence);
    confidence = Math.min(1, Math.max(0, confidence));

    const enabledState: LipidResult['enabledState'] =
      confidence >= 0.35 ? 'ENABLED_LOW_CONFIDENCE' : 'RESEARCH_ONLY';

    return {
      totalCholesterol: Math.round(chol),
      triglycerides: Math.round(trig),
      confidence,
      trend: this.computeTrend(this.cholHistory),
      researchMode: true,
      enabledState,
      featureCount,
      modelVersion: this.isCalibrated ? 'subj_v1' : 'pop_v1',
    };
  }

  calibrate(cholReference: number, trigReference: number, currentPredChol: number, currentPredTrig: number): void {
    this.cholOffset = cholReference - currentPredChol;
    this.trigOffset = trigReference - currentPredTrig;
    this.isCalibrated = true;
  }

  private computeTrend(history: number[]): LipidResult['trend'] {
    if (history.length < 5) return 'UNKNOWN';
    const recent = history.slice(-3);
    const older = history.slice(-6, -3);
    if (older.length < 2) return 'UNKNOWN';
    const rm = recent.reduce((a, b) => a + b, 0) / recent.length;
    const om = older.reduce((a, b) => a + b, 0) / older.length;
    if (rm - om > 5) return 'RISING';
    if (om - rm > 5) return 'FALLING';
    return 'STABLE';
  }

  reset(): void {
    this.cholHistory = [];
    this.trigHistory = [];
    this.lastChol = 0;
    this.lastTrig = 0;
  }

  fullReset(): void {
    this.reset();
    this.isCalibrated = false;
    this.cholOffset = 0;
    this.trigOffset = 0;
  }
}
