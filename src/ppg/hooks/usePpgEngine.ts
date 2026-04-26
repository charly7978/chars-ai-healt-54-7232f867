/**
 * USE PPG ENGINE
 * 
 * Single source of truth for the entire PPG pipeline.
 * 
 * Exposes:
 * - start(), stop(), reset()
 * - state, cameraStatus, torchStatus, roi
 * - rawChannels, g1, g2, g3, waveform, beats
 * - bpm, spo2, sqi, publication, debug
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { PpgCameraController } from '../camera/PpgCameraController';
import { FrameSampler } from '../camera/FrameSampler';
import { scanRoi } from '../roi/RoiScanner';
import { RoiTracker } from '../roi/RoiTracker';
import { evaluateRoiQuality } from '../roi/RoiQuality';
import { PpgExtractor } from '../signal/PpgExtractor';
import { Detrender } from '../signal/Detrender';
import { HampelFilter } from '../signal/HampelFilter';
import { BandpassFilter } from '../signal/BandpassFilter';
import { BeatDetector } from '../signal/BeatDetector';
import { SignalQualityIndex } from '../signal/SignalQualityIndex';
import { SpectralAnalyzer } from '../signal/SpectralAnalyzer';
import { PublicationGate } from '../signal/PublicationGate';
import type { PpgState, PpgEngineState, RoiBox, Beat } from '../signal/PpgTypes';

export function usePpgEngine() {
  const [state, setState] = useState<PpgState>('idle');
  const [engineState, setEngineState] = useState<PpgEngineState>({
    state: 'idle',
    cameraStatus: {
      active: false,
      videoWidth: 0,
      videoHeight: 0,
      fps: 0,
      torchActive: false,
    },
    roi: null,
    rawChannels: null,
    g1: 0,
    g2: 0,
    g3: 0,
    waveform: [],
    beats: [],
    bpm: null,
    spo2: null,
    sqi: null,
    publication: null,
    debug: {
      frameIndex: 0,
      lastFrameAgeMs: 0,
      bufferDuration: 0,
      validSamples: 0,
      noiseSamples: 0,
    },
  });

  // Core components
  const cameraRef = useRef<PpgCameraController | null>(null);
  const samplerRef = useRef<FrameSampler | null>(null);
  const extractorRef = useRef<PpgExtractor | null>(null);
  const detrenderRef = useRef<Detrender | null>(null);
  const hampelRef = useRef<HampelFilter | null>(null);
  const bandpassRef = useRef<BandpassFilter | null>(null);
  const beatDetectorRef = useRef<BeatDetector | null>(null);
  const sqiRef = useRef<SignalQualityIndex | null>(null);
  const spectralRef = useRef<SpectralAnalyzer | null>(null);
  const publicationGateRef = useRef<PublicationGate | null>(null);
  const roiTrackerRef = useRef<RoiTracker | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isMeasuringRef = useRef(false);
  const lastFrameTimeRef = useRef(0);

  // Initialize components
  useEffect(() => {
    cameraRef.current = new PpgCameraController();
    samplerRef.current = new FrameSampler();
    extractorRef.current = new PpgExtractor();
    detrenderRef.current = new Detrender();
    hampelRef.current = new HampelFilter();
    bandpassRef.current = new BandpassFilter();
    beatDetectorRef.current = new BeatDetector();
    sqiRef.current = new SignalQualityIndex();
    spectralRef.current = new SpectralAnalyzer();
    publicationGateRef.current = new PublicationGate();

    return () => {
      stop();
    };
  }, []);

  const start = useCallback(async () => {
    if (isMeasuringRef.current) return;

    setState('requesting_camera');
    isMeasuringRef.current = true;

    try {
      // Create video element
      const video = document.createElement('video');
      videoRef.current = video;
      cameraRef.current?.setVideoElement(video);
      samplerRef.current?.setVideoElement(video);

      // Start camera
      await cameraRef.current?.startMeasurement(
        (frame) => {
          lastFrameTimeRef.current = performance.now();
          processFrame(frame.imageData, frame.timestamp);
        },
        (status) => {
          setEngineState(prev => ({
            ...prev,
            cameraStatus: {
              active: status.state === 'measuring',
              videoWidth: status.videoWidth,
              videoHeight: status.videoHeight,
              fps: status.actualFrameRate,
              torchActive: status.torchActive,
            },
          }));
        }
      );

      setState('measuring');
    } catch (error) {
      console.error('Failed to start PPG engine:', error);
      setState('error');
      isMeasuringRef.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    isMeasuringRef.current = false;
    cameraRef.current?.stopMeasurement();
    samplerRef.current?.stop();
    extractorRef.current?.reset();
    beatDetectorRef.current?.reset();
    setState('idle');
  }, []);

  const reset = useCallback(() => {
    stop();
    extractorRef.current?.reset();
    beatDetectorRef.current?.reset();
    setEngineState({
      state: 'idle',
      cameraStatus: {
        active: false,
        videoWidth: 0,
        videoHeight: 0,
        fps: 0,
        torchActive: false,
      },
      roi: null,
      rawChannels: null,
      g1: 0,
      g2: 0,
      g3: 0,
      waveform: [],
      beats: [],
      bpm: null,
      spo2: null,
      sqi: null,
      publication: null,
      debug: {
        frameIndex: 0,
        lastFrameAgeMs: 0,
        bufferDuration: 0,
        validSamples: 0,
        noiseSamples: 0,
      },
    });
  }, [stop]);

  const processFrame = useCallback((imageData: ImageData, timestamp: number) => {
    const extractor = extractorRef.current;
    const detrender = detrenderRef.current;
    const hampel = hampelRef.current;
    const bandpass = bandpassRef.current;
    const beatDetector = beatDetectorRef.current;
    const sqi = sqiRef.current;
    const spectral = spectralRef.current;
    const publicationGate = publicationGateRef.current;
    const roiTracker = roiTrackerRef.current;

    if (!extractor || !detrender || !hampel || !bandpass || !beatDetector || !sqi || !spectral || !publicationGate) return;

    // Scan ROI
    const roiScan = scanRoi(imageData);
    
    // Track ROI
    if (!roiTracker) {
      roiTrackerRef.current = new RoiTracker(roiScan.selectedRoi);
    } else {
      roiTracker.update(roiScan.selectedRoi);
    }
    
    const roi = roiTrackerRef.current.getCurrentRoi();
    extractor.setRoi(roi);

    // Extract PPG signals
    const sample = extractor.processFrame(imageData, timestamp);
    if (!sample) return;

    // Get G2 history for filtering
    const g2History = extractor.getG2History(300);
    
    // Filter chain
    let filtered = sample.g.g2;
    filtered = detrender.process(filtered);
    filtered = hampel.process(filtered);
    filtered = bandpass.process(filtered);
    
    // Update G3
    extractor.updateG3(filtered);

    // Beat detection
    const g3History = extractor.getG3History(360);
    const beatResult = beatDetector.process(filtered, timestamp);

    // Spectral analysis
    const spectralResult = spectral.findPeak(
      spectral.fft(g3History),
      sample.fps,
      0.7,
      4.0
    );

    // SQI calculation
    const roiQuality = evaluateRoiQuality(
      imageData,
      roi,
      extractor.getRawHistory(100).r,
      extractor.getRawHistory(100).g,
      extractor.getRawHistory(100).b
    );

    const sqiMetrics = sqi.calculate({
      temporalVariance: roiQuality.metrics.temporalVariance,
      spectralPeakRatio: spectralResult.peakRatio,
      spectralPeakHz: spectralResult.peakHz,
      morphologyScore: 0, // TODO: from beat detector
      perfusionProxy: roiQuality.metrics.perfusionProxy,
      motionProxy: roiQuality.metrics.motionProxy,
      saturationRatio: roiQuality.metrics.saturationRatio,
      darkRatio: roiQuality.metrics.darkRatio,
      validPixelRatio: roiQuality.metrics.validPixelRatio,
      fps: sample.fps,
      redDominance: roiQuality.metrics.redDominance,
      channelCoherence: roiQuality.metrics.channelCoherence,
    });

    // Publication gate
    const gateResult = publicationGate.evaluate({
      bufferDuration: extractor.getBufferDuration(),
      fpsMedian: sample.fps,
      validPixelRatio: roiQuality.metrics.validPixelRatio,
      saturationRatio: roiQuality.metrics.saturationRatio,
      darkRatio: roiQuality.metrics.darkRatio,
      spectralPeakRatio: spectralResult.peakRatio,
      spectralPeakHz: spectralResult.peakHz,
      perfusionProxy: roiQuality.metrics.perfusionProxy,
      beatsValid: beatResult.beats.length,
      rrCV: 0, // TODO: from beat detector
      bpmTime: beatResult.bpm,
      bpmFreq: spectralResult.peakHz * 60,
      sqiOverall: sqiMetrics.overall,
      spo2Calibrated: false, // TODO: from calibration
    });

    // Update state
    setEngineState(prev => ({
      ...prev,
      state: gateResult.currentStatus,
      roi,
      rawChannels: sample.raw,
      g1: sample.g.g1,
      g2: sample.g.g2,
      g3: filtered,
      waveform: g3History,
      beats: beatResult.beats,
      bpm: gateResult.canPublishBpm ? beatResult.bpm : null,
      spo2: null, // No SpO2 without calibration
      sqi: sqiMetrics,
      publication: gateResult,
      debug: {
        frameIndex: extractor.getFrameCount(),
        lastFrameAgeMs: performance.now() - lastFrameTimeRef.current,
        bufferDuration: extractor.getBufferDuration(),
        validSamples: roiQuality.canPublish ? prev.debug.validSamples + 1 : prev.debug.validSamples,
        noiseSamples: roiQuality.canPublish ? prev.debug.noiseSamples : prev.debug.noiseSamples + 1,
      },
    }));

    setState(gateResult.currentStatus);
  }, []);

  const setVideoElement = useCallback((video: HTMLVideoElement) => {
    videoRef.current = video;
  }, []);

  return {
    start,
    stop,
    reset,
    setVideoElement,
    state,
    engineState,
  };
}
