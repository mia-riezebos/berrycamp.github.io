#!/usr/bin/env node
/**
 * Quantize all Celeste images to the wplace color palette using CIE Lab.
 *
 * Input:  public/img/celeste/**.png
 * Output: wplace-templates/quantized/**.png  (same relative structure)
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import { colorpalette as wplacePalette } from './lib/color-palette.mjs';
import { rgb2lab, lab2rgb, deltaE } from './lib/color.mjs';

let SOURCE_ROOT = path.join(process.cwd(), 'public', 'img', 'celeste');
let OUTPUT_ROOT = path.join(process.cwd(), 'wplace-templates', 'quantized');

function parseNumberArg(name, def) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v)) return v;
    }
    if (arg.startsWith(`--${name}=`)) {
      const v = Number(arg.split('=')[1]);
      if (!Number.isNaN(v)) return v;
    }
  }
  return def;
}

function parsePathArg(name, defAbs) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      const v = argv[i + 1];
      if (v) return path.resolve(process.cwd(), v);
    }
    if (arg.startsWith(`--${name}=`)) {
      const v = arg.split('=')[1];
      if (v) return path.resolve(process.cwd(), v);
    }
  }
  return defAbs;
}

function parseStringArg(name, def) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}` && i + 1 < argv.length) {
      return argv[i + 1];
    }
    if (arg.startsWith(`--${name}=`)) {
      return arg.split('=')[1];
    }
  }
  return def;
}

function computeQuantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(100, q));
  const pos = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const frac = pos - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

function computeMode(values, bins) {
  if (values.length === 0) return 0;
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return min;
  const bucketCount = Math.max(1, Math.floor(bins));
  const counts = new Array(bucketCount).fill(0);
  const width = (max - min) / bucketCount || 1;
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bucketCount) idx = bucketCount - 1;
    counts[idx]++;
  }
  let bestIdx = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[bestIdx]) bestIdx = i;
  }
  // Return bin center
  return min + (bestIdx + 0.5) * width;
}

function computeStat(values, kind, pctl, bins) {
  if (values.length === 0) return 0;
  const k = (kind || 'mean').toLowerCase();
  if (k === 'mean') {
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
  }
  if (k === 'median') {
    const s = values.slice().sort((a, b) => a - b);
    return computeQuantile(s, 50);
  }
  if (k === 'pctl' || k === 'percentile' || k === 'quantile') {
    const q = Number.isFinite(pctl) ? pctl : 50;
    const s = values.slice().sort((a, b) => a - b);
    return computeQuantile(s, q);
  }
  if (k === 'mode') {
    return computeMode(values, bins || 64);
  }
  // Fallback to mean
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function parseFlagArg(name) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) {
      const v = arg.split('=')[1];
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
      if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    }
  }
  return false;
}

function hasArg(name) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) return true;
    if (arg.startsWith(`--${name}=`)) return true;
  }
  return false;
}

async function existsAsFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// Using rgb2lab and deltaE from scripts/lib/color.mjs

/**
 * Apply saturation boost based on input chroma (C* = sqrt(a^2+b^2)).
 * For chroma in (satMin, satMax), ramp up to maxBoost at satMin.
 */
function applyRampedSaturationLab(LAB, satMin, satMax, maxBoost, gamma = 1.0, basis = 'chroma') {
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
    shaped = Math.max(sChroma, sLight); // choose the stronger boost
  } else {
    const metric = basis === 'lightness' ? L : Math.sqrt(a * a + b * b);
    shaped = shapeFromMetric(metric);
  }

  if (shaped <= 0) return LAB;
  const factor = 1 + maxBoost * shaped; // 1..1+maxBoost
  return [L, a * factor, b * factor];
}

const BAYER_8x8 = [
  [ 0, 48, 12, 60, 3, 51, 15, 63 ],
  [ 32, 16, 44, 28, 35, 19, 47, 31 ],
  [ 8, 56, 4, 52, 11, 59, 7, 55 ],
  [ 40, 24, 36, 20, 43, 27, 39, 23 ],
  [ 2, 50, 14, 62, 1, 49, 13, 61 ],
  [ 34, 18, 46, 30, 33, 17, 45, 29 ],
  [ 10, 58, 6, 54, 9, 57, 5, 53 ],
  [ 42, 26, 38, 22, 41, 25, 37, 21 ],
].map(row => row.map(v => v / 64));

function applySelectiveDitherLab(LAB, x, y, ditherMin, ditherMax, ditherShift, basis = 'lightness') {
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

/** Precompute CIE Lab for palette colors and build search indices. */
function buildPaletteLab(palette) {
  const entries = [];
  for (const entry of palette) {
    const [r, g, b] = entry.rgb;
    entries.push({
      name: entry.name,
      free: !!entry.free,
      rgb: [r, g, b],
      lab: rgb2lab([r, g, b]),
    });
  }
  return entries;
}

/** Find nearest palette entry using deltaE in CIE Lab. */
function findNearestPaletteIndex(lab, paletteLab) {
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < paletteLab.length; i++) {
    const d = deltaE(lab, paletteLab[i].lab);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function* walkPngFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkPngFiles(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      yield full;
    }
  }
}

