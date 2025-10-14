// Higher-level color operations over Lab
import { rgb2lab, lab2rgb } from './color.mjs';

export const BAYER_8x8 = [
  [ 0, 48, 12, 60, 3, 51, 15, 63 ],
  [ 32, 16, 44, 28, 35, 19, 47, 31 ],
  [ 8, 56, 4, 52, 11, 59, 7, 55 ],
  [ 40, 24, 36, 20, 43, 27, 39, 23 ],
  [ 2, 50, 14, 62, 1, 49, 13, 61 ],
  [ 34, 18, 46, 30, 33, 17, 45, 29 ],
  [ 10, 58, 6, 54, 9, 57, 5, 53 ],
  [ 42, 26, 38, 22, 41, 25, 37, 21 ],
].map(row => row.map(v => v / 64));

export function applyRampedSaturationLab(LAB, satMin, satMax, maxBoost, gamma = 1.0, basis = 'chroma') {
  const L = LAB[0];
  const a = LAB[1];
  const b = LAB[2];
  const denom = (satMax - satMin) || 1;

  function shapeFromMetric(value) {
    if (!(value > satMin && value < satMax)) return 0;
    const tRaw = (satMax - value) / denom;
    const t = Math.max(0, Math.min(1, tRaw));
    if (gamma < 0) {
      return Math.pow(1 - t, Math.abs(gamma));
    }
    const g = gamma || 1.0;
    return Math.pow(t, g);
  }

  let shaped;
  if (basis === 'smart') {
    const chroma = Math.sqrt(a * a + b * b);
    const sChroma = shapeFromMetric(chroma);
    const sLight = shapeFromMetric(L);
    shaped = Math.max(sChroma, sLight);
  } else {
    const metric = basis === 'lightness' ? L : Math.sqrt(a * a + b * b);
    shaped = shapeFromMetric(metric);
  }

  if (shaped <= 0) return LAB;
  const factor = 1 + maxBoost * shaped;
  return [L, a * factor, b * factor];
}

export function applySelectiveDitherLab(LAB, x, y, ditherMin, ditherMax, ditherShift, basis = 'lightness') {
  const L = LAB[0];
  const a = LAB[1];
  const b = LAB[2];
  const C = Math.sqrt(a * a + b * b);
  let inBand;
  if (basis === 'smart') {
    inBand = ((L > ditherMin && L < ditherMax) || (C > ditherMin && C < ditherMax));
  } else if (basis === 'chroma') {
    inBand = (C > ditherMin && C < ditherMax);
  } else {
    inBand = (L > ditherMin && L < ditherMax);
  }
  if (!inBand) return LAB;
  const threshold = BAYER_8x8[y & 7][x & 7] - 0.5;
  const shift = threshold * (2 * ditherShift);
  const Ld = Math.max(0, Math.min(100, L + shift));
  return [Ld, a, b];
}


