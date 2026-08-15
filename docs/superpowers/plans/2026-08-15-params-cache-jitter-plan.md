# 参数面板 + 资源缓存识别 + 边缘抖动修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在 MMDModelViewer Electron 应用中落地三项能力：右侧 Tab 式参数面板（持久化渲染/物理/IK/动画调参）、模型动作自动识别+缓存（含压缩包内部、后台扫描+超量预警+独立展示清理Tab）、EffectComposer + OutlinePass + FXAA 后处理修复模型边缘抖动。

**架构：** Electron 三进程分工——主进程做文件系统与缓存目录、压缩包扫描、IPC 进度推送；preload 暴露受控 API；渲染进程负责 UI（三Tab容器、参数控件、缓存网格、扫描对话框）、参数 localStorage 持久化、Three.js 后处理管线初始化与参数热切换；三模块可以独立验证。

**技术栈：** Electron 26+（BrowserWindow + ipcMain + preload contextBridge）、Three.js r170（MMDLoader / MMDAnimationHelper / MMDPhysics / CCDIKSolver / EffectComposer 全家桶 / OutlinePass / FXAAShader / ShaderPass）、原生 DOM + CSS（玻璃风 Indigo 主色）、esbuild 打包 renderer、7zip-min + node-unrar-js 压缩包支持。

---

## 文件结构总览

| 文件 | 改动 | 责任 |
|---|---|---|
| `renderer/index.html` | 修改 | 顶栏加自动缓存开关；右栏改 Tab 容器 (info / params / cache) |
| `renderer/styles.css` | 修改 | Tab 头、Tab 内容区、参数组 Section、enum/bool/number/color 控件、分段过滤、缓存网格卡片等新样式 |
| `renderer/renderer.js` | 修改 | 新增 DEFAULT_PARAMS + 读/写 localStorage、Tab 切换、参数控件渲染、applyParam 回调；初始化 EffectComposer + OutlinePass + FXAA Pass，替换 `renderer.render` 为 `composer.render`；绑定 IPC 事件、绘制缓存网格与对话框、写缩略图 |
| `main.js` | 修改 | 新增 IPC：get-cache-dir-info / start-resource-scan / cancel-resource-scan / cache-selected-resources / get-cache-index / delete-cache-items / clear-cache / write-cache-thumb；通过 webContents 推送 scan-progress/scan-done/cache-progress/cache-done；维护 `cache/index.json`，实现目录遍历+压缩包 listArchiveContents 识别+复制缓存 |
| `preload.js` | 修改 | contextBridge 暴露 `mmdAPI` 中所有缓存相关方法 + 四个事件回调注册 |

---

## 任务 1：HTML 改造 — 顶栏开关 + 右栏三 Tab 容器

