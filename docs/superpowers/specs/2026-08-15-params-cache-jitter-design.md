# 参数面板 + 资源缓存识别 + 边缘抖动修复 设计文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans 基于本 spec 生成实现计划后，再用 superpowers:subagent-driven-development 或 superpowers:executing-plans 按计划落地。

**目标：**
1. 将 UI 升级为「工程化方案三」——在右侧信息栏新增「参数面板」Tab，集中调节渲染/物理/IK/动画四类参数并持久化。
2. 新增模型与动作文件自动识别功能开关（含压缩包不解压识别），打开开关后后台扫描并将资源复制缓存到用户数据目录，提供独立「缓存资源」Tab 展示与单项/分类/全量清理。
3. 修复模型预览时边缘异常抖动，通过 EffectComposer + OutlinePass + FXAA 后处理管线稳定轮廓线并消除亚像素闪烁。

**架构：**
- **渲染进程**：`renderer/renderer.js` 负责 UI（三 Tab 切换、参数控件、缓存列表）、参数持久化（localStorage）、与 Three.js 后处理管线的交互；
- **主进程**：`main.js` 负责缓存目录定位（`app.getPath('userData')/cache`）、资源后台扫描（含压缩包内部条目识别）、IPC 事件推送进度/结果、缓存文件的增删；
- **Preload**：`preload.js` 暴露资源扫描、缓存索引读写、清理等 API 给渲染进程；
- **Three.js 管线**：引入 `EffectComposer`（RenderPass → OutlinePass → FXAA ShaderPass → OutputPass）替换原 `renderer.render` 直出；同时 MMDAnimationHelper / MMDPhysics / CCDIK 链路保持不变。

**技术栈：** Electron 主进程 + preload + 渲染进程（原生 DOM + esbuild 打包）；Three.js r170 + EffectComposer/OutlinePass/FXAAShader 后处理；缓存使用 `fs` 复制文件 + `index.json` 作为索引清单（JSON 足够轻量，无需 SQLite）。

---

## 模块一：右侧 Tab 式参数面板

### 1.1 布局改造

**文件改动：**
- 修改：`renderer/index.html:L127-L132`（将 `#info-panel` 改造为 Tab 容器）
- 修改：`renderer/styles.css`（新增 Tab 头、Tab 内容区、参数组 Section、控件样式）
- 修改：`renderer/renderer.js`（Tab 切换逻辑 + 参数控件渲染 + 读/写 localStorage + 参数应用到 Three.js 场景）

**HTML 结构：**
```html
<aside id="info-panel">
  <div class="tab-bar" role="tablist">
    <button class="tab-btn active" data-tab="info" role="tab">模型信息</button>
    <button class="tab-btn"        data-tab="params" role="tab">参数面板</button>
    <button class="tab-btn"        data-tab="cache"  role="tab">缓存资源</button>
  </div>
  <div class="tab-content" data-view="info">
    <div class="panel-title">模型信息</div>
    <div id="model-info" class="model-info">…（保留原内容）…</div>
  </div>
  <div class="tab-content hidden" data-view="params">
    <div class="panel-title">参数面板</div>
    <div id="params-render"  class="param-group"></div>
    <div id="params-physics" class="param-group"></div>
    <div id="params-ik"      class="param-group"></div>
    <div id="params-anim"    class="param-group"></div>
    <div class="param-actions">
      <button id="btn-reset-group" class="btn btn-small">重置当前组</button>
      <button id="btn-reset-all"   class="btn btn-small">重置全部</button>
    </div>
  </div>
  <div class="tab-content hidden" data-view="cache">
    <div class="panel-title">
      缓存资源
      <span id="cache-size" class="badge-muted">…</span>
    </div>
    <div class="cache-toolbar">
      <input id="cache-filter" class="filter-input" placeholder="搜索名称…" />
      <div class="segmented">
        <button class="seg active" data-cache-type="all">全部</button>
        <button class="seg"        data-cache-type="models">🧊 模型</button>
        <button class="seg"        data-cache-type="motions">🎬 动作</button>
      </div>
      <button id="btn-clear-model-cache"  class="btn btn-small">清空模型缓存</button>
      <button id="btn-clear-motion-cache" class="btn btn-small">清空动作缓存</button>
      <button id="btn-clear-all-cache"    class="btn btn-small btn-danger">一键清空</button>
    </div>
    <div id="cache-grid" class="cache-grid"></div>
  </div>
</aside>
```

