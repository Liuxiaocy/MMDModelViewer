# 2026-08-15 MMDModelViewer 三项增强设计文档

> 针对用户三条需求：
> 1. 文件树仿 Windows 10 列表（非"图标横铺 + 竖线缩进"）
> 2. 腿部不动 —— 改用 MMDAnimationHelper + CCDIK 修复
> 3. 增加布料物理效果 —— MMDPhysics（ammo.js）集成

## 一、背景与现状

- Electron 14 + Three.js r152+（含 MMDLoader / OrbitControls）
- 当前动画管线：仅 `AnimationMixer`，未引入 CCDIK / MMDPhysics
- 当前文件树：`.tree-item` 嵌套 + `border-left` 竖线缩进 + 横向铺开 size badge
- 已知根因：VMD 腿动作只记录「足先 + 膝盖 pole」，大腿/小腿需 CCDIK 每帧反解；没有 CCDIK → 腿停留在 bind pose

## 二、目标与非目标

### 目标（Must Have）
1. 文件树视觉严格对齐 Win10 资源管理器"详细信息/小图标列表"观感：扁平 grid 三列（icon+indent | name | size），hover #E5F3FF、selected #CCE8FF、无左侧竖线、行高 22px
2. 加载任意标准 VMD 腿部动作时，大腿 / 小腿 / 膝盖的角度能被正确反解，走路/奔跑/下蹲时脚抬离地面、膝盖弯曲方向自然
3. 裙摆/头发等带 `rigidBodies` + `joints` 的物理附件，在动作中具备正确的惯性摆动 + 重力下垂；动作骤停后物理继续跑 ~0.3s 逐渐停下

### 非目标（本次不做）
- 自定义 IK 迭代数 / 物理参数面板（方案三，后续可在架构上无缝扩展）
- 实时切换 ammo 重力向量（留接口但不暴露 UI）
- 动作混合（crossfade）与双 VMD 叠加 —— Helper 已兼容，但本次先保证单动作

## 三、架构总览（方案二）

```
┌─────────────── Renderer 线程 ─────────────────────────┐
│                                                        │
│  init()                                                │
│   ├─ initAmmo()  ───── 预加载 three/examples/jsm/libs/ │
│   │                     ammo.wasm.js → window.Ammo    │
│   └─ scan root / init UI                               │
│                                                        │
│  loadModel(pmx) ──────────────────────────────────┐    │
│   ├─ MMDLoader.load(url → mesh)                    │    │
│   ├─ if (oldMesh) helper.remove(oldMesh)          │    │
│   ├─ helper.add(mesh, {                            │    │
│   │     physics: true,                             │    │
│   │     unitStep: 1/60, maxStepNum: 2,             │    │
│   │     gravity: (0, -98, 0),                      │    │
│   │     resetPosition: true, resetRotation: true}) │    │
│   └─ helper.enable('ik')  helper.enable('physics') │    │
│                                                     │    │
│  playVmd(vmd)                切动作                 │    │
│   ├─ MMDLoader.loadAnimation(url, mesh → clip)     │    │
│   └─ helper.animate(mesh, clip)                    │    │
│                                                     │    │
│  animate(delta)  ← 每帧 60fps                       │    │
│   └─ helper.update(delta * speed)                  │    │
│        ├─ ① Animator 写 local （VMD track → bone） │    │
│        ├─ ② CCDIK 迭代（腿/臂）                    │    │
│        ├─ ③ Kinematic 刚体 → bone world             │    │
│        ├─ ④ Bullet stepSimulation（弹簧解算）       │    │
│        ├─ ⑤ 非 Kinematic 刚体 world → bone         │    │
│        └─ ⑥ 所有 SkinnedMesh 更新 boneMatrices      │    │
│                                                        │
│  clearModel()                                          │
│   └─ helper.remove(mesh)  → 销毁 IK / 物理 / 动画轨道   │
└────────────────────────────────────────────────────────┘
```

## 四、文件树改造（Section 1 · Win10 列表）

### 4.1 DOM 结构变化

旧（嵌套）：
```
.tree-item
  .tree-head (twisty + icon + name + size-badge)
  .tree-children (border-left:1px + margin-left:12px)
     .tree-item ...
```

新（扁平）：
```
.win10-rows  (直接替换 file-tree 内部)
  ├ .win10-row  level=0 dir
  ├ .win10-row  level=1 file
  ├ .win10-row  level=1 dir (collapsed → 后代隐藏)
  ├ .win10-row  level=2 file (class=collapsed-descendant  → display:none)
  └ ...
```

