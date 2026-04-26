/**
 * PPG MODULE INDEX
 * 
 * Central exports for the new PPG pipeline.
 */

// Camera
export { PpgCameraController } from './camera/PpgCameraController';
export { PPG_CAMERA_CONSTRAINTS, PPG_CAMERA_FALLBACK_CONSTRAINTS, LOW_RES_CONSTRAINTS } from './camera/CameraConstraints';
export { TorchController } from './camera/TorchController';
export { FrameSampler } from './camera/FrameSampler';

// Radiometry
export { srgbToLinear, linearToSrgb, rgbToLinear, linearToRgb, imageDataToLinear } from './radiometry/SrgbLinearizer';
export { OpticalDensityCalculator, calculateOD, calculateODRGB, updateBaselineEWMA } from './radiometry/OpticalDensity';
export { calculatePixelStats, calculateRoiPixelStats } from './radiometry/PixelStats';

// ROI
export { scanRoi } from './roi/RoiScanner';
export { RoiTracker } from './roi/RoiTracker';
export { evaluateRoiQuality } from './roi/RoiQuality';

// Signal
export * from './signal/PpgTypes';
export { RingBuffer } from './signal/RingBuffer';
export { Timebase } from './signal/Timebase';
export { PpgExtractor } from './signal/PpgExtractor';
export { Detrender } from './signal/Detrender';
export { HampelFilter } from './signal/HampelFilter';
export { BandpassFilter } from './signal/BandpassFilter';
export { SavitzkyGolay } from './signal/SavitzkyGolay';
export { BeatDetector } from './signal/BeatDetector';
export { SignalQualityIndex } from './signal/SignalQualityIndex';
export { SpectralAnalyzer } from './signal/SpectralAnalyzer';
export { PublicationGate } from './signal/PublicationGate';

// UI
export { CardiacMonitorCanvas } from './ui/CardiacMonitorCanvas';
export { FloatingVitalsOverlay, ControlOverlay } from './ui/FloatingVitalsOverlay';
export { ForensicDebugPanel } from './ui/ForensicDebugPanel';

// Hooks
export { usePpgEngine } from './hooks/usePpgEngine';
