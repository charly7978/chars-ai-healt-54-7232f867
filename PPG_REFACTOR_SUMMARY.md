# PPG Refactor Summary

## Overview
Complete architectural rebuild of the PPG application to use real camera data only, eliminating all simulated or fake physiological values.

## New Architecture: `src/ppg/`

### Directory Structure
```
src/ppg/
├── camera/
│   ├── PpgCameraController.ts    # Rear camera + torch control
│   ├── CameraConstraints.ts      # Camera constraint definitions
│   ├── TorchController.ts        # Torch management
│   └── FrameSampler.ts           # Real ImageData capture (rVFC)
├── radiometry/
│   ├── SrgbLinearizer.ts         # sRGB → linear (IEC 61966-2-1)
│   ├── OpticalDensity.ts         # OD calculation with EWMA baseline
│   └── PixelStats.ts             # Pixel statistics (saturation, dark, valid)
├── roi/
│   ├── RoiScanner.ts             # Grid-based ROI scanning
│   ├── RoiTracker.ts             # Kalman-like ROI tracking
│   └── RoiQuality.ts             # ROI quality evaluation
├── signal/
│   ├── PpgTypes.ts               # Core type definitions
│   ├── RingBuffer.ts             # Zero-allocation circular buffer
│   ├── Timebase.ts               # Real-time timestamp + fps estimation
│   ├── PpgExtractor.ts           # Multi-channel extraction (G1/G2/G3)
│   ├── Detrender.ts              # Baseline removal (EWMA/median)
│   ├── HampelFilter.ts           # Outlier detection (MAD)
│   ├── BandpassFilter.ts         # Butterworth bandpass (0.7-4.0 Hz)
│   ├── SavitzkyGolay.ts          # Visual smoothing only
│   ├── BeatDetector.ts           # Elgendi + spectral validation
│   ├── SignalQualityIndex.ts     # Comprehensive SQI metrics
│   ├── SpectralAnalyzer.ts       # FFT/Welch analysis
│   └── PublicationGate.ts        # Strict publication criteria
├── ui/
│   ├── CardiacMonitorCanvas.tsx  # Full-screen cardiac monitor
│   ├── FloatingVitalsOverlay.tsx # Minimal vitals display
│   └── ForensicDebugPanel.tsx    # Detailed forensic metrics
├── hooks/
│   └── usePpgEngine.ts           # Single source of truth hook
└── index.ts                      # Central exports
```

## Key Features

### Camera Pipeline
- **Rear camera only** (`facingMode: "environment"`)
- **High resolution**: 1920x1080 ideal, 1280x720 minimum
- **High frame rate**: 60 fps ideal, 30 fps minimum
- **Torch enabled** and maintained with watchdog
- **Real frame capture** via `requestVideoFrameCallback` with rVFC fallback
- **No simulated data** - only real camera frames

### Radiometry
- **sRGB to linear** conversion per IEC 61966-2-1
- **Optical density** calculation with moving EWMA baseline
- **Pixel statistics**: saturation ratio, dark ratio, valid pixel ratio
- **Red dominance** for hemoglobin signature

### ROI System
- **Grid-based scanning** (8x8) without blocking measurement
- **Kalman-like tracking** for smooth ROI transitions
- **Quality metrics**: valid pixels, saturation, dark, spectral peak
- **Center bias** for ROI selection
- **Non-blocking** - camera always analyzes

### Signal Processing
- **Multi-channel extraction**: R/G/B linear, OD_R/OD_G/OD_B
- **G1**: Raw green linear mean
- **G2**: Detrended OD green
- **G3**: Bandpass-filtered OD green (ready for beat detection)
- **Ring buffers**: 20-second history for all channels
- **Real timestamps**: No assumed fps, calculated from actual frame times
- **Gap detection**: >250ms gaps marked as discontinuities

### Filters
- **Detrender**: EWMA, moving average, or median baseline removal
- **Hampel**: MAD-based outlier detection and replacement
- **Bandpass**: Butterworth biquad (0.7-4.0 Hz for HR band)
- **Savitzky-Golay**: Visual smoothing only (not for beat detection)

### Beat Detection
- **Elgendi approach**: Short/long moving averages, adaptive threshold
- **Refractory period**: 280ms minimum
- **RR interval validation**: 300-2000ms
- **Morphology check**: Ascending/descending slope
- **Spectral validation**: FFT peak between 0.7-4.0 Hz
- **BPM agreement**: Time vs frequency domain must match within ±8 BPM
- **Minimum 5 valid beats** for publication

### Signal Quality Index
- **Temporal SQI**: Variance stability
- **Spectral SQI**: Peak concentration and frequency
- **Morphology SQI**: Beat morphology quality
- **Perfusion SQI**: AC/DC ratio
- **Motion SQI**: Motion artifact level
- **Saturation SQI**: Saturation and dark ratios
- **FPS SQI**: Frame rate quality
- **Overall SQI**: Weighted combination (min 0.65 for publication)

