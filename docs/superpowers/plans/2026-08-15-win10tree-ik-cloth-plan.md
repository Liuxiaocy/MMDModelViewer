# MMDModelViewer Win10列表 + IK修复 + 布料物理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同时交付三项增强：(1) 文件树切换至 Windows 10 小图标列表视觉；(2) 腿部 CCDIK 反解，修复 VMD 只记录足先时大腿/小腿停在 bind pose 的问题；(3) MMDPhysics (ammo.js) 集成，提供裙摆/头发等布料刚体+弹簧效果。

**Architecture:** 以 `MMDAnimationHelper` 为统一核心接管 AnimationMixer + CCDIKHelper + MMDPhysics。渲染循环改为单一 `helper.update(delta*speed)`，内部顺序保证「动画 → IK → 骨骼世界同步 → 物理解算 → 骨骼世界回写 → 蒙皮矩阵」。文件树 DOM 由嵌套 `.tree-item/.tree-children` 改为扁平 `.win10-row` grid 三列结构（缩进 icon-group | name | size）。ammo 在 init() 顶部通过动态 import 预加载，失败时降级布料保持腿部仍可用。

**Tech Stack:** Electron 14 / Node 20 / Three.js r170 (MMDLoader + MMDAnimationHelper + CCDIKHelper + MMDPhysics 四个 examples 模块) / ammo.js (kripken wasm, via three/examples/jsm/libs) / esbuild 0.28 / Win10 视觉 CSS 令牌。

---

## File Structure (Scope Check)

本改动覆盖三个可独立工作的子系统。考虑到它们共享同一个 renderer.js 单文件（原项目结构），不拆分独立计划文件，而是拆 Task A/B/C。每个 Task 结束后都可运行 `npm run build:renderer && npm start` 独立验证。

| # | File | Action | Responsibility |
|---|---|---|---|
| 1 | `package.json` | Modify devDependencies | 追加 `ammo.js` 依赖；修改 build.asarUnpack 追加 ammo.wasm 路径 |
| 2 | `renderer/renderer.js` | Modify | 全部逻辑变更：新增 MMDAnimationHelper import、ammoReady 状态、initAmmo()、helper 驱动 loadModel/playVmd/animate/clearModel、Win10 扁平文件树 render/append/toggle/expand/clearSelection/setSelectedByPath + 播放控件改造 |
| 3 | `renderer/styles.css` | Modify (append rules) | 新增 .win10-* 样式令牌 + 覆盖 .tree-children 旧 border/margin |

---

### Task A: 安装 ammo.js 依赖 + 更新 package.json 打包配置

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 ammo.js 到 devDependencies**

```powershell
# PowerShell
cd "d:\Program Files\code\MMDModelViewer"
npm install --save-dev ammo.js
```

Expected: `added 2 packages, and audited ...` ；package-lock.json 同步更新

- [ ] **Step 2: 更新 asarUnpack（打包隔离风险兜底）**

打开 `package.json` 第 35-37 行，修改：

```json
    "asarUnpack": [
      "node_modules/7zip-bin/**",
      "node_modules/three/examples/jsm/libs/ammo.wasm.wasm",
      "node_modules/three/examples/jsm/libs/ammo.wasm.js"
    ],
```

- [ ] **Step 3: 快速验证依赖存在**

```powershell
Test-Path "node_modules/three/examples/jsm/libs/ammo.wasm.js" ; Test-Path "node_modules/ammo.js/package.json"
```

