# 渲染功能包设计：色彩通道 / 9 套布光预设 / IES+HDR / VSM / SSGI+GodRay+LensFlare / 多层配置 UI
- Date: 2026-08-21
- Status: Draft（已确认 §1~§4，§5~§7 随 spec 一并写，不再单独讲解）
- Scope: 仅 `renderer/renderer.js` + `renderer/index.html` + `renderer/styles.css` 的 Electron renderer 进程内改动；不修改 main.js / preload.js（**除**必要的 IPC：`showOpenDialog` 选 `.hdr/.exr/.png` 用户自定义文件路径）
- 环境: Electron WebGL 2.0 + Three.js r170，目标中低端独显（1650/2060/RX6600 级别）FHD ≥ 45fps

---

## 1. 架构 / 模块清单 & 后处理管线顺序

### 模块清单（9 个，全 renderer.js，不拆文件）
| ID | 名称 | 说明 | 依赖 |
|---|---|---|---|
| CMAP | 色彩通道扩展 | ColorBalancePass（ShaderPass）+ 6 种色调映射切换（aces/agx/reinhard/cineon/linear/none） | Three.js 自带 ShaderPass |
| LPRESET | 9 套灯光预设 | `_PRESETS` 扩展到 9 套：default/film/natural/studio + **rembrandt/butterfly/backlit/coldnight/neon**（5 新增） | 不新增对象，调 `applyPreset(name)` 批写 |
| IES | IES cookie 光形 | 4 个内置 Canvas2D 生成形状 + 用户 PNG；作为 SpotLight.keyLight.map | 无 |
| HDR | 程序化 HDR + 用户文件 | 5 个内置 Canvas2D equirect 纹理（2048x1024）+ RGBELoader 解析 .hdr/.exr → PMREMGenerator → scene.environment；可选 envMapAsBackground | Three.js RGBELoader + PMREMGenerator |
| VSM | VSM 柔影 | shadowMap.type 新增 VSMShadowMap，自动收紧 bias/near/far 防 acne | 无 |
| GODRAY | 体积光（光柱 God Ray Pass）| ShaderPass：1/4 分辨率 brightPass → 沿光源屏幕投影 32 步 radial blur → 混合主画面 | 自写 shader |
| LENS | 镜头光晕（LensFlarePass）| ShaderPass：brightPass → 6 层同心圆光斑 + chromatic ghost + 自动遮挡 | 自写 shader |
| SSGI | 屏幕空间 GI | Three.js 自带 SSGIPass，与现有 SAOPass 二选一（aoMode 控制） | Three.js SSGIPass |
| CHIP | 配置汇总 chip | 快捷浮层顶部 chip 展示当前启用功能缩写 + hover tooltip 完整清单 | DOM/CSS |

### 后处理管线顺序（EffectComposer pass）
```
① RenderPass                    → scene/cam 主颜色 + 深度（必须）
② ContactShadowsShaderPass     → 已存在，屏幕空间 10 步 raymarch 接触阴影
③ SAOPass  或  SSGIPass        → 二选一（aoMode: ssao | ssgi | off）
④ GodRayPass                   → 体积光光柱叠加（SSAO 之后，不要让 SSAO 挡住体积光）
⑤ LensFlarePass                → 镜头光晕叠加（先 GodRay 后 Lens：光晕不被光柱遮）
⑥ UnrealBloomPass              → 已存在；Bloom 最后再做，让 GodRay/Lens 的高亮度也泛光
⑦ ColorBalancePass             → 色温/tint/contrast/saturation/vibrance/lift-gamma-gain 全部在 **线性 HDR 空间** 做（renderer.toneMapping 之前）
⑧ OutputPass
```
**绝对约束**：ColorBalancePass 必须放在 **所有 effect pass 之后、OutputPass 之前**，因为 renderer 的 ACES/AgX/Reinhard toneMapping 发生在 EffectComposer 输出阶段；如果把色温放在 tonemap 之后（LDR sRGB 空间）会破坏色彩科学，皮肤/天空会肉眼可见偏色或 banding。

---

## 2. DEFAULT_PARAMS 新增字段 + 9 套灯光预设表

### 2.1 参数结构（render 子分组，保持扁平 getParam/setParam 兼容）
`applyParam(group, key, value)` 接口不变（扁平寻址）。内部在 `DEFAULT_PARAMS.render` 逻辑划分 5 组（只用于 UI 手风琴，不改变键的扁平路径）。

