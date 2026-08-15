'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const seven = require('7zip-min');
const unrar = require('node-unrar-js');

const DEFAULT_ROOT = 'D:\\素材\\3D模型';
const MOTION_ROOT = path.join(DEFAULT_ROOT, '动作');

// 支持的模型 / 压缩包 / 文本扩展名
const MODEL_EXTS = new Set([
  '.pmx', '.pmd', '.vmd', '.vpd',
  '.gltf', '.glb', '.obj', '.fbx', '.stl', '.dae', '.ply', '.3ds',
]);
const ARCHIVE_EXTS = new Set(['.rar', '.zip', '.7z', '.tar', '.gz', '.xz']);
const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.cfg', '.ini', '.log', '.csv', '.xml', '.yaml', '.yml']);
const MOTION_EXTS = new Set(['.vmd', '.vpd']);

// 需要在 app ready 之前注册自定义协议
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mmd',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#F7F8FB',
    title: 'MMDModelViewer - 本地3D模型预览器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.MMD_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- mmd:// 协议：将本地文件映射为可 fetch 的 URL ----------
// 注意：必须手动返回带 CORS 头的 Response。
// MMDLoader 内部 TextureLoader 默认 crossOrigin='anonymous'，
// 若用 net.fetch(file://) 转发（无 ACAO 头），贴图会因跨源限制加载失败，模型显示为灰白色。
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.tga': 'image/x-tga',
  '.dds': 'image/x-dds',
  '.pmx': 'application/octet-stream',
  '.pmd': 'application/octet-stream',
  '.vmd': 'application/octet-stream',
  '.vpd': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

