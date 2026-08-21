'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const seven = require('7zip-min');
const unrar = require('node-unrar-js');

// 7za 可执行文件路径：使用随包分发的原始 7za（vendor/7za.exe，打包时 asarUnpack 到 asar.unpacked）。
// 不能依赖 7zip-min 默认的 asar 路径改写（它按 process.argv[1] 是否含 "app.asar" 判断，
// 而打包版 argv 里不含该串，会从 asar 内部 spawn 7za.exe 导致 ENOENT）；
// 也不能用 node_modules/7zip-bin 下的 7za.exe（打包期为绕过 winCodeSign 符号链接权限被替换为
// 容错 wrapper，会把真实 exit code 2 误判为成功，掩盖解压失败）。
const SEVENZA_BIN = app.isPackaged
  ? path.join(__dirname, 'vendor', '7za.exe').replace('app.asar', 'app.asar.unpacked')
  : path.join(__dirname, 'vendor', '7za.exe');
seven.config({ binaryPath: SEVENZA_BIN });

// 软件安装目录：打包（安装/便携版）后为可执行文件所在目录（如 D:\Program Files\MMDModelViewer），
// 开发模式为项目根目录；默认根目录与缓存目录均基于它派生
const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;

// userData（含 settings.json 设置与 Cache 缓存）重定向到 <安装目录>/data，
// 规避系统盘 AppData 的沙箱/权限写限制；开发模式为 <项目根>/data
const CACHE_BASE = path.join(APP_DIR, 'data');

// 冒烟测试使用独立 userData：避免污染真实缓存
if (process.argv.includes('--smoke-test')) {
  app.setPath('userData', path.join(__dirname, '.smoke-userdata'));
} else {
  app.setPath('userData', CACHE_BASE);
}

// 默认根目录：<安装目录>/mods（模型/动作/场景资源默认存放处）
const DEFAULT_ROOT = path.join(APP_DIR, 'mods');

// ---------- 根目录设置（用户自定义，持久化 userData/settings.json） ----------
// root 为空字符串时回退 DEFAULT_ROOT；动作库/场景库固定为其下「动作」「场景」子目录
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
let rootSettings = { root: '' };
function loadRootSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    if (j && typeof j.root === 'string' && j.root) rootSettings.root = j.root;
  } catch (_) { /* 无设置文件时使用默认根 */ }
}
function saveRootSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ root: rootSettings.root }, null, 2));
  } catch (_) { /* ignore */ }
}
function effectiveRoot() { return rootSettings.root || DEFAULT_ROOT; }
function motionRootOf(base) { return path.join(base, '动作'); }
function sceneRootOf(base) { return path.join(base, '场景'); }
loadRootSettings();

