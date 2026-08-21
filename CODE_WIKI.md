# MMDModelViewer · Code Wiki

> 本地 3D 模型（MMD PMX/PMD 为主，通用 3D/XXMI Mod 为辅）的桌面端预览应用。
> **技术栈：Electron 33 + Three.js 0.170 + esbuild 0.28 + Python 3 (DDS 解码辅助)**
> 版本：0.1.0 · 许可证：MIT · UI 风格：深色玻璃专业风（Indigo/Purple 主色 `#8B5CF6`）

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [目录结构与文件行数](#3-目录结构与文件行数)
4. [主进程 main.js（2024 行）](#4-主进程-mainjs2024-行)
5. [Preload 桥接 preload.js（98 行）](#5-preload-桥接-preloadjs98-行)
6. [渲染进程 renderer/](#6-渲染进程-renderer)
7. [资源处理流水线](#7-资源处理流水线)
8. [Three.js 渲染架构](#8-threejs-渲染架构)
9. [UI 架构与设计令牌](#9-ui-架构与设计令牌)
10. [关键机制深入](#10-关键机制深入)
11. [参数系统与渲染预设](#11-参数系统与渲染预设)
12. [缓存体系](#12-缓存体系)
13. [构建与运行](#13-构建与运行)
14. [冒烟测试](#14-冒烟测试)
15. [硬约束（不可违反的设计决定）](#15-硬约束不可违反的设计决定)
16. [工程守则与踩坑记录](#16-工程守则与踩坑记录)

---

## 1. 项目概述

### 定位
MMDModelViewer 是一款 Windows 桌面端 3D 模型预览器，面向本地 MMD（MikuMikuDance）/通用 3D 资源 / XXMI 游戏 Mod 的快速预览场景。支持目录浏览、拖拽组合多模型、VMD 动作播放、渲染参数实时调整、截图导出等完整工作流。

### 核心能力速览

| 能力模块 | 说明 |
| --- | --- |
| **目录浏览** | 默认根 `<安装目录>/mods`，可自定义；6 大库卡片（模型/动作/场景/Mod/缓存/组合 + 最近），Windows 10 扁平文件树，面包屑 + 前后/上级导航栈 |
| **MMD 模型预览** | `.pmx` / `.pmd` 加载；OrbitControls（左键旋转 / 右键平移 / 滚轮缩放 / 双击重置） |
| **XXMI/3DMigoto Mod** | `.zip` 含 `.ini` → 解析 `TextureOverride` draw call + `.buf/.ib/.dds` → 生成 BufferGeometry + MeshStandardMaterial 预览 |
| **VMD 动作播放** | 自动识别同目录/动作库 `.vmd`；播放/暂停/停止/0.1x~3x 调速；面板可收起 → 右下角迷你 tab |
| **多模型组合** | 1 场景背景 + N 可动角色（默认 3，参数可调）；选中高亮描边；移动模式拖拽地面 XZ 平面 |
| **压缩包即开** | `.zip/.7z/.rar/.tar/.gz/.xz` → 持久化解压缓存（路径+size+mtime 签名，LRU 64项/8GB） |
| **真实感渲染** | 三层地面（Grid+ShadowMaterial+PBR）+ ACES 色调映射 + PMREM 环境贴图 + Key/Rim/Ambient/Hemisphere 灯光 + 7 段后处理管线 + Fresnel/假倒角 Shader 注入 |
| **渲染设置** | 工具栏快捷面板（预设×4 + 开关×14 + 滑杆×5）+ 右侧完整参数面板（5 大组：渲染/物理/IK/动画/组合），所有状态持久化到 localStorage |
| **物理/IK** | MMDAnimationHelper 统一管理：Ammo.js 布料物理（线性/角阻尼 + 休眠阈值调优），IK 下肢/手臂求解器参数化 |
| **DDS/BC7 贴图** | 绕过 Electron GPU 软件渲染（SwiftShader）假阳性，用 Python `texture2ddecoder` CPU 解压 BC7→PNG，结果缓存到 `userData/dds-png-cache` |
| **资源缓存** | 扫描→候选→勾选复制到 `cache/models` / `cache/motions`，缩略图 PNG，索引 `index.json` |
| **截图导出** | `preserveDrawingBuffer` → `canvas.toDataURL` → 原生保存对话框 |

### 支持的文件格式

| 类别 | 扩展名 |
| --- | --- |
| **MMD（完整支持）** | `.pmx` `.pmd` `.vmd` `.vpd` |
| **通用 3D（预览支持）** | `.gltf` `.glb` `.obj` `.fbx` `.stl` `.dae` `.ply` `.3ds` |
| **专有二进制（仅分类）** | `.max` `.blend` |
| **压缩包** | `.zip` `.7z` `.rar` `.tar` `.gz` `.xz` `.tgz` `.txz` |
| **文本（只读预览）** | `.txt` `.md` `.json` `.cfg` `.ini` `.log` `.csv` `.xml` `.yaml` `.yml` |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    主进程 main.js（Node.js / Electron）              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ BrowserWindow │ │ mmd:// 协议  │ │ IPC Handlers │ │7zip/解压缓存│ │
│  │ createWindow │ │ registerMmd  │ │ registerIpc  │ │extractArchive│ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬──────┘ │
└─────────┼────────────────┼────────────────┼─────────────────┼────────┘
          │                │                │                 │
┌─────────┼────────────────┼────────────────┼─────────────────┼────────┐
│      contextBridge    CORS headers    invoke/handle        spawn      │
│         (preload)    Access-Control-*   ipcRenderer      python.exe  │
└─────────┼────────────────┼────────────────┼─────────────────┼────────┘
          ▼                ▼                ▼                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  渲染进程 renderer/（Chromium / ESM）                 │
│  ┌──────────────┐  ┌───────────────────────────────────┐              │
│  │ index.html   │  │  renderer.js (5167 行)            │              │
│  │ · 工具栏     │  │  ├─ DOM & 状态 & PARAMS 系统       │              │
│  │ · 侧边栏     │  │  ├─ 导航栈 / 面包屑 / 文件树       │              │
│  │ · 视口       │  │  ├─ Three.js 场景/相机/灯光/地面   │              │
│  │ · 信息栏     │  │  ├─ 后处理管线 7 Pass              │              │
│  │ · 状态栏     │  │  ├─ 模型/Mod/通用格式加载管线      │              │
│  │ · 渲染面板   │  │  ├─ MMDAnimationHelper (IK+物理)   │              │
│  │ · 动画面板   │  │  ├─ 组合/移动/拖拽/抖动修复        │              │
│  └──────────────┘  │  └─ animate 固定步长 + resize 防抖 │              │
│  ┌──────────────┐  └───────────────────────────────────┘              │
│  │ styles.css   │  设计令牌 / 玻璃拟物 / 工具栏分区 / 文件树 Win10 风 │
│  └──────────────┘                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

**跨进程数据流：**
1. 渲染进程通过 `window.mmdAPI.<method>()` 调用 IPC → preload 转发 → main.js 的 `ipcMain.handle`。
2. 所有本地资源经 `mmd://local/<绝对路径>` 协议（由 `protocol.handle('mmd', …)` 注册）返回带 CORS 头的 `Response`，绕开 CSP 的 `file://` 限制。
3. Python 子进程仅在首次遇到未缓存的 BC7 DDS 时触发（`scripts/decode_dds.py` + `texture2ddecoder`）。

---

## 3. 目录结构与文件行数

```
MMDModelViewer/
├── main.js                        2024 行    # Electron 主进程：窗口、IPC、协议、解压
├── preload.js                      98 行    # contextBridge：暴露 mmdAPI
├── package.json                                # 脚本/依赖/electron-builder 配置
├── renderer/
│   ├── index.html                 384 行    # 页面骨架：工具栏/三栏/动画面板/渲染面板
│   ├── styles.css                1794 行    # 深色玻璃 UI 令牌 + 所有组件样式
│   └── renderer.js               5167 行    # 渲染主逻辑（ESM bundle 入口）
├── scripts/
│   └── decode_dds.py               51 行    # BC7/DXT1-3 DDS → PNG（Python + texture2ddecoder）
├── vendor/
│   └── 7za.exe                              # 运行时 7zip 解压二进制（asarUnpack）
├── docs/superpowers/
│   ├── plans/*.md                           # 功能规格前的实现计划（3 份）
│   └── specs/*.md                           # 功能设计规格（3 份）
├── check_dds.py                             # 开发期 DDS 诊断辅助脚本
└── README.md / CODE_WIKI.md                 # 项目与本 Wiki 说明
```

**打包产物**：`renderer/bundle.js` 由 esbuild 打包（约 1.8-1.9 MB，带 sourcemap）。

---

## 4. 主进程 main.js（2024 行）

### 4.1 启动与路径约定

```
APP_DIR          安装/便携版：process.execPath 所在目录；开发：__dirname__
CACHE_BASE       <APP_DIR>/data        —— 安装目录旁，避免系统盘 AppData 限制
userData         非冒烟：<CACHE_BASE>；冒烟：<项目根>/.smoke-userdata
DEFAULT_ROOT     <APP_DIR>/mods
SETTINGS_FILE    <userData>/settings.json   —— 仅存 root（用户自定义根目录）
```

关键函数：

- **createWindow()** [main.js:89-116](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L89-L116)
  - 窗口尺寸 1440×900，最小 1000×640；`backgroundColor: #0B0E14` 消除启动白闪
  - `contextIsolation: true` + `nodeIntegration: false` + `sandbox: false` + `webSecurity: true`
  - `setMenuBarVisibility(false)`（无边框工具栏取代菜单栏）
  - `MMD_DEVTOOLS=1` 时自动打开独立 DevTools

### 4.2 mmd:// 自定义协议

- **registerMmdProtocol()** [main.js:140-182](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L140-L182)
  - URL 形式：`mmd://local/D:/素材/3D模型/a.pmx`
  - `protocol.handle('mmd', …)` 返回带 `Access-Control-Allow-Origin: *` + `Cache-Control: no-store` 的 Response
  - **贴图绝对路径兜底**：当 mmd:// 指向的贴图文件不存在（游戏导出 FBX 把作者机器绝对路径写进二进制），沿 URL 目录链向上找最近存在目录 + 按 basename 搜索，通常能定位到模型同目录下同名贴图

**MIME 表**（MIME_TYPES）覆盖 png/jpg/bmp/gif/webp/tga/dds/pmx/pmd/vmd/vpd/json/wasm 等。

### 4.3 目录扫描与文件分类

- **scanDir(rootPath, depth=0)** [main.js:185-217](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L185-L217)：递归目录树（最大深度 8），条目包含 `{name, path, type, size, children[]}`；排序：目录在前 + `zh-CN.localeCompare`，以 `.` 开头隐藏文件忽略
- **fileKind(p)**：基于扩展名将文件归入 `model/archive/text/file`，扩展集常量：
  - `MODEL_EXTS`（.pmx/.pmd/.vmd/.vpd + 通用 + .max/.blend）
  - `ARCHIVE_EXTS`（.rar/.zip/.7z/.tar/.gz/.xz）
  - `TEXT_EXTS` / `MOTION_EXTS`
- **scandir-flat**：单层子项（面包屑快速导航用）

### 4.4 压缩包解压与持久化 LRU 缓存

核心函数：**extractArchive(archivePath)** [main.js:286-409](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L286-L409)

```
命中顺序：
  1) 运行期内存 Map → 直接返回 dest
  2) 持久化签名命中：md5(archivePath|size|mtimeMs).slice(0,20)
      -> 目录非空校验 + fs.utimesSync() 刷新 mtime（刷新 LRU 热度）
  3) 实际解压：
      - .rar → node-unrar-js (WASM，支持 RAR5 + 中文)
      - .tar/.gz/.xz/.tgz/.txz → 7za
      - .zip/.7z/其他 → 7zip-min (7za)；带密码/分卷/空包诊断
  4) 失败清理残留目录；成功后异步 pruneExtractCacheIfNeeded()
```

- **pruneExtractCacheIfNeeded()** [main.js:249-284](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L249-L284)：阈值 `EXTRACT_MAX_ENTRIES=64` 目录 或 `EXTRACT_MAX_BYTES=8GB`，超过任一按目录 mtime 升序（最旧）删除，直到双阈值合规
- 缓存目录：`<userData>/Cache/extract/<sig>`

### 4.5 7za.exe 路径处理（非常关键）

```js
const SEVENZA_BIN = app.isPackaged
  ? path.join(__dirname, 'vendor', '7za.exe').replace('app.asar', 'app.asar.unpacked')
  : path.join(__dirname, 'vendor', '7za.exe');
seven.config({ binaryPath: SEVENZA_BIN });
```

**原因**（经验教训）：
1. `7zip-bin` 自带的 7za.exe 在打包期会被 winCodeSign 的符号链接权限问题替换成容错 wrapper，wrapper 会把真实 exit code 2 误判为成功
2. `7zip-min` 的 argv 启发式路径改写依赖 `process.argv[1]` 是否含 `app.asar`，打包版 argv 不含该串 → 静默从 asar 内部 spawn → ENOENT
3. **因此两条规则**：`vendor/7za.exe` 必须列入 `package.json` 的 `build.files` + `asarUnpack`，且 main.js 必须显式 `seven.config({binaryPath})`。

### 4.6 load-mod-archive：XXMI Mod 解析

`ipcMain.handle('load-mod-archive', ...)` [main.js:692-805](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L692-L805)

流程：
1. `extractArchive` 解压到持久化目录
2. 递归查找 `.ini`（3DMigoto/XXMI 描述符）
3. **简易 INI 解析**：识别 `[Section]` 头 + `k=v` 行 + 行内 `;` 注释截除
4. 收集 **Resource 定义**（有 `filename` 的节）：记录 `filename/stride/type/format`
5. 收集 **draw call（TextureOverride 段）**：要求有 `ib=` 和 `drawindexed=indexCount, startVertex, startIndex`，且 `ib !== 'null'`
6. **前缀匹配算法**匹配 Position/Texcoord 资源：
   - `TextureOverrideColumbinaEyeHead` vs `ResourceColumbinaEyePosition`
   - 去掉前缀后按最长公共前缀匹配，保证复杂命名（Head/Body 等）不会错配
7. 查找 diffuse 贴图：优先 `ps-t1`，其次 `ps-t0`
8. 返回 `{modName, modDir, parts[]}`，每个 part 包含 position/texcoord/index/diffuseTexture 的绝对路径与 stride

### 4.7 decode-dds-to-png：CPU BC7 解码

`ipcMain.handle('decode-dds-to-png', ...)` [main.js:809-869](file:///D:/Program%20Files/code/MMDModelViewer/main.js#L809-L869)

**背景**：Electron Chromium 在部分机器（如无独立显卡驱动）会退回 SwiftShader 软件渲染，会**假阳性**报告 `EXT_texture_compression_bptc` 扩展存在，但 BC7 硬解返回灰/黑像素。

**缓存**：`<userData>/dds-png-cache/<basename>_<size>_<mtime>.png`，命中且 mtime≥源直接返回。

**Python 查找**：`D:\\Python312\\python.exe → C:\\Python312\\python.exe → PATH 中 python`，`PYTHONPATH=<tmp>/pylibs`，脚本 `scripts/decode_dds.py` 调用 `texture2ddecoder.decode_bc7/bc1/bc2/bc3` + Pillow 存 PNG。

### 4.8 其他 IPC 总览

| IPC 名称 | 主要作用 |
| --- | --- |
| `scan-dir` / `scandir-flat` | 递归 / 单层目录扫描 |
| `extract-archive` / `list-archive-contents` | 解压 / 仅列出条目（list 失败时退化为 scandir 扫描解压目录） |
| `load-mod-archive` / `scan-mod-archives` | 加载单个 Mod / 扫描根目录下所有含 `.ini` 的压缩包（Mod 库过滤） |
| `decode-dds-to-png` | BC7 DDS → PNG CPU 解码 |
| `choose-dir` / `show-open-dialog` / `save-screenshot` | 原生对话框（选目录/文件/保存截图） |
| `get-default-root` / `get-root-settings` / `set-default-root` | 根目录管理（持久化 settings.json） |
| `get-motion-root` / `get-scene-root` | 动作/场景库根目录（`<根>/动作`，`<根>/场景`） |
| `read-text-file` | 读取前 N 字节（默认 2MB），UTF-8 含大量 U+FFFD 时退 latin1 |
| `get-ammo-libs-dir` | ammo.wasm 所在目录绝对路径 |
| `get-cache-dir-info` / `start-resource-scan` / `cancel-resource-scan` / `cache-selected-resources` / `get-cache-index` / `delete-cache-items` / `clear-cache` / `write-cache-thumb` | 资源扫描 + 缓存管理（见第 12 章） |
| `scan-progress` / `scan-done` / `cache-progress` / `cache-done` | 事件订阅（扫描/缓存进度） |

---

## 5. Preload 桥接 preload.js（98 行）

**唯一职责**：通过 `contextBridge.exposeInMainWorld('mmdAPI', {...})` 把所有 IPC 和 `mmdUrl()` 暴露给渲染进程。

- 渲染进程使用：`const api = window.mmdAPI;`
- `mmdUrl(filePath)`：将 Windows 反斜杠路径统一为正斜杠后拼成 `mmd://local/<path>`，供 `fetch/TextureLoader/MMDLoader` 直接使用
- 所有 IPC 方法都返回 `Promise`，事件订阅方法（`onScanProgress` 等）接收回调并内部用 `ipcRenderer.on` 转发

---

## 6. 渲染进程 renderer/

### 6.1 入口与 ESM 导入

`renderer.js` 是 ESM 模块，顶部导入 Three.js 所有依赖（都从 `node_modules/three/examples/jsm/**` 直接引用，esbuild 打包时会树摇）：

- **控制**：`OrbitControls`
- **加载器**：`MMDLoader / GLTFLoader / OBJLoader + MTLLoader / FBXLoader / TDSLoader / STLLoader / PLYLoader / ColladaLoader / DDSLoader`
- **动画 & 物理**：`MMDAnimationHelper`（含 IK、Ammo 物理、动画混合）
- **后处理**：`EffectComposer / RenderPass / OutlinePass / ShaderPass / OutputPass / UnrealBloomPass / SAOPass / FXAAShader`

### 6.2 全局核心状态（renderer.js 顶部）

```
currentRoot / currentDirPath / currentModelPath          —— 当前目录/模型
currentModel / currentMesh                                —— 当前角色模型 & mesh
sceneItems[{mesh, node, kind}]                            —— 场景集合（'scene' 背景 + 'placed' 可动）
composeTargetMesh / composeSelected                       —— 组合面板放置 & 选中
mmdHelper (MMDAnimationHelper) / ammoReady                —— 动画/物理
vmdFiles[] / motionRootItems[] / modRootItems[]           —— 动作/Mod 列表
dirDescendants Map                                        —— Win10 文件树：dirPath -> 后代 rows（展开父级时重置可见性）
PARAMS{ 'group.key': value } / PARAM_DEFS(DEFAULT_PARAMS) —— 参数系统
navStack.back[] / navStack.forward[]                      —— 前后导航栈
animPanelUserCollapsed (bool)                             —— 用户主动收起动画面板（与"无动作隐藏"区分）
```

### 6.3 核心函数索引（关键锚点）

| 函数/代码段 | 位置 | 说明 |
| --- | --- | --- |
| `DEFAULT_PARAMS` | renderer.js:118-194 | 参数定义：5 大组 × 50+ 项（类型 t + 默认 v + 范围） |
| `flattenParams/loadParams/saveParams/getParam/setParam/applyParam` | 199-370 | 参数序列化 + 实时 apply 映射到灯光/后处理/shader |
| `_PRESETS` (film/natural/studio/custom) | 474-663 | 三套预设 override 表 + 空 custom；`applyPreset(name)` 批量覆盖 |
| `injectEnhancementShader(mat)` | 708-807 | Fresnel Rim + 假倒角 (Normal Wrangle) Shader 注入 onBeforeCompile |
| `ContactShadowsShader` | 813-882 | 屏幕空间接触阴影：深度→法线叉乘→10 步光线步进 |
| `buildHelperOptions / syncIkSolverForMesh / tunePhysicsForMesh` | 883-983 | MMDAnimationHelper 配置 + Ammo 刚体阻尼/摩擦/重力调优 + IK 求解参数同步 |
| WebGLRenderer/scene/camera/controls 初始化 | 1003-1037 | ACES toneMapping + PCFSoftShadowMap + useLegacyLights=false（PBR 物理光照） |
| skyMesh ShaderMaterial + setSkyboxEnabled | 1041-1100 | 程序化渐变穹顶（天顶-中部-地平线）+ 太阳辉光；切换联动背景色/雾 |
| buildPMREnvMap (Canvas 2D equirect) | ~1100-1220 | 基于 sky 颜色画 equirectangular panorama → PMREMGenerator → envMap |
| **后处理管线构建** | 1220-1282 | RenderPass → SAO → Outline → Bloom → ContactShadows → FXAA → Output |
| 三层地面（grid + shadow + PBR） | 1284-1309 | GridHelper 网格 + ShadowMaterial 接收层 + MeshStandardMaterial 反射层 |
| `setStatus / fmtSize / iconFor / kindLabel` | 1311-1368 | 状态栏 + 图标/类型标签工具 |
| 面包屑/导航栈 `pushNavHistory/goBack/goForward/goUp/navigateTo` | 1370-1468 | 80 深栈 + 三个库（models/motions/scenes）独立根 |
| `renderTree` + `toggleDir` | 1654-1800 | Windows 10 文件树（每行三列网格：缩进+图标 / 名称 / 大小）；父级展开重置后代可见性 |
| `handleArchive` | 2057-2300 | 压缩包预览 → 自动识别内部根模型（pmx/pmd/fbx/...）→ `listArchiveContents` 失败兜底直接解压 |
| `handleModelFile` / `handleMotionFile` | 约 2350-2680 | 单/双击加载模型；区分角色模型 vs 场景模型 vs 放置模型 |
| `loadModel(node, opts)` | 2688-2816 | **核心模型加载**：MMD → MMDLoader → clearModel/加入 scene → mmdHelper.add → IK/物理调优 → frameModel → 信息面板 → setupVmdList |
| `loadGenericModel` | ~2700 分支 | GLB/FBX/OBJ 等通用格式分流加载（无 IK/物理/MMD 动作） |
| `loadDDSTextureBC7 / loadDDSTexture` | 2826-2920 | 原生 GPU BPTC 路径（非 SwiftShader）+ main.js CPU 解压 PNG 路径；失败回 DDSLoader(DXT1-3) |
| `loadModArchiveAsMesh` | ~2920-3100 | 根据 main 返回的 parts[] 读 .buf/.ib → BufferGeometry + MeshStandardMaterial + DDS 贴图 |
| `setAnimPanelVisible` / `setupVmdList` | 3249-3300 | 动画面板可见性（区分无动作隐藏 / 用户收起）；仅当前角色模型显示 |
| `playVmd` | 3312-3460 | VMD 加载 → mmdHelper.add(animation) → 切动作余辉 + 同步 IK/物理 + 状态 UI |
| **`animate()` 固定步长循环** | 3476-3600 | `STEP=1/60` 累积追赶 + `MAX_CATCH=5` 限次；mmdHelper.update + controls.update + composer.render；**GC 优化复用 Vector/Color** |
| `resize()` | 3605-3660 | 取 `#viewport.clientWidth/Height` (不用 canvas)，尺寸相同直接返回；缓存 devicePixelRatio 避免重建 FBO |
| 移动模式 `moveModeTarget/restoreDragPhysics` | 3662-3800 | **拖拽物理抖动修复关键**：pointerdown 保存 physics 置 null → 拖拽地面 XZ → pointerup 先 `mesh.updateMatrixWorld(true)` 再 `physics.reset()` + 清零所有刚体速度 + 8 帧 warm start |
| `markMaterialsNeedsUpdate()` | 531 | 遍历所有 mesh 材质，触发 onBeforeCompile 重编译（Fresnel/假倒角参数变化时） |
| `doScreenshot` | ~4500 左右 | `renderer.domElement.toDataURL('image/png')` → IPC 保存；preserveDrawingBuffer=true 保证读到有效 |
| `bindToolbar*` / `bindAnimPanelCollapse` | ~4700-5100 | 工具栏按钮、渲染快捷面板 UI 绑定；动画面板收起/展开与迷你 tab |
| `__mmdTest` 钩子 | 约末尾 | 冒烟测试 hook：`screenPointFor/dragAt/placedMesh/loadAsCurrent/current/selected/meshByName/focusMesh` |

---

## 7. 资源处理流水线

### 7.1 MMD 模型加载（主路径）

```
用户双击/单击文件 → handleModelFile → loadModel(node, {asScene?})
  ├─ 替换当前角色 → clearModel()（清 currentModel & 当前角色 mesh & helper 对象）
  ├─ 加入场景（asScene=true）→ sceneItems.push，不影响角色模型
  └─ MMDLoader.load(mmdUrl)
      ├─ MMDLoader 内部 TextureLoader 通过 mmd:// 协议加载贴图
      ├─ fixEmptyMorphAttributes(mesh) —— 修正空 morph 导致 animation clip 构建失败
      ├─ scene.add(mesh)
      ├─ mmdHelper.add(mesh, buildHelperOptions(mesh))
      │   ├─ physics（ammo.wasm 就绪 + 刚体≤200）：unitStep 1/120 + gravity 6.2×10 + maxStepNum 3
      │   ├─ onCreatedPhysics：Ammo 刚体 setDamping(0.45,0.55) / setSleepingThresholds(0.08,0.12) / setFriction 0.6 / setRestitution 0.05
      │   └─ IK 由 MMDAnimationHelper 内部基于 mesh.userData.ik 创建
      ├─ syncIkSolverForMesh：iteration 50 + toleranceAngle 0.08（从 PARAMS 读）
      ├─ tunePhysicsForMesh：清零速度 + 重复调优 + world.setGravity（PARAM.gravity 变更时实时生效）
      └─ UI：frameModel（相机聚焦）→ showModelInfo → setupVmdList（刷新动作列表+面板）
```

### 7.2 XXMI/3DMigoto Mod 加载

```
用户点击「🎮 加载 Mod」或 Mod 库项 → api.loadModArchive(archivePath)
  ├─ main.js 解压 → 找 .ini → 解析 Resource + TextureOverride draw calls → parts[]
  └─ renderer loadModArchiveAsMesh({modName, modDir, parts})
      ├─ 对每个 part：
      │   ├─ positionFile (Float32 stride=xz0+yz1+y? stride) → position Array
      │   ├─ texcoordFile（offset 4=U, offset 8=1-V，3DMigoto 标准）→ uv Array
      │   ├─ indexFile（uint32 或 uint16 按 stride 推断）→ index Array
      │   ├─ BufferGeometry(position/uv/normal compute + index)
      │   └─ diffuseTexture：loadDDSTexture(diffuseTexture) → MeshStandardMaterial(map)
      └─ Group（所有 parts）加入 scene + frameModel + showModelInfo
```

### 7.3 DDS 贴图加载路径

```
loadDDSTexture(ddsPath)
  ├─ 主路径：api.decodeDdsToPng(ddsPath) → userData/dds-png-cache/*.png → api.mmdUrl(pngPath) → TextureLoader 加载 → SRGBColorSpace + Mipmap + Anisotropy
  ├─ 回退 A：loadDDSTextureBC7(mmdUrl) → fetch → DataView 解析 DDS DX10 header → dxgiFormat=99(BC7) → WebGL EXT_texture_compression_bptc → THREE.CompressedTexture(BC7 block)
  │   （注意：SwiftShader 软件渲染会假阳性支持扩展，此路径读回来是灰/黑，必须用主路径）
  └─ 回退 B：DDSLoader（DXT1/3/5 经典）
```

### 7.4 VMD 动作播放

```
setupVmdList(mesh)
  ├─ isCurrentRole(mesh) 检查：非当前角色不显示面板
  ├─ 合并 vmdFiles（同目录）+ 动作库根目录动作
  └─ 列表每项点击 → playVmd(vmdNode, mesh, el)
      ├─ MMDLoader.loadAnimation(mmdUrl, mesh)
      ├─ mmdHelper.add(mesh, { animation, physics: {...} })
      │   （重新 add 会替换旧 animation + 重建 ikSolver/physics）
      ├─ syncIkSolverForMesh + tunePhysicsForMesh(forceApplyDamping=true)
      ├─ currentAnimating = true + 按钮切换
      └─ animate() 每帧 mmdHelper.update(delta * speedScale)
```

**animate 固定步长机制**（见 10.4 节）：`STEP=1/60s` 累积追赶 + `MAX_CATCH=5` 防止后台切回时物理爆炸。

---

## 8. Three.js 渲染架构

### 8.1 渲染器基础设置（renderer.js:1005-1016）

```js
renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(min(devicePixelRatio, 2));              // pixelRatioMax 默认 2，可调 1-3
renderer.outputColorSpace = THREE.SRGBColorSpace;               // 物理正确颜色管线
renderer.toneMapping = THREE.ACESFilmicToneMapping;             // 电影级色调映射
renderer.toneMappingExposure = 0.95;                             // 默认 0.95（防 overexpose）
renderer.useLegacyLights = false;                                // PBR 物理光照（不再用旧的 1600cd 近似）
renderer.shadowMap = { enabled: true, type: PCFSoftShadowMap }; // 可由 shadowSoftness → Basic/PCF/PCFSoft/VSM
```

### 8.2 相机 & 控制

```
PerspectiveCamera(45°, aspect, 0.1, 1000)
  position (0, 2.2, 5.2)
  target (0, 1.1, 0) —— 角色腰部位置，便于预览站立 MMD 模型
OrbitControls
  enableDamping=true, dampingFactor=0.08
  minDistance=0.3, maxDistance=60
```

### 8.3 灯光系统（5 盏灯，全部参数化）

| 灯光 | 类型 | 默认强度 | 颜色 | 阴影 | 备注 |
| --- | --- | --- | --- | --- | --- |
| AmbientLight | 全域环境 | 0.65 | 白 | — | 基础打底 |
| HemisphereLight | 上蓝下灰 | 0.60 | sky=0xB1C5FF, ground=0x8B7355 | — | 天空漫射色 |
| DirectionalLight（主方向光） | 前上 45°左 | 1.0 | 0xFFF1DC（暖） | 2048×2048 PCFSoft | 柔光时 1024 + 大 bias |
| SpotLight（Key 聚光） | 前上右 30°圆锥 | 6.0 | 0xFFE8BF | 2048 map + penumbra 0.35 | 立体感主光 |
| DirectionalLight（Rim 轮廓光） | 后上左逆光 | 1.1 | 0xFFC890（暖橙） | — | 边缘分离背景 |

**硬光模式联动**：dirLight shadow → 小 radius(0.15)、小 bias(-0.00012)、2048 map、`PCFShadowMap`；keyLight penumbra ≤ 0.38 + 2048 map。**柔光模式反之**。

### 8.4 天空盒 + 雾 + PMREM 环境贴图

- **天空盒**（程序化 ShaderMaterial）：直径 500m 球体，BackSide + 关闭 depthWrite。三段颜色渐变（top: `#1a3a6e` → mid: `#5a8fcf` → bottom: `#f5d8b8`）+ 方向向量太阳辉光（pow 120 硬盘 + pow 6 光晕）。`skyboxEnabled=false` 时 skyMesh.visible=false 且 scene.fog=null。
- **雾**：`THREE.Fog(#88AADD, 60, 180)`；背景色变时雾颜色按 `bgColor × 0.78 lerp 0x0B0E14 by 0.35` 重新混合，保证天空/雾视觉一致。
- **PMREM 环境贴图**：直接用 Canvas 2D 画一张 equirectangular panorama（模拟天空盒三段色） → `PMREMGenerator.fromEquirectangular` → `scene.environment`。**简化版只生成 1 张 WebGLRenderTarget**（之前用 Scene + Renderer 方案消耗 7 个 context，现减少到 1）。

### 8.5 三层地面

```
1. GridHelper(20, 20, 0xCBD5E1, 0xE2E8F0)
   opacity 0.35 transparent=true —— 网格参考线
2. ShadowMaterial(opacity 0.35) Plane(60×60)，Y=-0.001
   仅接收阴影不绘制颜色 —— 让阴影落到地面
3. MeshStandardMaterial(color 0x2a2f3a, roughness 0.85, metalness 0.08) Plane(60×60)
   receiveShadow —— 提供 PBR 反射质感 + 粗糙度变化
```

### 8.6 后处理管线（7 Pass 顺序固定）

| 顺序 | Pass | 作用 | 可开关 |
| --- | --- | --- | --- |
| 1 | `RenderPass(scene, camera)` 带 `DepthTexture` | 基础渲染 + 输出深度给后续 SSAO/ContactShadows | 否 |
| 2 | `SAOPass`（SSAO 近似） | 褶皱/缝隙屏幕空间环境遮蔽 | ssaoEnabled |
| 3 | `OutlinePass` | 基于法线/深度的描边；选择对象高亮时加入 selectedObjects | outlineEnabled |
| 4 | `UnrealBloomPass` | 高亮阈值 → 高斯 → 叠加泛光 | bloomEnabled |
| 5 | 自定义 `ShaderPass(ContactShadowsShader)` | 10 步屏幕空间光线步进接触阴影 | contactShadowsEnabled |
| 6 | `ShaderPass(FXAAShader)` | 快速近似抗锯齿 | fxaaEnabled |
| 7 | `OutputPass` | sRGB 编码输出（ACES 输出转换） | 否 |

所有 Pass 引用通过 `window.__postfx = { composer, renderPass, outlinePass, fxaaPass, contactShadowsPass, outputPass }` 暴露，`applyParam` 据此实时同步开关/滑杆。

### 8.7 Shader 注入（Fresnel Rim + 假倒角）

`injectEnhancementShader(mat)` 在每个 MeshStandardMaterial 上挂载 `onBeforeCompile`。**去重缓存** `mat.__enhCache` 避免参数未变时重复注入。

- **顶点**：追加 `vEnhWorldNormal / vEnhWorldPos / vEnhViewDir` varying。
- **假倒角（normal wrangle）**：`_enhBevelNormal(N, pos)` 用 `dFdx × dFdy = faceN` 与 smooth normal 按 sharp=`smoothstep(0.55,0.92,1-dot)` 混合，硬边对齐面法线，平滑区保持原 normal；TBN 空间有 normal map 时重新投影回 tangent space。
- **Fresnel Rim**：dithering_fragment 之后追加 `gl_FragColor.rgb += rimColor * pow(1-dot(N,V), rimPower) * rimIntensity`。

`markMaterialsNeedsUpdate()` 遍历 `currentModel / sceneItems[*].mesh` 的材质，**当 `fresnel* / shaderBevel*` 参数变化时触发重新编译**。

---

## 9. UI 架构与设计令牌

### 9.1 设计令牌（styles.css:root）

```
── 背景层 ──────────────────────────────────────────────
--bg-base              #0B0E14        应用根背景（同 backgroundColor 防白闪）
--bg-glass             rgba(20,24,33,0.70)   工具栏/面板玻璃底
--bg-glass-strong      rgba(22,27,37,0.92)   浮层加强玻璃
--bg-sidebar           rgba(16,20,28,0.60)   左侧栏
--bg-hover/selected    #7C5CFF 10%/16%       悬停/选中高亮

── 文字 ───────────────────────────────────────────────
--text                 #E8ECF4        主文字
--text-secondary       #B8C0D0        次级
--text-muted/dim       #8A93A8 / #5D6678   辅助/最暗

── 主色 Violet + 辅助 Cyan ──────────────────────────────
--accent               #7C5CFF        主题色（按钮/选中/焦点）
--accent-hover         #6D4FE0
--accent-border        rgba(139,92,246,0.40)
--accent-2             #38BDF8        辅助青（信息/数量徽标）

── 语义色 ─────────────────────────────────────────────
--warn/success/danger  #FBBF24 / #34D399 / #F87171

── 圆角：sm(6) md(8) lg(12) xl(16) full(999)
── 阴影：sm/md/lg/xl + glow-accent
── 过渡：t-fast 120ms / t-norm 200ms
```

应用根背景用了两层径向渐变（左上角紫 `rgba(124,92,255,0.14)` + 右下角青 `rgba(56,189,248,0.10)`）叠在 `--bg-base` 上，给深色玻璃增加专业氛围。

### 9.2 index.html 结构分区

```
#app (flex column, 100vh)
├── #toolbar                 顶部玻璃工具栏
│   ├── .tb-group.tb-brand          ◀ 折叠 + 应用标题
│   ├── .tb-group.tb-import         📂 添加模型 / 🗜 导入压缩包 / 🎮 加载 Mod / 📁 浏览 / 📌 根目录 / 刷新
│   ├── <spacer>
│   ├── .tb-group.tb-view           🖐 移动模式 / 🧹 清空场景 / 重置视角 / 🌤 天空盒 / ⚙️ 渲染设置 / 📸 截图
│   └── .tb-group.tb-misc           自动缓存开关 + root-path + ▶ 信息栏折叠
│
├── #main (flex row)
│   ├── #splitter-left              左右栏拖拽分割条
│   ├── #sidebar (左侧栏，可折叠)
│   │   ├── .library-cards × 7      🧊模型 🎬动作 🌆场景 🎮Mod 💾缓存 🧩组合 🕘最近
│   │   ├── .breadcrumb-bar         导航按钮 + 面包屑路径
│   │   └── .side-views (切换显示)
│   │       ├── data-view=models    文件目录 file-tree（Win10 扁平风）
│   │       ├── data-view=motions   动作目录 motion-list + 搜索
│   │       ├── data-view=scenes    场景目录 scene-tree
│   │       ├── data-view=mods      Mod 库 mod-list + 搜索
│   │       ├── data-view=cache     缓存资源（模型/场景/动作 三组）
│   │       ├── data-view=compose   组合编排（已加载模型 + 操作区 3 步）
│   │       └── data-view=recent    最近加载 recent-list
│   │
│   ├── #viewport (flex 1, 中央视口)
│   │   ├── canvas#gl-canvas        WebGL 渲染目标
│   │   ├── .view-hint              交互提示
│   │   ├── .render-quick-panel     ⚙️ 渲染快捷浮层（预设 + 开关×14 + 滑杆×5）
│   │   ├── .preview-card           模型预览卡
│   │   ├── .archive-preview        压缩包内容浮层
│   │   ├── #anim-panel             🎬 动作播放（VMD 列表 + 播放控制 + 速度）
│   │   └── #anim-mini-tab          收起动画面板后的迷你展开按钮（右下角）
│   │
│   ├── #splitter-right             视口/信息栏分割条
│   └── #info-panel (右侧信息栏，可折叠)
│       ├── .tab-bar × 3            模型信息 / 参数面板 / 缓存资源
│       ├── data-view=info          model-info（名称/路径/顶点面/贴图列表）
│       ├── data-view=params        5 param-group：渲染 / 物理 / IK / 动画 / 组合
│       └── data-view=cache         缓存 grid + 清空按钮
│
└── #statusbar                      状态栏（status-text + status-detail）
```

### 9.3 Windows 10 风格文件树

`renderTree` 生成的每一行是 CSS Grid 布局：
- `grid-template-columns: [indent] auto [name] 1fr [size] auto`
- 缩进用 `span.icon-prefix × level`（每级 16px + 引导线 `::before`）
- 目录展开 `toggleDir(dirPath)` **会重置所有后代行的可见性状态**（防止祖先折叠状态污染，匹配 Windows 10 Explorer 行为），通过 `dirDescendants: Map<dirPath, Set<row>>` O(1) 访问

### 9.4 渲染快捷面板（.render-quick-panel）

工具栏 ⚙️ 按钮打开：
1. **预设**：🎞 电影质感 / 🌤 自然预览 / 🎬 原色工作室 / 🎛 自定义
2. **光照与显示开关组**（6）：硬光/Key/Rim/阴影/网格/天空盒
3. **后处理与材质增强开关组**（7）：描边/FXAA/Bloom/接触阴影/SSAO/Fresnel/假倒角
4. **关键强度滑杆**（5）：主光 / Key 聚光 / Bloom / 接触阴影 / Rim Shader

所有控件绑定参数系统：`data-rk` → `applyParam('render', rk, value)`；预设切换通过 `__presetApplyingLock` 防止单项 apply 触发自定义跳转。

### 9.5 动画面板收起逻辑

- `animPanelUserCollapsed`（状态）区分**用户主动收起** vs **无动作自然隐藏**。
- 切换模型/清空场景时，清除收起状态 → 有动作自动显示。
- 用户点击 `—` 按钮：`animPanel.classList.add('hidden')` + 显示右下角 `#anim-mini-tab`（🎬 动作）。
- 再次点击迷你 tab → 恢复面板。

---

## 10. 关键机制深入

### 10.1 拖拽移动后布料剧烈抖动修复（核心经验）

**根因**：three.js MMDPhysics 中 static 刚体每帧经 `updateFromBone` 从骨骼 matrixWorld 同步位置；dynamic 刚体（布料/裙摆）由 Ammo 物理引擎控制。整体移动模型后 static 跟随骨骼移到新位置，但 dynamic 停留在旧位置，二者被约束弹簧反复拉扯 → **约束发散抖动**。

**完整修复方案** `restoreDragPhysics`：

| 时机 | 动作 |
| --- | --- |
| pointerdown（开始拖拽） | 1) `dragState._savedPhysics = mmdHelper.objects.get(mesh).physics`<br>2) 将 `mmdHelper.objects.get(mesh).physics = null` —— helper.update 每帧取 physics 时跳过 → 物理暂停，布料跟随骨骼无错位 |
| pointermove | 只改 `mesh.position.x/z`（XZ 地面拖拽，Y 保持不变；取消所有 Shift/Ctrl 轴向模式） |
| pointerup / pointercancel | 1) **先 `mesh.updateMatrixWorld(true)`** —— pointerup 事件在渲染循环外，骨骼 matrixWorld 仍是上一帧旧位置，直接 reset 会复位到错误坐标！<br>2) 恢复 `physics` 对象引用<br>3) `physics.reset()` —— 所有刚体 transform 立即同步到当前骨骼坐标<br>4) 用 `p.manager.allocVector3()` 遍历所有 `bodies[*].body` 清零 linearVelocity + angularVelocity（约束 pivot 为局部坐标，随 body 平移相对关系不变）<br>5) 8 帧 warm start：helper.update 在接下来 8 帧继续清零速度，消除残余脉冲 |

**移动模式目标优先级**：`moveModeTarget()` → 优先 `composeSelected`（组合面板中选中的任意模型），否则回退 `currentMesh`（无组合时的角色单模型）。

### 10.2 mmd:// 协议贴图绝对路径兜底

游戏导出的 FBX 常把作者机器的绝对贴图路径写进二进制（如 `D:\Datamine\Fmodel\...\T_xxx.png`）。mmd:// URL 指向不存在文件 → 返回 404 → 模型显示为白。

`registerMmdProtocol` 对所有贴图扩展名请求做以下 fallback：按 URL 末尾文件名，从请求路径的父目录开始沿目录链向上，找到最近的**已存在目录**后 join(basename) 重定位 —— 通常就落在模型同目录。

### 10.3 DDS BC7 解码的双路径策略（绕过 SwiftShader 假阳性）

| 环境 | 行为 |
| --- | --- |
| 真实硬件 GPU，`EXT_texture_compression_bptc` 有效 | 两条路径都能成功（主 PNG 路径 / BPTC 回退） |
| SwiftShader 软件渲染（假阳性） | GPU BPTC 路径上传后采样恒灰/恒黑 → CPU 解压 PNG 路径**唯一正确** |
| BPTC 扩展不存在 | GPU 路径 warn 后返回 null → PNG 路径继续尝试 |

`decode_dds.py` 支持 BC7（DX10 fourCC）+ BC1/2/3（DXT1/3/5），以名 `_` 分隔 `basename_size_mtimeMs.png` 缓存。

### 10.4 animate 固定步长 + MAX_CATCH 追赶机制

```js
const STEP = 1 / 60;        // 固定物理/动画步长：1/60 秒
const MAX_CATCH = 5;        // 单帧最大追赶次数
let _accum = 0;
// _tmpVec3 / _tmpColor / _tmpBox3 等全局复用对象避免每帧 new → GC

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.5);   // 极端 delta（后台休眠）截断
  _accum += delta;

  let catches = 0;
  while (_accum >= STEP && catches < MAX_CATCH) {
    const s = Number(getParam('anim', 'speedScale', 1.0)) || 1.0;
    if (mmdHelper) mmdHelper.update(STEP * s);   // 动画 + IK + 物理（1/60 固定步）
    _accum -= STEP;
    catches++;
  }
  // warm start 8 帧清零（拖拽后） / controls.update / composer.render
  controls.update();
  composer.render();
}
```

**收益**：
- 不同刷新率（60/120/144/240 Hz）屏幕下，动画插值不抖动（骨骼位置每帧步长一致）
- 切换后台 tab 休眠回来 delta 巨大 → 限制 5 次追赶（最多 5/60≈83ms 物理），避免 Ammo 世界爆炸
- GC 极少：所有临时 Vector/Color/Box3 用模块级对象复用，canvas rect 结果缓存

### 10.5 resize() 优化与常见 bug

```js
function resize() {
  // —— 必取 #viewport（容器）clientWidth/Height，不能取 canvas.clientWidth
  // 因为 renderer.setSize 会把 canvas.style.width/height 写成固定 px，
  // 拖拽侧栏/折叠面板后 canvas.clientWidth 读到陈旧值，画布不更新！
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (w === _lastW && h === _lastH) return;        // 尺寸相同直接返回（避免 FBO 重建）
  _lastW = w; _lastH = h;
  const pr = Math.min(window.devicePixelRatio, pixelRatioMax);
  if (pr === _cachedPr) {/* 跳过 pr 相同的冗余 setPixelRatio */}
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  // 同步后处理：OutlinePass/SAOPass/ContactShadows/FXAA 的 resolution/uniforms
}
window.addEventListener('resize', debounceRaf(resize));  // rAF 级别去抖
```

### 10.6 解压缓存的签名与 LRU

```
签名 sig = md5(archivePath | size | mtimeMs).slice(0, 20)
目录 = <userData>/Cache/extract/<sig>/
```

**之前踩过的坑**：用 `Date.now()` 做签名 → 每次启动必重解压；用 `os.tmpdir()` → 重启/关机后丢失。**正确方案**：三要素（路径+大小+修改时间）组合签名，路径放在 `<userData>` 下持久化。

命中 LRU：每次命中都 `fs.utimesSync(dest, now, now)` 刷新目录 mtime，作为最近使用时间戳；`pruneExtractCacheIfNeeded` 按 mtime 升序删除。阈值 64 目录 或 8GB，双阈值独立判断（任一超即开始删）。

---

## 11. 参数系统与渲染预设

### 11.1 参数组织

```
DEFAULT_PARAMS = {
  render: {    // 46 项：预设×1 + 基础×7 + 光照×13 + 后处理×11 + 材质增强×6 + 天空盒×1
               // 类型：select / switch / range / color
  },
  physics: {   // 5 项：enabled / gravity / unitStep / maxStepNum / autoDisableHeavy
  },
  ik: {        // 3 项：enabled / iteration / toleranceAngle
  },
  anim: {      // 4 项：speedScale / loopAnimation / resetOnStop / afterglow
  },
  compose: {   // 1 项：maxPlaced（1-20）
  },
}
```

- **持久化**：`flattenParams()` 扁平化成 `{ 'render.toneMappingExposure': 0.95, ... }` → `localStorage['mmdviewer_params_v1']`
- **回灌**：启动时 `loadParams()` + `applyAllParams()`（此时 `initApplyingParams=true` 抑制状态栏噪音）
- **手动修改单项触发**：`applyParam(group, key, value, prev)` → 映射到 renderer / 灯光 / postfx / Shader recompile / 雾 等。
- **切换自定义**：手动改任何 render 组参数（renderPreset 除外）且当前预设 ≠ custom 时，自动切到 custom + 刷新 UI。

### 11.2 三套预设

| 预设名 | 典型特征 |
| --- | --- |
| **🎞 电影质感 film** | 低曝光 0.82 / 中曝光 / 柔光 / 强 Bloom 0.65 / 高 Fresnel Rim 0.55 / 天空盒开 / 硬光关 |
| **🌤 自然预览 natural**（默认） | 曝光 0.95 / Key 6.0 / Bloom 0.42 / 接触阴影 0.55 / SSAO 关 / 天空盒开 |
| **🎬 原色工作室 studio** | 曝光 0.88 / **硬光开**（强对比）/ Key 7.2 / Bloom 关 / SSAO 强度 0.9 / 假倒角开 1.5 / 天空盒关 / 阴影更黑 |
| **🎛 自定义 custom** | 不做任何批量覆盖，纯手动。任何手动改参数会自动跳转到此预设。 |

### 11.3 applyParam 关键同步点

| 参数 | 同步目标 |
| --- | --- |
| `toneMappingExposure` | `renderer.toneMappingExposure`（实时） |
| `shadowEnabled / shadowSoftness` | `renderer.shadowMap.enabled / .type`（Basic/PCF/PCFSoft/VSM）+ 所有阴影 `needsUpdate=true` |
| `hardLightMode` | dirLight/keyLight shadow.radius/bias/mapSize/penumbra + `shadowMap.type` 联动 |
| `bgColor` | `scene.background`（无天空盒时） + `_fogParams.color` 重新混合 + `scene.fog.color.copy()` |
| `skyboxEnabled` | `setSkyboxEnabled(v)`：skyMesh.visible + `scene.fog = v ? new Fog(...) : null` + `scene.background = v ? ... : bgColor` |
| `fresnel* / shaderBevel*` | `markMaterialsNeedsUpdate()` → onBeforeCompile 重编译 |
| `physics.gravity` | Ammo `physics.world.setGravity(...)`（需要通过 manager.allocVector3 分配） |
| `*Intensity / *Color`（灯光） | 对应 light.intensity / `light.color.copy(new THREE.Color(...))` —— **不能直接 `=` 赋值**，Color 引用不会更新！ |
| postfx 任何开关/滑杆 | `window.__postfx.<pass>.enabled / <uniform> / <field>` |

---

## 12. 缓存体系

本项目有三套独立缓存，命名不要混淆：

### 12.1 解压缓存（extract cache）

- **位置**：`<userData>/Cache/extract/<sig>`
- **生成方**：main.js `extractArchive`
- **命中条件**：`md5(path|size|mtime)` 签名相同 + 目录非空
- **清理**：启动时异步 `pruneExtractCacheIfNeeded()`；`clear-cache(scope='all')` 时全删
- **阈值**：64 目录 或 8GB，按 mtime 升序（LRU）

### 12.2 DDS PNG 解码缓存

- **位置**：`<userData>/dds-png-cache/<basename>_<size>_<mtimeMs>.png`
- **生成方**：`decode-dds-to-png` IPC 调用 Python 解码
- **命中条件**：PNG 文件存在且 `png.mtimeMs ≥ dds.mtimeMs`
- **清理**：`clear-cache(scope='all')` 时同时删

### 12.3 资源缓存（用户入库 cache/models + cache/motions）

- **位置**：`<userData>/Cache/{models,motions,thumbs,tmp}/`
- **索引**：`<userData>/Cache/index.json`（items[]：id/name/ext/sourcePath/sourceType/thumbPath/sizeEstimate）
- **流程**：
  1. `startResourceScan({roots, intoArchives?})` → 扫描所有文件 + 压缩包内部条目（intoArchives 时遍历识别） → 事件 `scan-progress` + `scan-done(candidates[])`
  2. 用户勾选候选 → `cacheSelectedResources({taskId, ids[]})` → 复制到 `cache/models|motions`，生成缩略图 via `writeCacheThumb({id, base64Png})`，更新 index.json
  3. **读取**：`getCacheIndex()` / `getCacheDirInfo()` → 渲染缓存网格
  4. **删除**：`deleteCacheItems(ids[])`（同步删磁盘 + 缩略图 + index）
  5. **清空**：`clearCache('models'|'motions'|'all')`
- **注意**：`clearCache(scope='all')` 作为唯一的"超级清理"动作，必须同时执行三件事：
  1. 删 `<userData>/Cache/{models,motions,thumbs,tmp}` 及 index.json（资源库）
  2. 删 `<userData>/Cache/extract/`（解压缓存）
  3. 删 `<userData>/dds-png-cache/`（DDS 解码缓存）
  4. 清空渲染层的内存缓存引用（如 `modArchivesCache = null` 等）

---

## 13. 构建与运行

### 13.1 脚本速查（package.json）

| 脚本 | 作用 |
| --- | --- |
| `npm run build:renderer` | esbuild `renderer/renderer.js` → `renderer/bundle.js`（ESM，含 sourcemap） |
| `npm start` | 先 build:renderer → `electron .` 启动开发模式 |
| `npm run smoke` | build → `electron . --smoke-test`，独立 `.smoke-userdata` 避免污染真实数据 |
| `npm run dist` | build → `electron-builder --win`：输出 `dist/`（NSIS 安装包 + Portable 便携版） |

### 13.2 electron-builder 配置要点

```jsonc
"build": {
  "appId": "com.mmdviewer.app",
  "files": [
    "main.js", "preload.js", "renderer/**/*", "package.json", "vendor/7za.exe"
  ],
  "asarUnpack": [
    "vendor/7za.exe",                                // asar 内部无法 spawn exe
    "node_modules/7zip-bin/**",                       // （保留兼容用，实际不用）
    "node_modules/three/examples/jsm/libs/ammo.wasm.{wasm,js}"   // Ammo 物理二进制
  ],
  "win": { "target": ["nsis", "portable"] },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "createDesktopShortcut": true }
}
```

**7zip-bin 分类**：放入 `dependencies`（非 devDependencies），保证 electron-builder 会打进去（尽管运行期实际用的是 vendor/7za.exe，但未来可能引入依赖该模块的其他代码时不缺）。

### 13.3 运行期依赖环境

- **Electron 33**（Node v20.18+ 内置 Chromium 130+）
- **Python 3.12**（`D:\\Python312\\python.exe` 或 PATH 中），需要 pip 装 `texture2ddecoder` 和 `Pillow`。解码脚本把 `PYTHONPATH=<tmp>\\pylibs` 指向用户 pip 安装位置（若用户装到全局可直接 import）。
- **弹药物理**：three/examples/jsm/libs 里的 `ammo.wasm.wasm` / `ammo.wasm.js` —— 通过 asarUnpack 释放，渲染层用 `api.getAmmoLibsDir()` → mmd:// URL 加载。

---

## 14. 冒烟测试

启动参数 `--smoke-test`：
- 触发独立 userData（`.smoke-userdata`），不污染真实设置与缓存
- renderer.js 末尾挂 `__mmdTest` 钩子供外部脚本调用：
  ```js
  window.__mmdTest = {
    screenPointFor(meshOrName, heightTier=0) // 计算 mesh bbox 中心 XZ 的屏幕坐标（高度档位避免投影在视口外）
    dragAt(sx, sy, dx, dy)                   // pointerdown → 移动 dx dy px → pointerup 模拟拖拽
    placedMesh(idx)                          // sceneItems 中第 idx 个 placed mesh
    loadAsCurrent(path, {kind:'role'|'placed'|'scene'}) // 以指定模式加载模型（内部用）
    get current()                            // 当前 currentMesh
    get selected()                           // composeSelected（移动目标）
    meshByName(name)                         // 按名称从 scene 找对象
    focusMesh(mesh)                          // 相机聚焦（等同于 frameModel）
  }
  ```

### 常见冒烟用例（已验证）

| 用例 | 预期 |
| --- | --- |
| `params-reset-refresh` | 重置参数后：`applyAllParams` 正常 → UI 控件（完整参数面板 + 快捷面板 + 工具栏 active 状态）值同步 → 无 TypeError |
| `extract-cache-lru` | 放 65 个签名目录 → prune 后剩 64；写满 8.5GB → prune 后 ≤ 8GB；命中后目录 mtime 刷新 |
| `drag-damping` | 拖拽模型 300px → 松开后 `physics.reset()` + 速度清零 → 8 帧后布料无持续抖动（<0.5cm 振荡） |
| `anim-panel-states` | 新模型无动作 → 面板 hidden；加载动作 → 面板 shown；用户点 `—` → 面板 hidden + mini-tab shown；切换模型 → 收起状态清除；有动作时 shown |
| `apply-all-param-groups` | applyParam 对每个 key 在 render/physics/ik/anim/compose 5 组中均有分支，不抛 "Cannot read property of undefined" |
| `resize-debounce` | 快速 10 次窗口 resize → setPixelRatio/setSize 触发次数 ≪ 10；侧栏拖拽 500ms → 视口 canvas 同步更新（以 viewport.clientWidth 为准） |

---

## 15. 硬约束（不可违反的设计决定）

这些是项目长期迭代中被反复踩坑后锁定的决定。修改任何一项都需要先证明为什么旧方案不对。

1. **UI 必须深色玻璃专业风**，Indigo/Purple 主色 `#8B5CF6 / #7C5CFF`，窗口背景 `#0B0E14`（与 backgroundColor 同步防白闪）。浅色磨砂玻璃是废弃方向。
2. **文件选择必须使用系统原生对话框**（`dialog.showOpenDialog`）——禁止自绘文件选择器。
3. **主界面左侧栏是 7 张快速访问卡片**（模型/动作/场景/Mod/缓存/组合/最近），不展示完整文件树。文件树只出现在「模型库」和「场景库」的侧视图内。
4. **文件树是 Windows 10 列表风格**：每行一行（缩进+图标 / 名称 / 大小三列网格），无横向展开；父级展开时 `toggleDir` **必须重置后代可见性**（防止祖先折叠状态泄漏）。
5. **动画/IK/物理统一由 MMDAnimationHelper 管理**。禁止使用独立 AnimationMixer。IK / 物理开关 / 重力/ 步进 均从 PARAMS 读取。
6. **7zip-bin 必须放在 `dependencies`**（不是 devDependencies）；**vendor/7za.exe 必须分发**，打包时 `asarUnpack: ['vendor/7za.exe']`；main.js 必须在 `app.isPackaged` 时显式 `seven.config({ binaryPath: ...replace('app.asar','app.asar.unpacked') })`。
7. **`mmd://` 协议处理器必须包含贴图绝对路径 fallback**（目录链上溯 + basename 重定位）——游戏导出 FBX 绝对路径场景依赖。
8. **Mod 库只显示含 `.ini` 的 XXMI Mod 压缩包**（`scan-mod-archives` IPC 过滤），禁止把场景/模型 zip 混进来。
9. **渲染设置必须高度可定制**：快捷面板 + 完整参数面板 + localStorage 持久化 + 3 套预设；所有关键开关/强度必须实时同步 applyParam。
10. **动作播放（VMD）面板默认隐藏**——仅当前角色模型加载动作后显示；提供收起按钮 → 右下角迷你 tab；`animPanelUserCollapsed` 区分两种隐藏语义。
11. **解压缓存目录 = `<userData>/Cache/extract/`**，禁止 `os.tmpdir()`；签名 = 路径 + 大小 + 修改时间；LRU 阈值 64 目录 或 8GB，命中时 `fs.utimesSync` 刷新 mtime。
12. **`clear-cache(scope='all')` 必须同时清理**：资源库 models/motions/thumbs/tmp + 解压缓存 extract + DDS PNG 解码缓存 dds-png-cache + 渲染层所有内存缓存引用。
13. **启动时异步执行 `pruneExtractCacheIfNeeded()`**（不阻塞窗口创建）。

---

## 16. 工程守则与踩坑记录

### 16.1 构建-验证流水线（MMDModelViewer Build-Verify Pipeline）

每次修改 renderer/main/preload 任何代码后，**必须按顺序执行**：

1. **代码定位**：renderer.js 通常修改后需要定位关键锚点（见第 6.3 节函数索引），main.js 任何解压相关修改看 4.4 节，IPC 修改看 4.8 节。
2. **构建**：`npm run build:renderer`（esbuild，约 60-80ms，产物 ~1.9MB）；观察是否有 import 缺失。
3. **冒烟**：`npm run smoke` 启动 → 检查：
   - 无 console 报错（渲染进程 DevTools：MMD_DEVTOOLS=1）
   - params-reset-refresh 不抛异常
   - 加载至少一个 PMX 模型后，`animate()` 循环稳定（无 GC 抖动）
4. **交付判读**：若 build 失败 → 通常是路径错误 / 未 import / 语法错误；若 smoke 测试中模型白 → 检查 mmd:// 协议和贴图路径；若模型抖动 → 检查 tunePhysicsForMesh 是否被正确调用；若拖拽后抖动 → 检查 restoreDragPhysics 的 4 步流程。

### 16.2 关键踩坑列表（血与泪总结）

| 问题 | 根因 | 正确做法 | 代码位置 |
| --- | --- | --- | --- |
| 打包后解压 ENOENT | 7zip-min 依赖 `process.argv` 判断 asar，打包版 argv 不含 `app.asar`；7zip-bin 的 7za 又是容错 wrapper | 用 `vendor/7za.exe` + asarUnpack + `seven.config({binaryPath})` | main.js:14-22, package.json build.files & asarUnpack |
| resize 拖拽侧栏后视口不更新 | `renderer.setSize()` 会把 canvas.width/style 写成**固定 px**，用 canvas.clientWidth 读到陈旧值 | 必须从容器 `#viewport.clientWidth/Height` 取尺寸 | renderer.js resize() |
| 移动模型后布料剧烈抖动 | 整体 mesh.position 改变 → static 刚体跟随骨骼移动但 dynamic 刚体停旧位 → constraint 弹簧拉扯发散 | pointerdown 存 physics 置 null；pointerup 先 updateMatrixWorld(true) 再 physics.reset() 再清零所有速度；加 8 帧 warm start | renderer.js restoreDragPhysics |
| `setParam('render.dirLightColor', '#fff')` 后灯光没变 | `dirLight.color = new THREE.Color(...)` 只是**替换引用**，内部 cached Color 对象仍用旧值 | `dirLight.color.copy(new THREE.Color(...))` | applyParam 中所有 color |
| BC7 DDS 采样恒灰/黑 | Electron SwiftShader 软件渲染假阳性报告 `EXT_texture_compression_bptc` 支持，但 GPU 解压返回无效值 | 主路径：main.js Python CPU 解压 BC7→PNG；BPTC 扩展路径仅作兜底回退 | loadDDSTexture + decode-dds-to-png IPC |
| UV 贴图错位（XXMI Mod） | 自作主张用 U=offset 8, V=offset 4；但 3DMigoto 标准顶点缓冲是 (U=offset4, V=offset8)，V 还要翻转（3D 纹理 V 方向相反） | `U = buf[offset4]`，`V = 1.0 - buf[offset8]` | loadModArchiveAsMesh 的 UV 读入段 |
| 压缩包每次启动都重解压 | 之前用 `Date.now()` 做签名 + `os.tmpdir()` 存目录 | 用 `md5(path|size|mtime)` 签名 + `<userData>/Cache/extract/` 持久化，命中后 utimesSync 刷新热度 | main.js extractArchive + pruneExtractCacheIfNeeded |
| 预设"电影质感"过曝 | 默认 toneMappingExposure=1.05 + dirIntensity/keyLightIntensity/bloomStrength 过高 | 三套预设全部使用 ACES 曝光 0.82-0.95 区间，灯光强度值从下往上调；`applyAllParams` 必须同步 toneMappingExposure 分支 | applyPreset overrides 表 + applyParam toneMappingExposure 分支 |
| 切换场景模型后动画面板仍显示 | 旧 setupVmdList 对所有 mesh 触发面板显示 | 加入 `isCurrentRole(mesh)` 检查：非当前角色模型不触发 setAnimPanelVisible | setupVmdList 开头 |
| koa-connect wrapper ctx 泄漏 → 文件描述符耗尽 | 直接弃用 koa + connect 服务贴图的设计，改用 Electron protocol.handle | mmd:// 协议 + CORS 头 是本项目唯一文件服务方式 | main.js registerMmdProtocol |
| 预设修改手动单项时 applyParam 递归触发切 custom → 死循环 | 加 `__presetApplyingLock` 锁：applyPreset 批量覆盖期间不自动切 custom，结束后 refreshRenderPanelUI 一次 | applyParam 开头 + applyPreset |
| 灯光颜色改了但 scene.fog 没变导致天空雾色不一致 | scene.fog.color 独立于 `bgColor` 参数 | `bgColor` applyParam 时：同时 `_fogParams.color = bgColor*0.78 lerp 0x0B0E14 by 0.35` 并 fog.color.copy | applyParam bgColor 分支 |
| Mod 加载中 position/texcoord 资源错配（Head/Body 段交叉） | 简单按"第一个 Position/Texcoord"匹配 | 最长公共前缀匹配：去掉 TextureOverride/Resource 前缀后，按匹配长度降序选最优 | main.js load-mod-archive matchPrefix function |

### 16.3 新增功能 Checklist

- [ ] 是否新增参数 → 加入 `DEFAULT_PARAMS` + `applyParam` 分支 + `PARAM_DEFS` 类型定义
- [ ] 是否修改灯光颜色 → 使用 `.copy(new THREE.Color(...))`
- [ ] 是否改动尺寸读取 → 从 `#viewport` 取，不用 `canvas.clientWidth`
- [ ] 是否改动解压/缓存逻辑 → 检查签名三要素 + LRU `fs.utimesSync` + clear-cache('all') 覆盖
- [ ] 是否改动 7za → 检查运行期 binaryPath（isPackaged 分支）+ package.json 的 asarUnpack
- [ ] 是否改动动画面板 → 保持 `animPanelUserCollapsed` 语义：切换模型/清空场景时复位
- [ ] 是否改动拖拽 → 走 `restoreDragPhysics` 三步（存/拖/恢复+清零）
- [ ] 是否改动 DOM → 检查 styles.css 是否有新 class 的深色玻璃样式（遵循设计令牌）
- [ ] 是否改动后处理 → 检查 `window.__postfx` 是否同步暴露新 pass；applyParam 分支完整
- [ ] 修改完成 → `npm run build:renderer` → `npm run smoke`（确认无 console error + params-reset-refresh 通过）

---

> 本 Wiki 最后基于源码修订：2026-08-21。
> renderer.js **5167 行**，main.js **2024 行**，index.html **384 行**，styles.css **1794 行**，preload.js **98 行**，decode_dds.py **51 行**。