### 1.2 参数分组与默认值

所有参数均受 **运行时 + 持久化** 双层约束：启动时读 `localStorage['mmd.params.v1']`（缺省用 DEFAULT_PARAMS）；控件值改变时立即 `applyParam(key, value)` 并写回 localStorage。

```js
// renderer/renderer.js 顶部新增
const DEFAULT_PARAMS = {
  // 渲染
  render_pixelRatio:       { v: 'auto', type: 'enum',  opts: ['1.0','1.25','1.5','2.0','auto'] },
  render_antialias:        { v: 'fxaa', type: 'enum',  opts: ['off','fxaa','msaa'] },
  render_shadow:           { v: 'pcfsoft', type:'enum',opts: ['off','pcf','pcfsoft'] },
  render_bgColor:          { v: '#F7F8FB', type: 'color' },
  render_outline:          { v: true,    type: 'bool' },
  render_outlineThickness: { v: 0.01,    type: 'number', min:0,    max:0.05, step:0.001 },
  render_outlineColor:     { v: '#312E81',type: 'color' },

  // 物理
  physics_enabled:         { v: true,    type: 'bool' },   // UI 若 rbCount > 阈值则自动置灰
  physics_gravity:         { v: -98,     type: 'number', min:-200, max:0,    step:1 },
  physics_unitStep:        { v: 1/60,    type: 'enum',  opts: [1/120,1/60,1/30], labels:['1/120','1/60','1/30'] },
  physics_maxStepNum:      { v: 2,       type: 'number', min:1,    max:5,    step:1 },
  physics_rbThreshold:     { v: 200,     type: 'number', min:50,   max:1000, step:10 },

  // IK
  ik_iterations:           { v: 50,      type: 'number', min:10,   max:200,  step:5 },
  ik_limitAngle:           { v: 0.01,    type: 'number', min:0.001,max:0.1,  step:0.001 },

  // 动画
  anim_speed:              { v: 1.0,     type: 'number', min:0.1,  max:3.0,  step:0.1 },
  anim_afterglow:          { v: 0.1,     type: 'number', min:0,    max:0.5,  step:0.01 },
  anim_resetPhysicsOnLoop: { v: true,    type: 'bool' },
};
```

**参数控件类型：**
- `enum`：`<select>`；
- `bool`：`<label class="switch"><input type="checkbox">…`；
- `number`：`<input type="range">` + 右侧 `<span class="num-val">` 显示当前值；
- `color`：`<input type="color">` + 色值文本。

### 1.3 参数应用回调（applyParam）

```
render_pixelRatio          → renderer.setPixelRatio(ratio==='auto'?min(DPR,2):Number(ratio)); composer.setPixelRatio(同);
render_antialias           → 重建 renderer（msaa 为新 canvas 开 antialias:true） 或 开关 FXAA ShaderPass 的 enabled；
render_shadow              → renderer.shadowMap.enabled = (sh!=='off'); renderer.shadowMap.type = THREE.PCFShadowMap / PCFSoftShadowMap; 灯光.castShadow 重新同步；
render_bgColor             → scene.background = new THREE.Color(bg); 与玻璃风 UI 保持一致；
render_outline             → outlinePass.enabled = v;
render_outlineThickness    → outlinePass.edgeThickness = v;
render_outlineColor        → outlinePass.visibleEdgeColor.set(v); outlinePass.hiddenEdgeColor.set(v);
physics_enabled            → 如已有模型：mmdHelper.objects 中对 mesh 的 physics 开关做热切换（优先 remove+add 重建 helper 条目，因为 MMDAnimationHelper 不支持运行时改 physics 标志）；
physics_gravity            → 同上，热切换 helper 条目；
physics_unitStep/maxStepNum → 同上；
physics_rbThreshold        → 仅下次加载模型时读取，展示提示；
ik_iterations              → 写入参数存储；下次 playVmd 创建动画绑定的 CCDIKSolver 或下一次 loadModel 重建 helper 时生效（MMDAnimationHelper 不公开运行时改 IK 求解器属性，避免热调私有字段产生不稳定解）；
ik_limitAngle              → 同上，下次 playVmd / loadModel 时生效；
anim_speed                 → 与右下角 speed-range 联动，双向同步；mmdHelper.objects 每条 mixer.timeScale = v；
anim_afterglow             → mmdHelper.afterglow = v；
anim_resetPhysicsOnLoop    → mmdHelper.resetPhysicsOnLoop = v；
```

