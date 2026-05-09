/**
 * RR-tachogram interpolation for HRV spectral analysis.
 *
 * Why this — and not "upsample the raw PPG to 250 Hz":
 * HRV spectral metrics (LF, HF, LF/HF) are computed on the *tachogram*, i.e.
 * the series of beat-to-beat RR intervals indexed by time of beat occurrence.
 * The tachogram is irregularly sampled by definition. To run an FFT/Welch on
 * it you must first resample it onto a uniform grid. Cubic spline at 4 Hz is
 * the standard recommendation (Task Force of the European Society of
 * Cardiology, 1996) — it is the smallest fs that preserves the HF band
 * (0.15–0.40 Hz) without aliasing while remaining cheap on mobile.
 *
 * Resampling the raw PPG to 100–250 Hz adds zero new information when the
 * camera samples at 30 Hz; for HRV, the operation that matters is *here*.
 */

export interface TachogramSample {
  /** Time of beat occurrence in seconds. */
  readonly t: number;
  /** RR interval ending at this beat, in milliseconds. */
  readonly rr: number;
}

export interface ResampledTachogram {
  /** Uniform time vector in seconds. */
  readonly time: Float64Array;
  /** Interpolated RR values in milliseconds. */
  readonly rr: Float64Array;
  /** Sample rate of the uniform grid in Hz. */
  readonly fs: number;
}

/**
 * Build a tachogram from successive RR intervals (ms).
 * The first beat anchors the time axis at t = rr[0] / 1000.
 */
export function buildTachogramFromRR(rrMs: readonly number[]): TachogramSample[] {
  const out: TachogramSample[] = [];
  let t = 0;
  for (let i = 0; i < rrMs.length; i++) {
    const rr = rrMs[i];
    if (!Number.isFinite(rr) || rr <= 0) continue;
    t += rr / 1000;
    out.push({ t, rr });
  }
  return out;
}

/**
 * Natural cubic spline interpolation evaluated on a uniform grid.
 *
 * Solves the tridiagonal system for second derivatives M_i with the natural
 * boundary conditions M_0 = M_{n-1} = 0 in O(n) using the Thomas algorithm.
 * No external libraries; all buffers are typed arrays.
 *
 * @param tach   Irregular tachogram, strictly increasing in `t`.
 * @param fs     Target sample rate in Hz (default 4 Hz, per HRV guidelines).
 */
export function resampleTachogramCubic(
  tach: readonly TachogramSample[],
  fs = 4,
): ResampledTachogram {
  const n = tach.length;
  if (n < 2 || !(fs > 0)) {
    return { time: new Float64Array(0), rr: new Float64Array(0), fs };
  }

  // Defensive copy + sort by t to guarantee strict monotonicity.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = tach[i].t;
    ys[i] = tach[i].rr;
  }
  // Insertion sort — n is small (typically < 300 beats per session).
  for (let i = 1; i < n; i++) {
    const kx = xs[i];
    const ky = ys[i];
    let j = i - 1;
    while (j >= 0 && xs[j] > kx) {
      xs[j + 1] = xs[j];
      ys[j + 1] = ys[j];
      j--;
    }
    xs[j + 1] = kx;
    ys[j + 1] = ky;
  }

  // Step 1: build h_i = x_{i+1} - x_i and the RHS for the tridiagonal system.
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    h[i] = dx > 1e-9 ? dx : 1e-9;
  }

  // Step 2: solve for second derivatives M (natural spline: M[0]=M[n-1]=0).
  const M = new Float64Array(n);
  if (n >= 3) {
    const sub = new Float64Array(n - 2); // sub-diagonal
    const diag = new Float64Array(n - 2); // diagonal
    const sup = new Float64Array(n - 2); // super-diagonal
    const rhs = new Float64Array(n - 2);
    for (let i = 0; i < n - 2; i++) {
      sub[i] = h[i];
      diag[i] = 2 * (h[i] + h[i + 1]);
      sup[i] = h[i + 1];
      rhs[i] =
        6 * ((ys[i + 2] - ys[i + 1]) / h[i + 1] - (ys[i + 1] - ys[i]) / h[i]);
    }
    // Thomas algorithm (in-place on diag, rhs).
    for (let i = 1; i < n - 2; i++) {
      const w = sub[i] / diag[i - 1];
      diag[i] -= w * sup[i - 1];
      rhs[i] -= w * rhs[i - 1];
    }
    const m = new Float64Array(n - 2);
    m[n - 3] = rhs[n - 3] / diag[n - 3];
    for (let i = n - 4; i >= 0; i--) {
      m[i] = (rhs[i] - sup[i] * m[i + 1]) / diag[i];
    }
    for (let i = 0; i < n - 2; i++) M[i + 1] = m[i];
  }

  // Step 3: evaluate spline on uniform grid [xs[0], xs[n-1]] at step 1/fs.
  const t0 = xs[0];
  const t1 = xs[n - 1];
  const span = t1 - t0;
  const samples = Math.max(2, Math.floor(span * fs) + 1);
  const time = new Float64Array(samples);
  const rr = new Float64Array(samples);
  const dt = 1 / fs;

  let seg = 0;
  for (let k = 0; k < samples; k++) {
    const x = t0 + k * dt;
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const xi = xs[seg];
    const xj = xs[seg + 1];
    const hi = h[seg];
    const a = (xj - x) / hi;
    const b = (x - xi) / hi;
    const yi = ys[seg];
    const yj = ys[seg + 1];
    const Mi = M[seg];
    const Mj = M[seg + 1];
    // Standard cubic spline form.
    const value =
      a * yi +
      b * yj +
      ((a * a * a - a) * Mi + (b * b * b - b) * Mj) * (hi * hi) / 6;
    time[k] = x;
    rr[k] = value;
  }

  return { time, rr, fs };
}

/**
 * Convenience wrapper: RR (ms) -> uniform tachogram at `fs` Hz.
 */
export function interpolateRRSeries(
  rrMs: readonly number[],
  fs = 4,
): ResampledTachogram {
  return resampleTachogramCubic(buildTachogramFromRR(rrMs), fs);
}
