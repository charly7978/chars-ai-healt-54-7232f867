/**
 * DYNAMIC VITAL ESTIMATION CONFIGURATION
 * 
 * Population baseline coefficients for PPG-derived vital estimation.
 * 
 * ⚠️ IMPORTANT: These are RESEARCH-GRADE estimation models.
 * They provide OPTICAL PROXY values derived from PPG morphology,
 * NOT clinical measurements. All outputs must be marked with:
 * - confidence level
 * - calibrationState
 * - researchMode flag where applicable
 * - enabledState (RESEARCH_ONLY / ENABLED_LOW_CONFIDENCE / etc.)
 * 
 * The intercept values represent population statistical centers,
 * NOT "normal values" to use as results.
 */

// SpO2 quadratic calibration model
// Formula: SpO2 = A + B*R + C*R² where R is ratio-of-ratios
export const SPO2_CALIBRATION = {
  // Default uncalibrated coefficients from literature
  // (van Gastel et al. 2016, Sensors 2023)
  UNCALIBRATED: {
    A: 104.0,
    B: 4.2,
    C: -28.5,
  },
  // Physiological limits for validation
  MIN_SPO2: 50,
  MAX_SPO2: 105,
  // Quality thresholds
  MIN_PERFUSION_INDEX: 0.03,
  MIN_VALID_FRAMES: 5,
  MIN_QUALITY_FOR_OUTPUT: 25,
} as const;

// Blood pressure estimation coefficients
// Derived from PPG morphology features
export const BLOODPRESSURE_COEFF = {
  Systolic: {
    intercept: 82.0,  // Population statistical center, NOT a default result
    bDivA: -16.0,
    dDivA: 10.5,
    invSUT: 2500.0,
    SI: 7.5,
    AIx: 0.30,
    HR: 0.25,
    areaRatio: 5.0,
    AGI: 4.8,
    dicroticDepth: -8.0,
    pw75_pw25: 6.0,
  },
  Diastolic: {
    intercept: 42.0,  // Population statistical center, NOT a default result
    PW50: 0.10,
    DT: 0.030,
    RMSSD: -0.07,
    dicroticDepth: -10.0,
    areaRatio: 3.8,
    SI: 2.8,
    HR: 0.12,
    pw50_sut_ratio: 2.5,
  },
  // Physiological validation limits
  MIN_SBP: 85,
  MAX_SBP: 180,
  MIN_DBP: 50,
  MAX_DBP: 110,
  // Feature quality thresholds
  MIN_CYCLES: 1,
  MAX_CYCLES: 15,
  MIN_FEATURE_QUALITY: 0.15,
} as const;

// Glucose estimation (RESEARCH ONLY)
// Based on PPG morphology correlation with vascular compliance
export const GLUCOSE_RESEARCH_COEFF = {
  intercept: 95.0,  // Population baseline - research context only
  sutMs: 0.12,
  pw50Ms: 0.04,
  augIndex: 0.10,
  stiffness: 1.8,
  dicroticDepth: -10.0,
  areaRatio: 4.0,
  hr: 0.22,
  sdnn: -0.25,
  rmssd: -0.15,
  piGreen: -3.0,
  rgACRatio: 6.0,
  pw75_25Ratio: 12.0,
  // Population reference centers (for deviation calculation)
  REFERENCE_CENTERS: {
    sutMs: 140,
    pw50Ms: 320,
    augmentationIndex: 45,
    stiffnessIndex: 5.5,
    dicroticDepth: 0.25,
    areaRatio: 1.4,
    hr: 72,
    sdnn: 45,
    rmssd: 35,
    piGreen: 1.5,
    rgACRatio: 1.0,
    pw75_25Ratio: 0.55,
  },
  // Quality thresholds
  MIN_FEATURES: 5,
  MIN_HR: 35,
  MAX_HR: 200,
  MIN_PI: 0.03,
  MIN_SIGNAL_QUALITY: 15,
  // Physiological limits
  MIN_GLUCOSE: 30,
  MAX_GLUCOSE: 500,
} as const;

// Lipid estimation (RESEARCH ONLY)
export const LIPID_RESEARCH_COEFF = {
  Cholesterol: {
    intercept: 150.0,  // Population baseline - research context only
    stiffnessIndex: 8.0,
    augmentationIndex: 0.45,
    areaRatio: 12.0,
    dicroticDepth: 25.0,
    pwvProxy: 4.0,
    pw50Ms: 0.08,
    pw75_pw25: 15.0,
    hr: 0.3,
    sdnn: 0.35,
    // Reference centers
    REF_STIFFNESS: 6,
    REF_AI: 50,
    REF_AREA_RATIO: 1.5,
    REF_DICROTIC: 0.3,
    REF_PWV: 7,
    REF_PW50: 300,
    REF_PW75_25: 0.5,
  },
  Triglycerides: {
    intercept: 120.0,  // Population baseline - research context only
    pw50Ms: 0.15,
    diastolicTimeMs: 0.06,
    piGreen: 8.0,
    hr: 0.4,
    stiffnessIndex: 3.5,
    sdnn: 0.5,
    // Reference centers
    REF_PW50: 300,
    REF_DIASTOLIC_TIME: 400,
    REF_PI: 2.0,
    REF_HR: 72,
    REF_STIFFNESS: 6,
    REF_SDNN: 40,
  },
  // Quality thresholds
  MIN_FEATURES: 4,
  MIN_SIGNAL_QUALITY: 15,
  // Physiological limits
  MIN_CHOL: 60,
  MAX_CHOL: 500,
  MIN_TRIG: 30,
  MAX_TRIG: 600,
} as const;

// Calibration requirements
export const CALIBRATION_CONFIG = {
  SPO2: {
    SESSION_HISTORY_SIZE: 60,
    R_BUFFER_SIZE: 12,
    BEAT_RATIO_BUFFER: 8,
  },
  BLOODPRESSURE: {
    MIN_CYCLES_FOR_MEDIUM: 3,
    MIN_CYCLES_FOR_HIGH: 6,
    MIN_FEATURE_QUALITY_MEDIUM: 42,
    MIN_FEATURE_QUALITY_HIGH: 70,
  },
  GLUCOSE: {
    MAX_CALIBRATION_POINTS: 20,
    MIN_CALIBRATION_POINTS: 1,
    EMA_ALPHA: 0.20,
    HISTORY_SIZE: 20,
  },
  LIPIDS: {
    EMA_ALPHA: 0.18,
    HISTORY_SIZE: 15,
  },
} as const;