**注意**：运行时切参数后，若涉及 composer 的尺寸/像素比，也要调用 `composer.setSize(width,height)` 与 `FXAAShader.uniforms.resolution.set(1/width,1/height)`。

### 1.4 持久化与重置

- 加载：`params = Object.assign({}, DEFAULT_PARAMS, JSON.parse(localStorage['mmd.params.v1']||'{}'))`，对不存在字段自动补默认值。
- 单组重置：遍历 `render_*` / `physics_*` / `ik_*` / `anim_*` 把 `v` 回 DEFAULT，再 `applyParam` + 写 localStorage + 刷新控件显示。
- 全局重置：`localStorage.removeItem('mmd.params.v1')`，重新按 DEFAULT 初始化。

---

## 模块二：模型/动作自动识别与缓存

### 2.1 缓存目录与结构

**物理目录（由主进程提供路径）：**
```
主进程：path.join(app.getPath('userData'), 'cache')
   例（Windows）：C:\Users\刘萧\AppData\Roaming\MMDModelViewer\cache
```

**子目录：**
```
cache/
├─ models/          复制的 .pmx/.pmd 及其贴图目录（保持原相对结构）
├─ motions/         复制的 .vmd/.vpd
├─ thumbs/          模型缩略图 PNG（id=hash(cachePath)）
├─ tmp/             扫描压缩包时临时解压目录，任务结束后清空
└─ index.json       缓存资源索引
```

**index.json 结构：**
```json
{
  "version": 1,
  "items": [
    {
      "id":         "m_7a9f3c…",
      "type":       "model" | "motion",
      "name":       "少女_by_原神.pmx",
      "ext":        ".pmx",
      "cachePath":  "cache/models/abc/少女_by_原神.pmx",
      "cacheSize":  1234567,
      "sourcePath": "D:\\素材\\3D模型\\原神\\少女_by_原神_e2e51225eab45b4af102c499df74a063.zip",
      "sourceType": "file" | "archive",
      "archiveEntry": "少女_by_原神.pmx",   // 仅当 sourceType=archive
      "addedAt":    1760550000000,
      "thumb":      "thumbs/m_7a9f3c.png"  // 仅模型
    }
  ]
}
```

### 2.2 主开关 UI + 扫描流程

**UI 入口（顶部工具栏，`#toolbar`）：**
```html
<label class="switch" title="自动识别模型与动作资源并缓存">
  <input id="tgl-auto-cache" type="checkbox">
  <span>⚙ 自动识别缓存</span>
</label>
```
开关打开时弹出「扫描配置」对话框：
- 扫描范围：☑ 模型库根目录（可改路径） / ☑ 动作库根目录（可改路径） / ☑ 进入压缩包识别内部资源
- 超量预警阈值：默认 ☑ 当 ≥ 500 项 或 ≥ 500MB 时先让用户勾选

**扫描与缓存两步走（IPC）：**

1. **start-resource-scan(params)** → 返回 `{ taskId }`
   - 主进程异步遍历：
     - `scanDir(rootPath)`：对每个普通文件 `fs.stat` 判断扩展，收集入 candidates；
     - 压缩包：调用现有 `listArchiveContents(archivePath)` 不解压列举条目，对匹配 `\.(pmx|pmd|vmd|vpd)$/i` 的条目作为候选并标 `sourceType=archive`；
   - 进度通过事件回推：`scan-progress { taskId, done, total, currentDir }`；
   - 结束回 `scan-done { taskId, candidates:[{id,name,ext,sourcePath,sourceType,archiveEntry?,sizeEstimate}], totalCount, totalSize }`。

2. **超量检查（渲染进程判断）：**
   - 若 `totalCount>=500 || totalSize>=500*1024*1024` → 弹出勾选清单对话框（按类型过滤 + 全选/反选）；
   - 用户确认后调 `cache-selected-resources(taskId, selectedIds)`。