每行 grid 三列：
```
grid-template-columns: [indent-icon-col] auto   [name-col] 1fr   [size-col] auto
内容:                 w10-icongrp = twisty(14px)+icon(18px)    w10-name    w10-size(64px右对齐)
```

### 4.2 视觉令牌（追加到 styles.css，不删原 token）

```
Win10 行高     : 22px
Win10 字体     : Segoe UI / PingFang SC / system-ui, 12px, #1C1C1C
Win10 Hover    : #E5F3FF（整行）
Win10 Selected : #CCE8FF（整行，不加粗文字）
Win10 缩进增量 : 14px / 每级（通过 w10-icongrp style.marginLeft = depth*14）
Win10 size     : font 11px  color #666  宽度 64px  text-align:right
Win10 twisty   : 10px ▸▾  颜色 #777  文件行保持 14px 占位（不显示）
```

### 4.3 JS 函数改造清单

| 函数 | 新语义 |
|---|---|
| `renderTree(tree)` | 先清空 file-tree，然后 DFS 遍历，对每个 node 调用 `appendWin10Row(node, depth=0)`，用 `depth` 控制缩进 |
| `appendWin10Row(node, depth)` | 创建 `.win10-row`，含 w10-icongrp / w10-name / w10-size 三格；如果是 dir，twisty 写 ▸；挂载 dataset（path/name/type/size/isDir/rowId） |
| `toggleDir(rowEl, expand?)` | 根据 rowEl.dataset.path 找到它所有后代 rows 的集合；expand=true 删除 `.collapsed-descendant`，否则加；同步 twisty ▸↔▾ |
| `expandPath(absPath)` | 从根到目标节点，沿途把每一级 dir 都 toggleDir(expanded)，然后把目标 row 滚动进视图 |
| `clearSelection()` | `file-tree.querySelectorAll('.win10-row.selected').forEach(el => el.classList.remove('selected'))` |
| `setSelectedByPath(path)` | clearSelection → 找到对应 row → `.selected` → 滚动 |

## 五、动画管线重构（Section 2 · 腿部 IK 修复）

### 5.1 新增 imports

```js
import { MMDAnimationHelper } from '../node_modules/three/examples/jsm/animation/MMDAnimationHelper.js';
```

### 5.2 新状态变量

```
mmdHelper          : MMDAnimationHelper|null     （单例；每次切模型 remove 旧 + add 新）
ammoReady          : boolean
```

### 5.3 initAmmo()

**放在 init() 顶部**：

```js
async function initAmmo() {
  try {
    const AmmoFactory = (await import('../node_modules/three/examples/jsm/libs/ammo.wasm.js')).default;
    window.Ammo = await AmmoFactory();
    ammoReady = true;
  } catch (err) {
    ammoReady = false;
    setStatus('ammo 加载失败，布料物理降级（腿部IK仍正常）：' + err.message, 'warn');
  }
}
```

### 5.4 loadModel 改造点

```
  ... MMDLoader.load -> mesh ...
  if (mmdHelper && currentMesh) mmdHelper.remove(currentMesh);   // 先清理旧
  if (!mmdHelper) mmdHelper = new MMDAnimationHelper({ afterglow: 0.1 });
  currentMesh = mesh;
  scene.add(mesh);
  mmdHelper.add(mesh, {
    physics: ammoReady,
    unitStep: 1 / 60,
    maxStepNum: 2,
    gravity: new THREE.Vector3(0, -9.8 * 10, 0),
    resetPosition: true,
    resetRotation: true,
  });
```

### 5.5 playVmd 改造点

原：`AnimationMixer.clipAction(clip).play()`
新：
```
  mmdHelper.animate(mesh, clip);
```

### 5.6 animate 循环改造点

原：`if (mixer) mixer.update(delta * animSpeed);`
新：`if (mmdHelper) mmdHelper.update(delta * animSpeed);`

> 说明：`helper.update(0)`（暂停时）仍会跑物理 → 裙摆继续惯性摆动 ~0.3s，效果正确。

### 5.7 clearModel 改造点

在 `scene.remove(currentMesh)` **之前**加：
```
  if (mmdHelper && currentMesh) {
    mmdHelper.remove(currentMesh);
  }
```

## 六、布料物理（Section 3 · LEVEL 2 MMDPhysics）

### 6.1 物理参数（同 5.4 helper.add）