async function quantizeImageFile(filePath, paletteLab, cache, outPathOverride) {
  const rel = path.relative(SOURCE_ROOT, filePath);
  const outPath = outPathOverride ? outPathOverride : path.join(OUTPUT_ROOT, rel);
  await ensureDir(path.dirname(outPath));

  const inputBuffer = await fsp.readFile(filePath);
  const png = PNG.sync.read(inputBuffer);
  const { width, height, data } = png; // RGBA

  let ditherMin = parseNumberArg('dither-min', 35);
  let ditherMax = parseNumberArg('dither-max', 65);
  const ditherShift = parseNumberArg('dither-shift', 3.0);
  let satMin = parseNumberArg('sat-min', 0);
  let satMax = parseNumberArg('sat-max', 35);
  const satBoost = parseNumberArg('sat-boost', 0.5); // 50% at satMin
  const autoDitherWindow = parseNumberArg('auto-dither-window', 0);
  const autoSatWindow = parseNumberArg('auto-sat-window', 0);
  const satGamma = parseNumberArg('sat-gamma', 1.0);
  const satBasis = parseStringArg('sat-basis', 'chroma'); // 'chroma' | 'lightness'
  const ditherBasis = parseStringArg('dither-basis', 'lightness'); // 'lightness' | 'chroma' | 'smart'
  const sampleStat = parseStringArg('sample-stat', 'mean'); // mean|median|pctl|mode
  const samplePctl = parseNumberArg('sample-pctl', 50); // used when sample-stat=pctl
  const sampleBins = parseNumberArg('sample-bins', 64); // used when sample-stat=mode
  const sampleStep = Math.max(1, parseNumberArg('sample-step', 4));
  const autoDitherProvided = hasArg('auto-dither-window');
  const autoSatProvided = hasArg('auto-sat-window');
  const debugSat = parseFlagArg('debug-sat');
  const debugDither = parseFlagArg('debug-dither');
  const debugPreview = parseFlagArg('debug-preview');

  // Subsample to compute average L* for dynamic ranges
  if (autoDitherProvided || autoSatProvided) {
    const samplesL = [];
    const samplesC = [];
    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const idx = (y * width + x) * 4;
        const a = data[idx + 3];
        if (a === 0) continue;
        const r = data[idx + 0];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const lab = rgb2lab([r, g, b]);
        samplesL.push(lab[0]);
        const ca = lab[1];
        const cb = lab[2];
        samplesC.push(Math.sqrt(ca * ca + cb * cb));
      }
    }
    const avgL = samplesL.length > 0 ? computeStat(samplesL, sampleStat, samplePctl, sampleBins) : 50;
    const avgC = samplesC.length > 0 ? computeStat(samplesC, sampleStat, samplePctl, sampleBins) : 25;

    if (autoDitherProvided) {
      if (autoDitherWindow === 0) {
        // Scale around avgL using current width
        const baseHalf = Math.max(0, (ditherMax - ditherMin) / 2);
        ditherMin = Math.max(0, avgL - baseHalf);
        ditherMax = Math.min(100, avgL + baseHalf);
      } else if (autoDitherWindow > 0) {
        // Positive: treat as absolute width as before
        const half = autoDitherWindow / 2;
        ditherMin = Math.max(0, avgL - half);
        ditherMax = Math.min(100, avgL + half);
      } else {
        // Negative: interpret as percentage (0..1) of avgL when magnitude <= 1, else absolute below avgL
        const w = Math.abs(autoDitherWindow);
        const maxBelow = w <= 1 ? (avgL * (1 - w)) : Math.max(0, avgL - w);
        ditherMin = 0;
        ditherMax = Math.max(0, Math.min(100, maxBelow));
      }
    }
    if (autoSatProvided) {
      const avgMetric = satBasis === 'chroma' ? avgC : avgL; // for 'smart', use lightness as anchor
      if (autoSatWindow === 0) {
        const baseHalf = Math.max(0, (satMax - satMin) / 2);
        satMin = Math.max(0, avgMetric - baseHalf);
        satMax = Math.min(100, avgMetric + baseHalf);
      } else if (autoSatWindow > 0) {
        const half = autoSatWindow / 2;
        satMin = Math.max(0, avgMetric - half);
        satMax = Math.min(100, avgMetric + half);
      } else { // negative -> scaled below average, pin min to 0
        const w = Math.abs(autoSatWindow);
        const maxBelow = w <= 1 ? (avgMetric * (1 - w)) : Math.max(0, avgMetric - w);
        satMin = 0;
        satMax = Math.max(0, Math.min(100, maxBelow));
      }
    }
  }

  const ditherEnabled = ditherMax > ditherMin && ditherShift > 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) {
      // Preserve fully transparent pixels
      continue;
    }
    const r = data[i + 0];
    const g = data[i + 1];
    const b = data[i + 2];

    const px = (i / 4) % width;
    const py = Math.floor((i / 4) / width);

    const lab0 = rgb2lab([r, g, b]);

    // Debug visualization paths
    if (debugPreview) {
      const lab1 = applyRampedSaturationLab(lab0, satMin, satMax, satBoost, satGamma);
      const labAdj = ditherEnabled ? applySelectiveDitherLab(lab1, px, py, ditherMin, ditherMax, ditherShift) : lab1;
      const [pr, pg, pb] = lab2rgb(labAdj);
      data[i + 0] = Math.max(0, Math.min(255, Math.round(pr)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(pg)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(pb)));
      continue;
    }

    if (debugSat) {
      const a0 = lab0[1];
      const b0 = lab0[2];
      const C0 = Math.sqrt(a0 * a0 + b0 * b0);
      const satAffected = (C0 > satMin && C0 < satMax);
      if (satAffected) {
        data[i + 0] = 255; // magenta
        data[i + 1] = 0;
        data[i + 2] = 255;
      } else {
        data[i + 0] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      continue;
    }

    if (debugDither) {
      // Evaluate dither band AFTER saturation adjustment (respect basis)
      const lab1 = applyRampedSaturationLab(lab0, satMin, satMax, satBoost, satGamma, satBasis);
      const L1 = lab1[0];
      const a1 = lab1[1];
      const b1 = lab1[2];
      const C1 = Math.sqrt(a1 * a1 + b1 * b1);
      let ditherAffected = false;
      if (ditherEnabled) {
        if (ditherBasis === 'smart') {
          ditherAffected = ((L1 > ditherMin && L1 < ditherMax) || (C1 > ditherMin && C1 < ditherMax));
        } else if (ditherBasis === 'chroma') {
          ditherAffected = (C1 > ditherMin && C1 < ditherMax);
        } else {
          ditherAffected = (L1 > ditherMin && L1 < ditherMax);
        }
      }
      if (ditherAffected) {
        data[i + 0] = 255; // yellow
        data[i + 1] = 255;
        data[i + 2] = 0;
      } else {
        data[i + 0] = r;
        data[i + 1] = g;
        data[i + 2] = b;
      }
      continue;
    }

    const baseKey = (r << 16) | (g << 8) | b;
    const key = ditherEnabled ? (baseKey ^ (((px & 7) << 3) | (py & 7))) : baseKey;
    let mapped;
    if (cache.has(key)) {
      mapped = cache.get(key);
    } else {
      const lab1 = applyRampedSaturationLab(lab0, satMin, satMax, satBoost, satGamma, satBasis);
      const lab = ditherEnabled ? applySelectiveDitherLab(lab1, px, py, ditherMin, ditherMax, ditherShift, ditherBasis) : lab1;
      const idx = findNearestPaletteIndex(lab, paletteLab);
      mapped = paletteLab[idx].rgb;
      cache.set(key, mapped);
    }

    data[i + 0] = mapped[0];
    data[i + 1] = mapped[1];
    data[i + 2] = mapped[2];
    // keep original alpha
  }

  const outputBuffer = PNG.sync.write({ width, height, data });
  await fsp.writeFile(outPath, outputBuffer);
  return { rel: outPathOverride ? path.relative(process.cwd(), outPath) : rel, width, height };
}