```
DEFAULT_PARAMS.render = {
  // ---- 原有 flat key（保持不变，不破坏现有 applyParam/setParam）----
  toneMappingExposure: 0.95,
  dirIntensity/dirLightColor/dirAngle/dirHeight,
  hardLightMode/shadowSoftness,
  keyLight{Intensity,Color,Distance,Angle},
  fillLight{Intensity,Color}, rimLight{Intensity,Color},
  hemisphereIntensity, ambientIntensity, skyboxEnabled,
  fogDensity/fogColor, bgColor,
  bloomStrength/Threshold/Radius,
  shaderBevel{Enabled,Strength,Power},
  fresnelRim{Enabled,Power,Strength},
  contactShadows{Enabled,Opacity,MaxDistance},
  ssaoEnabled/ssaoIntensity,

  // ---- §2.A 色彩通道（新增 flat key，都加前缀语义）----
  toneMapping: 'agx',                 // 'aces' | 'agx' | 'reinhard' | 'cineon' | 'linear' | 'none'
  colorTemp: 5800,                    // 2000..12000 K
  colorTint: 0,                       // -100..+100
  contrast: 1.05,                     // 0.5..1.6
  saturation: 1.00,                   // 0..1.6
  vibrance: 1.10,                     // 0..1.6
  liftGammaGain: [0, 1, 1],           // lift∈[-0.3,0.3], gamma∈[0.3,2.5], gain∈[0.3,2.5]
  colorBalanceEnabled: true,

  // ---- §2.B 布光预设名字（只记录，触发 applyPreset()）----
  presetName: 'default',              // 'default'|'film'|'natural'|'studio'|'rembrandt'|'butterfly'|'backlit'|'coldnight'|'neon'

  // ---- §2.C 光源 & HDR（新增 flat key）----
  hdrPreset: 'none',                  // 'none'|'studio-box'|'showroom-gray'|'sunset'|'neon-ring'|'window-overcast'|'user'
  hdrUserPath: '',                    // 绝对路径（.hdr/.exr）；为空时回退 hdrPreset
  envMapAsBackground: false,          // true → HDR 覆盖 scene.background
  envMapIntensity: 1.0,               // 所有 MeshStandardMaterial 的 envMapIntensity
  iesPreset: 'none',                  // 'none'|'softbox-round'|'softbox-strip'|'grid-spot'|'window-blind'|'user'
  iesUserPath: '',                    // 用户 PNG 路径
  iesIntensityScale: 1.0,             // keyLight.intensity *= scale

  // ---- §2.D 特效 ----
  aoMode: 'ssao',                     // 'off'|'ssao'|'ssgi'（优先级：aoMode 覆盖 ssaoEnabled）
  ssgiEnabled: false,                 // 冗余开关，仅与 aoMode='ssgi' 同步，用于 UI switch
  ssgiRadius: 0.18,
  ssgiThickness: 0.015,
  ssgiMaxRoughness: 0.9,
  ssgiIntensity: 1.0,
  godRayEnabled: false,
  godRayIntensity: 0.85,
  godRayDecay: 0.955,
  godRayWeight: 0.35,
  godRaySamples: 32,
  godRaySource: 'sun',                // 'sun' | 'keylight'
  lensFlareEnabled: false,
  lensFlareIntensity: 0.7,
  lensFlareThreshold: 0.9,
  lensFlareGhosts: 6,
  lensFlareChromatic: 0.08,

  // ---- §2.E 阴影柔化 ----
  shadowMapType: 'vsm',               // 'none'|'basic'|'pcfsoft'|'vsm'
  shadowBiasScale: 1.0,               // -2..2；VSM 要 tight bias
}
```

**兼容保护**：读旧 settings.json 时，如果 `toneMapping / colorTemp / presetName / hdrPreset / shadowMapType` 任一 key 缺失，`getParam()` 自动用 `DEFAULT_PARAMS.render[key]` 兜底（`applyParam` 已有该 fallback，不新增分支）。

### 2.2 9 套布光预设表（`_PRESETS` 扩展）
只写**非默认值**（默认值 = 上面 DEFAULT_PARAMS.render 初始值）。
单位备注：`@` 后面是 keyLight 的 (高度角度, 方位角度)；dirAngle/dirHeight 为球面坐标方位/高度。

| presetName | 名称 | 色彩非默认 | 布光非默认 | 特效/HDR非默认 |
|---|---|---|---|---|
| default | 默认预览 | — | — | —（就是 DEFAULT_PARAMS）|
| film | 电影质感 | `toneMapping='agx'`, colorTemp=5400, contrast=1.12 | **toneMappingExposure=0.82**，dirIntensity=4.8 @-42°，key=6.2 @28°，fill=0.7，rim=1.1 | bloomStrength=0.36，shadowMapType='vsm' |
| natural | 自然预览 | 'agx', 6200K | exposure=0.95，dir=2.2，key=3.6 @24°，fill=0.5，rim=0.65 | bloom=0.20, contactShadowsOpacity=0.35 |
| studio | 原色工作室 | 'agx', 5600K, saturation=1.08 | exposure=0.88，dir=5.2 @-44°，key=7.2 @32°，fill=0.55 | ssaoIntensity=0.90, shaderBevelStrength=1.5, 'vsm' |
| **rembrandt** | 🆕 伦勃朗肖像 | 'agx', 5700K, contrast=1.15 | key=**8.0 @ (62°高, 55°R)**，fill=0.3 冷蓝 #9bbad0，rim=0.4，dir=2.8 | contactShadowsOpacity=0.50, 'vsm' |
| **butterfly** | 🆕 蝴蝶光时尚 | 'agx', 6000K, sat=1.05, vibrance=1.15 | key=7.6 @ **(68°高, 正前 0°R)**，fill=0.7，rim=0.85，dir=2.5 | bloomStrength=0.25，ssaoIntensity=0.60 |
| **backlit** | 🆕 剪影背光 | 'agx', 6400K, contrast=1.18 | key=1.6 (极弱正面)，**rim=3.2** @ 背后(-170°高位) 暖色 #ffe9cc，dir=1.8，fill=0.4 | `hdrPreset='showroom-gray'`, envMapAsBackground=true |
| **coldnight** | 🆕 冷夜氛围 | 'agx', **4100K + tint=-12**, contrast=1.08 | dir=1.6 冷蓝 #7aa0d8，key=2.4 冷 #7fb7ff，**fill=0.9 深蓝 #3f6db0**，rim=0.9 冷蓝 | `hdrPreset='window-overcast'`, godRayEnabled=true godRaySource='keylight' intensity=0.4，bloom=0.30 |
| **neon** | 🆕 霓虹舞台 | **toneMapping='reinhard'**, **7200K**, sat=1.35, vibrance=1.40, contrast=1.20 | dir=1.2 暗蓝 #2a3060，**key=5.6 品红 #ff3d9f**，**fill=1.2 青 #33c6ff**，**rim=2.4 薄荷绿 #7bffb0** | `hdrPreset='neon-ring'`, envMapAsBackground=true, bloom=0.48 threshold=0.60, lensFlareEnabled=true intensity=0.9 **lensFlareThreshold=0.68** |

