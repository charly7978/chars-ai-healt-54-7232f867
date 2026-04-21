/**
 * MORPHOLOGY UTILITIES
 *
 * Tiny 7×7 binary morphology primitives used by the AdaptiveROIMask to clean
 * up the per-tile contact mask before connected-component analysis. Pure
 * TypeScript, zero allocation per call (caller supplies the output buffer),
 * branchless inner loops.
 */

/**
 * 4-neighbour binary erosion. A cell stays 1 only if all 4 von-Neumann
 * neighbours (and itself) are 1. Border cells are treated as 0 (eroded out).
 *
 * `mask` and `out` must both be Uint8Array of length `gridSize * gridSize`.
 * Values are interpreted as boolean: 0 = background, ≥1 = foreground.
 */
export function erode4(mask: Uint8Array, out: Uint8Array, gridSize: number): void {
  const G = gridSize;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (!mask[i]) { out[i] = 0; continue; }
      const left  = x > 0 ? mask[i - 1] : 0;
      const right = x < G - 1 ? mask[i + 1] : 0;
      const up    = y > 0 ? mask[i - G] : 0;
      const down  = y < G - 1 ? mask[i + G] : 0;
      out[i] = (left && right && up && down) ? 1 : 0;
    }
  }
}

/**
 * 4-neighbour binary dilation. A cell becomes 1 if it or any 4-neighbour is 1.
 */
export function dilate4(mask: Uint8Array, out: Uint8Array, gridSize: number): void {
  const G = gridSize;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const i = y * G + x;
      if (mask[i]) { out[i] = 1; continue; }
      const left  = x > 0 ? mask[i - 1] : 0;
      const right = x < G - 1 ? mask[i + 1] : 0;
      const up    = y > 0 ? mask[i - G] : 0;
      const down  = y < G - 1 ? mask[i + G] : 0;
      out[i] = (left || right || up || down) ? 1 : 0;
    }
  }
}

/** Open = erode then dilate. Removes isolated speckle. Uses one scratch buffer. */
export function open4(mask: Uint8Array, scratch: Uint8Array, gridSize: number): void {
  erode4(mask, scratch, gridSize);
  dilate4(scratch, mask, gridSize);
}

/** Close = dilate then erode. Fills 1-cell holes inside the blob. */
export function close4(mask: Uint8Array, scratch: Uint8Array, gridSize: number): void {
  dilate4(mask, scratch, gridSize);
  erode4(scratch, mask, gridSize);
}

export interface ConnectedComponent {
  /** Tile indices that belong to the component. */
  members: number[];
  /** Bounding box in grid coordinates (inclusive). */
  minX: number; maxX: number; minY: number; maxY: number;
  /** Centroid in [0..1] grid space. */
  centroidX: number; centroidY: number;
  /** Area in tiles. */
  area: number;
}

/**
 * Find the largest 4-connected foreground component in a binary mask.
 * Returns null if the mask is empty. Iterative flood-fill using a small stack
 * (no recursion to avoid blowing up on noisy masks).
 */
export function largestComponent4(mask: Uint8Array, gridSize: number): ConnectedComponent | null {
  const G = gridSize;
  const N = G * G;
  const visited = new Uint8Array(N);
  let best: ConnectedComponent | null = null;
  const stack: number[] = [];

  for (let i = 0; i < N; i++) {
    if (!mask[i] || visited[i]) continue;
    // BFS/DFS flood fill
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const members: number[] = [];
    let minX = G, maxX = -1, minY = G, maxY = -1;
    let sumX = 0, sumY = 0;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      members.push(idx);
      const x = idx % G;
      const y = (idx / G) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      sumX += x; sumY += y;

      // 4-neighbours
      if (x > 0)     { const j = idx - 1; if (mask[j] && !visited[j]) { visited[j] = 1; stack.push(j); } }
      if (x < G - 1) { const j = idx + 1; if (mask[j] && !visited[j]) { visited[j] = 1; stack.push(j); } }
      if (y > 0)     { const j = idx - G; if (mask[j] && !visited[j]) { visited[j] = 1; stack.push(j); } }
      if (y < G - 1) { const j = idx + G; if (mask[j] && !visited[j]) { visited[j] = 1; stack.push(j); } }
    }

    const area = members.length;
    if (!best || area > best.area) {
      best = {
        members,
        minX, maxX, minY, maxY,
        centroidX: G > 1 ? (sumX / area) / (G - 1) : 0.5,
        centroidY: G > 1 ? (sumY / area) / (G - 1) : 0.5,
        area,
      };
    }
  }
  return best;
}