3. **cache-selected-resources(taskId, selectedIds)** → 逐文件/条目复制：
   - `sourceType=file` → `fs.copyFile(sourcePath, cache/[type]/[safeName])`；若 PMX 同级有贴图目录（扫描时顺便识别常见相对路径：`textures/` `tex/`），一并复制；
   - `sourceType=archive` → 调用现有 `handleArchive` 内 `extractArchive` 临时解压到 `cache/tmp/<taskId>/<entry>` → `fs.copyFile` 复制进 `cache/models|motions/` → 最后 `fs.rm(tmp)`；
   - 进度事件：`cache-progress { taskId, done, total, currentName, succeeded }`；
   - 全部结束：`cache-done { taskId, summary:{ok,fail}, indexVersion }`，并由主进程重写 `index.json`。

4. **cancel-resource-scan(taskId)** → 中止未完成的扫描或缓存阶段，不回滚已写入项（保留并进索引）。

### 2.3 缓存展示 Tab

- 顶部：搜索框 + 分段过滤（全部/模型/动作） + 三种清空按钮；
- 网格：卡片缩略图 + 名称 + 类型徽章 + 大小 + `载入` 按钮 + `删除` 按钮；
- 缩略图生成时机：首次点击「缓存资源」Tab 且该卡片 `thumb` 为空时，后台对该模型做一次缩略渲染：在独立离屏 renderer / 或切模型到 viewport 渲染一帧后 `toDataURL` 裁剪保存为 PNG，之后写回 index.json；动作项不生成缩略图（用 VMD 图标占位）。
- `载入`：点击卡片 → 对模型调用 `loadModel({path: absCachePath, ...})`，对动作调用 `playVmd(absCachePath, currentMesh)`。
- `删除`：
  - 单项 → `delete-cache-items([id])` → 主进程 `fs.unlink(cachePath)` 并同步删 thumb（若有）+ 移除 index 条目；
  - 清空模型缓存 / 清空动作缓存 → `clear-cache('models'|'motions')`；
  - 一键清空 → `clear-cache('all')`，删 models + motions + thumbs + index.json。

### 2.4 IPC 清单（主进程 + preload）

**main.js 新增：**
```js
ipcMain.handle('get-cache-dir-info', async () => ({
  root:     path.join(app.getPath('userData'), 'cache'),
  models:   path.join(app.getPath('userData'), 'cache', 'models'),
  motions:  path.join(app.getPath('userData'), 'cache', 'motions'),
  thumbs:   path.join(app.getPath('userData'), 'cache', 'thumbs'),
  tmp:      path.join(app.getPath('userData'), 'cache', 'tmp'),
  totalSize: await calcDirSize(cacheRoot),
}));
ipcMain.handle('start-resource-scan',          async (e, params) => { /* …返回 taskId 并异步推事件 */ });
ipcMain.handle('cancel-resource-scan',         async (e, taskId) => { /* 置 abort 标志 */ });
ipcMain.handle('cache-selected-resources',     async (e, { taskId, ids }) => { /* 执行复制 */ });
ipcMain.handle('get-cache-index',              async () => readIndex());
ipcMain.handle('delete-cache-items',           async (e, ids) => { /* 删磁盘+index，返回结果 */ });
ipcMain.handle('clear-cache',                  async (e, scope) => { /* scope: models/motions/all */ });
ipcMain.handle('write-cache-thumb',            async (e, { id, base64Png }) => { /* 存 thumbs/<id>.png 并更新 index */ });
```

**事件通道（主→渲染）：** 通过 `webContents.send('scan-progress' | 'scan-done' | 'cache-progress' | 'cache-done')`，preload 端用 `ipcRenderer.on(...)` 暴露 `api.onScanProgress(cb)` / `api.onScanDone(cb)` 等回调注册函数。

