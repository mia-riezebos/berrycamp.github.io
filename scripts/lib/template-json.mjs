import fsp from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import celesteData from '../../data/celeste.json' with { type: 'json' };

let celesteIndex = null;

function buildIndex(data) {
  const chapterIndexById = new Map();
  const sideIndexByChapterId = new Map();
  const roomByPath = new Map(); // key: chapterId/sideId/roomId
  (data.chapters || []).forEach((chapter, cIdx) => {
    chapterIndexById.set(chapter.id, cIdx);
    const sideMap = new Map();
    sideIndexByChapterId.set(chapter.id, sideMap);
    (chapter.sides || []).forEach((side) => {
      sideMap.set(side.id, side);
      const rooms = side.rooms || {};
      Object.keys(rooms).forEach((roomId) => {
        roomByPath.set(`${chapter.id}/${side.id}/${roomId}`, rooms[roomId]);
      });
    });
  });
  return { data, chapterIndexById, sideIndexByChapterId, roomByPath };
}

export async function ensureCelesteIndex() {
  if (celesteIndex) return celesteIndex;
  celesteIndex = buildIndex(celesteData);
  return celesteIndex;
}

export function parseCelestePathFromImage(filePath) {
  // Expect segments: public/img/celeste/rooms/<chapter>/<side>/<room>.png
  const parts = filePath.split(path.sep);
  const roomsIdx = parts.lastIndexOf('rooms');
  if (roomsIdx === -1 || roomsIdx + 3 >= parts.length) return null;
  const chapter = parts[roomsIdx + 1];
  const side = parts[roomsIdx + 2];
  const file = parts[roomsIdx + 3];
  if (!file.toLowerCase().endsWith('.png')) return null;
  const roomId = file.slice(0, -4);
  return { chapter, side, roomId };
}