async function main() {
  // Resolve CLI overrides for input/output
  const inputPath = parsePathArg('input', SOURCE_ROOT);
  const outputPath = parsePathArg('output', OUTPUT_ROOT);

  const st = await fsp.stat(inputPath);
  if (st.isFile()) {
    SOURCE_ROOT = path.dirname(inputPath);
  } else {
    SOURCE_ROOT = inputPath;
  }
  OUTPUT_ROOT = outputPath;

  const paletteLab = buildPaletteLab(wplacePalette);

  const cache = new Map(); // rgb24 ^ cell -> [r,g,b] mapped
  let processed = 0;
  if (st.isFile()) {
    // Determine if output is a file path or directory
    const outExt = path.extname(outputPath).toLowerCase();
    let finalOutPath;
    if (outExt === '.png' || (await existsAsFile(outputPath))) {
      finalOutPath = outputPath;
    } else {
      await ensureDir(outputPath);
      finalOutPath = path.join(outputPath, path.basename(inputPath));
    }
    await ensureDir(path.dirname(finalOutPath));
    const { rel } = await quantizeImageFile(inputPath, paletteLab, cache, finalOutPath);
    processed++;
    // eslint-disable-next-line no-console
    console.log(`Processed ${processed}: ${rel}`);
  } else {
    await ensureDir(OUTPUT_ROOT);
    for await (const file of walkPngFiles(SOURCE_ROOT)) {
    const { rel } = await quantizeImageFile(file, paletteLab, cache);
    processed++;
    if (processed % 25 === 0) {
      // eslint-disable-next-line no-console
      console.log(`Processed ${processed}: ${rel}`);
    }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`Done. Processed ${processed} images.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});