**preload.js 新增：**
```js
getCacheDirInfo:            () => ipcRenderer.invoke('get-cache-dir-info'),
startResourceScan:          (params) => ipcRenderer.invoke('start-resource-scan', params),
cancelResourceScan:         (taskId) => ipcRenderer.invoke('cancel-resource-scan', taskId),
cacheSelectedResources:     (payload) => ipcRenderer.invoke('cache-selected-resources', payload),
getCacheIndex:              () => ipcRenderer.invoke('get-cache-index'),
deleteCacheItems:           (ids) => ipcRenderer.invoke('delete-cache-items', ids),
clearCache:                 (scope) => ipcRenderer.invoke('clear-cache', scope),
writeCacheThumb:            (p) => ipcRenderer.invoke('write-cache-thumb', p),
onScanProgress:             (cb) => ipcRenderer.on('scan-progress', (_e, p) => cb(p)),
onScanDone:                 (cb) => ipcRenderer.on('scan-done',     (_e, p) => cb(p)),
onCacheProgress:            (cb) => ipcRenderer.on('cache-progress',(_e, p) => cb(p)),
onCacheDone:                (cb) => ipcRenderer.on('cache-done',    (_e, p) => cb(p)),
```

---

## 模块三：边缘异常抖动修复（EffectComposer 后处理）

### 3.1 引入后处理管线

**文件：** `renderer/renderer.js`（import + 初始化 + 替换渲染循环）；`package.json` 无需新依赖，使用 `three/examples/jsm/postprocessing/*` 内的模块即可。

**import：**
```js
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass }     from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { ShaderPass }      from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader }      from 'three/examples/jsm/shaders/FXAAShader.js';
```

### 3.2 初始化（initThree 改造）

```js
let composer, renderPass, outlinePass, fxaaPass, outputPass;
function initThree() {
  // …原 canvas/renderer/scene/camera/controls/灯光 保持不变…
  // 注意：若 render_antialias === 'msaa' 则 canvas: { antialias:true }；否则 false（省 GPU，交给 FXAA）

  // === 后处理管线 ===
  composer    = new EffectComposer(renderer);
  renderPass  = new RenderPass(scene, camera);
  const v2Size = new THREE.Vector2(viewport.clientWidth, viewport.clientHeight);
  outlinePass = new OutlinePass(v2Size, scene, camera, /*selectedObjects*/[]);
  outlinePass.edgeStrength  = 3;           // 与面板的"厚度"联动：UI 显示的 thickness→映射这里强度+隐藏/可见边颜色
  outlinePass.edgeThickness = 1;
  outlinePass.visibleEdgeColor.set(params.render_outlineColor.v);
  outlinePass.hiddenEdgeColor.set('#00000000');
  outlinePass.enabled = params.render_outline.v;

  fxaaPass    = new ShaderPass(FXAAShader);
  const pr = params.render_pixelRatio.v === 'auto'
    ? Math.min(window.devicePixelRatio, 2)
    : Number(params.render_pixelRatio.v);
  fxaaPass.material.uniforms.resolution.value.set(
    1 / (viewport.clientWidth  * pr),
    1 / (viewport.clientHeight * pr)
  );
  fxaaPass.enabled = params.render_antialias.v === 'fxaa';

  outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(outlinePass);
  composer.addPass(fxaaPass);
  composer.addPass(outputPass);
  composer.setPixelRatio(pr);
  composer.setSize(viewport.clientWidth, viewport.clientHeight);
}
```

### 3.3 outlinePass.selectedObjects 绑定

- 在 `loadModel()` 成功后：`outlinePass.selectedObjects = [mesh];`（也可以遍历 mesh 内所有子 mesh：`const sel=[]; mesh.traverse(c=>c.isMesh&&sel.push(c)); outlinePass.selectedObjects=sel;`）。
- 在 `clearModel()`：`outlinePass.selectedObjects = [];`。

### 3.4 animate 循环改造

```js
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mmdHelper) mmdHelper.update(delta);
  controls.update();
  // 替换原 renderer.render(scene, camera)：
  composer.render();
}
```

### 3.5 resize 事件

```js
window.addEventListener('resize', () => {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);       // false：不触发样式改尺寸，只设后备缓冲区
  composer.setSize(w, h);
  const pr = effectivePixelRatio();    // 按 params.render_pixelRatio 计算
  composer.setPixelRatio(pr);
  fxaaPass.material.uniforms.resolution.value.set(1/(w*pr), 1/(h*pr));
});
```

### 3.6 applyParam 联动（关键）