export async function emitBlueMarbleTemplate({
  inputImagePath,
  outputImagePath,
  width,
  height,
  startX,
  startY,
  startTileX,
  startTileY,
  startOffsetX,
  startOffsetY,
}) {
  const index = await ensureCelesteIndex();
  if (!index) return;

  const parsed = parseCelestePathFromImage(inputImagePath);
  if (!parsed) return;
  const { chapter, side, roomId } = parsed;
  const roomKey = `${chapter}/${side}/${roomId}`;
  const room = index.roomByPath.get(roomKey);
  if (!room || !room.canvas || !room.canvas.position) return;

  const tileSize = 1000;
  let absX;
  let absY;
  if (
    Number.isFinite(startTileX) && Number.isFinite(startTileY) &&
    Number.isFinite(startOffsetX) && Number.isFinite(startOffsetY)
  ) {
    absX = startTileX * tileSize + startOffsetX + (room.canvas.position.x || 0);
    absY = startTileY * tileSize + startOffsetY + (room.canvas.position.y || 0);
  } else {
    absX = startX + (room.canvas.position.x || 0);
    absY = startY + (room.canvas.position.y || 0);
  }

  // Read the quantized PNG (source) for shreaded tile generation
  const srcBuffer = await fsp.readFile(outputImagePath);
  const srcPng = PNG.sync.read(srcBuffer);
  const srcW = srcPng.width;
  const srcH = srcPng.height;
  const srcData = srcPng.data; // RGBA

  const shreadSize = 3;

  // Derive BM coords as in Template.js: [tileX, tileY, pxX, pxY]
  const offsetTileX = Math.floor(absX / tileSize);
  const offsetTileY = Math.floor(absY / tileSize);
  const offsetPxX = absX % tileSize;
  const offsetPxY = absY % tileSize;

  const tiles = {};

  // Helper to set center pixel in a PNG buffer
  function setCenterPixel(dstPng, dx, dy, r, g, b, a) {
    if (dx < 0 || dy < 0 || dx >= dstPng.width || dy >= dstPng.height) return;
    const idx = (dy * dstPng.width + dx) * 4;
    dstPng.data[idx + 0] = r;
    dstPng.data[idx + 1] = g;
    dstPng.data[idx + 2] = b;
    dstPng.data[idx + 3] = a;
  }

  function hasAnyOpaque(dstPng) {
    const data = dstPng.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  }

  // Iterate tile segments mirroring Template.js
  for (let pixelY = offsetPxY; pixelY < offsetPxY + srcH;) {
    const drawSizeY = Math.min(tileSize - (pixelY % tileSize), (offsetPxY + srcH) - pixelY);
    for (let pixelX = offsetPxX; pixelX < offsetPxX + srcW;) {
      const drawSizeX = Math.min(tileSize - (pixelX % tileSize), (offsetPxX + srcW) - pixelX);

      const destW = drawSizeX * shreadSize;
      const destH = drawSizeY * shreadSize;
      const dstPng = new PNG({ width: destW, height: destH, colorType: 6 });
      // Initialize fully transparent
      dstPng.data.fill(0);

      // Fill only the center pixel of each 3x3 block with source color
      for (let sy = 0; sy < drawSizeY; sy++) {
        const srcY = (pixelY - offsetPxY) + sy;
        for (let sx = 0; sx < drawSizeX; sx++) {
          const srcX = (pixelX - offsetPxX) + sx;
          const sIdx = (srcY * srcW + srcX) * 4;
          const r = srcData[sIdx + 0];
          const g = srcData[sIdx + 1];
          const b = srcData[sIdx + 2];
          const a = srcData[sIdx + 3];
          const dx = sx * shreadSize + 1; // middle pixel
          const dy = sy * shreadSize + 1;
          setCenterPixel(dstPng, dx, dy, r, g, b, a);
        }
      }

      if (hasAnyOpaque(dstPng)) {
        const tilePngBuffer = PNG.sync.write(dstPng);
        const tileBase64 = tilePngBuffer.toString('base64');

        const tileName = `${String(offsetTileX + Math.floor(pixelX / tileSize)).padStart(4, '0')},${String(offsetTileY + Math.floor(pixelY / tileSize)).padStart(4, '0')},${String(pixelX % tileSize).padStart(3, '0')},${String(pixelY % tileSize).padStart(3, '0')}`;
        tiles[tileName] = tileBase64;
      }

      pixelX += drawSizeX;
    }
    pixelY += drawSizeY;
  }

  const createdAt = new Date().toISOString();
  // Compose wplace 4-number coords: [tileX, tileY, offsetX, offsetY]
  const tileX = Math.floor(absX / tileSize);
  const tileY = Math.floor(absY / tileSize);
  const offsetX = absX % tileSize;
  const offsetY = absY % tileSize;
  const coordsStr = `${tileX}, ${tileY}, ${offsetX}, ${offsetY}`;
  const json = {
    whoami: 'BlueMarble',
    scriptVersion: '0.90.6',
    schemaVersion: '1.0.0',
    createdAt,
    lastModified: createdAt,
    templateCount: 1,
    totalPixels: width * height,
    templates: {
      [coordsStr]: {
        name: `celeste/${chapter}/${side}/${roomId}`,
        coords: coordsStr,
        createdAt,
        pixelCount: width * height,
        validPixelCount: width * height,
        transparentPixelCount: 0,
        enabled: true,
        disabledColors: [],
        enhancedColors: [],
        tiles,
      },
    },
  };

  const outDir = path.dirname(outputImagePath);
  const outFile = path.join(outDir, `${roomId}.json`);
  await fsp.writeFile(outFile, JSON.stringify(json, null, 2), 'utf8');
}

export async function composeSideImage({ entries, outImagePath }) {
  if (!entries || entries.length === 0) return null;
  // Compute bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entries) {
    minX = Math.min(minX, e.absX);
    minY = Math.min(minY, e.absY);
    maxX = Math.max(maxX, e.absX + e.width);
    maxY = Math.max(maxY, e.absY + e.height);
  }
  const totalW = Math.max(0, maxX - minX);
  const totalH = Math.max(0, maxY - minY);
  if (totalW === 0 || totalH === 0) return null;

  const big = new PNG({ width: totalW, height: totalH, colorType: 6 });
  big.data.fill(0);
  for (const e of entries) {
    const buf = await fsp.readFile(e.outputImagePath);
    const img = PNG.sync.read(buf);
    for (let y = 0; y < img.height; y++) {
      const srcRow = img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4);
      const dy = (e.absY - minY) + y;
      if (dy < 0 || dy >= big.height) continue;
      const dx = (e.absX - minX);
      if (dx < 0 || dx + img.width > big.width) {
        // Clip horizontally if needed
        const clipStart = Math.max(0, -dx);
        const clipEnd = Math.min(img.width, big.width - dx);
        if (clipEnd > clipStart) {
          const srcClipped = srcRow.subarray(clipStart * 4, clipEnd * 4);
          srcClipped.copyWithin(0, 0); // no-op, just ensure typed array
          big.data.set(srcClipped, (dy * big.width + (dx + clipStart)) * 4);
        }
      } else {
        big.data.set(srcRow, (dy * big.width + dx) * 4);
      }
    }
  }

  const outBuf = PNG.sync.write(big);
  await fsp.writeFile(outImagePath, outBuf);
  return { minX, minY, totalW, totalH };
}

