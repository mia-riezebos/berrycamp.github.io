#!/usr/bin/env node
/**
 * Quantize all Celeste images to the wplace color palette using CIE Lab.
 *
 * Input:  public/img/celeste/**.png
 * Output: wplace-templates/quantized/**.png  (same relative structure)
 */

import fsp from "fs/promises";
import path from "path";
import { PNG } from "pngjs";
import readline from "readline";
import { hasArg, parseFlagArg, parseNumberArg, parsePathArg, parseStringArg } from "./lib/args.mjs";
import { applyRampedSaturationLab, applySelectiveDitherLab } from "./lib/color-ops.mjs";
import { colorpalette as wplacePalette } from "./lib/color-palette.mjs";
import { lab2rgb, rgb2lab } from "./lib/color.mjs";
import { ensureDir, existsAsFile, walkPngFiles } from "./lib/fs-utils.mjs";
import { buildPaletteLab, findNearestPaletteIndex } from "./lib/palette.mjs";
import { computeStat } from "./lib/stats.mjs";
import { emitBlueMarbleTemplate, ensureCelesteIndex } from "./lib/template-json.mjs";

let SOURCE_ROOT = path.join(process.cwd(), "public", "img", "celeste");
let OUTPUT_ROOT = path.join(process.cwd(), "wplace-templates", "quantized");

function promptYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function quantizeImageFile(filePath, paletteLab, cache, outPathOverride, emitTemplateEnabled) {
    const rel = path.relative(SOURCE_ROOT, filePath);
    const outPath = outPathOverride ? outPathOverride : path.join(OUTPUT_ROOT, rel);
    await ensureDir(path.dirname(outPath));

    const inputBuffer = await fsp.readFile(filePath);
    const png = PNG.sync.read(inputBuffer);
    const { width, height, data } = png; // RGBA

    let ditherMin = parseNumberArg("dither-min", 35);
    let ditherMax = parseNumberArg("dither-max", 65);
    const ditherShift = parseNumberArg("dither-shift", 3.0);
    let satMin = parseNumberArg("sat-min", 0);
    let satMax = parseNumberArg("sat-max", 35);
    const satBoost = parseNumberArg("sat-boost", 0.5); // 50% at satMin
    const autoDitherWindow = parseNumberArg("auto-dither-window", 0);
    const autoSatWindow = parseNumberArg("auto-sat-window", 0);
    const satGamma = parseNumberArg("sat-gamma", 1.0);
    const satBasis = parseStringArg("sat-basis", "chroma"); // 'chroma' | 'lightness'
    const ditherBasis = parseStringArg("dither-basis", "lightness"); // 'lightness' | 'chroma' | 'smart'
    const sampleStat = parseStringArg("sample-stat", "mean"); // mean|median|pctl|mode
    const samplePctl = parseNumberArg("sample-pctl", 50); // used when sample-stat=pctl
    const sampleBins = parseNumberArg("sample-bins", 64); // used when sample-stat=mode
    const sampleStep = Math.max(1, parseNumberArg("sample-step", 4));
    const autoDitherProvided = hasArg("auto-dither-window");
    const autoSatProvided = hasArg("auto-sat-window");
    const debugSat = parseFlagArg("debug-sat");
    const debugDither = parseFlagArg("debug-dither");
    const debugPreview = parseFlagArg("debug-preview");
    const startX = parseNumberArg("start-x", 0);
    const startY = parseNumberArg("start-y", 0);
    const startTileX = parseNumberArg("start-tile-x", NaN);
    const startTileY = parseNumberArg("start-tile-y", NaN);
    const startOffsetX = parseNumberArg("start-offset-x", NaN);
    const startOffsetY = parseNumberArg("start-offset-y", NaN);
    const startCoordsStr = parseStringArg("start-coords", "");
    const chapterFilter = parseStringArg("chapter", "");
    const sideFilter = parseStringArg("side", "");
    let startTileXParsed = Number.isNaN(startTileX) ? undefined : startTileX;
    let startTileYParsed = Number.isNaN(startTileY) ? undefined : startTileY;
    let startOffsetXParsed = Number.isNaN(startOffsetX) ? undefined : startOffsetX;
    let startOffsetYParsed = Number.isNaN(startOffsetY) ? undefined : startOffsetY;
    if (startCoordsStr) {
        const parts = startCoordsStr.split(/[\s,]+/).map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
            [startTileXParsed, startTileYParsed, startOffsetXParsed, startOffsetYParsed] = parts;
        }
    }

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
                const maxBelow = w <= 1 ? avgL * (1 - w) : Math.max(0, avgL - w);
                ditherMin = 0;
                ditherMax = Math.max(0, Math.min(100, maxBelow));
            }
        }
        if (autoSatProvided) {
            const avgMetric = satBasis === "chroma" ? avgC : avgL; // for 'smart', use lightness as anchor
            if (autoSatWindow === 0) {
                const baseHalf = Math.max(0, (satMax - satMin) / 2);
                satMin = Math.max(0, avgMetric - baseHalf);
                satMax = Math.min(100, avgMetric + baseHalf);
            } else if (autoSatWindow > 0) {
                const half = autoSatWindow / 2;
                satMin = Math.max(0, avgMetric - half);
                satMax = Math.min(100, avgMetric + half);
            } else {
                // negative -> scaled below average, pin min to 0
                const w = Math.abs(autoSatWindow);
                const maxBelow = w <= 1 ? avgMetric * (1 - w) : Math.max(0, avgMetric - w);
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
        const py = Math.floor(i / 4 / width);

        const lab0 = rgb2lab([r, g, b]);

        // Debug visualization paths
        if (debugPreview) {
            const lab1 = applyRampedSaturationLab(lab0, satMin, satMax, satBoost, satGamma);
            const labAdj = ditherEnabled
                ? applySelectiveDitherLab(lab1, px, py, ditherMin, ditherMax, ditherShift)
                : lab1;
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
            const satAffected = C0 > satMin && C0 < satMax;
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
                if (ditherBasis === "smart") {
                    ditherAffected = (L1 > ditherMin && L1 < ditherMax) || (C1 > ditherMin && C1 < ditherMax);
                } else if (ditherBasis === "chroma") {
                    ditherAffected = C1 > ditherMin && C1 < ditherMax;
                } else {
                    ditherAffected = L1 > ditherMin && L1 < ditherMax;
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
        const key = ditherEnabled ? baseKey ^ (((px & 7) << 3) | (py & 7)) : baseKey;
        let mapped;
        if (cache.has(key)) {
            mapped = cache.get(key);
        } else {
            const lab1 = applyRampedSaturationLab(lab0, satMin, satMax, satBoost, satGamma, satBasis);
            const lab = ditherEnabled
                ? applySelectiveDitherLab(lab1, px, py, ditherMin, ditherMax, ditherShift, ditherBasis)
                : lab1;
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
    // Optionally emit BlueMarble template JSON alongside the PNG
    if (emitTemplateEnabled) {
        await emitBlueMarbleTemplate({
            inputImagePath: filePath,
            outputImagePath: outPath,
            width,
            height,
            startX,
            startY,
            startTileX: startTileXParsed,
            startTileY: startTileYParsed,
            startOffsetX: startOffsetXParsed,
            startOffsetY: startOffsetYParsed,
        });
    }
    return { rel: outPathOverride ? path.relative(process.cwd(), outPath) : rel, width, height };
}

async function main() {
    // Resolve CLI overrides for input/output
    const inputPath = parsePathArg("input", SOURCE_ROOT);
    const outputPath = parsePathArg("output", OUTPUT_ROOT);

    const st = await fsp.stat(inputPath);
    if (st.isFile()) {
        SOURCE_ROOT = path.dirname(inputPath);
    } else {
        SOURCE_ROOT = inputPath;
    }
    OUTPUT_ROOT = outputPath;

    const paletteLab = buildPaletteLab(wplacePalette);
    const chapterFilter = parseStringArg("chapter", "");
    const sideFilter = parseStringArg("side", "");
    const chapterProvided = hasArg("chapter");
    const sideProvided = hasArg("side");
    const emitTemplateFlag = parseFlagArg("emit-template");
    let proceedWithoutTemplates = true;
    if (emitTemplateFlag && !chapterProvided) {
        console.warn("emit-template requires --chapter. You can still quantize images without emitting templates.");
        const ans = await promptYesNo("Proceed to quantize all images without emitting templates? [Y/N] ");
        const ok = String(ans || "").trim().toLowerCase();
        if (!(ok === "y" || ok === "yes")) {
            console.log("Aborted by user.");
            return;
        }
        proceedWithoutTemplates = true;
    }

    const cache = new Map(); // rgb24 ^ cell -> [r,g,b] mapped
    let processed = 0;
    if (st.isFile()) {
        // Determine if output is a file path or directory
        const outExt = path.extname(outputPath).toLowerCase();
        let finalOutPath;
        if (outExt === ".png" || (await existsAsFile(outputPath))) {
            finalOutPath = outputPath;
        } else {
            await ensureDir(outputPath);
            finalOutPath = path.join(outputPath, path.basename(inputPath));
        }
        await ensureDir(path.dirname(finalOutPath));
        const { rel } = await quantizeImageFile(inputPath, paletteLab, cache, finalOutPath, emitTemplateFlag && chapterProvided);
        processed++;
        // eslint-disable-next-line no-console
        console.log(`Processed ${processed}: ${rel}`);
    } else {
        await ensureDir(OUTPUT_ROOT);
        const cel = await ensureCelesteIndex();
        if (cel && cel.data && Array.isArray(cel.data.chapters)) {
            // Iterate celeste.json order: chapters → sides → rooms
            for (const chapter of cel.data.chapters) {
                if (chapterFilter && chapter.id !== chapterFilter) continue;
                for (const side of chapter.sides || []) {
                    if (chapterProvided) {
                        const requiredSide = sideProvided ? sideFilter : "a";
                        if (requiredSide && side.id !== requiredSide) continue;
                    }
                    const rooms = side.rooms || {};
                    // Room keys are assumed ordered as desired
                    for (const roomId of Object.keys(rooms)) {
                        const candidate = path.join(SOURCE_ROOT, "rooms", chapter.id, side.id, `${roomId}.png`);
                        try {
                            await fsp.access(candidate);
                            const { rel } = await quantizeImageFile(candidate, paletteLab, cache, undefined, emitTemplateFlag && chapterProvided);
                            processed++;
                            if (processed % 25 === 0) {
                                console.log(`Processed ${processed}: ${rel}`);
                            }
                        } catch {
                            // Skip if file missing
                        }
                    }
                }
            }
        } else {
            // Fallback to file order if index missing
            for await (const file of walkPngFiles(SOURCE_ROOT)) {
                const { rel } = await quantizeImageFile(file, paletteLab, cache, undefined, emitTemplateFlag && chapterProvided);
                processed++;
                if (processed % 25 === 0) {
                    console.log(`Processed ${processed}: ${rel}`);
                }
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
