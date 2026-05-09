/**
 * Closed-form PCA on a 3x3 covariance matrix of (R, G, B) channels.
 *
 * Eigenvalues are computed via Cardano's depressed cubic — runs in
 * nanoseconds without external math libraries. The principal eigenvector is
 * recovered by Gauss elimination on `(C - λ·I)`. The output sign is aligned
 * with the green channel so the projected signal stays physiologically
 * consistent across frames.
 */

const EPS = 1e-12;

export interface FusionResult {
  readonly value: number;
  readonly eigenvalue: number;
  readonly axis: Readonly<[number, number, number]>;
}

function cardanoEigenvalues(
  m00: number,
  m11: number,
  m22: number,
  m01: number,
  m02: number,
  m12: number,
): [number, number, number] {
  // Symmetric matrix => characteristic polynomial λ^3 - p2 λ^2 + p1 λ - p0.
  const p2 = m00 + m11 + m22;
  const p1 =
    m00 * m11 + m00 * m22 + m11 * m22 - m01 * m01 - m02 * m02 - m12 * m12;
  const det =
    m00 * (m11 * m22 - m12 * m12) -
    m01 * (m01 * m22 - m12 * m02) +
    m02 * (m01 * m12 - m11 * m02);

  // Depressed cubic substitution λ = t + p2/3.
  const a = -p2;
  const b = p1;
  const c = -det;
  const shift = -a / 3;
  const p = b - (a * a) / 3;
  const q = (2 * (a * a * a)) / 27 - (a * b) / 3 + c;
  const half = q / 2;
  const third = p / 3;
  const disc = half * half + third * third * third;

  if (disc > 0) {
    // One real root + two complex; numeric noise from a near-symmetric matrix.
    const sqrtDisc = Math.sqrt(disc);
    const u = Math.cbrt(-half + sqrtDisc);
    const v = Math.cbrt(-half - sqrtDisc);
    const root = u + v + shift;
    return [root, root, root];
  }

  const r = Math.sqrt(-third * third * third);
  const phi = Math.acos(Math.max(-1, Math.min(1, -half / Math.max(r, EPS))));
  const m = 2 * Math.cbrt(r);
  const t1 = m * Math.cos(phi / 3);
  const t2 = m * Math.cos((phi + 2 * Math.PI) / 3);
  const t3 = m * Math.cos((phi + 4 * Math.PI) / 3);
  return [t1 + shift, t2 + shift, t3 + shift];
}

function principalEigenvector(
  m00: number,
  m11: number,
  m22: number,
  m01: number,
  m02: number,
  m12: number,
  lambda: number,
): [number, number, number] {
  const a = m00 - lambda;
  const d = m11 - lambda;
  const f = m22 - lambda;

  // Try cross-product of two rows of (C - λI). Pick the most-independent pair.
  const r0x = a;
  const r0y = m01;
  const r0z = m02;
  const r1x = m01;
  const r1y = d;
  const r1z = m12;
  const r2x = m02;
  const r2y = m12;
  const r2z = f;

  const candidates: Array<[number, number, number]> = [
    [r0y * r1z - r0z * r1y, r0z * r1x - r0x * r1z, r0x * r1y - r0y * r1x],
    [r0y * r2z - r0z * r2y, r0z * r2x - r0x * r2z, r0x * r2y - r0y * r2x],
    [r1y * r2z - r1z * r2y, r1z * r2x - r1x * r2z, r1x * r2y - r1y * r2x],
  ];

  let best: [number, number, number] = [0, 1, 0];
  let bestNorm = 0;
  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n > bestNorm) {
      bestNorm = n;
      best = v;
    }
  }
  if (bestNorm < EPS) return [0, 1, 0];
  return [best[0] / bestNorm, best[1] / bestNorm, best[2] / bestNorm];
}

/** Online RGB-channel covariance accumulator with a fixed window. */
export class RgbPcaFusion {
  private readonly rs: Float32Array;
  private readonly gs: Float32Array;
  private readonly bs: Float32Array;
  private readonly capacity: number;
  private head = 0;
  private size = 0;

  constructor(windowSamples: number) {
    this.capacity = windowSamples;
    this.rs = new Float32Array(windowSamples);
    this.gs = new Float32Array(windowSamples);
    this.bs = new Float32Array(windowSamples);
  }

  pushAndProject(r: number, g: number, b: number): FusionResult {
    this.rs[this.head] = r;
    this.gs[this.head] = g;
    this.bs[this.head] = b;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;

    if (this.size < 8) {
      return {
        value: g,
        eigenvalue: 0,
        axis: [0, 1, 0],
      };
    }

    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (let i = 0; i < this.size; i++) {
      mr += this.rs[i];
      mg += this.gs[i];
      mb += this.bs[i];
    }
    mr /= this.size;
    mg /= this.size;
    mb /= this.size;

    let crr = 0;
    let cgg = 0;
    let cbb = 0;
    let crg = 0;
    let crb = 0;
    let cgb = 0;
    for (let i = 0; i < this.size; i++) {
      const dr = this.rs[i] - mr;
      const dg = this.gs[i] - mg;
      const db = this.bs[i] - mb;
      crr += dr * dr;
      cgg += dg * dg;
      cbb += db * db;
      crg += dr * dg;
      crb += dr * db;
      cgb += dg * db;
    }
    const inv = 1 / Math.max(1, this.size - 1);
    crr *= inv;
    cgg *= inv;
    cbb *= inv;
    crg *= inv;
    crb *= inv;
    cgb *= inv;

    const eigs = cardanoEigenvalues(crr, cgg, cbb, crg, crb, cgb);
    let lambda = eigs[0];
    if (eigs[1] > lambda) lambda = eigs[1];
    if (eigs[2] > lambda) lambda = eigs[2];
    const axis = principalEigenvector(
      crr,
      cgg,
      cbb,
      crg,
      crb,
      cgb,
      lambda,
    );

    // Sign-align with green so projection stays consistent.
    const sign = axis[1] < 0 ? -1 : 1;
    const ax0 = axis[0] * sign;
    const ax1 = axis[1] * sign;
    const ax2 = axis[2] * sign;

    const value = ax0 * (r - mr) + ax1 * (g - mg) + ax2 * (b - mb);
    return { value, eigenvalue: lambda, axis: [ax0, ax1, ax2] };
  }

  reset(): void {
    this.head = 0;
    this.size = 0;
  }
}
