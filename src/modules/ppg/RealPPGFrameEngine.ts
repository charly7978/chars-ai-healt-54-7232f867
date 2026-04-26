import { RadiometricProcessor } from './RadiometricProcessor';
import { OpticalEvidenceGate } from './OpticalEvidenceGate';
import { PPGSignalExtractor } from './PPGSignalExtractor';
import { CardiacSignalValidator } from './CardiacSignalValidator';
import { BeatDetector } from './BeatDetector';
import { PublicationGate } from './PublicationGate';
import { RingBuffer } from './RingBuffer';
import { createEmptySnapshot } from './types';
import type { RealPPGSnapshot } from './types';

/**
 * RealPPGFrameEngine
 * ------------------
 * Single source of truth. Owns the per-frame pipeline:
 *   raw frame → RadiometricProcessor → OpticalEvidenceGate
 *             → PPGSignalExtractor → CardiacSignalValidator
 *             → BeatDetector → PublicationGate
 *
 * No defaults, no fallbacks, no fabricated values. If anything is missing,
 * snapshot.publication.canPublish === false and bpm === null.
 */

const FILTERED_BUFFER = 600;     // ~20 s @ 30 fps
const VALIDATION_WINDOW_S = 8;   // seconds passed to CardiacSignalValidator
const FPS_WINDOW = 60;

export class RealPPGFrameEngine {
  private rad = new RadiometricProcessor();
  private optical = new OpticalEvidenceGate();
  private extractor = new PPGSignalExtractor();
  private validator = new CardiacSignalValidator();
  private beat = new BeatDetector();
  private publication = new PublicationGate();

  private filtered = new RingBuffer(FILTERED_BUFFER);
  private greenAC = new RingBuffer(FILTERED_BUFFER);
  private redAC = new RingBuffer(FILTERED_BUFFER);
  private frameTimes: number[] = [];
  private frameIndex = 0;

  reset(): void {
    this.rad.reset();
    this.optical.reset();
    this.extractor.reset();
    this.beat.reset();
    this.filtered.reset();
    this.greenAC.reset();
    this.redAC.reset();
    this.frameTimes = [];
    this.frameIndex = 0;
  }

  processFrame(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    tMs: number,
  ): RealPPGSnapshot {
    if (!data || width <= 0 || height <= 0) return createEmptySnapshot();
    this.frameIndex++;

    // Real fps from timestamps (NOT Date.now, NOT assumed 30).
    this.frameTimes.push(tMs);
    if (this.frameTimes.length > FPS_WINDOW) this.frameTimes.shift();
    let fs = 0;
    if (this.frameTimes.length >= 5) {
      const dt = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / (this.frameTimes.length - 1);
      fs = dt > 0 ? 1000 / dt : 0;
    }

    const frame = this.rad.process(data, width, height, tMs);
    const extracted = this.extractor.process(frame, fs);
    const optical = this.optical.evaluate(
      frame,
      extracted.perfusionIndex.red,
      extracted.perfusionIndex.green,
    );

    // Push the bandpassed sample only when optical contact is plausible.
    // This stops the validator from chasing pure noise spectra.
    if (optical.opticalContact) {
      this.filtered.push(extracted.filteredValue);
      // Keep AC channels aligned to the same gating for fair coherence.
      this.greenAC.push(frame.greenLinear);
      this.redAC.push(frame.redLinear);
    }

    const winN = Math.min(this.filtered.size(), Math.floor(VALIDATION_WINDOW_S * Math.max(fs, 1)));
    const filteredWindow = winN > 0 ? this.filtered.toArray().slice(-winN) : [];
    const greenWindow = winN > 0 ? this.greenAC.toArray().slice(-winN) : [];
    const redWindow = winN > 0 ? this.redAC.toArray().slice(-winN) : [];

    const cardiac = optical.opticalContact && fs > 0
      ? this.validator.evaluate(filteredWindow, greenWindow, redWindow, fs)
      : { cardiacEvidence: false, spectralSQI: 0, peakSQI: 0, channelCoherence: 0,
          dominantHz: 0, bpmCandidate: null, reason: 'NO_OPTICAL_CONTACT' };

    const beatState = this.beat.process(
      extracted.filteredValue,
      tMs,
      cardiac.cardiacEvidence,
      cardiac.dominantHz,
    );

    const publication = this.publication.evaluate(
      optical, extracted, cardiac, beatState,
      filteredWindow.slice(-Math.min(filteredWindow.length, 200)),
    );

    const vibrationAllowed = publication.canPublish && beatState.acceptedBeat;

    return {
      frame, optical, extracted, cardiac, beat: beatState, publication,
      fps: fs, frameIndex: this.frameIndex, vibrationAllowed,
    };
  }
}