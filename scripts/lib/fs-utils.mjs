import fsp from 'fs/promises';
import path from 'path';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function existsAsFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function* walkPngFiles(dir) {
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