// 支持的模型 / 压缩包 / 文本扩展名
// max/blend 为专有二进制格式，仅识别分类（可选中/缓存/入库），3D 预览走渲染层分流提示
const MODEL_EXTS = new Set([
  '.pmx', '.pmd', '.vmd', '.vpd',
  '.gltf', '.glb', '.obj', '.fbx', '.stl', '.dae', '.ply', '.3ds',
  '.max', '.blend',
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
    backgroundColor: '#0B0E14',
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
        // 贴图绝对路径兜底：部分游戏导出的 FBX 在二进制内记录作者机器的绝对贴图路径
        // （如 D:\Datamine\Fmodel\...\T_xxx.png），FBXLoader 拼到 mmd:// URL 后指向不存在的
        // 文件导致 404、模型显示为白色。此时按 URL 末尾文件名，沿目录链向上找「最近的已存在
        // 目录」重新定位（通常即模型所在目录），兜底解析贴图。
        if (/\.(png|jpe?g|bmp|gif|webp|tga|dds)$/i.test(filePath)) {
          const bn = path.basename(filePath);
          let dir = path.dirname(filePath);
          while (dir && dir !== path.dirname(dir)) {
            try {
              if (fs.statSync(dir).isDirectory()) {
                const cand = path.join(dir, bn);
                if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { filePath = cand; break; }
              }
            } catch (_) { /* 该层目录不存在，继续上溯 */ }
            dir = path.dirname(dir);
          }
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return new Response('Not Found', { status: 404 });
        }
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

// ---------- 压缩包解压目录：持久化缓存（跨程序启动复用，避免每次重解压） ----------
// 之前用 os.tmpdir() + Date.now()，每次启动必重解压，关机或 tmp 清理后也会失效；
// 现在放到 <userData>/Cache/extract/<sig>，sig 由 archivePath+size+mtimeMs 生成，
// 源压缩包未修改时下次启动直接命中。手动「一键清空」会同时清理该目录。
const extractCache = new Map();   // 运行期内存 map：archivePath -> { dest, createdAt }

function _extractRoot() {
  // userData 需 app.whenReady 之后才合法，这里用惰性函数即可（registerIpc 内 whenReady 后调用）
  try { return path.join(app.getPath('userData'), 'Cache', 'extract'); }
  catch (_) { return path.join(os.tmpdir(), 'mmdviewer'); }
}
function _extractSig(archivePath, stat) {
  const size = String(stat && stat.size || 0);
  const mtime = String(stat && stat.mtimeMs ? Math.floor(stat.mtimeMs) : 0);
  return crypto.createHash('md5')
    .update(String(archivePath || '') + '|' + size + '|' + mtime)
    .digest('hex')
    .slice(0, 20);
}
// 启动 / 解压前做一次 LRU：超过数量/容量阈值就删除最旧目录（避免持久化目录无限增长）
const EXTRACT_MAX_ENTRIES = 64;
const EXTRACT_MAX_BYTES  = 8 * 1024 * 1024 * 1024; // 8GB
async function pruneExtractCacheIfNeeded() {
  const root = _extractRoot();
  if (!fs.existsSync(root)) return;
  try {
    const entries = [];
    const names = await fsp.readdir(root);
    for (const name of names) {
      const full = path.join(root, name);
      let st;
      try { st = await fsp.stat(full); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      // 用目录 mtime 作为最近使用时间
      entries.push({ name, full, ts: st.mtimeMs });
    }
    // 计算总大小（只看第一层目录下的文件数：极端情况下算总量太慢，退化为"条目数+粗略"。
    // 为更准确，按目录数超阈值或总大小超上限才清。）
    let totalBytes = 0;
    for (const e of entries) {
      try { totalBytes += await calcDirSize(e.full); } catch (_) {}
    }
    if (entries.length <= EXTRACT_MAX_ENTRIES && totalBytes <= EXTRACT_MAX_BYTES) return;
    // 按 ts 升序（最旧先删），删到两条阈值都满足为止
    entries.sort((a, b) => a.ts - b.ts);
    for (const e of entries) {
      const nLeft = entries.length - entries.indexOf(e);
      if (nLeft <= EXTRACT_MAX_ENTRIES && totalBytes <= EXTRACT_MAX_BYTES) break;
      try {
        const freed = await calcDirSize(e.full);
        await fsp.rm(e.full, { recursive: true, force: true, maxRetries: 2 });
        totalBytes = Math.max(0, totalBytes - freed);
      } catch (_) { /* noop */ }
    }
  } catch (e) {
    console.warn('[cache] pruneExtractCacheIfNeeded failed:', e && e.message);
  }
}

function extractArchive(archivePath) {
  return new Promise(async (resolve, reject) => {
    // 0) 运行期内存缓存命中（同进程内多次解压同一包）
    const memCached = extractCache.get(archivePath);
    if (memCached && fs.existsSync(memCached.dest)) {
      resolve(memCached.dest);
      return;
    }
    extractCache.delete(archivePath);

    // 1) 预读压缩包 stat：用于签名（判断文件是否修改）+ 校验
    let stat;
    try {
      const fd = fs.openSync(archivePath, 'r');
      fs.closeSync(fd);
      stat = fs.statSync(archivePath);
      if (stat.size === 0) { reject(new Error('压缩包为空文件（0 字节）')); return; }
    } catch (accErr) {
      reject(new Error('压缩包不可访问：' + (accErr && accErr.message || accErr)));
      return;
    }

    // 2) 持久化缓存命中（跨进程 / 跨启动）
    const root = _extractRoot();
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
    const sig = _extractSig(archivePath, stat);
    const dest = path.join(root, sig);
    if (fs.existsSync(dest)) {
      // 轻量完整性校验：目录非空且至少有 1 个文件
      try {
        const any = fs.readdirSync(dest, { withFileTypes: true }).some(e => e.isFile() || e.isDirectory());
        if (any) {
          try { fs.utimesSync(dest, Date.now() / 1000, Date.now() / 1000); } catch (_) {}
          const entry = { dest, createdAt: Date.now() };
          extractCache.set(archivePath, entry);
          resolve(dest);
          return;
        }
        // 空目录：清掉重新解压
        try { fs.rmSync(dest, { recursive: true, force: true, maxRetries: 2 }); } catch (_) {}
      } catch (_) { /* 校验读失败：重新解压 */ }
    }
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (mkErr) {
      reject(new Error('无法创建解压目录：' + (mkErr && mkErr.message || mkErr)));
      return;
    }

    const ext = path.extname(archivePath).toLowerCase();

    const finish = (err) => {
      if (err) {
        // 失败时清理残留下的目录，避免留下半截目录下次误命中
        try { if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true, maxRetries: 2 }); } catch (_) { /* ignore */ }
        reject(new Error('解压失败：' + (err && err.message ? err.message : err)));
      } else {
        const entry = { dest, createdAt: Date.now() };
        extractCache.set(archivePath, entry);
        // 异步 LRU 修剪（不阻塞当前解压）
        pruneExtractCacheIfNeeded().catch(() => {});
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
      const target = rootPath || effectiveRoot();
      if (!fs.existsSync(target)) {
        return { ok: false, error: `目录不存在：${target}` };
      }
      return { ok: true, data: scanDir(target) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 扫描根目录下所有"Mod 压缩包"（含 .ini 描述符的 XXMI/3DMigoto Mod）
  // 排除非 mod 文件（如场景压缩包、模型压缩包等）
  ipcMain.handle('scan-mod-archives', async (_evt, rootPath) => {
    try {
      const target = rootPath || effectiveRoot();
      if (!fs.existsSync(target)) return { ok: false, error: '目录不存在' };

      // 递归收集所有压缩包
      const archives = [];
      (function walk(dir) {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (_) { return; }
        for (const it of items) {
          if (it.name.startsWith('.')) continue;
          const full = path.join(dir, it.name);
          if (it.isDirectory()) walk(full);
          else if (isArchiveFile(it.name)) archives.push({ path: full, name: it.name });
        }
      })(target);

      // 检查每个压缩包是否含 .ini（XXMI Mod 标志）
      const mods = [];
      for (const a of archives) {
        try {
          const entries = await listArchiveEntries(a.path);
          const hasIni = entries.some(e => e.name.toLowerCase().endsWith('.ini'));
          if (hasIni) {
            let size = null;
            try { size = fs.statSync(a.path).size; } catch (_) { /* noop */ }
            mods.push({ path: a.path, name: a.name, size });
          }
        } catch (_) { /* 跳过无法读取的压缩包 */ }
      }
      return { ok: true, data: mods };
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
      defaultPath: effectiveRoot(),
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
      defaultPath: (opts && opts.defaultPath) || effectiveRoot(),
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

  ipcMain.handle('get-default-root', async () => ({ ok: true, data: effectiveRoot() }));

  // 动作库根目录（<根>/动作）
  ipcMain.handle('get-motion-root', async () => {
    try {
      const motionRoot = motionRootOf(effectiveRoot());
      const ok = fs.existsSync(motionRoot) && fs.statSync(motionRoot).isDirectory();
      return { ok: true, data: ok ? motionRoot : null };
    } catch (e) {
      return { ok: true, data: null };
    }
  });

  // 场景模型根目录（<根>/场景）
  ipcMain.handle('get-scene-root', async () => {
    try {
      const sceneRoot = sceneRootOf(effectiveRoot());
      const ok = fs.existsSync(sceneRoot) && fs.statSync(sceneRoot).isDirectory();
      return { ok: true, data: ok ? sceneRoot : null };
    } catch (e) {
      return { ok: true, data: null };
    }
  });

  // 根目录设置：{ root, customized }
  ipcMain.handle('get-root-settings', async () => ({
    ok: true,
    data: { root: effectiveRoot(), customized: !!rootSettings.root },
  }));

  // 设置默认根目录（校验存在性并持久化到 userData/settings.json）
  ipcMain.handle('set-default-root', async (_evt, rootPath) => {
    try {
      const target = String(rootPath || '').trim();
      if (!target) return { ok: false, error: '根目录为空' };
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        return { ok: false, error: `目录不存在：${target}` };
      }
      rootSettings.root = target;
      saveRootSettings();
      console.log('[settings] 默认根目录已设置为', target);
      return { ok: true, data: { root: effectiveRoot() } };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
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

  // ---------- 加载 XXMI/3DMigoto Mod 压缩包 ----------
  // 解压 zip → 找 .ini → 解析部件 → 返回二进制文件路径与元数据
  // 渲染进程通过 mmd:// 协议 fetch 各 .buf/.ib/.dds 并自行解析为 Three.js 几何体
  ipcMain.handle('load-mod-archive', async (_evt, archivePath) => {
    try {
      if (!fs.existsSync(archivePath)) return { ok: false, error: '文件不存在' };
      const ext = path.extname(archivePath).toLowerCase();
      if (!ARCHIVE_EXTS.has(ext)) return { ok: false, error: '不支持的压缩包格式：' + ext };

      const dest = await extractArchive(archivePath);

      // 查找 .ini 文件（XXMI 导出的 mod 描述符）
      function findIni(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isFile() && e.name.toLowerCase().endsWith('.ini')) return path.join(dir, e.name);
          if (e.isDirectory()) { const r = findIni(path.join(dir, e.name)); if (r) return r; }
        }
        return null;
      }
      const iniFile = findIni(dest);
      if (!iniFile) return { ok: false, error: '压缩包内未找到 .ini 描述符（非 XXMI Mod）' };
      const iniText = fs.readFileSync(iniFile, 'utf-8');

      // --- 简易 INI 解析 ---
      const sections = {};
      let curSec = null;
      for (const line of iniText.split(/\r?\n/)) {
        const secMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (secMatch) { curSec = secMatch[1].trim(); sections[curSec] = {}; continue; }
        if (!curSec) continue;
        const kvMatch = line.match(/^\s*(\S+)\s*=\s*(.*)$/);
        if (kvMatch) {
          const k = kvMatch[1].trim();
          const v = kvMatch[2].trim();
          // 去掉行内注释
          const semi = v.indexOf(';');
          if (semi >= 0) sections[curSec][k] = v.slice(0, semi).trim();
          else sections[curSec][k] = v;
        }
      }

      // --- 收集 Resource 定义 ---
      const resources = {};
      for (const [secName, kv] of Object.entries(sections)) {
        if (!kv.filename) continue;
        resources[secName] = {
          filename: kv.filename,
          stride: kv.stride ? parseInt(kv.stride) : 0,
          type: kv.type || 'Texture',
          format: kv.format || null,
        };
      }

      // --- 收集 draw call（含 ib= 和 drawindexed= 的 TextureOverride 段） ---
      const positionRes = Object.keys(resources).filter(n => n.endsWith('Position'));
      const texcoordRes = Object.keys(resources).filter(n => n.endsWith('Texcoord'));
      const parts = [];

      for (const [secName, kv] of Object.entries(sections)) {
        if (!secName.startsWith('TextureOverride')) continue;
        if (!kv.ib || !kv.drawindexed) continue;
        if (kv.ib === 'null') continue;

        const ibRes = resources[kv.ib];
        if (!ibRes || !ibRes.filename) continue;

        // 解析 drawindexed = indexCount, startVertex, startIndex
        const diParts = kv.drawindexed.split(',').map(s => parseInt(s.trim()) || 0);
        const indexCount = diParts[0];
        if (indexCount <= 0) continue;

        // 按 section 名最长前缀匹配 Position / Texcoord 资源
        // section 名 = TextureOverrideColumbinaEyeHead，resource 名 = ResourceColumbinaEyePosition
        // 双方去掉各自前缀（TextureOverride / Resource）后做 startsWith 匹配
        const matchPrefix = (resList) => {
          const secBase = secName.replace(/^TextureOverride/, '');
          const candidates = resList
            .map(n => ({ res: n, base: n.replace(/^Resource/, '').replace(/Position$|Texcoord$/, ''), len: 0 }))
            .map(c => { c.len = c.base.length; return c; })
            .filter(c => secBase.startsWith(c.base))
            .sort((a, b) => b.len - a.len);
          return candidates.length > 0 ? resources[candidates[0].res] : null;
        };

        const posMatch = matchPrefix(positionRes);
        const tcMatch = matchPrefix(texcoordRes);
        if (!posMatch || !tcMatch) continue;

        // 查找 diffuse 贴图：优先 ps-t1（含 Diffuse），其次 ps-t0
        let diffuseRes = null;
        for (const key of ['ps-t1', 'ps-t0']) {
          if (kv[key] && resources[kv[key]] && resources[kv[key]].filename) {
            diffuseRes = resources[kv[key]];
            break;
          }
        }

        parts.push({
          name: secName,
          positionFile: path.join(dest, posMatch.filename),
          positionStride: posMatch.stride,
          texcoordFile: path.join(dest, tcMatch.filename),
          texcoordStride: tcMatch.stride,
          indexFile: path.join(dest, ibRes.filename),
          indexCount,
          diffuseTexture: diffuseRes ? path.join(dest, diffuseRes.filename) : null,
        });
      }

      if (parts.length === 0) return { ok: false, error: '未在 .ini 中找到有效的网格部件（含 ib + drawindexed 的段）' };

      const modName = path.basename(iniFile, '.ini');
      return { ok: true, data: { modName, modDir: dest, parts } };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // ---------- BC7 DDS -> PNG 解码（CPU 解压，绕过软件渲染器 BC7 硬解 bug） ----------
  // 返回 { ok, pngPath, url }，pngPath 为本地文件绝对路径，url 为可直接 fetch 的 file:// URL
  ipcMain.handle('decode-dds-to-png', async (_evt, ddsPath) => {
    try {
      if (!ddsPath || !fs.existsSync(ddsPath)) return { ok: false, error: 'DDS 文件不存在: ' + ddsPath };

      // 缓存目录：userData/dds-png-cache
      const cacheDir = path.join(app.getPath('userData'), 'dds-png-cache');
      await fsp.mkdir(cacheDir, { recursive: true });
      // 用 DDS 内容 hash 命名，避免不同 Mod 同名 DDS 冲突
      const stat = await fsp.stat(ddsPath);
      const key = path.basename(ddsPath, '.dds') + '_' + stat.size + '_' + Math.floor(stat.mtimeMs);
      const pngPath = path.join(cacheDir, key + '.png');

      // 已缓存且比 DDS 新，直接复用
      if (fs.existsSync(pngPath)) {
        const pngMtime = (await fsp.stat(pngPath)).mtimeMs;
        if (pngMtime >= stat.mtimeMs) {
          return { ok: true, pngPath, url: pathToFileURL(pngPath).href };
        }
      }

      // Python 可执行文件：优先用户安装路径，其次 PATH
      const pyCandidates = [
        'D:\\Python312\\python.exe',
        'C:\\Python312\\python.exe',
        'python',
      ];
      let pyExe = null;
      for (const c of pyCandidates) {
        try {
          if (c.includes(':')) {
            // 绝对路径，直接检查
            if (fs.existsSync(c)) { pyExe = c; break; }
          } else {
            // PATH 中的命令，用 -c 测试
            await new Promise((resolve, reject) => {
              execFile(c, ['-c', 'import sys'], { windowsHide: true }, (e) => e ? reject(e) : resolve());
            });
            pyExe = c; break;
          }
        } catch (_) { /* 继续尝试下一个 */ }
      }
      if (!pyExe) return { ok: false, error: '未找到 Python 可执行文件（请安装 Python 3 到 D:\\Python312 或加入 PATH）' };

      // texture2ddecoder 库目录：临时 pylibs
      const pyLibs = path.join(os.tmpdir(), 'pylibs');
      const script = path.join(__dirname, 'scripts', 'decode_dds.py');
      if (!fs.existsSync(script)) return { ok: false, error: '解码脚本不存在: ' + script };

      const env = { ...process.env, PYTHONPATH: pyLibs };

      await new Promise((resolve, reject) => {
        execFile(pyExe, [script, ddsPath, pngPath], { env, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || stdout || '').trim() + ' (' + String(err && err.message || err) + ')'));
          } else resolve();
        });
      });

      if (!fs.existsSync(pngPath)) return { ok: false, error: 'PNG 生成失败（解码脚本未输出文件）' };
      return { ok: true, pngPath, url: pathToFileURL(pngPath).href };
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
    // 缓存根目录：<userData>/Cache（安装后即 <安装目录>/data/Cache）
    const root = path.join(app.getPath('userData'), 'Cache');
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
    // 白名单：只保留 ASCII 字母/数字/._-，其余（中文/日文/空格/%#?&+ 等）一律替换为下划线
    let s = String(name || 'file')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')                    // 连续下划线合并
      .replace(/^_+|_+$/g, '')                // 去掉首尾下划线
      .replace(/^\.+|\.+$/g, '')            // 去掉首尾点（避免 .. 或隐藏文件）
      .slice(0, 100);
    if (!s) s = 'file';
    // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加前缀避免冲突
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)) s = '_' + s;
    return s;
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

  // ---- IPC: 获取缓存索引（带自愈：修正 cachePath 失效的旧条目） ----
  ipcMain.handle('get-cache-index', async () => {
    await ensureCacheDirs();
    const idx = await repairCacheIndex();
    const totalSize = (idx.items || []).reduce((s, it) => s + (Number(it.cacheSize) || 0), 0);
    return { index: idx, totalSize };
  });

  // 自愈：早期版本整包缓存的 cachePath 缺子目录层级（只写文件名），导致加载时路径不存在。
  // 遍历 index：cachePath 指向的文件不存在时，在 srcDir 缓存目录内按文件名递归查找真实路径并修正。
  async function repairCacheIndex() {
    const p = await ensureCacheDirs();
    const idx = await readIndex();
    let changed = false;
    for (const it of Array.isArray(idx.items) ? idx.items : []) {
      if (!it || !it.cachePath) continue;
      const abs = String(it.cachePath).startsWith(p.root)
        ? String(it.cachePath)
        : path.join(p.root, String(it.cachePath));
      try { await fsp.access(abs); continue; } catch (_) { /* 失效，尝试修正 */ }
      if (!it.srcDir) continue;
      const absDir = String(it.srcDir).startsWith(p.root)
        ? String(it.srcDir)
        : path.join(p.root, String(it.srcDir));
      const base = path.basename(String(it.cachePath)).toLowerCase();
      let fixed = null;
      try {
        const hits = await findFilesByExt(absDir, new Set(['.pmx', '.pmd', '.vmd', '.vpd']));
        fixed = hits.find((f) => path.basename(f).toLowerCase() === base) || null;
      } catch (_) { /* noop */ }
      if (fixed) {
        it.cachePath = path.relative(p.root, fixed).split(path.sep).join('/');
        changed = true;
        console.log('[cache] repaired cachePath:', it.name, '->', it.cachePath);
      }
    }
    if (changed) await writeIndex(idx);
    return idx;
  }

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
          if (it.srcDir) {
            // 整包缓存：删除整个缓存目录
            const absDir = String(it.srcDir).startsWith(p.root)
              ? String(it.srcDir)
              : path.join(p.root, String(it.srcDir));
            try { await fsp.rm(absDir, { recursive: true, force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          } else {
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
      // 「一键清空」同时清理：解压缓存(extract/) + DDS→PNG 解码缓存
      // （这两类属于"派生缓存"，不会删 models/motions 里的用户保留源，所以只有 all 才清）
      try {
        const extractDir = _extractRoot();
        if (extractDir) await tryRm(extractDir);
        await fsp.mkdir(extractDir, { recursive: true });
      } catch (_) { /* noop */ }
      try {
        const ddsCacheDir = path.join(app.getPath('userData'), 'dds-png-cache');
        await tryRm(ddsCacheDir);
        await fsp.mkdir(ddsCacheDir, { recursive: true });
      } catch (_) { /* noop */ }
      // 内存里运行期解压引用也一起清（避免下次把已删除的 dest 又返回出去）
      extractCache.clear();
    } else if (scope === 'models') {
      await tryRm(p.models); await fsp.mkdir(p.models, { recursive: true });
    } else if (scope === 'motions') {
      await tryRm(p.motions); await fsp.mkdir(p.motions, { recursive: true });
    }
    return { removed, freedBytes };
  });

  // ========== 资源扫描：本地目录 + 压缩包内部候选（PMX/PMD/VMD/VPD） ==========
  const scanTasks = new Map();        // taskId -> { cancelled:boolean, startTime }
  const scanCandidatesCache = new Map(); // taskId -> Candidate[]
  const cacheCopyTasks = new Map();   // taskId -> { cancelled:boolean }

  function classifyExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (!MODEL_EXTS.has(e)) return null;
    return e === '.vmd' || e === '.vpd' ? 'motion' : 'model';
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
  // 解析 7za -slt 输出为 [{name, size}]
  function parse7zSlt(str) {
    if (!str) return [];
    str = String(str).replace(/(\r\n|\n|\r)/gm, '\n');
    const items = str.split(/^\s*$/m);
    const res = [];
    for (const item of items) {
      if (!item || !item.trim()) continue;
      const obj = {};
      for (const line of item.split('\n')) {
        const m = line.match(/^(\S[^=]*?)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1].trim();
        const val = m[2].trim();
        if (key === 'Path') obj.name = val;
        else if (key === 'Size') obj.size = val;
      }
      if (obj.name) res.push(obj);
    }
    return res;
  }
  // 直接调用 7za（-sccUTF-8 强制 UTF-8 输出，解决 Windows 下中文条目名乱码）
  function list7zEntries(archivePath) {
    return new Promise((resolve) => {
      execFile(SEVENZA_BIN, ['l', '-slt', '-ba', '-sccUTF-8', archivePath],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { console.error('[scan] 7za list failed:', archivePath, (err && err.message) || err); return resolve([]); }
          try { resolve(parse7zSlt(stdout)); } catch (_) { resolve([]); }
        });
    });
  }
  async function listArchiveEntries(archivePath) {
    try {
      if (!fs.existsSync(archivePath)) return [];
      const ext = path.extname(archivePath).toLowerCase();
      if (!ARCHIVE_EXTS.has(ext)) return [];
      if (ext !== '.rar') {
        // 优先 7za -sccUTF-8（条目名编码正确）；失败则回退 7zip-min list
        const via7za = await list7zEntries(archivePath);
        if (via7za.length) return via7za.map(it => ({
          name: String(it.name || ''),
          size: typeof it.size === 'string' ? (Number(it.size) || null) : it.size,
        }));
        if (typeof seven.list === 'function') {
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
        return [];
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
    console.log('[scan] start-resource-scan roots=', JSON.stringify(roots), 'intoArchives=', intoArchives);
    const taskId = 'scan_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const win = BrowserWindow.fromWebContents(evt.sender);
    scanTasks.set(taskId, { cancelled: false, startTime: Date.now() });
    // 异步启动扫描（不阻塞 invoke 返回）
    (async () => {
      const task = scanTasks.get(taskId);
      try {
        // 根目录去重：若某 root 是另一 root 的子目录，则递归已覆盖，跳过它
        const rootsRaw = Array.isArray(roots) ? roots : [];
        const rootsArr = [];
        for (const r of rootsRaw) {
          const abs = path.resolve(r);
          const isChild = rootsArr.some((parent) => {
            const rel = path.relative(parent, abs);
            return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
          });
          if (!isChild) rootsArr.push(abs);
        }
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
        const seenCandidateIds = new Set();
        const pushCandidate = ({ name, ext, sourcePath, sourceType, archiveEntry, sizeEstimate, type }) => {
          const id = itemId(type, candidateKey({ sourcePath, archiveEntry }));
          if (seenCandidateIds.has(id)) return; // 同一资源只保留一条
          seenCandidateIds.add(id);
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
        if (!cancelled) scanCandidatesCache.set(taskId, candidates);
        console.log('[scan] done candidates=', candidates.length, 'totalSize=', totalSize, 'cancelled=', cancelled, 'roots=', JSON.stringify(rootsArr));
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
        setTimeout(() => scanCandidatesCache.delete(taskId), 60 * 1000);
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
  async function findFileInDirCaseInsensitive(dir, relativeName) {
    const parts = String(relativeName || '').split(/[\\/]/).filter(Boolean);
    let cur = dir;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let ents;
      try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch (_) { return null; }
      const lower = String(part).toLowerCase();
      const hit = ents.find(e => String(e.name).toLowerCase() === lower);
      if (!hit) return null;
      cur = path.join(cur, hit.name);
      if (i === parts.length - 1) {
        if (hit.isFile()) return cur;
        return null;
      } else {
        if (!hit.isDirectory()) return null;
      }
    }
    return null;
  }
  // 在目录树中按扩展名集合递归查找所有文件
  async function findFilesByExt(dir, extSet) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of ents) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile() && extSet.has(path.extname(ent.name).toLowerCase())) out.push(full);
      }
    }
    return out;
  }
  // 贴图引用缺失回退补全：源模型 PMX 常引用 zip 中不存在的贴图（如仅含 _1~_9/_A 变体，
  // 而无 Tex_0122.png 本体）。缓存后把同前缀变体文件补成缺失文件名，保证材质贴图齐全。
  async function backfillMissingTextures(modelDir, pmxFile) {
    try {
      const mmd = await import('three/examples/jsm/libs/mmdparser.module.js');
      const parser = new mmd.MMDParser.Parser();
      const buf = await fsp.readFile(path.join(modelDir, pmxFile));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const data = parser.parsePmx(ab);
      let fixed = 0;
      for (const mat of Array.isArray(data.materials) ? data.materials : []) {
        for (const idx of [mat.textureIndex, mat.sphereTextureIndex]) {
          if (!(idx >= 0) || !data.textures || !data.textures[idx]) continue;
          const tp = String(data.textures[idx]).replace(/\\/g, '/');
          if (!tp) continue;
          const abs = path.join(modelDir, tp);
          try { await fsp.access(abs); continue; } catch (_) { /* 缺失则回退 */ }
          const dir = path.dirname(abs);
          const base = path.basename(tp);
          const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
          const baseLower = base.toLowerCase();
          let entries = [];
          try { entries = await fsp.readdir(dir); } catch (_) { entries = []; }
          const cand = entries
            .filter((n) => {
              const nl = n.toLowerCase();
              return nl !== baseLower
                && nl.startsWith(stem)
                && path.extname(n).toLowerCase() === path.extname(base).toLowerCase();
            })
            // 优先 _A（albedo）变体，其次按名称自然顺序
            .sort((a, b) => {
              const pa = /_a\.[^.]+$/.test(a.toLowerCase()) ? 0 : 1;
              const pb = /_a\.[^.]+$/.test(b.toLowerCase()) ? 0 : 1;
              return pa - pb || a.localeCompare(b);
            })[0];
          if (!cand) continue;
          try {
            await fsp.copyFile(path.join(dir, cand), abs);
            fixed++;
            console.log('[cache] backfill texture:', base, '<-', cand);
          } catch (e) { /* noop */ }
        }
      }
      if (fixed > 0) console.log('[cache] backfillMissingTextures: 补齐', fixed, '张贴图于', modelDir);
      return fixed;
    } catch (e) {
      console.error('[cache] backfillMissingTextures failed:', (e && e.message) || e);
      return 0;
    }
  }

  async function copyOne(candidate, cpaths, existingIds) {
    const { id, type, name, ext, sourcePath, sourceType, archiveEntry } = candidate;
    if (existingIds.has(String(id))) {
      return { succeeded: false, skipped: true, reason: 'already_cached' };
    }
    // 是否来自场景根目录（<根>/场景）：用于左侧「场景」卡片展示缓存场景模型
    const isSceneSource = (() => {
      try {
        const sceRoot = sceneRootOf(effectiveRoot());
        const prefix = sceRoot.endsWith(path.sep) ? sceRoot : sceRoot + path.sep;
        const src = String(sourcePath || '').replace(/\\/g, '/').toLowerCase();
        const pref = prefix.replace(/\\/g, '/').toLowerCase();
        return src.startsWith(pref);
      } catch (_) { return false; }
    })();
    const extDot = '.' + String(ext || '').toLowerCase();
    const safeBase = safeFilename(String(name || 'file'));
    const shortId = String(id).replace(/^(m_|v_)/, '').slice(0, 8);
    const cacheFile = `${safeBase}-${shortId}${extDot}`;
    const subDir = type === 'motion' ? cpaths.motions : cpaths.models;
    const absDest = path.join(subDir, cacheFile);
    const relDest = (type === 'motion' ? 'motions/' : 'models/') + cacheFile;

    // 模型压缩包：整包解压缓存，保证 Tex/AONMPB 等同包贴图资源随模型一起可用
    if (sourceType === 'archive' && type === 'model') {
      let tmpDirToClean = null;
      try {
        const dest = await extractArchive(sourcePath);
        tmpDirToClean = dest;
        let found = await findFileInDirCaseInsensitive(dest, archiveEntry);
        if (!found && archiveEntry) {
          // 条目名可能因编码差异不匹配：按扩展名递归回退
          const byExt = await findFilesByExt(dest, new Set(['.pmx', '.pmd']));
          if (byExt.length === 1) found = byExt[0];
          else if (byExt.length > 1) {
            const base = path.basename(String(archiveEntry || '')).toLowerCase();
            found = byExt.find(f => path.basename(f).toLowerCase() === base) || null;
          }
        }
        if (!found) {
          return { succeeded: false, skipped: false, reason: 'archive_entry_not_found:' + (archiveEntry || '') };
        }
        const dirName = `${safeBase}-${shortId}`;
        const absDir = path.join(subDir, dirName);
        const relDir = 'models/' + dirName;
        try { await fsp.rm(absDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
        await fsp.mkdir(absDir, { recursive: true });
        // 递归复制整个解压目录（fs.cp 需 Node 16.7+，Electron 内置 Node 满足）
        await fsp.cp(dest, absDir, { recursive: true, force: true });
        // 同压缩包多模型冗余清理：散落结构（模型文件与贴图文件夹都直接放在压缩包根）时，
        // 整包复制会把其他模型的 .pmx/.pmd 也拷进来。只保留目标模型，贴图/资源目录保留共享。
        try {
          const targetBase = path.basename(found).toLowerCase();
          const topEntries = await fsp.readdir(absDir, { withFileTypes: true });
          for (const ent of topEntries) {
            if (ent.isFile() && /\.(pmx|pmd)$/i.test(ent.name) && ent.name.toLowerCase() !== targetBase) {
              await fsp.rm(path.join(absDir, ent.name), { force: true });
              console.log('[cache] prune sibling model file:', ent.name);
            }
          }
        } catch (_) { /* 清理失败不影响主流程 */ }
        // 贴图引用缺失回退补全（源模型缺陷：PMX 引用 zip 中不存在的贴图文件）
        // 相对路径必须基于解压根 dest 计算（found 可能在子目录，也可能在根目录）；
        // 若落在解压根之外则退化为仅用文件名
        const relInArchive = path.relative(dest, found);
        const relPmxInDir = (relInArchive.startsWith('..') ? path.basename(found) : relInArchive).split(path.sep).join('/');
        await backfillMissingTextures(absDir, relPmxInDir);
        const cacheSize = await calcDirSize(absDir);
        return {
          succeeded: true,
          skipped: false,
          indexItem: {
            id, type,
            name: String(name || ''),
            ext: String(ext || '').toLowerCase(),
            sourcePath: String(sourcePath || ''),
            sourceType: 'archive',
            archiveEntry: archiveEntry || null,
            srcDir: relDir,
            // 模型可能在解压包子目录中（整包复制保留了相对结构），cachePath 必须包含子目录层级，
            // 否则加载时拼出的路径不存在（mmd:// 404 → 加载模型失败）
            cachePath: relDir + '/' + relPmxInDir,
            thumb: null,
            cacheSize,
            addedAt: Date.now(),
            scene: isSceneSource,
          },
        };
      } catch (e) {
        console.error('[cache] copyOne(whole-package) failed:', candidate, e);
        return { succeeded: false, skipped: false, reason: (e && e.message) || String(e) };
      } finally {
        if (tmpDirToClean) {
          try { await fsp.rm(tmpDirToClean, { recursive: true, force: true }); } catch (_) { /* noop */ }
          extractCache.delete(sourcePath);
        }
      }
    }

    // 模型（文件来源）：整目录复制以携带 tex/aonmpb/spa/sph/toon 等相邻贴图资源，避免缓存后加载缺贴图
    if (sourceType === 'file' && type === 'model') {
      try {
        const srcDir = path.dirname(sourcePath);
        const srcBase = path.basename(sourcePath);
        const dirName = `${safeBase}-${shortId}`;
        const absDir = path.join(subDir, dirName);
        const relDir = 'models/' + dirName;
        try { await fsp.rm(absDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
        await fsp.mkdir(absDir, { recursive: true });
        // 复制整个父目录资源
        await fsp.cp(srcDir, absDir, { recursive: true, force: true, filter: (src, _dest) => {
          try {
            const st = fs.statSync(src);
            if (st.isDirectory()) {
              const b = path.basename(src).toLowerCase();
              if (b === '__macosx' || b === '.git' || b === 'node_modules' || b.startsWith('.')) return false;
              return true;
            }
            const ext = path.extname(src).toLowerCase();
            if (ext === '.tmp' || ext === '.log' || ext === '.bak') return false;
            return true;
          } catch (_) { return false; }
        }});
        const relInSrcDir = srcBase; // always flat inside absDir
        await backfillMissingTextures(absDir, relInSrcDir);
        const cacheSize = await calcDirSize(absDir);
        return {
          succeeded: true,
          skipped: false,
          indexItem: {
            id, type,
            name: String(name || ''),
            ext: String(ext || '').toLowerCase(),
            sourcePath: String(sourcePath || ''),
            sourceType: 'file',
            archiveEntry: null,
            srcDir: relDir,
            cachePath: relDir + '/' + relInSrcDir.replace(/\\/g, '/'),
            thumb: null,
            cacheSize,
            addedAt: Date.now(),
            scene: isSceneSource,
          },
        };
      } catch (e) {
        console.error('[cache] copyOne(file-model whole) failed:', candidate, e);
        return { succeeded: false, skipped: false, reason: (e && e.message) || String(e) };
      }
    }

    let fromAbs = null;
    let tmpDirToClean = null;
    try {
      if (sourceType === 'file') {
        fromAbs = sourcePath;
      } else if (sourceType === 'archive') {
        const dest = await extractArchive(sourcePath);
        tmpDirToClean = dest;
        let found = await findFileInDirCaseInsensitive(dest, archiveEntry);
        if (!found && archiveEntry) {
          // 条目名可能因编码差异不匹配：按扩展名递归回退
          const extSet = type === 'motion'
            ? new Set(['.vmd', '.vpd'])
            : new Set(['.pmx', '.pmd']);
          const byExt = await findFilesByExt(dest, extSet);
          if (byExt.length === 1) found = byExt[0];
          else if (byExt.length > 1) {
            const base = path.basename(String(archiveEntry || '')).toLowerCase();
            found = byExt.find(f => path.basename(f).toLowerCase() === base) || null;
          }
        }
        if (!found) {
          return { succeeded: false, skipped: false, reason: 'archive_entry_not_found:' + (archiveEntry || '') };
        }
        fromAbs = found;
      } else {
        return { succeeded: false, skipped: false, reason: 'unknown_source_type:' + sourceType };
      }
      try { await fsp.mkdir(path.dirname(absDest), { recursive: true }); } catch (_) { /* noop */ }
      await fsp.copyFile(fromAbs, absDest);
      let cacheSize = null;
      try { const st = await fsp.stat(absDest); cacheSize = st.size; } catch (_) { /* noop */ }
      if (tmpDirToClean) {
        try { await fsp.rm(tmpDirToClean, { recursive: true, force: true }); } catch (_) { /* noop */ }
        extractCache.delete(sourcePath);
      }
      return {
        succeeded: true,
        skipped: false,
        indexItem: {
          id, type,
          name: String(name || ''),
          ext: String(ext || '').toLowerCase(),
          sourcePath: String(sourcePath || ''),
          sourceType: sourceType === 'archive' ? 'archive' : 'file',
          archiveEntry: archiveEntry || null,
          cachePath: relDest,
          thumb: null,
          cacheSize,
          addedAt: Date.now(),
          scene: isSceneSource,
        },
      };
    } catch (e) {
      console.error('[cache] copyOne failed:', candidate, e);
      if (tmpDirToClean) {
        try { await fsp.rm(tmpDirToClean, { recursive: true, force: true }); } catch (_) { /* noop */ }
      }
      return { succeeded: false, skipped: false, reason: (e && e.message) || String(e) };
    }
  }

  ipcMain.handle('cache-selected-resources', async (_e, payload) => {
    const { taskId, ids } = payload || {};
    console.log('[cache] cache-selected-resources called taskId=', taskId, 'ids=', Array.isArray(ids) ? ids.length : 0);
    const tid = String(taskId || ('copy_' + Date.now().toString(36)));
    const win = BrowserWindow.fromWebContents(_e.sender);
    cacheCopyTasks.set(tid, { cancelled: false });
    (async () => {
      const t = cacheCopyTasks.get(tid);
      try {
        await ensureCacheDirs();
        const cpaths = cachePaths();
        const idx = await readIndex();
        const existing = new Map();
        for (const it of Array.isArray(idx.items) ? idx.items : []) {
          if (it && it.id) existing.set(String(it.id), it);
        }
        let sourceList = [];
        for (const v of scanCandidatesCache.values()) sourceList.push(...(Array.isArray(v) ? v : []));
        sourceList = sourceList.concat(Array.from(existing.values() || []));
        const wanted = Array.from(new Set(Array.isArray(ids) ? ids.map(String) : []));
        const selected = [];
        for (const id of wanted) {
          const cand = sourceList.find(c => c && String(c.id) === id);
          if (cand) selected.push(cand);
        }
        console.log('[cache] cache copy task: sourceList=', sourceList.length, 'wanted=', wanted.length, 'selected=', selected.length);
        const total = selected.length;
        let done = 0;
        let okCount = 0;
        let skipCount = 0;
        let failCount = 0;
        const existingIds = new Set(existing.keys());
        for (const cand of selected) {
          if (t && t.cancelled) break;
          console.log('[cache] copy #' + (done + 1) + '/' + total, cand.type, cand.name, 'srcType=' + cand.sourceType, 'entry=' + String(cand.archiveEntry || ''));
          const res = await copyOne(cand, cpaths, existingIds);
          done++;
          console.log('[cache] copy result #' + done, cand.name, '->', res ? (res.skipped ? 'skip' : res.succeeded ? 'ok' : 'FAIL:' + res.reason) : 'NULL');
          if (res && res.skipped) {
            // 已缓存：不算失败，也不重复写 index
            skipCount++;
            win && win.webContents.send('cache-progress', {
              taskId: tid,
              done, total,
              currentName: String(cand.name || cand.id || ''),
              succeeded: true,
              skipped: true,
            });
          } else if (res && res.succeeded && res.indexItem) {
            idx.items = Array.isArray(idx.items) ? idx.items : [];
            idx.items.push(res.indexItem);
            existingIds.add(String(cand.id));
            okCount++;
            win && win.webContents.send('cache-progress', {
              taskId: tid,
              done, total,
              currentName: String(cand.name || cand.id || ''),
              succeeded: true,
            });
          } else {
            failCount++;
            win && win.webContents.send('cache-progress', {
              taskId: tid,
              done, total,
              currentName: String(cand.name || cand.id || ''),
              succeeded: false,
              error: res && res.reason,
            });
          }
        }
        idx.version = (Number(idx.version) || 1) + 1;
        await writeIndex(idx);
        win && win.webContents.send('cache-done', {
          taskId: tid,
          summary: { ok: okCount, fail: failCount, skip: skipCount, indexVersion: idx.version },
        });
      } catch (e) {
        console.error('[cache] cache-selected-resources fatal:', e);
        win && win.webContents.send('cache-done', {
          taskId: tid,
          summary: { ok: 0, fail: 0, indexVersion: 0 },
          error: (e && e.message) || String(e),
        });
      } finally {
        cacheCopyTasks.delete(tid);
      }
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
    // 1. 根目录设置持久化读写
    rootSettings.root = DEFAULT_ROOT;
    saveRootSettings();
    const rs = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    check('root-settings-persist', rs && rs.root === DEFAULT_ROOT, SETTINGS_FILE());

    // 2. 默认目录存在性
    const rootExists = fs.existsSync(effectiveRoot());
    check('default-root-exists', rootExists, effectiveRoot());

    if (rootExists) {
      // 3. 扫描目录
      const tree = scanDir(effectiveRoot());
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

      // 4.5 缓存扫描完整链路：renderer 发起 startResourceScan -> 主进程扫描 -> scan-done 事件回传
      try {
        const scanCode = [
          '(async () => {',
          '  try {',
          '    const [d, m] = await Promise.all([window.mmdAPI.getDefaultRoot(), window.mmdAPI.getMotionRoot()]);',
          '    const roots = [];',
          '    if (d && d.data) roots.push(d.data);',
          '    if (m && m.data && m.data !== d.data) roots.push(m.data);',
          '    const result = await new Promise((resolve) => {',
          '      const timer = setTimeout(() => resolve({ error: "timeout 60s" }), 60000);',
          '      window.mmdAPI.onScanDone((p) => { clearTimeout(timer); resolve(p); });',
          '      window.mmdAPI.startResourceScan({ roots, intoArchives: true }).catch((e) => {',
          '        clearTimeout(timer); resolve({ error: "startResourceScan: " + String(e && e.message || e) });',
          '      });',
          '    });',
          '    return { roots, result };',
          '  } catch (e) { return { error: String(e && e.message || e) }; }',
          '})()',
        ].join('\n');
        const scanRes = await mainWindow.webContents.executeJavaScript(scanCode);
        const r = scanRes && scanRes.result;
        const ok = r && !r.error && Array.isArray(r.candidates) && r.candidates.length > 0;
        const info = r && r.error
          ? r.error
          : (r && Array.isArray(r.candidates) ? `发现 ${r.candidates.length} 个候选（totalCount=${r.totalCount}）` : 'no result');
        check('cache-scan-chain', ok, info);
        console.log('[smoke] cache-scan roots=', JSON.stringify(scanRes && scanRes.roots), '->', info);
      } catch (e) {
        check('cache-scan-chain', false, String(e && e.message || e));
      }

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

      // 6.7 缓存模型加载链路：切到缓存 Tab → 点击第一个模型卡片「加载」→ 观察状态栏
      try {
        const uiOk = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const tab = document.querySelector('#info-panel .tab-btn[data-tab="cache"]');
            if (tab) tab.click();
            await wait(800);
            // 优先点击「模型」行（加载按钮），避免候选顺序不同导致点到动作行
            const rows = [...document.querySelectorAll('.cache-rows .cache-row')];
            const modelRow = rows.find((r) => {
              const b = r.querySelector('.cc-load');
              return b && b.textContent.trim() === '加载';
            }) || rows[0];
            const btn = modelRow ? modelRow.querySelector('.cc-load') : null;
            if (!btn) return { error: '缓存 Tab 无加载按钮（未渲染）', status: '', detail: '' };
            btn.click();
            await wait(5000);
            const st = document.querySelector('#status-text') ? document.querySelector('#status-text').textContent : '';
            const sd = document.querySelector('#status-detail') ? document.querySelector('#status-detail').textContent : '';
            return { status: st, detail: sd };
          })()
        `);
        const ok = uiOk && !uiOk.error && /已加载/.test(uiOk.status || '');
        check('load-cached-model', ok, uiOk.error || `状态栏:「${uiOk.status}」详情:「${uiOk.detail}」`);
      } catch (e) {
        check('load-cached-model', false, String(e && e.message || e));
      }

      // 6.8 场景视图渲染 + 左侧「缓存资源」独立面板（模型/场景/动作分类，不再混入文件树）
      try {
        const uiOk = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const sce = document.querySelector('.lib-card[data-tab="scenes"]');
            if (!sce) return { error: '无场景入口', sceneRows: 0, cacheSize: '', cats: [] };
            sce.click();
            await wait(600);
            const sceneRows = document.querySelectorAll('#scene-tree .win10-row').length;
            const cac = document.querySelector('.lib-card[data-tab="cache"]');
            if (cac) cac.click();
            await wait(800);
            const cacheSize = document.getElementById('side-cache-size')
              ? document.getElementById('side-cache-size').textContent : '';
            const cats = ['cc-models', 'cc-scenes', 'cc-motions'].map((id) => ({
              id,
              rows: document.querySelectorAll('#' + id + ' .scc-row').length,
              empty: !!document.querySelector('#' + id + ' .scc-empty'),
            }));
            // 文件树不再注入「已缓存」组
            const models = document.querySelector('.lib-card[data-tab="models"]');
            if (models) models.click();
            await wait(600);
            const cachedRow = document.querySelector('#file-tree .win10-row[data-path="__cached_models__"]');
            return { sceneRows, cacheSize, cats, treeHasCachedGroup: !!cachedRow };
          })()
        `);
        const ok = uiOk && !uiOk.error
          && Number(uiOk.sceneRows) > 0
          && uiOk.cacheSize !== '计算中…' && uiOk.cacheSize !== ''
          && uiOk.cats.every((c) => c.rows > 0 || c.empty)
          && !uiOk.treeHasCachedGroup;
        check('scenes-and-cached-group', ok,
          uiOk.error || `场景行数:${uiOk.sceneRows} 缓存面板:「${uiOk.cacheSize}」 分类:[${uiOk.cats.map((c) => c.id + '=' + c.rows + (c.empty ? 'E' : '')).join(' ')}] 文件树含已缓存组:${uiOk.treeHasCachedGroup}`);
      } catch (e) {
        check('scenes-and-cached-group', false, String(e && e.message || e));
      }

      // 6.9 参数面板「重置全部」后表单立即回显默认值（Bug3）
      try {
        const uiOk = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const tab = document.querySelector('#info-panel .tab-btn[data-tab="params"]');
            if (tab) tab.click();
            await wait(600);
            const range = document.querySelector('#params-render input[type="range"]');
            if (!range) return { error: '参数面板无滑块' };
            const before = range.value;
            range.value = range.max;
            range.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            const changed = range.value;
            const btnAll = document.getElementById('btn-reset-all');
            if (!btnAll) return { error: '无重置全部按钮' };
            btnAll.click();
            await wait(200);
            return { before, changed, after: range.value };
          })()
        `);
        const ok = uiOk && !uiOk.error && uiOk.changed !== uiOk.after && String(uiOk.after) === String(uiOk.before);
        check('params-reset-refresh', ok,
          uiOk.error || `重置前:${uiOk.before} 改后:${uiOk.changed} 重置后:${uiOk.after}`);
      } catch (e) {
        check('params-reset-refresh', false, String(e && e.message || e));
      }

      // 6.10 场景压缩包预览：场景 Tab 单击 zip → 提取浏览 → 自动加载第一个 PMX（问题3回归）
      try {
        const uiOk = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const sce = document.querySelector('.lib-card[data-tab="scenes"]');
            if (!sce) return { error: '无场景入口' };
            sce.click();
            await wait(800);
            const rows = [...document.querySelectorAll('#scene-tree .win10-row')];
            const zipRow = rows.find((r) => /\.zip$/i.test(r.dataset.name || ''));
            if (!zipRow) return { error: '场景树无 zip 行, rows=' + rows.length };
            zipRow.click();
            await wait(4000);
            const dlg = document.getElementById('archive-preview');
            const visible = dlg && !dlg.classList.contains('hidden');
            const status = document.querySelector('#status-text')?.textContent || '';
            if (!visible) return { error: '清单对话框未弹出, status=' + status };
            const extBtn = document.getElementById('ap-extract');
            if (!extBtn) return { error: '无提取浏览按钮' };
            extBtn.click();
            await wait(45000);
            const st = document.querySelector('#status-text')?.textContent || '';
            const sd = document.querySelector('#status-detail')?.textContent || '';
            await wait(2000);
            const state = window.__mmdTest && window.__mmdTest.getState ? window.__mmdTest.getState() : null;
            return { afterStatus: st, detail: sd, state };
          })()
        `);
        const ok = uiOk && !uiOk.error && /已加载/.test(uiOk.afterStatus || '');
        check('scene-zip-extract-load', ok,
          uiOk.error || `状态栏:「${uiOk.afterStatus}」 tex:${uiOk.state && uiOk.state.texLoaded}/${uiOk.state && uiOk.state.texTotal} mesh:${uiOk.state && uiOk.state.meshCount}`);
      } catch (e) {
        check('scene-zip-extract-load', false, String(e && e.message || e));
      }

      // 6.11 整包缓存验证：缓存场景压缩包 → cache/models 下生成整包目录（含 Tex/AONMPB 贴图）→ 加载缓存模型贴图齐全（问题2回归）
      try {
        const sceneZip = archives.find((a) => /\.zip$/i.test(a) && /场景/i.test(a)) || archives.find((a) => /\.zip$/i.test(a));
        if (!sceneZip) {
          check('cache-whole-package', false, '未找到场景 zip 压缩包');
        } else {
          const uiOk = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const [d] = await Promise.all([window.mmdAPI.getDefaultRoot()]);
              const roots = d && d.data ? [d.data] : [];
              const scan = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ error: 'scan timeout 120s' }), 120000);
                window.mmdAPI.onScanDone((p) => { clearTimeout(timer); resolve(p); });
                window.mmdAPI.startResourceScan({ roots, intoArchives: true }).catch((e) => {
                  clearTimeout(timer); resolve({ error: 'startResourceScan: ' + String(e && e.message || e) });
                });
              });
              if (scan.error || !Array.isArray(scan.candidates)) return { error: scan.error || 'scan 无候选' };
              const cands = scan.candidates.filter((c) => c.sourceType === 'archive' && c.type === 'model' && c.sourcePath === ${JSON.stringify(sceneZip)});
              if (!cands.length) return { error: '未找到 zip 的模型候选, total=' + scan.candidates.length };
              const target = cands[0];
              const done = await new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ error: 'cache timeout 240s' }), 240000);
                window.mmdAPI.onCacheDone((p) => { clearTimeout(timer); resolve(p); });
                window.mmdAPI.cacheSelectedResources({ taskId: 'smoke_whole_pkg', ids: [target.id] }).catch((e) => {
                  clearTimeout(timer); resolve({ error: 'cacheSelectedResources: ' + String(e && e.message || e) });
                });
              });
              if (done.error) return { error: done.error };
               const idx = await window.mmdAPI.getCacheIndex();
               const item = ((idx && idx.index && idx.index.items) || []).find((it) => it.id === target.id);
               return { target, done, item };
            })()
          `);
          const cacheRoot = path.join(app.getPath('userData'), 'Cache');
          let dirOk = false, dirInfo = '';
          if (uiOk && !uiOk.error && uiOk.item && uiOk.item.srcDir) {
            const absDir = path.join(cacheRoot, String(uiOk.item.srcDir).replace(/^models[/\\]/, 'models/'));
            try {
              const names = fs.readdirSync(absDir);
              const hasPmx = names.some((f) => /\.pmx$/i.test(f));
              const hasTex = names.some((f) => /^(tex|aonmpb)$/i.test(f));
              dirOk = hasPmx && hasTex;
              dirInfo = `目录 ${uiOk.item.srcDir}: ${names.length} 项, pmx=${hasPmx}, 贴图目录=${hasTex}`;
            } catch (e) {
              dirInfo = '目录检查异常: ' + String(e && e.message || e);
            }
          } else {
            dirInfo = uiOk && uiOk.error ? uiOk.error : '未生成 srcDir 缓存项';
          }
          check('cache-whole-package', dirOk, dirInfo);
          // 加载整包缓存模型，验证贴图齐全
          if (uiOk && !uiOk.error && uiOk.item && uiOk.item.srcDir) {
            try {
              const loadOk = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                  const tab = document.querySelector('#info-panel .tab-btn[data-tab="cache"]');
                  if (tab) tab.click();
                  await wait(1000);
                  const rows = [...document.querySelectorAll('.cache-rows .cache-row')];
                  const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(String(uiOk.target.name))}));
                  if (!row) return { error: '缓存列表未找到 ' + ${JSON.stringify(String(uiOk.target.name))} };
                  row.querySelector('.cc-load').click();
                  await wait(8000);
                  const st = document.querySelector('#status-text')?.textContent || '';
                  const state = window.__mmdTest && window.__mmdTest.getState ? window.__mmdTest.getState() : null;
                  return { status: st, texLoaded: state && state.texLoaded, texTotal: state && state.texTotal, meshCount: state && state.meshCount };
                })()
              `);
              const ok2 = loadOk && !loadOk.error && /已(加载|加入场景)/.test(loadOk.status || '')
                && Number(loadOk.texTotal) > 0 && Number(loadOk.texLoaded) === Number(loadOk.texTotal);
              check('load-cached-whole-package', ok2,
                loadOk.error || `状态栏:「${loadOk.status}」 tex:${loadOk.texLoaded}/${loadOk.texTotal} mesh:${loadOk.meshCount}`);
            } catch (e) {
              check('load-cached-whole-package', false, String(e && e.message || e));
            }
          }
        }
      } catch (e) {
        check('cache-whole-package', false, String(e && e.message || e));
      }
      // 6.11 主流通用格式加载探针（仅 --generic-probe + GENERIC_PROBE_DIR 时执行，不影响常规冒烟）
      try {
        const probeDir = process.env.GENERIC_PROBE_DIR;
        if (process.argv.includes('--generic-probe') && probeDir && fs.existsSync(probeDir)) {
          const supported = new Set(['gltf', 'glb', 'obj', 'fbx', 'stl', 'dae', 'ply', '3ds']);
          const files = fs.readdirSync(probeDir).filter((f) => {
            if (!supported.has(path.extname(f).toLowerCase().replace(/^\./, ''))) return false;
            try { return fs.statSync(path.join(probeDir, f)).isFile(); } catch (_) { return false; }
          });
          for (const f of files) {
            const full = path.join(probeDir, f);
            const ext = path.extname(f).toLowerCase().replace(/^\./, '');
            const r = await mainWindow.webContents.executeJavaScript(
              `window.__mmdTest.genericProbe(${JSON.stringify(full)})`
            );
            check('generic-' + ext, r && r.ok,
              r && r.ok
                ? `包围盒 ${(r.size || []).join(' x ')} mesh=${r.meshes} verts=${r.verts}`
                : (r && r.error || 'no result'));
          }
        }
      } catch (e) {
        check('generic-probe', false, String(e && e.message || e));
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
app.whenReady().then(async () => {
  console.log('[main] ready, argv:', JSON.stringify(process.argv));
  // 首次运行确保默认根目录（<安装目录>/mods）存在，避免空目录报错
  try { fs.mkdirSync(DEFAULT_ROOT, { recursive: true }); } catch (_) { /* ignore */ }
  registerMmdProtocol();
  registerIpc();
  // 启动后异步修剪一下压缩包解压的持久化缓存（不阻塞窗口创建）
  pruneExtractCacheIfNeeded().catch(() => {});

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
module.exports = { DEFAULT_ROOT, MODEL_EXTS, effectiveRoot, rootSettings, saveRootSettings };
