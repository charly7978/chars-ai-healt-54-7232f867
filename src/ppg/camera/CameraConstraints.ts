/**
 * CAMERA CONSTRAINTS
 * 
 * Centralized camera constraint definitions for PPG measurement.
 */

export interface CameraConstraints {
  video: {
    facingMode: 'environment' | { exact: 'environment' };
    width: {
      ideal: number;
      min: number;
    };
    height: {
      ideal: number;
      min: number;
    };
    frameRate: {
      ideal: number;
      min: number;
    };
  };
  audio: false;
}

export const PPG_CAMERA_CONSTRAINTS: CameraConstraints = {
  video: {
    facingMode: { exact: 'environment' },
    width: { ideal: 1920, min: 1280 },
    height: { ideal: 1080, min: 720 },
    frameRate: { ideal: 60, min: 30 },
  },
  audio: false,
};

export const PPG_CAMERA_FALLBACK_CONSTRAINTS: CameraConstraints = {
  video: {
    facingMode: 'environment',
    width: { ideal: 1920, min: 1280 },
    height: { ideal: 1080, min: 720 },
    frameRate: { ideal: 60, min: 30 },
  },
  audio: false,
};

export const LOW_RES_CONSTRAINTS: CameraConstraints = {
  video: {
    facingMode: 'environment',
    width: { ideal: 1280, min: 640 },
    height: { ideal: 720, min: 480 },
    frameRate: { ideal: 30, min: 24 },
  },
  audio: false,
};