```js
function applyParam(k, v) {
  switch (k) {
    case 'render_pixelRatio': {
      const pr = v === 'auto' ? Math.min(window.devicePixelRatio, 2) : Number(v);
      renderer.setPixelRatio(pr);
      composer.setPixelRatio(pr);
      const w = viewport.clientWidth, h = viewport.clientHeight;
      fxaaPass.material.uniforms.resolution.value.set(1/(w*pr), 1/(h*pr));
      break;
    }
    case 'render_antialias': {
      // off/fxaa/msaa。MSAA 需要新开 WebGLRenderer(antialias:true)；简单做法：
      // fxaaPass.enabled = (v === 'fxaa');
      // MSAA 与 FXAA 互斥：若 v==='msaa' 先关 fxaaPass，再提示"下帧起生效"或做一次性 renderer 重建
      fxaaPass.enabled = (v === 'fxaa');
      if (v === 'msaa' && !renderer.options.antialias) {
        setStatus('MSAA 模式需重建 WebGL 上下文，请重启应用以完全生效（当前 FXAA 已关闭，轮廓线可减轻抖动）', 'warn');
      }
      break;
    }
    case 'render_shadow': {
      renderer.shadowMap.enabled = (v !== 'off');
      if (v === 'pcf')      renderer.shadowMap.type = THREE.PCFShadowMap;
      if (v === 'pcfsoft')  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // 若关阴影，则把所有 castShadow=true 的灯光先记录再关闭；重新开启时恢复
      scene.traverse(o => { if (o.isLight) o.castShadow = (v !== 'off'); });
      break;
    }
    case 'render_bgColor': {
      scene.background = new THREE.Color(v);
      break;
    }
    case 'render_outline':
      outlinePass.enabled = v; break;
    case 'render_outlineThickness':
      // thickness (0~0.05) 线性映射到 outlinePass.edgeThickness (1~5) + edgeStrength
      outlinePass.edgeThickness = 1 + Math.round(v / 0.05 * 4);     // 1..5
      outlinePass.edgeStrength  = 2 + v / 0.05 * 4;                  // 2..6
      break;
    case 'render_outlineColor':
      outlinePass.visibleEdgeColor.set(v); break;
    case 'physics_enabled':
    case 'physics_gravity':
    case 'physics_unitStep':
    case 'physics_maxStepNum': {
      // 重建当前 mesh 的 helper 条目
      if (currentMesh && mmdHelper) {
        mmdHelper.remove(currentMesh);
        const rbCount = currentMesh.userData.rigidBodies?.length || 0;
        const usePhysics = params.physics_enabled.v && ammoReady && rbCount <= params.physics_rbThreshold.v;
        mmdHelper.add(currentMesh, {
          animation: currentAnimClip || undefined,
          physics: usePhysics,
          unitStep:  Number(params.physics_unitStep.v),
          maxStepNum: params.physics_maxStepNum.v,
          gravity:   new THREE.Vector3(0, params.physics_gravity.v, 0),
          resetPosition: true,
          resetRotation: true,
        });
        outlinePass.selectedObjects = collectMeshes(currentMesh);
      }
      break;
    }
    case 'ik_iterations':
    case 'ik_limitAngle': {
      // MMDAnimationHelper 的 CCDIKSolver 以私有字段挂载在其内部绑定结构上。
      // 为避免热调内部字段带来不稳定解（反复迭代出错），这里仅写参数存储。
      // 真正生效时机：下一次 playVmd（将 ik 配置带入 CCDIKSolver 构造选项）或下一次 loadModel。
      // playVmd 中读取 params.ik_iterations.v / params.ik_limitAngle.v 并传给内部 helper API。
      setStatus('IK 参数已保存，切换动作或重载模型时生效', 'info');
      break;
    }
    case 'anim_speed': {
      if (mmdHelper) {
        for (const o of mmdHelper.objects) {
          if (o.mixer) o.mixer.timeScale = v;
        }
      }
      syncAnimSpeedUI(v);
      break;
    }
    case 'anim_afterglow':
      if (mmdHelper) mmdHelper.afterglow = v; break;
    case 'anim_resetPhysicsOnLoop':
      if (mmdHelper) mmdHelper.resetPhysicsOnLoop = v; break;
  }
}
```

