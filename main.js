'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
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