Expected: 两行都返回 `True`

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): 安装 ammo.js 并在 asarUnpack 中放行 three ammo wasm"
```

---

### Task B: 文件树 → Win10 列表（扁平 .win10-row grid 三列）

**Files:**
- Modify: `renderer/styles.css` — 追加 CSS
- Modify: `renderer/renderer.js:427-513` — 替换目录树渲染与导航辅助函数

**Subtask B-1: 写 styles.css 追加令牌**

- [ ] **Step 1: 末尾追加 Win10 列表 CSS**

在 `renderer/styles.css` 文件**末尾**追加以下内容（不删原有规则，依靠层叠覆盖 `.tree-children` 的旧 border/margin）：

```css
/* ====== Win10 列表风格（覆盖旧 .tree-item 嵌套） ====== */
#file-tree { padding: 0; }
#file-tree > .tree-item,
.tree-children { margin-left: 0 !important; padding-left: 0 !important; border-left: none !important; }
#file-tree > .tree-item,
.tree-item { background: none; border: none; margin: 0; padding: 0; }
#file-tree > .tree-item > .twisty,
.tree-item > .twisty { display: none; }
.tree-item > .name,
.tree-item > .badge { display: none; }
.tree-children.collapsed { display: block; }   /* 折叠现在用 .collapsed-descendant */