### 3.7 截图导出兼容

原 `btn-screenshot` 走 `renderer.domElement.toDataURL('image/png')`，因 composer 最终绘制到同一 canvas 上，逻辑不变。若未来用独立 RenderTarget，需改 `composer.readRenderTargetPixels` + Canvas 绘出。

---

## 非目标 / 边界

1. 缓存模块不引入 SQLite、不生成 WebP（JPEG/PNG + 手写 JSON 索引够快够简单）；
2. 预设保存（Preset JSON 导入导出）与 A/B 分屏对比 **不做**，留给「极致工程化方案三」；
3. 超量阈值默认 500 项 / 500MB，可在扫描配置对话框改，但当前版本不在参数面板中暴露阈值持久化；
4. 动作用户不生成缩略图（避免动效截屏需要额外的渲染循环分离逻辑）；
5. MSAA 模式运行时不重建 WebGL 上下文（给出提示「重启生效」/降级 FXAA）。

---

## 错误处理与提示

- 扫描失败：`scan-done` 事件带 `error` 字段 → 右侧「缓存资源」顶部红色 alert 条显示；
- 缓存复制失败：`cache-progress` 对单条标 `succeeded:false` 并附带 message → 卡片展示失败图标；
- 磁盘空间不足：在复制前 `fs.stat(cacheRoot所在盘)`，估算剩余空间 → 不足时弹确认；
- 模型无刚体 / Ammo 未加载：`physics_enabled` 开关自动置灰 + 工具提示解释；
- 抗锯齿与后处理：当 `render_antialias==='off'` 且 `render_outline===false` 时，OutlinePass/FXAAShaderPass 可 `enabled=false` 降低 GPU 占用。

---

## 测试要点（手动验证清单）

1. **参数面板**：
   - 切换 Tab 无闪烁；
   - 调每一个控件 → 场景立即生效（像素比 / 抗锯齿等级 / 阴影 / 背景色 / 轮廓开关厚度颜色 / 物理开关 / 动画速度 等）；
   - 点「重置当前组」「重置全部」后控件值与实际渲染正确回到默认；
   - 关闭再打开应用，参数持久化被恢复。
2. **缓存识别**：
   - 开关开启 → 能扫描出 PMX/PMD/VMD/VPD 与压缩包内部条目；
   - 超阈值弹窗勾选 → 仅勾选项复制进缓存；
   - 缓存 Tab 按「全部/模型/动作」正确过滤；单项删除 / 分类清空 / 一键清空能同步删磁盘；
   - 动作项点击能在当前模型上播放 VMD；模型项点击能载入。
3. **边缘抖动**：
   - 打开任意模型后旋转视角：原硬边在 FXAA + OutlinePass 下保持稳定、不闪烁；
   - 关闭 FXAA / 关轮廓 → 回到原直出效果（可对比抖动差异）；
   - 截图导出图像与视口一致（含轮廓、含抗锯齿结果）。

---

## 文件影响总览

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `renderer/index.html` | 修改 | 顶栏加 `#tgl-auto-cache` 开关；右栏改 Tab 结构（info/params/cache） |
| `renderer/styles.css` | 修改 | Tab/参数组/开关/分段控件/缓存网格卡片等样式；延续浅色玻璃风 & Indigo 主色 |
| `renderer/renderer.js` | 修改 | Tab 切换、参数系统、applyParam 回调、持久化、后处理管线初始化+循环、缓存 UI 渲染、缩略图写回、IPC 事件订阅 |
| `main.js` | 修改 | 新增 8 个 IPC handle + 4 个事件通道；提供 `cache/*` 目录定位；扫描/缓存两阶段异步实现（文件遍历 + 压缩包 listArchiveContents + 临时解压 + 复制）；维护 index.json |
| `preload.js` | 修改 | 新增 `mmdAPI` 方法：getCacheDirInfo / startResourceScan / cancelResourceScan / cacheSelectedResources / getCacheIndex / deleteCacheItems / clearCache / writeCacheThumb / onScanProgress / onScanDone / onCacheProgress / onCacheDone |
| `package.json` | 修改（可选） | 若需新增依赖则写 devDependencies；当前方案用 three 内置 postprocessing，故可不改 |
