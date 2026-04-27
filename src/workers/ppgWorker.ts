/// <reference lib="webworker" />
/**
 * PPG WORKER — Off-main-thread signal processing for forensic-grade stability.
 *
 * Responsibilities:
 *  - Own a single PPGSignalProcessor instance.
 *  - Receive ImageData (transferable when possible) + frame timestamp.
 *  - Emit ProcessedSignal back to the main thread.
 *  - Expose RGB stats, position quality and debug telemetry on demand.
 *
 * Backpressure protocol:
 *  - Main thread sends FRAME and waits for FRAME_DONE before sending the next.
 *  - If a frame arrives while busy, it's dropped (counted) — no queue, no jank.
 */
import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import type { ProcessedSignal, ProcessingError } from '../types/signal';

type InMsg =
  | { type: 'INIT'; sessionId: string }
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'CALIBRATE' }
  | { type: 'FRAME'; data: Uint8ClampedArray; width: number; height: number; ts: number; captureTs: number; seq: number }
  | { type: 'GET_RGB' }
  | { type: 'GET_POS' }
  | { type: 'GET_DEBUG' };

type OutMsg =
  | { type: 'READY' }
  | { type: 'SIGNAL'; signal: ProcessedSignal; seq: number; procMs: number; captureTs: number; emitTs: number }
  | { type: 'FRAME_DONE'; seq: number; procMs: number; captureTs: number; emitTs: number }
  | { type: 'ERROR'; error: ProcessingError }
  | { type: 'RGB'; stats: ReturnType<PPGSignalProcessor['getRGBStats']> }
  | { type: 'POS'; quality: ReturnType<PPGSignalProcessor['getPositionQuality']> }
  | { type: 'DEBUG'; info: ReturnType<PPGSignalProcessor['getDebugInfo']> };

const ctx: DedicatedWorkerGlobalScope = self as any;

let processor: PPGSignalProcessor | null = null;
let lastSignal: ProcessedSignal | null = null;

function ensureProcessor() {
  if (processor) return processor;
  processor = new PPGSignalProcessor(
    (signal) => { lastSignal = signal; },
    (error) => { ctx.postMessage({ type: 'ERROR', error } satisfies OutMsg); }
  );
  return processor;
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'INIT': {
        ensureProcessor();
        ctx.postMessage({ type: 'READY' } satisfies OutMsg);
        return;
      }
      case 'START': {
        ensureProcessor().start();
        return;
      }
      case 'STOP': {
        if (processor) processor.stop();
        return;
      }
      case 'CALIBRATE': {
        ensureProcessor().calibrate();
        return;
      }
      case 'FRAME': {
        const p = ensureProcessor();
        // Reconstruct ImageData inside the worker (zero-copy: we received the buffer transferred).
        const imgData = new ImageData(msg.data as unknown as Uint8ClampedArray<ArrayBuffer>, msg.width, msg.height);
        const t0 = performance.now();
        lastSignal = null;
        p.processFrame(imgData, msg.ts);
        const procMs = performance.now() - t0;
        const emitTs = performance.now();
        if (lastSignal) {
          ctx.postMessage({
            type: 'SIGNAL', signal: lastSignal, seq: msg.seq,
            procMs, captureTs: msg.captureTs, emitTs,
          } satisfies OutMsg);
        }
        // Always ACK so the main thread can release backpressure even when no signal was emitted.
        ctx.postMessage({
          type: 'FRAME_DONE', seq: msg.seq, procMs, captureTs: msg.captureTs, emitTs,
        } satisfies OutMsg);
        return;
      }
      case 'GET_RGB': {
        if (!processor) return;
        ctx.postMessage({ type: 'RGB', stats: processor.getRGBStats() } satisfies OutMsg);
        return;
      }
      case 'GET_POS': {
        if (!processor) return;
        ctx.postMessage({ type: 'POS', quality: processor.getPositionQuality() } satisfies OutMsg);
        return;
      }
      case 'GET_DEBUG': {
        if (!processor) return;
        ctx.postMessage({ type: 'DEBUG', info: processor.getDebugInfo() } satisfies OutMsg);
        return;
      }
    }
  } catch (err) {
    ctx.postMessage({
      type: 'ERROR',
      error: { code: 'WORKER_EXCEPTION', message: String((err as any)?.message ?? err), timestamp: Date.now() }
    } satisfies OutMsg);
  }
};

export {};