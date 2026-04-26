import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Auto-hide overlays after a period of inactivity.
 *
 * - Visible by default for `initialMs` after mount.
 * - Any pointer / touch / key activity revives them for `idleMs`.
 * - Force-visible while `pinned` is true (e.g. critical alert state).
 *
 * Returns:
 *   visible    — boolean to drive `data-overlay-visible`
 *   reveal()   — manually show overlays again (e.g. tap on canvas)
 */
export function useAutoHideOverlays(opts: {
  idleMs?: number;
  initialMs?: number;
  pinned?: boolean;
} = {}) {
  const { idleMs = 4000, initialMs = 4000, pinned = false } = opts;
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number | null>(null);

  const arm = useCallback((delay: number) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      timerRef.current = null;
    }, delay);
  }, []);

  const reveal = useCallback(() => {
    setVisible(true);
    if (!pinned) arm(idleMs);
  }, [arm, idleMs, pinned]);

  // Initial visibility window
  useEffect(() => {
    setVisible(true);
    if (pinned) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    arm(initialMs);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [arm, initialMs, pinned]);

  // Activity listeners
  useEffect(() => {
    if (pinned) return;
    const handler = () => reveal();
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointerdown", handler, opts);
    window.addEventListener("touchstart", handler, opts);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [reveal, pinned]);

  return { visible: pinned ? true : visible, reveal };
}
