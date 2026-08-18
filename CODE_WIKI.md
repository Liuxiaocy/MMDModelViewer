# MMDModelViewer · Code Wiki

> 本地 3D 模型（MMD PMX/PMD 为主）便捷查看与预览的桌面应用，基于 **Electron 33 + Three.js 0.170**。
> 版本：0.1.0 · 许可证：MIT

本文档对仓库源码进行结构化梳理，覆盖整体架构、模块职责、关键类与函数、依赖关系以及运行方式。

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [主进程 main.js](#4-主进程-mainjs)
5. [Preload 桥接 preload.js](#5-preload-桥接-preloadjs)
6. [渲染进程 renderer/](#6-渲染进程-renderer)
7. [依赖关系](#7-依赖关系)
8. [构建与运行](#8-构建与运行)
9. [关键机制深入](#9-关键机制深入)
10. [冒烟测试](#10-冒烟测试)
11. [注意事项](#11-注意事项)

---

## 1. 项目概述

### 定位
MMDModelViewer 是一款 Windows 桌面端 3D 模型预览器，专为本地 MMD（MikuMikuDance）模型文件设计，同时附带对常见通用 3D 格式的占位支持。

### 核心能力
| 能力 | 说明 |
| --- | --- |
| 目录浏览 | 默认扫描 `D:\素材\3D模型`，可切换任意目录；竖向紧凑文件树 + 引导线 |
| MMD 模型预览 | 加载 `.pmx` / `.pmd`，支持左键旋转 / 右键平移 / 滚轮缩放 |
| VMD 动作播放 | 自动列出模型同目录 `.vmd`，支持播放 / 暂停 / 停止 / 0.1x~3x 调速 |
| 截图导出 | 一键将当前视角导出为 PNG |
| 压缩包预览 | 直接解压 `.rar` / `.zip` / `.7z` 到临时目录并浏览内部模型 |
| 模型信息 | 顶点数、面数、贴图数量与贴图列表 |

### 支持的文件格式
| 类别 | 扩展名 |
| --- | --- |
| MMD | `.pmx` `.pmd` `.vmd` `.vpd` |
| 通用 3D（占位） | `.gltf` `.glb` `.obj` `.fbx` `.stl` `.dae` `.ply` `.3ds` |
| 压缩包 | `.rar` `.zip` `.7z` |
| 文本（仅元信息） | `.txt` `.md` `.json` `.cfg` `.ini` |

> 当前完整渲染链路（贴图、骨骼、动作）仅针对 MMD 优化，通用格式仅出现在列表中。

---

## 2. 整体架构

应用遵循 Electron 标准的三层进程模型，并通过自定义 `mmd://` 协议打通本地文件与浏览器安全模型。

```
┌──────────────────────────────────────────────────────────────────┐
│                       主进程 main.js (Node)                      │
│  ─ 窗口管理 (BrowserWindow)                                       │
│  ─ mmd:// 自定义协议（本地文件 → 带 CORS 头的 HTTP 响应）          │
│  ─ IPC 处理器：scan-dir / extract-archive / choose-dir /          │
│                save-screenshot / get-default-root                 │
│  ─ 冒烟测试模式 (--smoke-test)                                    │
└──────────────┬───────────────────────────────────┬───────────────┘
               │ contextBridge (window.mmdAPI)      │ ipcRenderer.invoke
               ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Preload (preload.js)                            │
│  暴露受控 API：scanDir / extractArchive / chooseDir /             │
│               saveScreenshot / getDefaultRoot / mmdUrl            │
└──────────────┬───────────────────────────────────────────────────┘
               │ window.mmdAPI
               ▼
┌──────────────────────────────────────────────────────────────────┐
│             渲染进程 renderer/ (Chromium + ES Module)             │
│  ─ index.html   三栏布局（工具栏 / 文件树 / 视口 / 信息栏）        │
│  ─ styles.css   深色主题                                          │
│  ─ renderer.js  源文件：Three.js 场景、MMDLoader、OrbitControls、  │
│                  动作播放、文件树、冒烟测试钩子                    │
│  ─ bundle.js    esbuild 构建产物（three.js 内联，避免 asar ESM）   │
└──────────────────────────────────────────────────────────────────┘
               ▲
               │ fetch(mmd://local/D:/...)
               │
┌──────────────────────────────────────────────────────────────────┐
│             mmd:// 协议处理器 (主进程内)                          │
│  pathname → 本地路径 → fs.readFile → Response                     │
│  关键：响应头含 Access-Control-Allow-Origin: *                    │
└──────────────────────────────────────────────────────────────────┘
```

### 进程间通信总览

| 方向 | 通道 | 触发方 | 处理方 | 用途 |
| --- | --- | --- | --- | --- |
| 渲染 → 主 | `scan-dir` | renderer | main | 扫描目录返回树结构 |
| 渲染 → 主 | `extract-archive` | renderer | main | 解压压缩包到临时目录 |
| 渲染 → 主 | `choose-dir` | renderer | main | 弹出系统目录选择框 |
| 渲染 → 主 | `save-screenshot` | renderer | main | 保存 PNG dataURL 到磁盘 |
| 渲染 → 主 | `get-default-root` | renderer | main | 获取默认根目录常量 |
| 主 → 渲染 | `mmd://` 协议响应 | renderer fetch | main | 本地文件流式响应（含 CORS） |

### 安全模型
- `contextIsolation: true`，`nodeIntegration: false`，`webSecurity: true`，`sandbox: false`
- 渲染进程无法直接访问 Node API，仅通过 `window.mmdAPI` 暴露的白名单方法交互
- HTML 中以 `Content-Security-Policy` meta 限制资源加载源：仅允许 `self`、`mmd:`、`data:`、`blob:`，脚本仅 `self` + `unsafe-inline`

---

## 3. 目录结构

```
MMDModelViewer/
├── main.js                # 主进程入口（窗口、协议、IPC、冒烟测试）
├── preload.js             # 安全桥接（contextBridge）
├── package.json           # 依赖、脚本、electron-builder 配置
├── README.md              # 项目说明
├── .gitignore             # 忽略 node_modules / dist / bundle.js 等
├── renderer/              # 渲染进程
│   ├── index.html         # 界面骨架（工具栏 / 文件树 / 3D 视口 / 信息栏）
│   ├── styles.css         # 深色主题样式
│   ├── renderer.js        # 源文件（Three.js 场景、MMDLoader、动作播放）
│   ├── bundle.js          # esbuild 构建产物（npm run build:renderer 生成）
│   └── bundle.js.map      # sourcemap（构建产物）
└── dist/                  # 打包输出（electron-builder 生成，被 git 忽略）
    ├── win-unpacked/      # 解包版
    └── MMDModelViewer 0.1.0.exe
```

---

## 4. 主进程 main.js

### 4.1 职责
- 创建并管理 `BrowserWindow`（1440×900，最小 1000×640）
- 在 `app.ready` 之前注册 `mmd://` 特权协议
- 注册 5 个 IPC 处理器，封装文件系统、解压、对话框操作
- 提供 `--smoke-test` 自动化入口

### 4.2 关键常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `DEFAULT_ROOT` | `<安装目录>/mods`（开发模式 `<项目根>/mods`） | 默认扫描根目录 |
| `MODEL_EXTS` | `.pmx .pmd .vmd .vpd .gltf .glb .obj .fbx .stl .dae .ply .3ds .max .blend` | 模型扩展名集合（max/blend 为专有二进制格式，仅识别分类不可预览） |
| `ARCHIVE_EXTS` | `.rar .zip .7z` | 压缩包扩展名集合 |
| `TEXT_EXTS` | `.txt .md .json .cfg .ini` | 文本扩展名集合 |
| `MIME_TYPES` | png/jpg/bmp/gif/webp/tga/dds/pmx/pmd/vmd/vpd/txt/json | mmd:// 响应 Content-Type 映射 |

### 4.3 关键函数

#### `createWindow()` — [main.js:38-65](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L38-L65)
创建主窗口。`webPreferences` 强制开启 `contextIsolation`、关闭 `nodeIntegration`、保留 `webSecurity`。若环境变量 `MMD_DEVTOOLS=1` 则自动打开 DevTools。

#### `registerMmdProtocol()` — [main.js:88-111](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L88-L111)
注册 `mmd://` 协议处理器：
1. 解析 `url.pathname`，去掉前导 `/`，得到本地路径
2. `path.resolve` 规范化后校验存在性
3. `fs.promises.readFile` 读取文件
4. 返回带 `Access-Control-Allow-Origin: *` 与 `Cache-Control: no-store` 的 `Response`

> **必须手动加 CORS 头**：MMDLoader 内部 `TextureLoader` 默认 `crossOrigin='anonymous'`，若用 `net.fetch(file://)` 转发（无 ACAO 头），贴图会被浏览器跨源拦截，模型显示为灰白色。

#### `scanDir(rootPath, depth = 0)` — [main.js:114-146](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L114-L146)
递归扫描目录，最大深度 `maxDepth = 8`。返回节点结构：
```js
{
  name: string,           // basename
  path: string,           // 绝对路径
  type: 'dir' | 'model' | 'archive' | 'text' | 'file',
  children: Node[],
  size: number | null,    // 文件字节数，目录为 null
}
```
- 过滤 `.` 开头的隐藏项
- 排序：目录优先，文件名按 `zh-CN` locale 排序
- 单层异常（如无权限）静默吞掉，返回空 children

#### `fileKind(p)` — [main.js:148-154](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L148-L154)
根据扩展名映射 `file` → `model` / `archive` / `text` / `file`。

#### `extractArchive(archivePath)` — [main.js:157-187](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L157-L187)
解压压缩包到 `os.tmpdir()/mmdviewer/<md5(路径+时间戳)前12位>`。
- `.rar` → `node-unrar-js`（WASM，兼容 RAR5 + 中文路径）
- `.zip` / `.7z` → `7zip-min`（内置 7za 二进制）

返回临时目录路径。失败时 reject 带「解压失败：」前缀的 Error。

#### `registerIpc()` — [main.js:190-239](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L190-L239)
集中注册 5 个 `ipcMain.handle`，详见 [IPC 通道表](#进程间通信总览)。统一返回 `{ ok: boolean, data?, error? }` 结构。

#### `runSmokeTest()` — [main.js:242-360](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L242-L360)
冒烟测试主流程，详见 [§10 冒烟测试](#10-冒烟测试)。

### 4.4 生命周期
```js
app.whenReady() →
  registerMmdProtocol() + registerIpc() + createWindow()
  → 若 --smoke-test，1.5s 后 runSmokeTest()
app.on('window-all-closed') → 非 macOS 退出
```

### 4.5 模块导出
```js
module.exports = { DEFAULT_ROOT, MODEL_EXTS };
```
仅用于潜在的外部脚本引用，应用本身未使用。

---

## 5. Preload 桥接 preload.js

### 5.1 职责
通过 `contextBridge.exposeInMainWorld('mmdAPI', ...)` 向渲染进程暴露受控 API，是渲染进程与主进程通信的唯一合法通道。

### 5.2 暴露的 API — [preload.js:14-27](file:///d:/Program%20Files/code/MMDModelViewer/preload.js#L14-L27)

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `scanDir(rootPath)` | `=> Promise<{ok, data?, error?}>` | 扫描目录，data 为节点树 |
| `extractArchive(archivePath)` | `=> Promise<{ok, data:{dest,tree}?, error?}>` | 解压并返回临时目录与新树 |
| `chooseDir()` | `=> Promise<{ok, data:path?, error?}>` | 弹出系统目录选择框 |
| `saveScreenshot(dataUrl, defaultName)` | `=> Promise<{ok, data:path?, error?}>` | 保存 PNG dataURL |
| `getDefaultRoot()` | `=> Promise<{ok, data:path?}>` | 获取默认根目录 |
| `mmdUrl(filePath)` | `=> string` | 本地路径 → `mmd://local/<path>` |

### 5.3 `mmdUrl` 实现 — [preload.js:7-12](file:///d:/Program%20Files/code/MMDModelViewer/preload.js#L7-L12)
```js
function mmdUrl(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');  // D:\素材\x -> D:/素材/x
  return 'mmd://local/' + normalized;
}
```
将 Windows 反斜杠路径转为正斜杠，前缀 `mmd://local/`，对应主进程协议处理器的 `pathname` 解析逻辑。

---

## 6. 渲染进程 renderer/

### 6.1 index.html — 界面骨架

三栏 + 顶/底栏布局：
```
┌─────────────────────────────────────────────┐
│ #toolbar  标题 / 刷新 / 选择目录 / 重置视角 / 截图 │
├──────────┬──────────────────┬──────────────┤
│ #sidebar │   #viewport      │ #info-panel  │
│ 文件树    │   canvas#gl-canvas│  模型信息     │
│          │   #anim-panel    │              │
│          │   (VMD 控制)     │              │
├──────────┴──────────────────┴──────────────┤
│ #statusbar  状态文本 / 详情                    │
└─────────────────────────────────────────────┘
```

**CSP**（meta 标签）：
```
default-src 'self' 'unsafe-inline' mmd: data: blob:;
script-src  'self' 'unsafe-inline';
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob: mmd:;
connect-src 'self' mmd: data: blob:;
```

入口脚本 `<script type="module" src="bundle.js">`（esbuild 构建产物）。

### 6.2 styles.css — 深色主题

- CSS 变量调色板：`--bg #1e1f26`、`--accent #4f8cff`、`--accent-2 #35c98d` 等
- 字体：`"Segoe UI", "Microsoft YaHei", system-ui`
- 文件树：竖向紧凑 + 12px 缩进 + 左侧 1px 引导线，根节点不带引导线
- 动作面板：右下角浮层，半透明背景 + 阴影
- 滚动条：8px 宽，圆角深灰

### 6.3 renderer.js — 渲染逻辑

入口模块，依赖 `three` 与 `three/examples/jsm` 下的 `OrbitControls` 与 `MMDLoader`。

#### 6.3.1 顶层状态变量 — [renderer.js:21-28](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L21-L28)

| 变量 | 类型 | 用途 |
| --- | --- | --- |
| `currentRoot` | Node \| null | 当前根目录节点 |
| `currentModelPath` | string \| null | 当前模型绝对路径 |
| `currentModel` | Object3D \| null | 当前场景中的模型对象 |
| `currentMesh` | Object3D \| null | MMD 网格（用于动作绑定） |
| `mixer` | AnimationMixer \| null | 动作混合器 |
| `currentAction` | AnimationAction \| null | 当前播放的动作 |
| `vmdFiles` | Node[] | 当前目录的 VMD 文件列表 |
| `autoRotate` | boolean | 预留的自动旋转开关 |

#### 6.3.2 Three.js 场景初始化 — [renderer.js:30-93](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L30-L93)

| 对象 | 关键配置 |
| --- | --- |
| `WebGLRenderer` | `preserveDrawingBuffer: true`（截图必需）、`antialias`、像素比 ≤ 2、PCFSoftShadowMap、sRGB 输出 |
| `Scene` | 背景 `#1b1c22`，Fog `30~120` |
| `PerspectiveCamera` | 45° FOV，初始位置 `(0, 2.2, 5.2)` |
| `OrbitControls` | `target (0,1.1,0)`、阻尼 0.08、距离 `0.3~60` |
| `AmbientLight` | 强度 0.55 |
| `HemisphereLight` | 天 `#dde6ff` 地 `#40382c`，强度 0.5 |
| `DirectionalLight` (主) | 强度 1.1，阴影贴图 2048²，正交阴影相机 8×8 |
| `DirectionalLight` (补) | 颜色 `#8fb0ff`，强度 0.35 |
| `GridHelper` | 20×20 网格 |
| `ground` | 40×40 PlaneGeometry + ShadowMaterial(opacity 0.28) |

#### 6.3.3 目录树模块 — [renderer.js:119-225](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L119-L225)

| 函数 | 行号 | 职责 |
| --- | --- | --- |
| `renderTree(root)` | [120-137](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L120-L137) | 渲染根节点 + 一级子项（过滤掉 `file` 与 `text`） |
| `buildNode(node)` | [139-168](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L139-L168) | 递归构造单个树节点 DOM；目录预加载全部子项 |
| `toggleDir(item, node, childWrap)` | [170-181](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L170-L181) | 展开/折叠目录，切换 `▾`/`▸` |
| `expandPath(nodePath)` | [184-215](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L184-L215) | 沿父目录链逐级展开并定位目标文件元素 |
| `escapeHtml(s)` | [217-221](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L217-L221) | 防 XSS 转义 |
| `clearSelection()` | [223-225](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L223-L225) | 清除所有 `.selected` |
| `iconFor(type)` | [109-117](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L109-L117) | 类型 → emoji 图标映射 |
| `fmtSize(bytes)` | [102-107](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L102-L107) | 字节 → B/KB/MB 格式化 |

#### 6.3.4 文件选择与模型加载 — [renderer.js:227-353](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L227-L353)

| 函数 | 行号 | 职责 |
| --- | --- | --- |
| `selectFile(node)` | [228-244](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L228-L244) | 路由：model → loadModel、archive → handleArchive、text → showTextFile |
| `handleArchive(node)` | [246-259](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L246-L259) | 调主进程解压，用临时目录替换文件树 |
| `showTextFile(node)` | [261-266](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L261-L266) | 仅展示文本文件元信息（不读取内容） |
| `clearModel()` | [271-283](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L271-L283) | 移除并 dispose 当前模型、停止动作、清空 VMD 列表 |
| `disposeObject(obj)` | [285-299](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L285-L299) | 递归释放 geometry / material / texture，防内存泄漏 |
| `loadModel(node)` | [301-328](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L301-L328) | 通过 mmdUrl 加载 PMX，frameModel + showModelInfo + setupVmdList |
| `findDirNode(rootNode, filePath)` | [330-340](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L330-L340) | 在节点树中查找文件所在目录节点（用于收集 VMD） |
| `frameModel(mesh)` | [342-353](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L342-L353) | 计算包围盒，自动调整相机距离与 target |

#### 6.3.5 模型信息展示 — [renderer.js:355-389](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L355-L389)
`showModelInfo(mesh, node)` 遍历 mesh 统计：
- 顶点数：`geometry.attributes.position.count`
- 面数：`index.count / 3` 或 position 数 / 3
- 贴图：扫描 `map` / `normalMap` / `specularMap` / `emissiveMap` / `alphaMap`，去重统计文件名

#### 6.3.6 VMD 动作播放 — [renderer.js:391-426](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L391-L426)

| 函数 | 行号 | 职责 |
| --- | --- | --- |
| `setupVmdList(mesh)` | [392-406](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L392-L406) | 渲染 VMD 列表项，无则隐藏面板 |
| `playVmd(vmdNode, mesh, el)` | [408-426](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L408-L426) | `mmdLoader.loadAnimation` 加载 VMD → 创建 mixer → clipAction.play |

动作播放控制：`btn-play` / `btn-pause` / `btn-stop` / `speed-range`（0.1~3x）。

#### 6.3.7 渲染循环 — [renderer.js:428-450](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L428-L450)
```js
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer && currentAction) mixer.update(delta * parseFloat(speedRange.value));
  controls.update();
  renderer.render(scene, camera);
}
```
- 速度倍率直接乘到 `mixer.update` 的 delta 上
- `resize()` 监听窗口尺寸，更新相机投影与渲染器尺寸

#### 6.3.8 工具栏事件 — [renderer.js:452-488](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L452-L488)

| 按钮 | 行为 |
| --- | --- |
| `btn-reset-view` | 有模型则 frameModel，否则恢复初始相机 |
| `btn-screenshot` | `canvas.toDataURL('image/png')` → `api.saveScreenshot` |
| `btn-refresh` | 重新扫描 `currentRoot` |
| `btn-choose-dir` | `api.chooseDir` → `loadRoot` |
| `btn-play` / `btn-pause` / `btn-stop` | 控制 `currentAction` / `mixer` |
| `speed-range` | 实时显示倍率，影响下一帧 `mixer.update` |

#### 6.3.9 启动流程 — [renderer.js:490-524](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L490-L524)
```
init() → api.getDefaultRoot() → loadRoot(defaultRoot)
loadRoot(rootPath) → api.scanDir → renderTree + 状态栏显示模型数
```

#### 6.3.10 冒烟测试钩子 `window.__mmdTest` — [renderer.js:527-729](file:///d:/Program%20Files/code/MMDModelViewer/renderer/renderer.js#L527-L729)
仅在 `--smoke-test` 模式下被主进程通过 `webContents.executeJavaScript` 调用：

| 方法 | 用途 |
| --- | --- |
| `loadAndMeasure(filePath)` | 加载 PMX 返回包围盒尺寸 |
| `renderShot(filePath)` | 离屏 320×320 渲染一帧并导出 PNG dataURL |
| `diagnose(filePath)` | 诊断材质/贴图加载状态，探测 URL 可加载性 |
| `texProbe(filePath)` | 对照测试 TextureLoader 对反斜杠/正斜杠 URL 的加载 |
| `texProbe2(filePath)` | 精确重现 MMDLoader `_loadTexture` 路径（含 crossOrigin 设置） |
| `mmdProbe(filePath)` | 完整 MMDLoader 加载流程诊断（材质 map 完成状态、手动重载对比） |

---

## 7. 依赖关系

### 7.1 运行时依赖 (dependencies)

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `7zip-min` | `^2.0.0` | 解压 `.zip` / `.7z`，内置 7za 二进制 |
| `node-unrar-js` | `^2.0.2` | 解压 `.rar`（WASM，基于官方 unrar 源码，兼容 RAR5 + 中文路径） |

### 7.2 开发依赖 (devDependencies)

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `electron` | `^33.0.0` | 应用外壳 |
| `electron-builder` | `^25.0.0` | 打包为 NSIS 安装包 + 便携版 |
| `esbuild` | `^0.28.2` | 将 renderer.js + three.js 打包为单文件 bundle.js |
| `three` | `^0.170.0` | 3D 渲染（仅在渲染进程通过 esbuild 内联） |
| `7zip-bin` | `^5.2.0` | 7zip-min 的二进制依赖，打包时需 `asarUnpack` |

### 7.3 模块依赖图

```
main.js
├── electron (app, BrowserWindow, ipcMain, dialog, protocol, net)
├── path / fs / os / crypto / url
├── 7zip-min        ──> 7zip-bin (asarUnpack)
└── node-unrar-js

preload.js
└── electron (contextBridge, ipcRenderer)

renderer/renderer.js
├── three
│   ├── examples/jsm/controls/OrbitControls.js
│   └── examples/jsm/loaders/MMDLoader.js
└── window.mmdAPI (由 preload.js 注入)
```

### 7.4 打包配置要点 — [package.json:26-52](file:///d:/Program%20Files/code/MMDModelViewer/package.json#L26-L52)
- `appId: com.mmdviewer.app`
- `files`: 仅打包 `main.js` / `preload.js` / `renderer/**` / `package.json`
- `asarUnpack: ["node_modules/7zip-bin/**"]`：7za 二进制不能进 asar
- Windows 目标：`nsis` + `portable`
- NSIS：非一键安装，允许选择安装目录，创建桌面快捷方式

---

## 8. 构建与运行

### 8.1 npm scripts — [package.json:9-14](file:///d:/Program%20Files/code/MMDModelViewer/package.json#L9-L14)

| 命令 | 等价于 | 说明 |
| --- | --- | --- |
| `npm run build:renderer` | `esbuild renderer/renderer.js --bundle --format=esm --outfile=renderer/bundle.js --sourcemap` | 仅构建渲染进程 bundle |
| `npm start` | `npm run build:renderer && electron .` | 构建并启动应用 |
| `npm run smoke` | `npm run build:renderer && electron . --smoke-test` | 构建并跑冒烟测试 |
| `npm run dist` | `npm run build:renderer && electron-builder --win` | 打包 Windows 安装包 |

### 8.2 首次运行

```bash
# 1. 安装依赖（Windows 下若遇缓存权限问题加 --cache .\.npm-cache）
npm install

# 2. 启动
npm start
```

### 8.3 调试
- 启动前设置 `MMD_DEVTOOLS=1` 自动打开 DevTools（detach 模式）
- 例（PowerShell）：`$env:MMD_DEVTOOLS='1'; npm start`

### 8.4 打包发布

```bash
# 无证书时跳过代码签名
set CSC_IDENTITY_AUTO_DISCOVERY=false && npm run dist
```
产物位于 `dist/`：NSIS 安装包 + 便携版 exe + `win-unpacked/`。

---

## 9. 关键机制深入

### 9.1 `mmd://` 自定义协议

**问题**：MMDLoader 内部的 `TextureLoader` 默认 `crossOrigin='anonymous'`，浏览器安全模型要求跨源资源必须返回 CORS 头，否则贴图被拦截，模型显示为灰白色。

**解决方案**：
1. `app.ready` 前调用 `protocol.registerSchemesAsPrivileged` 注册 `mmd` 为 `standard + secure + supportFetchAPI + stream`
2. `protocol.handle('mmd', ...)` 读取本地文件，手动构造带 `Access-Control-Allow-Origin: *` 的 `Response`
3. preload 中 `mmdUrl(path)` 将 `D:\素材\x.pmx` 转为 `mmd://local/D:/素材/x.pmx`
4. 渲染进程 `fetch(mmdUrl)` / `MMDLoader.load(mmdUrl)` 即可正常加载模型与贴图

> 不能用 `net.fetch(file://)` 转发：file 响应不带 ACAO 头，仍会触发跨源拦截。

### 9.2 渲染进程打包（esbuild）

**问题**：Electron asar 归档内 ESM 模块的相对路径解析存在限制，直接 `import 'three'` 在打包后会失败。

**解决方案**：esbuild 将 `renderer/renderer.js` 及其依赖（three、OrbitControls、MMDLoader）内联为单个 `renderer/bundle.js`，HTML 中以 `<script type="module" src="bundle.js">` 加载。

### 9.3 压缩包预览

| 格式 | 解压库 | 实现 |
| --- | --- | --- |
| `.rar` | node-unrar-js | 纯 JS/WASM，基于官方 unrar 源码，兼容 RAR5 + 中文路径 |
| `.zip` / `.7z` | 7zip-min | 调用内置 7za 二进制（打包时 asarUnpack） |

解压目标：`os.tmpdir()/mmdviewer/<md5(path+Date.now()).slice(0,12)>`，每次解压生成独立目录避免冲突。解压后用临时目录替换文件树根，UI 上 `root-path` 显示「临时目录：...」。

### 9.4 截图导出

1. WebGLRenderer 创建时 `preserveDrawingBuffer: true`，否则 `toDataURL` 得到空白图
2. 点击截图按钮 → `canvas.toDataURL('image/png')`
3. 通过 IPC `save-screenshot` 把 dataURL 传给主进程
4. 主进程弹出保存对话框，去前缀后 `Buffer.from(base64, 'base64')` 写文件
5. 默认文件名：`<模型名>_<时间戳>.png`，默认目录：系统「图片」文件夹

### 9.5 文件树设计

- **竖向紧凑**：子节点 `margin-left: 12px` + `padding-left: 6px` + 左侧 1px 引导线，深目录不会横向溢出
- **根节点不带引导线**：`#file-tree > .tree-item > .tree-children` 重置 margin/border
- **点击模型自动展开父链**：`expandPath` 沿路径逐级展开并定位目标元素，`scrollIntoView({ block: 'nearest' })`
- **隐藏无关文件**：根节点直接过滤 `file` 与 `text` 类型，只显示目录、模型、压缩包

### 9.6 内存管理

切换模型时 `clearModel()` 调用 `disposeObject(currentModel)`：
- 递归 `traverse` 所有子对象
- 对每个 Mesh：`geometry.dispose()` + 遍历 material 的所有 texture 属性 `dispose()` + `material.dispose()`
- 停止 `mixer.stopAllAction()` 并置空

防止频繁切换模型导致 GPU 资源泄漏。

---

## 10. 冒烟测试

通过 `npm run smoke` 触发，主进程检测到 `--smoke-test` 参数后延迟 1.5s 执行 `runSmokeTest()`。

### 10.1 测试项 — [main.js:259-353](file:///d:/Program%20Files/code/MMDModelViewer/main.js#L259-L353)

| # | 测试名 | 验证内容 |
| --- | --- | --- |
| 1 | `default-root-exists` | 默认目录 `D:\素材\3D模型` 存在 |
| 2 | `scan-dir` | 扫描后能发现 >0 个模型文件 |
| 3 | `find-pmx` | 能找到至少一个 `.pmx` |
| 4 | `extract-rar` | RAR 解压成功且包含 PMX |
| 5 | （隐式）`did-finish-load` | 渲染进程页面加载完成 |
| 6 | `preload-api` | `window.mmdAPI` 含 scanDir/extractArchive/mmdUrl |
| 7 | `mmd-url` | `mmdUrl()` 返回以 `mmd://` 开头的字符串 |
| 8 | `load-pmx-render` | 实际加载 PMX 并渲染一帧，返回包围盒尺寸 |
| 9 | `texture-loaded` | 材质 map 加载完成（防止灰白模型） |
| 10 | `render-screenshot` | WebGL 渲染后 `toDataURL` 得到有效 PNG |

### 10.2 结果输出
- 控制台逐项打印 `[smoke] PASS/FAIL <name> :: <info>`
- 写入 JSON 结果到 `app.getPath('userData')/smoke-result.json`（GUI 应用 stdout 常被吞，文件便于外部读取）
- 退出码：全部通过 `0`，有失败 `1`

---

## 11. 注意事项

- **默认目录**：首次启动若 `D:\素材\3D模型` 不存在，状态栏提示扫描失败，需手动「选择目录…」
- **临时目录**：解压后的临时目录在应用退出后**不会自动清理**（位于系统临时目录）
- **大模型加载**：数十 MB + 大量贴图的模型首次加载需数秒，属正常现象
- **代码签名**：本机无证书时打包需 `set CSC_IDENTITY_AUTO_DISCOVERY=false` 跳过签名
- **通用 3D 格式**：列表中会出现 `.gltf` `.glb` `.obj` 等，但当前未接入对应 Loader，点击后 MMDLoader 加载会失败
- **跨平台**：当前仅打包 Windows（`electron-builder --win`），macOS / Linux 未配置
- **CSP**：脚本仅允许 `self` + `unsafe-inline`，外网 CDN 资源会被拦截

---

> 本 Wiki 基于源码现状梳理，后续若新增模块或调整 IPC 通道，请同步更新本文档。