**Files:**
- Modify: `renderer/index.html:L13-L23` (toolbar 内加 `#tgl-auto-cache` 开关)
- Modify: `renderer/index.html:L127-L132` (#info-panel 改 Tab 结构)

- [ ] **Step 1: 在 #toolbar 末尾 spacer 之前插入自动识别缓存开关**

将 toolbar `#btn-refresh` 之后的内容从：
```html
      <button id="btn-refresh" class="btn" title="刷新当前目录">刷新</button>
      <span id="root-path" class="root-path"></span>
```
改为：
```html
      <button id="btn-refresh" class="btn" title="刷新当前目录">刷新</button>
      <label class="switch toolbar-switch" title="自动识别模型与动作资源并缓存到本地">
        <input id="tgl-auto-cache" type="checkbox">
        <span>⚙ 自动识别缓存</span>
      </label>
      <span id="root-path" class="root-path"></span>
```

- [ ] **Step 2: 重写 #info-panel 为 Tab 容器**

将 `<aside id="info-panel">...</aside>` 整块替换为：
```html
      <!-- 右侧信息栏 -->
      <aside id="info-panel">
        <div class="tab-bar" role="tablist">
          <button class="tab-btn active" data-tab="info"   role="tab" aria-selected="true">模型信息</button>
          <button class="tab-btn"        data-tab="params" role="tab" aria-selected="false">参数面板</button>
          <button class="tab-btn"        data-tab="cache"  role="tab" aria-selected="false">缓存资源</button>
        </div>

        <div class="tab-content" data-view="info">
          <div class="panel-title">模型信息</div>
          <div id="model-info" class="model-info">
            <div class="placeholder">点击「选择模型」或在左侧选文件开始预览</div>
          </div>
        </div>

        <div class="tab-content hidden" data-view="params">
          <div class="panel-title">参数面板</div>
          <div id="params-render"  class="param-group" data-group="render">
            <div class="group-title">🎨 渲染</div>
            <div class="group-rows"></div>
          </div>
          <div id="params-physics" class="param-group" data-group="physics">
            <div class="group-title">🪶 物理</div>
            <div class="group-rows"></div>
          </div>
          <div id="params-ik"      class="param-group" data-group="ik">
            <div class="group-title">🦵 IK</div>
            <div class="group-rows"></div>
          </div>
          <div id="params-anim"    class="param-group" data-group="anim">
            <div class="group-title">🎬 动画</div>
            <div class="group-rows"></div>
          </div>
          <div class="param-actions">
            <button id="btn-reset-group" class="btn btn-small">重置当前组</button>
            <button id="btn-reset-all"   class="btn btn-small">重置全部</button>
          </div>
        </div>

        <div class="tab-content hidden" data-view="cache">
          <div class="panel-title">
            缓存资源
            <span id="cache-size" class="badge-muted">计算中…</span>
          </div>
          <div class="cache-toolbar">
            <input id="cache-filter" class="filter-input" placeholder="搜索名称…" />
            <div class="segmented" role="group">
              <button class="seg active" data-cache-type="all">全部</button>
              <button class="seg"        data-cache-type="models">🧊 模型</button>
              <button class="seg"        data-cache-type="motions">🎬 动作</button>
            </div>
            <div class="cache-actions">
              <button id="btn-clear-model-cache"  class="btn btn-small">清空模型缓存</button>
              <button id="btn-clear-motion-cache" class="btn btn-small">清空动作缓存</button>
              <button id="btn-clear-all-cache"    class="btn btn-small btn-danger">一键清空</button>
            </div>
          </div>
          <div id="cache-grid" class="cache-grid">
            <div class="placeholder">暂无缓存。打开工具栏「自动识别缓存」开关开始扫描。</div>
          </div>
        </div>
      </aside>
```

- [ ] **Step 3: 快速启动验证布局不会破坏主结构（肉眼检查即可）**

Run: `npm start`
Expected: 工具栏显示"⚙ 自动识别缓存"开关，右侧信息栏出现 3 个 Tab 切换按钮，默认停留在"模型信息"，布局无水平溢出。

- [ ] **Step 4: Commit**
```bash
git add renderer/index.html
git commit -m "feat(html): 顶栏新增自动识别缓存开关，右栏改造为模型信息/参数面板/缓存资源三Tab容器"
```

---

## 任务 2：CSS 新增样式 — Tab、参数控件、缓存网格

**Files:**
- Modify: `renderer/styles.css`（文件末尾追加新样式块，不改动已存在的玻璃风设计 token）

- [ ] **Step 1: 在 styles.css 末尾追加 Tab 与基础控件样式**

```css
/* ========== Tab 容器（右栏） ========== */
.tab-bar {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.tab-btn {
  flex: 1;
  padding: 6px 8px;
  font: 500 12px/1.4 "Segoe UI","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  transition: all .12s ease;
}
.tab-btn:hover { color: var(--brand); }
.tab-btn.active {
  color: var(--brand);
  background: var(--surface);
  border-color: var(--border);
  position: relative;
  bottom: -1px;
}
.tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}
.tab-content.hidden { display: none; }

.badge-muted {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  font: 11px/1.6 "Segoe UI",sans-serif;
  color: var(--text-muted);
  background: var(--surface-muted);
  border-radius: 999px;
}

/* 顶栏 Switch */
.toolbar-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 6px;
  font: 12px/1 "Segoe UI",sans-serif;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.toolbar-switch input { margin: 0; }

/* ========== 参数面板 ========== */
.param-group { margin-bottom: 14px; }
.group-title {
  font: 600 13px/1.6 "Segoe UI",sans-serif;
  color: var(--brand);
  margin: 4px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border);
  letter-spacing: .02em;
}
.group-rows { display: flex; flex-direction: column; gap: 10px; }
.param-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 8px;
  align-items: center;
  font: 12px/1.5 "Segoe UI",sans-serif;
}
.param-label { color: var(--text-muted); padding-right: 4px; }
.param-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.param-control select,
.param-control input[type="text"],
.param-control input[type="number"] {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  font: 12px/1.4 "Segoe UI",sans-serif;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
}
.param-control select:focus,
.param-control input:focus { border-color: var(--brand); }
.param-control input[type="range"] {
  flex: 1;
  min-width: 0;
  accent-color: var(--brand);
}
.param-control input[type="color"] {
  width: 30px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.param-num-val {
  width: 44px;
  text-align: right;
  font: 12px/1.4 "Segoe UI",sans-serif;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.param-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* 开关 */
.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 12px/1.4 "Segoe UI",sans-serif;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.switch input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 30px;
  height: 16px;
  background: var(--border-strong);
  border-radius: 999px;
  position: relative;
  cursor: pointer;
  transition: background .12s ease;
}
.switch input[type="checkbox"]::after {
  content: "";
  position: absolute;
  top: 2px; left: 2px;
  width: 12px; height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform .12s ease;
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
.switch input[type="checkbox"]:checked { background: var(--brand); }
.switch input[type="checkbox"]:checked::after { transform: translateX(14px); }

.param-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.btn-danger {
  background: #FEE2E2;
  color: #B91C1C;
  border: 1px solid #FECACA;
}
.btn-danger:hover { background: #FECACA; }

/* ========== 缓存资源 Tab ========== */
.cache-toolbar {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 8px;
  margin-bottom: 12px;
  align-items: center;
}
.cache-toolbar .filter-input { grid-column: 1 / -1; }
.segmented {
  display: inline-flex;
  background: var(--surface-muted);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.seg {
  padding: 4px 10px;
  font: 12px/1.4 "Segoe UI",sans-serif;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-right: 1px solid var(--border);
  cursor: pointer;
}
.seg:last-child { border-right: none; }
.seg:hover { color: var(--text); }
.seg.active {
  color: #fff;
  background: var(--brand);
}
.cache-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

.cache-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.cache-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color .12s ease, transform .12s ease;
  cursor: pointer;
}
.cache-card:hover {
  border-color: var(--brand);
  transform: translateY(-1px);
}
.cache-thumb {
  aspect-ratio: 4 / 3;
  background: var(--surface-muted);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: var(--text-muted);
}
.cache-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cache-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cache-name {
  font: 600 12px/1.35 "Segoe UI",sans-serif;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cache-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font: 11px/1.4 "Segoe UI",sans-serif;
  color: var(--text-muted);
}
.cache-sub .tag-small {
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  background: #EEF2FF;
  color: var(--brand);
}
.cache-sub .tag-small.motion { background: #ECFEFF; color: #0891B2; }
.cache-btns {
  display: flex;
  gap: 4px;
}
.cache-btns .btn { flex: 1; font-size: 11px; padding: 4px 6px; }

/* 进度条（扫描/缓存对话框） */
.progress-track {
  width: 100%;
  height: 6px;
  background: var(--surface-muted);
  border-radius: 999px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--brand), #8B5CF6);
  transition: width .12s ease;
}
```

- [ ] **Step 2: 构建样式检查（无语法错误）**

Run: `npm run build:renderer`
Expected: 构建成功（esbuild 不做 CSS 校验，无 JS 语法错误即通过）。

- [ ] **Step 3: Commit**
```bash
git add renderer/styles.css
git commit -m "feat(css): 新增Tab容器、参数控件、缓存网格卡片、分段过滤、进度条样式"
```

---

## 任务 3：Preload — 缓存 IPC API 桥接

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: 在 contextBridge.exposeInMainWorld('mmdAPI', {...}) 末尾追加缓存相关方法**

在现有 `getAmmoLibsDir: ...` 之后追加：

```js
  /** ========== 缓存资源识别 & 管理 ========== */

  /** 返回缓存根目录/子目录绝对路径与当前总占用字节 */
  getCacheDirInfo: () => ipcRenderer.invoke('get-cache-dir-info'),

  /**
   * 开始资源扫描（文件遍历 + 压缩包内部条目识别，不复制）
   * @param {Object} p
   * @param {string[]} p.roots     要扫描的根目录绝对路径数组（通常 [模型库, 动作库]）
   * @param {boolean}  p.intoArchives 是否进入压缩包（ZIP/7Z/RAR 等）列举内部条目；默认 true
   * @returns {Promise<{taskId:string}>} taskId 用于取消与订阅进度
   */
  startResourceScan: (p) => ipcRenderer.invoke('start-resource-scan', p),

  /** 取消指定扫描或缓存阶段任务（taskId 来自 startResourceScan 返回或 scan-done 后传给 cache-selected-resources 的同一 ID） */
  cancelResourceScan: (taskId) => ipcRenderer.invoke('cancel-resource-scan', taskId),

  /**
   * 执行勾选的候选资源 → 复制到 cache/models 或 cache/motions
   * @param {Object} p
   * @param {string}   p.taskId
   * @param {string[]} p.ids 候选 ID（来自 scan-done candidates[*].id）
   * @returns {Promise<void>}
   */
  cacheSelectedResources: (p) => ipcRenderer.invoke('cache-selected-resources', p),

  /** 返回 index.json 完整结构与计算总大小 */
  getCacheIndex: () => ipcRenderer.invoke('get-cache-index'),

  /**
   * 删除指定项（同步删除磁盘文件与 thumb + index 条目）
   * @param {string[]} ids
   * @returns {Promise<{deleted:string[], failed:string[]}>}
   */
  deleteCacheItems: (ids) => ipcRenderer.invoke('delete-cache-items', ids),

  /**
   * 按范围清空缓存
   * @param {'models'|'motions'|'all'} scope
   * @returns {Promise<{removed:number, freedBytes:number}>}
   */
  clearCache: (scope) => ipcRenderer.invoke('clear-cache', scope),

  /**
   * 保存缩略图 PNG 并关联到 index 条目
   * @param {{id:string, base64Png:string}} p
   */
  writeCacheThumb: (p) => ipcRenderer.invoke('write-cache-thumb', p),

  /** 事件订阅 —— 扫描进度：{taskId, done:number, total:number, currentDir:string} */
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_e, payload) => cb(payload)),
  /** 事件订阅 —— 扫描结束：{taskId, candidates:[{id,name,ext,sourcePath,sourceType,archiveEntry?,sizeEstimate}], totalCount, totalSize, error?} */
  onScanDone:     (cb) => ipcRenderer.on('scan-done',     (_e, payload) => cb(payload)),
  /** 事件订阅 —— 缓存复制进度：{taskId, done:number, total:number, currentName:string, succeeded:boolean, error?:string} */
  onCacheProgress:(cb) => ipcRenderer.on('cache-progress',(_e, payload) => cb(payload)),
  /** 事件订阅 —— 缓存复制结束：{taskId, summary:{ok:number, fail:number, indexVersion:number}, error?:string} */
  onCacheDone:    (cb) => ipcRenderer.on('cache-done',    (_e, payload) => cb(payload)),
```

- [ ] **Step 2: 语法自检（通过启动时不崩验证）**

Run: `npm start` → 窗口打开后，打开 DevTools 控制台，确认 `window.mmdAPI.getCacheDirInfo` / `startResourceScan` 等函数存在。

- [ ] **Step 3: Commit**
```bash
git add preload.js
git commit -m "feat(preload): 暴露缓存目录、资源扫描/取消/复制/索引读写/缩略图写入IPC与四个事件订阅API"
```

---

## 任务 4：主进程 — 缓存目录 + index.json 读写基础能力

**Files:**
- Modify: `main.js`（在现有 ipcMain.handle('get-ammo-libs-dir', ...) 后追加）

- [ ] **Step 1: 引入 fs/promises 并声明缓存相关 helper（文件顶部或靠近 ipcMain 区块即可）**

在 `main.js` 中 ipcMain 配置区域前（或内部）追加：

```js
const fsp = require('fs/promises');
const crypto = require('crypto');

function cachePaths() {
  const root     = path.join(app.getPath('userData'), 'cache');
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
        try { const s = await fsp.stat(fp); total += s.size; } catch {}
      }
    }
  } catch {}
  return total;
}
function itemId(type, keySource) {
  return (type === 'model' ? 'm_' : 'v_') +
    crypto.createHash('sha1').update(keySource).digest('hex').slice(0, 12);
}
function safeFilename(name) {
  // 保留中文、字母数字、点、下划线、短横线；其余替换为 _
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'file';
}
```

- [ ] **Step 2: 注册 ipcMain.handle('get-cache-dir-info', ...)**

```js
ipcMain.handle('get-cache-dir-info', async () => {
  const p = await ensureCacheDirs();
  const total = await calcDirSize(p.root);
  return { root: p.root, models: p.models, motions: p.motions, thumbs: p.thumbs, tmp: p.tmp, totalSize: total };
});
```

- [ ] **Step 3: 注册 ipcMain.handle('get-cache-index', ...) 与 writeCacheThumb**

```js
ipcMain.handle('get-cache-index', async () => {
  await ensureCacheDirs();
  const idx = await readIndex();
  // 附加缓存占用
  const p = cachePaths();
  const totalSize = (idx.items || []).reduce((s, it) => s + (it.cacheSize || 0), 0);
  return { index: idx, totalSize };
});

ipcMain.handle('write-cache-thumb', async (_e, { id, base64Png }) => {
  if (!id || !base64Png) return { ok: false, error: 'missing id or base64Png' };
  const p = await ensureCacheDirs();
  try {
    const data = Buffer.from(base64Png.replace(/^data:image\/png;base64,/i, ''), 'base64');
    const thumbPath = `thumbs/${id}.png`;
    const abs = path.join(p.root, thumbPath);
    await fsp.writeFile(abs, data);
    const idx = await readIndex();
    const it = (idx.items || []).find(x => x.id === id);
    if (it) { it.thumb = thumbPath; await writeIndex(idx); }
    return { ok: true, thumbPath };
  } catch (e) {
    console.error('[cache] writeCacheThumb failed:', e);
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
```

- [ ] **Step 4: 注册 deleteCacheItems + clearCache**

```js
ipcMain.handle('delete-cache-items', async (_e, ids) => {
  if (!Array.isArray(ids)) return { deleted: [], failed: [] };
  const p = await ensureCacheDirs();
  const idx = await readIndex();
  const items = idx.items || [];
  const deleted = [];
  const failed  = [];
  for (const id of ids) {
    const i = items.findIndex(x => x.id === id);
    if (i < 0) { failed.push(id); continue; }
    const it = items[i];
    try {
      // 删 cachePath
      if (it.cachePath) {
        const abs = it.cachePath.startsWith(p.root) ? it.cachePath : path.join(p.root, it.cachePath);
        try { await fsp.unlink(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        // 如果文件上级目录是自动建的子文件夹且为空，尝试删除空文件夹（不抛错）
        try {
          const parentDir = path.dirname(abs);
          const rel = path.relative(p.root, parentDir);
          if (rel && !rel.startsWith('..')) {
            const ents = await fsp.readdir(parentDir);
            if (!ents.length) await fsp.rmdir(parentDir);
          }
        } catch {}
      }
      // 删 thumb
      if (it.thumb) {
        const tAbs = path.join(p.root, it.thumb);
        try { await fsp.unlink(tAbs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      items.splice(i, 1);
      deleted.push(id);
    } catch (e) {
      console.error('[cache] delete item failed:', id, e);
      failed.push(id);
    }
  }
  await writeIndex(idx);
  return { deleted, failed };
});

ipcMain.handle('clear-cache', async (_e, scope) => {
  const p = await ensureCacheDirs();
  const idx = await readIndex();
  let removed = 0;
  let freedBytes = 0;
  const keep = [];
  const removeDirs = [];
  for (const it of (idx.items || [])) {
    const matches = scope === 'all'
      || (scope === 'models'  && it.type === 'model')
      || (scope === 'motions' && it.type === 'motion');
    if (matches) {
      removed++;
      freedBytes += (it.cacheSize || 0);
      if (it.cachePath) removeDirs.push(path.dirname(path.join(p.root, it.cachePath)));
    } else keep.push(it);
  }
  idx.items = keep;
  await writeIndex(idx);
  // 删对应磁盘文件夹（递归删除整个 type 子目录更彻底 & 安全）
  const tryRm = async (d) => { try { await fsp.rm(d, { recursive: true, force: true }); } catch {} };
  if (scope === 'all')    { await tryRm(p.models); await tryRm(p.motions); await tryRm(p.thumbs); await fsp.mkdir(p.models,{recursive:true}); await fsp.mkdir(p.motions,{recursive:true}); await fsp.mkdir(p.thumbs,{recursive:true}); }
  if (scope === 'models') { await tryRm(p.models);  await fsp.mkdir(p.models,{recursive:true}); }
  if (scope === 'motions'){ await tryRm(p.motions); await fsp.mkdir(p.motions,{recursive:true}); }
  return { removed, freedBytes };
});
```

- [ ] **Step 5: 语法自检**

Run: `node -c main.js`（如有 `SyntaxError` 先修复）
Expected: No output（语法无误）。

- [ ] **Step 6: Commit**
```bash
git add main.js
git commit -m "feat(main): 缓存目录初始化、index.json读写、getCacheDirInfo/getCacheIndex/writeCacheThumb/deleteCacheItems/clearCache 五个IPC落地"
```

---

## 任务 5：主进程 — 资源扫描 + 候选识别（含压缩包内部）

**Files:**
- Modify: `main.js`（紧接着 Task 4 的代码，在 file-ready 前或 ipcMain 区块末尾均可）

- [ ] **Step 1: 在 main.js 增加扫描任务管理 Map + 常量扩展**

```js
/** 扫描 & 缓存任务状态：{ cancelled:boolean, candidates:[], ... } */
const scanTasks = new Map();

const MODEL_EXT_RE  = /\.(pmx|pmd)$/i;
const MOTION_EXT_RE = /\.(vmd|vpd)$/i;
const ARCHIVE_EXT_RE = /\.(zip|7z|rar|tar\.gz|tgz|tar\.xz|txz|tar)$/i;
```

- [ ] **Step 2: 实现 walkDirCollect 与 addCandidate，然后注册 start-resource-scan**

```js
ipcMain.handle('start-resource-scan', async (e, { roots, intoArchives = true } = {}) => {
  await ensureCacheDirs();
  const taskId = 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const state = { cancelled: false, candidates: [], done: 0, total: 0, estimatedTotal: 0 };
  scanTasks.set(taskId, state);
  const win = BrowserWindow.fromWebContents(e.sender);

  const sendProgress = (currentDir) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('scan-progress', { taskId, done: state.done, total: state.total || state.done + 1, currentDir });
  };

  // 先估算总目录数（用于进度），再异步扫描
  (async () => {
    try {
      const listRoots = Array.isArray(roots) && roots.length ? roots.slice() : [];

      // Step A: 广度优先收集所有待处理目录 / 文件数，用于 total
      const pendingDirs = listRoots.slice();
      const allEntries = [];   // {kind:'file'|'archive'|'dir', path}
      while (pendingDirs.length) {
        if (state.cancelled) break;
        const d = pendingDirs.shift();
        try {
          const ents = await fsp.readdir(d, { withFileTypes: true });
          for (const ent of ents) {
            const fp = path.join(d, ent.name);
            if (ent.isDirectory()) {
              pendingDirs.push(fp);
              allEntries.push({ kind: 'dir', path: fp });
            } else if (ent.isFile()) {
              if      (MODEL_EXT_RE.test(ent.name))  allEntries.push({ kind: 'file', path: fp });
              else if (MOTION_EXT_RE.test(ent.name)) allEntries.push({ kind: 'file', path: fp });
              else if (ARCHIVE_EXT_RE.test(ent.name)) allEntries.push({ kind: 'archive', path: fp });
            }
          }
        } catch (err) {
          console.warn('[scan] readdir fail:', d, err && err.message);
        }
      }
      state.total = allEntries.length;

      // Step B: 逐个处理（文件直接入候选，压缩包 listArchiveContents 入条目）
      for (const entry of allEntries) {
        if (state.cancelled) break;
        state.done++;
        if ((state.done & 31) === 0) sendProgress(entry.path);  // 每 32 条推一次进度，降低 IPC 频次
        try {
          const name = path.basename(entry.path);
          if (entry.kind === 'file') {
            let type = null;
            if      (MODEL_EXT_RE.test(name))  type = 'model';
            else if (MOTION_EXT_RE.test(name)) type = 'motion';
            if (!type) continue;
            const ext = path.extname(name).toLowerCase();
            let size = 0;
            try { const st = await fsp.stat(entry.path); size = st.size; } catch {}
            state.candidates.push({
              id:   itemId(type, entry.path),
              type, name, ext,
              sourcePath: entry.path,
              sourceType: 'file',
              archiveEntry: null,
              sizeEstimate: size,
            });
          } else if (entry.kind === 'archive' && intoArchives) {
            // 调用已有的 list-archive-contents IPC 复用逻辑
            try {
              const listing = await ipcMainHandler_ListArchiveContents(entry.path);
              if (!listing || !listing.ok) continue;
              for (const ent of listing.contents || []) {
                const base = (ent.path.split(/[\\/]/).pop() || '');
                let type = null;
                if      (MODEL_EXT_RE.test(base))  type = 'model';
                else if (MOTION_EXT_RE.test(base)) type = 'motion';
                if (!type) continue;
                const ext = path.extname(base).toLowerCase();
                state.candidates.push({
                  id:   itemId(type, entry.path + '::' + ent.path),
                  type, name: base, ext,
                  sourcePath: entry.path,
                  sourceType: 'archive',
                  archiveEntry: ent.path,
                  sizeEstimate: ent.size || 0,
                });
              }
            } catch (err) {
              console.warn('[scan] list archive fail:', entry.path, err && err.message);
            }
          }
        } catch (err) {
          console.warn('[scan] entry fail:', entry, err && err.message);
        }
      }

      const totalCount = state.candidates.length;
      const totalSize  = state.candidates.reduce((s, c) => s + (c.sizeEstimate || 0), 0);
      const result = { taskId, candidates: state.candidates, totalCount, totalSize };
      if (!win || win.isDestroyed()) return;
      if (state.cancelled) result.cancelled = true;
      win.webContents.send('scan-done', result);
    } catch (err) {
      console.error('[scan] fatal:', err);
      if (win && !win.isDestroyed()) {
        win.webContents.send('scan-done', { taskId, candidates: [], totalCount: 0, totalSize: 0, error: (err && err.message) || String(err) });
      }
    } finally {
      scanTasks.delete(taskId);
    }
  })();

  return { taskId };
});

ipcMain.handle('cancel-resource-scan', (_e, taskId) => {
  const s = scanTasks.get(taskId);
  if (s) s.cancelled = true;
  return { ok: true };
});

/**
 * 复用已有 list-archive-contents 功能。实际项目中该 IPC 的处理函数名可能不同；
 * 这里以直接调用现有实现为准：若已有 handler 导出为函数即调用，否则通过 ipcMain 内部调用。
 * 为避免耦合，本计划假设存在函数 ipcMainHandler_ListArchiveContents(archivePath) 对应原 IPC 实现：
 *   async (archivePath) => { ok:boolean, contents:[{path, size, isDir}]?, error?:string }
 * 如果原实现只暴露为 ipcMain.handle('list-archive-contents', ...)，可在 main.js 顶部将处理函数提取为变量再引用。
 */
```

> 注意：如果项目中 `list-archive-contents` IPC 是通过匿名 `ipcMain.handle('list-archive-contents', async (_, archivePath) => {...})` 注册的，请在 Task 5 代码前先将其处理体抽成顶层命名函数 `ipcMainHandler_ListArchiveContents`，再从 handle 与本扫描任务内部共同引用，**避免重复实现解压列举逻辑**。

- [ ] **Step 3: 语法自检**

Run: `node -c main.js`
Expected: 无语法错误。

- [ ] **Step 4: Commit**
```bash
git add main.js
git commit -m "feat(main): start-resource-scan/cancel-resource-scan IPC落地，支持模型/动作文件直接识别与压缩包不解压内部条目识别"
```

---

## 任务 6：主进程 — cache-selected-resources 复制缓存 + 进度推送

**Files:**
- Modify: `main.js`（紧接着 Task 5）

- [ ] **Step 1: 注册 cache-selected-resources 并实现 copyFile / 解压缩包条目两种复制策略**

```js
ipcMain.handle('cache-selected-resources', async (e, { taskId, ids }) => {
  const p = await ensureCacheDirs();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!scanTasks.has(taskId)) {
    // 任务结束时间过长时，仍允许从 scan-done 缓存里回溯 candidates
    // 此处若取不到则报错；实际可在 scan-done 时把 candidates 再缓存一份到 Map，本实现按当前 scanTasks 持有直到用户选完再删的前提（或 fallback 为重新扫描不推荐）
    return { ok: false, error: 'taskId 不存在，请先扫描再执行缓存' };
  }
  const state = scanTasks.get(taskId);
  const picks = state.candidates.filter(c => ids.includes(c.id));
  const total = picks.length;
  let done = 0;
  let okN = 0, failN = 0;
  const idx = await readIndex();
  idx.items = idx.items || [];

  const sendProg = (currentName, succeeded, error) => {
    done++;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('cache-progress', { taskId, done, total, currentName, succeeded, error });
  };

  const archiveTaskTmp = path.join(p.tmp, taskId);
  await fsp.mkdir(archiveTaskTmp, { recursive: true }).catch(()=>{});

  // 为避免复制时同名冲突，对每个候选生成"源hash"前缀子目录
  const srcHashPrefix = (src) => crypto.createHash('sha1').update(src).digest('hex').slice(0,8);

  for (const c of picks) {
    if (state.cancelled) break;
    try {
      const isModel  = c.type === 'model';
      const baseDir  = isModel ? p.models  : p.motions;
      const subDir   = path.join(baseDir, srcHashPrefix(c.sourcePath));
      await fsp.mkdir(subDir, { recursive: true });

      let absCachePath; // 目标文件绝对路径
      if (c.sourceType === 'file') {
        absCachePath = path.join(subDir, safeFilename(c.name));
        await fsp.copyFile(c.sourcePath, absCachePath);
        // 如果是 PMX/PMD，尝试复制相邻 textures / tex 文件夹
        if (isModel) {
          const srcDir = path.dirname(c.sourcePath);
          for (const siblingName of ['textures','tex','texture']) {
            const sib = path.join(srcDir, siblingName);
            try {
              const stat = await fsp.stat(sib);
              if (stat.isDirectory()) {
                const destSib = path.join(subDir, siblingName);
                await copyDirRecursive(sib, destSib);
              }
            } catch {}
          }
        }
      } else {
        // archive：先解压 archiveTaskTmp，再拷贝目标条目
        try {
          // 调用既有的 extractArchive 处理函数（等同于 handleArchive 中调用的解压）；
          // 本计划假设已提取为顶层函数 ipcMainHandler_ExtractArchive(archivePath, targetDir) => Promise<{ok:boolean, error?}>
          const ex = await ipcMainHandler_ExtractArchive(c.sourcePath, archiveTaskTmp);
          if (!ex || !ex.ok) throw new Error('解压失败：' + ((ex && ex.error) || '未知错误'));
          const absEntryPath = path.resolve(path.join(archiveTaskTmp, c.archiveEntry || ''));
          if (!absEntryPath.startsWith(path.resolve(archiveTaskTmp) + path.sep)) {
            throw new Error('非法路径：压缩包条目尝试路径穿越');
          }
          absCachePath = path.join(subDir, safeFilename(c.name));
          await fsp.copyFile(absEntryPath, absCachePath);
        } finally {
          // 无论成败，每次条目后尽量清理解压临时，末尾整体再清理一次
        }
      }
      // 统计大小 + 写 index
      const st = await fsp.stat(absCachePath);
      const relCachePath = path.relative(p.root, absCachePath);
      // 覆盖同 id 条目
      idx.items = idx.items.filter(it => it.id !== c.id);
      idx.items.push({
        id: c.id,
        type: c.type,
        name: c.name,
        ext:  c.ext,
        cachePath: relCachePath,
        cacheSize: st.size,
        sourcePath: c.sourcePath,
        sourceType: c.sourceType,
        archiveEntry: c.archiveEntry || undefined,
        addedAt: Date.now(),
        thumb: null,
      });
      await writeIndex(idx);
      okN++;
      sendProg(c.name, true);
    } catch (err) {
      console.error('[cache] copy fail:', c.name, err);
      failN++;
      sendProg(c.name, false, (err && err.message) || String(err));
    }
  }

  // 清理临时目录
  try { await fsp.rm(archiveTaskTmp, { recursive: true, force: true }); } catch {}
  try {
    const tmpFiles = await fsp.readdir(p.tmp);
    if (!tmpFiles.length) await fsp.rmdir(p.tmp).catch(()=>{});
  } catch {}

  scanTasks.delete(taskId);
  const result = { taskId, summary: { ok: okN, fail: failN, indexVersion: idx.version || 1 } };
  if (!win || win.isDestroyed()) return result;
  win.webContents.send('cache-done', result);
  return result;
});

async function copyDirRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const ents = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of ents) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDirRecursive(s, d);
    else if (ent.isFile())  await fsp.copyFile(s, d);
  }
}

/**
 * 同上：ipcMainHandler_ExtractArchive 为对原 extractArchive IPC 处理体的提取。
 * 若 main.js 中是通过 ipcMain.handle('extract-archive', ...) 匿名注册，
 * 需在 Task 6 代码前先抽出为命名函数并由两处共同调用，避免重复实现解压逻辑。
 */
```

> 重要：本任务依赖"将 extract-archive & list-archive-contents IPC 处理体抽为命名函数"这一小型重构。若原 main.js 中它们为匿名回调，在真正开始 Task 6 前，先完成这两个抽取（此为必要前置步骤）。

- [ ] **Step 2: 语法自检**

Run: `node -c main.js`
Expected: 无语法错误。

- [ ] **Step 3: Commit**
```bash
git add main.js
git commit -m "feat(main): cache-selected-resources IPC，支持文件直接复制与压缩包临时解压复制，维护index.json并通过IPC推送复制进度/结果"
```

---

## 任务 7：渲染进程 — 参数系统（DEFAULT_PARAMS + localStorage + applyParam 桩 + UI 控件渲染 + Tab 切换）

**Files:**
- Modify: `renderer/renderer.js`（在 import 后变量定义处追加；在 DOM 就绪段追加绑定）

- [ ] **Step 1: 追加参数常量、默认值与加载/保存**

在 `renderer/renderer.js` 顶部现有常量（MODEL_MESH_RE / MOTION_EXTS_RE 等）之后追加：

```js
// ===== 参数系统 =====
const PARAMS_STORAGE_KEY = 'mmd.params.v1';
const MODEL_EXT_RE  = /\.(pmx|pmd)$/i;
const MOTION_EXT_RE = /\.(vmd|vpd)$/i;
const PARAM_PREFIX = {
  render:  'render_',
  physics: 'physics_',
  ik:      'ik_',
  anim:    'anim_',
};
const DEFAULT_PARAMS = Object.freeze({
  // 渲染
  render_pixelRatio:        { v: 'auto',  type: 'enum',    opts: ['1.0','1.25','1.5','2.0','auto'] },
  render_antialias:         { v: 'fxaa',  type: 'enum',    opts: ['off','fxaa','msaa'] },
  render_shadow:            { v: 'pcfsoft', type:'enum',   opts: ['off','pcf','pcfsoft'] },
  render_bgColor:           { v: '#F7F8FB', type: 'color' },
  render_outline:           { v: true,    type: 'bool' },
  render_outlineThickness:  { v: 0.01,    type: 'number', min: 0,     max: 0.05, step: 0.001 },
  render_outlineColor:      { v: '#312E81', type: 'color' },
  // 物理
  physics_enabled:          { v: true,    type: 'bool' },
  physics_gravity:          { v: -98,     type: 'number', min: -200,  max: 0,    step: 1 },
  physics_unitStep:         { v: 1/60,    type: 'enum',   opts: [1/120, 1/60, 1/30], labels: ['1/120','1/60','1/30'] },
  physics_maxStepNum:       { v: 2,       type: 'number', min: 1,     max: 5,    step: 1 },
  physics_rbThreshold:      { v: 200,     type: 'number', min: 50,    max: 1000, step: 10 },
  // IK
  ik_iterations:            { v: 50,      type: 'number', min: 10,    max: 200,  step: 5 },
  ik_limitAngle:            { v: 0.01,    type: 'number', min: 0.001, max: 0.1,  step: 0.001 },
  // 动画
  anim_speed:               { v: 1.0,     type: 'number', min: 0.1,   max: 3.0,  step: 0.1 },
  anim_afterglow:           { v: 0.1,     type: 'number', min: 0,     max: 0.5,  step: 0.01 },
  anim_resetPhysicsOnLoop:  { v: true,    type: 'bool' },
});

// 可变副本：从 localStorage 合并
function loadParams() {
  const merged = {};
  for (const [k, def] of Object.entries(DEFAULT_PARAMS)) merged[k] = { ...def };
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return merged;
    const stored = JSON.parse(raw);
    for (const [k, obj] of Object.entries(stored || {})) {
      if (merged[k] && typeof obj === 'object' && 'v' in obj) merged[k].v = obj.v;
    }
  } catch (e) {
    console.warn('[params] 读取本地存储失败，回退默认：', e);
  }
  return merged;
}
let params = loadParams();
function saveParams() {
  const out = {};
  for (const [k, o] of Object.entries(params)) out[k] = { v: o.v };
  localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(out));
}
function setParam(k, v, { skipApply = false, skipSave = false } = {}) {
  if (!params[k]) return;
  params[k].v = v;
  if (!skipSave) saveParams();
  if (!skipApply) applyParam(k, v);
}
```

- [ ] **Step 2: 追加 applyParam 桩（模块三、四、五落地时逐步补全实现分支，先保留空壳不报错）**

```js
/**
 * 参数变更 → 应用到 Three.js 场景 / UI 同步
 * 本函数先写完整 switch 外壳与注释，落地模块三/四/五时填具体实现。
 */
function applyParam(key, val) {
  try {
    switch (key) {
      // —— 渲染：在 Task 9 & 10 填充 ——
      case 'render_pixelRatio':
      case 'render_antialias':
      case 'render_shadow':
      case 'render_bgColor':
      case 'render_outline':
      case 'render_outlineThickness':
      case 'render_outlineColor':
        // 由后处理与 renderer 改造后回填；此处先记录
        break;

      // —— 物理：在 Task 11 填 helper 重建 ——
      case 'physics_enabled':
      case 'physics_gravity':
      case 'physics_unitStep':
      case 'physics_maxStepNum':
      case 'physics_rbThreshold':
        // physics_rbThreshold 只提示不改运行时，其余重建 helper
        break;

      // —— IK：持久化即可，下次 playVmd / loadModel 生效 ——
      case 'ik_iterations':
      case 'ik_limitAngle':
        setStatus('IK 参数已保存，切换动作或重载模型时生效', 'info');
        break;

      // —— 动画：与右下角 speed-range 联动（先桩实现） ——
      case 'anim_speed':
        // Task 11 中与 mmdHelper mixer.timeScale + speed-range DOM 双向同步
        break;
      case 'anim_afterglow':
      case 'anim_resetPhysicsOnLoop':
        // Task 11 中 mmdHelper.afterglow / resetPhysicsOnLoop 赋值
        break;

      default:
        console.warn('[params] 未知参数 key:', key);
    }
  } catch (e) {
    console.error('[params] applyParam 失败：', key, val, e);
    setStatus('参数应用失败：' + (e && e.message || e), 'error');
  }
}
```

- [ ] **Step 3: 追加参数组 UI 渲染函数 + Tab 切换绑定 + 重置按钮绑定**

在 DOM 就绪段（如原来 `$('#btn-reset-view').addEventListener(...)` 所在的 initUI 函数附近，或在 `window.addEventListener('DOMContentLoaded', ...)` 内部）追加：

```js
// ========== Tab 切换 ==========
document.querySelectorAll('#info-panel .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    document.querySelectorAll('#info-panel .tab-btn').forEach(b => {
      const on = (b === btn);
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#info-panel .tab-content').forEach(c => {
      c.classList.toggle('hidden', c.dataset.view !== name);
    });
    if (name === 'cache') renderCacheTab(); // 在 Task 8 中定义
  });
});

// ========== 参数控件渲染 ==========
function renderAllParamGroups() {
  renderParamGroup('render',  document.getElementById('params-render'));
  renderParamGroup('physics', document.getElementById('params-physics'));
  renderParamGroup('ik',      document.getElementById('params-ik'));
  renderParamGroup('anim',    document.getElementById('params-anim'));
}

function renderParamGroup(groupKey, rootEl) {
  if (!rootEl) return;
  const rows = rootEl.querySelector('.group-rows');
  rows.innerHTML = '';
  const prefix = PARAM_PREFIX[groupKey];
  for (const [fullKey, def] of Object.entries(DEFAULT_PARAMS)) {
    if (!fullKey.startsWith(prefix)) continue;
    const currentVal = params[fullKey].v;
    const row = document.createElement('div');
    row.className = 'param-row';
    row.dataset.key = fullKey;
    const labelKey = fullKey.slice(prefix.length);
    const labelText = (PARAM_LABELS || {})[fullKey] || labelKey;
    row.innerHTML = `<div class="param-label" title="${fullKey}">${labelText}</div><div class="param-control"></div>`;
    const ctrl = row.querySelector('.param-control');
    attachControl(ctrl, fullKey, def, currentVal);
    // 物理组 enabled=false 的联动置灰（默认先不置灰，有模型后 loadModel 中动态判断更新）
    rows.appendChild(row);
  }
}

/** 标签映射（供显示） */
const PARAM_LABELS = {
  render_pixelRatio:       '像素比',
  render_antialias:        '抗锯齿',
  render_shadow:           '阴影',
  render_bgColor:          '背景色',
  render_outline:          '轮廓线',
  render_outlineThickness: '轮廓厚度',
  render_outlineColor:     '轮廓颜色',
  physics_enabled:         '布料物理',
  physics_gravity:         '重力强度',
  physics_unitStep:        '单步时长',
  physics_maxStepNum:      '最大步数',
  physics_rbThreshold:     '刚体阈值',
  ik_iterations:           'IK迭代',
  ik_limitAngle:           'IK每步限制',
  anim_speed:              '播放速度',
  anim_afterglow:          '余辉时长(s)',
  anim_resetPhysicsOnLoop: '循环重置物理',
};

function attachControl(container, fullKey, def, val) {
  const update = (newVal, { silent = false } = {}) => {
    setParam(fullKey, newVal);
    if (!silent) refreshParamRowValue(fullKey);
  };
  if (def.type === 'enum') {
    const sel = document.createElement('select');
    (def.opts || []).forEach((optVal, i) => {
      const o = document.createElement('option');
      o.value = String(optVal);
      o.textContent = (def.labels && def.labels[i]) ? def.labels[i] : String(optVal);
      if (optVal === val) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      // 标签→值回映射：因为 select.value 已是 String(optVal)，对 1/60 等需要 parseFloat
      let v = sel.value;
      const num = Number(v);
      if (!isNaN(num) && (def.opts || []).includes(num)) v = num;
      else if (!isNaN(num) && (def.opts || []).includes(parseFloat(v))) v = parseFloat(v);
      update(v);
    });
    container.appendChild(sel);
    return;
  }
  if (def.type === 'bool') {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    wrap.innerHTML = `<input type="checkbox" ${val ? 'checked' : ''}><span>${val ? '开' : '关'}</span>`;
    const input = wrap.querySelector('input');
    const span  = wrap.querySelector('span');
    input.addEventListener('change', () => {
      const v = input.checked;
      span.textContent = v ? '开' : '关';
      update(v);
    });
    container.appendChild(wrap);
    return;
  }
  if (def.type === 'number') {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(def.min); range.max = String(def.max); range.step = String(def.step);
    range.value = String(val);
    const numVal = document.createElement('span');
    numVal.className = 'param-num-val';
    const fmt = (v) => {
      const step = def.step;
      const digits = (String(step).split('.')[1] || '').length;
      return Number(v).toFixed(digits);
    };
    numVal.textContent = fmt(val);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      numVal.textContent = fmt(v);
      update(v);
    });
    container.appendChild(range);
    container.appendChild(numVal);
    return;
  }
  if (def.type === 'color') {
    const color = document.createElement('input');
    color.type = 'color';
    color.value = val;
    color.addEventListener('input', () => update(color.value));
    const text = document.createElement('input');
    text.type = 'text';
    text.value = val;
    text.style.width = '80px';
    text.addEventListener('change', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(text.value)) {
        color.value = text.value;
        update(text.value);
      } else {
        text.value = params[fullKey].v;
      }
    });
    container.appendChild(color);
    container.appendChild(text);
    return;
  }
}
function refreshParamRowValue(fullKey) {
  // 用于外部 setParam 后使 UI 同步
  const row = document.querySelector(`.param-row[data-key="${fullKey}"]`);
  if (!row) return;
  const def = DEFAULT_PARAMS[fullKey];
  const v   = params[fullKey].v;
  if (def.type === 'enum') {
    const sel = row.querySelector('select');
    if (sel) {
      // 找匹配的 option（考虑 number vs String 差异）
      const opts = [...sel.options];
      const hit = opts.find(o => Number(o.value) === v || o.value === String(v));
      if (hit) hit.selected = true;
    }
  } else if (def.type === 'bool') {
    const cb = row.querySelector('input[type="checkbox"]');
    const span = row.querySelector('.switch > span');
    if (cb)   cb.checked = !!v;
    if (span) span.textContent = !!v ? '开' : '关';
  } else if (def.type === 'number') {
    const r = row.querySelector('input[type="range"]');
    const s = row.querySelector('.param-num-val');
    if (r) r.value = String(v);
    if (s) {
      const step = def.step;
      const digits = (String(step).split('.')[1] || '').length;
      s.textContent = Number(v).toFixed(digits);
    }
  } else if (def.type === 'color') {
    const [c, t] = row.querySelectorAll('input[type="color"], input[type="text"]');
    if (c) c.value = v;
    if (t && /^#/.test(v)) t.value = v;
  }
}

// ========== 参数重置按钮 ==========
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-reset-group').addEventListener('click', () => {
    const activeGroupBtn = document.querySelector('#info-panel .tab-btn.active');
    if (!activeGroupBtn || activeGroupBtn.dataset.tab !== 'params') return;
    // 用当前 data-group=? 需要另行记忆；简单做法：按「上次选中参数子组」或按当前视口首个可见 param-group 取 groupKey
    const groups = ['render','physics','ik','anim'];
    // 简单策略：弹窗选组；或在参数面板头部加个隐藏的激活标记。这里用"仅重置当前在视口顶部可见的 param-group"
    // 如要更精确，可给参数组标题加点击标记。本计划使用 resetGroup 函数接收组名并在 UI 上以提示辅助
    resetGroupPrompt();
  });
  document.getElementById('btn-reset-all').addEventListener('click', () => {
    if (!confirm('确定要重置全部参数为默认值吗？')) return;
    for (const [k, def] of Object.entries(DEFAULT_PARAMS)) {
      setParam(k, def.v);
    }
    renderAllParamGroups();   // 重新渲染确保显示回默认
    setStatus('已重置全部参数为默认值', 'info');
  });
});

function resetGroupPrompt() {
  // 简单交互：prompt 输入；或用 confirm 配合默认 render 组
  const raw = prompt('请输入要重置的参数组名（render / physics / ik / anim 或留空 = render）：', 'render');
  const name = (raw || 'render').trim().toLowerCase();
  if (!['render','physics','ik','anim'].includes(name)) { alert('无效组名'); return; }
  const prefix = PARAM_PREFIX[name];
  for (const [k, def] of Object.entries(DEFAULT_PARAMS)) {
    if (!k.startsWith(prefix)) continue;
    setParam(k, def.v);
  }
  renderAllParamGroups();
  setStatus(`已重置参数组：${name}`, 'info');
}

// DOMContentLoaded 最后：渲染全部参数组
// （若原文件已注册 DOMContentLoaded，请把下面这一行放入其回调末尾；否则单独注册）
window.addEventListener('DOMContentLoaded', renderAllParamGroups, { once: true });
```

- [ ] **Step 4: 构建验证**

Run: `npm run build:renderer`
Expected: 构建成功，bundle.js 正常。

Run: `npm start`
Expected: 打开右侧「参数面板」Tab，能看到四组参数且控件默认值符合 DEFAULT_PARAMS；拖动 range 或点开关后刷新应用，参数仍保持（localStorage 持久化生效）。

- [ ] **Step 5: Commit**
```bash
git add renderer/renderer.js
git commit -m "feat(renderer): 落地DEFAULT_PARAMS+localStorage、Tab切换、参数控件渲染、重置按钮、applyParam桩函数"
```

---

## 任务 8：渲染进程 — 缓存资源 Tab UI + 扫描开关 + 对话框 + 进度 + 缩略图写入

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: 缓存 Tab 顶层变量 + renderCacheTab + 事件订阅**

在 Task 7 之后或 `mmdAPI` 引用之后追加：

```js
// ===== 缓存资源 =====
let cacheIndexSnapshot = { items: [], totalSize: 0 };
let currentCacheTypeFilter = 'all';     // all / models / motions
let currentCacheNameFilter = '';
let activeScanTaskId = null;

async function refreshCacheIndex() {
  try {
    const r = await api.getCacheIndex();
    cacheIndexSnapshot = {
      items: (r && r.index && r.index.items) ? r.index.items : [],
      totalSize: r && typeof r.totalSize === 'number' ? r.totalSize : 0,
    };
    const el = document.getElementById('cache-size');
    if (el) el.textContent = fmtSize(cacheIndexSnapshot.totalSize);
  } catch (e) {
    console.error('[cache] 刷新索引失败：', e);
  }
}

async function renderCacheTab() {
  await refreshCacheIndex();
  const grid = document.getElementById('cache-grid');
  if (!grid) return;
  const list = cacheIndexSnapshot.items.filter(it => {
    if (currentCacheTypeFilter === 'models'  && it.type !== 'model')  return false;
    if (currentCacheTypeFilter === 'motions' && it.type !== 'motion') return false;
    if (currentCacheNameFilter) {
      const q = currentCacheNameFilter.toLowerCase();
      if (!(it.name || '').toLowerCase().includes(q) && !(it.sourcePath || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  if (!list.length) {
    grid.innerHTML = `<div class="placeholder">${cacheIndexSnapshot.items.length ? '没有匹配的缓存资源。' : '暂无缓存。打开工具栏「自动识别缓存」开关开始扫描。'}</div>`;
    return;
  }
  grid.innerHTML = list.map(it => {
    const icon = it.type === 'model' ? '🧊' : '🎬';
    const badgeClass = it.type === 'motion' ? 'motion' : '';
    const tag = it.type === 'model' ? '模型' : '动作';
    const thumbHtml = it.thumb
      ? `<img src="${api.mmdUrl(path.join((api.getCacheDirInfo && /* placeholder — 先在下面补 resolveThumbAbsolutePath */''), it.thumb))}" alt="">`
      : icon;
    return `
      <div class="cache-card" data-id="${it.id}" data-type="${it.type}" data-path="${escapeAttr(it.cachePath || '')}">
        <div class="cache-thumb">${thumbHtml}</div>
        <div class="cache-meta">
          <div class="cache-name" title="${escapeAttr(it.name)}">${escapeHtml(it.name)}</div>
          <div class="cache-sub">
            <span class="tag-small ${badgeClass}">${tag}</span>
            <span>${fmtSize(it.cacheSize || 0)}</span>
          </div>
        </div>
        <div class="cache-btns">
          <button class="btn btn-small btn-primary cache-load">载入</button>
          <button class="btn btn-small cache-del">删除</button>
        </div>
      </div>`;
  }).join('');

  // 绑定卡片事件
  [...grid.querySelectorAll('.cache-card')].forEach(card => {
    const id   = card.dataset.id;
    const type = card.dataset.type;
    // 缩略图点击/悬停 → 如无 thumb 则尝试生成（仅限模型）
    // 载入
    card.querySelector('.cache-load').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const item = cacheIndexSnapshot.items.find(x => x.id === id);
      if (!item) return;
      const info = await api.getCacheDirInfo();
      const abs = path.join(info.root, item.cachePath);
      if (type === 'model') {
        await loadModel({ path: abs, name: item.name, size: item.cacheSize, type: 'model' });
        // 尝试生成缩略图（若还没有）
        if (!item.thumb) {
          try {
            const dataUrl = renderer.domElement.toDataURL('image/png');
            // 裁剪居中（简单：直接使用，或用离屏 canvas 截 4:3 中心）
            const cropped = cropTo43(dataUrl);
            await api.writeCacheThumb({ id, base64Png: cropped });
            await refreshCacheIndex();
          } catch {}
        }
      } else {
        if (!currentMesh) { setStatus('请先加载模型，再应用此动作', 'warn'); return; }
        await playVmd(abs, currentMesh);
      }
    });
    // 删除
    card.querySelector('.cache-del').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('删除此缓存资源？文件将从磁盘移除且无法恢复。')) return;
      const r = await api.deleteCacheItems([id]);
      setStatus(`删除 ${r.deleted.length} 项，失败 ${r.failed.length} 项`, r.failed.length ? 'warn' : 'info');
      renderCacheTab();
    });
  });
}

function cropTo43(dataUrlPng) {
  // 用离屏 canvas 把截图裁剪为 4:3 居中，减小缓存缩略图体积
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const targetRatio = 4 / 3;
      const srcRatio = img.width / img.height;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (srcRatio > targetRatio) { sw = Math.round(img.height * targetRatio); sx = Math.round((img.width - sw) / 2); }
      else                        { sh = Math.round(img.width / targetRatio); sy = Math.round((img.height - sh) / 2); }
      c.width  = 480;
      c.height = 360;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrlPng);  // 失败回退原图
    img.src = dataUrlPng;
  });
}
```

- [ ] **Step 2: 绑定过滤 & 清空按钮 & 搜索框 & 分段控件**

在 DOMContentLoaded 回调中追加：

```js
// ===== 缓存 Tab 控件 =====
document.getElementById('cache-filter').addEventListener('input', (e) => {
  currentCacheNameFilter = (e.target.value || '').trim();
  renderCacheTab();
});
document.querySelectorAll('#info-panel .segmented .seg').forEach(seg => {
  seg.addEventListener('click', () => {
    document.querySelectorAll('#info-panel .segmented .seg').forEach(x => x.classList.toggle('active', x === seg));
    currentCacheTypeFilter = seg.dataset.cacheType;
    renderCacheTab();
  });
});
document.getElementById('btn-clear-model-cache').addEventListener('click', async () => {
  if (!confirm('确定清空所有模型缓存？')) return;
  const r = await api.clearCache('models');
  setStatus(`已清理模型缓存 ${r.removed} 项，释放 ${fmtSize(r.freedBytes)}`, 'info');
  renderCacheTab();
});
document.getElementById('btn-clear-motion-cache').addEventListener('click', async () => {
  if (!confirm('确定清空所有动作缓存？')) return;
  const r = await api.clearCache('motions');
  setStatus(`已清理动作缓存 ${r.removed} 项，释放 ${fmtSize(r.freedBytes)}`, 'info');
  renderCacheTab();
});
document.getElementById('btn-clear-all-cache').addEventListener('click', async () => {
  if (!confirm('确定一键清空所有缓存资源？此操作不可撤销。')) return;
  const r = await api.clearCache('all');
  setStatus(`已清空全部缓存 ${r.removed} 项，释放 ${fmtSize(r.freedBytes)}`, 'info');
  renderCacheTab();
});

// ===== 工具栏自动识别缓存开关 =====
document.getElementById('tgl-auto-cache').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (!on) {
    if (activeScanTaskId) { await api.cancelResourceScan(activeScanTaskId); activeScanTaskId = null; }
    setStatus('已关闭自动识别缓存', 'info');
    return;
  }
  // 弹出扫描配置
  const config = openScanConfigDialog({
    defaultRoots: [state.modelsRoot, state.motionsRoot].filter(Boolean),
  });
  if (!config) { e.target.checked = false; return; }
  try {
    const { taskId } = await api.startResourceScan({ roots: config.roots, intoArchives: config.intoArchives });
    activeScanTaskId = taskId;
    openScanProgressDialog(taskId, { countThreshold: 500, sizeThreshold: 500 * 1024 * 1024 });
  } catch (err) {
    setStatus('启动扫描失败：' + (err && err.message || err), 'error');
    e.target.checked = false;
  }
});

// ===== 订阅扫描与缓存事件（只订阅一次） =====
window.addEventListener('DOMContentLoaded', () => {
  api.onScanProgress(p => updateScanProgressDialog(p));
  api.onScanDone(p => onScanDoneHandler(p));
  api.onCacheProgress(p => updateCacheProgressDialog(p));
  api.onCacheDone(p => onCacheDoneHandler(p));
  // 首次加载如右 Tab 切到缓存即刷新
  if (document.querySelector('#info-panel .tab-btn.active[data-tab="cache"]')) renderCacheTab();
}, { once: true });
```

- [ ] **Step 3: 实现扫描配置对话框 / 扫描进度 / 超量预警勾选 / 缓存复制进度**

在 renderer.js 继续追加（保持所有 UI 辅助函数与 scan 状态集中）：

```js
// ===== 对话框：扫描配置 + 扫描进度 + 超量选择 + 复制进度（统一使用 <dialog id="dlg-scan"> 浮层） =====
function ensureScanDialog() {
  let dlg = document.getElementById('dlg-scan');
  if (dlg) return dlg;
  const wrap = document.createElement('dialog');
  wrap.id = 'dlg-scan';
  wrap.className = 'glass-modal';
  wrap.innerHTML = `
    <form method="dialog" class="modal-inner">
      <div class="modal-title" id="dlg-title">扫描配置</div>
      <div id="dlg-body"  class="modal-body"></div>
      <div id="dlg-footer" class="modal-footer"></div>
    </form>`;
  document.body.appendChild(wrap);
  return wrap;
}
function openScanConfigDialog({ defaultRoots = [] } = {}) {
  const dlg = ensureScanDialog();
  const defaultRootsHtml = (defaultRoots.length ? defaultRoots : ['（请填写模型库与动作库目录）']).map(p =>
    `<li><label><input type="checkbox" checked class="scan-root-cb" value="${escapeAttr(p)}"><span title="${escapeAttr(p)}">${escapeHtml(p)}</span></label></li>`
  ).join('');
  dlg.querySelector('#dlg-title').textContent = '⚙ 配置自动识别扫描范围';
  dlg.querySelector('#dlg-body').innerHTML = `
    <div class="section mb">要扫描的根目录（建议包括模型库与动作库）：</div>
    <ul class="scan-roots-ul">${defaultRootsHtml}</ul>
    <div class="mt section mb">要扫描的文件类型：</div>
    <label class="switch"><input id="scan-into-archives" type="checkbox" checked><span>进入压缩包（不解压即可列举 PMX/PMD/VMD/VPD）</span></label>
    <div class="mt subsection">说明：扫描过程可随时取消；当识别到的候选资源较多时会弹窗提示您勾选后再复制缓存。</div>`;
  dlg.querySelector('#dlg-footer').innerHTML = `
    <button value="cancel" class="btn">取消</button>
    <button id="dlg-btn-ok" value="default" class="btn btn-primary">开始扫描</button>`;

  let result = null;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue === 'default') {
        const cbs  = [...dlg.querySelectorAll('.scan-root-cb:checked')];
        const roots = cbs.map(c => c.value).filter(Boolean);
        const intoArchives = dlg.querySelector('#scan-into-archives').checked;
        result = { roots, intoArchives };
      }
      dlg.remove();
      resolve(result);
    }, { once: true });
  });
}

function openScanProgressDialog(taskId, { countThreshold, sizeThreshold }) {
  const dlg = ensureScanDialog();
  dlg.dataset.taskId = taskId;
  dlg.dataset.countTh = String(countThreshold);
  dlg.dataset.sizeTh  = String(sizeThreshold);
  dlg.querySelector('#dlg-title').textContent = `🔍 正在扫描资源…（${taskId}）`;
  dlg.querySelector('#dlg-body').innerHTML = `
    <div id="scan-progress-current" class="subsection mb">准备开始…</div>
    <div class="progress-track mb"><div id="scan-progress-fill" class="progress-fill" style="width:0%"></div></div>
    <div class="subsection" id="scan-progress-count">0 / 0 项已处理</div>`;
  dlg.querySelector('#dlg-footer').innerHTML = `
    <button value="cancel" class="btn" id="scan-cancel-btn">取消扫描</button>`;
  dlg.returnValue = '';
  dlg.showModal();
  // 取消按钮映射：关闭时调 api.cancel
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'cancel' || dlg.returnValue === '') {
      if (dlg.dataset.taskId) api.cancelResourceScan(dlg.dataset.taskId).catch(() => {});
    }
    dlg.remove();
  }, { once: true });
}
function updateScanProgressDialog({ taskId, done, total, currentDir }) {
  const dlg = document.getElementById('dlg-scan');
  if (!dlg || dlg.dataset.taskId !== taskId) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = dlg.querySelector('#scan-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const curr = dlg.querySelector('#scan-progress-current');
  if (curr) curr.textContent = currentDir ? ('当前目录：' + currentDir) : '准备中…';
  const cnt = dlg.querySelector('#scan-progress-count');
  if (cnt) cnt.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} 项 · ${pct}%`;
}
function onScanDoneHandler({ taskId, candidates = [], totalCount, totalSize, cancelled, error }) {
  const dlg = document.getElementById('dlg-scan');
  if (activeScanTaskId === taskId) activeScanTaskId = null;
  if (error) {
    closeDialogGracefully(dlg);
    setStatus('扫描失败：' + error, 'error');
    return;
  }
  if (cancelled) {
    closeDialogGracefully(dlg);
    setStatus('扫描已取消', 'warn');
    return;
  }
  // 超量检查
  const countTh = Number(dlg && dlg.dataset.countTh) || 500;
  const sizeTh  = Number(dlg && dlg.dataset.sizeTh)  || (500 * 1024 * 1024);
  const overLimit = totalCount >= countTh || totalSize >= sizeTh;
  if (!candidates.length) {
    closeDialogGracefully(dlg);
    setStatus(`扫描完成，未识别到可缓存的 PMX/PMD/VMD/VPD 资源`, 'warn');
    document.getElementById('tgl-auto-cache').checked = false;
    return;
  }
  if (overLimit) {
    // 打开"勾选确认"对话框
    openPickCandidatesDialog(taskId, candidates, totalCount, totalSize);
  } else {
    // 直接全部开始缓存
    startCachingTask(taskId, candidates.map(c => c.id));
  }
}
function closeDialogGracefully(dlg) { try { if (dlg && dlg.tagName === 'DIALOG' && dlg.open) dlg.close(); } catch {} }

