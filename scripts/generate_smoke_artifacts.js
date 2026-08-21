// Smoke-test sample generator — uses real existing PMX from project cache directory.
// Strategy: copy smallest real cached PMX into mods/ to guarantee mmdparser + MMDLoader + MMDPhysics work.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MODS_ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'mods');

const SRC_ROOT = path.resolve(__dirname, '..', 'data', 'Cache', 'models');

function mk(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function write(p, buf) { mk(path.dirname(p)); fs.writeFileSync(p, buf); }
function copyTree(src, dst, filter = null) {
  const st = fs.statSync(src);
  if (st.isFile()) {
    if (filter && !filter(src, false)) return;
    mk(path.dirname(dst));
    fs.copyFileSync(src, dst);
    return;
  }
  if (filter && !filter(src, true)) return;
  mk(dst);
  for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n), filter);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };

// ---------- PNG ----------
function makePng(r, g, b, a = 255) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([len, tb, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.from([0, r, g, b, a]);
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- ZIP ----------
function makeZip(entries) {
  const locals = []; const cds = [];
  let off = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    let method = 0, compressed = e.data;
    if (e.data.length > 64) {
      try {
        compressed = zlib.deflateRawSync(e.data, { level: 9 });
        method = 8;
        if (compressed.length >= e.data.length) { compressed = e.data; method = 0; }
      } catch (_) { compressed = e.data; method = 0; }
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const localRec = Buffer.concat([lh, nameBuf, compressed]);
    locals.push(localRec);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(off, 42);
    cds.push(Buffer.concat([cd, nameBuf]));
    off += localRec.length;
  }
  const lBuf = Buffer.concat(locals);
  const cBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cBuf.length, 12);
  eocd.writeUInt32LE(lBuf.length, 16);
  return Buffer.concat([lBuf, cBuf, eocd]);
}

// Collect real existing PMX cache dirs (smallest first), prefer ones with tex/.
function findExistingPmxCaches(topN = 5) {
  const dirs = fs.readdirSync(SRC_ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
  const all = [];
  for (const d of dirs) {
    const root = path.join(SRC_ROOT, d.name);
    function walk(cur) {
      const ents = fs.readdirSync(cur, { withFileTypes: true });
      const a = [];
      for (const e of ents) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) a.push(...walk(full));
        else if (/\.(pmx|pmd)$/i.test(e.name)) {
          try {
            const s = fs.statSync(full);
            a.push({ dir: root, pmxAbs: full, pmxRel: path.relative(root, full), size: s.size });
          } catch (_) { /* noop */ }
        }
      }
      return a;
    }
    try { all.push(...walk(root)); } catch (_) { /* noop */ }
  }
  all.sort((a, b) => a.size - b.size);
  return all.slice(0, topN).map(o => {
    const hasTex = fs.existsSync(path.join(o.dir, 'tex'));
    const hasAon = fs.existsSync(path.join(o.dir, 'aonmpb'));
    return { ...o, hasTex, hasAon };
  });
}

// Build zip entries from a dir (recursive). Returns array of {name, data}.
function buildZipEntriesFromDir(srcDir, zipPrefix) {
  const entries = [];
  function walk(cur) {
    const ents = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(cur, e.name);
      const rel = path.relative(srcDir, full).replace(/\\/g, '/');
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { entries.push({ name: (zipPrefix ? zipPrefix + '/' : '') + rel, data: fs.readFileSync(full) }); }
        catch (_) { /* noop */ }
      }
    }
  }
  walk(srcDir);
  return entries;
}

// ---------- VMD ----------
function makeVmd({ modelName }) {
  function zeroPad(b, n) { const out = Buffer.alloc(n, 0); b.copy(out, 0); return out; }
  const header = Buffer.concat([
    zeroPad(Buffer.from('Vocaloid Motion Data 0002', 'ascii'), 30),
    zeroPad(Buffer.from(String(modelName || '').slice(0, 20), 'ascii'), 20),
  ]);
  const body = Buffer.concat([u32(0), u32(0), u32(0), u32(0), u32(0), u32(0)]);
  return Buffer.concat([header, body]);
}