### Publication Gate
**NO publish BPM if:**
- bufferDuration < 8s
- fpsMedian < 18
- validPixelRatio < 0.70
- saturationRatio > 0.45
- darkRatio > 0.40
- spectralPeakRatio < 0.35
- perfusionProxy < threshold
- beatsValid < 5
- RR_CV unreasonable
- BPM_time vs BPM_freq diff > 8 BPM
- sqiOverall < 0.65

**NO publish SpO2** without calibration
**NO publish waveform** as "real" without evidence

### UI Components
- **CardiacMonitorCanvas**: Full-screen, high-DPI canvas, edge-to-edge waveform
- **FloatingVitalsOverlay**: Minimal, transparent, floating cards
- **ForensicDebugPanel**: Drawer with detailed metrics (camera, ROI, signal, beats, publication)
- **ControlOverlay**: Start/Stop buttons

### Main Hook
- **usePpgEngine**: Single source of truth for entire pipeline
- Exposes: `start()`, `stop()`, `reset()`, `state`, `engineState`
- Manages all components internally
- No processing in UI components

## Files Created

### New Files (src/ppg/)
- `camera/PpgCameraController.ts` (318 lines)
- `camera/CameraConstraints.ts` (29 lines)
- `camera/TorchController.ts` (124 lines)
- `camera/FrameSampler.ts` (184 lines)
- `radiometry/SrgbLinearizer.ts` (66 lines)
- `radiometry/OpticalDensity.ts` (117 lines)
- `radiometry/PixelStats.ts` (172 lines)
- `roi/RoiScanner.ts` (183 lines)
- `roi/RoiTracker.ts` (118 lines)
- `roi/RoiQuality.ts` (327 lines)
- `signal/PpgTypes.ts` (84 lines)
- `signal/RingBuffer.ts` (87 lines)
- `signal/Timebase.ts` (118 lines)
- `signal/PpgExtractor.ts` (219 lines)
- `signal/Detrender.ts` (114 lines)
- `signal/HampelFilter.ts` (104 lines)
- `signal/BandpassFilter.ts` (145 lines)
- `signal/SavitzkyGolay.ts` (157 lines)
- `signal/BeatDetector.ts` (328 lines)
- `signal/SignalQualityIndex.ts` (165 lines)
- `signal/SpectralAnalyzer.ts` (67 lines)
- `signal/PublicationGate.ts` (123 lines)
- `ui/CardiacMonitorCanvas.tsx` (185 lines)
- `ui/FloatingVitalsOverlay.tsx` (152 lines)
- `ui/ForensicDebugPanel.tsx` (172 lines)
- `hooks/usePpgEngine.ts` (277 lines)
- `index.ts` (32 lines)

### Reference Implementation
- `src/pages/Index.new.tsx` (145 lines) - Reference for refactored architecture

### Scripts
- `scripts/audit-ppg.mjs` (88 lines) - Audit script for fake/simulated data

### Modified Files
- `package.json` - Added `audit:ppg` script and updated `ci:guard`

## Audit Script

The `npm run audit:ppg` command checks for:
- `Math.random` in production code
- Hardcoded BPM values
- Hardcoded SpO2 values
- Mock/fake/simulated keywords
- `setInterval` generating waveforms
- Vibration timers

## Publication Rules

### Technical States Displayed
When publication gate fails, the app shows technical status messages:
- `SEARCHING_SIGNAL` - Initial state
- `OPTICAL_CONTACT_CANDIDATE` - Some optical evidence
- `PPG_CANDIDATE` - Stronger evidence
- `NO_PPG_SIGNAL` - Insufficient signal
- `SATURATED` - Too much light
- `DARK_FRAME` - Too little light
- `MOTION_ARTIFACT` - Excessive motion
- `LOW_PERFUSION` - Weak perfusion

### Published Values
Only published when all gate criteria pass:
- **BPM**: Real-time calculated from confirmed beats
- **SpO2**: Only if calibrated (not implemented yet)
- **Waveform**: Only if SQI ≥ 0.65

## Next Steps

### To Complete Integration
1. Install dependencies: `npm install`
2. Replace `src/pages/Index.tsx` with `src/pages/Index.new.tsx` (or integrate gradually)
3. Run `npm run build` to verify build
4. Run `npm run audit:ppg` to verify no fake data
5. Test with real camera and finger

### To Remove Old Code
After verification:
1. Remove or deprecate old `src/modules/signal-processing/` files
2. Remove or deprecate old `src/hooks/usePpgCamera.ts`, `useSignalProcessor.ts`, etc.
3. Clean up unused imports
4. Remove dead code

## Summary

The new architecture provides:
- **Real camera data only** - no simulation
- **Centralized pipeline** under `src/ppg/`
- **Strict publication gate** - no fake values
- **Comprehensive forensic debug** - full visibility
- **Modern UI** - full-screen cardiac monitor
- **Type-safe** - full TypeScript
- **Testable** - modular design
- **Maintainable** - clear separation of concerns

Total new code: ~4,200 lines across 27 files
