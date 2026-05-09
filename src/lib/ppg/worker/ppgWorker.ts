/**
 * PPG Web Worker.
 *
 * Receives RGB samples + real-time FPS from the main thread via Transferable
 * Float32Array buffers (zero-copy), runs PCA fusion + Butterworth bandpass +
 * SQI on its own thread, and posts back a snapshot — also as a Transferable.
 *
 * The main thread never blocks on signal math.
 */

import { PPG_CONFIG } from "../types";
import { BandpassBiquad } from "../signal/filters";
import { RingBuffer } from "../signal/ringBuffer";
import { RgbPcaFusion } from "../signal/signalFusion";
import { computeSqi } from "../signal/sqi";

export interface WorkerInboundSample {
  readonly type: "sample";
  /** [r, g, b, fps] packed as Float32Array (transferred). */
  readonly payload: Float32Array;
}

export interface WorkerInboundReset {
  readonly type: "reset";
}

export type WorkerInbound = WorkerInboundSample | WorkerInboundReset;

export interface WorkerOutboundSnapshot {
  readonly type: "snapshot";
  readonly filtered: Float32Array;
  readonly sqi: number;
  readonly perfusionIndex: number;
  readonly skewness: number;
  readonly kurtosis: number;
  readonly fpsActual: number;
  readonly samples: number;
}

const ringCapacity = Math.max(
  64,
  Math.round(PPG_CONFIG.FPS_TARGET * PPG_CONFIG.RING_SECONDS),
);

const filtered = new RingBuffer(ringCapacity);
const fusion = new RgbPcaFusion(ringCapacity);
let bandpass = new BandpassBiquad(
  PPG_CONFIG.FPS_TARGET,
  PPG_CONFIG.BANDPASS.lowHz,
  PPG_CONFIG.BANDPASS.highHz,
);
let dcEstimate = 0;
let dcInitialized = false;
let snapshotBuffer = new Float32Array(ringCapacity);
let lastEmit = 0;
const EMIT_INTERVAL_MS = 1000 / PPG_CONFIG.STATE_THROTTLE_HZ;

function handleSample(payload: Float32Array): void {
  const r = payload[0];
  const g = payload[1];
  const b = payload[2];
  const fps = payload[3];

  if (Number.isFinite(fps) && fps > 1) bandpass.setSampleRate(fps);

  const fused = fusion.pushAndProject(r, g, b);
  const dcSource = g; // Green channel is the standard PPG DC reference.
  if (!dcInitialized) {
    dcEstimate = dcSource;
    dcInitialized = true;
  } else {
    dcEstimate = dcEstimate * 0.99 + dcSource * 0.01;
  }

  const filt = bandpass.process(fused.value);
  filtered.push(filt);

  const now = performance.now();
  if (now - lastEmit < EMIT_INTERVAL_MS) return;
  lastEmit = now;

  if (snapshotBuffer.length !== filtered.capacity) {
    snapshotBuffer = new Float32Array(filtered.capacity);
  }
  const samples = filtered.snapshot(snapshotBuffer);
  const sqi = computeSqi(snapshotBuffer, samples, dcEstimate);

  // Hand ownership of the snapshot buffer to the main thread, then re-allocate.
  const out: WorkerOutboundSnapshot = {
    type: "snapshot",
    filtered: snapshotBuffer,
    sqi: sqi.sqi,
    perfusionIndex: sqi.perfusionIndex,
    skewness: sqi.skewness,
    kurtosis: sqi.kurtosis,
    fpsActual: fps,
    samples,
  };
  (self as unknown as Worker).postMessage(out, [snapshotBuffer.buffer]);
  snapshotBuffer = new Float32Array(filtered.capacity);
}

function handleReset(): void {
  filtered.clear();
  fusion.reset();
  bandpass = new BandpassBiquad(
    PPG_CONFIG.FPS_TARGET,
    PPG_CONFIG.BANDPASS.lowHz,
    PPG_CONFIG.BANDPASS.highHz,
  );
  dcEstimate = 0;
  dcInitialized = false;
  lastEmit = 0;
}

self.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const msg = event.data;
  if (msg.type === "sample") handleSample(msg.payload);
  else if (msg.type === "reset") handleReset();
});
