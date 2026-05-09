import type {
  SafeMediaTrackCapabilities,
  SafeMediaTrackSettings,
} from "../types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) if (typeof v === "string") out.push(v);
  return out;
}

function asRange(
  value: unknown,
): { min: number; max: number } | undefined {
  if (!isObject(value)) return undefined;
  const min = asNumber(value.min, NaN);
  const max = asNumber(value.max, NaN);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return { min, max };
}

export function extractCapabilities(
  track: MediaStreamTrack,
): SafeMediaTrackCapabilities {
  const getter = (track as unknown as {
    getCapabilities?: () => unknown;
  }).getCapabilities;
  const raw: unknown = typeof getter === "function" ? getter.call(track) : {};
  const c: Record<string, unknown> = isObject(raw) ? raw : {};

  const widthMax = isObject(c.width) ? asNumber(c.width.max, 0) : 0;
  const heightMax = isObject(c.height) ? asNumber(c.height.max, 0) : 0;
  const frameRateMax = isObject(c.frameRate) ? asNumber(c.frameRate.max, 0) : 0;

  return {
    torch: c.torch === true,
    focusModes: asStringArray(c.focusMode),
    exposureModes: asStringArray(c.exposureMode),
    whiteBalanceModes: asStringArray(c.whiteBalanceMode),
    widthMax,
    heightMax,
    frameRateMax,
    iso: asRange(c.iso),
    exposureCompensation: asRange(c.exposureCompensation),
  };
}

export function extractSettings(
  track: MediaStreamTrack,
): SafeMediaTrackSettings {
  const getter = (track as unknown as {
    getSettings?: () => unknown;
  }).getSettings;
  const raw: unknown = typeof getter === "function" ? getter.call(track) : {};
  const s: Record<string, unknown> = isObject(raw) ? raw : {};

  return {
    width: asNumber(s.width, 0),
    height: asNumber(s.height, 0),
    frameRate: asNumber(s.frameRate, 0),
    facingMode: typeof s.facingMode === "string" ? s.facingMode : undefined,
    deviceId: typeof s.deviceId === "string" ? s.deviceId : undefined,
  };
}