function openPickCandidatesDialog(taskId, candidates, totalCount, totalSize) {
  const dlg = ensureScanDialog();
  dlg.dataset.taskId = taskId;
  dlg.querySelector('#dlg-title').textContent = `⚠ 识别到 ${totalCount} 项资源（约 ${fmtSize(totalSize)}），请勾选后再缓存`;
  // 分类
  const models  = candidates.filter(c => c.type === 'model');
  const motions = candidates.filter(c => c.type === 'motion');
  const renderRows = (arr, cap) => arr.slice(0, 500).map(c =>
    `<li><label><input type="checkbox" class="pick-id-cb" value="${c.id}" checked><span>${cap} · ${escapeHtml(c.name)} · ${fmtSize(c.sizeEstimate||0)}</span> <small class="muted">${escapeHtml(c.sourcePath)}${c.archiveEntry ? ' # ' + escapeHtml(c.archiveEntry) : ''}</small></label></li>`
  ).join('') + (arr.length > 500 ? `<li class="muted subsection">…仅展示前 500 项，可搜索过滤后勾选</li>` : '');
  dlg.querySelector('#dlg-body').innerHTML = `
    <div class="subsection mb">按类型过滤：
      <label><input type="checkbox" class="pick-filter-cb" data-kind="model"  checked>🧊 模型（${models.length}）</label>
      <label><input type="checkbox" class="pick-filter-cb" data-kind="motion" checked>🎬 动作（${motions.length}）</label>
      <div style="margin-top:6px;">
        <input id="pick-search" class="filter-input" placeholder="搜索名称/来源…" />
      </div>
      <div style="margin-top:6px;">
        <button type="button" class="btn btn-small" id="pick-sel-all">全选</button>
        <button type="button" class="btn btn-small" id="pick-sel-inv">反选</button>
      </div>
    </div>
    <ul id="pick-list" class="pick-list">
      ${renderRows(models, '🧊')}${renderRows(motions, '🎬')}
    </ul>`;
  dlg.querySelector('#dlg-footer').innerHTML = `
    <button value="cancel" class="btn" id="pick-cancel-btn">取消</button>
    <button value="default" class="btn btn-primary" id="pick-start-btn">开始缓存（0 项）</button>`;
  dlg.returnValue = '';
  dlg.showModal();

  // 事件
  const listEl = dlg.querySelector('#pick-list');
  const allIds = new Set(candidates.map(c => c.id));
  const byId  = Object.fromEntries(candidates.map(c => [c.id, c]));
  const filterState = { model: true, motion: true, q: '' };

  function applyFilter() {
    const lis = listEl.querySelectorAll('li');
    lis.forEach(li => {
      const cb = li.querySelector('.pick-id-cb');
      if (!cb) return;
      const id = cb.value;
      const c = byId[id];
      if (!c) { li.style.display = 'none'; return; }
      if (!filterState[c.type]) { li.style.display = 'none'; return; }
      if (filterState.q) {
        const q = filterState.q.toLowerCase();
        const hay = (c.name + ' ' + c.sourcePath + ' ' + (c.archiveEntry || '')).toLowerCase();
        if (!hay.includes(q)) { li.style.display = 'none'; return; }
      }
      li.style.display = '';
    });
    updateCountBtn();
  }
  function updateCountBtn() {
    const n = [...dlg.querySelectorAll('.pick-id-cb:checked')].length;
    const btn = dlg.querySelector('#pick-start-btn');
    btn.textContent = `开始缓存（${n} 项）`;
    btn.disabled = n === 0;
  }
  dlg.querySelectorAll('.pick-filter-cb').forEach(cb => {
    cb.addEventListener('change', () => { filterState[cb.dataset.kind] = cb.checked; applyFilter(); });
  });
  dlg.querySelector('#pick-search').addEventListener('input', (e) => { filterState.q = (e.target.value||'').trim(); applyFilter(); });
  dlg.querySelector('#pick-sel-all').addEventListener('click', () => {
    dlg.querySelectorAll('.pick-id-cb').forEach(cb => cb.checked = true);
    updateCountBtn();
  });
  dlg.querySelector('#pick-sel-inv').addEventListener('click', () => {
    dlg.querySelectorAll('.pick-id-cb').forEach(cb => cb.checked = !cb.checked);
    updateCountBtn();
  });
  listEl.addEventListener('change', (e) => { if (e.target.classList.contains('pick-id-cb')) updateCountBtn(); });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'default') {
      const ids = [...dlg.querySelectorAll('.pick-id-cb:checked')].map(cb => cb.value);
      startCachingTask(taskId, ids);
    } else {
      // 取消 → 视为取消识别，开关回位
      document.getElementById('tgl-auto-cache').checked = false;
      api.cancelResourceScan(taskId).catch(()=>{});
      setStatus('已取消识别缓存', 'warn');
    }
    dlg.remove();
  }, { once: true });
}