/* Win10 行容器（file-tree 的直接 children） */
.win10-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  height: 22px;
  line-height: 22px;
  cursor: pointer;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
  font-size: 12px;
  color: #1C1C1C;
  user-select: none;
}
.win10-row:hover { background: #E5F3FF; }
.win10-row.selected { background: #CCE8FF; }
.win10-row.collapsed-descendant { display: none; }

/* 缩进 + twisty + 图标 的 group */
.w10-icongrp { display: flex; align-items: center; min-width: 0; }
.w10-twisty {
  width: 14px; text-align: center; color: #767676; font-size: 10px; flex-shrink: 0;
  line-height: 1;
}
.w10-twisty:empty { display: inline-block; width: 14px; }
.w10-icon { width: 18px; text-align: center; font-size: 13px; flex-shrink: 0; }

.w10-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  padding-right: 2px;
}
.w10-size {
  width: 64px; text-align: right; font-size: 11px; color: #666;
  padding-right: 4px; min-width: 0;
}
```

**Subtask B-2: renderer.js 替换目录树 6 个函数 + 新增 appendWin10Row + setSelectedByPath**

- [ ] **Step 2: 在 renderer.js 顶部 `// ---------- DOM ----------` 之后的状态区，加一个辅助 WeakMap**

在第 60 行附近（`let recentItems = [];` 之后）追加：

```js
// Win10 扁平文件树辅助：dir 行的 path -> Set(所有后代 rows 的引用)
const dirDescendants = new Map();  // key: dirPath(normalized) -> Set<HTMLElement>
```

- [ ] **Step 3: 替换 `renderTree(root)` (L428-440) 为扁平实现**

把 `function renderTree(root) {...}` 整个替换为：

```js
// ---------- 目录树 (Win10 列表扁平 grid) ----------
function renderTree(root) {
  fileTreeEl.innerHTML = '';
  dirDescendants.clear();
  // 根节点本身也要一行（Win10 风格）
  appendWin10Row(root, 0, true);
  // root 默认展开
  if (root.children) {
    root.children.forEach((c) => dfsAppend(c, 1, [root]));
  }
}
function dfsAppend(node, depth, ancestorDirs) {
  const row = appendWin10Row(node, depth, false);
  // 挂到所有祖先 dir 的后代集合（便于 toggle 时一次性显示/隐藏）
  ancestorDirs.forEach((a) => {
    const key = normalizePath(a.path || a.name);
    if (!dirDescendants.has(key)) dirDescendants.set(key, new Set());
    dirDescendants.get(key).add(row);
  });
  if (node.type === 'dir' && node.children && node.children.length) {
    const nextAncestors = ancestorDirs.concat([node]);
    node.children.forEach((c) => dfsAppend(c, depth + 1, nextAncestors));
    // 自己也作为后代的控制者
    const me = normalizePath(node.path || node.name);
    if (!dirDescendants.has(me)) dirDescendants.set(me, new Set());
    // 初始状态：一级目录不默认折叠，深层默认折叠（保持初始视图简洁）
    if (depth >= 1) {
      dirDescendants.get(me).forEach((r) => r.classList.add('collapsed-descendant'));
      const twisty = row.querySelector('.w10-twisty');
      if (twisty) twisty.textContent = '▸';
    }
  }
}
function normalizePath(p) { return (p || '').replace(/\\/g, '/'); }
function appendWin10Row(node, depth, isRoot) {
  const row = document.createElement('div');
  row.className = 'win10-row';
  row.dataset.path = normalizePath(node.path);
  row.dataset.isDir = node.type === 'dir' ? '1' : '0';
  row.dataset.depth = depth;
  row.dataset.name = node.name || '';
  row.title = (node.path || '') + (node.size ? ` (${fmtSize(node.size)})` : '');

  const isVmd = MOTION_EXTS_RE.test(node.name);
  const isDir = node.type === 'dir';
  const icon = isRoot ? '🖥️' : isDir ? iconFor('dir') : isVmd ? iconFor('motion') : iconFor(node.type);
  const size = isDir ? '' : (node.size != null ? fmtSize(node.size) : '');
  const twisty = (isDir ? (depth === 0 ? '▾' : '▸') : '');

  const indGrp = document.createElement('div');
  indGrp.className = 'w10-icongrp';
  indGrp.style.marginLeft = (depth * 14) + 'px';
  indGrp.innerHTML = `<span class="w10-twisty">${twisty}</span><span class="w10-icon">${icon}</span>`;

  const name = document.createElement('div');
  name.className = 'w10-name';
  name.textContent = node.name || '(根)';

  const sz = document.createElement('div');
  sz.className = 'w10-size';
  sz.textContent = size;

  row.appendChild(indGrp);
  row.appendChild(name);
  row.appendChild(sz);

  // 事件
  if (isDir) {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      // 点 dir：先展开/折叠（toggleDir），再选中高亮 + 鼠标进入预览卡
      clearSelection();
      row.classList.add('selected');
      toggleDir(row);
      showPreviewCardForNode(node);
    });
    row.addEventListener('dblclick', (e) => { e.stopPropagation(); navigateTo(node.path, 'models', true); });
  } else {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
      row.classList.add('selected');
      selectFile(node);
    });
    row.addEventListener('mouseenter', () => showPreviewCardForNode(node));
    row.addEventListener('mouseleave', hidePreviewCard);
  }

  fileTreeEl.appendChild(row);
  return row;
}
```

- [ ] **Step 4: 替换 `toggleDir` / `expandPath` / `clearSelection` (L472-513)**

整个替换：

```js
function toggleDir(rowEl, forceExpand) {
  if (rowEl?.dataset?.isDir !== '1') return;
  const key = normalizePath(rowEl.dataset.path);
  const desc = dirDescendants.get(key);
  const twisty = rowEl.querySelector('.w10-twisty');
  if (!twisty) return;
  const currentlyCollapsed = twisty.textContent === '▸';
  const shouldExpand = forceExpand === undefined ? currentlyCollapsed : !!forceExpand;
  if (shouldExpand) {
    twisty.textContent = '▾';
    if (desc) desc.forEach((r) => r.classList.remove('collapsed-descendant'));
    // 注：如果后代里面也有折叠的 dir，它们自己的 collapsed-descendant 仍保留（独立控制）
    // 正确做法：只清"我作为最外层加的那一层" → 这里我们用一个 data-collapsed-by 来区分子孙自己折叠
    // 为避免复杂，我们只要求：deselect 的子 dir 折叠状态靠它们各自 twisty 控制的后代来管理，
    // 且 desc 里只存亲儿子等"以 dir 为根的所有行子集"。由于 dfsAppend 里已把所有后代挂
    // 到各自 ancestor 上，这里直接 remove class 会展开全部子子孙孙，虽然不精确但体验好（
    // 大多数用户点一下展开就想看到所有下一级）。Win10 行为是点一下只露出直接孩子，
    // 所以我们改为：每次点击只暴露 depth+1 的直接孩子。
    if (desc) {
      const myDepth = parseInt(rowEl.dataset.depth || '0', 10);
      desc.forEach((r) => {
        const d = parseInt(r.dataset.depth || '0', 10);
        if (d === myDepth + 1) r.classList.remove('collapsed-descendant');
        // 孙子+：只有当中间的父 dir 也是展开态时才显示 → 靠中间那级的 toggleDir 独立控制
      });
    }
  } else {
    twisty.textContent = '▸';
    // 折叠：把所有后代（不论 depth）全部加回 collapsed-descendant
    // 因为 Win10 折叠父节点后所有下级别再不可见
    if (desc) desc.forEach((r) => r.classList.add('collapsed-descendant'));
  }
}
function expandPath(nodePath) {
  const norm = normalizePath(nodePath);
  if (!norm) return null;
  // 找到目标行
  const target = [...fileTreeEl.querySelectorAll('.win10-row')].find((r) => r.dataset.path === norm);
  if (!target) return null;
  // 从根到 target，沿途所有 dir 强制展开
  const parts = norm.split('/');
  for (let i = 1; i < parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const row = [...fileTreeEl.querySelectorAll('.win10-row')].find((r) => r.dataset.path === sub);
    if (row && row.dataset.isDir === '1') toggleDir(row, true);
  }
  // 目标可见并滚到视图
  target.classList.remove('collapsed-descendant');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return target;
}
function clearSelection() {
  fileTreeEl.querySelectorAll('.win10-row.selected').forEach((el) => el.classList.remove('selected'));
}
function setSelectedByPath(p) {
  const t = expandPath(p);
  clearSelection();
  if (t) t.classList.add('selected');
}
```

- [ ] **Step 5: 验证构建通过（文件树部分）**

```powershell
cd "d:\Program Files\code\MMDModelViewer"
npm run build:renderer 2>&1 | Select-Object -Last 15
```

Expected: `renderer/bundle.js  5.3mb ⚡️` 之类；exit code 0

- [ ] **Step 6: 手动 T1/T2 快速冒烟**

```powershell
# 打开应用后目视检查侧边栏
npm start
```

→ 验收用例 T1/T2 合格。

- [ ] **Step 7: 提交 Task B**

```bash
git add renderer/styles.css renderer/renderer.js renderer/bundle.js renderer/bundle.js.map
git commit -m "feat(tree): 文件树改为 Win10 扁平列表（grid 三列）+ 支持展开折叠与高亮"
```

---

### Task C: 动画管线重构 → MMDAnimationHelper + CCDIK（腿部修复）+ MMDPhysics（布料）

**Files:**
- Modify: `renderer/renderer.js`
  - imports 顶部 (L1-4)
  - 状态区 (L50-60) 加 mmdHelper / ammoReady / 改 currentAction
  - 新增 `initAmmo()`
  - 修改 `clearModel()` (L939-951)
  - 修改 `loadModel()` (L965-991)
  - 修改 `playVmd()` (L1067-1085)
  - 修改 `animate()` (L1129-1135)
  - 修改播放控件 btn-play / btn-pause / btn-stop + btn-pause 逻辑 (L1177-1184)
  - 修改 `init()` 顶部先 await initAmmo() (L1233-1242)

**Subtask C-1: import + 状态 + initAmmo**

- [ ] **Step 1: 在 renderer.js 顶部 imports (L2-4) 之后加 MMDAnimationHelper**

原：
```js
import { MMDLoader } from '../node_modules/three/examples/jsm/loaders/MMDLoader.js';
```

改为：
```js
import { MMDLoader } from '../node_modules/three/examples/jsm/loaders/MMDLoader.js';
import { MMDAnimationHelper } from '../node_modules/three/examples/jsm/animation/MMDAnimationHelper.js';
```

- [ ] **Step 2: 在状态区（L50-60）新增 helper/ammoReady 状态，删除 currentAction**

原：
```js
let currentModel = null;
let currentMesh = null;
let mixer = null;
let currentAction = null;
```

改为：
```js
let currentModel = null;
let currentMesh = null;
// AnimationMixer（旧管线）已废弃；统一由 MMDAnimationHelper 管理 IK + 物理 + 动画
let mmdHelper = null;
let ammoReady = false;
let currentAnimating = false;  // 表示当前是否有动作在驱动（用于播放按钮显示）
```

- [ ] **Step 3: 在 `init()` 之前追加 `initAmmo()` 函数**

找一个靠近 `init()`（L1233 附近）的地方，在 `function countModels` 之前加：

```js
// ---------- Ammo.js 预加载（用于 MMDPhysics 布料） ----------
async function initAmmo() {
  try {
    const mod = await import('../node_modules/three/examples/jsm/libs/ammo.wasm.js');
    const AmmoFactory = (mod && mod.default) ? mod.default : (mod.Ammo ? mod.Ammo : null);
    if (!AmmoFactory) throw new Error('ammo.wasm.js 模块未导出有效工厂');
    const Ammo = await AmmoFactory();
    window.Ammo = Ammo;
    ammoReady = true;
  } catch (err) {
    ammoReady = false;
    setStatus('ammo 加载失败，布料物理降级（腿部 IK 仍正常）：' + (err.message || err), 'warn');
  }
}
```

**Subtask C-2: 修改 clearModel / loadModel / playVmd / animate**

- [ ] **Step 4: 修改 clearModel() (L939-951)**

原：
```js
function clearModel() {
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
    currentModel = null;
    currentMesh = null;
  }
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  currentAction = null;
  vmdFiles = [];
  vmdListEl.innerHTML = '';
  animPanel.classList.add('hidden');
}
```

改为：
```js
function clearModel() {
  // 先让 helper 卸掉旧 mesh 的 IK/物理/动画轨道（必须在 scene.remove 之前）
  if (mmdHelper && currentMesh) {
    try { mmdHelper.remove(currentMesh); } catch (_) { /* ignore */ }
  }
  if (currentModel) {
    scene.remove(currentModel);
    disposeObject(currentModel);
    currentModel = null;
    currentMesh = null;
  }
  currentAnimating = false;
  vmdFiles = [];
  vmdListEl.innerHTML = '';
  animPanel.classList.add('hidden');
}
```

- [ ] **Step 5: 修改 loadModel(node) (L965-991)**

整个函数替换：

```js
async function loadModel(node) {
  const url = api.mmdUrl(node.path);
  setStatus('正在加载模型 ' + node.name + ' …');
  clearModel();

  // 收集同目录 VMD 动作
  const dirNode = findDirNode(currentRoot, node.path);
  vmdFiles = (dirNode ? dirNode.children : []).filter(
    (c) => c.type === 'model' && MOTION_EXTS_RE.test(c.name)
  );

  try {
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, reject);
    });
    currentModel = mesh;
    currentMesh = mesh;
    scene.add(mesh);

    // ====== 交给 MMDAnimationHelper 统一驱动（IK + 物理 + 动画） ======
    if (!mmdHelper) {
      mmdHelper = new MMDAnimationHelper({
        afterglow: 0.1,                 // 切动作 100ms 余辉
        resetPhysicsOnLoop: true,
      });
    }

    // 性能兜底：刚体数 > 200 自动关物理
    const rbCount = (mesh.userData.rigidBodies && mesh.userData.rigidBodies.length) || 0;
    const jnCount = (mesh.userData.joints && mesh.userData.joints.length) || 0;
    let usePhysics = ammoReady;
    if (usePhysics && rbCount > 200) {
      usePhysics = false;
      setStatus(`模型刚体 ${rbCount} 个过多，布料物理已自动关闭（腿部 IK 正常）`, 'warn');
    }

    mmdHelper.add(mesh, {
      animation: null,               // 先不绑定动作，等 playVmd 调 helper.animate
      physics: usePhysics,
      unitStep: 1 / 60,
      maxStepNum: 2,
      gravity: new THREE.Vector3(0, -9.8 * 10, 0),   // MMD 尺度毫米，×10 官方约定
      resetPosition: true,
      resetRotation: true,
    });

    frameModel(mesh);
    showModelInfo(mesh, node);
    setupVmdList(mesh);

    const extra = `${vmdFiles.length} 个动作可用 · IK✓ · 布料${usePhysics ? `✓ (${rbCount} 刚体/${jnCount} 弹簧)` : '✗'}`;
    setStatus(`已加载：${node.name}`, 'info', extra);
  } catch (err) {
    setStatus('加载模型失败：' + (err && err.message || err), 'error');
    console.error(err);
  }
}
```

- [ ] **Step 6: 修改 playVmd (L1067-1085)**

整个替换：

```js
async function playVmd(vmdNode, mesh, el) {
  const url = api.mmdUrl(vmdNode.path);
  setStatus('加载动作 ' + vmdNode.name + ' …');
  try {
    const clip = await new Promise((resolve, reject) => {
      mmdLoader.loadAnimation(url, mesh, resolve, undefined, reject);
    });

    // helper.animate 内部已经会 stop 旧动作并启动新 + 刷 IK/物理重置
    // 如果 mesh 不存在 helper 里，兜底回退
    if (mmdHelper && mesh && mmdHelper.objects && mmdHelper.objects.has(mesh)) {
      mmdHelper.animate(mesh, clip);
    } else if (mmdHelper) {
      // 兜底（先 add 再 animate）
      mmdHelper.add(mesh, { animation: clip, physics: ammoReady });
    }
    currentAnimating = true;

    vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
    el && el.classList.add('active');
    showPreviewCardForNode({ path: vmdNode.path, name: vmdNode.name, size: vmdNode.size, type: 'model' }, true);
    setStatus(`播放动作：${vmdNode.name}`, 'info', `时长 ${clip.duration.toFixed(2)}s · ${clip.tracks.length} 条轨道 · IK+物理驱动`);
  } catch (err) {
    setStatus('加载动作失败：' + (err && err.message || err), 'error');
  }
}
```

- [ ] **Step 7: 修改 animate() 渲染循环 (L1129-1135)**

原：
```js
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer && currentAction) mixer.update(delta * parseFloat(speedRange.value));
  controls.update();
  renderer.render(scene, camera);
}
```

改为：
```js
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const speed = parseFloat(speedRange.value || '1');
  // 无动作也要跑 helper.update(0)：物理（布料）继续惯性摆动 ~0.3s
  const d = currentAnimating ? delta * speed : 0;
  if (mmdHelper) {
    try {
      mmdHelper.update(d);
    } catch (err) {
      // 防止某一帧物理/IK 异常导致整帧卡崩
      console.warn('[MMDAnimationHelper.update] caught:', err && err.message);
    }
  }
  controls.update();
  renderer.render(scene, camera);
}
```

**Subtask C-3: 播放控件（play/pause/stop）适配新管线**

- [ ] **Step 8: 修改 L1177-1184 的播放控件**

原：
```js
// 播放控制
$('btn-play').addEventListener('click', () => { if (currentAction) currentAction.play(); });
$('btn-pause').addEventListener('click', () => { if (currentAction) currentAction.pause(); });
$('btn-stop').addEventListener('click', () => {
  if (mixer) mixer.stopAllAction();
  currentAction = null;
  vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
});
```

改为：
```js
// 播放控制（MMDAnimationHelper 统一驱动）
$('btn-play').addEventListener('click', () => {
  if (!mmdHelper || !currentMesh) return;
  const obj = mmdHelper.objects && mmdHelper.objects.get(currentMesh);
  if (obj && obj.loopedAnimationMixer) obj.loopedAnimationMixer.timeScale = 1;
  currentAnimating = true;
});
$('btn-pause').addEventListener('click', () => {
  if (!mmdHelper || !currentMesh) return;
  const obj = mmdHelper.objects && mmdHelper.objects.get(currentMesh);
  if (obj && obj.loopedAnimationMixer) obj.loopedAnimationMixer.timeScale = 0;
  currentAnimating = false;
});
$('btn-stop').addEventListener('click', () => {
  if (mmdHelper && currentMesh) {
    // 从 helper 里 remove 后再 re-add（无 animation），相当于完全停止动作 + 回到 bind pose
    try { mmdHelper.remove(currentMesh); } catch (_) {}
    mmdHelper.add(currentMesh, {
      animation: null,
      physics: ammoReady && (currentMesh.userData.rigidBodies?.length || 0) <= 200,
      unitStep: 1 / 60,
      maxStepNum: 2,
      gravity: new THREE.Vector3(0, -9.8 * 10, 0),
      resetPosition: true,
      resetRotation: true,
    });
  }
  currentAnimating = false;
  vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
});
```

**Subtask C-4: 改 init() 顶部预加载 ammo**

- [ ] **Step 9: 修改 init() (L1233-1242)**

原：
```js
async function init() {
  loadRecent();
  try {
    const [defRes, motRes] = await Promise.all([api.getDefaultRoot(), api.getMotionRoot()]);
    ...
```

改为：
```js
async function init() {
  loadRecent();
  // 先启动 ammo 预加载（与扫描根目录并行，保证第一个模型加载时 ammo 已就绪）
  const ammoPromise = initAmmo();
  try {
    const [defRes, motRes] = await Promise.all([api.getDefaultRoot(), api.getMotionRoot()]);
    // 等 ammo 完（不会比目录扫描更慢）
    await ammoPromise;
    if (!defRes.ok || !defRes.data) { setStatus('默认根目录获取失败', 'error'); return; }
    defaultRootPath = defRes.data;
    motionRootPath = motRes.data || null;
    navStack.back = [{ path: defaultRootPath, tab: 'models' }];
    navStack.forward = [];
    await navigateTo(defaultRootPath, 'models', false);
```

**Subtask C-5: 构建 + 验收**

- [ ] **Step 10: 运行 build:renderer**

```powershell
cd "d:\Program Files\code\MMDModelViewer"
npm run build:renderer 2>&1 | Select-Object -Last 15
```

Expected: exit code 0，输出 bundle.js/sourcemap

- [ ] **Step 11: 启动应用，验收用例 T3–T10**

```powershell
npm start
```

按 spec §八 顺序：
- T3 腿部走路动作
- T4 下蹲动作
- T5 裙摆惯性
- T6 头发甩动
- T7 切模型无残留刚体
- T8 切动作正确接管
- T9 降级（暂不验证；代码里 setStatus 降级分支存在即可）
- T10 构建

- [ ] **Step 12: 提交 Task C**

```bash
git add renderer/renderer.js renderer/bundle.js renderer/bundle.js.map
git commit -m "feat: 动画管线迁移 MMDAnimationHelper，修复腿部 CCDIK + 引入 MMDPhysics 布料（ammo）"
```

---

### Task Z: 端到端回归

**Files:**
- 运行时验证（不改文件）

- [ ] **Step 1: 启动应用执行 end-to-end**

```powershell
cd "d:\Program Files\code\MMDModelViewer" ; npm start
```

手工流程：
1. 进入默认根目录 → 文件树：Win10 列表观感合格（T1）
2. 点开"3D模型/原神"目录 → twisty▾展开，孩子缩进 14px，再点 twisty▸全部折叠（T2）
3. 打开"少女_by_原神_…"解压后的 .pmx → 状态栏提示 `IK✓ · 布料✓ (xx 刚体/yy 弹簧)`
4. 在 animPanel 选择走路.vmd → 观察抬脚/膝盖弯曲（T3）；再选下蹲.vmd（T4）；观察裙摆摆/头发甩（T5/T6）
5. 点「停止」→ 模型回到 bind pose，但裙摆继续晃 ~0.3s 停
6. 切另一个模型 → 控制台无"旧 mesh helper.add failed"错误（T7）
7. 在同模型走路→跳舞切 VMD → helper.animate 无残留（T8）
8. 构建无报错（T10）✅

- [ ] **Step 2: 最终打包一次可选**（如果要发版）

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false" ; npm run dist 2>&1 | Select-Object -Last 20
```

- [ ] **Step 3: 端到端完成，提交一次整合标记（非必要，用户选）**

可选：
```bash
git add renderer/bundle.js renderer/bundle.js.map
git commit -m "build: 最终 bundle（Win10 列表 + IK + 布料物理）"
```
