// Sonido de finalización de medición usando Web Audio API
let audioCtx: AudioContext | null = null;

const getAudioContext = (): AudioContext => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
};

/**
 * Tono de finalización profesional: triple beep ascendente
 */
export const playCompletionSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const frequencies = [880, 1100, 1320]; // A5, C#6, E6 (acorde mayor)
    const durations = [0.12, 0.12, 0.25];
    let offset = 0;

    frequencies.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);

      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.3, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + durations[i]);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + offset);
      osc.stop(now + offset + durations[i] + 0.05);

      offset += durations[i] + 0.06;
    });
  } catch (e) {
    console.log('Audio no disponible:', e);
  }
};

/**
 * Beep corto de alerta (para arritmias)
 */
export const playAlertBeep = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(660, now);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch (e) {
    console.log('Audio no disponible:', e);
  }
};

/**
 * Pip cardíaco — tono corto sintetizado (sine 820 → 460 Hz, 100 ms).
 * Llamado por el hook UI en cada latido aceptado para dar realimentación
 * audible. Throttled a 220 ms para respetar el período refractario y
 * evitar zumbido cuando la tasa cae a algoritmo de seguridad.
 */
let lastHeartBeepAt = 0;
let audioUnlocked = false;
const tryUnlockAudio = () => {
  if (audioUnlocked) return;
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    audioUnlocked = true;
  } catch {}
};
if (typeof document !== 'undefined') {
  const onFirstInteraction = () => {
    tryUnlockAudio();
    document.removeEventListener('touchstart', onFirstInteraction);
    document.removeEventListener('click', onFirstInteraction);
  };
  document.addEventListener('touchstart', onFirstInteraction, { passive: true });
  document.addEventListener('click', onFirstInteraction, { passive: true });
}

export const playHeartBeep = () => {
  try {
    const now = performance.now();
    if (now - lastHeartBeepAt < 220) return;       // refractory
    lastHeartBeepAt = now;

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(820, t);
    osc.frequency.exponentialRampToValueAtTime(460, t + 0.08);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.10);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  } catch {
    /* ignore — audio just won't play */
  }
};