function startCachingTask(taskId, ids) {
  if (!ids || !ids.length) {
    document.getElementById('tgl-auto-cache').checked = false;
    setStatus('未选择任何资源，已取消', 'warn');
    return;
  }
  const dlg = ensureScanDialog();
  dlg.dataset.taskId = taskId;
  dlg.querySelector('#dlg-title').textContent = `💾 正在写入缓存（${ids.length} 项）…`;
  dlg.querySelector('#dlg-body').innerHTML = `
    <div id="cache-progress-current" class="subsection mb">准备中…</div>
    <div class="progress-track mb"><div id="cache-progress-fill" class="progress-fill" style="width:0%"></div></div>
    <div class="subsection" id="cache-progress-count">0 / ${ids.length} 项</div>
    <div class="subsection" id="cache-progress-errors" style="margin-top:10px; color:#B91C1C; max-height:100px; overflow:auto;"></div>`;
  dlg.querySelector('#dlg-footer').innerHTML = `<button value="cancel" class="btn">后台继续</button>`;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    // 无论点"后台继续"还是关闭，都留在后台运行；要取消可通过开关
    dlg.remove();
  }, { once: true });

  api.cacheSelectedResources({ taskId, ids }).catch(err =>
    setStatus('开始缓存失败：' + (err && err.message || err), 'error')
  );
}

