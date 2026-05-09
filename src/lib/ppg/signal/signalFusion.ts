/**
 * PCA cerrado para 3 canales RGB.
 * Eigendecomposición analítica de matriz simétrica 3x3 vía Cardano (O(1)).
 * Devuelve la proyección del primer componente principal.
 */
export class PcaSignalFusion {
  /** weights del último PC1 — [wR, wG, wB] */
  static lastWeights: [number, number, number] = [0, 1, 0];

  static computePrincipalComponent(
    rSignal: Float32Array,
    gSignal: Float32Array,
    bSignal: Float32Array
  ): Float32Array {
    const n = Math.min(rSignal.length, gSignal.length, bSignal.length);
    const out = new Float32Array(n);
    if (n < 8) return out;

    let mR = 0, mG = 0, mB = 0;
    for (let i = 0; i < n; i++) { mR += rSignal[i]; mG += gSignal[i]; mB += bSignal[i]; }
    mR /= n; mG /= n; mB /= n;

    let Cxx = 0, Cyy = 0, Czz = 0, Cxy = 0, Cxz = 0, Cyz = 0;
    for (let i = 0; i < n; i++) {
      const dr = rSignal[i] - mR;
      const dg = gSignal[i] - mG;
      const db = bSignal[i] - mB;
      Cxx += dr * dr; Cyy += dg * dg; Czz += db * db;
      Cxy += dr * dg; Cxz += dr * db; Cyz += dg * db;
    }
    Cxx /= n; Cyy /= n; Czz /= n; Cxy /= n; Cxz /= n; Cyz /= n;

    // Polinomio característico λ³ - p1 λ² + p2 λ - p3 = 0
    const p1 = Cxx + Cyy + Czz;
    const p2 = Cxx * Cyy + Cxx * Czz + Cyy * Czz - Cxy * Cxy - Cxz * Cxz - Cyz * Cyz;
    const p3 = Cxx * Cyy * Czz + 2 * Cxy * Cxz * Cyz - Cxx * Cyz * Cyz - Cyy * Cxz * Cxz - Czz * Cxy * Cxy;

    const q = p1 / 3;
    const A = Math.max(0, q * q - p2 / 3);
    const B = q * A - (q * q * q - q * p2 / 2 + p3 / 2);
    let angle = 0;
    const dist = A * Math.sqrt(A);
    if (dist > 1e-12) {
      let ratio = B / dist;
      if (ratio < -1) ratio = -1; else if (ratio > 1) ratio = 1;
      angle = Math.acos(ratio) / 3;
    }
    const sqrtA = Math.sqrt(A);
    const eig1 = q + 2 * sqrtA * Math.cos(angle);

    // Eigenvector dominante via (M - λI) — usando producto cruz de filas
    const m11 = Cxx - eig1, m22 = Cyy - eig1, m33 = Czz - eig1;
    let evX = m22 * m33 - Cyz * Cyz;
    let evY = Cxz * Cyz - Cxy * m33;
    let evZ = Cxy * Cyz - Cxz * m22;
    const mag = Math.sqrt(evX * evX + evY * evY + evZ * evZ) + 1e-9;
    evX /= mag; evY /= mag; evZ /= mag;

    PcaSignalFusion.lastWeights = [evX, evY, evZ];

    for (let i = 0; i < n; i++) {
      out[i] = (rSignal[i] - mR) * evX + (gSignal[i] - mG) * evY + (bSignal[i] - mB) * evZ;
    }
    return out;
  }
}