| 参数 | 值 | 理由 |
|---|---|---|
| `unitStep` | 1/60 s | MMD 物理标准 60fps |
| `maxStepNum` | 2 | 在 30fps 显示刷新率下也能补两帧物理，避免穿透 |
| `gravity` | (0, -98, 0) | PMX 模型尺度 mm，Bullet 默认 9.8 按米；×10 符合 MMD 官方约定 |
| `resetPosition` / `resetRotation` | true | 切动作时把所有刚体瞬移到新骨骼位置，不再从旧位置"飞回来" |
| `afterglow` (Helper) | 0.1 s | 切 VMD 时做 100ms 的动作余辉，避免生硬跳转 |

### 6.2 降级策略

ammo 加载失败（`ammoReady=false`）：
1. `helper.add(mesh, { physics: false })` 不加物理
2. CCDIK 仍由 helper 驱动 → **腿部仍正常动作**
3. `setStatus` 提示用户布料降级

### 6.3 性能兜底（暂不做 UI）

如果模型 rigidBodies > 200（罕见），物理每帧耗时可能 > 8ms。兜底：
- 加载完 mesh 后 `if ((mesh.userData.rigidBodies?.length || 0) > 200) helper.enable('physics', false)` 并 setStatus 警告

## 七、影响面与兼容性

| 模块 | 是否受影响 | 说明 |
|---|---|---|
| main.js / preload.js | ❌ 无 | 纯 renderer 内改造 |
| 样式 styles.css | ✅ 追加 | 原 token 保留，新增 .win10-* ；旧 .tree-children border/margin 覆盖为 none |
| renderer.js | ✅ 核心 | 覆盖树渲染 / 动画管线 / 加载清理 |
| package.json | ✅ 追加 ammo.js 依赖 | 1.8MB 下载，ammo.wasm 走 esbuild 拷贝路径 |
| esbuild bundle | ✅ 重新 `npm run build:renderer` | MMDAnimationHelper + CCDIKHelper + MMDPhysics 都会被打包 |
| 已保存最近文件 / 面包屑历史 | ❌ 无 | 数据结构未变 |

## 八、验收用例

| ID | 场景 | 预期结果 |
|---|---|---|
| T1 文件树视觉 | 打开「3D模型」目录 | 每行 22px；悬停浅蓝；选中深一码蓝；无左侧竖线；三列对齐，最后一列大小数字右对齐 |
| T2 文件树展开/折叠 | 点击 twisty ▸ 展开二级目录 | 下级行显示且缩进 14px；再点击 ▾ 折叠后下级行 display:none 无残留 |
| T3 腿部走路动作 | 加载少女.pmx + 走路.vmd | 脚交替抬离地面；膝盖自然弯曲（非反关节）；落地时脚底对齐参考地面不穿模或浮起 > 1cm |
| T4 腿部下蹲动作 | 加下蹲 VMD | 小腿不僵直；膝盖前倾；脚后跟不离地；整体无抖动 |
| T5 裙摆物理 | 播放左右旋转幅度大的动作 | 裙摆跟随身体摆动，有滞后；动作骤停后裙摆继续晃 1-3 周期再停下 |
| T6 头发物理 | 播放快速奔跑/旋转 | 发梢甩动明显且不穿模 |
| T7 切模型 | A.pmx 播放动作中 → 切 B.pmx → 加载 C.vmd | A 的布料刚体全部销毁；切换时控制台无错误；C.vmd 正常驱动 B 的 IK+物理 |
| T8 切动作 | 模型同，从走路 VMD 切到跳舞 VMD | helper.animate 正确接管，无旧动作残留 |
| T9 降级 | 人为制造 ammo 加载失败（如断网删包） | 状态栏出现降级警告；腿部 IK 仍正确；只是布料/头发不摆 |
| T10 构建 | `npm run build:renderer` | 0 error；esbuild 输出 bundle.js 正常；`npm start` 启动无告警 |

## 九、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| ammo.wasm wasm 加载路径被 Electron asar 打包隔离 | 中 | 打包后运行布料失效，开发模式 OK | 打包 config 中 `asarUnpack: ["node_modules/three/examples/jsm/libs/ammo.wasm.wasm"]`（必要时加）|
| 部分 PMX 骨骼名非日文标准（如中文"左腿"），CCDIKHelper 找不到 IK bone | 低 | 个别模型腿仍不动 | 文档里提示用户配布的 MMD 模型要符合日文标准名；非标准 → 可后续做骨骼名映射表（本次不做）|
| 模型 rigidBodies 分组碰撞掩码异常导致"腿自己踢到裙子" | 极低 | 穿模/抖动 | 在 helper.add 之前给 userData.joints 做一次 sanity check（可后补）|
| 超大模型（rigidBodies>300）在低端机物理超 8ms | 低 | 掉帧到 40fps 左右 | 见 6.3 兜底：>200 自动降级；或未来做参数面板手动关 |