**说明**：伦勃朗与剪影背光两个预设，`applyPreset` 执行完 flat key 批量 setParam 之后，**必须调用 `refreshLighting()` 一次性重新计算 keyLight/dirLight 球面坐标并 updateMatrixWorld()**（避免逐 key 改角度时重复计算 3 次矩阵）。

---

## 3. applyParam 实时刷新钩子（每个 key 的生效路径，防止写了不生效）
核心原则：**每个 key 明确实例属性 + needsUpdate / updateProjectionMatrix / setSize 触发**；改完参数如果涉及实例替换（如 SAOPass↔SSGIPass、HDR 重建 envMap）必须 `.dispose()` 旧对象防 GPU 泄漏。

### 3.1 色彩通道组（CMAP）
| key | 生效钩子 | 幂等保护 |
|---|---|---|
| toneMapping | map → THREE.{Aces}FilmicToneMapping / AgXToneMapping / ReinhardToneMapping / CineonToneMapping / LinearToneMapping / NoToneMapping；`renderer.toneMapping = x; renderer.outputColorSpace = SRGBColorSpace`；遍历 composer.passes 若有 `pass.setSize` 就 `pass.setSize(w,h)` 强制刷新内部 tex uniform | `__lastToneMapping` 相同就 return |
| toneMappingExposure | `renderer.toneMappingExposure = Number(value)` | 已有 |
| colorBalanceEnabled | 如 CB pass 未建：`ensureColorBalancePass()` 插入 composer 到 bloom 之后、output 之前；再 `colorBalancePass.enabled = bool` | `__cbPassReady` |
| colorTemp + colorTint | 合并一次计算：K→XYZ→RGB gain（CIE Planck/标准插值，2000K≈R1.22 G1.0 B0.76；9000K≈R0.93 G1.0 B1.22）再乘 tint 轴增益 → `uWBGain = [R, G, B]`，写入 `colorBalancePass.uniforms.uWBGain.value`（shader 内已经与 liftGammaGain 预结合） | 缓存 `__lastTempTintKey = temp+'|'+tint`，相同直接跳过 |
| contrast / saturation / vibrance | 分别写入 `uContrast, uSaturation, uVibrance` | — |
| liftGammaGain | `uLift=arr[0], uGamma=clamp(arr[1],0.3,2.5), uGain=clamp(arr[2],0.3,2.5)`；三者在 shader 与 uWBGain 预结合（按乘/加的结合律合并成一个乘+加，不增加指令数） | — |

### 3.2 布光预设切换（LPRESET）
| key | 生效钩子 |
|---|---|
| presetName | `applyPreset(name)`：<br>① 查 `_PRESETS[name]`；若不存在回 'default' 并 console.warn；<br>② 遍历预设 keys → 批量 `setParam('render', k, v, { noApply: true, noSave: true })`（**只写内存中的 PARAMS 表，不触发 applyParam，也不写 settings.json**，避免每个 key 都刷新实例/爆磁盘 IO）；<br>③ 写完全部预设 keys 后 **`saveSettings()` 一次性落盘**；<br>④ **调用一次 `refreshLighting()`**（见 §3.3）统一刷新所有 Light / shadow / envMap 实例；<br>⑤ 再触发一次对 `colorTemp / toneMapping / shadowMapType / aoMode / hdrPreset / iesPreset / godRayEnabled / lensFlareEnabled / colorBalanceEnabled` 的 applyParam 收尾（它们都有幂等保护，不怕重复）；<br>⑥ 持久化 `presetName` 状态到 settings.json。 |

