## Goal
1. **Add a live forensic debug overlay** showing Gate 1 / Gate 2 / Gate 3 status, the rejection reason, and live SNR / peak frequency / spectral concentration during measurement.
2. **Harden the Gate-3 morphology feedback loop** so the morphology verdict always feeds back into `PPGSignalProcessor` frame-by-frame through a typed API, removing the current `(window as any).__ppgProcessor` indirection.

## Bug found while reading the code
- `PPGSignalProcessor.computeForensicGate()` already produces the full `forensicGate` payload (`gate1_optical`, `gate2_spectral`, `gate3_morphology`, `passAll`, `cardiacSNRdB`, `spectralPeakHz`, `spectralConcentration`, `livenessReason`) and stamps it on every emitted frame.
- Gate 3 is set via `processor.setMorphologyGate(pass, reason)` — but `Index.tsx` calls it through `(window as any).__ppgProcessor?.setMorphologyGate?.()`, and **nothing in the codebase ever assigns `window.__ppgProcessor`**. So today Gate 3 stays at its initial `false` and `passAll` can never become true → the triple-gate is silently broken. This change fixes that.

## Changes

### 1. `src/hooks/useSignalProcessor.ts`
- Add a memoised `setMorphologyGate(pass: boolean, reason?: string)` callback that delegates to `processorRef.current?.setMorphologyGate(...)`.
- Return it from the hook. Fully typed, no globals.

### 2. `src/pages/Index.tsx`
- Destructure `setMorphologyGate` from `useSignalProcessor()`.
- Replace the `(window as any).__ppgProcessor?.setMorphologyGate?.(...)` block (around line 552–558) with a direct call: `setMorphologyGate(morphPass, morphPass ? 'OK' : 'MORFOLOGÍA INSUFICIENTE')`.
- Track the latest `forensicGate` snapshot in a small ref + state tick so the overlay can re-render without thrashing the hot path (update on each `lastSignal` change, which already drives the existing effect).
- Add a URL toggle: overlay is visible when `?forensic=1` is present, OR by default in FORENSIC_MODE. Disable with `?forensic=0`.
- Mount the new `<ForensicGateOverlay />` when the toggle is on and `isMonitoring` is true.

### 3. New component `src/components/ForensicGateOverlay.tsx`
A compact, fixed-position panel (top-right, ~280 px wide, semi-transparent dark bg, monospace, pointer-events-none so it never blocks the camera view). Shows:
- Three large status pills in a row: **G1 ÓPTICA**, **G2 ESPECTRAL**, **G3 MORFOLOGÍA** — green when pass, red when fail, grey when unknown/null.
- One "VEREDICTO" line driven by `passAll`: green “PULSO REAL DETECTADO” / red “SIN PULSO VÁLIDO”.
- Live numeric readouts (fixed-width rows):
  - `SNR cardíaca: XX.X dB` (color: ≥6 green, 3–6 amber, <3 red)
  - `Pico: X.XX Hz  (≈ XXX BPM)`  (BPM = `peakHz * 60`, hidden if `peakHz === 0`)
  - `Concentración: XX %`
  - `Razón: <livenessReason>` (truncated to 48 chars; full text in `title`)
- Tiny legend footer: `G1 firma hemoglobina · G2 SNR ≥ 6 dB · G3 morfología 4/4`.

Props: `{ gate: ForensicGateSnapshot | null; visible: boolean }`. Pure presentational, no side effects, no timers.

### 4. `src/types/signal.d.ts`
- No schema change required (`forensicGate` already declared). Optionally export a `ForensicGateSnapshot` type alias of the existing inline shape so `ForensicGateOverlay` and `Index.tsx` share it.

## Out of scope
- No changes to gate thresholds, spectral verifier, or morphology rules.
- No new tests (the morphology bug fix is verifiable directly via the overlay; can be added later if requested).

## Risk & verification
- Removing the `window` global is strictly safer — today that call is a silent no-op.
- After this change `passAll` will flip true only when there really are 4 morphology-valid beats with G1+G2 also passing — exactly the forensic spec.
- Manual verification path:
  1. No finger → G1 red, G2 red, G3 red, veredicto SIN PULSO VÁLIDO.
  2. Finger placed → G1 turns green within ~5 frames.
  3. After ~1.5 s of clean signal → G2 turns green, SNR shows ≥6 dB, peak in 0.7–3.5 Hz.
  4. After 4 morphology-valid beats → G3 turns green, veredicto flips to PULSO REAL DETECTADO and the waveform/BPM start rendering.