export function computeQuantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(100, q));
  const pos = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const frac = pos - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

export function computeMode(values, bins = 64) {
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
  return min + (bestIdx + 0.5) * width;
}

export function computeStat(values, kind = 'mean', pctl = 50, bins = 64) {
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