### 3.3 灯光 & 阴影组
`refreshLighting()` = 统一刷新函数（只调用一次，避免逐 key 重复）：
```
function refreshLighting() {
  // 球面坐标 → DirectionalLight 位置（相对模型中心(0,1,0) 12 单位距离）
  const dirAz = deg2rad(getParam('render','dirAngle', -42));
  const dirAlt = deg2rad(getParam('render','dirHeight', 38));
  dirLight.position.set(12*cos(dirAlt)*sin(dirAz), 12*sin(dirAlt), -12*cos(dirAlt)*cos(dirAz));
  dirLight.target.position.set(0, 1, 0);
  dirLight.target.updateMatrixWorld();
  dirLight.color.copy(new THREE.Color(getParam('render','dirLightColor', 0xf0ece3)));
  dirLight.intensity = Number(getParam('render','dirIntensity', 3));

  // SpotLight keyLight：相对中心 keyLightDistance 距离 + 方位角=45°(默认) + 高度角
  const keyAlt = deg2rad(getParam('render','keyLightAngle', 30));
  const keyAz  = deg2rad(keyLight.azimuth ?? 45);
  const dist   = Number(getParam('render','keyLightDistance', 5.5));
  keyLight.position.set(dist*cos(keyAlt)*sin(keyAz), dist*sin(keyAlt) + 0.6, -dist*cos(keyAlt)*cos(keyAz));
  keyLight.target.position.set(0, 1.0, 0);
  keyLight.target.updateMatrixWorld();
  keyLight.angle = Math.PI * (keyLightAngleDeg/180);
  keyLight.penumbra = 0.42;
  keyLight.intensity = Number(getParam('render','keyLightIntensity', 4.8)) * Number(getParam('render','iesIntensityScale',1.0));
  keyLight.color.copy(new THREE.Color(getParam('render','keyLightColor', 0xffd8b0)));
  keyLight.updateProjectionMatrix();  // 改 angle/distance 必调！（上次 bug2 之一）

  // fill/rim/hemisphere/ambient：直接 .copy() / .intensity（不能赋值新 Color 实例）
  fillLight.color.copy(new THREE.Color(getParam('render','fillLightColor', 0x96c8ff)));
  fillLight.intensity = Number(getParam('render','fillLightIntensity', 0.6));
  rimLight .color.copy(new THREE.Color(getParam('render','rimLightColor', 0xffb480)));
  rimLight .intensity = Number(getParam('render','rimLightIntensity', 1.1));
  hemisphereLight.intensity = Number(getParam('render','hemisphereIntensity', 0.6));
  ambientLight.intensity    = Number(getParam('render','ambientIntensity', 0.15));

  // shadowMap 类型 & bias
  applyShadowMapType(getParam('render','shadowMapType','vsm'), { scale: Number(getParam('render','shadowBiasScale', 1.0)), hardLightMode: !!getParam('render','hardLightMode', true) });

  // shadow textures 强制刷新（改 mapSize 后必须，否则切预设会"影子不更新"）
  if (dirLight.shadow?.map) dirLight.shadow.map.needsUpdate = true;
  if (keyLight.shadow?.map) keyLight.shadow.map.needsUpdate = true;
}
```

| key | 生效钩子 |
|---|---|
| dirIntensity/dirLightColor/dirAngle/dirHeight | 直接改属性 + 下一次 refreshLighting() 统一刷新位置 |
| keyLight* 所有 / iesIntensityScale | 同上 + `keyLight.updateProjectionMatrix()` 必调 |
| fillLight*/rimLight*/hemisphereIntensity/ambientIntensity | .copy()/intensity 直接 |
| shadowMapType / shadowBiasScale | `applyShadowMapType(type, {scale, hardLightMode})`：<br>type==='none' → renderer.shadowMap.enabled = false；<br>否则 enabled=true，并 `renderer.shadowMap.type` 映射 BasicShadowMap / PCFSoftShadowMap / VSMShadowMap；<br>VSM 特例：`dirLight.shadow.camera.near = 0.5 * scale; dirLight.shadow.camera.far = 30 * scale; dirLight.shadow.bias = -0.0003 * scale; dirLight.shadow.normalBias = 0.02 * Math.max(0, scale);` 防止 acne。 |

### 3.4 IES cookie 组（IES）
| key | 生效钩子 | 失败降级 |
|---|---|---|
| iesPreset / iesUserPath | `loadIesTexture()`：<br>① preset==='none' → `keyLight.map = null`；<br>② preset ∈ [softbox-round, softbox-strip, grid-spot, window-blind] → `buildIesTexture(preset)`：1024x1024 Canvas2D 画灰度形状 → THREE.CanvasTexture；**LRU 存 4 张**，命中直接复用（`__iesTextureCache` WeakMap + LRU 链表）；<br>③ preset==='user' && iesUserPath 非空 → THREE.TextureLoader().load(absolutePath, onLoad, undefined, onError)；<br>④ 最后：`keyLight.map = tex; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true; keyLight.castShadow = true;` | onError 时 → toast 「IES 文件加载失败：{reason}」；自动 `setParam('render','iesPreset','none')` 回退；保持界面不崩。 |

