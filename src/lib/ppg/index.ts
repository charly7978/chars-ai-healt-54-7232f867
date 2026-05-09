/**
 * Pipeline PPG profesional — punto de entrada único.
 * Capas: types, camera, capture, detection, roi, signal.
 * Diseñado para ser consumido por el adapter `PPGSignalProcessor` y/o el worker.
 */
export * from "./types";
export { CameraController, type CameraDiagnostics } from "./camera/cameraController";
export { Downsampler } from "./capture/downsample";
export { FrameLoop, type FrameMeta } from "./capture/frameLoop";
export { computeFingerMetrics, type FingerMetrics } from "./detection/fingerDetector";
export { classifyExposure } from "./detection/exposureClassifier";
export { AdaptiveRoiSelector } from "./roi/adaptiveRoi";
export { FloatRingBuffer } from "./signal/ringBuffer";
export { NormalizationPipeline } from "./signal/normalization";
export { BiquadBandpass } from "./signal/filters";
export { PcaSignalFusion } from "./signal/signalFusion";
export { SqiEvaluator } from "./signal/sqi";
