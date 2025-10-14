import { rgb2lab, deltaE } from './color.mjs';

export function buildPaletteLab(palette) {
  // If palette entries already include a Lab field, reuse it; otherwise compute.
  const entries = [];
  for (const entry of palette) {
    const [r, g, b] = entry.rgb;
    const existingLab = Array.isArray(entry.lab) && entry.lab.length === 3 ? entry.lab : null;
    entries.push({
      name: entry.name,
      free: !!entry.free,
      rgb: [r, g, b],
      lab: existingLab ? existingLab : rgb2lab([r, g, b]),
    });
  }
  return entries;
}

export function findNearestPaletteIndex(lab, paletteLab) {
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