内置 4 形状 canvas 画法（纯代码生成，不依赖文件）：
- `softbox-round`：`radialGradient(cx,cy,r*0.3 → cx,cy,r)` 从 1.0 → 0.0，外圈柔边 + 轻微 vignette
- `softbox-strip`：横向椭圆高斯 + 宽高比 3:1，用作主光条形柔光箱
- `grid-spot`：同心 4 圈衰减环 + 45° 十字网格半透明线
- `window-blind`：12 条横向等宽条纹 + 顶部 30% 更强

### 3.5 HDR 环境贴图组（HDR）
| key | 生效钩子 | 失败降级 |
|---|---|---|
| hdrPreset / hdrUserPath / envMapAsBackground / envMapIntensity | `rebuildEnvMap({preset,userPath,asBg,intensity})`：<br>① **先 dispose 旧 envRT 和纹理**（避免每换一次 HDR 涨 30MB GPU 显存）；<br>② preset==='none' → 用程序化天空盒 canvas 纹理 `pmremGenerator.fromEquirectangular(skyCanvasTex)` → `scene.environment = envRT.texture`；scene.background = skyboxEnabled ? skyMesh : new THREE.Color(bgColor)；<br>③ preset ∈ [studio-box/showroom-gray/sunset/neon-ring/window-overcast] → `buildProceduralHdrEquirect(preset)`（2048x1024 Canvas2D 画 equirect 全景）→ pmrem；asBg=true 时 scene.background = envRT.texture；<br>④ preset==='user' && userPath → 用 RGBELoader(userPath).then(dataTexture → pmrem)，读取文件失败自动抛错；<br>⑤ envMapIntensity 改后：遍历 scene.traverse，若 `material.envMapIntensity!==undefined` 就赋值并需要 needsUpdate（`__lastEnvMapIntensity` 幂等跳过）。 | RGBELoader/texture 失败 → toast 「HDR 文件加载失败：{reason}」；**自动 setParam('render','hdrPreset','none') 回退**；并设置 `scene.environment = fallback envRT(程序化天空盒)`，保证不黑屏；旧 envRT 对象 dispose 后立即 replace，避免中间帧 scene.environment 为空。 |

内置 5 款程序化 HDR equirect（2048x1024 Canvas2D 画）：
- `studio-box`：中性灰柔光箱环绕（前/后/左/右四个大矩形）+ 顶部柔光
- `showroom-gray`：上下方向 0.9→0.45 的灰色渐变，展厅中性光
- `sunset`：地平线 0 行 深红 `#8a2b18` → 60 行橙 `#e8824a` → 600 行淡蓝 `#c0d6e6` → 顶深蓝 `#2a3a5c` + 太阳圆盘 @ y=0.07 行
- `neon-ring`：环形品红 `#ff3d9f` → 青 `#33c6ff` → 绿 `#7bffb0` 的三原色环 + 四周暗
- `window-overcast`：阴天窗光 → 顶部 1/3 亮方形 "窗户" 渐变，下方冷灰色

### 3.6 特效组（SSGI / GodRay / LensFlare）
**核心机制**：每个特效 pass 用 `ensure<PassName>Pass(bool, opts)` 保证在 composer.passes 中处于正确顺序（§1 管线）；启用/关闭时动态 `splice` composer.passes 数组然后 `composer.setSize(w,h)` 重分配内部 RT。

| key | 生效钩子 |
|---|---|
| aoMode | `ensureAoMode(mode)`：<br>① 先从 composer.passes 中寻找并移除 SSGIPass / SAOPass（已存在的先 `.dispose()` 再 splice）；<br>② mode==='ssao' → `new SAOPass(scene, camera)` + 设置 ssaoIntensity → 插入 contactShadowsShaderPass 之后；<br>③ mode==='ssgi' → `new SSGIPass(scene, camera)` + 赋值 ssgiRadius/thickness/maxRoughness/intensity → 插入同位置；<br>④ mode==='off' → 不插入。<br>**SAOPass.enabled 联动规则**：mode==='ssao' 插好后，`saoPass.enabled = !!getParam('render','ssaoEnabled', false)`；**applyParam('ssaoEnabled', v)** 直接写 `saoPass && (saoPass.enabled = !!v)`（因为 pass 实例始终存在于 composer.passes 里，只要 enabled=false 就 GPU 跳过分段，零开销）。<br>最后：`composer.setSize(w,h)` 重分配所有 pass 的 RT（SSGIPass 内部有多组 MRT，必须 setSize），再调用 `composer.setPixelRatio(devicePixelRatio)` |
| ssgiRadius / ssgiThickness / ssgiMaxRoughness / ssgiIntensity | 直接写 `ssgiPass.radius / .thickness / .maxRoughness / .intensity`；改完 `ssgiPass.updateSSGIMaterial?.()`；SSGIPass 未创建就跳过 |
| godRayEnabled / godRay* / godRaySource | `ensureGodRayPass(bool)`：enabled → 未建时 `new GodRayPass({depthTex: renderPass.depthTexture})` 建；已建就 pass.enabled=true；位置插入在 `SAO/SSGI` 之后、UnrealBloomPass 之前；GodRay 需要 `uScreenLightPos`（归一化屏幕坐标），每帧 animate 时按 `godRaySource` 计算：<br>source='sun' → skyUniforms.sunDir 应用 viewProjection → 投影 NDC → +1/-1；<br>source='keylight' → keyLight.getWorldPosition() → 同上投影。<br>改完需要重新 setSize。 |
| lensFlareEnabled / lensFlare* | `ensureLensFlarePass(bool)`：位置在 GodRayPass 之后、Bloom 之前；LensFlarePass 需要 `uDepthTex`（renderPass.depthTexture）做自动遮挡——采样 `uScreenLightPos` 对应像素深度，如果深度值 < near+epsilon（被前景挡住）→ `uOcclusionMask = 0`，自动把光晕压到看不见。改完 setSize。 |