export async function emitBlueMarbleImage({ imagePath, absX, absY, width, height, outFilePath, name }) {
  const shreadSize = 3;
  const tileSize = 1000;
  const srcBuffer = await fsp.readFile(imagePath);
  const srcPng = PNG.sync.read(srcBuffer);
  const srcW = srcPng.width;
  const srcH = srcPng.height;
  const srcData = srcPng.data;

  const tiles = {};
  function hasAnyOpaque(dstPng) {
    const data = dstPng.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  }
  for (let pixelY = 0; pixelY < srcH;) {
    const drawSizeY = Math.min(tileSize - ((absY + pixelY) % tileSize), srcH - pixelY);
    for (let pixelX = 0; pixelX < srcW;) {
      const drawSizeX = Math.min(tileSize - ((absX + pixelX) % tileSize), srcW - pixelX);
      const destW = drawSizeX * shreadSize;
      const destH = drawSizeY * shreadSize;
      const dstPng = new PNG({ width: destW, height: destH, colorType: 6 });
      dstPng.data.fill(0);
      for (let sy = 0; sy < drawSizeY; sy++) {
        const srcY = pixelY + sy;
        for (let sx = 0; sx < drawSizeX; sx++) {
          const srcX = pixelX + sx;
          const sIdx = (srcY * srcW + srcX) * 4;
          const r = srcData[sIdx + 0];
          const g = srcData[sIdx + 1];
          const b = srcData[sIdx + 2];
          const a = srcData[sIdx + 3];
          const dx = sx * shreadSize + 1;
          const dy = sy * shreadSize + 1;
          const dIdx = (dy * destW + dx) * 4;
          dstPng.data[dIdx + 0] = r;
          dstPng.data[dIdx + 1] = g;
          dstPng.data[dIdx + 2] = b;
          dstPng.data[dIdx + 3] = a;
        }
      }
      if (hasAnyOpaque(dstPng)) {
        const tileBuf = PNG.sync.write(dstPng);
        const tileBase64 = tileBuf.toString('base64');
        const tileName = `${String(Math.floor((absX + pixelX) / tileSize)).padStart(4, '0')},${String(Math.floor((absY + pixelY) / tileSize)).padStart(4, '0')},${String((absX + pixelX) % tileSize).padStart(3, '0')},${String((absY + pixelY) % tileSize).padStart(3, '0')}`;
        tiles[tileName] = tileBase64;
      }
      pixelX += drawSizeX;
    }
    pixelY += drawSizeY;
  }

  const createdAt = new Date().toISOString();
  const tileX = Math.floor(absX / tileSize);
  const tileY = Math.floor(absY / tileSize);
  const offsetX = absX % tileSize;
  const offsetY = absY % tileSize;
  const coordsStr = `${tileX}, ${tileY}, ${offsetX}, ${offsetY}`;

  const json = {
    whoami: 'BlueMarble',
    scriptVersion: '0.90.6',
    schemaVersion: '1.0.0',
    createdAt,
    lastModified: createdAt,
    templateCount: 1,
    totalPixels: width * height,
    templates: {
      [coordsStr]: {
        name: name || 'celeste/side',
        coords: coordsStr,
        createdAt,
        pixelCount: width * height,
        validPixelCount: width * height,
        transparentPixelCount: 0,
        enabled: true,
        disabledColors: [],
        enhancedColors: [],
        tiles,
      },
    },
  };

  await fsp.writeFile(outFilePath, JSON.stringify(json, null, 2), 'utf8');
}

