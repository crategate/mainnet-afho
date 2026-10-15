#!/usr/bin/env node
// Normalize the market-status photo pools in place:
//   1. back up every ORIGINAL to ../originals-state-images/ (once per file)
//   2. downscale anything wider than 1600px (1600 covers the tile at 2x DPR)
//   3. steer mean brightness toward a common target with a CLAMPED gain so
//      no image pops as the bright/sore thumb in the rotation — subtle
//      sameness, not a flattening
//   4. re-encode (JPEG q82 / WebP q80 / AVIF q60) + strip metadata
//
// Run whenever new images are dropped:  node tools/normalize-state-images.mjs
// Re-running is safe: originals are only copied to the backup once, and the
// brightness gain is computed against the CURRENT file but clamped, so
// repeated runs converge instead of ratcheting.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../public/state-images');
const BACKUP = path.resolve(HERE, '../originals-state-images');
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const TARGET_MEAN = 95;   // 0-255 luma
const MIN_GAIN = 0.75;    // clamp — "subtle sameness, not too much"
const MAX_GAIN = 1.35;
const MAX_WIDTH = 1600;

const QUALITY = { '.jpg': 82, '.jpeg': 82, '.png': 82, '.webp': 80, '.avif': 60, '.gif': 82 };

const sh = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

function walk(dir, rel, out = []) {
    for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith('.')) continue;
        const p = path.join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (fs.statSync(p).isDirectory()) walk(p, r, out);
        else if (IMG_EXTS.has(path.extname(name).toLowerCase()) && !name.endsWith('.rejected')) out.push([p, r]);
    }
    return out;
}

function meanLuma(file) {
    // -depth 8 keeps 10-bit AVIFs on the 0-255 scale
    const out = sh('magick', file, '-resize', '64x64!', '-colorspace', 'gray',
        '-depth', '8', '-format', '%[fx:round(mean*255)]', 'info:');
    return Number(out);
}

const rows = [];
for (const [p, rel] of walk(ROOT, '')) {
    const before = meanLuma(p);
    const id = sh('identify', '-format', '%w %h', p);
    const [w0, h0] = id.split(' ').map(Number);
    const kb0 = Math.round(fs.statSync(p).size / 1024);

    const backupPath = path.join(BACKUP, rel);
    if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(p, backupPath);
    }

    const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_MEAN / before));
    const ext = path.extname(p).toLowerCase();
    const tmp = p + '.norm.tmp' + (ext === '.png' ? '.png' : '');
    const resize = w0 > MAX_WIDTH ? ['-resize', `${MAX_WIDTH}x>`] : [];
    // GIF/PNG stay lossless-ish (modulate only); others re-encode with quality
    const encode = (ext === '.gif' || ext === '.png') ? [] : ['-quality', String(QUALITY[ext] ?? 82)];
    execFileSync('magick', [p, ...resize, '-modulate', String(Math.round(gain * 100)), ...encode,
        '-strip', tmp.endsWith('.png') ? `${tmp}:` : tmp]);

    const finalPath = tmp.endsWith('.png') ? tmp.replace(/\.png$/, '') : tmp;
    fs.renameSync(finalPath, p);

    const after = meanLuma(p);
    const [w1, h1] = sh('identify', '-format', '%w %h', p).split(' ').map(Number);
    const kb1 = Math.round(fs.statSync(p).size / 1024);
    rows.push({ rel, w0, h0, w1, h1, kb0, kb1, before, after });
    const moved = before !== after ? ` lum ${before}->${after}` : ' lum ~';
    console.log(`${rel}: ${w0}x${h0} ${kb0}KB -> ${w1}x${h1} ${kb1}KB${moved}`);
}

const lum = rows.map((r) => r.after);
console.log(`\n${rows.length} normalized. Luma now ${Math.min(...lum)}-${Math.max(...lum)} (target ${TARGET_MEAN}). Originals in ${path.relative(process.cwd(), BACKUP)}/`);