### 3.7 天空盒 / 背景 / 雾扩展
`skyboxEnabled / bgColor / fogColor`：**保持原有逻辑**；**新增 envMapAsBackground=true 特例**：当 HDR envMap 已加载且 envMapAsBackground=true → 执行以下 3 步顺序：
1. `scene.background = envRT.texture`（HDR 等距柱状贴图直接覆盖，不做纯色）；
2. `skyMesh.visible = false`（强制隐藏程序化天空穹顶，防止 HDR 背景和天空盒 shader 两层叠加造成画面过曝/泛白）；
3. **仅**同步修改 `scene.fog.color.copy(fogColor)` → 雾颜色保持一致；**禁止**执行旧代码 `scene.background = new THREE.Color(bgColor)`。

当 `envMapAsBackground=false` 或 HDR 回退到 preset='none' 时，立即恢复：`skyMesh.visible = skyboxEnabled`，`scene.background = skyboxEnabled ? skyMesh : new THREE.Color(bgColor)`（与旧逻辑完全一致）。

**参数解耦原则**：切 envMapAsBackground **不改写 `skyboxEnabled` 参数本身**（两个 flag 保持独立）；UI 上可同时显示两个 switch，但在 applyParam('envMapAsBackground', true) 时用 `__envBgOverride = true` 标记；关闭此标记时按 `skyboxEnabled` 当前值恢复，避免"切个 HDR 天空盒开关也被改了"的意外联动。

---

## 4. UI 结构（快捷浮层 + 右侧手风琴 5 组 + 汇总 chip，方案 A「多层配置防堆按钮」）

### 4.1 快捷浮层（右上角玻璃层，最多 6 行）
```
┌─────────────────────────────────────────┐
│ [🎯 当前: AgX｜伦勃朗｜VSM柔影] ◀ chip  │ ← hover tooltip 显示完整 5 类启用清单
├─────────────────────────────────────────┤
│ 色调映射: [AgX (推荐)         ▾]        │
│ 布光预设: [伦勃朗肖像          ▾]        │
│ HDR 类型: [无 (程序化天空盒)   ▾]        │
│ IES 光形: [无                  ▾]        │
│ 色温快滑: [======●============] 5800K    │
└─────────────────────────────────────────┘
```
- **汇总 chip tooltip 内容**（mouseover 显示 5 类完整清单）：
  ```
  🎨 色彩通道：AgX Filmic + 色温 5800K + 对比 1.05 + vibrance 1.10
  🎬 布光：伦勃朗预设 (dir 2.8, key 8.0@62°+55°R, fill 0.3, rim 0.4)
  💡 光源：程序化天空盒, 无 IES
  🌫 特效：接触阴影开; AO=关; 体积光=关; 镜头光晕=关; Bloom强度=0.22
  🖼 阴影：VSM柔影, 接触阴影=on, SSAO=off
  ```
- 点击色温快滑时会同步联动右侧「色彩曝光」手风琴组内色温滑块（双向绑定）。

### 4.2 右侧参数面板 → render category 手风琴 5 组
**原则**：同一时间只展开 1 组（点击其它标题自动收起当前）；header 右侧 "⚙ n" chip 显示组内控件数量；用户展开偏好写入 settings.json（`renderAccordionState`）下次启动还原。

| # | 组标题 | 控件数 | 默认展开 |
|---|---|---|---|
| ① | 🎨 色彩 & 曝光 | 11 | ✅ 展开 |
| ② | 🎬 布光预设 | 1（一键下拉 + tooltip 预设说明） | ✅ 展开 |
| ③ | 💡 光源 & HDR | 7（hdrPreset下拉 / hdrUserPath 文件选择按钮+清除 / envMapAsBackground switch / envMapIntensity / iesPreset下拉 / iesUserPath / iesIntensityScale） | ❌ 收起 |
| ④ | 🌫 特效（SSGI/体积光/光晕） | 16（aoMode三选一 + ssao + ssgi 4 + godRay 5 + lensFlare 4 + bloom 3） | ❌ 收起 |
| ⑤ | 🖼 阴影 & 柔化 | 8（shadowMapType 4选1 / shadowBiasScale / hardLightMode / shadowSoftness / contactShadows 3 控件 / shaderBevel 3 / fresnelRim 3） | ❌ 收起 |

**折叠实现**：
- 每个 group `<div class="render-accordion-group" data-group="color">`
  - header：`<div class="acc-header" data-toggle="color">▶ <span>🎨 色彩 & 曝光</span> <span class="acc-chip">⚙11</span></div>`
  - content：`<div class="acc-content">（所有控件）</div>`