export async function emitBlueMarbleSideTemplate({
  entries, // Array<{ outputImagePath, absX, absY, width, height }>
  outFilePath,
  chapterId,
  sideId,
}) {
  if (!entries || entries.length === 0) return;

  const shreadSize = 3;
  const tileSize = 1000;

  // Compute bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entries) {
    minX = Math.min(minX, e.absX);
    minY = Math.min(minY, e.absY);
    maxX = Math.max(maxX, e.absX + e.width);
    maxY = Math.max(maxY, e.absY + e.height);
  }
  const totalW = Math.max(0, maxX - minX);
  const totalH = Math.max(0, maxY - minY);

  const tiles = {};

  function setCenterPixel(dstPng, dx, dy, r, g, b, a) {
    if (dx < 0 || dy < 0 || dx >= dstPng.width || dy >= dstPng.height) return;
    const idx = (dy * dstPng.width + dx) * 4;
    dstPng.data[idx + 0] = r;
    dstPng.data[idx + 1] = g;
    dstPng.data[idx + 2] = b;
    dstPng.data[idx + 3] = a;
  }

  // For each image, generate its shreaded tiles and merge into tiles map
  function hasAnyOpaque(dstPng) {
    const data = dstPng.data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  }
  for (const e of entries) {
    const srcBuffer = await fsp.readFile(e.outputImagePath);
    const srcPng = PNG.sync.read(srcBuffer);
    const srcW = srcPng.width;
    const srcH = srcPng.height;
    const srcData = srcPng.data;

    const offsetPxX = e.absX % tileSize;
    const offsetPxY = e.absY % tileSize;

    for (let pixelY = offsetPxY; pixelY < offsetPxY + srcH;) {
      const drawSizeY = Math.min(tileSize - (pixelY % tileSize), (offsetPxY + srcH) - pixelY);
      for (let pixelX = offsetPxX; pixelX < offsetPxX + srcW;) {
        const drawSizeX = Math.min(tileSize - (pixelX % tileSize), (offsetPxX + srcW) - pixelX);

        const destW = drawSizeX * shreadSize;
        const destH = drawSizeY * shreadSize;
        const dstPng = new PNG({ width: destW, height: destH, colorType: 6 });
        dstPng.data.fill(0);

        for (let sy = 0; sy < drawSizeY; sy++) {
          const srcY = (pixelY - offsetPxY) + sy;
          for (let sx = 0; sx < drawSizeX; sx++) {
            const srcX = (pixelX - offsetPxX) + sx;
            const sIdx = (srcY * srcW + srcX) * 4;
            const r = srcData[sIdx + 0];
            const g = srcData[sIdx + 1];
            const b = srcData[sIdx + 2];
            const a = srcData[sIdx + 3];
            const dx = sx * shreadSize + 1;
            const dy = sy * shreadSize + 1;
            setCenterPixel(dstPng, dx, dy, r, g, b, a);
          }
        }

        if (hasAnyOpaque(dstPng)) {
          const tilePngBuffer = PNG.sync.write(dstPng);
          const tileBase64 = tilePngBuffer.toString('base64');

          const tileName = `${String(Math.floor(e.absX / tileSize) + Math.floor(pixelX / tileSize)).padStart(4, '0')},${String(Math.floor(e.absY / tileSize) + Math.floor(pixelY / tileSize)).padStart(4, '0')},${String(pixelX % tileSize).padStart(3, '0')},${String(pixelY % tileSize).padStart(3, '0')}`;
          tiles[tileName] = tileBase64;
        }

        pixelX += drawSizeX;
      }
      pixelY += drawSizeY;
    }
  }

  const createdAt = new Date().toISOString();
  const tileX = Math.floor(minX / tileSize);
  const tileY = Math.floor(minY / tileSize);
  const offsetX = minX % tileSize;
  const offsetY = minY % tileSize;
  const coordsStr = `${tileX}, ${tileY}, ${offsetX}, ${offsetY}`;

  const json = {
    whoami: 'BlueMarble',
    scriptVersion: '0.90.6',
    schemaVersion: '1.0.0',
    createdAt,
    lastModified: createdAt,
    templateCount: 1,
    totalPixels: totalW * totalH,
    templates: {
      [coordsStr]: {
        name: `celeste/${chapterId}/${sideId}`,
        coords: coordsStr,
        createdAt,
        pixelCount: totalW * totalH,
        validPixelCount: totalW * totalH,
        transparentPixelCount: 0,
        enabled: true,
        disabledColors: [],
        enhancedColors: [],
        tiles,
      },
    },
  };

  await fsp.writeFile(outFilePath, JSON.stringify(json, null, 2), 'utf8');
}

