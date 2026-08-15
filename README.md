# MMDModelViewer · 本地 3D 模型预览器

便捷查看与预览本地 3D 模型（MMD PMX/PMD 为主）的桌面应用，基于 **Electron + Three.js**。

## 功能

- 📂 **目录浏览**：默认扫描 `D:\素材\3D模型`，支持切换任意目录（"选择目录…"）
- 🧊 **MMD 模型预览**：加载 `.pmx` / `.pmd`，支持旋转 / 平移 / 缩放（鼠标左键 / 右键 / 滚轮）
- 🎬 **VMD 动作播放**：自动列出模型同目录下的 `.vmd` 动作文件，播放 / 暂停 / 停止，速度可调（0.1x ~ 3x）
- 📸 **截图导出**：一键导出当前视角为 PNG 图片
- 🗜️ **压缩包内预览**：直接解压 `.rar` / `.zip` / `.7z` 到临时目录并浏览内部模型
  - RAR 使用纯 JS 解压（node-unrar-js，兼容 RAR5 + 中文路径）
  - ZIP / 7Z 使用内置 7za，无需安装任何解压软件
- ℹ️ **模型信息**：顶点数、面数、贴图数量与贴图列表

## 支持的模型格式

| 类型 | 扩展名 |
| --- | --- |
| MMD | `.pmx` `.pmd` `.vmd` `.vpd` |
| 通用 | `.gltf` `.glb` `.obj` `.fbx` `.stl` `.dae` `.ply` `.3ds` |

> 当前完整渲染链路（贴图加载、骨骼、动作）针对 MMD 格式优化；通用格式会出现在列表中，可后续扩展加载器。

## 开发与运行

```bash
# 安装依赖
npm install

# 构建渲染进程并启动应用
npm start

# 冒烟测试（自动验证：目录扫描 / RAR 解压 / PMX 加载 / 渲染 / 截图）
npm run smoke
```

> Windows 下如遇 npm 缓存权限问题，可指定工作区内缓存：`npm install --cache .\.npm-cache`

## 打包发布

```bash
npm run dist   # 生成 NSIS 安装包 + 便携版（dist/ 目录）
```

> 打包时如需跳过代码签名（本机无证书时）：`set CSC_IDENTITY_AUTO_DISCOVERY=false && npm run dist`

## 技术结构

```
MMDModelViewer/
├── main.js          # Electron 主进程：窗口、mmd:// 协议、IPC（扫描/解压/截图）、冒烟测试
├── preload.js       # 安全桥接（contextBridge）
└── renderer/        # 渲染进程
    ├── index.html   # 界面（工具栏 / 文件树 / 3D 视口 / 信息栏）
    ├── styles.css   # 深色主题样式
    ├── renderer.js  # 源文件（Three.js 场景、MMDLoader、OrbitControls、动作播放）
    └── bundle.js    # esbuild 构建产物（npm run build:renderer 生成）
```

### 核心机制

- **`mmd://` 自定义协议**：将本地文件路径映射为可 fetch 的 URL（`mmd://local/D:/素材/...`），
  使 MMDLoader 的贴图相对路径解析在浏览器安全模型下正常工作。
  - 协议响应**带 `Access-Control-Allow-Origin: *` 头**：MMDLoader 内部 TextureLoader 默认
    `crossOrigin='anonymous'`，若无 CORS 头，贴图会被浏览器拦截，模型将显示为灰白色。
- **渲染进程打包**：esbuild 将 three.js 等依赖内联为单个 `bundle.js`，避免 asar 内 ESM 加载问题。
- **压缩包预览**：RAR 用 node-unrar-js（WASM，官方 unrar 源码），ZIP/7Z 用 7zip-min（内置 7za）。
- **截图**：WebGL 画布 `preserveDrawingBuffer` + `toDataURL`，通过 IPC 保存。
- **文件树**：竖向紧凑树 + 引导线，深目录不横向挤出；点击模型自动展开其所在目录链。

## 注意事项

- 首次启动如果 `D:\素材\3D模型` 不存在，会提示扫描失败，可手动"选择目录…"。
- 解压后的临时目录在应用退出后不会自动清理（系统临时目录）。
- 大模型（数十 MB + 大量贴图）首次加载需要数秒，属正常现象。