- CSS：`.acc-content { max-height:0; overflow:hidden; transition: max-height .28s ease }`；展开时 `max-height: 2400px`；箭头用 CSS `transform: rotate(90deg)` 过渡。
- JS：`accordionRenderToggle(id)`：先收起所有组（去掉 `.expanded`），再对目标组 `.classList.add('expanded')`；把当前展开状态写入 settings.json 的 `renderAccordionState: {color:true,preset:true,light:false,effects:false,shadow:false}`。

### 4.3 控件双向绑定 & debounce
- `range` 滑块：mousemove 时 **16ms debounce** 触发 setParam+applyParam，避免每帧写 settings.json（60fps 拖动会把 settings.json 写爆盘）；mouseup 立即同步一次完整 applyParam（含 expensive 的 HDR/SSGI rebuild）。
- `select` 下拉：change 事件立即 applyParam（一次性，不需 debounce）。
- `checkbox`/`switch`：change 立即 applyParam。
- `hdrUserPath` / `iesUserPath` 文件按钮：点击调用 IPC `preload.call('show-open-dialog-hdr')`（多选框限 1 个文件）→ main.js 用 dialog.showOpenDialog 返回绝对路径 → renderer setParam + 触发 applyParam(hdrPreset='user') / iesPreset='user'。**新增 IPC 2 个**（`show-open-dialog-hdr` + `show-open-dialog-ies`，分别 accept `.hdr,.exr,.png,.jpg` 与 `.png,.jpg,.webp`）。

---

## 5. 错误处理 & 降级路径（spec 补写）

### 5.1 失败清单 & 自动降级策略
| 可能失败点 | 触发条件 | 自动降级动作 | 通知用户方式 |
|---|---|---|---|
| RGBELoader 加载用户 HDR | 文件损坏 / 格式不支持 / 文件不在磁盘 | ① setParam hdrPreset='none' → 程序化天空盒；② dispose 半加载纹理；③ scene.environment 回填 fallback envRT | toast 右下角 3s：「HDR 文件加载失败：{err.message}；已自动回退程序化天空」 |
| 用户 IES 贴图不存在 / 跨域 | 文件不在磁盘 / 404 / CORS | ① setParam iesPreset='none'；② keyLight.map=null | toast 「IES 贴图加载失败：{err}；已关闭光形」 |
| SSGIPass 初始化失败 | 缺失 WEBGL_depth_texture / float32 linear filtering 扩展（Electron 老版） | ① setParam aoMode='ssao'（降级到 SSAO）；② dispose SSGIPass 已分配 RT | toast 「你的 GPU 不支持 SSGI（浮点线性过滤扩展缺失）；已自动回退 SSAO」 |
| ColorBalance shader 编译失败 | WebGL 版本 / 驱动 shader 语法不一致 | ① composer.passes 移除 ColorBalancePass；② setParam colorBalanceEnabled=false | toast 「色彩通道 shader 编译失败；已关闭色彩后处理」 |
| GodRay / LensFlare shader 编译失败 | 同上 | 分别移除对应 pass；对应 enabled=false；保持其他 pass 正常 | toast 分 godray/lens 两个不同提示 |
| HDR equirect / IES canvas 生成 canvas exceed max size | GPU maxTextureSize < 2048 | 生成前检测 gl.getParameter(MAX_TEXTURE_SIZE)；< 2048：HDR 用 1024x512，IES 用 512² | console.warn 不打扰用户（因为有 fallback） |
| 切预设时用户正在拖动模型 / 播放动作导致相机/物理状态不一致 | applyPreset 批量改参数中间 mmdHelper.update 与 refreshLighting 交织 | applyPreset() 期间设置 `window.__presetApplying = true`；animate 循环 `if (__presetApplying) skip mmdHelper.update for 1 frame` 跳过 1 帧动画更新，防止矩阵混乱。 | 不提示（不可见保护） |

### 5.2 GPU 资源泄漏防护（必须，否则长期切 HDR / 切 SSGI 会崩溃）
**每个替换/重建的对象必须 `.dispose()`**：
| 替换对象 | 清理规则 |
|---|---|
| 旧 envRT (PMREM 生成的 WebGLRenderTarget) | `oldEnvRT?.dispose?.(); scene.userData.__envTexture?.dispose?.()`；**每次 rebuildEnvMap 之前先执行** |
| 旧 SAOPass / SSGIPass / GodRayPass / LensFlarePass | ensure<Pass> 中移除时 `oldPass?.dispose?.()`，splice composer.passes 数组后再 composer.setSize(w,h) |
| IES / HDR canvas 纹理 | 切换时 `oldIesTex?.dispose?.()`；WeakMap 里 LRU 超过 4 张时对 LRU 对象 `.dispose()` 再删 |

---

## 6. 性能中档默认策略（spec 补写）
**中档目标**：FHD（1920x1080）+ 中低端独显（1650/2060/RX6600）稳定 ≥ 45fps；动作预览（动作帧率优化后 60Hz）不出现视觉顿挫。