function registerMmdProtocol() {
  protocol.handle('mmd', async (request) => {
    try {
      const url = new URL(request.url);
      // pathname 形如 /D:/素材/3D模型/xxx.pmx
      let filePath = decodeURIComponent(url.pathname).replace(/^\//, '');
      filePath = path.resolve(filePath);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response('Not Found', { status: 404 });
      }
      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(data, {
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return new Response(String(err && err.message || err), { status: 500 });
    }
  });
}

// ---------- 目录扫描 ----------
function scanDir(rootPath, depth = 0) {
  const maxDepth = 8;
  const stat = fs.statSync(rootPath);
  const entry = {
    name: path.basename(rootPath) || rootPath,
    path: rootPath,
    type: stat.isDirectory() ? 'dir' : fileKind(rootPath),
    children: [],
    size: stat.isFile() ? stat.size : null,
  };

  if (!stat.isDirectory() || depth >= maxDepth) return entry;

  let items;
  try {
    items = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return entry;
  }

  items
    .filter((it) => !it.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    })
    .forEach((it) => {
      const full = path.join(rootPath, it.name);
      entry.children.push(scanDir(full, depth + 1));
    });

  return entry;
}

function fileKind(p) {
  const ext = path.extname(p).toLowerCase();
  if (MODEL_EXTS.has(ext)) return 'model';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'file';
}

// ---------- 压缩包解压到临时目录 ----------
// 缓存：archivePath -> { dest, createAt }，避免重复解压
const extractCache = new Map();

function extractArchive(archivePath) {
  return new Promise((resolve, reject) => {
    // 若已解压过且临时目录仍存在，直接复用
    const cached = extractCache.get(archivePath);
    if (cached && fs.existsSync(cached.dest)) {
      resolve(cached.dest);
      return;
    }
    extractCache.delete(archivePath);

    const dest = path.join(
      os.tmpdir(),
      'mmdviewer',
      crypto.createHash('md5').update(archivePath + Date.now()).digest('hex').slice(0, 12)
    );
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (mkErr) {
      reject(new Error('无法创建临时目录：' + (mkErr && mkErr.message || mkErr)));
      return;
    }

    const ext = path.extname(archivePath).toLowerCase();

    // 先校验归档文件可读性
    try {
      const fd = fs.openSync(archivePath, 'r');
      fs.closeSync(fd);
      const st = fs.statSync(archivePath);
      if (st.size === 0) {
        reject(new Error('压缩包为空文件（0 字节）'));
        return;
      }
    } catch (accErr) {
      reject(new Error('压缩包不可访问：' + (accErr && accErr.message || accErr)));
      return;
    }

    const finish = (err) => {
      if (err) {
        // 失败时清理残留下的目录，避免污染临时目录
        try { if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true, maxRetries: 2 }); } catch (_) { /* ignore */ }
        reject(new Error('解压失败：' + (err && err.message ? err.message : err)));
      } else {
        const entry = { dest, createdAt: Date.now() };
        extractCache.set(archivePath, entry);
        resolve(dest);
      }
    };

    if (ext === '.rar') {
      // RAR5：node-unrar-js（纯 JS/WASM，兼容中文路径，支持 RAR5 新特性）
      Promise.resolve().then(async () => {
        try {
          const extractor = await unrar.createExtractorFromFile({ filepath: archivePath, targetPath: dest });
          // 支持中文/非 ascii 文件名
          const extracted = extractor.extract();
          // 迭代驱动写入磁盘（files 迭代器会触发实际解压）
          let hasAny = false;
          for (const f of extracted.files) { hasAny = true; }
          if (!hasAny) {
            // 兼容旧版接口：可能返回的对象结构不同，退一步看目录里有无文件
            const hasAfter = fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
            if (!hasAfter) { finish(new Error('压缩包内没有任何文件（可能已损坏）')); return; }
          }
          finish(null);
        } catch (rarErr) {
          finish(rarErr);
        }
      }).catch(finish);
    } else if (ext === '.tar' || ext === '.gz' || ext === '.xz' || ext === '.tgz' || ext === '.txz') {
      // tar / gz / xz 用 node:zlib + tar-stream？为避免新增依赖，先用 7za，7za 支持 tar/tar.gz/tar.xz
      // 7zip-min 会把 .tar.gz 当作压缩包处理，内部调 7za 能识别
      try {
        seven.unpack(archivePath, dest, (err) => {
          if (err) {
            // 若 7za 识别失败，尝试当作普通 gz 解一层
            finish(err);
          } else {
            finish(null);
          }
        });
      } catch (zipErr) {
        finish(zipErr);
      }
    } else {
      // zip / 7z / 其余：7zip-min（内置 7za）
      try {
        seven.unpack(archivePath, dest, (err) => {
          if (!err) { finish(null); return; }
          // 常见错误：中文文件名乱码、分卷缺失、损坏。补充诊断信息
          const msg = String(err && err.message || err);
          let extra = '';
          if (/password|encrypted/i.test(msg)) extra = '（压缩包已加密，暂不支持带密码解压）';
          else if (/split|volume/i.test(msg)) extra = '（疑似分卷压缩，请确保所有分卷齐全）';
          else if (/empty|no such|cannot open/i.test(msg)) extra = '（文件不完整或路径含不可访问字符）';
          // 兜底：再用 7z list 看看能否识别
          try {
            seven.list ? seven.list(archivePath, (_lErr, _l) => finish(err)) : finish(err);
          } catch (_) {
            finish(new Error(msg + extra));
          }
        });
      } catch (zipErr) {
        finish(zipErr);
      }
    }
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('scan-dir', async (_evt, rootPath) => {
    try {
      const target = rootPath || DEFAULT_ROOT;
      if (!fs.existsSync(target)) {
        return { ok: false, error: `目录不存在：${target}` };
      }
      return { ok: true, data: scanDir(target) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('extract-archive', async (_evt, archivePath) => {
    try {
      const dest = await extractArchive(archivePath);
      return { ok: true, data: { dest, tree: scanDir(dest) } };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('choose-dir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择模型目录',
      properties: ['openDirectory'],
      defaultPath: DEFAULT_ROOT,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' };
    return { ok: true, data: res.filePaths[0] };
  });

  // 原生文件选择对话框（选模型/压缩包/动作文件）
  ipcMain.handle('show-open-dialog', async (_evt, opts) => {
    const filters = (opts && opts.filters) || [
      { name: '模型/压缩包', extensions: ['pmx', 'pmd', 'vmd', 'vpd', 'zip', '7z', 'rar', 'tar', 'gz', 'xz'] },
      { name: '所有文件', extensions: ['*'] },
    ];
    const res = await dialog.showOpenDialog(mainWindow, {
      title: (opts && opts.title) || '选择文件',
      properties: (opts && opts.properties) || ['openFile'],
      filters,
      defaultPath: (opts && opts.defaultPath) || DEFAULT_ROOT,
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' };
    return { ok: true, data: res.filePaths };
  });

  ipcMain.handle('save-screenshot', async (_evt, dataUrl, defaultName) => {
    try {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '保存模型截图',
        defaultPath: path.join(app.getPath('pictures') || os.homedir(), defaultName || 'model.png'),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(res.filePath, Buffer.from(base64, 'base64'));
      return { ok: true, data: res.filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('get-default-root', async () => ({ ok: true, data: DEFAULT_ROOT }));

  // 动作库根目录
  ipcMain.handle('get-motion-root', async () => {
    try {
      const ok = fs.existsSync(MOTION_ROOT) && fs.statSync(MOTION_ROOT).isDirectory();
      return { ok: true, data: ok ? MOTION_ROOT : null };
    } catch (e) {
      return { ok: true, data: null };
    }
  });

  // 读取文本文件内容（带大小上限，默认 2MB）
  ipcMain.handle('read-text-file', async (_evt, filePath, maxBytes = 2 * 1024 * 1024) => {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false, error: '文件不存在：' + filePath };
      }
      const st = fs.statSync(filePath);
      const total = st.size;
      const trunc = total > maxBytes;
      const len = trunc ? maxBytes : total;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      // 探测 UTF-8 / GBK：优先 utf-8，包含替换字符则尝试 gbk 解码（纯 JS，无额外依赖）
      let content;
      try {
        content = buf.toString('utf-8');
        // 若存在大量 U+FFFD，尝试用 gbk（Node 内置不带 gbk，简单用 'binary' 替代以便渲染侧显示）
        const bad = (content.match(/\uFFFD/g) || []).length;
        if (bad > 0 && bad / Math.max(1, content.length) > 0.02) {
          content = buf.toString('latin1'); // 至少能看到字节
        }
      } catch (_) {
        content = buf.toString('latin1');
      }
      return { ok: true, data: { content, total, truncated: trunc, size: total } };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 单层扫描（返回某目录下直接子项，用于面包屑快速导航）
  ipcMain.handle('scandir-flat', async (_evt, dirPath) => {
    try {
      if (!fs.existsSync(dirPath)) return { ok: false, error: '目录不存在：' + dirPath };
      if (!fs.statSync(dirPath).isDirectory()) return { ok: false, error: '路径不是目录：' + dirPath };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const arr = entries
        .filter((it) => !it.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-CN');
        })
        .map((it) => {
          const full = path.join(dirPath, it.name);
          let type;
          if (it.isDirectory()) type = 'dir';
          else if (it.isSymbolicLink() || it.isFile()) {
            type = fileKind(full);
          } else type = 'file';
          let size = null;
          if (type !== 'dir') {
            try { size = fs.statSync(full).size; } catch (_) { /* ignore */ }
          }
          return { name: it.name, path: full, type, size };
        });
      return { ok: true, data: arr };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 列出压缩包内部条目（不解压即可预览内容）
  ipcMain.handle('list-archive-contents', async (_evt, archivePath) => {
    try {
      if (!fs.existsSync(archivePath)) return { ok: false, error: '文件不存在' };
      const ext = path.extname(archivePath).toLowerCase();
      if (!ARCHIVE_EXTS.has(ext)) return { ok: false, error: '不支持的压缩包格式：' + ext };

      // zip/7z/tar.gz 等用 seven.list
      if (ext !== '.rar' && typeof seven.list === 'function') {
        return await new Promise((resolve) => {
          seven.list(archivePath, (err, list) => {
            if (err) {
              // seven.list 失败，退化为直接解压后 scandir（代价：会生成缓存）
              extractArchive(archivePath).then((dest) => {
                const tree = scanDir(dest);
                resolve({ ok: true, data: { kind: 'scandir', dest, tree } });
              }).catch((e) => resolve({ ok: false, error: String(e && e.message || e) }));
            } else {
              resolve({
                ok: true,
                data: {
                  kind: 'list',
                  entries: Array.isArray(list) ? list.map((it) => ({
                    name: it.name || String(it),
                    size: typeof it.size === 'number' ? it.size : null,
                    packed: typeof it.packed === 'number' ? it.packed : null,
                    attr: it.attr || null,
                    datetime: it.datetime || it.date || null,
                  })) : []
                }
              });
            }
          });
        });
      }

      // RAR：node-unrar-js 也有 list 能力
      if (ext === '.rar') {
        try {
          const extractor = await unrar.createExtractorFromFile({ filepath: archivePath });
          const it = extractor.extract();
          const entries = [];
          for (const f of it.files || []) {
            entries.push({
              name: f.name,
              size: typeof f.unpackSize === 'number' ? f.unpackSize : null,
              packed: typeof f.packSize === 'number' ? f.packSize : null,
              datetime: f.dateTime || null,
              attr: null,
            });
          }
          return { ok: true, data: { kind: 'list', entries } };
        } catch (rarErr) {
          return { ok: false, error: 'RAR 读取失败：' + (rarErr && rarErr.message || rarErr) };
        }
      }

      return { ok: false, error: '当前格式暂不支持列表预览：' + ext };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---------- ammo.wasm 目录路径（布料物理用） ----------
  ipcMain.handle('get-ammo-libs-dir', () => {
    return path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm', 'libs');
  });

  // ========== 缓存资源识别 & 管理 ==========

  function cachePaths() {
    const root = path.join(app.getPath('userData'), 'cache');
    return {
      root,
      models:  path.join(root, 'models'),
      motions: path.join(root, 'motions'),
      thumbs:  path.join(root, 'thumbs'),
      tmp:     path.join(root, 'tmp'),
      index:   path.join(root, 'index.json'),
    };
  }
  async function ensureCacheDirs() {
    const p = cachePaths();
    await Promise.all([p.root, p.models, p.motions, p.thumbs, p.tmp].map(d => fsp.mkdir(d, { recursive: true })));
    return p;
  }
  async function readIndex() {
    const p = cachePaths();
    try {
      const raw = await fsp.readFile(p.index, 'utf8');
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return { version: 1, items: [] };
      return data;
    } catch (e) {
      if (e && e.code === 'ENOENT') return { version: 1, items: [] };
      console.error('[cache] readIndex failed:', e);
      return { version: 1, items: [] };
    }
  }
  async function writeIndex(idx) {
    const p = cachePaths();
    await fsp.writeFile(p.index, JSON.stringify(idx, null, 2), 'utf8');
  }
  async function calcDirSize(dir) {
    let total = 0;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) total += await calcDirSize(fp);
        else if (ent.isFile()) {
          try { const s = await fsp.stat(fp); total += s.size; } catch (_) { /* noop */ }
        }
      }
    } catch (_) { /* noop */ }
    return total;
  }
  function itemId(type, keySource) {
    return (type === 'model' ? 'm_' : 'v_') +
      crypto.createHash('sha1').update(keySource).digest('hex').slice(0, 12);
  }
  function safeFilename(name) {
    return String(name || 'file')
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'file';
  }

  // ---- IPC: 缓存目录信息 ----
  ipcMain.handle('get-cache-dir-info', async () => {
    const p = await ensureCacheDirs();
    const total = await calcDirSize(p.root);
    return {
      root: p.root,
      models: p.models,
      motions: p.motions,
      thumbs: p.thumbs,
      tmp: p.tmp,
      totalSize: total,
    };
  });

  // ---- IPC: 获取缓存索引 ----
  ipcMain.handle('get-cache-index', async () => {
    await ensureCacheDirs();
    const idx = await readIndex();
    const totalSize = (idx.items || []).reduce((s, it) => s + (Number(it.cacheSize) || 0), 0);
    return { index: idx, totalSize };
  });

  // ---- IPC: 写入缩略图 PNG 并更新 index.thumb ----
  ipcMain.handle('write-cache-thumb', async (_e, { id, base64Png }) => {
    if (!id || !base64Png) return { ok: false, error: 'missing id or base64Png' };
    const p = await ensureCacheDirs();
    try {
      const clean = String(base64Png).replace(/^data:image\/png;base64,/i, '');
      const data = Buffer.from(clean, 'base64');
      const thumbPath = `thumbs/${id}.png`;
      const abs = path.join(p.root, thumbPath);
      await fsp.writeFile(abs, data);
      const idx = await readIndex();
      const it = Array.isArray(idx.items) ? idx.items.find(x => x && x.id === id) : null;
      if (it) { it.thumb = thumbPath; await writeIndex(idx); }
      return { ok: true, thumbPath };
    } catch (e) {
      console.error('[cache] writeCacheThumb failed:', e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  // ---- IPC: 删除指定缓存项（按 id） ----
  ipcMain.handle('delete-cache-items', async (_e, ids) => {
    if (!Array.isArray(ids)) return { deleted: [], failed: [] };
    const p = await ensureCacheDirs();
    const idx = await readIndex();
    const items = Array.isArray(idx.items) ? idx.items : [];
    const deleted = [];
    const failed  = [];
    for (const id of ids) {
      const i = items.findIndex(x => x && x.id === id);
      if (i < 0) { failed.push(String(id)); continue; }
      const it = items[i];
      try {
        if (it && it.cachePath) {
          const abs = String(it.cachePath).startsWith(p.root)
            ? String(it.cachePath)
            : path.join(p.root, String(it.cachePath));
          try { await fsp.unlink(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          try {
            const parentDir = path.dirname(abs);
            const rel = path.relative(p.root, parentDir);
            if (rel && !rel.startsWith('..')) {
              const ents = await fsp.readdir(parentDir);
              if (!ents.length) await fsp.rmdir(parentDir);
            }
          } catch (_) { /* noop */ }
        }
        if (it && it.thumb) {
          const tAbs = path.join(p.root, String(it.thumb));
          try { await fsp.unlink(tAbs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        items.splice(i, 1);
        deleted.push(String(id));
      } catch (e) {
        console.error('[cache] delete item failed:', id, e);
        failed.push(String(id));
      }
    }
    idx.items = items;
    await writeIndex(idx);
    return { deleted, failed };
  });

  // ---- IPC: 清空缓存（按 models/motions/all） ----
  ipcMain.handle('clear-cache', async (_e, scope) => {
    const p = await ensureCacheDirs();
    const idx = await readIndex();
    const items = Array.isArray(idx.items) ? idx.items : [];
    let removed = 0;
    let freedBytes = 0;
    const keep = [];
    for (const it of items) {
      const matches = scope === 'all'
        || (scope === 'models'  && it.type === 'model')
        || (scope === 'motions' && it.type === 'motion');
      if (matches) {
        removed++;
        freedBytes += Number(it.cacheSize) || 0;
      } else {
        keep.push(it);
      }
    }
    idx.items = keep;
    await writeIndex(idx);
    const tryRm = async (d) => { try { await fsp.rm(d, { recursive: true, force: true }); } catch (_) { /* noop */ } };
    if (scope === 'all') {
      await tryRm(p.models); await tryRm(p.motions); await tryRm(p.thumbs);
      await fsp.mkdir(p.models, { recursive: true });
      await fsp.mkdir(p.motions, { recursive: true });
      await fsp.mkdir(p.thumbs, { recursive: true });
    } else if (scope === 'models') {
      await tryRm(p.models); await fsp.mkdir(p.models, { recursive: true });
    } else if (scope === 'motions') {
      await tryRm(p.motions); await fsp.mkdir(p.motions, { recursive: true });
    }
    return { removed, freedBytes };
  });

  // ========== 资源扫描：本地目录 + 压缩包内部候选（PMX/PMD/VMD/VPD） ==========
  const scanTasks = new Map(); // taskId -> { cancelled:boolean, timeoutMs, startTime }

  function classifyExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === '.pmx' || e === '.pmd') return 'model';
    if (e === '.vmd' || e === '.vpd') return 'motion';
    return null;
  }
  function isArchiveFile(name) {
    return ARCHIVE_EXTS.has(path.extname(String(name || '').toLowerCase()));
  }
  function candidateKey(src) {
    // src: { sourcePath, archiveEntry? }
    return src.archiveEntry
      ? (src.sourcePath + '::' + src.archiveEntry)
      : src.sourcePath;
  }
  async function listArchiveEntries(archivePath) {
    try {
      if (!fs.existsSync(archivePath)) return [];
      const ext = path.extname(archivePath).toLowerCase();
      if (!ARCHIVE_EXTS.has(ext)) return [];
      if (ext !== '.rar' && typeof seven.list === 'function') {
        return await new Promise((resolve) => {
          seven.list(archivePath, (err, list) => {
            if (err) return resolve([]);
            if (!Array.isArray(list)) return resolve([]);
            resolve(list.map(it => ({
              name: String(it.name || it || ''),
              size: typeof it.size === 'number' ? it.size : null,
            })));
          });
        });
      }
      if (ext === '.rar') {
        try {
          const extractor = await unrar.createExtractorFromFile({ filepath: archivePath });
          const it = extractor.extract();
          return Array.from(it.files || []).map(f => ({
            name: String(f.name || ''),
            size: typeof f.unpackSize === 'number' ? f.unpackSize : null,
          }));
        } catch (_) { return []; }
      }
      return [];
    } catch (e) {
      console.error('[scan] listArchiveEntries failed:', archivePath, e);
      return [];
    }
  }
  async function collectFilesInRoot(root) {
    // 先广度枚举，收集全部普通文件绝对路径（含压缩包）与大致总数量用于总进度
    const out = [];
    let dirsCount = 0;
    try {
      const st = await fsp.stat(root);
      if (!st.isDirectory()) return { files: [], dirsApprox: 0 };
    } catch (_) { return { files: [], dirsApprox: 0 }; }
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch (_) { entries = []; }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
          dirsCount++;
        } else if (ent.isFile()) {
          out.push(full);
        }
      }
    }
    return { files: out, dirsApprox: dirsCount };
  }

  ipcMain.handle('start-resource-scan', async (evt, payload) => {
    const { roots, intoArchives = true } = payload || {};
    const taskId = 'scan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const win = BrowserWindow.fromWebContents(evt.sender);
    scanTasks.set(taskId, { cancelled: false, startTime: Date.now() });
    // 异步启动扫描（不阻塞 invoke 返回）
    (async () => {
      const task = scanTasks.get(taskId);
      try {
        const rootsArr = Array.isArray(roots) ? roots : [];
        if (!rootsArr.length) {
          win && win.webContents.send('scan-done', {
            taskId, candidates: [], totalCount: 0, totalSize: 0,
            error: '扫描根目录为空',
          });
          return;
        }
        // 1) 收集所有文件
        const collectJobs = rootsArr.map(r => collectFilesInRoot(r));
        const allCollected = await Promise.all(collectJobs);
        const allFiles = [];
        for (const c of allCollected) allFiles.push(...(c.files || []));
        // 2) 分类
        const modelOrMotionFiles = [];
        const archiveFiles = [];
        for (const f of allFiles) {
          const ext = path.extname(f).toLowerCase();
          const k = classifyExt(ext);
          if (k) modelOrMotionFiles.push({ abs: f, kind: k });
          else if (ARCHIVE_EXTS.has(ext)) archiveFiles.push({ abs: f });
        }
        // 总步骤：模型/动作文件数 + (intoArchives ? 压缩包数 : 0)
        const totalSteps = modelOrMotionFiles.length + (intoArchives ? archiveFiles.length : 0);
        let done = 0;
        const candidates = [];
        let totalSize = 0;
        const pushCandidate = ({ name, ext, sourcePath, sourceType, archiveEntry, sizeEstimate, type }) => {
          const id = itemId(type, candidateKey({ sourcePath, archiveEntry }));
          candidates.push({ id, name, ext, sourcePath, sourceType, archiveEntry, sizeEstimate, type });
          totalSize += Number(sizeEstimate) || 0;
        };
        const emitProgress = (currentDir) => {
          win && win.webContents.send('scan-progress', { taskId, done, total: totalSteps, currentDir: String(currentDir || '') });
        };
        // 先统计本地文件
        for (const mm of modelOrMotionFiles) {
          if (task && task.cancelled) break;
          const ext = path.extname(mm.abs).toLowerCase();
          const base = path.basename(mm.abs);
          let sizeEst = null;
          try { const s = await fsp.stat(mm.abs); sizeEst = s.size; } catch (_) { /* noop */ }
          pushCandidate({
            name: base,
            ext: ext.replace(/^\./, ''),
            sourcePath: mm.abs,
            sourceType: 'file',
            archiveEntry: null,
            sizeEstimate: sizeEst,
            type: mm.kind,
          });
          done++;
          if (done % 20 === 0 || done === totalSteps) emitProgress(mm.abs);
        }
        // 再处理压缩包（只识别，不解压内容，不复制）
        if (intoArchives && !task.cancelled) {
          for (const af of archiveFiles) {
            if (task && task.cancelled) break;
            const entries = await listArchiveEntries(af.abs);
            for (const ent of entries) {
              const ext = path.extname(ent.name).toLowerCase();
              const kind = classifyExt(ext);
              if (!kind) continue;
              const baseName = path.basename(ent.name);
              pushCandidate({
                name: baseName,
                ext: ext.replace(/^\./, ''),
                sourcePath: af.abs,
                sourceType: 'archive',
                archiveEntry: ent.name,
                sizeEstimate: Number(ent.size) || null,
                type: kind,
              });
            }
            done++;
            emitProgress(af.abs);
          }
        }
        const cancelled = task && task.cancelled;
        win && win.webContents.send('scan-done', {
          taskId,
          candidates,
          totalCount: candidates.length,
          totalSize,
          cancelled,
        });
      } catch (e) {
        console.error('[scan] fatal:', e);
        win && win.webContents.send('scan-done', {
          taskId, candidates: [], totalCount: 0, totalSize: 0,
          error: (e && e.message) || String(e),
        });
      } finally {
        scanTasks.delete(taskId);
      }
    })();
    return { taskId };
  });

  ipcMain.handle('cancel-resource-scan', async (_e, taskId) => {
    const t = scanTasks.get(String(taskId || ''));
    if (t) t.cancelled = true;
    return { ok: true };
  });

  // 缓存复制：把候选（文件或压缩包条目）实际复制/提取到 cache/models 或 cache/motions
  // Task 6 将在同一个 clear-cache handle 之后、registerIpc 闭合 } 之前继续追加实现。
  // 此处先留 stub（让 preload 中暴露的 API 不报错），真正落地在 Task 6。
  ipcMain.handle('cache-selected-resources', async (_e, payload) => {
    const taskId = String((payload && payload.taskId) || ('copy_' + Date.now().toString(36)));
    const win = BrowserWindow.fromWebContents(_e.sender);
    (async () => {
      win && win.webContents.send('cache-done', {
        taskId,
        summary: { ok: 0, fail: 0, indexVersion: 0 },
        error: 'cache-selected-resources 尚未实现（预计在 Task 6 落地）',
      });
    })();
    return { ok: true };
  });
}

// ---------- 冒烟测试模式（--smoke-test） ----------
async function runSmokeTest() {
  const results = [];
  const check = (name, ok, info) => {
    results.push({ name, ok, info });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`);
  };
  const logFile = path.join(app.getPath('userData'), 'smoke-result.json');
  const writeResults = () => {
    try {
      const failed = results.filter((r) => !r.ok);
      fs.writeFileSync(logFile, JSON.stringify({
        passed: results.length - failed.length, total: results.length, results,
      }, null, 2));
      console.log('[smoke] result file:', logFile);
    } catch (e) { /* ignore */ }
  };

  try {
    // 1. 默认目录存在性
    const rootExists = fs.existsSync(DEFAULT_ROOT);
    check('default-root-exists', rootExists, DEFAULT_ROOT);

    if (rootExists) {
      // 2. 扫描目录
      const tree = scanDir(DEFAULT_ROOT);
      const models = [];
      const archives = [];
      (function walk(n) {
        if (n.type === 'model') models.push(n.path);
        if (n.type === 'archive') archives.push(n.path);
        (n.children || []).forEach(walk);
      })(tree);
      check('scan-dir', models.length > 0, `发现 ${models.length} 个模型文件`);
      const pmx = models.find((m) => m.toLowerCase().endsWith('.pmx'));
      check('find-pmx', !!pmx, pmx || 'no pmx');

      // 2.5 压缩包解压（RAR5 + 中文路径）
      const rar = archives.find((a) => a.toLowerCase().endsWith('.rar'));
      if (rar) {
        try {
          const dest = await extractArchive(rar);
          const hasPmx = (function walk(p) {
            for (const it of fs.readdirSync(p, { withFileTypes: true })) {
              const full = path.join(p, it.name);
              if (it.isDirectory()) { if (walk(full)) return true; }
              else if (full.toLowerCase().endsWith('.pmx')) return true;
            }
            return false;
          })(dest);
          check('extract-rar', hasPmx, `${path.basename(rar)} -> ${dest}${hasPmx ? ' 含 PMX' : ''}`);
        } catch (e) {
          check('extract-rar', false, String(e && e.message || e));
        }
      } else {
        check('extract-rar', false, '未找到 rar 压缩包');
      }

      // 3. 加载页面
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15000);
        mainWindow.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      });

      // 4. preload API 完整
      const apiOk = await mainWindow.webContents.executeJavaScript(
        `!!(window.mmdAPI && window.mmdAPI.scanDir && window.mmdAPI.extractArchive && window.mmdAPI.mmdUrl)`
      );
      check('preload-api', apiOk, 'window.mmdAPI 完整');

      // 5. mmd:// URL 构造
      const urlOk = await mainWindow.webContents.executeJavaScript(
        `window.mmdAPI.mmdUrl(${JSON.stringify(pmx || '')})`
      );
      check('mmd-url', typeof urlOk === 'string' && urlOk.startsWith('mmd://'), urlOk || '');

      // 6. 实际加载 PMX 并渲染一帧（验证 bundle 内 Three.js + MMDLoader + mmd:// 全链路）
      if (pmx) {
        const loadOk = await mainWindow.webContents.executeJavaScript(`
          window.__mmdTest.loadAndMeasure(${JSON.stringify(pmx)})
        `);
        check('load-pmx-render', loadOk && loadOk.ok,
          loadOk.ok ? `包围盒 ${loadOk.size.join(' x ')}` : (loadOk && loadOk.error || 'no result'));

        // 6.5 贴图加载（防止模型发灰：材质 map 必须成功加载）
        const texOk = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            try {
              const r = await window.__mmdTest.mmdProbe(${JSON.stringify(pmx)});
              const s1 = r.step1 || {};
              const ok = s1.mmdMapComplete === true && s1.mmdMapImg === 'HTMLImageElement';
              return { ok, img: s1.mmdMapImg, complete: s1.mmdMapComplete, file: s1.mapFileName };
            } catch (e) {
              return { ok: false, error: String(e && e.message || e) };
            }
          })()
        `);
        check('texture-loaded', texOk && texOk.ok, texOk.ok
          ? `${texOk.file} (${texOk.complete ? 'complete' : 'pending'})`
          : (texOk && texOk.error || 'texture 未加载'));

        // 7. 截图导出（WebGL 渲染后 toDataURL）
        const shotOk = await mainWindow.webContents.executeJavaScript(`
          window.__mmdTest.renderShot(${JSON.stringify(pmx)})
        `);
        check('render-screenshot', shotOk && shotOk.ok, shotOk.ok
          ? `PNG dataURL ${(shotOk.len / 1024).toFixed(0)}KB`
          : (shotOk && shotOk.error || 'no result'));
      }
    }
  } catch (err) {
    check('smoke-crash', false, String(err && err.stack || err));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[smoke] RESULT: ${results.length - failed.length}/${results.length} passed`);
  // GUI 应用的 stdout 常被吞掉，把结果写到文件便于外部读取
  writeResults();
  app.exit(failed.length ? 1 : 0);
}

// ---------- 启动 ----------
app.whenReady().then(() => {
  console.log('[main] ready, argv:', JSON.stringify(process.argv));
  registerMmdProtocol();
  registerIpc();

  createWindow();
  if (process.argv.includes('--smoke-test')) {
    setTimeout(runSmokeTest, 1500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 让渲染进程也能引用 mmd:// 构造辅助（在 preload 中实现）
module.exports = { DEFAULT_ROOT, MODEL_EXTS };