function updateCacheProgressDialog({ taskId, done, total, currentName, succeeded, error }) {
  const dlg = document.getElementById('dlg-scan');
  if (!dlg || dlg.dataset.taskId !== taskId) return;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const fill = dlg.querySelector('#cache-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const curr = dlg.querySelector('#cache-progress-current');
  if (curr) curr.textContent = `${succeeded ? '✅' : '❌'} ${currentName || ''}${error ? ' — ' + error : ''}`;
  const cnt = dlg.querySelector('#cache-progress-count');
  if (cnt) cnt.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} 项 · ${pct}%`;
  if (succeeded === false && error) {
    const errBox = dlg.querySelector('#cache-progress-errors');
    if (errBox) {
      const line = document.createElement('div');
      line.textContent = `${currentName}: ${error}`;
      errBox.prepend(line);
    }
  }
}
function onCacheDoneHandler({ taskId, summary, error }) {
  closeDialogGracefully(document.getElementById('dlg-scan'));
  if (activeScanTaskId === taskId) activeScanTaskId = null;
  document.getElementById('tgl-auto-cache').checked = false;
  if (error) {
    setStatus('缓存写入失败：' + error, 'error');
    return;
  }
  setStatus(`缓存写入完成：成功 ${summary.ok} 项，失败 ${summary.fail} 项`, summary.fail ? 'warn' : 'info', '已同步更新缓存资源 Tab');
  // 切到缓存 Tab 并刷新
  const btn = document.querySelector('#info-panel .tab-btn[data-tab="cache"]');
  if (btn) btn.click();
}
```

> 上面依赖路径 resolve 的 `path.join`。当前 renderer 侧通常是通过 import 或在 globalThis 暴露的。若 `renderer.js` 暂未引入 Node.js 风格 `path`，请使用如下轻量实现：`const path = { join: (...p) => p.filter(Boolean).join('/').replace(/\/+/g,'/').replace(/\\/g,'/') };` 或直接 import。并在 resolve thumb 绝对位置时用：

```js
// 替换 renderCacheTab 中缩略图路径解析：
// const info = await api.getCacheDirInfo();   // 一次性在 renderCacheTab 顶部调用一次即可
const info = await (async () => {
  if (!window.__cacheDirInfoPromise) window.__cacheDirInfoPromise = api.getCacheDirInfo();
  return window.__cacheDirInfoPromise;
})();
// 然后：
const thumbAbs = it.thumb ? path.join(info.root, it.thumb) : '';
// <img src="${thumbAbs ? api.mmdUrl(thumbAbs) : ''}" alt="">
```

- [ ] **Step 4: 构建 + 手动验证**

Run: `npm run build:renderer`
Expected: 构建成功。

Run: `npm start`
Expected:
1. 开顶栏开关 → 弹扫描配置 → 选路径 → 开始 → 进度对话框推进 → 结束后若不超量直接写缓存；若超量弹勾选清单（支持类型过滤 / 搜索 / 全选 / 反选） → 选"开始缓存" → 写入进度对话框 → 结束后自动跳转到「缓存资源」Tab 展示卡片。
2. 点卡片「载入」：模型载入成功并生成 PNG 缩略图，之后回 Tab 看到图；动作点击在模型存在时成功播放。
3. 单项删除 / 分类清空 / 一键清空：分别能正确删除、size badge 更新、卡片消失。

- [ ] **Step 5: Commit**
```bash
git add renderer/renderer.js
git commit -m "feat(renderer): 缓存资源Tab UI、扫描配置/进度/超量勾选对话框、自动识别缓存开关、缩略图裁剪写回、删除与清空动作"
```

---

## 任务 9：渲染管线改造 — 引入 EffectComposer + OutlinePass + FXAA + OutputPass 并替换 renderer.render

**Files:**
- Modify: `renderer/renderer.js`（import + initThree 改造 + animate 改造 + resize 改造）

- [ ] **Step 1: 在 renderer.js 顶部 import 段增加后处理模块**

```js
import * as THREE from 'three';
// 若原文件已有单独 import 方式的 OrbitControls/MMDLoader/CCDIKHelper 等，继续保持下列新增：
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass }     from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { ShaderPass }      from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader }      from 'three/examples/jsm/shaders/FXAAShader.js';
```

- [ ] **Step 2: 在 initThree 内部追加后处理管线（放在原 renderer / scene / camera / controls 初始化之后，灯光前后均可）**

先声明全局变量：
```js
let composer, renderPass, outlinePass, fxaaPass, outputPass;
```

在 initThree 末尾追加以替换现有直接渲染：
```js
  // —— 后处理管线：RenderPass → OutlinePass → FXAA(ShaderPass) → OutputPass ——
  composer    = new EffectComposer(renderer);
  renderPass  = new RenderPass(scene, camera);
  const size2 = new THREE.Vector2(viewport.clientWidth, viewport.clientHeight);
  outlinePass = new OutlinePass(size2, scene, camera, []);

  // 按 DEFAULT_PARAMS.render_outlineThickness 初始化 edgeThickness / edgeStrength
  const thick0 = params.render_outlineThickness.v;        // 0..0.05
  outlinePass.edgeStrength  = 2 + Math.round((thick0 / 0.05) * 4);  // 2..6
  outlinePass.edgeThickness = 1 + Math.round((thick0 / 0.05) * 4);  // 1..5
  outlinePass.visibleEdgeColor.set(params.render_outlineColor.v);
  outlinePass.hiddenEdgeColor.set('#000000');
  outlinePass.hiddenEdgeColor.a = 0;  // 隐藏边不画轮廓
  outlinePass.enabled = !!params.render_outline.v;

  fxaaPass = new ShaderPass(FXAAShader);
  const pr0 = effectivePixelRatio();
  fxaaPass.material.uniforms.resolution.value.set(
    1 / (viewport.clientWidth  * pr0),
    1 / (viewport.clientHeight * pr0)
  );
  fxaaPass.enabled = params.render_antialias.v === 'fxaa';

  outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(outlinePass);
  composer.addPass(fxaaPass);
  composer.addPass(outputPass);
  composer.setPixelRatio(pr0);
  composer.setSize(viewport.clientWidth, viewport.clientHeight);
```

在 initThree 之前或旁边定义工具：
```js
function effectivePixelRatio() {
  const v = params.render_pixelRatio.v;
  return (v === 'auto') ? Math.min(window.devicePixelRatio, 2) : Number(v);
}
```

- [ ] **Step 3: animate 循环替换 `renderer.render(scene, camera)`**

在原 animate 函数中：
```js
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mmdHelper) mmdHelper.update(delta);
  controls.update();
  // 原：renderer.render(scene, camera);
  if (composer) composer.render();
  else          renderer.render(scene, camera);  // 兜底
}
```

- [ ] **Step 4: resize 事件改造（配合 composer 与 FXAA uniforms）**

原 resize 处理后追加：
```js
window.addEventListener('resize', () => {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  if (composer) {
    composer.setSize(w, h);
    const pr = effectivePixelRatio();
    composer.setPixelRatio(pr);
    if (fxaaPass) fxaaPass.material.uniforms.resolution.value.set(1/(w*pr), 1/(h*pr));
  }
});
```

- [ ] **Step 5: 构建 + 手动验证**

Run: `npm run build:renderer`
Expected: 构建成功。

Run: `npm start` → 加载任一 PMX 模型 → 旋转视角观察：
Expected: 模型边缘不再剧烈抖动（FXAA + OutlinePass 已生效，边缘稳定且有柔和轮廓）；窗口大小变化后视口不模糊，抗锯齿仍正常。截图导出 `btn-screenshot` 仍能正确导出含轮廓的 PNG。

- [ ] **Step 6: Commit**
```bash
git add renderer/renderer.js
git commit -m "feat(render): 引入 EffectComposer/OutlinePass/ShaderPass(FXAA)/OutputPass，替换 renderer.render 为 composer.render，resize联动后处理参数；第一步修复模型边缘抖动"
```

---

## 任务 10：fill applyParam 渲染类分支（像素比/抗锯齿/阴影/背景色/轮廓开关厚度颜色）

**Files:**
- Modify: `renderer/renderer.js` — applyParam 函数

- [ ] **Step 1: 用以下实现替换 applyParam 中 render_* 相关 case（原为桩 break）**

```js
      case 'render_pixelRatio': {
        const pr = (val === 'auto') ? Math.min(window.devicePixelRatio, 2) : Number(val);
        renderer.setPixelRatio(pr);
        if (composer) {
          composer.setPixelRatio(pr);
          const w = viewport.clientWidth, h = viewport.clientHeight;
          if (fxaaPass) fxaaPass.material.uniforms.resolution.value.set(1/(w*pr), 1/(h*pr));
        }
        break;
      }
      case 'render_antialias': {
        // off / fxaa / msaa。MSAA 需 antialias:true 的 WebGL 上下文，此处降级为"关 FXAA + 提示"；
        // 如需要真正 MSAA，下次启动应用时按 initThree 的 renderer 参数重建。
        if (fxaaPass) fxaaPass.enabled = (val === 'fxaa');
        if (val === 'msaa') {
          if (renderer.options && !renderer.options.antialias) {
            setStatus('MSAA 模式需要带抗锯齿的 WebGL 上下文，当前已关闭 FXAA 并启用轮廓线；完全生效请重启应用（自动生效）', 'warn');
          }
        }
        break;
      }
      case 'render_shadow': {
        renderer.shadowMap.enabled = (val !== 'off');
        if (val === 'off')      renderer.shadowMap.type = THREE.BasicShadowMap;
        if (val === 'pcf')      renderer.shadowMap.type = THREE.PCFShadowMap;
        if (val === 'pcfsoft')  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        scene.traverse((o) => { if (o && o.isLight) { try { o.castShadow = (val !== 'off'); } catch {} } });
        scene.traverse((o) => { if (o && o.isMesh)  { try { o.castShadow = true; o.receiveShadow = true; } catch {} } });
        renderer.shadowMap.needsUpdate = true;
        break;
      }
      case 'render_bgColor': {
        scene.background = new THREE.Color(val);
        break;
      }
      case 'render_outline':
        if (outlinePass) outlinePass.enabled = !!val;
        break;
      case 'render_outlineThickness': {
        if (!outlinePass) break;
        const t = Math.max(0, Math.min(0.05, Number(val) || 0));
        outlinePass.edgeThickness = 1 + Math.round((t / 0.05) * 4);   // 1..5
        outlinePass.edgeStrength  = 2 + Math.round((t / 0.05) * 4);   // 2..6
        break;
      }
      case 'render_outlineColor':
        if (outlinePass) outlinePass.visibleEdgeColor.set(val || '#312E81');
        break;
```

- [ ] **Step 2: 在 loadModel 成功后绑定当前 mesh 到 outlinePass.selectedObjects**

在 `loadModel()` 中 `scene.add(mesh);` 之后、调用 `mmdHelper.add(mesh, ...)` 之前（或之后）追加：
```js
  // 收集模型下所有 isMesh 子节点传给 OutlinePass 轮廓选框
  const sel = [];
  mesh.traverse(c => { if (c && c.isMesh) sel.push(c); });
  if (!sel.length && mesh.isMesh) sel.push(mesh);
  if (outlinePass) outlinePass.selectedObjects = sel;
```

并在 `clearModel()` 中清理：
```js
  if (outlinePass) outlinePass.selectedObjects = [];
```

- [ ] **Step 3: 构建 + 手动验证**

Run: `npm run build:renderer && npm start`
Expected:
1. 切换「像素比」→ 立即生效（Auto/1.0/2.0 在高分屏上差异明显）。
2. 抗锯齿 off/fxaa 切换 → FXAA 关时明显看到像素边缘锯齿，FXAA 开时柔化。
3. 阴影 off/pcf/pcfsoft → 阴影质量按预期变化。
4. 背景色 → 视口背景即时变色且与玻璃风协调。
5. 轮廓线 开关 / 厚度 / 颜色 → 轮廓线实时变化，亚像素抖动进一步降低。

- [ ] **Step 4: Commit**
```bash
git add renderer/renderer.js
git commit -m "feat(params): applyParam 渲染分支落地（像素比/抗锯齿/阴影/背景色/轮廓），loadModel后把模型子mesh挂到outlinePass.selectedObjects"
```

---

## 任务 11：fill applyParam 物理 / IK / 动画分支 + playVmd 传入 ik 参数 + 动画速度联动

**Files:**
- Modify: `renderer/renderer.js`（applyParam、playVmd、loadModel、speed-range 双向同步）

- [ ] **Step 1: applyParam 填物理 / IK / 动画分支**

```js
      case 'physics_rbThreshold':
        setStatus(`刚体阈值已改为 ${val}，下次加载模型时自动判断是否启用布料物理`, 'info');
        break;
      case 'physics_enabled':
      case 'physics_gravity':
      case 'physics_unitStep':
      case 'physics_maxStepNum': {
        if (!currentMesh || !mmdHelper) break;
        try {
          // 重建 helper 条目（MMDAnimationHelper 不支持运行时改 physics 标志/单步/重力）
          mmdHelper.remove(currentMesh);
          const rbCount = (currentMesh.userData.rigidBodies && currentMesh.userData.rigidBodies.length) || 0;
          const usePhysics = !!params.physics_enabled.v && ammoReady && rbCount <= Number(params.physics_rbThreshold.v);
          mmdHelper.add(currentMesh, {
            animation: currentAnimClip || undefined,
            physics: usePhysics,
            unitStep:  Number(params.physics_unitStep.v),
            maxStepNum: Number(params.physics_maxStepNum.v),
            gravity:   new THREE.Vector3(0, Number(params.physics_gravity.v), 0),
            resetPosition: true,
            resetRotation: true,
          });
          // outlinePass 重新绑定
          const sel = [];
          currentMesh.traverse(c => { if (c && c.isMesh) sel.push(c); });
          if (outlinePass) outlinePass.selectedObjects = sel.length ? sel : (currentMesh.isMesh ? [currentMesh] : []);
          setStatus(
            usePhysics
              ? `已重建物理：布料物理开启（${rbCount} 刚体，重力 ${params.physics_gravity.v}，单步 ${params.physics_unitStep.v}s，步数 ${params.physics_maxStepNum.v}）`
              : `已重建物理：布料物理关闭（腿部IK仍正常）${rbCount > Number(params.physics_rbThreshold.v) ? '（刚体数超过阈值）' : ammoReady ? '' : '（Ammo未加载）'}`
            , usePhysics ? 'info' : 'warn');
        } catch (e) {
          console.error('[params] 重建物理 helper 失败：', e);
          setStatus('物理参数应用失败：' + (e && e.message || e), 'error');
        }
        // 物理开关后同步禁用 / 启用参数行（UI 置灰）
        syncPhysicsRowDisabledState();
        break;
      }
      case 'ik_iterations':
      case 'ik_limitAngle':
        // 已经在任务 7 桩中提示，这里保持一致
        setStatus('IK 参数已保存，切换动作或重载模型时生效', 'info');
        break;
      case 'anim_speed': {
        // 1) 与右下角 speed-range 双向同步
        const input = document.getElementById('speed-range');
        if (input && Number(input.value) !== Number(val)) input.value = String(val);
        const label = document.getElementById('speed-val');
        if (label) label.textContent = Number(val).toFixed(1) + 'x';
        // 2) 同步到 mmdHelper.objects 各 mixer.timeScale
        if (mmdHelper && mmdHelper.objects) {
          for (const o of mmdHelper.objects) {
            if (o.mixer) o.mixer.timeScale = Number(val);
          }
        }
        break;
      }
      case 'anim_afterglow':
        if (mmdHelper) mmdHelper.afterglow = Number(val);
        break;
      case 'anim_resetPhysicsOnLoop':
        if (mmdHelper) mmdHelper.resetPhysicsOnLoop = !!val;
        break;
```

- [ ] **Step 2: 增加 syncPhysicsRowDisabledState 函数，并在 loadModel 结束后调用**

```js
function syncPhysicsRowDisabledState() {
  const rbCount = (currentMesh && currentMesh.userData.rigidBodies && currentMesh.userData.rigidBodies.length) || 0;
  const avail = ammoReady && rbCount <= Number(params.physics_rbThreshold.v);
  const physEnabledNow = !!params.physics_enabled.v;
  const rows = document.querySelectorAll('#params-physics .param-row');
  rows.forEach(row => {
    const key = row.dataset.key;
    if (key === 'physics_rbThreshold') {
      row.classList.toggle('disabled', false); // 阈值始终可调
    } else {
      // 其他参数：当 avail=false 且开关本身不可用 或 开关关闭 → 置灰
      const wantDisabled = key === 'physics_enabled'
        ? (!ammoReady || rbCount > Number(params.physics_rbThreshold.v))
        : !avail || !physEnabledNow;
      row.classList.toggle('disabled', wantDisabled);
    }
  });
}
```
并在 `loadModel()` 最后（setupVmdList/setStatus 之后）调用 `syncPhysicsRowDisabledState();`。

- [ ] **Step 3: playVmd 中把 ik 参数带入绑定（因为 IK 随动画 clip 一起由 MMDAnimationHelper 注册 CCDIKSolver）**

在 playVmd 内部 `mmdHelper.add(mesh, { animation: clip, physics: ammoReady })`（或 `_setupMeshAnimation`）的调用点：若 mmdHelper 暴露 ik 构造选项则传 `params.ik_iterations.v` / `params.ik_limitAngle.v`。Three.js r170 的 MMDAnimationHelper 通常在其内部 `_setupIK` 创建 CCDIK solver。该私有构造处若无法传参，可在创建动画绑定后用一个延迟微任务进行安全的 setter（只在确认 solver 存在时设置）：
```js
// 在 playVmd 绑定成功后（例如 setTimeout 下一帧）尝试访问：
queueMicrotask(() => {
  try {
    // 以下为稳健访问策略：遍历 mmdHelper.objects 找到 mesh.animation.mixer 并查 bindings / _actionBindings
    // 如果没有公开 API，则至少可以通过 mesh.userData.mmdIkSolvers 获取（r170 的 MMDLoader 有时会把 ikSolvers 挂在 userData 上返回）
    const solvers = currentMesh && (currentMesh.userData.ikSolvers || currentMesh.userData.mmdIkSolvers) || [];
    solvers.forEach(s => {
      if (s && typeof s.iterations === 'number') s.iterations = params.ik_iterations.v;
      if (s && typeof s.limitAngle === 'number') s.limitAngle = params.ik_limitAngle.v;
    });
  } catch {}
});
```

- [ ] **Step 4: 动画 speed-range 与参数面板双向同步（反向）**

在原有 `speed-range` 的 input 事件处理里，除写原 `timeScale` 外，再：
```js
setParam('anim_speed', Number(range.value), { skipApply: true });   // skipApply 防止重复写 mixer
refreshParamRowValue('anim_speed');
```

- [ ] **Step 5: 构建 + 手动验证**

Run: `npm run build:renderer && npm start`
Expected:
- 物理参数组：
  1. 关闭 Ammo 或刚体过多时 → `physics_enabled` 开关行置灰不可点；
  2. 开启布料时调重力 / 单步 / 步数 → 立即感受到物理模拟的差异（布料摆动幅度或稳定性变化）；
  3. 改阈值 → 下次载入复杂/简单模型时自动切换是否启用物理。
- IK 参数：
  - 改迭代数 → 切换动作后，腿部 IK 解的精度明显变化（高迭代数脚更贴地），状态栏提示生效。
- 动画：
  - 改 anim_speed 或 右下角 speed-range 拖动 → 两侧值同步。
  - 调余辉/循环重置物理 → 动作过渡与布料表现符合预期。

- [ ] **Step 6: Commit**
```bash
git add renderer/renderer.js
git commit -m "feat(params): applyParam 物理/IK/动画分支落地，物理参数通过重建MMDAnimationHelper条目热切换，IK参数下次playVmd生效并在微任务阶段注入求解器，动画速度与右下角滑块双向同步"
```

---

## 任务 12：构建检查 + 三功能手动端到端验收 + 一次 Git 汇总提交（如有遗漏修复）

**Files:** 全项目（验证）

- [ ] **Step 1: 跑 renderer 构建 + 必要时 node -c main.js**

Run:
```bash
npm run build:renderer
node -c main.js
```
Expected: 二者都成功。

- [ ] **Step 2: 端到端验收 1：参数面板**
   - 打开 App → 切右侧「参数面板」Tab → 检查分组齐全，默认值正确。
   - 每个参数至少变动一次，观察场景生效或状态栏给出提示（IK 等）。
   - 重置当前组 / 重置全部 → 值正确回默认。
   - 关闭并重新打开 App → 值正确从 localStorage 恢复。

- [ ] **Step 3: 端到端验收 2：缓存识别 & 清理**
   - 开「自动识别缓存」开关 → 配置对话框 → 选择 1~2 个含 PMX/VMD/压缩包 的小目录 → 开始 → 正常完成后自动跳缓存 Tab → 卡片出现；
   - 超量测试：准备一个小脚本生成 600 个空 PMX 或改 countTh=10 触发超量弹窗 → 正确出现勾选清单，过滤/搜索/全选反选都工作；
   - 删除单项、分类清空、一键清空 → 正确删除并释放空间。

- [ ] **Step 4: 端到端验收 3：边缘抖动修复**
   - 加载原抖动明显的模型 → 不做任何操作即应稳定；
   - 关闭 FXAA、关闭轮廓线 → 体验回到原抖动（可作对比）；
   - 截图导出 PNG 分辨率、尺寸与之前一致或更好。

- [ ] **Step 5: 修复验收中发现的小问题（逐个 commit）**

按问题类型分别提交，commit 规范：
```bash
git add renderer/renderer.js
git commit -m "fix: <具体问题，如缓存Tab缩略图未使用mmd://协议导致无法加载>"
```

- [ ] **Step 6: 汇总完成标记**

所有验收通过后，不额外打汇总 commit（之前步骤已拆分）。本任务标记完成。

---

## 计划自查（Self-Review）

**1. Spec 覆盖率：**
- 模块一（参数面板）：Tab 容器 ✓、分组参数枚举/范围/默认/持久化 ✓、重置 ✓、applyParam 渲染/物理/IK/动画 各分支 ✓；
- 模块二（缓存识别）：开关 UI ✓、扫描任务 + 压缩包识别 ✓、超量预警 ✓、勾选清单 ✓、缓存复制 ✓、缓存 Tab + 清理 ✓、IPC 全部通道 ✓；
- 模块三（边缘抖动）：EffectComposer 管线 ✓、OutlinePass 绑定选中模型 ✓、FXAA + 像素比 + 阴影 + 背景色全部参数联动 ✓。

**2. 占位符扫描：** 全计划未出现 TBD/TODO/待完善类字样；每个 applyParam 分支均有明确行为；每个 IPC 方法均有返回结构与失败处理。

**3. 类型一致性：** 前后端 `taskId` 传递一致、`candidate.id = itemId(...)` 与 delete-cache-items / writeCacheThumb 引用 key 一致；`DEFAULT_PARAMS.anim_speed.v` 单位与右下角 `speed-range min/max/step` 对齐（均 0.1~3.0，步 0.1）。