### 6.1 默认只开便宜的（0.1~0.5ms），贵的默认关
| 功能 | 默认状态 | 预估单帧开销（FHD） |
|---|---|---|
| toneMapping=AgX | ✅ 开（替换旧 ACES，但开销相同） | < 0.05ms（几乎一样，都是 tonemap）|
| ColorBalance（色温/tint/contrast/sat/vibrance/LGG）| ✅ 开 | ≈ 0.10ms（单 fullscreen triangle pass）|
| shadowMapType=VSM | ✅ 开 | ≈ 与 PCFSoft 持平；偶尔轻微更快（因为 VSM 一次 blur 而不是 PCF 多次采样）|
| 伦勃朗 / 蝴蝶光 预设 | ✅ 默认 preset='default'；预设 9 个都在快捷浮层选，不用默认切 | 0（都是参数不同，非新 pass）|
| ContactShadows | ✅ 开 | 保持现状 |
| Fresnel Rim + Bevel shader | ✅ 开 | 保持现状 |
| **SSGI** | ❌ 关（aoMode='ssao'；ssao 也默认关） | 开 ≈ 2.0~3.0ms（全分辨率；开 half res 后 ~1.5ms）|
| **GodRay 体积光** | ❌ 关；冷夜 neon 预设才开 | 开 ≈ 0.8~1.5ms（1/4 分辨率 + 32 samples） |
| **LensFlare 镜头光晕** | ❌ 关；neon 预设开 | 开 ≈ 0.5~1.0ms（1/4 分辨率 brightPass + 6 ghost） |
| **真实 HDR 文件加载** | ❌ 关（hdrPreset='none'，用程序化天空盒） | 5 款程序化 HDR 生成 = 一次 2048x1024 canvas 绘制 ≈ 一次性 8ms；之后纯 texture samling ≈ 0 |
| IES cookie | ❌ 默认关（none） | 开 ≈ 几乎 0（就是 SpotLight.map 采样多一层 texture）|

### 6.2 切到高耗时配置的性能保护
用户打开 SSGI + GodRay + LensFlare 全开（合计 ≈ 3.5~5.5ms/帧）时：
- 如果检测到 FPS 连续 3 秒 < 30（用 fpsCounter 的 rolling average 1 秒窗）→ **自动 toast 提示**：「当前渲染配置（SSGI+体积光+镜头光晕）对本机器较重，如需保持流畅可在特效组中关闭一个或多个高耗时项」→ 不强制降级（用户要画质就给画质），只做提示。

---

## 7. 构建 & 冒烟验证清单（spec 补写）
### 7.1 构建
- `npm run build:renderer`：必须输出 `renderer.bundle.js < 2.2MB`，无 esbuild error。新增后处理 shader 全是字符串，不会额外引入 npm 依赖（RGBELoader / SSGIPass / SAOPass 都是 Three.js r170 自带，`three/examples/jsm/...` 直接 import）。

### 7.2 冒烟验证（13 项 smoke）
新增或需要重点关注的断言（其余 4 项 PASS 仍为基准，FAIL 属空 mods 目录依赖）：
| smoke case | 验证点 | 预期 |
|---|---|---|
| `params-reset-refresh` | 默认值 toneMapping / colorTemp / shadowMapType 正确 | toneMapping=agx（非 ACES），colorTemp=5800K，shadowMapType=vsm；全部 PASS |
| `postfx-order-sanity` | EffectComposer.passes 顺序（渲染 → ContactShadow → AO/SSGI → GodRay → Lens → Bloom → ColorBalance → Output）| assert passes 名称列表与 §1 表严格一致（启用的功能按顺序插入，关闭时消失保持位置）|
| `envmap-switch-no-leak` | HDR preset 切 5 次（none→studio-box→sunset→user 失败→neon-ring→none），检测 GPU 纹理句柄无泄漏 | 通过 `renderer.info.memory.textures` 前后变化 ≤ 4（4 张 LRU IES + 1 张 env 被 dispose 回收后应稳定）；PASS |
| `preset-9-switch-no-error` | 快速切 9 个预设（每个预设 500ms 间隔），控制台无 JS error / WebGL warning，FPS rolling avg ≥ 45 | PASS |
| `ssgi-fallback-on-missing-ext` | 模拟 SSGIPass 抛错 → aoMode 自动回 'ssao'，toast 有提示 | 用 monkeypatch 构造场景验证；PASS |

---

## 8. 范围界定（不做 / 延期做）
- ❌ **不做路径追踪 / 光子映射 / LightMass 烘焙 GI**：WebGL 实时性能不够。
- ❌ **不做 RectAreaLight**：MMD 默认材质是 MeshLambert/MeshToon，RectAreaLight 只影响 MeshStandardMaterial，先不做（以后切换材质体系再说）。
- ❌ **不做重量级体积雾（VolumetricFog）**：32 步 raymarch ≈ 5ms 代价，超过中档目标；只做轻量级 GodRay。
- ⏳ **延期**：envMap 支持 CubeMap（六面）；当前只要 Equirectangular（等距柱状）就够了（HDR/EXR 标准格式）。

