import type {
  CardiacEvidence, ExtractedPPG, OpticalGateResult,
  PublicationDecision, BeatDetectorState,
} from './types';

/**
 * PublicationGate
 * ---------------
 * Final authority. Returns canPublish=true ONLY when:
 *   - opticalContact && tissueCandidate && perfusionCandidate
 *   - cardiacEvidence with spectralSQI / peakSQI / coherence above floors
 *   - sample rate plausible (>= 12 Hz)
 *   - at least 4 accepted beats with bpmMedian in human range
 *   - source quality non-trivial
 *
 * If anything fails: bpm=null, waveform=[], everything blank.
 */

const MIN_FS = 12;
const MIN_ACCEPTED_BEATS = 4;

export class PublicationGate {
  evaluate(
    optical: OpticalGateResult,
    extracted: ExtractedPPG,
    cardiac: CardiacEvidence,
    beat: BeatDetectorState,
    waveformWindow: number[],
  ): PublicationDecision {
    if (!optical.opticalContact) {
      return blank('NO_OPTICAL_CONTACT: ' + optical.reason);
    }
    if (!optical.tissueCandidate) {
      return blank('NOT_TISSUE_LIKE: ' + optical.reason);
    }
    if (!optical.perfusionCandidate) {
      return blank('NO_PERFUSION_AC');
    }
    if (extracted.sampleRate < MIN_FS) {
      return blank('UNSTABLE_SAMPLE_RATE');
    }
    if (extracted.selectedSource === 'NONE' || extracted.sourceQuality < 0.20) {
      return blank('LOW_SOURCE_QUALITY');
    }
    if (!cardiac.cardiacEvidence) {
      return blank('NO_CARDIAC_EVIDENCE: ' + cardiac.reason);
    }
    const beatsWithRR = beat.beats.filter(b => b.rrMs > 0);
    if (beatsWithRR.length < MIN_ACCEPTED_BEATS) {
      return blank('INSUFFICIENT_BEATS');
    }
    if (beat.bpmMedian == null || beat.bpmMedian < 42 || beat.bpmMedian > 210) {
      return blank('BPM_OUT_OF_RANGE');
    }

    return {
      canPublish: true,
      reason: 'PUBLISHED',
      bpm: beat.bpmMedian,
      waveform: waveformWindow,
      beats: beat.beats.slice(),
    };
  }
}

function blank(reason: string): PublicationDecision {
  return { canPublish: false, reason, bpm: null, waveform: [], beats: [] };
}