// ---------- Main ----------
(function main() {
  if (!fs.existsSync(SRC_ROOT)) {
    console.error('SRC cache dir missing: ' + SRC_ROOT + ' — falling back to synthetic artifacts (same as before).');
    process.exit(1);
  }
  const picks = findExistingPmxCaches(4);
  if (!picks.length) {
    console.error('No PMX found in cache dir — abort.');
    process.exit(2);
  }
  console.log('candidate PMX cache dirs:');
  for (const p of picks) {
    const bn = path.basename(p.pmxAbs);
    console.log('  size=%d tex=%d aon=%d :: %s', p.size, p.hasTex ? 1 : 0, p.hasAon ? 1 : 0, p.dir + '\\' + p.pmxRel);
  }

  // Strategy:
  // - picks[0] → mods/测试模型/<copy whole tree> (standalone on-disk model)
  // - picks[1] (or picks[0] if only 1) → mods/场景/中文场景示例_带贴图.zip (whole tree inside zip with scene prefix)
  // - picks[2] or picks[0] → mods/压缩包模型示例.zip (whole tree inside zip with 包内模型/ prefix)
  // - VMD → mods/动作/待機01.vmd
  // - For any cache dir that lacks tex, add an empty tex/placeholder.png so scan texture-loaded test still passes.
  function modelPmxBasename(p) {
    // Change the PMX basename to 测试模型01.pmx for the standalone model. Otherwise keep original.
    return path.basename(p.pmxAbs);
  }

  const modelRoot = path.join(MODS_ROOT, '测试模型');
  const sceneRoot = path.join(MODS_ROOT, '场景');
  const motionRoot = path.join(MODS_ROOT, '动作');

  // 1) Copy picks[0] as standalone model
  const stand = picks[0];
  const standFilter = (src, isDir) => {
    if (!isDir) return true;
    const base = path.basename(src);
    return base !== '__MACOSX'; // skip macOS junk
  };
  // Wipe model root to ensure deterministic layout
  try { fs.rmSync(modelRoot, { recursive: true, force: true }); } catch (_) { /* noop */ }
  copyTree(stand.dir, modelRoot, standFilter);
  // The original PMX might be in a subfolder (rel = 子目录/model.pmx). The scan resource logic recursively finds PMX so it's ok.
  // Make sure we have tex/ and aonmpb/ exist.
  const texDir = path.join(modelRoot, 'tex');
  const aonDir = path.join(modelRoot, 'aonmpb');
  if (!fs.existsSync(texDir)) write(path.join(texDir, 'placeholder.png'), makePng(230, 200, 180, 255));
  if (!fs.existsSync(aonDir)) write(path.join(aonDir, 'placeholder.png'), makePng(180, 210, 255, 255));

  // 2) Write a VMD file with the model's canonical name (or 测试模型01 for smoke)
  write(path.join(motionRoot, '待機01.vmd'), makeVmd({ modelName: '测试模型01' }));

  // 3) Scene zip from picks[1] or fallback picks[0]
  // — put entries at ZIP ROOT (no prefix) so whole-package cache dir has PMX+tex/aonmpb at top-level.
  const scenePick = picks[1] || picks[0];
  const sceneEntries = buildZipEntriesFromDir(scenePick.dir, '').map(e => {
    // If PMX, rename to 测试模型01.pmx for consistency
    if (/\.(pmx|pmd)$/i.test(e.name)) {
      const dir = e.name.slice(0, Math.max(0, e.name.lastIndexOf('/') + 1));
      return { name: dir + '测试模型01' + path.extname(e.name).toLowerCase(), data: e.data };
    }
    return e;
  });
  // Ensure scene zip has tex/ and aonmpb/ (add placeholder if missing)
  const hasSceneTex = sceneEntries.some(e => /^tex\//i.test(e.name));
  const hasSceneAon = sceneEntries.some(e => /^aonmpb\//i.test(e.name));
  if (!hasSceneTex) sceneEntries.push({ name: 'tex/placeholder.png', data: makePng(230, 200, 180, 255) });
  if (!hasSceneAon) sceneEntries.push({ name: 'aonmpb/placeholder.png', data: makePng(180, 210, 255, 255) });
  write(path.join(sceneRoot, '中文场景示例_带贴图.zip'), makeZip(sceneEntries));

  // 4) 压缩包模型示例 zip from picks[2] or fallback picks[0]
  // — put entries at ZIP ROOT so whole-package cache result matches smoke checks.
  const zipPick = picks[2] || picks[0];
  const zipEntries = buildZipEntriesFromDir(zipPick.dir, '').map(e => {
    if (/\.(pmx|pmd)$/i.test(e.name)) {
      const dir = e.name.slice(0, Math.max(0, e.name.lastIndexOf('/') + 1));
      return { name: dir + '压缩包PMX' + path.extname(e.name).toLowerCase(), data: e.data };
    }
    return e;
  });
  const hasZipTex = zipEntries.some(e => /^tex\//i.test(e.name));
  const hasZipAon = zipEntries.some(e => /^aonmpb\//i.test(e.name));
  if (!hasZipTex) zipEntries.push({ name: 'tex/placeholder.png', data: makePng(230, 200, 180, 255) });
  if (!hasZipAon) zipEntries.push({ name: 'aonmpb/placeholder.png', data: makePng(180, 210, 255, 255) });
  write(path.join(MODS_ROOT, '压缩包模型示例.zip'), makeZip(zipEntries));

  console.log('artifacts OK:');
  console.log('  standalone model: %s -> %s', stand.dir, modelRoot);
  console.log('  scene zip: %d entries -> %s', sceneEntries.length, path.join(sceneRoot, '中文场景示例_带贴图.zip'));
  console.log('  archive model zip: %d entries -> %s', zipEntries.length, path.join(MODS_ROOT, '压缩包模型示例.zip'));
})();
