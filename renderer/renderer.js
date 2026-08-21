/* ============ MMDModelViewer 渲染进程 · 浅色玻璃简约风 ============ */
import * as THREE from 'three';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { MMDLoader } from '../node_modules/three/examples/jsm/loaders/MMDLoader.js';
import { MMDAnimationHelper } from '../node_modules/three/examples/jsm/animation/MMDAnimationHelper.js';
import { EffectComposer } from '../node_modules/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '../node_modules/three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from '../node_modules/three/examples/jsm/postprocessing/OutlinePass.js';
import { ShaderPass } from '../node_modules/three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from '../node_modules/three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from '../node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SAOPass } from '../node_modules/three/examples/jsm/postprocessing/SAOPass.js';
import { FXAAShader } from '../node_modules/three/examples/jsm/shaders/FXAAShader.js';
import { RGBELoader } from '../node_modules/three/examples/jsm/loaders/RGBELoader.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from '../node_modules/three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from '../node_modules/three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from '../node_modules/three/examples/jsm/loaders/FBXLoader.js';
import { TDSLoader } from '../node_modules/three/examples/jsm/loaders/TDSLoader.js';
import { STLLoader } from '../node_modules/three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from '../node_modules/three/examples/jsm/loaders/PLYLoader.js';
import { ColladaLoader } from '../node_modules/three/examples/jsm/loaders/ColladaLoader.js';
import { DDSLoader } from '../node_modules/three/examples/jsm/loaders/DDSLoader.js';

const api = window.mmdAPI;
const MOTION_EXTS_RE = /\.(vmd|vpd)$/i;
// 可直接 3D 预览的网格格式（MMD + 主流通用格式）
const MODEL_MESH_RE = /\.(pmx|pmd|gltf|glb|obj|fbx|stl|dae|ply|3ds)$/i;
// 专有二进制格式：仅识别分类（可选中/缓存/入库），无法在浏览器端解析预览
const NON_PREVIEW_RE = /\.(max|blend)$/i;
const ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|xz|tgz|txz)$/i;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const fileTreeEl = $('file-tree');
const sceneTreeEl = $('scene-tree');
const modelInfoEl = $('model-info');
const statusText = $('status-text');
const statusDetail = $('status-detail');
const rootPathEl = $('root-path');
const animPanel = $('anim-panel');
const vmdListEl = $('vmd-list');
const speedRange = $('speed-range');
const speedVal = $('speed-val');
const breadcrumbEl = $('breadcrumb');
const btnBack = $('btn-back');
const btnForward = $('btn-forward');
const btnUp = $('btn-up');
const btnHome = $('btn-home');
const motionListEl = $('motion-list');
const motionFilterEl = $('motion-filter');
const modListEl = $('mod-list');
const modFilterEl = $('mod-filter');
const recentListEl = $('recent-list');
const libCards = document.querySelectorAll('.lib-card');
const sideViews = document.querySelectorAll('.side-view');
const previewCardEl = $('preview-card');
const pcTitle = $('pc-title');
const pcBody = $('pc-body');
const pcClose = $('pc-close');
const archivePreviewEl = $('archive-preview');
const apTitle = $('ap-title');
const apBody = $('ap-body');
const apClose = $('ap-close');
const apExtract = $('ap-extract');

// ---------- 导航栈 ----------
const navStack = { back: [], forward: [] };
let defaultRootPath = null;
let motionRootPath = null;
let sceneRootPath = null;
let sceneRoot = null;
let activeTab = 'models';
let lastArchivePreviewPath = null;

// ---------- 状态 ----------
let currentRoot = null;
let currentDirPath = null;
let currentModelPath = null;
let currentModel = null;
let currentMesh = null;
// 场景模型集合：与角色模型同时预览。加入场景的模型不会被 clearModel 移除
// kind: 'scene' = 场景背景（仅一个，换场景时替换）；'placed' = 组合面板放置的可动模型
let sceneItems = [];  // { mesh, node, kind }
let composeTargetMesh = null;  // 组合面板最近放置的可动模型（附加动作的目标）
let composeSelected = null;    // 组合面板当前选中的模型（移动/动作目标，选中边缘高亮）
// 组合面板自定义下拉框实例（r2：展开显示选项名称 + 类型徽标）
let composeSceneDD = null;
let composeModelDD = null;
let composeMotionDD = null;
// 组合模型数量上限（r3：不含动作，默认 3，可在参数面板「组合」组修改）
function composeMaxPlaced() {
  const v = Number(getParam('compose', 'maxPlaced', 3));
  return Math.max(1, Math.min(20, Math.floor(v) || 3));
}
function composePlacedCount() {
  return (sceneItems || []).filter((s) => s && s.kind === 'placed').length;
}
// AnimationMixer（旧管线）已废弃；统一由 MMDAnimationHelper 管理 IK + 物理 + 动画
let mmdHelper = null;
let ammoReady = false;
let currentAnimating = false;  // 表示当前是否有动作在驱动（用于播放按钮显示）
let vmdFiles = [];
let motionRootItems = [];
let motionFilterKw = '';
let modRootItems = [];
let modFilterKw = '';
let modArchivesCache = null; // mod 压缩包缓存（含 .ini 的），null 表示未扫描
let recentItems = [];

// Win10 扁平文件树辅助：dir 行的 path -> Set(所有后代 rows 的引用)
const dirDescendants = new Map();  // key: dirPath(normalized) -> Set<HTMLElement>

// ---------- 最近加载（localStorage 持久化） ----------
const RECENT_KEY = 'mmdviewer_recent';
const RECENT_MAX = 20;
// ---------- 参数面板持久化 ----------
const PARAMS_KEY = 'mmdviewer_params_v1';
const DEFAULT_PARAMS = {
  render: {
    // ---------- 预设 ----------
    renderPreset:     { t: 'select', v: 'default', label: '渲染预设', hint: '一键套用整组参数',
                        options: [['default','🟰 默认预览'],['film','🎞 电影质感'],['natural','🌤 自然预览'],['studio','🎬 原色工作室'],['rembrandt','🖼 伦勃朗肖像'],['butterfly','🦋 蝴蝶光时尚'],['backlit','🌇 剪影背光'],['coldnight','🌙 冷夜氛围'],['neon','🌈 霓虹舞台'],['custom','🎛 自定义']] },
    presetName:       { t: 'hidden', v: 'default', label: '当前布光预设' },
    // ---------- 基础 ----------
    outlineEnabled:   { t: 'switch', v: true,  label: '轮廓描边',    hint: '稳定模型边缘抖动' },
    edgeStrength:     { t: 'range',  v: 0.9,   label: '边缘强度',    min: 0, max: 2, step: 0.01 },
    edgeThickness:    { t: 'range',  v: 0.003, label: '边缘粗细',    min: 0.0001, max: 0.01, step: 0.0001 },
    edgeColor:        { t: 'color',  v: '#111827', label: '边缘颜色' },
    fxaaEnabled:      { t: 'switch', v: true,  label: 'FXAA 快速抗锯齿' },
    pixelRatioMax:    { t: 'range',  v: 2,     label: '像素比上限',  min: 1, max: 3, step: 0.25 },
    shadowEnabled:    { t: 'switch', v: true,  label: '阴影' },
    shadowSoftness:   { t: 'range',  v: 1,     label: '阴影柔和度(旧)',  min: 0, max: 2, step: 0.05 },
    gridVisible:      { t: 'switch', v: true,  label: '显示网格地面' },
    bgColor:          { t: 'color',  v: '#F0F1F5', label: '背景色(天空盒关闭时)' },
    toneMappingExposure:{ t: 'range', v: 0.95,  label: '曝光值 (Tone Exposure)', min: 0.3, max: 1.6, step: 0.01 },
    // ---------- 色彩通道 CMAP ----------
    toneMapping:      { t: 'select', v: 'agx', label: '色调映射 (Tone Mapping)', hint: '建议 AgX Filmic，更贴近电影中性肤色',
                        options: [['aces','ACES Filmic'],['agx','AgX (推荐)'],['reinhard','Reinhard'],['cineon','Cineon'],['linear','Linear'],['none','None']] },
    colorBalanceEnabled:{ t: 'switch', v: true, label: '色彩通道 (色温/对比/饱和)' },
    colorTemp:        { t: 'range',  v: 5800,  label: '色温 (K)',   min: 2000, max: 12000, step: 50, hint: '2000K=暖黄 / 6500K=白 / 12000K=冷蓝' },
    colorTint:        { t: 'range',  v: 0,     label: 'Tint (绿↔洋红)',  min: -100, max: 100, step: 1 },
    contrast:         { t: 'range',  v: 1.05,  label: '对比度 Contrast', min: 0.5, max: 1.6, step: 0.01 },
    saturation:       { t: 'range',  v: 1.00,  label: '饱和度 Saturation', min: 0,   max: 1.6, step: 0.01 },
    vibrance:         { t: 'range',  v: 1.10,  label: '自然饱和 Vibrance', min: 0, max: 1.6, step: 0.01, hint: '抬升不饱和像素，避免肤色过饱和' },
    // liftGammaGain 作为特殊控件：拆为 3 条 range 在 UI 中合并
    liftGammaGain:    { t: 'lgg',    v: [0,1,1], label: 'Lift / Gamma / Gain' },
    // ---------- 光照 ----------
    hardLightMode:    { t: 'switch', v: false, label: '硬光模式',    hint: '方向光强对比+硬阴影，关闭为柔和漫射' },
    ambientIntensity: { t: 'range',  v: 0.65,  label: '环境光强度',  min: 0, max: 2, step: 0.01 },
    hemiIntensity:    { t: 'range',  v: 0.6,   label: '半球光强度',  min: 0, max: 2, step: 0.01 },
    dirIntensity:     { t: 'range',  v: 1.0,   label: '主方向光强度', min: 0, max: 8, step: 0.01 },
    dirAngle:         { t: 'range',  v: -42,   label: '主方向光方位角(°)', min: -180, max: 180, step: 1, hint: '水平角度，左/右绕角色旋转' },
    dirHeight:        { t: 'range',  v: 38,    label: '主方向光高度角(°)', min: -15, max: 89, step: 1, hint: '仰角，太阳/月亮高低' },
    fillIntensity:    { t: 'range',  v: 0.30,  label: '补光 (Fill) 强度', min: 0, max: 3, step: 0.01 },
    fillLightColor:   { t: 'color',  v: '#96C8FF', label: '补光 (Fill) 颜色' },
    dirLightColor:    { t: 'color',  v: '#FFF1DC', label: '主方向光颜色' },
    // ---- 聚光灯 Key Light ----
    keyLightEnabled:  { t: 'switch', v: true,  label: '聚光灯 (Key Light)', hint: '带圆锥角的主光，立体感优于方向光' },
    keyLightIntensity:{ t: 'range',  v: 6.0,   label: '聚光灯强度',  min: 0, max: 15, step: 0.1 },
    keyLightAngle:    { t: 'range',  v: 32,    label: '聚光角度(°)', min: 10, max: 80, step: 1 },
    keyLightHeight:   { t: 'range',  v: 30,    label: '聚光高度角(°)', min: 5, max: 85, step: 1, hint: 'Key 光高度角，伦勃朗 62° / 蝴蝶光 68°' },
    keyLightAzimuth:  { t: 'range',  v: 45,    label: '聚光方位角(°)', min: -180, max: 180, step: 1, hint: 'Key 光水平旋转：正前 0° / 右 45°=伦勃朗 / -170°=背' },
    keyLightDistance: { t: 'range',  v: 5.5,   label: '聚光距离',    min: 2, max: 15, step: 0.1 },
    keyLightPenumbra: { t: 'range',  v: 0.35,  label: '半影(柔边)',  min: 0, max: 1, step: 0.01 },
    keyLightColor:    { t: 'color',  v: '#FFE8BF', label: '聚光灯颜色' },
    // ---- 轮廓光 Rim ----
    rimLightEnabled:  { t: 'switch', v: true,  label: '方向光轮廓光 (Rim)' },
    rimLightIntensity:{ t: 'range',  v: 1.1,   label: 'Rim 光强度',  min: 0, max: 4, step: 0.01 },
    rimLightColor:    { t: 'color',  v: '#FFC890', label: 'Rim 光颜色' },
    rimLightAzimuth:  { t: 'range',  v: -140,  label: 'Rim 方位角(°)', min: -180, max: 180, step: 1, hint: '剪影背光预设: -170° 后上高位' },
    rimLightHeight:   { t: 'range',  v: 45,    label: 'Rim 高度角(°)', min: 5, max: 89, step: 1 },
    // ---- IES cookie ----
    iesPreset:        { t: 'select', v: 'none', label: 'IES 光形 (Key Cookie)',
                        options: [['none','无'],['softbox-round','柔光球(圆)'],['softbox-strip','柔光条(3:1)'],['grid-spot','蜂窝聚光'],['window-blind','百叶窗'],['user','自定义 PNG…']] },
    iesUserPath:      { t: 'file',   v: '',     label: 'IES 用户 PNG', accept: 'png,jpg,webp' },
    iesIntensityScale:{ t: 'range',  v: 1.0,    label: 'IES 强度倍率', min: 0.1, max: 4, step: 0.01 },
    // ---- HDR 环境 ----
    hdrPreset:        { t: 'select', v: 'none', label: 'HDR 环境 (IBL)',
                        options: [['none','无(程序化天空盒)'],['studio-box','棚拍柔光箱'],['showroom-gray','展厅中性灰'],['sunset','日落氛围'],['neon-ring','霓虹三色环'],['window-overcast','阴天侧窗'],['user','自定义 HDR/EXR…']] },
    hdrUserPath:      { t: 'file',   v: '',     label: '用户 HDR/EXR', accept: 'hdr,exr,png,jpg' },
    envMapAsBackground:{ t: 'switch', v: false, label: 'HDR 同时作为背景', hint: '用 HDR 全景做背景，替代程序化天空穹顶' },
    envMapIntensity:  { t: 'range',  v: 1.0,    label: '环境强度 (envMapIntensity)', min: 0, max: 3, step: 0.01 },
    skyboxEnabled:    { t: 'switch', v: true,  label: '程序化天空盒' },
    // ---------- 后处理 ----------
    bloomEnabled:     { t: 'switch', v: true,  label: 'Bloom 泛光',   hint: '高亮区域柔化发光' },
    bloomStrength:    { t: 'range',  v: 0.42,  label: '泛光强度',     min: 0, max: 2.0, step: 0.01 },
    bloomThreshold:   { t: 'range',  v: 0.82,  label: '泛光阈值',     min: 0, max: 1.0, step: 0.01, hint: '低于此亮度的像素不发光' },
    bloomRadius:      { t: 'range',  v: 0.52,  label: '泛光半径',     min: 0, max: 1.0, step: 0.01 },
    contactShadowsEnabled:  { t: 'switch', v: true,  label: '接触阴影 Contact Shadows', hint: '脚底/褶皱处贴地增强' },
    contactShadowsOpacity:  { t: 'range',  v: 0.55,  label: '接触阴影浓度', min: 0, max: 1.0, step: 0.01 },
    contactShadowsDistance: { t: 'range',  v: 0.08,  label: '搜索距离(相对)', min: 0.005, max: 0.3, step: 0.005, hint: '越大阴影范围越大' },
    // --- AO / SSGI ---
    aoMode:           { t: 'select', v: 'ssao', label: '屏幕空间 AO 模式', hint: 'off=关闭 / ssao=轻量级 / ssgi=屏幕空间 GI（较贵）',
                        options: [['off','关闭'],['ssao','SSAO (推荐中低档)'],['ssgi','SSGI (屏幕空间GI，贵)']] },
    ssaoEnabled:      { t: 'switch', v: false, label: 'SSAO 环境遮蔽', hint: '屏幕空间遮蔽，褶皱/缝隙处体积感增强' },
    ssaoIntensity:    { t: 'range',  v: 0.75,  label: 'SSAO 强度',    min: 0, max: 2.0, step: 0.01 },
    ssaoRadius:       { t: 'range',  v: 8,     label: 'SSAO 采样半径',min: 1, max: 20, step: 0.5 },
    ssgiEnabled:      { t: 'switch', v: false, label: 'SSGI GI 开关(联动 aoMode)' },
    ssgiRadius:       { t: 'range',  v: 0.18,  label: 'SSGI 半径',    min: 0.02, max: 0.8, step: 0.01 },
    ssgiThickness:    { t: 'range',  v: 0.015, label: 'SSGI 厚度阈值',min: 0.002, max: 0.1, step: 0.001 },
    ssgiMaxRoughness: { t: 'range',  v: 0.9,   label: 'SSGI 最大粗糙度', min: 0, max: 1, step: 0.01 },
    ssgiIntensity:    { t: 'range',  v: 1.0,   label: 'SSGI 强度',    min: 0, max: 3, step: 0.01 },
    // --- God Ray ---
    godRayEnabled:    { t: 'switch', v: false, label: '体积光 (God Ray)' },
    godRayIntensity:  { t: 'range',  v: 0.85,  label: '体积光强度',   min: 0, max: 3, step: 0.01 },
    godRayDecay:      { t: 'range',  v: 0.955, label: '体积光衰减',   min: 0.9, max: 0.999, step: 0.001 },
    godRayWeight:     { t: 'range',  v: 0.35,  label: '体积光权重',   min: 0.1, max: 1, step: 0.01 },
    godRaySamples:    { t: 'range',  v: 32,    label: '体积光采样数', min: 8, max: 128, step: 4 },
    godRaySource:     { t: 'select', v: 'sun', label: '体积光来源',    options: [['sun','程序化天空太阳方向'],['keylight','聚光灯 Key Light 位置']] },
    // --- Lens Flare ---
    lensFlareEnabled: { t: 'switch', v: false, label: '镜头光晕 Lens Flare' },
    lensFlareIntensity:{ t: 'range', v: 0.7,   label: '光晕强度',     min: 0, max: 3, step: 0.01 },
    lensFlareThreshold:{ t: 'range', v: 0.9,   label: '光晕阈值',     min: 0.5, max: 1, step: 0.01 },
    lensFlareGhosts:  { t: 'range',  v: 6,     label: '鬼影层数',     min: 1, max: 12, step: 1 },
    lensFlareChromatic:{ t: 'range', v: 0.08,  label: '色散(彩边)',   min: 0, max: 0.2, step: 0.005 },
    // ---------- 材质增强 ----------
    fresnelRimEnabled:{ t: 'switch', v: true,  label: 'Fresnel 轮廓光 Shader', hint: '模型边缘一圈发微光（发丝/服饰）' },
    fresnelRimColor:  { t: 'color',  v: '#A8C0FF', label: 'Rim Shader 颜色' },
    fresnelRimPower:  { t: 'range',  v: 4.5,   label: 'Rim 细度',     min: 1.0, max: 10.0, step: 0.1, hint: '越大圈越细' },
    fresnelRimIntensity:{ t: 'range',v: 0.38,  label: 'Rim 强度',     min: 0, max: 2.0, step: 0.01 },
    shaderBevelEnabled:{ t: 'switch', v: false, label: '着色器假倒角', hint: '硬边缘高光圆润(不改几何体)' },
    shaderBevelStrength:{ t: 'range', v: 1.2,   label: '倒角强度',     min: 0.2, max: 3.0, step: 0.05 },
    // ---------- 阴影柔化 / VSM ----------
    shadowMapType:    { t: 'select', v: 'vsm',  label: '阴影图类型',
                        options: [['none','关闭'],['basic','Basic 硬'],['pcfsoft','PCF Soft 软'],['vsm','VSM 柔影(推荐)']] },
    shadowBiasScale:  { t: 'range',  v: 1.0,    label: '阴影 Bias 倍率', min: -2, max: 2, step: 0.1, hint: 'VSM 需用紧凑 bias 防 acne；>1 更松、<1 更紧' },
    // ---------- 手风琴持久化状态 ----------
    renderAccordionState:{ t: 'hidden', v: '{"color":true,"preset":true,"light":false,"effects":false,"shadow":false}', label: 'render 手风琴展开状态(JSON)' },
  },
  physics: {
    enabled:          { t: 'switch', v: true,  label: '物理（布料/刚体）', hint: '加载新模型时完整生效，部分参数可实时修改' },
    gravity:          { t: 'range',  v: 6.2,   label: '重力 m/s²',   min: 0, max: 20, step: 0.1, hint: '降低布料/头发垂坠抖动的主要旋钮' },
    unitStep:         { t: 'select', v: '1/120',label: '物理步进',
                        options: [['1/60','1/60'],['1/120','1/120'],['1/30','1/30']] },
    maxStepNum:       { t: 'range',  v: 3,     label: '最大迭代步数', min: 1, max: 6, step: 1, hint: '高频运动时加大以避免穿模/抖动' },
    autoDisableHeavy: { t: 'switch', v: true,  label: '刚体>200自动关闭物理' },
  },
  ik: {
    enabled:          { t: 'switch', v: false, label: 'IK 求解（下肢/手臂）', hint: '加载新模型/切动作时生效' },
    iteration:        { t: 'range',  v: 50,    label: 'IK 迭代次数',  min: 1, max: 200, step: 1 },
    toleranceAngle:   { t: 'range',  v: 0.08,  label: 'IK 收敛角(rad)', min: 0.001, max: 0.5, step: 0.001 },
  },
  anim: {
    speedScale:       { t: 'range',  v: 1.0,   label: '全局速度倍率',  min: 0.1, max: 3, step: 0.05 },
    loopAnimation:    { t: 'switch', v: true,  label: '循环播放动作' },
    resetOnStop:      { t: 'switch', v: true,  label: '停止后回到BindPose' },
    afterglow:        { t: 'range',  v: 0.1,   label: '切动作余辉(秒)', min: 0, max: 1, step: 0.01 },
  },
  compose: {
    maxPlaced:        { t: 'range',  v: 3,     label: '组合模型上限',  min: 1, max: 20, step: 1, hint: '组合面板可放置的模型数量（不含场景与动作）' },
  },
};
let PARAMS = {};
const PARAM_DEFS = DEFAULT_PARAMS;
// 启动回灌参数时置 true，抑制 applyParam 中的状态栏提示噪音
let initApplyingParams = false;
// 启动时把所有已持久化参数回灌到渲染管线/灯光/网格等（物理/IK 需 helper 重建的除外，它们由 buildHelperOptions 读取）
function applyAllParams() {
  initApplyingParams = true;
  try {
    for (const gk of Object.keys(PARAMS || {})) {
      const [g, k] = String(gk).split('.');
      if (!g || !k) continue;
      try { applyParam(g, k, PARAMS[gk], undefined); } catch (_) { /* noop */ }
    }
  } finally {
    initApplyingParams = false;
  }
}
function flattenParams(src) {
  const out = {};
  for (const g of Object.keys(src || {})) {
    const grp = src[g] || {};
    for (const k of Object.keys(grp)) {
      out[`${g}.${k}`] = grp[k].v;
    }
  }
  return out;
}
function loadParams() {
  const defaults = flattenParams(DEFAULT_PARAMS);
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      PARAMS = Object.assign({}, defaults, obj || {});
      return;
    }
  } catch (_) { /* noop */ }
  PARAMS = Object.assign({}, defaults);
}
function saveParams() {
  try { localStorage.setItem(PARAMS_KEY, JSON.stringify(PARAMS || {})); } catch (_) { /* ignore */ }
}
function getParam(group, key, fallback) {
  const v = PARAMS[`${group}.${key}`];
  return (typeof v === 'undefined' || v === null) ? fallback : v;
}
function setParam(group, key, value, { persist = true, apply = true } = {}) {
  const k = `${group}.${key}`;
  const prev = PARAMS[k];
  PARAMS[k] = value;
  if (persist) saveParams();
  if (apply) applyParam(group, key, value, prev);
}
function applyParam(group, key, value, prev) {
  const set = (obj, field, transform) => { if (obj && typeof obj[field] !== 'undefined') obj[field] = (transform ? transform(value) : value); };
  // 手动修改参数时，renderPreset 自动切到 custom（预设 applyPreset 内部会临时锁）
  if (group === 'render' && !window.__presetApplyingLock && key !== 'renderPreset') {
    try {
      const cur = getParam('render', 'renderPreset', 'custom');
      if (cur !== 'custom') {
        window.__presetApplyingLock = true;
        setParam('render', 'renderPreset', 'custom', { persist: true, apply: true });
        initApplyingParams || refreshRenderPanelUI();
      }
    } finally { window.__presetApplyingLock = false; }
  }
  if (group === 'render') {
    if (key === 'renderPreset') { applyPreset(String(value || 'default')); return; }
    if (key === 'presetName') { /* 只持久化，不直接生效；由 applyPreset 一并维护 */ return; }
    if (key === 'skyboxEnabled') { try { setSkyboxEnabled(!!value); } catch (_) {} return; }
    if (key === 'renderAccordionState') { return; } // 只持久化 JSON 字符串
    if (key === 'toneMappingExposure') { try { renderer.toneMappingExposure = Math.max(0.3, Number(value) || 1); } catch (_) {} }
    if (key === 'shadowEnabled') set(renderer.shadowMap, 'enabled');
    if (key === 'pixelRatioMax') {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, Math.max(1, Number(value) || 1)));
      resize();
    }
    // -------- 色彩通道 CMAP --------
    if (key === 'toneMapping') {
      try {
        const want = String(value || 'agx');
        if (window.__postfx && window.__postfx.__lastToneMapping === want) { /* noop */ }
        else {
          const map = {
            aces: THREE.ACESFilmicToneMapping,
            agx: (typeof THREE.AgXToneMapping !== 'undefined') ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping,
            reinhard: THREE.ReinhardToneMapping,
            cineon: THREE.CineonToneMapping,
            linear: THREE.LinearToneMapping,
            none: THREE.NoToneMapping,
          };
          renderer.toneMapping = (typeof map[want] !== 'undefined') ? map[want] : THREE.ACESFilmicToneMapping;
          renderer.outputColorSpace = THREE.SRGBColorSpace;
          if (window.__postfx) {
            window.__postfx.__lastToneMapping = want;
            // 刷新内部 RT：遍历 passes 强制 setSize
            const vp = $('viewport');
            const w = vp ? vp.clientWidth : (canvas.clientWidth || 1);
            const h = vp ? vp.clientHeight : (canvas.clientHeight || 1);
            if (w > 0 && h > 0) {
              window.__postfx.composer.setSize(w, h);
            }
          }
        }
      } catch (_) { /* noop */ }
    }
    if (key === 'colorBalanceEnabled') {
      try { ensureColorBalancePass(); } catch (_) {}
      const postfx = window.__postfx;
      if (postfx && postfx.colorBalancePass) postfx.colorBalancePass.enabled = !!value;
    }
    if (key === 'colorTemp' || key === 'colorTint') {
      try {
        const tK = Number(getParam('render', 'colorTemp', 5800)) || 5800;
        const tint = Number(getParam('render', 'colorTint', 0)) || 0;
        const cacheKey = `${tK}|${tint}`;
        if (window.__postfx && window.__postfx.__lastTempTintKey === cacheKey) { /* 幂等跳过 */ }
        else {
          const gain = colorTempTintToWBGain(tK, tint);
          ensureColorBalancePass();
          if (window.__postfx && window.__postfx.colorBalancePass) {
            const u = window.__postfx.colorBalancePass.uniforms;
            u.uWBGain.value.set(gain[0], gain[1], gain[2]);
            window.__postfx.__lastTempTintKey = cacheKey;
          }
        }
      } catch (_) { /* noop */ }
    }
    if (key === 'contrast') { try { ensureColorBalancePass(); if (window.__postfx?.colorBalancePass) window.__postfx.colorBalancePass.uniforms.uContrast.value = Math.max(0.5, Math.min(1.6, Number(value) || 1)); } catch (_) {} }
    if (key === 'saturation') { try { ensureColorBalancePass(); if (window.__postfx?.colorBalancePass) window.__postfx.colorBalancePass.uniforms.uSaturation.value = Math.max(0, Math.min(1.6, Number(value) || 0)); } catch (_) {} }
    if (key === 'vibrance') { try { ensureColorBalancePass(); if (window.__postfx?.colorBalancePass) window.__postfx.colorBalancePass.uniforms.uVibrance.value = Math.max(0, Math.min(1.6, Number(value) || 0)); } catch (_) {} }
    if (key === 'liftGammaGain') {
      try {
        ensureColorBalancePass();
        if (!window.__postfx?.colorBalancePass) { /* noop */ }
        else {
          const arr = Array.isArray(value) ? value : getParam('render', 'liftGammaGain', [0,1,1]);
          const lift = Math.max(-0.3, Math.min(0.3, Number(arr[0]) || 0));
          const gam  = Math.max(0.3, Math.min(2.5, Number(arr[1]) || 1));
          const gain = Math.max(0.3, Math.min(2.5, Number(arr[2]) || 1));
          const u = window.__postfx.colorBalancePass.uniforms;
          u.uLift.value = lift;
          u.uGamma.value = gam;
          u.uGain.value = gain;
        }
      } catch (_) { /* noop */ }
    }
    if (key === 'bgColor') {
      try {
        const c = new THREE.Color(String(value));
        const asBg = !!window.__postfx && !!window.__postfx.__envBgOverride;
        if (asBg) {
          // HDR 作为背景时，scene.background 已被 envRT.texture 接管；bgColor 只作为雾色
        } else if (!skyboxEnabled || (scene.background && !skyMesh)) {
          scene.background = c;
        }
        _fogParams.color = c.clone().multiplyScalar(0.78).lerp(new THREE.Color(0x0B0E14), 0.35);
        if (scene.fog) { try { scene.fog.color.copy(_fogParams.color); } catch (_) {} }
      } catch (_) {}
    }
    if (key === 'gridVisible') { try { gridHelper.visible = !!value; } catch (_) {} }
    // -------- 硬光 / 阴影柔化 / VSM 柔影：统一作为 alias 写入 shadowMapType & shadowBiasScale --------
    if (key === 'hardLightMode') {
      try {
        const hard = !!value;
        // 聚光灯 penumbra 联动（保持旧行为）
        if (typeof keyLight !== 'undefined') {
          const cur = Number(keyLight.penumbra) || 0;
          keyLight.penumbra = hard ? Math.min(cur, 0.38) : Math.max(cur, 0.45);
          keyLight.shadow.mapSize.set(hard ? 2048 : 1024, hard ? 2048 : 1024);
          keyLight.shadow.needsUpdate = true;
        }
        if (typeof dirLight !== 'undefined') {
          dirLight.shadow.radius = hard ? 0.15 : 3.0;
          dirLight.shadow.mapSize.set(hard ? 2048 : 1024, hard ? 2048 : 1024);
          dirLight.shadow.needsUpdate = true;
        }
        // 硬光 → Basic；柔光 → VSM
        setParam('render', 'shadowBiasScale', hard ? 0.8 : 1.0, { persist: false, apply: true });
        setParam('render', 'shadowMapType', hard ? 'basic' : 'vsm', { persist: true, apply: true });
      } catch (_) { /* noop */ }
    }
    if (key === 'shadowSoftness') {
      try {
        const v = Number(value) || 0;
        let t = 'vsm';
        if (v <= 0.25) t = 'basic';
        else if (v <= 0.75) t = 'pcfsoft';
        else if (v <= 1.25) t = 'vsm';
        else t = 'vsm';
        if (getParam('render', 'shadowMapType', 'vsm') !== t) {
          setParam('render', 'shadowMapType', t, { persist: true, apply: true });
        } else {
          // 无实际类型变化，仍需要刷新阴影贴图（旧 softness 行为）
          if (dirLight && dirLight.shadow) dirLight.shadow.needsUpdate = true;
          if (keyLight && keyLight.shadow) keyLight.shadow.needsUpdate = true;
        }
        markMaterialsNeedsUpdate();
      } catch (_) { /* noop */ }
    }
    if (key === 'shadowMapType' || key === 'shadowBiasScale') {
      try {
        applyShadowMapType(
          String(getParam('render', 'shadowMapType', 'vsm') || 'vsm'),
          {
            scale: Number(getParam('render', 'shadowBiasScale', 1.0) || 1.0),
            hardLightMode: !!getParam('render', 'hardLightMode', false),
          }
        );
      } catch (_) { /* noop */ }
    }
    const postfx = window.__postfx;
    if (postfx) {
      if (key === 'outlineEnabled') {
        if (postfx.outlinePass) {
          postfx.outlinePass.enabled = !!value;
          refreshOutlineSelection();
        }
      }
      if (key === 'edgeStrength' && postfx.outlinePass) postfx.outlinePass.edgeStrength = Number(value) || 0;
      if (key === 'edgeThickness' && postfx.outlinePass) postfx.outlinePass.edgeThickness = Number(value) || 0;
      if (key === 'edgeColor' && postfx.outlinePass) {
        try {
          const c = new THREE.Color(String(value));
          postfx.outlinePass.visibleEdgeColor.copy(c);
          postfx.outlinePass.hiddenEdgeColor.copy(c).multiplyScalar(0.15);
        } catch (_) { /* noop */ }
      }
      if (key === 'fxaaEnabled' && postfx.fxaaPass) postfx.fxaaPass.enabled = !!value;
      if (key === 'bloomEnabled' && postfx.bloomPass) postfx.bloomPass.enabled = !!value;
      if (key === 'bloomStrength' && postfx.bloomPass) postfx.bloomPass.strength = Number(value) || 0;
      if (key === 'bloomThreshold' && postfx.bloomPass) postfx.bloomPass.threshold = Number(value) || 0;
      if (key === 'bloomRadius' && postfx.bloomPass) postfx.bloomPass.radius = Number(value) || 0;
      if (key === 'contactShadowsEnabled' && postfx.contactShadowsPass) postfx.contactShadowsPass.enabled = !!value;
      if (key === 'contactShadowsOpacity' && postfx.contactShadowsPass) {
        if (postfx.contactShadowsPass.uniforms) postfx.contactShadowsPass.uniforms.opacity.value = Number(value) || 0;
      }
      if (key === 'contactShadowsDistance' && postfx.contactShadowsPass) {
        if (postfx.contactShadowsPass.uniforms) postfx.contactShadowsPass.uniforms.maxDistance.value = Number(value) || 0;
      }
      // ---- AO / SSGI ----
      if (key === 'aoMode') { try { ensureAoMode(String(value || 'off')); } catch (_) {} }
      if (key === 'ssaoEnabled') {
        // Sao 实例存在时直接 enabled 切换（pass 始终在 composer.passes 里，enabled=false GPU 跳过分段，零开销）
        if (postfx.saoPass) postfx.saoPass.enabled = !!value;
        else if (getParam('render', 'aoMode', 'ssao') === 'ssao') try { ensureAoMode('ssao'); } catch (_) {}
      }
      if (key === 'ssaoIntensity' && postfx.saoPass) { try { postfx.saoPass.intensity = Number(value) || 0; } catch(_) { try { postfx.saoPass.params.intensity = Number(value) || 0; } catch(_2){} } }
      if (key === 'ssaoRadius' && postfx.saoPass)    { try { postfx.saoPass.radius = Number(value) || 0; } catch(_)    { try { postfx.saoPass.params.radius = Number(value) || 0; } catch(_2){} } }
      if (key === 'ssgiEnabled') {
        const mode = String(getParam('render', 'aoMode', 'ssao') || 'ssao');
        if (!!value && mode !== 'ssgi') setParam('render', 'aoMode', 'ssgi', { persist: true, apply: true });
        else if (!value && mode === 'ssgi') {
          // 关 SSGI switch → 回 ssao
          if (postfx.ssgiPass) try { ensureAoMode('ssao'); } catch (_) {}
        }
      }
      if (key === 'ssgiRadius' || key === 'ssgiThickness' || key === 'ssgiMaxRoughness' || key === 'ssgiIntensity') {
        if (!postfx.ssgiPass) { /* SSGIPass 未创建跳过 */ }
        else {
          try {
            if (key === 'ssgiRadius') {
              if ('radius' in postfx.ssgiPass) postfx.ssgiPass.radius = Number(value) || 0;
              if (postfx.ssgiPass.params) postfx.ssgiPass.params.radius = Number(value) || 0;
            }
            if (key === 'ssgiThickness') {
              if ('thickness' in postfx.ssgiPass) postfx.ssgiPass.thickness = Number(value) || 0;
              if (postfx.ssgiPass.params) postfx.ssgiPass.params.thickness = Number(value) || 0;
            }
            if (key === 'ssgiMaxRoughness') {
              if ('maxRoughness' in postfx.ssgiPass) postfx.ssgiPass.maxRoughness = Number(value) || 0;
              if (postfx.ssgiPass.params) postfx.ssgiPass.params.maxRoughness = Number(value) || 0;
            }
            if (key === 'ssgiIntensity') {
              if ('intensity' in postfx.ssgiPass) postfx.ssgiPass.intensity = Number(value) || 0;
              if (postfx.ssgiPass.params) postfx.ssgiPass.params.intensity = Number(value) || 0;
            }
            if (typeof postfx.ssgiPass.updateSSGIMaterial === 'function') postfx.ssgiPass.updateSSGIMaterial();
          } catch (_) { /* noop */ }
        }
      }
      // ---- God Ray ----
      if (key === 'godRayEnabled') { try { ensureGodRayPass(!!value); } catch (_) {} }
      if ((postfx.godRayPass) && ['godRayIntensity','godRayDecay','godRayWeight','godRaySamples'].indexOf(key) >= 0) {
        try {
          const u = postfx.godRayPass.uniforms;
          if (key === 'godRayIntensity') u.uIntensity.value = Math.max(0, Number(value) || 0);
          if (key === 'godRayDecay')     u.uDecay.value     = Math.max(0.8, Math.min(0.999, Number(value) || 0.95));
          if (key === 'godRayWeight')    u.uWeight.value    = Math.max(0.05, Math.min(1, Number(value) || 0.35));
          if (key === 'godRaySamples')   u.uSamples.value   = Math.max(8, Math.min(128, Math.floor(Number(value) || 32)));
        } catch (_) { /* noop */ }
      }
      if (key === 'godRaySource') { /* 每帧在 animate 中按此值重算 uScreenLightPos，此处仅确保 pass 存在 */ try { if (getParam('render','godRayEnabled', false)) ensureGodRayPass(true); } catch(_){} }
      // ---- Lens Flare ----
      if (key === 'lensFlareEnabled') { try { ensureLensFlarePass(!!value); } catch (_) {} }
      if (postfx.lensFlarePass && ['lensFlareIntensity','lensFlareThreshold','lensFlareGhosts','lensFlareChromatic'].indexOf(key) >= 0) {
        try {
          const u = postfx.lensFlarePass.uniforms;
          if (key === 'lensFlareIntensity') u.uIntensity.value = Math.max(0, Number(value) || 0);
          if (key === 'lensFlareThreshold') u.uThreshold.value = Math.max(0.1, Math.min(1, Number(value) || 0.9));
          if (key === 'lensFlareGhosts')    u.uGhosts.value    = Math.max(1, Math.min(12, Math.floor(Number(value) || 6)));
          if (key === 'lensFlareChromatic') u.uChromatic.value = Math.max(0, Math.min(0.3, Number(value) || 0.08));
        } catch (_) { /* noop */ }
      }
    }
    // -------------- 灯光：直接改属性或通过 refreshLighting() --------------
    if (key === 'ambientIntensity') { if (typeof ambientLight !== 'undefined') { ambientLight.intensity = Number(value) || 0; } }
    if (key === 'hemiIntensity')    { if (typeof hemisphereLight !== 'undefined') { hemisphereLight.intensity = Number(value) || 0; } }
    if (key === 'dirIntensity')     { if (typeof dirLight !== 'undefined')     { dirLight.intensity = Number(value) || 0; } }
    if (key === 'fillIntensity')    { if (typeof fillLight !== 'undefined')    { fillLight.intensity = Number(value) || 0; } }
    if (key === 'dirLightColor')    { if (typeof dirLight !== 'undefined')     { try { dirLight.color.copy(new THREE.Color(String(value))); } catch (_){} } }
    if (key === 'fillLightColor')   { if (typeof fillLight !== 'undefined')    { try { fillLight.color.copy(new THREE.Color(String(value))); } catch (_){} } }
    // 球面坐标类键：只改 PARAMS 值（下次 refreshLighting() 统一刷新）
    if (['dirAngle','dirHeight','keyLightDistance','keyLightAzimuth','keyLightHeight','rimLightAzimuth','rimLightHeight'].indexOf(key) >= 0) {
      try { refreshLighting(); } catch (_) {}
    }
    // ---- SpotLight Key Light ----
    if (key === 'keyLightEnabled')  { if (typeof keyLight !== 'undefined')     { keyLight.visible = !!value; keyLight.castShadow = !!value; } }
    if (key === 'keyLightIntensity'){ if (typeof keyLight !== 'undefined')     { keyLight.intensity = Number(value) || 0; try { refreshLighting(); } catch(_){} } }
    if (key === 'keyLightAngle')    { if (typeof keyLight !== 'undefined')     { keyLight.angle = Math.PI / 180 * (Number(value) || 30); keyLight.updateProjectionMatrix && keyLight.updateProjectionMatrix(); } }
    if (key === 'keyLightPenumbra') { if (typeof keyLight !== 'undefined')     { keyLight.penumbra = Math.max(0, Math.min(1, Number(value) || 0)); } }
    if (key === 'keyLightColor')    { if (typeof keyLight !== 'undefined')     { try { keyLight.color.copy(new THREE.Color(String(value))); } catch (_){} } }
    if (key === 'iesIntensityScale'){ if (typeof keyLight !== 'undefined')     { try { refreshLighting(); } catch (_){} } }
    if (key === 'iesPreset' || key === 'iesUserPath') { try { loadIesTexture(); } catch (_) {} }
    // ---- Rim Directional ----
    if (key === 'rimLightEnabled')  { if (typeof rimLight !== 'undefined')     { rimLight.visible = !!value; } }
    if (key === 'rimLightIntensity'){ if (typeof rimLight !== 'undefined')     { rimLight.intensity = Number(value) || 0; } }
    if (key === 'rimLightColor')    { if (typeof rimLight !== 'undefined')     { try { rimLight.color.copy(new THREE.Color(String(value))); } catch (_){} } }
    // ---- HDR / Environment ----
    if (['hdrPreset','hdrUserPath','envMapAsBackground','envMapIntensity'].indexOf(key) >= 0) {
      try {
        rebuildEnvMap({
          preset:    String(getParam('render','hdrPreset','none') || 'none'),
          userPath:  String(getParam('render','hdrUserPath','') || ''),
          asBg:      !!getParam('render','envMapAsBackground', false),
          intensity: Number(getParam('render','envMapIntensity', 1.0) || 1.0),
        });
      } catch (_) { /* noop */ }
    }
    // -------------- 材质增强（Shader 注入，应用到所有已加载材质）--------------
    if (['fresnelRimEnabled','fresnelRimColor','fresnelRimPower','fresnelRimIntensity',
         'shaderBevelEnabled','shaderBevelStrength'].indexOf(key) >= 0) {
      try { markMaterialsNeedsUpdate(); } catch (_){}
    }
    // ---- 收尾：快捷面板 chip 更新（幂等：内部缓存） ----
    try { updateRqpChip(); } catch (_) {}
  } else if (group === 'physics' || group === 'ik') {
    // 这些参数需要下一次 helper.add（重建 physics/ikSolver）才会生效：
    // 这里立即尝试对 mmdHelper.objects 中当前 mesh 的 ikSolver/physics 做一次尽力修改，能改就改；
    // 不能改的（重建级别）保持 PARAMS 值即可，下一次 loadModel / btn-stop / playVmd 会读取。
    if (group === 'physics') {
      // 遍历当前所有已 add 的 mesh physics 做尽力实时修改（所有 mesh 都改，不局限于 currentMesh）
      const meshTargets = [];
      if (mmdHelper && mmdHelper.objects) {
        try {
          for (const m of mmdHelper.objects.keys()) {
            if (m && m.isMesh) meshTargets.push(m);
          }
        } catch (_) {}
      }
      if (key === 'gravity') {
        const gravityN = Math.max(0, Number(value) || 0);
        meshTargets.forEach((m) => {
          try { tunePhysicsForMesh(m); } catch (_) {}  // tunePhysicsForMesh 内会重算 world.setGravity
        });
        if (!initApplyingParams) {
          try { setStatus(`物理重力已实时调整为 ${gravityN.toFixed(1)} m/s²`, 'info'); } catch (_) { /* noop */ }
        }
        return;
      }
      if (key === 'enabled') {
        meshTargets.forEach((m) => {
          try {
            const obj = mmdHelper && mmdHelper.objects && mmdHelper.objects.get(m);
            if (!obj) return;
            if (!!value) {
              // 开启：把之前缓存的 physics 存回 obj（如果 obj.__disabledPhysics 有备份）
              if (obj.__disabledPhysics && !obj.physics) {
                obj.physics = obj.__disabledPhysics;
                obj.__disabledPhysics = null;
                try {
                  if (m && m.updateMatrixWorld) m.updateMatrixWorld(true);
                  if (obj.physics && obj.physics.reset) obj.physics.reset();
                  tunePhysicsForMesh(m, { forceApplyDamping: true });
                } catch (_) {}
              }
              mmdHelper.enabled.physics = true;
            } else {
              // 关闭：保存 physics 引用并置 null，让 helper 不再更新；保留 __disabledPhysics 以便再开启
              if (obj.physics) { obj.__disabledPhysics = obj.physics; obj.physics = null; }
              mmdHelper.enabled.physics = false;
            }
          } catch (_) {}
        });
        return;
      }
      if (key === 'unitStep' || key === 'maxStepNum') {
        // 这两个值是 mmdHelper.configuration / physics 创建级别，已在运行的 physics 无法替换 step；
        // 仍对当前所有 mesh 尝试 tune（避免误操作完全无反应），并提示下次生效
        meshTargets.forEach((m) => { try { tunePhysicsForMesh(m, { forceApplyDamping: true }); } catch (_) {} });
        if (!initApplyingParams) {
          try { setStatus(`物理参数「${key}」已记录，会在下一次加载模型/停止动作时应用`, 'warn'); } catch (_) { /* noop */ }
        }
        return;
      }
      if (key === 'autoDisableHeavy') {
        if (!initApplyingParams) {
          try { setStatus(`物理参数「${key}」已记录，下一次加载模型时判断刚体数量是否自动关闭物理`, 'info'); } catch (_) { /* noop */ }
        }
        return;
      }
    }
    if (group === 'ik') {
      // 若 ikSolver 已经存在（已经 add 进 mmdHelper），尝试把每根 ik 的 iteration/tolerance 覆盖
      if (mmdHelper && currentMesh && mmdHelper.objects && mmdHelper.objects.has(currentMesh)) {
        const obj = mmdHelper.objects.get(currentMesh);
        const ikSolver = obj && obj.ikSolver;
        if (ikSolver && Array.isArray(ikSolver.iks)) {
          ikSolver.iks.forEach((ik) => {
            if (key === 'iteration') { ik.iteration = Math.max(1, Math.floor(Number(value) || 1)); }
            if (key === 'toleranceAngle') {
              ik.minAngle = Math.max(0, Number(value) || 0);
            }
          });
        }
        if (key === 'enabled') {
          mmdHelper.enabled.ik = !!value;
        }
      }
    }
  } else if (group === 'anim') {
    if (key === 'speedScale') {
      try {
        if (speedRange) { speedRange.value = String(Math.max(0.1, Math.min(3, Number(value) || 1))); }
        if (speedVal) { speedVal.textContent = parseFloat(speedRange.value).toFixed(1) + 'x'; }
        // 同步当前 mixer.timeScale（btn-play/pause 会覆盖它，这里保持一致）
        if (mmdHelper && currentMesh && mmdHelper.objects && mmdHelper.objects.has(currentMesh)) {
          const obj = mmdHelper.objects.get(currentMesh);
          if (obj && obj.mixer) {
            const s = parseFloat(speedRange.value) || 1;
            obj.mixer.timeScale = s;
          }
        }
      } catch (_) { /* noop */ }
    }
    if (key === 'loopAnimation') {
      if (mmdHelper && currentMesh && mmdHelper.objects && mmdHelper.objects.has(currentMesh)) {
        const obj = mmdHelper.objects.get(currentMesh);
        const mixer = obj && obj.mixer;
        if (mixer && mixer._actions && mixer._actions.length) {
          const mode = value ? THREE.LoopRepeat : THREE.LoopOnce;
          mixer._actions.forEach((act) => { if (act) act.loop = mode; });
          // 重置到 0 时让 LoopOnce 重新进入「可播放一次」的状态
          if (mixer._actions.length) {
            const cur = mixer._actions[0];
            if (cur) { cur.reset(); }
          }
        }
      }
    }
    if (key === 'resetOnStop') {
      // 记录在 PARAMS，btn-stop 读取；用户可见反馈
      if (!initApplyingParams) {
        try { setStatus(value ? '停止时将回到 BindPose' : '停止时保持当前姿势', 'info'); } catch (_) { /* noop */ }
      }
    }
    if (key === 'afterglow') {
      // afterglow 是 MMDAnimationHelper.configuration 级别，需要重建 helper（或直接改 configuration）
      if (mmdHelper && mmdHelper.configuration) {
        mmdHelper.configuration.afterglow = Math.max(0, Number(value) || 0);
      }
      if (!initApplyingParams) {
        try { setStatus(`切动作余辉：${(Number(value) || 0).toFixed(2)}s`, 'info'); } catch (_) { /* noop */ }
      }
    }
  }
}
function refreshOutlineSelection() {
  if (!window.__postfx || !window.__postfx.outlinePass) return;
  const sel = [];
  const collect = (root) => {
    if (root && root.traverse) root.traverse((c) => { if (c && c.isMesh) sel.push(c); });
  };
  // 组合面板选中目标：仅该模型边缘高亮；未选中时保持全模型描边
  if (composeSelected) {
    collect(composeSelected);
  } else {
    collect(currentMesh);
    (sceneItems || []).forEach((s) => collect(s && s.mesh));
  }
  window.__postfx.outlinePass.selectedObjects = sel;
}
function resetParamGroup(groupName) {
  const defaults = flattenParams(DEFAULT_PARAMS);
  for (const gk of Object.keys(defaults)) {
    const [g, k] = gk.split('.');
    if (g !== groupName) continue;
    setParam(g, k, defaults[gk], { persist: true, apply: true });
  }
}
function resetAllParams() {
  const defaults = flattenParams(DEFAULT_PARAMS);
  for (const gk of Object.keys(defaults)) {
    const [g, k] = gk.split('.');
    setParam(g, k, defaults[gk], { persist: true, apply: true });
  }
}
// 所有已加载材质 needsUpdate=true，让 onBeforeCompile 重新注入 Shader（Fresnel Rim / 假倒角）
function markMaterialsNeedsUpdate() {
  const touched = new WeakSet();
  const applyTo = (m) => {
    if (!m || !m.isMesh || !m.material) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach((mat) => {
      if (!mat || touched.has(mat)) return;
      touched.add(mat);
      try {
        // 触发 onBeforeCompile 重新编译（重注入 Fresnel/Bevel uniform 和 chunk）
        injectEnhancementShader(mat);
        mat.needsUpdate = true;
      } catch (_) { /* noop */ }
    });
  };
  if (currentMesh) currentMesh.traverse && currentMesh.traverse(applyTo);
  (sceneItems || []).forEach((s) => { if (s && s.mesh && s.mesh.traverse) s.mesh.traverse(applyTo); });
}
// 一键渲染预设：9 套（default/film/natural/studio + 新增 5 套：rembrandt/butterfly/backlit/coldnight/neon）+ custom 纯占位
// 注意：预设只写入数值，不触发手动改值时的 custom 自动切换（用 __presetApplyingLock 锁）
// 预设结构：{label, overrides}；overrides 仅写"非 DEFAULT"值，避免冗余
const _PRESETS = {
  default: {
    label: '🟰 默认预览',
    overrides: {},
  },
  film: {
    label: '🎞 电影质感',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.82,
      colorTemp: 5400,
      contrast: 1.12,
      hardLightMode: true,
      ambientIntensity: 0.08,
      hemiIntensity: 0.18,
      dirIntensity: 4.8,
      dirHeight: 38,
      dirAngle: -42,
      fillIntensity: 0.7,
      fillLightColor: '#BFD4F0',
      dirLightColor: '#FFE4BD',
      keyLightEnabled: true,
      keyLightIntensity: 6.2,
      keyLightAngle: 28,
      keyLightHeight: 28,
      keyLightDistance: 5.5,
      keyLightAzimuth: 45,
      keyLightPenumbra: 0.35,
      keyLightColor: '#FFC98B',
      rimLightEnabled: true,
      rimLightIntensity: 1.1,
      rimLightColor: '#FFA560',
      shadowMapType: 'vsm',
      bloomEnabled: true,
      bloomStrength: 0.36,
      bloomThreshold: 0.86,
      bloomRadius: 0.55,
      contactShadowsEnabled: true,
      contactShadowsOpacity: 0.56,
      contactShadowsDistance: 0.08,
      aoMode: 'ssao',
      ssaoEnabled: true,
      ssaoIntensity: 0.80,
      ssaoRadius: 9,
      fresnelRimEnabled: true,
      fresnelRimColor: '#FFB78A',
      fresnelRimPower: 4.4,
      fresnelRimIntensity: 0.34,
      shaderBevelEnabled: true,
      shaderBevelStrength: 1.2,
      skyboxEnabled: true,
    },
  },
  natural: {
    label: '🌤 自然预览',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.95,
      colorTemp: 6200,
      hardLightMode: false,
      ambientIntensity: 0.28,
      hemiIntensity: 0.44,
      dirIntensity: 2.2,
      dirHeight: 42,
      dirAngle: -30,
      fillIntensity: 0.5,
      fillLightColor: '#A8C0FF',
      dirLightColor: '#FFF1DC',
      keyLightEnabled: true,
      keyLightIntensity: 3.6,
      keyLightAngle: 34,
      keyLightHeight: 24,
      keyLightAzimuth: 38,
      keyLightPenumbra: 0.55,
      keyLightColor: '#FFE8BF',
      rimLightEnabled: true,
      rimLightIntensity: 0.65,
      rimLightColor: '#FFC890',
      bloomEnabled: true,
      bloomStrength: 0.20,
      bloomThreshold: 0.92,
      bloomRadius: 0.30,
      contactShadowsEnabled: true,
      contactShadowsOpacity: 0.35,
      contactShadowsDistance: 0.06,
      aoMode: 'ssao',
      ssaoEnabled: false,
      ssaoIntensity: 0.60,
      ssaoRadius: 7,
      fresnelRimEnabled: true,
      fresnelRimColor: '#A8C0FF',
      fresnelRimPower: 5.0,
      fresnelRimIntensity: 0.22,
      shaderBevelEnabled: false,
      shaderBevelStrength: 1.0,
      skyboxEnabled: true,
    },
  },
  studio: {
    label: '🎬 原色工作室',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.88,
      colorTemp: 5600,
      saturation: 1.08,
      hardLightMode: true,
      ambientIntensity: 0.18,
      hemiIntensity: 0.30,
      dirIntensity: 5.2,
      dirHeight: 42,
      dirAngle: -44,
      fillIntensity: 0.55,
      fillLightColor: '#BFD4F0',
      dirLightColor: '#E8EEFF',
      keyLightEnabled: true,
      keyLightIntensity: 7.2,
      keyLightAngle: 26,
      keyLightHeight: 32,
      keyLightAzimuth: 42,
      keyLightPenumbra: 0.25,
      keyLightColor: '#D8E3FF',
      rimLightEnabled: true,
      rimLightIntensity: 0.95,
      rimLightColor: '#B4C5FF',
      shadowMapType: 'vsm',
      bloomEnabled: false,
      bloomStrength: 0.10,
      bloomThreshold: 0.98,
      bloomRadius: 0.15,
      contactShadowsEnabled: true,
      contactShadowsOpacity: 0.68,
      contactShadowsDistance: 0.09,
      aoMode: 'ssao',
      ssaoEnabled: true,
      ssaoIntensity: 0.90,
      ssaoRadius: 10,
      fresnelRimEnabled: false,
      fresnelRimColor: '#FFFFFF',
      fresnelRimPower: 5.0,
      fresnelRimIntensity: 0.08,
      shaderBevelEnabled: true,
      shaderBevelStrength: 1.5,
      skyboxEnabled: false,
    },
  },
  rembrandt: {
    label: '🖼 伦勃朗肖像',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.9,
      colorTemp: 5700,
      contrast: 1.15,
      hardLightMode: true,
      ambientIntensity: 0.08,
      hemiIntensity: 0.2,
      dirIntensity: 2.8,
      dirHeight: 30,
      dirAngle: -40,
      fillIntensity: 0.3,
      fillLightColor: '#9bbad0',
      dirLightColor: '#F5E9D0',
      keyLightEnabled: true,
      keyLightIntensity: 8.0,
      keyLightAngle: 36,
      keyLightHeight: 62,
      keyLightAzimuth: 55,
      keyLightPenumbra: 0.30,
      keyLightColor: '#FFD8A8',
      rimLightEnabled: true,
      rimLightIntensity: 0.4,
      rimLightColor: '#FFC890',
      contactShadowsEnabled: true,
      contactShadowsOpacity: 0.50,
      contactShadowsDistance: 0.07,
      shadowMapType: 'vsm',
      bloomEnabled: true,
      bloomStrength: 0.30,
      bloomThreshold: 0.86,
      bloomRadius: 0.40,
      skyboxEnabled: true,
    },
  },
  butterfly: {
    label: '🦋 蝴蝶光时尚',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.92,
      colorTemp: 6000,
      saturation: 1.05,
      vibrance: 1.15,
      hardLightMode: false,
      ambientIntensity: 0.22,
      hemiIntensity: 0.36,
      dirIntensity: 2.5,
      dirHeight: 40,
      dirAngle: -30,
      fillIntensity: 0.7,
      fillLightColor: '#A8C0FF',
      dirLightColor: '#FFF4E4',
      keyLightEnabled: true,
      keyLightIntensity: 7.6,
      keyLightAngle: 30,
      keyLightHeight: 68,
      keyLightAzimuth: 0,  // 正前
      keyLightPenumbra: 0.28,
      keyLightColor: '#FFEED5',
      rimLightEnabled: true,
      rimLightIntensity: 0.85,
      rimLightColor: '#FFC890',
      bloomEnabled: true,
      bloomStrength: 0.25,
      bloomThreshold: 0.9,
      bloomRadius: 0.38,
      aoMode: 'ssao',
      ssaoEnabled: true,
      ssaoIntensity: 0.60,
      ssaoRadius: 8,
      skyboxEnabled: true,
    },
  },
  backlit: {
    label: '🌇 剪影背光',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.88,
      colorTemp: 6400,
      contrast: 1.18,
      hardLightMode: false,
      ambientIntensity: 0.10,
      hemiIntensity: 0.18,
      dirIntensity: 1.8,
      dirHeight: 18,
      dirAngle: 25,
      fillIntensity: 0.4,
      fillLightColor: '#7a9ec9',
      dirLightColor: '#E8F0FF',
      keyLightEnabled: true,
      keyLightIntensity: 1.6,
      keyLightHeight: 15,
      keyLightAzimuth: 0,
      keyLightPenumbra: 0.6,
      keyLightColor: '#C8D8FF',
      rimLightEnabled: true,
      rimLightIntensity: 3.2,
      rimLightAzimuth: -170,
      rimLightHeight: 52,
      rimLightColor: '#ffe9cc',
      hdrPreset: 'showroom-gray',
      envMapAsBackground: true,
      envMapIntensity: 1.1,
      bloomEnabled: true,
      bloomStrength: 0.28,
      bloomThreshold: 0.84,
      bloomRadius: 0.45,
      shadowMapType: 'vsm',
      skyboxEnabled: false,
    },
  },
  coldnight: {
    label: '🌙 冷夜氛围',
    overrides: {
      toneMapping: 'agx',
      toneMappingExposure: 0.86,
      colorTemp: 4100,
      colorTint: -12,
      contrast: 1.08,
      hardLightMode: false,
      ambientIntensity: 0.05,
      hemiIntensity: 0.10,
      dirIntensity: 1.6,
      dirAngle: -28,
      dirHeight: 20,
      fillIntensity: 0.9,
      fillLightColor: '#3f6db0',
      dirLightColor: '#7aa0d8',
      keyLightEnabled: true,
      keyLightIntensity: 2.4,
      keyLightHeight: 36,
      keyLightAzimuth: 30,
      keyLightColor: '#7fb7ff',
      keyLightPenumbra: 0.5,
      rimLightEnabled: true,
      rimLightIntensity: 0.9,
      rimLightColor: '#8ab4ff',
      rimLightAzimuth: -150,
      rimLightHeight: 40,
      hdrPreset: 'window-overcast',
      envMapAsBackground: false,
      envMapIntensity: 0.8,
      godRayEnabled: true,
      godRayIntensity: 0.4,
      godRaySource: 'keylight',
      bloomEnabled: true,
      bloomStrength: 0.30,
      bloomThreshold: 0.88,
      bloomRadius: 0.50,
      shadowMapType: 'vsm',
      skyboxEnabled: true,
    },
  },
  neon: {
    label: '🌈 霓虹舞台',
    overrides: {
      toneMapping: 'reinhard',
      toneMappingExposure: 0.90,
      colorTemp: 7200,
      saturation: 1.35,
      vibrance: 1.40,
      contrast: 1.20,
      hardLightMode: false,
      ambientIntensity: 0.02,
      hemiIntensity: 0.05,
      dirIntensity: 1.2,
      dirAngle: -20,
      dirHeight: 12,
      fillIntensity: 1.2,
      fillLightColor: '#33c6ff',
      dirLightColor: '#2a3060',
      keyLightEnabled: true,
      keyLightIntensity: 5.6,
      keyLightHeight: 40,
      keyLightAzimuth: 55,
      keyLightColor: '#ff3d9f',
      keyLightPenumbra: 0.45,
      rimLightEnabled: true,
      rimLightIntensity: 2.4,
      rimLightAzimuth: -160,
      rimLightHeight: 46,
      rimLightColor: '#7bffb0',
      hdrPreset: 'neon-ring',
      envMapAsBackground: true,
      envMapIntensity: 1.2,
      bloomEnabled: true,
      bloomStrength: 0.48,
      bloomThreshold: 0.60,
      bloomRadius: 0.70,
      lensFlareEnabled: true,
      lensFlareIntensity: 0.9,
      lensFlareThreshold: 0.68,
      lensFlareGhosts: 6,
      lensFlareChromatic: 0.10,
      shadowMapType: 'vsm',
      skyboxEnabled: false,
    },
  },
  custom: {
    label: '🎛 自定义',
    overrides: {}, // custom = 不做任何批量覆盖
  },
};
function applyPreset(name) {
  const preset = _PRESETS[name];
  if (!preset) {
    console.warn('[applyPreset] 未知预设:', name, '；回退 default');
    try { setStatus(`预设「${name}」不存在，已回退默认预览`, 'warn'); } catch (_) {}
    name = 'default';
  }
  window.__presetApplyingLock = true;
  window.__presetApplying = true;
  try {
    const overrides = (preset && preset.overrides) || {};
    // ② 批量 noApply + noSave 写入 overrides 的所有键
    for (const k of Object.keys(overrides)) {
      const def = DEFAULT_PARAMS.render && DEFAULT_PARAMS.render[k];
      if (!def) continue;
      let v = overrides[k];
      if (def.t === 'switch') v = !!v;
      else if (def.t === 'range') v = Number(v);
      // 'select' 保留 string；'lgg' 保留 数组；'hidden'/'file' 原样
      setParam('render', k, v, { persist: false, apply: false });
    }
    // ③ 一次性落盘
    saveParams();
    // ④ 统一刷新灯光/阴影
    try { refreshLighting(); } catch (_) {}
    // ⑤ 对收尾键触发一次 applyParam（都有幂等保护，不怕重复）
    const tailKeys = [
      'toneMapping','colorTemp','colorTint','contrast','saturation','vibrance','liftGammaGain','colorBalanceEnabled',
      'shadowMapType','aoMode','hdrPreset','iesPreset',
      'godRayEnabled','lensFlareEnabled','envMapAsBackground','envMapIntensity','iesIntensityScale',
      'ssaoEnabled','ssgiEnabled','bloomEnabled','outlineEnabled','fxaaEnabled',
      'skyboxEnabled'
    ];
    for (const k of tailKeys) {
      try { applyParam('render', k, getParam('render', k, null), undefined); } catch (_) {}
    }
    // ⑥ 同步 presetName / renderPreset
    setParam('render', 'presetName', name, { persist: true, apply: false });
    setParam('render', 'renderPreset', name, { persist: true, apply: false });
  } finally {
    window.__presetApplyingLock = false;
    // 预设切换期间布料/物理的抖动抑制：再保 1 帧
    requestAnimationFrame(() => { try { window.__presetApplying = false; } catch (_) {} });
    try { refreshRenderPanelUI(); } catch (_) {}
    try { updateRqpChip(); } catch (_) {}
    try { setStatus(`渲染预设：${(preset&&preset.label)||name}`, 'info'); } catch (_) {}
  }
}
// 刷新渲染面板所有控件值（保持控件与 PARAMS 一致，预设切换或 custom 跳转时调用）
function refreshRenderPanelUI() {
  // 1) 右侧完整参数面板：复用已有的 syncParamValuesFromState（基于 p_group_key ID 查）
  try { syncParamValuesFromState('render'); } catch (_) {}
  // 2) 工具栏快捷浮层：同步所有开关/滑块/预设
  try { syncRenderQuickPanelUI(); } catch (_) {}
  // 3) 同步工具栏按钮 active 状态
  try {
    const sbBtn = $('btn-toggle-skybox');
    if (sbBtn) sbBtn.classList.toggle('active', !!getParam('render', 'skyboxEnabled', true));
  } catch (_) {}
}

// =================================================================
// 材质增强 Shader 注入：Fresnel Rim + 假倒角 (Normal Wrangle)
// 挂 material.onBeforeCompile，当 needsUpdate=true 重新编译时生效
// =================================================================
function _hexToRgb(hex) {
  try {
    const c = new THREE.Color(String(hex || '#FFFFFF'));
    return [c.r, c.g, c.b];
  } catch (_) { return [1,1,1]; }
}
function injectEnhancementShader(mat) {
  if (!mat || mat.isShaderMaterial) return;
  // 读取当前 PARAMS 中的增强配置（每个材质编译时都是最新的参数值）
  const rimEnabled = !!getParam('render', 'fresnelRimEnabled', true);
  const [rimR, rimG, rimB] = _hexToRgb(getParam('render', 'fresnelRimColor', '#A8C0FF'));
  const rimPower = Math.max(0.5, Number(getParam('render', 'fresnelRimPower', 4.5)) || 4.5);
  const rimIntensity = Math.max(0, Number(getParam('render', 'fresnelRimIntensity', 0.38)) || 0);
  const bevelEnabled = !!getParam('render', 'shaderBevelEnabled', false);
  const bevelStrength = Math.max(0.1, Number(getParam('render', 'shaderBevelStrength', 1.2)) || 1.2);
  // 避免重复注入标记
  if (mat.__enhInjected && mat.__enhCache
    && mat.__enhCache.rimEnabled === rimEnabled
    && mat.__enhCache.rimPower === rimPower
    && mat.__enhCache.rimIntensity === rimIntensity
    && mat.__enhCache.bevelEnabled === bevelEnabled
    && mat.__enhCache.bevelStrength === bevelStrength
    && Math.abs(mat.__enhCache.rimR - rimR) < 0.001
    && Math.abs(mat.__enhCache.rimG - rimG) < 0.001
    && Math.abs(mat.__enhCache.rimB - rimB) < 0.001) {
    return; // 配置未变，无需重写 onBeforeCompile
  }
  mat.__enhCache = { rimEnabled, rimPower, rimIntensity, bevelEnabled, bevelStrength, rimR, rimG, rimB };
  mat.__enhInjected = true;
  mat.onBeforeCompile = function (shader, renderer) {
    // ---- Uniforms ----
    shader.uniforms._RimEnabled =    { value: rimEnabled ? 1.0 : 0.0 };
    shader.uniforms._RimColor =      { value: new THREE.Color(rimR, rimG, rimB) };
    shader.uniforms._RimPower =      { value: rimPower };
    shader.uniforms._RimIntensity =  { value: rimIntensity };
    shader.uniforms._BevelEnabled =  { value: bevelEnabled ? 1.0 : 0.0 };
    shader.uniforms._BevelStrength = { value: bevelStrength };
    // ---- Vertex: 传 worldNormal / worldPos / viewDir 到片元 ----
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vEnhWorldNormal;\nvarying vec3 vEnhWorldPos;\nvarying vec3 vEnhViewDir;\n`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n` +
        `  vEnhWorldNormal = normalize(mat3(modelMatrix) * normal);\n` +
        `  vEnhWorldPos = worldPosition.xyz;\n` +
        `  vEnhViewDir = normalize(cameraPosition - worldPosition.xyz);\n`
      );
    // ---- Fragment: 1) 倒角 -> 修正 normal; 2) Fresnel Rim -> 加到 gl_FragColor.rgb ----
    let fragHeader =
      `#extension GL_OES_standard_derivatives : enable\n` +
      `varying vec3 vEnhWorldNormal;\n` +
      `varying vec3 vEnhWorldPos;\n` +
      `varying vec3 vEnhViewDir;\n` +
      `uniform float _RimEnabled;\n` +
      `uniform vec3  _RimColor;\n` +
      `uniform float _RimPower;\n` +
      `uniform float _RimIntensity;\n` +
      `uniform float _BevelEnabled;\n` +
      `uniform float _BevelStrength;\n` +
      // 假倒角：基于 face normal(dFdx/dFdy 叉乘) 与 smooth normal 的差，做加权平均
      `vec3 _enhBevelNormal(vec3 N, vec3 pos) {\n` +
      `  vec3 dp1 = dFdx(pos);\n` +
      `  vec3 dp2 = dFdy(pos);\n` +
      `  vec3 faceN = normalize(cross(dp1, dp2));\n` +
      `  if (!gl_FrontFacing) faceN = -faceN;\n` +
      `  float mixK = clamp(_BevelStrength * 0.45, 0.0, 1.0);\n` +
      `  vec3 blended = normalize(mix(N, faceN, mixK));\n` +
      `  // 用 dot 的余弦再做一层锐化：硬边对齐面法线，平滑区保持原 normal\n` +
      `  float d = abs(dot(N, faceN));\n` +
      `  float sharp = smoothstep(0.55, 0.92, 1.0 - d);\n` +
      `  return normalize(mix(N, blended, sharp * _BevelEnabled));\n` +
      `}\n`;
    shader.fragmentShader = fragHeader + shader.fragmentShader;
    // ---- 在 <normal_fragment_begin> 之后把修正过的法线替换进 geometryNormal ----
    // normal_fragment_begin 里有 `vec3 normal = normalize( vNormal );`，我们可以在其后追加：
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>\n` +
      `  normal = _enhBevelNormal(normalize(vEnhWorldNormal), vEnhWorldPos);\n` +
      `  #ifdef USE_TANGENT\n` +
      `    // 如果有 tangent 空间，重新把 worldNormal 投影回 TBN 用于 normalmap\n` +
      `    mat3 TBN = mat3( normalize( vTBN[0] ), normalize( vTBN[1] ), normalize( vTBN[2] ) );\n` +
      `    normal = normalize( TBN * normal );\n` +
      `  #endif\n`
    );
    // ---- 在最后输出颜色之前（`#include <dithering_fragment>` 之后）叠加 Fresnel Rim ----
    // dithering_fragment 一般在 `gl_FragColor = ...` 之前最后一个 chunk；
    // 对 MeshLambert/Phong 等旧材质，输出是 `gl_FragColor = vec4( outgoingLight, diffuseColor.a );`；
    // 我们直接在输出前追加 `gl_FragColor.rgb += rim * rimIntensity * rimEnabled`：
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>\n` +
      `  if (_RimEnabled > 0.5 && _RimIntensity > 0.0001) {\n` +
      `    vec3 V = normalize(vEnhViewDir);\n` +
      `    vec3 N2 = normalize(vEnhWorldNormal);\n` +
      `    float fres = pow(1.0 - max(dot(N2, V), 0.0), _RimPower);\n` +
      `    vec3 rimCol = _RimColor * fres * _RimIntensity;\n` +
      `    gl_FragColor.rgb += rimCol;\n` +
      `  }\n`
    );
  };
  mat.needsUpdate = true;
}

// =================================================================
// 接触阴影 Contact Shadows Shader（屏幕空间光线步进）
// 读取深度缓冲 → 朝法线方向 N 步 → 命中“紧贴”像素则加暗
// =================================================================
const ContactShadowsShader = {
  uniforms: {
    tDiffuse:     { value: null },   // 来自 ShaderPass 的上一帧颜色
    tDepth:       { value: null },   // RenderPass.depthTexture
    resolution:   { value: new THREE.Vector2(1, 1) },
    cameraNear:   { value: 0.1 },
    cameraFar:    { value: 1000.0 },
    opacity:      { value: 0.55 },
    maxDistance:  { value: 0.08 },   // 归一化搜索距离（越小越贴边）
    steps:        { value: 10 },     // 光线步数
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float opacity;
    uniform float maxDistance;
    uniform int   steps;
    varying vec2 vUv;

    float readDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      // z 是 [0,1]，转为视角线性深度 [-near,-far] -> [0,1]
      float ndcZ = z * 2.0 - 1.0;
      float linear = (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - ndcZ * (cameraFar - cameraNear));
      return linear / cameraFar; // 归一化 [0,1]
    }
    void main() {
      vec4  col = texture2D(tDiffuse, vUv);
      float d   = readDepth(vUv);
      if (d >= 0.9999) { // 未命中任何几何体（天空/背景）
        gl_FragColor = col;
        return;
      }
      // 估计屏幕空间法线（从深度梯度的叉乘）
      float dx = d - readDepth(vUv + vec2(1.0 / resolution.x, 0.0));
      float dy = d - readDepth(vUv + vec2(0.0, 1.0 / resolution.y));
      vec3 normal = normalize(cross(
        vec3(1.0 / resolution.x, 0.0, dx * 0.5),
        vec3(0.0, 1.0 / resolution.y, dy * 0.5)
      ));
      // 光线步进：沿 +Z(forward) 方向并朝法线偏一个角度，找“紧贴”像素
      vec2 dir = vec2(-normal.x, -normal.y) * 0.5 + vec2(0.0, 0.02);
      dir = normalize(dir) * maxDistance / float(steps);
      float shadow = 0.0;
      vec2 cur = vUv;
      for (int i = 1; i <= 16; i++) {
        if (i > steps) break;
        cur += dir;
        if (cur.x < 0.0 || cur.x > 1.0 || cur.y < 0.0 || cur.y > 1.0) break;
        float sd = readDepth(cur);
        float diff = d - sd;              // 正 = 当前像素“更近”
        // 如果 diff 在 (0, maxDistance*0.5) 之间视为有接触
        float hit = smoothstep(0.0, maxDistance * 0.5, diff) * (1.0 - smoothstep(maxDistance * 0.5, maxDistance, diff));
        shadow = max(shadow, hit);
      }
      shadow = 1.0 - shadow * opacity;
      gl_FragColor = vec4(col.rgb * shadow, col.a);
    }
  `,
};
// 基于当前 PARAMS 构建 mmdHelper.add / playVmd fallback add 所需的 physics/ik/gravity/unitStep/maxStepNum
function buildHelperOptions(mesh, extra = {}) {
  const rbCount = (mesh && mesh.userData && mesh.userData.rigidBodies && mesh.userData.rigidBodies.length) || 0;
  let physics = !!getParam('physics', 'enabled', true) && ammoReady;
  if (physics && getParam('physics', 'autoDisableHeavy', true) && rbCount > 200) {
    physics = false;
    try { setStatus(`模型刚体 ${rbCount} 个过多，布料物理已自动关闭（腿部 IK 正常）`, 'warn'); } catch (_) { /* noop */ }
  }
  const gravityN = Math.max(0, Number(getParam('physics', 'gravity', 6.2)) || 0);
  const unitStepStr = String(getParam('physics', 'unitStep', '1/120'));
  const unitStep = (unitStepStr === '1/120') ? 1/120 : (unitStepStr === '1/30' ? 1/30 : 1/60);
  const maxStepNum = Math.max(1, Math.floor(Number(getParam('physics', 'maxStepNum', 3)) || 1));
  return Object.assign({
    animation: undefined,
    physics,
    unitStep,
    maxStepNum,
    gravity: new THREE.Vector3(0, -gravityN * 10, 0),
    resetPosition: true,
    resetRotation: true,
    // MMDPhysics 创建后，对每个 Ammo 刚体追加线性/角阻尼（显著衰减布料高频振荡/抖动）
    onCreatedPhysics(physicsObj) {
      try {
        if (!physicsObj || !Array.isArray(physicsObj.bodies)) return;
        for (const rb of physicsObj.bodies) {
          if (!rb || !rb.body) continue;
          // Ammo btRigidBody：setDamping(linear, angular)；线性 0.45 / 角 0.55 抑制高频摆动
          try { rb.body.setDamping(0.45, 0.55); } catch (_) {}
          // setSleepingThresholds(linear, angular)：放宽休眠阈值，轻微抖动直接进入休眠冷却
          try { rb.body.setSleepingThresholds(0.08, 0.12); } catch (_) {}
          // setFriction / setRestitution：布料低恢复防止弹跳
          try { rb.body.setFriction(0.6); } catch (_) {}
          try { rb.body.setRestitution(0.05); } catch (_) {}
          // 激活再强制唤醒一次，保证阻尼设置立刻生效
          try { rb.body.activate(true); } catch (_) {}
        }
      } catch (_) { /* 某些 ammo 版本不支持上述 API，静默忽略即可 */ }
    },
  }, extra || {});
}
// 重建 ikSolver 并同步 PARAM.ik 参数（供 playVmd 重建后调用）
function syncIkSolverForMesh(mesh) {
  if (!mmdHelper || !mesh || !mmdHelper.objects || !mmdHelper.objects.has(mesh)) return;
  const obj = mmdHelper.objects.get(mesh);
  const ikSolver = obj && obj.ikSolver;
  if (!ikSolver || !Array.isArray(ikSolver.iks)) return;
  const iter = Math.max(1, Math.floor(Number(getParam('ik', 'iteration', 50)) || 1));
  const tol = Math.max(0, Number(getParam('ik', 'toleranceAngle', 0.08)) || 0);
  const ikEnabled = !!getParam('ik', 'enabled', false);
  ikSolver.iks.forEach((ik) => {
    ik.iteration = iter;
    ik.minAngle = tol;
  });
  if (mmdHelper.enabled) mmdHelper.enabled.ik = ikEnabled;
}
// mmdHelper.add(mesh, ...) 后的统一后处理：
// 1) 应用 Ammo 刚体阻尼/摩擦/恢复系数，抑制布料/裙摆/头发抖动；
// 2) 对 physics.world.setGravity 实时同步 PARAMS.gravity；
// 3) 供 playVmd / loadModel / 放置可动模型三处复用
function tunePhysicsForMesh(mesh, { forceApplyDamping = false } = {}) {
  if (!mmdHelper || !mesh || !mmdHelper.objects || !mmdHelper.objects.has(mesh)) return;
  const obj = mmdHelper.objects.get(mesh);
  const physics = obj && obj.physics;
  if (!physics) return;
  const gravityN = Math.max(0, Number(getParam('physics', 'gravity', 6.2)) || 0);
  // 对 world.setGravity 尝试修改（Ammo btDiscreteDynamicsWorld）
  try {
    if (physics.world && physics.manager && physics.manager.allocVector3) {
      const g = physics.manager.allocVector3();
      g.setValue(0, -gravityN * 10, 0);
      try { physics.world.setGravity(g); } catch (_) {}
      physics.manager.freeVector3(g);
    }
  } catch (_) { /* noop */ }
  if (!physics.bodies || !physics.manager) return;
  const needDamping = forceApplyDamping || !physics.__dampingTuned;
  if (!needDamping) return;
  const mgr = physics.manager;
  const zero = mgr.allocVector3(); zero.setValue(0, 0, 0);
  try {
    for (const rb of physics.bodies) {
      if (!rb || !rb.body) continue;
      try {
        // 对未休眠的刚体，初始化时先清零一次速度，清除载入瞬间的残余抖动
        rb.body.setLinearVelocity(zero);
        rb.body.setAngularVelocity(zero);
      } catch (_) {}
      try { rb.body.setDamping(0.45, 0.55); } catch (_) {}
      try { rb.body.setSleepingThresholds(0.08, 0.12); } catch (_) {}
      try { rb.body.setFriction(0.6); } catch (_) {}
      try { rb.body.setRestitution(0.05); } catch (_) {}
      try { rb.body.activate(true); } catch (_) {}
    }
    physics.__dampingTuned = true;
  } finally {
    mgr.freeVector3(zero);
  }
}
function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    recentItems = raw ? JSON.parse(raw) : [];
  } catch (_) { recentItems = []; }
}
function saveRecent() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentItems.slice(0, RECENT_MAX))); } catch (_) { /* ignore */ }
}
function addRecent(path, name, type, size) {
  // 去重
  recentItems = recentItems.filter((r) => r.path !== path);
  recentItems.unshift({ path, name, type, size, ts: Date.now() });
  recentItems = recentItems.slice(0, RECENT_MAX);
  saveRecent();
  updateLibCounts();
  if (activeTab === 'recent') renderRecentList();
}

// ---------- Three.js 场景 ----------
const canvas = $('gl-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// ---- 真实感渲染升级 ----
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.useLegacyLights = false; // 物理正确光照（PBR）

// ---------- Post-processing: 稳定边缘抖动 + 抗锯齿 ----------
const composer = new EffectComposer(renderer);
// 注：scene/camera 在此处尚未声明，所以我们等 scene/camera 声明完之后再重建 RenderPass 与 OutlinePass
// 先插入占位 composer；真正的 pass 顺序在 scene/camera/灯光声明之后一次性构建

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0B0E14); // 深色 UI 同色底（无天空盒时 fallback）
// 真实感雾效：距离渐远融入天空色，增强空间纵深感（Stage 大体量模型也保持细节可见，雾效只作用于 80 米外）
scene.fog = new THREE.Fog(0x88AADD, 60, 180);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 2.2, 5.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.3;
controls.maxDistance = 60;
controls.update();

// ---------- 天空盒（程序化渐变穹顶） ----------
// ShaderMaterial 从地平线暖黄过渡到天顶深蓝，加入轻微日落辉光和大气散射效果
const skyUniforms = {
  topColor:    { value: new THREE.Color(0x1a3a6e) },   // 天顶深蓝
  midColor:    { value: new THREE.Color(0x5a8fcf) },   // 中部淡蓝
  bottomColor: { value: new THREE.Color(0xf5d8b8) },   // 地平线暖白（日落余辉）
  sunDir:      { value: new THREE.Vector3(0.5, 0.35, 0.6).normalize() }, // 太阳方向
  sunIntensity:{ value: 2.8 },
};
const skyVertex = `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const skyFragment = `
  varying vec3 vWorldPos;
  uniform vec3 topColor;
  uniform vec3 midColor;
  uniform vec3 bottomColor;
  uniform vec3 sunDir;
  uniform float sunIntensity;
  void main() {
    vec3 dir = normalize(vWorldPos);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0); // 0=地平线 1=天顶
    vec3 col;
    if (h < 0.25) {
      col = mix(bottomColor, midColor, h * 4.0);
    } else {
      col = mix(midColor, topColor, (h - 0.25) * 1.3333);
    }
    // 太阳辉光 + 霞
    float sd = max(dot(normalize(vWorldPos), sunDir), 0.0);
    float sun = pow(sd, 120.0) * sunIntensity;
    float halo = pow(sd, 6.0) * 0.35;
    vec3 sunCol = vec3(1.0, 0.95, 0.82);
    col += sunCol * (sun + halo);
    gl_FragColor = vec4(col, 1.0);
  }
`;
const skyMesh = new THREE.Mesh(
  new THREE.SphereGeometry(500, 64, 32),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
  })
);
skyMesh.renderOrder = -100; // 天空盒最先渲染
scene.add(skyMesh);

// 天空盒状态：可通过工具栏按钮切换
// 保存雾参数：THREE.Fog 没有 enabled 属性，切换时用 null / new Fog 来开关
const _fogParams = { color: 0x88AADD, near: 60, far: 180 };
let skyboxEnabled = !!getParam('render', 'skyboxEnabled', true);
skyMesh.visible = skyboxEnabled;
if (!skyboxEnabled) scene.fog = null;
function setSkyboxEnabled(v) {
  skyboxEnabled = !!v;
  skyMesh.visible = skyboxEnabled;
  if (skyboxEnabled) {
    scene.fog = new THREE.Fog(_fogParams.color, _fogParams.near, _fogParams.far);
    // 开启时清除纯色背景，让穹顶 Shader 直接作为背景（renderOrder=-100 先渲染）
    scene.background = null;
  } else {
    scene.fog = null;
    // 关闭时背景用深色纯色
    scene.background = new THREE.Color(0x0B0E14);
  }
  // 持久化：直接写 PARAMS + saveParams，避免 setParam 循环调用 applyParam
  PARAMS['render.skyboxEnabled'] = skyboxEnabled;
  try { saveParams(); } catch (_) {}
  const btn = $('btn-toggle-skybox');
  if (btn) {
    btn.classList.toggle('active', skyboxEnabled);
    btn.textContent = skyboxEnabled ? '🌤 天空盒' : '⬛ 纯色底';
  }
  // 同步参数面板（右侧 + 快捷浮层）
  try { syncParamValuesFromState('render'); } catch (_) {}
  try { syncRenderQuickPanelUI(); } catch (_) {}
}
setSkyboxEnabled(skyboxEnabled);

// ---------- PMREM 环境光（IBL）：让 MeshStandardMaterial 有真实反射效果 ----------
// 延迟到首帧渲染后再构建，避免 WebGL 上下文未就绪导致同步崩溃
const pmrem = new THREE.PMREMGenerator(renderer);
let sceneEnvMap = null;
let _envBuilt = false;
function buildEnvFromSky() {
  if (_envBuilt) return;
  _envBuilt = true;
  try {
    // 直接用 2D Canvas 绘制 equirectangular 天空渐变（2:1）
    const W = 512, H = 256;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // 颜色：从 skyUniforms 取（与天空盒 Shader 保持一致的色调）
    const topCol = skyUniforms.topColor.value;
    const midCol = skyUniforms.midColor.value;
    const botCol = skyUniforms.bottomColor.value;
    const grd = ctx.createLinearGradient(0, H, 0, 0);
    grd.addColorStop(0.00, `rgb(${botCol.r*255|0},${botCol.g*255|0},${botCol.b*255|0})`);
    grd.addColorStop(0.35, `rgb(${midCol.r*255|0},${midCol.g*255|0},${midCol.b*255|0})`);
    grd.addColorStop(0.65, `rgb(${midCol.r*255|0},${midCol.g*255|0},${midCol.b*255|0})`);
    grd.addColorStop(1.00, `rgb(${topCol.r*255|0},${topCol.g*255|0},${topCol.b*255|0})`);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    // 叠加太阳辉光
    const sunX = W * 0.72;
    const sunY = H * 0.38;
    const haloR = Math.max(W, H) * 0.5;
    const halo = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, haloR);
    halo.addColorStop(0.00, 'rgba(255,242,210,0.55)');
    halo.addColorStop(0.08, 'rgba(255,230,180,0.28)');
    halo.addColorStop(0.25, 'rgba(255,200,140,0.10)');
    halo.addColorStop(1.00, 'rgba(255,180,120,0.00)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    // 生成 PMREM：若此处抛异常会中断初始化，因此放在渲染循环首帧调用
    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const envRT = pmrem.fromEquirectangular(tex);
    sceneEnvMap = envRT.texture;
    scene.environment = sceneEnvMap;
    tex.dispose();
  } catch (e) {
    // 失败静默降级：无环境光，MeshStandard 仍能工作（靠灯光漫反射）
  }
}

// ---------- IES 纹理系统：Canvas2D 程序化生成 4 款 + 用户 PNG；LRU 4 张 ----------
// 用 Map 做 name→tex + order 链表（简单 push/move）
const __iesCache = { map: new Map(), order: [], max: 4 };
function __iesDisposeOldestIfNeeded() {
  const del = () => {
    const oldest = __iesCache.order.shift();
    if (!oldest) return;
    const tex = __iesCache.map.get(oldest);
    try { tex && tex.dispose && tex.dispose(); } catch (_) {}
    __iesCache.map.delete(oldest);
  };
  while (__iesCache.order.length > __iesCache.max) del();
}
function __iesTouch(presetName) {
  const i = __iesCache.order.indexOf(presetName);
  if (i >= 0) __iesCache.order.splice(i, 1);
  __iesCache.order.push(presetName);
}
// 检测 maxTextureSize：<1024 降 IES 512²，<2048 降 HDR 1024²
let __maxTexSizeCache = -1;
function getMaxTexSize() {
  if (__maxTexSizeCache > 0) return __maxTexSizeCache;
  try {
    const gl = renderer.getContext && renderer.getContext();
    const v = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048;
    __maxTexSizeCache = Math.max(64, Number(v) || 2048);
  } catch (_) { __maxTexSizeCache = 2048; }
  return __maxTexSizeCache;
}
// 4 款内置 IES canvas
function buildIesTexture(preset) {
  if (__iesCache.map.has(preset)) { __iesTouch(preset); return __iesCache.map.get(preset); }
  const mts = getMaxTexSize();
  const SZ = mts < 1024 ? 512 : 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SZ;
  const ctx = cv.getContext('2d');
  const cx = SZ / 2, cy = SZ / 2, R = SZ * 0.49;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SZ, SZ);
  if (preset === 'softbox-round') {
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.38)');
    g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    const vg = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.05);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, SZ, SZ);
  } else if (preset === 'softbox-strip') {
    ctx.save();
    ctx.translate(cx, cy);
    const grd = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
    grd.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grd;
    ctx.scale(1.6, 0.5);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  } else if (preset === 'grid-spot') {
    const rings = 4;
    for (let i = rings; i >= 1; i--) {
      const r1 = (i - 1) * (R / rings);
      const r2 = i * (R / rings);
      const alpha = 0.35 + (1 - i / rings) * 0.65;
      const g = ctx.createRadialGradient(cx, cy, r1, cx, cy, r2);
      g.addColorStop(0.0, `rgba(255,255,255,${alpha.toFixed(3)})`);
      g.addColorStop(0.6, `rgba(255,255,255,${(alpha * 0.65).toFixed(3)})`);
      g.addColorStop(1.0, `rgba(255,255,255,0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(-R, -SZ * 0.01, R * 2, SZ * 0.02);
    ctx.rotate(Math.PI / 2);
    ctx.fillRect(-R, -SZ * 0.01, R * 2, SZ * 0.02);
    ctx.restore();
  } else if (preset === 'window-blind') {
    const stripes = 12;
    const h = SZ / stripes;
    for (let i = 0; i < stripes; i++) {
      const y = i * h;
      const topBoost = (i / stripes) < 0.3 ? 1.0 : (0.55 + 0.25 * (1 - i / stripes));
      const g = ctx.createLinearGradient(0, y, SZ, y);
      g.addColorStop(0.0, `rgba(255,255,255,${(0.25 * topBoost).toFixed(3)})`);
      g.addColorStop(0.1, `rgba(255,255,255,${(0.98 * topBoost).toFixed(3)})`);
      g.addColorStop(0.9, `rgba(255,255,255,${(0.98 * topBoost).toFixed(3)})`);
      g.addColorStop(1.0, `rgba(255,255,255,${(0.25 * topBoost).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, y, SZ, h * 0.72);
    }
    const eg = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 1.05);
    eg.addColorStop(0, 'rgba(0,0,0,0)');
    eg.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = eg;
    ctx.fillRect(0, 0, SZ, SZ);
  } else {
    ctx.fillStyle = '#FFF';
    ctx.fillRect(0, 0, SZ, SZ);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  __iesCache.map.set(preset, tex);
  __iesCache.order.push(preset);
  __iesDisposeOldestIfNeeded();
  return tex;
}
// 加载 IES：分派 preset
let __lastIesTex = null;
function loadIesTexture() {
  if (typeof keyLight === 'undefined') return;
  const preset = String(getParam('render', 'iesPreset', 'none') || 'none');
  const userPath = String(getParam('render', 'iesUserPath', '') || '');
  const after = (tex) => {
    try {
      if (__lastIesTex && __lastIesTex !== tex && (!__iesCache.map.has(__lastIesTex.__preset || ''))) {
        try { __lastIesTex.dispose && __lastIesTex.dispose(); } catch (_) {}
      }
    } catch (_) {}
    __lastIesTex = tex || null;
    keyLight.map = tex || null;
    if (tex) {
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
    }
    keyLight.castShadow = !!getParam('render', 'keyLightEnabled', true);
    try { keyLight.updateProjectionMatrix && keyLight.updateProjectionMatrix(); } catch (_) {}
  };
  if (preset === 'none') { after(null); return; }
  const builtin = ['softbox-round','softbox-strip','grid-spot','window-blind'];
  if (builtin.indexOf(preset) >= 0) {
    try {
      const tex = buildIesTexture(preset);
      tex.__preset = preset;
      after(tex);
      if (window.__postfx) window.__postfx.iesCache = __iesCache;
      return;
    } catch (e) {
      console.warn('[buildIesTexture] failed:', e && e.message);
      toast('IES 光形生成失败：' + (e && e.message || '未知错误'), 'warn');
      try { setParam('render', 'iesPreset', 'none', { persist: true, apply: false }); } catch (_) {}
      after(null);
      return;
    }
  }
  if (preset === 'user') {
    if (!userPath) { try { setParam('render', 'iesPreset', 'none', { persist: true, apply: false }); } catch (_) {}; after(null); return; }
    try {
      const abs = userPath;
      const loader = new THREE.TextureLoader();
      const url = (api && api.mmdUrl) ? api.mmdUrl(abs) : abs;
      loader.load(url, (tex) => {
        try { tex.__preset = 'user:' + abs; after(tex); } catch (_) { after(tex); }
      }, undefined, (err) => {
        console.warn('[loadIesTexture] user load failed:', err && err.message);
        toast('IES 贴图加载失败：' + (err && err.message || '未知错误') + '；已关闭光形', 'warn');
        try { setParam('render', 'iesPreset', 'none', { persist: true, apply: false }); } catch (_) {}
        after(null);
      });
    } catch (e) {
      toast('IES 贴图加载失败：' + (e && e.message || '未知错误') + '；已关闭光形', 'warn');
      try { setParam('render', 'iesPreset', 'none', { persist: true, apply: false }); } catch (_) {}
      after(null);
    }
    return;
  }
  after(null);
}
// ---------- HDR 环境贴图系统：5 款程序化 equirect + 用户 HDR/EXR ----------
function buildProceduralHdrEquirect(preset) {
  const mts = getMaxTexSize();
  const W = mts < 2048 ? 1024 : 2048;
  const H = W / 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const fillGradVertical = (stops) => {
    const grd = ctx.createLinearGradient(0, H, 0, 0);
    stops.forEach(([r, col]) => {
      grd.addColorStop(Math.max(0, Math.min(1, 1 - r)), col);
    });
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  };
  if (preset === 'studio-box') {
    ctx.fillStyle = '#777';
    ctx.fillRect(0, 0, W, H);
    const grd = ctx.createLinearGradient(0, H, 0, 0);
    grd.addColorStop(0, '#4a4a4a'); grd.addColorStop(0.5, '#858585'); grd.addColorStop(1, '#c9c9c9');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(W * 0.1, H * 0.02, W * 0.8, H * 0.08);
    const boxes = [[0.05,0.35,0.22,0.30],[0.38,0.35,0.22,0.30],[0.70,0.35,0.22,0.30]];
    boxes.forEach(([x,y,w,h]) => {
      const g = ctx.createRadialGradient(W*(x+w/2), H*(y+h/2), Math.min(W,H)*0.02, W*(x+w/2), H*(y+h/2), Math.min(W,H)*0.35);
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    });
  } else if (preset === 'showroom-gray') {
    fillGradVertical([[0, '#888a8f'], [0.5, '#bdbfc4'], [1.0, '#eceef3']]);
  } else if (preset === 'sunset') {
    fillGradVertical([
      [0.00, '#8a2b18'],
      [0.06, '#e8824a'],
      [0.14, '#f6c38a'],
      [0.58, '#c0d6e6'],
      [1.00, '#2a3a5c'],
    ]);
    const y = H * 0.07;
    const cx = W * 0.72;
    const rSun = W * 0.018;
    const haloG = ctx.createRadialGradient(cx, y, 0, cx, y, W * 0.28);
    haloG.addColorStop(0, 'rgba(255,250,220,0.95)');
    haloG.addColorStop(0.06, 'rgba(255,230,160,0.55)');
    haloG.addColorStop(0.2, 'rgba(255,190,120,0.22)');
    haloG.addColorStop(1, 'rgba(255,180,120,0)');
    ctx.fillStyle = haloG; ctx.fillRect(0, 0, W, H);
    ctx.beginPath(); ctx.fillStyle = '#fffbe0'; ctx.arc(cx, y, rSun, 0, Math.PI * 2); ctx.fill();
  } else if (preset === 'neon-ring') {
    const colHue = (h) => { const c = new THREE.Color(); c.setHSL(h, 0.95, 0.55); return c; };
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const lat = (y / H) * Math.PI - Math.PI / 2;
      const latFactor = Math.cos(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W) * Math.PI * 2 - Math.PI;
        const band = 1.0 - Math.abs(Math.sin(lat)) * 1.2;
        const hue = (lon / (Math.PI * 2) + 1.0) % 1.0;
        const ringCol = colHue(hue);
        const edge = 0.12 + 0.88 * Math.max(0, band);
        let r = ringCol.r * edge, g = ringCol.g * edge, b = ringCol.b * edge;
        const pole = Math.pow(Math.max(0, latFactor), 1.8);
        r *= 0.15 + 0.85 * pole; g *= 0.15 + 0.85 * pole; b *= 0.15 + 0.85 * pole;
        const idx = (y * W + x) * 4;
        img.data[idx + 0] = Math.max(0, Math.min(255, r * 255));
        img.data[idx + 1] = Math.max(0, Math.min(255, g * 255));
        img.data[idx + 2] = Math.max(0, Math.min(255, b * 255));
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  } else if (preset === 'window-overcast') {
    fillGradVertical([
      [0.0, '#3d4a5a'],
      [0.4, '#6b7a8c'],
      [1.0, '#a8b6c6'],
    ]);
    const wx = W * 0.32, wy = H * 0.05, ww = W * 0.36, wh = H * 0.28;
    const wg = ctx.createLinearGradient(wx, wy, wx, wy + wh);
    wg.addColorStop(0, 'rgba(255,255,255,0.92)');
    wg.addColorStop(1, 'rgba(220,230,240,0.55)');
    ctx.fillStyle = wg; ctx.fillRect(wx, wy, ww, wh);
    const halo = ctx.createRadialGradient(W/2, H*0.12, Math.min(W,H)*0.01, W/2, H*0.12, Math.min(W,H)*0.7);
    halo.addColorStop(0, 'rgba(240,245,255,0.45)');
    halo.addColorStop(1, 'rgba(240,245,255,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
  } else {
    fillGradVertical([[0,'#f5d8b8'],[0.35,'#5a8fcf'],[1,'#1a3a6e']]);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
// 重建 envMap：可重入 + dispose 旧对象 + 失败回退
function rebuildEnvMap(opts = {}) {
  const preset   = String(opts.preset || getParam('render', 'hdrPreset', 'none') || 'none');
  const userPath = String(opts.userPath || getParam('render', 'hdrUserPath', '') || '');
  const asBg     = typeof opts.asBg === 'boolean' ? opts.asBg : !!getParam('render', 'envMapAsBackground', false);
  const intensity= typeof opts.intensity === 'number' ? opts.intensity : Number(getParam('render', 'envMapIntensity', 1.0) || 1.0);
  const postfx = window.__postfx;
  try {
    if (postfx && postfx.envRT) { try { postfx.envRT.dispose && postfx.envRT.dispose(); } catch (_) {} }
    if (postfx && scene.userData && scene.userData.__envTexture) {
      try { scene.userData.__envTexture.dispose && scene.userData.__envTexture.dispose(); } catch (_) {}
    }
    if (postfx) { postfx.envRT = null; postfx.envRTTexture = null; }
    scene.userData && (scene.userData.__envTexture = null);
  } catch (_) { /* noop */ }
  const fallbackToNone = (msg) => {
    if (msg) { toast(msg, 'warn'); }
    try { setParam('render', 'hdrPreset', 'none', { persist: true, apply: false }); } catch (_) {}
    try {
      if (preset !== 'none') {
        rebuildEnvMap({ preset: 'none', userPath: '', asBg: false, intensity });
      }
    } catch (_) {}
  };
  const applyEnvFromTexture = (srcTex, colorSpace) => {
    try {
      srcTex.mapping = THREE.EquirectangularReflectionMapping;
      if (colorSpace) srcTex.colorSpace = colorSpace;
      srcTex.needsUpdate = true;
      const envRT = pmrem.fromEquirectangular(srcTex);
      const envTex = envRT.texture;
      scene.environment = envTex;
      sceneEnvMap = envTex;
      if (postfx) { postfx.envRT = envRT; postfx.envRTTexture = envTex; }
      scene.userData = scene.userData || {};
      scene.userData.__envTexture = srcTex;
      try { applyEnvMapIntensityToScene(intensity); } catch (_) {}
      if (postfx) postfx.__envBgOverride = !!asBg;
      if (asBg) {
        scene.background = envTex;
        try { skyMesh && (skyMesh.visible = false); } catch (_) {}
        try {
          if (scene.fog) {
            const fc = new THREE.Color(String(getParam('render', 'bgColor', 0x0B0E14)));
            const mixC = fc.clone().multiplyScalar(0.78).lerp(new THREE.Color(0x0B0E14), 0.35);
            scene.fog.color.copy(mixC);
          }
        } catch (_) {}
      } else {
        try {
          const sb = !!getParam('render', 'skyboxEnabled', true);
          skyMesh.visible = sb;
          scene.background = sb ? null : new THREE.Color(String(getParam('render', 'bgColor', 0x0B0E14)));
          if (postfx) postfx.__envBgOverride = false;
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[applyEnvFromTexture] caught:', e && e.message);
      fallbackToNone('HDR 环境生成失败：' + (e && e.message || '未知错误') + '；已回退程序化天空');
      srcTex && srcTex.dispose && srcTex.dispose();
    }
  };
  if (preset === 'none') {
    try {
      const tex = buildProceduralHdrEquirect('_sky_default');
      const mts2 = getMaxTexSize();
      const W2 = mts2 < 2048 ? 1024 : 2048, H2 = W2 / 2;
      const cv2 = document.createElement('canvas');
      cv2.width = W2; cv2.height = H2;
      const c2 = cv2.getContext('2d');
      const topCol = skyUniforms.topColor.value, midCol = skyUniforms.midColor.value, botCol = skyUniforms.bottomColor.value;
      const grd2 = c2.createLinearGradient(0, H2, 0, 0);
      grd2.addColorStop(0.0, `rgb(${(botCol.r*255)|0},${(botCol.g*255)|0},${(botCol.b*255)|0})`);
      grd2.addColorStop(0.35, `rgb(${(midCol.r*255)|0},${(midCol.g*255)|0},${(midCol.b*255)|0})`);
      grd2.addColorStop(0.65, `rgb(${(midCol.r*255)|0},${(midCol.g*255)|0},${(midCol.b*255)|0})`);
      grd2.addColorStop(1, `rgb(${(topCol.r*255)|0},${(topCol.g*255)|0},${(topCol.b*255)|0})`);
      c2.fillStyle = grd2; c2.fillRect(0,0,W2,H2);
      const sunX = W2*0.72, sunY = H2*0.38, haloR = Math.max(W2,H2)*0.5;
      const halo = c2.createRadialGradient(sunX, sunY, 0, sunX, sunY, haloR);
      halo.addColorStop(0,'rgba(255,242,210,0.55)'); halo.addColorStop(0.08,'rgba(255,230,180,0.28)'); halo.addColorStop(0.25,'rgba(255,200,140,0.10)'); halo.addColorStop(1,'rgba(255,180,120,0)');
      c2.fillStyle = halo; c2.fillRect(0,0,W2,H2);
      tex.image = cv2; tex.needsUpdate = true;
      applyEnvFromTexture(tex, THREE.SRGBColorSpace);
    } catch (e) {
      console.warn('[rebuildEnvMap.none] failed:', e && e.message);
      try { scene.environment = sceneEnvMap || null; } catch (_) {}
    }
    return;
  }
  const builtinPresets = ['studio-box','showroom-gray','sunset','neon-ring','window-overcast'];
  if (builtinPresets.indexOf(preset) >= 0) {
    try {
      const tex = buildProceduralHdrEquirect(preset);
      applyEnvFromTexture(tex, THREE.SRGBColorSpace);
      return;
    } catch (e) {
      fallbackToNone('HDR 环境生成失败：' + (e && e.message || '未知错误') + '；已回退程序化天空');
      return;
    }
  }
  if (preset === 'user') {
    if (!userPath) { fallbackToNone(); return; }
    try {
      const abs = userPath;
      const url = (api && api.mmdUrl) ? api.mmdUrl(abs) : abs;
      const rgbeLoader = new RGBELoader();
      if (typeof rgbeLoader.setDataType === 'function') rgbeLoader.setDataType( THREE.FloatType );
      rgbeLoader.load(url, (dataTex) => {
        try { applyEnvFromTexture(dataTex, THREE.LinearSRGBColorSpace); }
        catch (e2) { fallbackToNone('HDR 文件解析失败：' + (e2 && e2.message || '未知错误') + '；已回退程序化天空'); dataTex && dataTex.dispose && dataTex.dispose(); }
      }, undefined, (err) => {
        fallbackToNone('HDR 文件加载失败：' + (err && err.message || '未知错误') + '；已回退程序化天空');
      });
    } catch (e) {
      fallbackToNone('HDR 文件加载失败：' + (e && e.message || '未知错误') + '；已回退程序化天空');
    }
    return;
  }
  try { preset !== 'none' && fallbackToNone(); } catch (_) {}
}
// envMapIntensity 同步：遍历所有材质，幂等跳过
function applyEnvMapIntensityToScene(v) {
  const postfx = window.__postfx;
  const val = Number(v);
  if (postfx) {
    const last = postfx.__lastEnvMapIntensity;
    if (typeof last === 'number' && Math.abs(last - val) < 1e-4) return;
    postfx.__lastEnvMapIntensity = val;
  }
  if (!scene || !scene.traverse) return;
  scene.traverse((o) => {
    try {
      if (!o || !o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        if (typeof m.envMapIntensity !== 'undefined') {
          m.envMapIntensity = val;
          m.needsUpdate = true;
        }
      });
    } catch (_) {}
  });
}
// ---------- ensureXxx Pass：懒创建 + 幂等 + 失败降级 ----------
function ensureColorBalancePass() {
  const postfx = window.__postfx;
  if (!postfx) return;
  if (postfx.colorBalancePass && postfx.composer.passes.indexOf(postfx.colorBalancePass) >= 0) return;
  try {
    const np = new ShaderPass(ColorBalanceShader);
    postfx.colorBalancePass = np;
    const arr = postfx.composer.passes;
    const iBloom = arr.indexOf(postfx.bloomPass);
    const iFxaa = arr.indexOf(postfx.fxaaPass);
    const insertAt = iBloom >= 0 ? iBloom + 1 : (iFxaa >= 0 ? iFxaa : arr.length - 1);
    arr.splice(insertAt, 0, np);
    try {
      const vp = document.getElementById('viewport');
      const w = vp ? vp.clientWidth : (canvas.clientWidth || 1);
      const h = vp ? vp.clientHeight : (canvas.clientHeight || 1);
      if (w > 0 && h > 0) postfx.composer.setSize(w, h);
    } catch (_) {}
    const u = np.uniforms;
    const gain = colorTempTintToWBGain(Number(getParam('render','colorTemp',5800))||5800, Number(getParam('render','colorTint',0))||0);
    u.uWBGain.value.set(gain[0], gain[1], gain[2]);
    u.uContrast.value   = Math.max(0.5, Math.min(1.6, Number(getParam('render','contrast',1.05))||1.0));
    u.uSaturation.value = Math.max(0,   Math.min(1.6, Number(getParam('render','saturation',1.0))||0));
    u.uVibrance.value   = Math.max(0,   Math.min(1.6, Number(getParam('render','vibrance',1.1))||0));
    const lgg = Array.isArray(getParam('render','liftGammaGain')) ? getParam('render','liftGammaGain') : [0,1,1];
    u.uLift.value = Math.max(-0.3, Math.min(0.3, Number(lgg[0])||0));
    u.uGamma.value = Math.max(0.3,  Math.min(2.5, Number(lgg[1])||1));
    u.uGain.value = Math.max(0.3,  Math.min(2.5, Number(lgg[2])||1));
    np.enabled = !!getParam('render','colorBalanceEnabled', true);
  } catch (e) {
    console.warn('[ensureColorBalancePass] failed:', e && e.message);
    try { toast('色彩通道 Shader 编译失败；已关闭色彩后处理', 'warn'); } catch (_) {}
    try { setParam('render','colorBalanceEnabled',false,{persist:true,apply:false}); } catch (_) {}
    postfx.colorBalancePass = null;
  }
}
function ensureAoMode(mode) {
  const postfx = window.__postfx;
  if (!postfx || !postfx.composer) return;
  const arr = postfx.composer.passes;
  const removable = [];
  arr.forEach((p, i) => {
    if (p === postfx.saoPass || p === postfx.ssgiPass) removable.push([i, p]);
  });
  removable.reverse().forEach(([i, p]) => {
    try { p.dispose && p.dispose(); } catch (_) {}
    arr.splice(i, 1);
  });
  if (postfx.saoPass === postfx.ssgiPass) { postfx.saoPass = null; }
  postfx.saoPass = null;
  postfx.ssgiPass = null;
  const anchor = arr.indexOf(postfx.contactShadowsPass);
  const insertAt = anchor >= 0 ? anchor + 1 : Math.min(2, Math.max(1, arr.length - 6));
  const doResize = () => {
    try {
      const vp = document.getElementById('viewport');
      const w = vp ? vp.clientWidth : (canvas.clientWidth || 1);
      const h = vp ? vp.clientHeight : (canvas.clientHeight || 1);
      if (w > 0 && h > 0) {
        postfx.composer.setSize(w, h);
        try { postfx.composer.setPixelRatio(renderer.getPixelRatio()); } catch (_) {}
      }
    } catch (_) {}
  };
  if (mode === 'off') { doResize(); return; }
  if (mode === 'ssgi') {
    try {
      if (typeof window.__FakeSSGIPass !== 'function') throw new Error('SSGI 未启用：已将 SSGI 视为可选后处理，你的当前版本 three 未内置 SSGIPass；自动回退 SSAO');
      const np = new window.__FakeSSGIPass(scene, camera);
      postfx.ssgiPass = np;
      const write = (k, v) => { try { if (k in np) np[k] = v; } catch (_) {} try { if (np.params && (k in np.params)) np.params[k] = v; } catch (_) {} };
      write('radius',       Number(getParam('render','ssgiRadius',0.18)) || 0.18);
      write('thickness',    Number(getParam('render','ssgiThickness',0.015)) || 0.015);
      write('maxRoughness', Number(getParam('render','ssgiMaxRoughness',0.9)) || 0.9);
      write('intensity',    Number(getParam('render','ssgiIntensity',1.0)) || 1.0);
      try { typeof np.updateSSGIMaterial === 'function' && np.updateSSGIMaterial(); } catch (_) {}
      arr.splice(insertAt, 0, np);
      doResize();
      if (!getParam('render','ssgiEnabled',false)) {
        try { setParam('render','ssgiEnabled', true, { persist: true, apply: false }); } catch (_) {}
      }
    } catch (e) {
      console.warn('[ensureAoMode.ssgi] failed:', e && e.message);
      try { toast('你的 GPU 不支持 SSGI（浮点/线性过滤扩展缺失）；已自动回退 SSAO', 'warn'); } catch (_) {}
      try { setParam('render','aoMode','ssao', { persist: true, apply: false }); } catch (_) {}
      try { setParam('render','ssgiEnabled', false, { persist: true, apply: false }); } catch (_) {}
      try { ensureAoMode('ssao'); } catch (_) {}
    }
    return;
  }
  try {
    const np = new SAOPass(scene, camera, false, true);
    postfx.saoPass = np;
    np.params.intensity = Number(getParam('render','ssaoIntensity',0.75)) || 0;
    np.params.radius    = Number(getParam('render','ssaoRadius',8)) || 0;
    np.params.saoScale  = 1.0;
    np.params.saoBias   = 0.1;
    np.params.saoIntensity = 0.95;
    np.enabled = !!getParam('render','ssaoEnabled', false);
    arr.splice(insertAt, 0, np);
    doResize();
  } catch (e) {
    console.warn('[ensureAoMode.ssao] failed:', e && e.message);
    try { toast('SSAO 创建失败：' + (e && e.message || '未知错误'), 'warn'); } catch (_) {}
    postfx.saoPass = null;
  }
}
function ensureGodRayPass(enable) {
  const postfx = window.__postfx;
  if (!postfx || !postfx.composer) return;
  const arr = postfx.composer.passes;
  if (enable && postfx.godRayPass) { postfx.godRayPass.enabled = true; return; }
  if (!enable && postfx.godRayPass) { postfx.godRayPass.enabled = false; return; }
  if (enable && !postfx.godRayPass) {
    try {
      const np = new ShaderPass(GodRayShader);
      np.enabled = true;
      const u = np.uniforms;
      u.tDepth.value = postfx.depthTexture || null;
      const vp = document.getElementById('viewport');
      const w = vp ? vp.clientWidth : (canvas.clientWidth || 1);
      const h = vp ? vp.clientHeight : (canvas.clientHeight || 1);
      u.uResolution.value.set(Math.max(1,w), Math.max(1,h));
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value  = camera.far;
      u.uIntensity.value = Number(getParam('render','godRayIntensity',0.85))||0;
      u.uDecay.value     = Number(getParam('render','godRayDecay',0.955))||0.95;
      u.uWeight.value    = Number(getParam('render','godRayWeight',0.35))||0.35;
      u.uSamples.value   = Math.max(8, Math.min(128, Math.floor(Number(getParam('render','godRaySamples',32))||32)));
      const after1 = postfx.ssgiPass ? arr.indexOf(postfx.ssgiPass) : arr.indexOf(postfx.saoPass);
      const after2 = arr.indexOf(postfx.outlinePass);
      const anchor = Math.max(after1, after2);
      let insertAt = anchor >= 0 ? anchor + 1 : arr.length - 3;
      if (postfx.lensFlarePass) {
        const iLens = arr.indexOf(postfx.lensFlarePass);
        if (iLens >= 0 && insertAt > iLens) insertAt = iLens;
      }
      const iBloom = arr.indexOf(postfx.bloomPass);
      if (iBloom >= 0 && insertAt > iBloom) insertAt = iBloom;
      arr.splice(insertAt, 0, np);
      postfx.godRayPass = np;
      try { if (w>0 && h>0) postfx.composer.setSize(w, h); } catch (_) {}
    } catch (e) {
      console.warn('[ensureGodRayPass] failed:', e && e.message);
      try { toast('体积光 Shader 编译失败；已自动关闭', 'warn'); } catch (_) {}
      try { setParam('render','godRayEnabled',false,{persist:true,apply:false}); } catch (_) {}
      postfx.godRayPass = null;
    }
  }
}
function ensureLensFlarePass(enable) {
  const postfx = window.__postfx;
  if (!postfx || !postfx.composer) return;
  const arr = postfx.composer.passes;
  if (enable && postfx.lensFlarePass) { postfx.lensFlarePass.enabled = true; return; }
  if (!enable && postfx.lensFlarePass) { postfx.lensFlarePass.enabled = false; return; }
  if (enable && !postfx.lensFlarePass) {
    try {
      const np = new ShaderPass(LensFlareShader);
      np.enabled = true;
      const u = np.uniforms;
      u.tDepth.value = postfx.depthTexture || null;
      const vp = document.getElementById('viewport');
      const w = vp ? vp.clientWidth : (canvas.clientWidth || 1);
      const h = vp ? vp.clientHeight : (canvas.clientHeight || 1);
      u.uResolution.value.set(Math.max(1,w), Math.max(1,h));
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value  = camera.far;
      u.uIntensity.value = Number(getParam('render','lensFlareIntensity',0.7))||0;
      u.uThreshold.value = Math.max(0.1, Math.min(1, Number(getParam('render','lensFlareThreshold',0.9))||0.9));
      u.uGhosts.value    = Math.max(1, Math.min(12, Math.floor(Number(getParam('render','lensFlareGhosts',6))||6)));
      u.uChromatic.value = Math.max(0, Math.min(0.3, Number(getParam('render','lensFlareChromatic',0.08))||0.08));
      const iGod = postfx.godRayPass ? arr.indexOf(postfx.godRayPass) : -1;
      const iBloom = arr.indexOf(postfx.bloomPass);
      let insertAt = iGod >= 0 ? iGod + 1 : (arr.indexOf(postfx.outlinePass) + 1);
      if (iBloom >= 0 && insertAt > iBloom) insertAt = iBloom;
      arr.splice(insertAt, 0, np);
      postfx.lensFlarePass = np;
      try { if (w>0 && h>0) postfx.composer.setSize(w, h); } catch (_) {}
    } catch (e) {
      console.warn('[ensureLensFlarePass] failed:', e && e.message);
      try { toast('镜头光晕 Shader 编译失败；已自动关闭', 'warn'); } catch (_) {}
      try { setParam('render','lensFlareEnabled',false,{persist:true,apply:false}); } catch (_) {}
      postfx.lensFlarePass = null;
    }
  }
}
// ---------- CHIP 汇总 chip：按 5 类生成缩写串 + hover tooltip 完整清单 ----------
let __lastChipText = '';
function updateRqpChip() {
  const chip = $('rqp-chip');
  const tip  = $('rqp-tooltip');
  if (!chip) return;
  try {
    const tm  = String(getParam('render','toneMapping','agx')||'agx').toUpperCase().slice(0,3);
    const ct  = Math.round((Number(getParam('render','colorTemp',5800))||5800)/1000);
    const pn  = String(getParam('render','presetName','default')||'default');
    const presCN = { default:'默认',film:'电影',natural:'自然',studio:'工作室',rembrandt:'伦勃朗',butterfly:'蝴蝶光',backlit:'剪影',coldnight:'冷夜',neon:'霓虹',custom:'自定义' };
    const pnCN = presCN[pn] || (pn && pn[0]);
    const hdr = String(getParam('render','hdrPreset','none')||'none');
    const hdrMap = { none:'N','studio-box':'棚','showroom-gray':'展','sunset':'日落','neon-ring':'霓虹','window-overcast':'窗阴','user':'U' };
    const ies = String(getParam('render','iesPreset','none')||'none');
    const iesMap = { none:'无','softbox-round':'SBR','softbox-strip':'SBS','grid-spot':'GS','window-blind':'WB','user':'U' };
    const sMap = { none:'N',basic:'B',pcfsoft:'P',vsm:'V' };
    const sType = sMap[String(getParam('render','shadowMapType','vsm')||'vsm')] || '?';
    const csOn = !!getParam('render','contactShadowsEnabled',true);
    const ao = String(getParam('render','aoMode','ssao')||'ssao');
    const aoCode = ao==='off'?'O':(ao==='ssgi'?'G':'S');
    const gr = !!getParam('render','godRayEnabled',false) ? 'GR+' : '';
    const lf = !!getParam('render','lensFlareEnabled',false) ? 'LF+' : '';
    const bSt = Math.round((Number(getParam('render','bloomStrength',0.42))||0.42) * 100) / 100;
    const line1 = `${tm}·T${ct}K`;
    const line2 = pnCN;
    const line3 = (hdrMap[hdr]||'N') + '·' + (iesMap[ies]||'无');
    const line4 = `${csOn?'CS':''}${aoCode}${gr}${lf}B${bSt}`;
    const line5 = sType;
    const short = `🎯 ${line1}｜${line2}｜${line3}｜${line4}｜${line5}影`;
    if (short === __lastChipText) { return; }
    __lastChipText = short;
    chip.textContent = short;
    const tipHtml = [
      `🎨 色彩通道：${tm} (${getParam('render','toneMapping','agx')}) + 色温 ${getParam('render','colorTemp',5800)}K + 对比 ${(Number(getParam('render','contrast',1.05))||1.05).toFixed(2)} + vibrance ${(Number(getParam('render','vibrance',1.1))||1.1).toFixed(2)}`,
      `🎬 布光：${_PRESETS[pn]&&_PRESETS[pn].label?_PRESETS[pn].label:pnCN} (dir ${(Number(getParam('render','dirIntensity',3))||3).toFixed(1)}; key ${(Number(getParam('render','keyLightIntensity',6))||6).toFixed(1)} @ ${getParam('render','keyLightHeight',30)}°H ${getParam('render','keyLightAzimuth',45)}°A)`,
      `💡 光源：HDR=${hdr}; IES=${ies}`,
      `🌫 特效：接触阴影=${csOn?'开':'关'}; AO=${ao}; 体积光=${getParam('render','godRayEnabled',false)?'开':'关'}; 光晕=${getParam('render','lensFlareEnabled',false)?'开':'关'}; Bloom=${bSt}`,
      `🖼 阴影：${String(getParam('render','shadowMapType','vsm'))}; SSAO=${getParam('render','ssaoEnabled',false)?'开':'关'}; SSGI=${getParam('render','ssgiEnabled',false)?'开':'关'}`,
    ].join('\n');
    chip.setAttribute('title', tipHtml);
    if (tip) { tip.textContent = tipHtml; }
  } catch (_) { /* noop */ }
}
// ---------- 手风琴 5 分组（render 组）：切换逻辑 + 状态持久化 ----------
function accordionRenderToggle(id) {
  const container = document.querySelector('#params-render .accordion-root');
  if (!container) return;
  try {
    const groups = container.querySelectorAll('.render-accordion-group');
    groups.forEach((g) => {
      const on = g.dataset.group === String(id || '');
      g.classList.toggle('expanded', !!on);
    });
    const state = {};
    groups.forEach((g) => { state[String(g.dataset.group || '')] = !!g.classList.contains('expanded'); });
    try { setParam('render','renderAccordionState', JSON.stringify(state), { persist: true, apply: false }); } catch (_) {}
  } catch (_) { /* noop */ }
}
window.accordionRenderToggle = accordionRenderToggle;
// 5 分组：参数 key → 分组归属表
const RENDER_ACCORDION_SECTIONS = {
  color:   ['toneMapping','toneMappingExposure','colorBalanceEnabled','colorTemp','colorTint','contrast','saturation','vibrance','liftGammaGain','bgColor'],
  preset:  ['renderPreset','presetName'],
  light:   [
    'hardLightMode','ambientIntensity','hemiIntensity','dirIntensity','dirAngle','dirHeight','fillIntensity','fillLightColor','dirLightColor',
    'keyLightEnabled','keyLightIntensity','keyLightAngle','keyLightHeight','keyLightAzimuth','keyLightDistance','keyLightPenumbra','keyLightColor',
    'rimLightEnabled','rimLightIntensity','rimLightColor','rimLightAzimuth','rimLightHeight',
    'iesPreset','iesUserPath','iesIntensityScale',
    'hdrPreset','hdrUserPath','envMapAsBackground','envMapIntensity','skyboxEnabled',
    'gridVisible','shadowEnabled',
  ],
  effects: [
    'outlineEnabled','edgeStrength','edgeThickness','edgeColor','fxaaEnabled','pixelRatioMax',
    'bloomEnabled','bloomStrength','bloomThreshold','bloomRadius',
    'contactShadowsEnabled','contactShadowsOpacity','contactShadowsDistance',
    'aoMode','ssaoEnabled','ssaoIntensity','ssaoRadius','ssgiEnabled','ssgiRadius','ssgiThickness','ssgiMaxRoughness','ssgiIntensity',
    'godRayEnabled','godRayIntensity','godRayDecay','godRayWeight','godRaySamples','godRaySource',
    'lensFlareEnabled','lensFlareIntensity','lensFlareThreshold','lensFlareGhosts','lensFlareChromatic',
  ],
  shadow: [
    'shadowMapType','shadowSoftness','shadowBiasScale','shadowMapResK','vsmBlurRadius',
    'fresnelRimEnabled','fresnelRimColor','fresnelRimPower','fresnelRimIntensity',
    'shaderBevelEnabled','shaderBevelStrength',
  ],
};
const RENDER_ACCORDION_KEY_2_SECTION = (() => {
  const map = {};
  Object.keys(RENDER_ACCORDION_SECTIONS).forEach((s) => {
    RENDER_ACCORDION_SECTIONS[s].forEach((k) => { map[k] = s; });
  });
  return map;
})();

// 灯光（物理正确光照模式下数值重新校准）
const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
scene.add(ambientLight);
const hemisphereLight = new THREE.HemisphereLight(0xBFD6FF, 0x3a2e24, 0.6);
scene.add(hemisphereLight);
const dirLight = new THREE.DirectionalLight(0xFFF1DC, 3.2);
dirLight.position.set(5, 8, 6);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 50;
dirLight.shadow.camera.left = -10;
dirLight.shadow.camera.right = 10;
dirLight.shadow.camera.top = 10;
dirLight.shadow.camera.bottom = -10;
dirLight.shadow.bias = -0.0005;
dirLight.shadow.normalBias = 0.02;
dirLight.shadow.radius = 3;
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0x6F86B8, 0.6);
fillLight.position.set(-4, 3, -5);
scene.add(fillLight);
// 轮廓光（rim light）：从背面上方打暖色光，突出发丝/轮廓边缘
const rimLight = new THREE.DirectionalLight(0xFFC890, 1.1);
rimLight.position.set(-3, 5, -6);
scene.add(rimLight);
// ---------- 聚光灯 Key Light（三点布光的主光）----------
// 位置：右上前方约 45° 瞄准角色胸部（target=0,1.1,0），有圆锥角+半影，立体感优于方向光
const keyLight = new THREE.SpotLight(0xFFE8BF, 6.0);
keyLight.position.set(4.5, 6.5, 5.2);
keyLight.target.position.set(0, 1.1, 0);
keyLight.angle = Math.PI / 180 * 32;    // 圆锥角 32°
keyLight.penumbra = 0.35;                // 柔边半影
keyLight.distance = 0;                    // 无限距离
keyLight.decay = 1.5;                     // 距离衰减
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 40;
keyLight.shadow.bias = -0.00015;
keyLight.shadow.normalBias = 0.015;
keyLight.shadow.radius = 1;
scene.add(keyLight);
scene.add(keyLight.target);

// ---------- 3 款 ShaderPass 常量：ColorBalance / GodRay / LensFlare（字符串，不新增 npm 依赖）----------
const FSVT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
// 色彩通道：白平衡 gain(线性) + lift/gamma/gain + contrast + saturation/vibrance
const ColorBalanceShader = {
  name: 'ColorBalancePass',
  uniforms: {
    tDiffuse:   { value: null },
    uWBGain:    { value: new THREE.Vector3(1, 1, 1) },
    uContrast:  { value: 1.05 },
    uSaturation:{ value: 1.0 },
    uVibrance:  { value: 1.1 },
    uLift:      { value: 0.0 },
    uGamma:     { value: 1.0 },
    uGain:      { value: 1.0 },
  },
  vertexShader: FSVT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3  uWBGain;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVibrance;
    uniform float uLift;
    uniform float uGamma;
    uniform float uGain;
    varying vec2 vUv;
    float _luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main() {
      vec4 tc = texture2D(tDiffuse, vUv);
      vec3 c = tc.rgb;
      // 1) 白平衡（线性 HDR 空间）
      c *= uWBGain;
      // 2) lift/gamma/gain：结合律合并为一次乘+加+pow
      c = (c + uLift);
      c = pow(max(c, vec3(1e-5)), vec3(1.0 / max(uGamma, 0.01))) * uGain;
      // 3) contrast：围绕 0.5 线性灰（线性空间中点近似 0.18，这里用 0.5 视觉上稳定、与 UI 滑块一致）
      c = (c - 0.5) * uContrast + 0.5;
      // 4) saturation + vibrance
      float luma = max(_luma(c), 0.0);
      vec3 satMix = mix(vec3(luma), c, uSaturation);
      // vibrance：抬升不饱和像素（饱和度越低，提升越多）
      float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
      float vAmt = (1.0 - smoothstep(0.0, 0.5, sat)) * (uVibrance - 1.0);
      vec3 vibMix = satMix + (satMix - vec3(luma)) * vAmt;
      gl_FragColor = vec4(vibMix, tc.a);
    }
  `,
};
// 体积光（God Ray）：径向 32 步采样 + 深度遮挡
const GodRayShader = {
  name: 'GodRayPass',
  uniforms: {
    tDiffuse:         { value: null },
    tDepth:           { value: null },
    uResolution:      { value: new THREE.Vector2(1, 1) },
    uScreenLightPos:  { value: new THREE.Vector2(0.5, 0.75) },
    uIntensity:       { value: 0.85 },
    uDecay:           { value: 0.955 },
    uWeight:          { value: 0.35 },
    uSamples:         { value: 32 },
    uCameraNear:      { value: 0.1 },
    uCameraFar:       { value: 1000.0 },
  },
  vertexShader: FSVT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  uResolution;
    uniform vec2  uScreenLightPos;
    uniform float uIntensity;
    uniform float uDecay;
    uniform float uWeight;
    uniform int   uSamples;
    uniform float uCameraNear;
    uniform float uCameraFar;
    varying vec2 vUv;
    float linearizeDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
    }
    void main(){
      vec4 col = texture2D(tDiffuse, vUv);
      vec2 lp = clamp(uScreenLightPos, vec2(-0.2), vec2(1.2));
      bool lightBehind = (lp.x < 0.0 || lp.x > 1.0 || lp.y < 0.0 || lp.y > 1.0);
      // 光源点遮挡检测：若光源在屏幕内且被前景挡住，体积光整体压暗
      float occ = 1.0;
      if (!lightBehind) {
        vec2 cl = clamp(lp, vec2(0.001), vec2(0.999));
        float dL = linearizeDepth(cl);
        // 若 depth < (cameraFar * 0.99) 表示光源点处有前景，遮挡
        occ = smoothstep(uCameraFar * 0.6, uCameraFar * 0.995, dL);
      }
      if (uIntensity <= 0.001 || occ <= 0.001) { gl_FragColor = col; return; }
      vec2 dUv = (vUv - lp) * (1.0 / float(max(4, uSamples)));
      vec2 cuv = vUv;
      float weight = 1.0;
      vec3 accum = vec3(0.0);
      // 最多 128 步，避免 uniform 误用
      const int MAX_S = 128;
      for (int i = 0; i < MAX_S; i++) {
        if (i >= uSamples) break;
        cuv -= dUv;
        if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) continue;
        vec3 s = texture2D(tDiffuse, cuv).rgb;
        // brightPass：只取高亮度贡献
        float bm = max(max(s.r, s.g), s.b) - 0.75;
        vec3 bright = max(vec3(bm), vec3(0.0));
        accum += bright * weight * uWeight;
        weight *= uDecay;
      }
      gl_FragColor = vec4(col.rgb + accum * uIntensity * occ, col.a);
    }
  `,
};
// 镜头光晕：brightPass → 6 层鬼影 + chromatic + 自动遮挡
const LensFlareShader = {
  name: 'LensFlarePass',
  uniforms: {
    tDiffuse:         { value: null },
    tDepth:           { value: null },
    uResolution:      { value: new THREE.Vector2(1, 1) },
    uScreenLightPos:  { value: new THREE.Vector2(0.5, 0.75) },
    uIntensity:       { value: 0.7 },
    uThreshold:       { value: 0.9 },
    uGhosts:          { value: 6 },
    uChromatic:       { value: 0.08 },
    uCameraNear:      { value: 0.1 },
    uCameraFar:       { value: 1000.0 },
  },
  vertexShader: FSVT,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  uResolution;
    uniform vec2  uScreenLightPos;
    uniform float uIntensity;
    uniform float uThreshold;
    uniform int   uGhosts;
    uniform float uChromatic;
    uniform float uCameraNear;
    uniform float uCameraFar;
    varying vec2 vUv;
    float linearizeDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
    }
    vec3 sampleGhosts(vec2 uv, vec2 lp, vec2 dirCenter, int count, float chroma){
      vec3 acc = vec3(0.0);
      const int MAX_G = 16;
      for (int i = 0; i < MAX_G; i++) {
        if (i >= count) break;
        float t = float(i + 1) / float(max(1, count));
        // 距离中心越远，层级越弱
        float fade = 1.0 - smoothstep(0.2, 1.0, t);
        // RGB 三个通道的 ghost 位置略偏移 -> 彩边色散
        vec2 pR = lp + dirCenter * (t * 1.1) * (1.0 + chroma * 0.5);
        vec2 pG = lp + dirCenter * (t * 1.0);
        vec2 pB = lp + dirCenter * (t * 0.9) * (1.0 - chroma * 0.5);
        // 通过屏幕中心反射
        pR = (vec2(0.5) - (pR - vec2(0.5)));
        pG = (vec2(0.5) - (pG - vec2(0.5)));
        pB = (vec2(0.5) - (pB - vec2(0.5)));
        float r = texture2D(tDiffuse, pR).r;
        float g = texture2D(tDiffuse, pG).g;
        float b = texture2D(tDiffuse, pB).b;
        float brightR = max(r - uThreshold, 0.0);
        float brightG = max(g - uThreshold, 0.0);
        float brightB = max(b - uThreshold, 0.0);
        acc += vec3(brightR, brightG, brightB) * fade;
      }
      return acc;
    }
    void main(){
      vec4 col = texture2D(tDiffuse, vUv);
      vec2 lp = clamp(uScreenLightPos, vec2(-0.2), vec2(1.2));
      // 遮挡检测（光源屏幕内才做）
      float occ = 1.0;
      bool inScreen = (lp.x >= 0.0 && lp.x <= 1.0 && lp.y >= 0.0 && lp.y <= 1.0);
      if (inScreen) {
        vec2 cl = clamp(lp, vec2(0.001), vec2(0.999));
        float dL = linearizeDepth(cl);
        occ = smoothstep(uCameraFar * 0.55, uCameraFar * 0.995, dL);
      } else {
        // 光源在屏幕外：允许一部分光晕（沿屏幕边缘），但强度减半
        occ = 0.45;
      }
      if (uIntensity <= 0.001 || occ <= 0.001) { gl_FragColor = col; return; }
      vec2 dirCenter = lp - vec2(0.5);
      // 1) 主光晕 halo：在 lp 附近径向采样 bright
      vec2 haloDUv = (vUv - lp);
      float haloD = length(haloDUv);
      float halo = exp(-haloD * 4.5) * 0.6 + exp(-haloD * 14.0) * 1.2;
      // brightPass halo color：采 lp 颜色
      vec2 clp = clamp(lp, vec2(0.001), vec2(0.999));
      vec3 lc = texture2D(tDiffuse, clp).rgb;
      float lcb = max(max(lc.r, lc.g), lc.b) - uThreshold;
      vec3 haloCol = lc * max(lcb, 0.0) * halo;
      // 2) 多层鬼影
      vec3 ghosts = sampleGhosts(vUv, lp, dirCenter, uGhosts, uChromatic);
      vec3 flare = (haloCol + ghosts * 0.55) * uIntensity * occ;
      gl_FragColor = vec4(col.rgb + flare, col.a);
    }
  `,
};

// ---------- 正式构建后处理管线（scene/camera/灯光均已就绪） ----------
// 《设计》§1 严格顺序：
//  ① RenderPass (颜色+深度)
//  ② ContactShadowsShaderPass   （屏幕空间接触阴影，紧邻主色，不要被 AO 再叠加）
//  ③ SAOPass | SSGIPass          （二选一，由 aoMode 控制；默认先插入 saoPass，ensureAoMode 可替换成 SSGI）
//  ④ OutlinePass                 （稳定边缘：描边在 AO 之后，不被 AO 压暗）
//  ⑤ GodRayPass [可选，占位，默认关闭；ensureGodRayPass 再启用]
//  ⑥ LensFlarePass [可选，占位，默认关闭]
//  ⑦ UnrealBloomPass             （Bloom 最后再叠加，GodRay/Lens 的高亮度也会泛光）
//  ⑧ ColorBalancePass            （线性 HDR 空间做色彩校正 → 在 toneMapping 之前）
//  ⑨ FXAAShaderPass              （抗锯齿：作用在 tonemap 之前、色彩校正之后）
//  ⑩ OutputPass                  （负责 sRGB output、color space 变换）
const resolution = new THREE.Vector2(Math.max(1, canvas.clientWidth || 1), Math.max(1, canvas.clientHeight || 1));
composer.passes = [];
// ① RenderPass：真实挂 DepthTexture，并把 tDepth 同步给 ContactShadows / GodRay / LensFlare
const renderPassFinal = new RenderPass(scene, camera);
const depthTexture = new THREE.DepthTexture(Math.max(1, resolution.x), Math.max(1, resolution.y));
depthTexture.type = THREE.UnsignedShortType;
depthTexture.format = THREE.DepthFormat;
depthTexture.minFilter = THREE.NearestFilter;
depthTexture.magFilter = THREE.NearestFilter;
renderPassFinal.clear = true;
renderPassFinal.depthTexture = depthTexture;
renderPassFinal.depthBuffer = true;
composer.addPass(renderPassFinal);
// ② ContactShadows：接触阴影 ShaderPass，必须紧随主色后
const contactShadowsPass = new ShaderPass(ContactShadowsShader);
contactShadowsPass.enabled = !!getParam('render', 'contactShadowsEnabled', true);
contactShadowsPass.uniforms.tDepth.value = depthTexture;
contactShadowsPass.uniforms.resolution.value.set(
  Math.max(1, resolution.x * renderer.getPixelRatio()),
  Math.max(1, resolution.y * renderer.getPixelRatio())
);
contactShadowsPass.uniforms.cameraNear.value = camera.near;
contactShadowsPass.uniforms.cameraFar.value  = camera.far;
contactShadowsPass.uniforms.opacity.value     = Number(getParam('render', 'contactShadowsOpacity', 0.55)) || 0;
contactShadowsPass.uniforms.maxDistance.value = Number(getParam('render', 'contactShadowsDistance', 0.08)) || 0;
contactShadowsPass.uniforms.steps.value       = 10;
composer.addPass(contactShadowsPass);
// ③ SAOPass：默认 ssao 模式占位；后续 ensureAoMode('ssgi') 可 dispose+替换为 SSGI
const saoPass = new SAOPass(scene, camera, false, true);
saoPass.enabled = !!getParam('render', 'ssaoEnabled', false);
saoPass.params.intensity = Number(getParam('render', 'ssaoIntensity', 0.75)) || 0;
saoPass.params.radius    = Number(getParam('render', 'ssaoRadius', 8)) || 0;
saoPass.params.saoScale  = 1.0;
saoPass.params.saoBias   = 0.1;
saoPass.params.saoIntensity = 0.95;
let ssgiPass = null;   // SSGIPass：当前 three 版本未内置，保持为 null，由 ensureAoMode 统一降级到 SSAO
composer.addPass(saoPass);
// ④ Outline：描边（边缘稳定）
const outlinePass = new OutlinePass(resolution, scene, camera, []);
outlinePass.edgeStrength = Number(getParam('render', 'edgeStrength', 0.9)) || 0;
outlinePass.edgeThickness = Number(getParam('render', 'edgeThickness', 0.003)) || 0;
outlinePass.visibleEdgeColor = new THREE.Color(String(getParam('render', 'edgeColor', '#111827')));
outlinePass.hiddenEdgeColor = new THREE.Color(0x000000);
outlinePass.edgeGlow = 0;
outlinePass.downSampleRatio = 2;
outlinePass.pulsePeriod = 0;
outlinePass.enabled = !!getParam('render', 'outlineEnabled', true);
composer.addPass(outlinePass);
// ⑤ GodRay：先建立占位（默认 disabled 0 开销），ensureGodRayPass(true) 再打开
let godRayPass = null;
try {
  godRayPass = new ShaderPass(GodRayShader);
  godRayPass.enabled = false; // 初始关（避免 uniform 未同步时黑块）
  const gU = godRayPass.uniforms;
  gU.tDepth.value = depthTexture;
  gU.uResolution.value.set(Math.max(1, resolution.x), Math.max(1, resolution.y));
  gU.uCameraNear.value = camera.near;
  gU.uCameraFar.value  = camera.far;
  gU.uIntensity.value = Number(getParam('render', 'godRayIntensity', 0.85)) || 0;
  gU.uDecay.value     = Number(getParam('render', 'godRayDecay', 0.955)) || 0.95;
  gU.uWeight.value    = Number(getParam('render', 'godRayWeight', 0.35)) || 0.35;
  gU.uSamples.value   = Math.max(8, Math.min(128, Math.floor(Number(getParam('render', 'godRaySamples', 32)) || 32)));
  composer.addPass(godRayPass);
} catch (e) {
  console.warn('[GodRayPass] init failed:', e && e.message);
  try { toast('体积光 Shader 编译失败，已自动关闭', 'warn'); } catch (_) {}
  godRayPass = null;
}
// ⑥ LensFlare：先占位（默认关）
let lensFlarePass = null;
try {
  lensFlarePass = new ShaderPass(LensFlareShader);
  lensFlarePass.enabled = false;
  const lU = lensFlarePass.uniforms;
  lU.tDepth.value = depthTexture;
  lU.uResolution.value.set(Math.max(1, resolution.x), Math.max(1, resolution.y));
  lU.uCameraNear.value = camera.near;
  lU.uCameraFar.value  = camera.far;
  lU.uIntensity.value = Number(getParam('render', 'lensFlareIntensity', 0.7)) || 0;
  lU.uThreshold.value = Math.max(0.1, Math.min(1, Number(getParam('render', 'lensFlareThreshold', 0.9)) || 0.9));
  lU.uGhosts.value    = Math.max(1, Math.min(12, Math.floor(Number(getParam('render', 'lensFlareGhosts', 6)) || 6)));
  lU.uChromatic.value = Math.max(0, Math.min(0.3, Number(getParam('render', 'lensFlareChromatic', 0.08)) || 0.08));
  composer.addPass(lensFlarePass);
} catch (e) {
  console.warn('[LensFlarePass] init failed:', e && e.message);
  try { toast('镜头光晕 Shader 编译失败，已自动关闭', 'warn'); } catch (_) {}
  lensFlarePass = null;
}
// ⑦ Bloom：泛光（在 GodRay/Lens 之后，让它们的高亮度也泛开）
const bloomPass = new UnrealBloomPass(resolution,
  Number(getParam('render', 'bloomStrength', 0.42)) || 0,
  Number(getParam('render', 'bloomRadius', 0.52)) || 0,
  Number(getParam('render', 'bloomThreshold', 0.82)) || 0
);
bloomPass.enabled = !!getParam('render', 'bloomEnabled', true);
composer.addPass(bloomPass);
// ⑧ ColorBalancePass：色彩校正（在线性 HDR 空间，toneMapping 之前 → OutputPass 之前 FXAA 之后的位置）
let colorBalancePass = null;
try {
  colorBalancePass = new ShaderPass(ColorBalanceShader);
  colorBalancePass.enabled = !!getParam('render', 'colorBalanceEnabled', true);
  const u = colorBalancePass.uniforms;
  const gain = colorTempTintToWBGain(
    Number(getParam('render', 'colorTemp', 5800)) || 5800,
    Number(getParam('render', 'colorTint', 0)) || 0
  );
  u.uWBGain.value.set(gain[0], gain[1], gain[2]);
  u.uContrast.value   = Math.max(0.5, Math.min(1.6, Number(getParam('render', 'contrast', 1.05)) || 1.0));
  u.uSaturation.value = Math.max(0,   Math.min(1.6, Number(getParam('render', 'saturation', 1.0)) || 0));
  u.uVibrance.value   = Math.max(0,   Math.min(1.6, Number(getParam('render', 'vibrance', 1.1)) || 0));
  u.uLift.value = Math.max(-0.3, Math.min(0.3, Number(Array.isArray(getParam('render','liftGammaGain')) ? getParam('render','liftGammaGain')[0] : 0) || 0));
  u.uGamma.value = Math.max(0.3,  Math.min(2.5, Number(Array.isArray(getParam('render','liftGammaGain')) ? getParam('render','liftGammaGain')[1] : 1) || 1));
  u.uGain.value = Math.max(0.3,  Math.min(2.5, Number(Array.isArray(getParam('render','liftGammaGain')) ? getParam('render','liftGammaGain')[2] : 1) || 1));
  composer.addPass(colorBalancePass);
} catch (e) {
  console.warn('[ColorBalancePass] init failed:', e && e.message);
  try { toast('色彩通道 Shader 编译失败，已关闭色彩后处理', 'warn'); } catch (_) {}
  colorBalancePass = null;
  // 同步参数以免 UI 显示"开"但实际关
  try { setParam('render', 'colorBalanceEnabled', false, { persist: true, apply: false }); } catch (_) {}
}
// ⑨ FXAA：快速抗锯齿（色彩校正 → tonemap 之前）
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.uniforms['resolution'].value = new THREE.Vector2(
  1 / Math.max(1, resolution.x * renderer.getPixelRatio()),
  1 / Math.max(1, resolution.y * renderer.getPixelRatio())
);
fxaaPass.enabled = !!getParam('render', 'fxaaEnabled', true);
composer.addPass(fxaaPass);
// ⑩ OutputPass：sRGB 输出 + toneMapping
const outputPass = new OutputPass();
composer.addPass(outputPass);
// 最终挂 postfx 引用（含 aoMode 切换用到的 saoPass/ssgiPass、GodRay/Lens/ColorBalance）
window.__postfx = {
  composer,
  renderPass: renderPassFinal,
  depthTexture,
  saoPass, ssgiPass,
  outlinePass,
  godRayPass, lensFlarePass,
  bloomPass,
  colorBalancePass,
  contactShadowsPass,
  fxaaPass,
  outputPass,
  envRT: null, envRTTexture: null, __envBgOverride: false,
  iesCache: null,
  __lastToneMapping: null, __lastTempTintKey: null, __lastEnvMapIntensity: null,
  __presetApplying: false,
  __fpsRollingSamples: [],
};

// 地面
const gridHelper = new THREE.GridHelper(20, 20, 0xCBD5E1, 0xE2E8F0);
gridHelper.material.opacity = 0.35;
gridHelper.material.transparent = true;
scene.add(gridHelper);
// 地面阴影接收层（仅接收阴影，不渲染自身颜色）
const groundShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.ShadowMaterial({ opacity: 0.35 })
);
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.receiveShadow = true;
groundShadow.position.y = -0.001; // 略低于主地面避免Z-fighting
scene.add(groundShadow);
// PBR 地面材质层：提供真实感反射与质感
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({
    color: 0x2a2f3a,
    roughness: 0.85,
    metalness: 0.08,
  })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 工具 ----------
function setStatus(text, kind = 'info', detail = '') {
  statusText.textContent = text;
  statusText.className = kind === 'error' ? 'error' : (kind === 'warn' ? 'warn' : '');
  statusDetail.textContent = detail || '';
}
// ---- 轻量 toast（右下角 3s 自动消失）----
let _toastTimer = null;
let _toastEl = null;
function toast(text, kind = 'info') {
  try {
    if (!_toastEl) {
      const el = document.createElement('div');
      el.className = 'info-toast';
      Object.assign(el.style, {
        position: 'fixed', right: '22px', bottom: '22px', zIndex: '999999',
        padding: '10px 14px', borderRadius: '10px', color: '#fff',
        fontSize: '13px', fontWeight: '500',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        background: 'rgba(15,20,30,0.72)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        opacity: '0', transform: 'translateY(8px)', transition: 'all .25s ease',
        pointerEvents: 'none', maxWidth: '420px',
      });
      document.body.appendChild(el);
      _toastEl = el;
    }
    _toastEl.textContent = String(text || '');
    if (kind === 'warn') _toastEl.style.background = 'rgba(78,55,12,0.78)';
    else if (kind === 'error') _toastEl.style.background = 'rgba(86,18,24,0.78)';
    else _toastEl.style.background = 'rgba(15,20,30,0.72)';
    _toastEl.style.opacity = '1';
    _toastEl.style.transform = 'translateY(0)';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      if (!_toastEl) return;
      _toastEl.style.opacity = '0';
      _toastEl.style.transform = 'translateY(8px)';
    }, 3000);
  } catch (_) { /* noop */ }
}
// ---------- 球面坐标工具 ----------
const deg2rad = (d) => (Number(d) || 0) * Math.PI / 180;
// ---------- 色温 + Tint → 白平衡 RGB Gain（CIE Planck 近似插值）----------
function colorTempTintToWBGain(tempK, tint) {
  // 已知锚点：2000K 暖 ~ 6500K 白 ~ 12000K 冷
  const anchors = [
    [ 2000, 1.220, 1.000, 0.760],
    [ 3000, 1.120, 1.000, 0.850],
    [ 4500, 1.035, 1.000, 0.940],
    [ 5500, 1.000, 1.000, 0.985],
    [ 6500, 1.000, 1.000, 1.000],
    [ 8000, 0.965, 1.000, 1.065],
    [10000, 0.945, 1.000, 1.130],
    [12000, 0.930, 1.000, 1.220],
  ];
  const T = Math.max(2000, Math.min(12000, Number(tempK) || 6500));
  let i = 0;
  while (i < anchors.length - 2 && anchors[i + 1][0] < T) i++;
  const a = anchors[i], b = anchors[i + 1];
  const t = (T - a[0]) / (b[0] - a[0]);
  let R = a[1] + (b[1] - a[1]) * t;
  let G = a[2] + (b[2] - a[2]) * t;
  let B = a[3] + (b[3] - a[3]) * t;
  // tint ∈ [-100, 100]：负=偏绿，正=偏洋红（G axis 反向上/向下，R+B 反向下/向上）
  const tN = Math.max(-100, Math.min(100, Number(tint) || 0)) / 100;
  const gShift = -0.12 * tN;     // +tint → G↓
  const rbShift = +0.06 * tN;    // +tint → R,B 略增 (洋红)
  R = Math.max(0.1, R + rbShift);
  G = Math.max(0.1, G + gShift);
  B = Math.max(0.1, B + rbShift);
  // 归一化：以 G=1.0 为基准，保留整体曝光量级
  return [R, G, B];
}
// ---------- 阴影类型切换（VSM 用更紧凑的 bias/near/far 防 acne）----------
function applyShadowMapType(type, opts = {}) {
  const scale = typeof opts.scale === 'number' ? opts.scale : 1.0;
  const hard  = !!opts.hardLightMode;
  const enabled = type !== 'none';
  try { renderer.shadowMap.enabled = enabled; } catch (_) {}
  if (!enabled) return;
  const map = {
    basic:   THREE.BasicShadowMap,
    pcfsoft: THREE.PCFSoftShadowMap,
    vsm:     (typeof THREE.VSMShadowMap !== 'undefined') ? THREE.VSMShadowMap : THREE.PCFSoftShadowMap,
  };
  const resolved = (typeof map[type] !== 'undefined') ? map[type] : THREE.PCFSoftShadowMap;
  try { renderer.shadowMap.type = resolved; } catch (_) {}
  if (!dirLight || !keyLight) return;
  // ---- dirLight ----
  try {
    if (type === 'vsm') {
      dirLight.shadow.camera.near = Math.max(0.1, 0.5 * scale);
      dirLight.shadow.camera.far  = Math.max(1, 30 * scale);
      dirLight.shadow.bias        = -0.0003 * scale;
      dirLight.shadow.normalBias  = 0.02 * Math.max(0, scale);
      dirLight.shadow.radius      = hard ? 0.2 : 3.0;
    } else if (type === 'basic') {
      dirLight.shadow.camera.near = Math.max(0.1, 0.4 * scale);
      dirLight.shadow.camera.far  = Math.max(1, 50 * scale);
      dirLight.shadow.bias        = -0.0005 * scale;
      dirLight.shadow.normalBias  = 0.02 * Math.max(0, scale);
      dirLight.shadow.radius      = 0.15;
    } else {
      dirLight.shadow.camera.near = Math.max(0.1, 0.5 * scale);
      dirLight.shadow.camera.far  = Math.max(1, 50 * scale);
      dirLight.shadow.bias        = -0.0005 * scale;
      dirLight.shadow.normalBias  = 0.03 * Math.max(0, scale);
      dirLight.shadow.radius      = hard ? 0.5 : 3.0;
    }
    dirLight.shadow.camera.updateProjectionMatrix();
    if (dirLight.shadow.map) dirLight.shadow.map.needsUpdate = true;
  } catch (_) { /* noop */ }
  // ---- keyLight ----
  try {
    if (type === 'vsm') {
      keyLight.shadow.camera.near = Math.max(0.1, 0.4 * scale);
      keyLight.shadow.camera.far  = Math.max(1, 30 * scale);
      keyLight.shadow.bias        = -0.00012 * scale;
      keyLight.shadow.normalBias  = 0.015 * Math.max(0, scale);
    } else if (type === 'basic') {
      keyLight.shadow.camera.near = Math.max(0.1, 0.5 * scale);
      keyLight.shadow.camera.far  = Math.max(1, 40 * scale);
      keyLight.shadow.bias        = -0.00015 * scale;
      keyLight.shadow.normalBias  = 0.015 * Math.max(0, scale);
    } else {
      keyLight.shadow.camera.near = Math.max(0.1, 0.5 * scale);
      keyLight.shadow.camera.far  = Math.max(1, 40 * scale);
      keyLight.shadow.bias        = -0.00015 * scale;
      keyLight.shadow.normalBias  = 0.02 * Math.max(0, scale);
    }
    keyLight.shadow.camera.updateProjectionMatrix();
    if (keyLight.shadow.map) keyLight.shadow.map.needsUpdate = true;
  } catch (_) { /* noop */ }
}
// ---------- 灯光统一刷新：球面坐标 → 笛卡尔坐标（避免逐 key 重复算矩阵）----------
function refreshLighting() {
  if (typeof dirLight === 'undefined' || typeof keyLight === 'undefined') return;
  try {
    // ---- DirectionalLight（相对中心 12 单位距离）----
    const dirAz   = deg2rad(getParam('render', 'dirAngle',  -42));
    const dirAlt  = deg2rad(getParam('render', 'dirHeight',  38));
    const DIR_R   = 12;
    dirLight.position.set(
      DIR_R * Math.cos(dirAlt) * Math.sin(dirAz),
      DIR_R * Math.sin(dirAlt),
     -DIR_R * Math.cos(dirAlt) * Math.cos(dirAz),
    );
    dirLight.target.position.set(0, 1.0, 0);
    dirLight.target.updateMatrixWorld();
    try { dirLight.color.copy(new THREE.Color(String(getParam('render', 'dirLightColor', 0xFFF1DC)))); } catch(_){}
    dirLight.intensity = Math.max(0, Number(getParam('render', 'dirIntensity', 3.0)) || 0);

    // ---- SpotLight Key Light（距离可配 + 方位角 + 高度角）----
    const keyAlt  = deg2rad(getParam('render', 'keyLightHeight',  30));
    const keyAz   = deg2rad(getParam('render', 'keyLightAzimuth', 45));
    const dist    = Math.max(1, Number(getParam('render', 'keyLightDistance', 5.5)) || 5.5);
    const keyAngD = Math.max(5, Math.min(90, Number(getParam('render', 'keyLightAngle', 32)) || 32));
    keyLight.position.set(
      dist * Math.cos(keyAlt) * Math.sin(keyAz),
      dist * Math.sin(keyAlt) + 0.6,
     -dist * Math.cos(keyAlt) * Math.cos(keyAz),
    );
    keyLight.target.position.set(0, 1.0, 0);
    keyLight.target.updateMatrixWorld();
    keyLight.angle = Math.PI / 180 * keyAngD;
    keyLight.penumbra = Math.max(0, Math.min(1, Number(getParam('render', 'keyLightPenumbra', 0.35)) || 0));
    const kBaseInt = Math.max(0, Number(getParam('render', 'keyLightIntensity', 6.0)) || 0);
    const kScale   = Math.max(0.1, Number(getParam('render', 'iesIntensityScale', 1.0)) || 1);
    keyLight.intensity = kBaseInt * kScale;
    try { keyLight.color.copy(new THREE.Color(String(getParam('render', 'keyLightColor', 0xFFE8BF)))); } catch(_){}
    keyLight.castShadow = !!getParam('render', 'keyLightEnabled', true);
    keyLight.visible    = !!getParam('render', 'keyLightEnabled', true);
    keyLight.updateProjectionMatrix && keyLight.updateProjectionMatrix();

    // ---- Fill / Rim / Hemisphere / Ambient ----
    try { fillLight.color.copy(new THREE.Color(String(getParam('render', 'fillLightColor', 0x96C8FF)))); } catch(_){}
    fillLight.intensity = Math.max(0, Number(getParam('render', 'fillIntensity', 0.3)) || 0);
    // Fill 位置：与 dir 对称的对面（左前）
    try {
      const fAz = deg2rad(Number(getParam('render', 'dirAngle', -42)) + 180);
      const fAlt = deg2rad(Math.min(45, Math.max(5, (Number(getParam('render', 'dirHeight', 38)) * 0.5 + 10))));
      fillLight.position.set(
        7 * Math.cos(fAlt) * Math.sin(fAz),
        5 * Math.sin(fAlt) + 1,
       -7 * Math.cos(fAlt) * Math.cos(fAz),
      );
    } catch (_) {}
    try { rimLight.color.copy(new THREE.Color(String(getParam('render', 'rimLightColor', 0xFFC890)))); } catch(_){}
    rimLight.intensity = Math.max(0, Number(getParam('render', 'rimLightIntensity', 1.1)) || 0);
    rimLight.visible   = !!getParam('render', 'rimLightEnabled', true);
    // Rim 球面坐标（剪影背光预设需要 -170° 后方上高位）
    try {
      const rAz  = deg2rad(getParam('render', 'rimLightAzimuth', -140));
      const rAlt = deg2rad(getParam('render', 'rimLightHeight',   45));
      const R_R = 10;
      rimLight.position.set(
        R_R * Math.cos(rAlt) * Math.sin(rAz),
        R_R * Math.sin(rAlt) + 1.5,
       -R_R * Math.cos(rAlt) * Math.cos(rAz),
      );
    } catch (_) {}
    hemisphereLight.intensity = Math.max(0, Number(getParam('render', 'hemiIntensity', 0.6)) || 0);
    ambientLight.intensity    = Math.max(0, Number(getParam('render', 'ambientIntensity', 0.65)) || 0);

    // ---- ShadowMap Type / Bias ----
    try {
      applyShadowMapType(
        String(getParam('render', 'shadowMapType', 'vsm') || 'vsm'),
        {
          scale: Number(getParam('render', 'shadowBiasScale', 1.0) || 1.0),
          hardLightMode: !!getParam('render', 'hardLightMode', false),
        }
      );
    } catch (_) { /* noop */ }

    // 强制刷新 shadow textures（预设切换后"影子不更新"问题）
    try { if (dirLight.shadow && dirLight.shadow.map) dirLight.shadow.map.needsUpdate = true; } catch (_) {}
    try { if (keyLight.shadow && keyLight.shadow.map) keyLight.shadow.map.needsUpdate = true; } catch (_) {}
  } catch (e) {
    console.warn('[refreshLighting] caught:', e && e.message);
  }
}
// 灯光声明完后立即用 PARAMS 正确就位一次
try { refreshLighting(); } catch (_) {}
function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function fmtDT(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toLocaleString('zh-CN');
  return String(val);
}
function iconFor(type) {
  switch (type) {
    case 'dir': return '<span class="icon icon-dir">📁</span>';
    case 'model': return '<span class="icon icon-model">🧊</span>';
    case 'archive': return '<span class="icon icon-archive">🗜️</span>';
    case 'text': return '<span class="icon icon-text">📄</span>';
    case 'motion': return '<span class="icon icon-model" style="color:var(--accent)">🎬</span>';
    default: return '<span class="icon icon-file">📃</span>';
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function kindTagClass(type) {
  if (type === 'model') return 'model';
  if (MOTION_EXTS_RE.test(type || '')) return 'motion';
  if (type === 'archive') return 'archive';
  if (type === 'text') return 'text';
  return '';
}
function kindLabel(type, name) {
  if (type === 'dir') return '目录';
  if (type === 'archive') return /\.rar$/i.test(name) ? 'RAR' :
    /\.7z$/i.test(name) ? '7Z' : /\.zip$/i.test(name) ? 'ZIP' :
    /\.(tar|gz|xz|tgz|txz)$/i.test(name) ? 'TAR' : '压缩包';
  if (type === 'model') {
    if (MOTION_EXTS_RE.test(name)) return /\.vmd$/i.test(name) ? 'VMD 动作' : 'VPD 姿势';
    if (/\.pmx$/i.test(name)) return 'PMX 模型';
    if (/\.pmd$/i.test(name)) return 'PMD 模型';
    return name.split('.').pop().toUpperCase() + ' 3D';
  }
  if (type === 'text') return /\.(md|txt)$/i.test(name) ? '文本' : name.split('.').pop().toUpperCase();
  return type || '文件';
}
function pathBasename(p) {
  const n = (p || '').replace(/\\/g, '/').replace(/\/$/, '');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

// ---------- 面包屑 + 导航栈 ----------
function pushNavHistory(path, tab) {
  if (activeTab !== tab) return;
  const cur = navStack.back[navStack.back.length - 1];
  if (cur && cur.path === path) return;
  navStack.back.push({ path, tab });
  if (navStack.back.length > 80) navStack.back.shift();
  navStack.forward.length = 0;
  updateNavButtons();
}
function goBack() {
  if (navStack.back.length < 2) return;
  const cur = navStack.back.pop();
  navStack.forward.push(cur);
  const prev = navStack.back[navStack.back.length - 1];
  updateNavButtons();
  navigateTo(prev.path, prev.tab, false);
}
function goForward() {
  const nxt = navStack.forward.pop();
  if (!nxt) return;
  navStack.back.push(nxt);
  updateNavButtons();
  navigateTo(nxt.path, nxt.tab, false);
}
function goUp() {
  const base = activeTab === 'motions' ? (motionRootPath || '')
    : activeTab === 'scenes' ? (sceneRootPath || '') : (defaultRootPath || '');
  const curPath = navStack.back[navStack.back.length - 1]?.path || '';
  if (!curPath) return;
  if (curPath === base || isSamePath(parentPath(curPath), base)) {
    navigateTo(base, activeTab, true);
    return;
  }
  const parent = parentPath(curPath);
  if (parent && parent !== curPath) navigateTo(parent, activeTab, true);
}
function goHome() {
  const root = activeTab === 'motions' ? (motionRootPath || defaultRootPath)
    : activeTab === 'scenes' ? (sceneRootPath || defaultRootPath) : defaultRootPath;
  if (root) navigateTo(root, activeTab, true);
}
function parentPath(p) {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/').replace(/\/$/, '');
  const i = norm.lastIndexOf('/');
  if (i <= 0) return /^[A-Za-z]:$/.test(norm) ? p : norm.slice(0, i || 1);
  return norm.slice(0, i) || '';
}
function isSamePath(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() ===
    b.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}
function updateNavButtons() {
  btnBack.disabled = navStack.back.length < 2;
  btnForward.disabled = navStack.forward.length === 0;
  const curPath = navStack.back[navStack.back.length - 1]?.path || '';
  const base = activeTab === 'motions' ? (motionRootPath || '')
    : activeTab === 'scenes' ? (sceneRootPath || '') : (defaultRootPath || '');
  let canUp = false;
  if (curPath && base) {
    const normCur = curPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const normBase = base.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    canUp = normCur !== normBase && normCur.length > normBase.length;
  } else if (curPath) {
    canUp = curPath !== parentPath(curPath);
  }
  btnUp.disabled = !canUp;
}

async function navigateTo(dirPath, tab, pushHistory = true) {
  if (!dirPath) return;
  switchTab(tab || activeTab, false);
  if (pushHistory) pushNavHistory(dirPath, activeTab);

  if (activeTab === 'motions') {
    setStatus('正在扫描动作库…', 'info', dirPath);
    const res = await api.scanDir(dirPath);
    if (!res.ok) { setStatus('动作库扫描失败：' + res.error, 'error'); return; }
    const flat = [];
    (function walk(n) {
      if (!n) return;
      if (n.type === 'model' && MOTION_EXTS_RE.test(n.name)) flat.push(n);
      (n.children || []).forEach(walk);
    })(res.data);
    motionRootItems = flat;
    renderMotionList();
    renderBreadcrumb(dirPath, pathPartsUnderRoot(dirPath, motionRootPath || dirPath));
    setStatus('就绪', 'info', `动作库：共 ${flat.length} 个动作文件`);
  } else if (activeTab === 'scenes') {
    setStatus('正在扫描场景目录…', 'info', dirPath);
    const res = await api.scanDir(dirPath);
    if (!res.ok) { setStatus('场景扫描失败：' + res.error, 'error'); return; }
    sceneRoot = res.data;
    sceneRootPath = dirPath;
    renderTree(sceneRoot, sceneTreeEl);
    renderBreadcrumb(dirPath, pathPartsUnderRoot(dirPath, sceneRootPath || dirPath));
    setStatus('就绪', 'info', `${countModels(res.data)} 个场景模型`);
  } else {
    setStatus('正在加载目录…', 'info', dirPath);
    const res = await api.scanDir(dirPath);
    if (!res.ok) { setStatus('扫描失败：' + res.error, 'error'); return; }
    currentRoot = res.data;
    currentDirPath = dirPath;
    rootPathEl.textContent = dirPath;
    renderTree(res.data);
    renderBreadcrumb(dirPath, pathPartsUnderRoot(dirPath, defaultRootPath || dirPath));
    setStatus('就绪', 'info', `${countModels(res.data)} 个模型文件`);
  }
  updateNavButtons();
}

function pathPartsUnderRoot(fullPath, rootPath) {
  const nFull = fullPath.replace(/\\/g, '/').replace(/\/$/, '');
  const nRoot = rootPath ? rootPath.replace(/\\/g, '/').replace(/\/$/, '') : '';
  let rest = nFull;
  let prefix = '';
  if (nRoot && nFull.toLowerCase().startsWith(nRoot.toLowerCase())) {
    rest = nFull.slice(nRoot.length).replace(/^\//, '');
    prefix = nRoot;
  }
  const parts = [];
  if (prefix) parts.push({ name: pathBasename(prefix) || '根目录', path: prefix });
  else {
    const driveM = nFull.match(/^([A-Za-z]:)\//);
    if (driveM) {
      parts.push({ name: driveM[1], path: driveM[1] + '/' });
      rest = nFull.slice(driveM[0].length);
    }
  }
  let acc = prefix || (parts[0]?.path || '');
  (rest ? rest.split('/').filter(Boolean) : []).forEach((seg) => {
    acc = (acc.replace(/\/$/, '')) + '/' + seg;
    parts.push({ name: seg, path: acc });
  });
  return parts;
}

function renderBreadcrumb(dirPath, parts) {
  breadcrumbEl.innerHTML = '';
  if (!parts || !parts.length) {
    const s = document.createElement('span');
    s.className = 'crumb placeholder';
    s.textContent = '—';
    breadcrumbEl.appendChild(s);
    return;
  }
  parts.forEach((p, idx) => {
    if (idx > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      breadcrumbEl.appendChild(sep);
    }
    const cr = document.createElement('span');
    cr.className = 'crumb' + (idx === parts.length - 1 ? ' current' : '');
    cr.textContent = p.name;
    cr.title = p.path;
    cr.addEventListener('click', () => {
      if (idx === parts.length - 1) return;
      navigateTo(p.path, activeTab, true);
    });
    cr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCrumbMenu(cr, p.path);
    });
    breadcrumbEl.appendChild(cr);
  });
}

async function openCrumbMenu(crEl, dirPath) {
  document.querySelectorAll('.crumb-dir-menu').forEach((m) => m.remove());
  const res = await api.scandirFlat(dirPath);
  const menu = document.createElement('div');
  menu.className = 'crumb-dir-menu';
  if (!res.ok || !res.data || res.data.length === 0) {
    menu.innerHTML = '<div class="mi" style="color:var(--text-muted)">（空或不可访问）</div>';
  } else {
    res.data.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'mi';
      row.innerHTML = `
        <span>${it.type === 'dir' ? '📁' : it.type === 'model' ? '🧊' : it.type === 'archive' ? '🗜️' : it.type === 'text' ? '📄' : '📃'}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${escapeHtml(it.name)}</span>
        <span class="mi-badge">${it.type === 'dir' ? '' : fmtSize(it.size)}</span>
      `;
      row.addEventListener('click', () => {
        menu.remove();
        if (it.type === 'dir') navigateTo(it.path, activeTab, true);
        else selectFlat(it);
      });
      menu.appendChild(row);
    });
  }
  crEl.classList.add('dir-popover');
  crEl.appendChild(menu);
  const onDocClick = (e) => {
    if (!menu.contains(e.target) && e.target !== crEl) {
      menu.remove();
      crEl.classList.remove('dir-popover');
      document.removeEventListener('mousedown', onDocClick, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
}

// ---------- Tab 切换（库入口卡片） ----------
function switchTab(tab, updateHistory = true) {
  activeTab = tab;
  libCards.forEach((c) => c.classList.toggle('active', c.dataset.tab === tab));
  sideViews.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== tab));

  if (tab === 'motions') {
    if (motionRootPath) {
      if (!motionRootItems || !motionRootItems.length) {
        navigateTo(motionRootPath, 'motions', updateHistory);
      } else {
        renderMotionList();
        renderBreadcrumb(motionRootPath, pathPartsUnderRoot(motionRootPath, motionRootPath));
        if (updateHistory) pushNavHistory(motionRootPath, 'motions');
        updateNavButtons();
      }
    } else {
      motionListEl.innerHTML = '<div class="placeholder">未找到动作目录</div>';
    }
  } else if (tab === 'scenes') {
    if (sceneRootPath) {
      if (!sceneRoot) {
        navigateTo(sceneRootPath, 'scenes', updateHistory);
      } else {
        renderTree(sceneRoot, sceneTreeEl);
        renderBreadcrumb(sceneRootPath, pathPartsUnderRoot(sceneRootPath, sceneRootPath));
        if (updateHistory) pushNavHistory(sceneRootPath, 'scenes');
        updateNavButtons();
      }
    } else {
      sceneTreeEl.innerHTML = '<div class="placeholder">未找到场景目录（' + (defaultRootPath || '') + '\\场景）</div>';
    }
  } else if (tab === 'mods') {
    renderModList();
    renderBreadcrumb('', []);
    breadcrumbEl.innerHTML = '<span class="crumb placeholder">🎮 Mod 库（选择 Mod 装载到当前模型）</span>';
    updateNavButtons();
  } else if (tab === 'recent') {
    renderRecentList();
    renderBreadcrumb('', []);
    breadcrumbEl.innerHTML = '<span class="crumb placeholder">最近加载的文件</span>';
    updateNavButtons();
  } else if (tab === 'cache') {
    renderSideCache();
    renderBreadcrumb('', []);
    breadcrumbEl.innerHTML = '<span class="crumb placeholder">💾 缓存资源：模型 / 场景 / 动作</span>';
    updateNavButtons();
  } else if (tab === 'compose') {
    renderComposePanel();
    renderBreadcrumb('', []);
    breadcrumbEl.innerHTML = '<span class="crumb placeholder">🧩 组合编排：场景 + 模型 + 动作</span>';
    updateNavButtons();
  } else {
    if (currentRoot) {
      renderTree(currentRoot); // 重绘文件树（已缓存资源见「缓存资源」面板）
      renderBreadcrumb(currentDirPath || defaultRootPath,
        pathPartsUnderRoot(currentDirPath || defaultRootPath, defaultRootPath));
      if (updateHistory) pushNavHistory(currentDirPath || defaultRootPath, 'models');
      updateNavButtons();
    }
  }
}

// 判断缓存项是否属于「场景」来源（用于左侧场景卡片展示）
function isSceneCacheItem(it) {
  if (!it || it.type !== 'model') return false;
  if (it.scene === true) return true;
  if (sceneRootPath) {
    const src = String(it.sourcePath || '').replace(/\\/g, '/').toLowerCase();
    const pref = sceneRootPath.replace(/\\/g, '/').toLowerCase();
    return src.startsWith(pref + '/') || src === pref;
  }
  return false;
}

// ---------- 目录树 (Win10 列表扁平 grid) ----------
function renderTree(root, containerEl) {
  const cont = containerEl || fileTreeEl;
  cont.innerHTML = '';
  dirDescendants.clear();
  // 根节点本身也要一行（Win10 风格）
  appendWin10Row(root, 0, true, cont);
  // root 默认展开
  if (root.children) {
    root.children.forEach((c) => dfsAppend(c, 1, [root], cont));
  }
  // 注：已缓存资源不再注入文件树，统一展示在左侧「缓存资源」面板（模型/场景/动作分类）
}
function dfsAppend(node, depth, ancestorDirs, cont) {
  const row = appendWin10Row(node, depth, false, cont);
  // 挂到所有祖先 dir 的后代集合（便于 toggle 时一次性显示/隐藏）
  ancestorDirs.forEach((a) => {
    const key = normalizePath(a.path || a.name);
    if (!dirDescendants.has(key)) dirDescendants.set(key, new Set());
    dirDescendants.get(key).add(row);
  });
  if (node.type === 'dir' && node.children && node.children.length) {
    const nextAncestors = ancestorDirs.concat([node]);
    node.children.forEach((c) => dfsAppend(c, depth + 1, nextAncestors, cont));
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
function appendWin10Row(node, depth, isRoot, container) {
  const cont = container || fileTreeEl;
  const row = document.createElement('div');
  row.className = 'win10-row';
  row.dataset.path = normalizePath(node.path);
  row.dataset.isDir = node.type === 'dir' ? '1' : '0';
  row.dataset.depth = depth;
  row.dataset.name = node.name || '';
  if (node.isSceneCache) row.dataset.scene = '1';
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
    row.addEventListener('dblclick', (e) => { e.stopPropagation(); navigateTo(node.path, cont === sceneTreeEl ? 'scenes' : 'models', true); });
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

  // 模型文件行支持拖拽：拖到 3D 视口可在指定位置放入场景（场景与角色同时预览）
  if (node.type === 'model' && MODEL_MESH_RE.test(node.name)) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-mmd-model', JSON.stringify({
        path: node.path,
        name: node.name,
        size: node.size != null ? node.size : null,
        isSceneCache: !!node.isSceneCache,
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  cont.appendChild(row);
  return row;
}
function toggleDir(rowEl, forceExpand) {
  if (rowEl?.dataset?.isDir !== '1') return;
  const key = normalizePath(rowEl.dataset.path);
  const desc = dirDescendants.get(key);
  const twisty = rowEl.querySelector('.w10-twisty');
  if (!twisty) return;
  const currentlyCollapsed = twisty.textContent === '▸';
  const shouldExpand = forceExpand === undefined ? currentlyCollapsed : !!forceExpand;
  if (shouldExpand) {
    // 展开：本目录所有后代先恢复可见，再对仍处于折叠状态的子目录重新隐藏其后代
    twisty.textContent = '▾';
    if (desc) desc.forEach((r) => r.classList.remove('collapsed-descendant'));
    if (desc) desc.forEach((r) => {
      if (r.dataset.isDir === '1') {
        const subTwisty = r.querySelector('.w10-twisty');
        if (subTwisty && subTwisty.textContent === '▸') {
          const subDesc = dirDescendants.get(normalizePath(r.dataset.path));
          if (subDesc) subDesc.forEach((sr) => sr.classList.add('collapsed-descendant'));
        }
      }
    });
  } else {
    // 折叠：所有后代全部隐藏（与 Win10 资源管理器一致）
    twisty.textContent = '▸';
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

// ---------- 原生文件对话框 ----------
async function handleOpenModelDialog() {
  const res = await api.showOpenDialog({
    title: '选择模型/动作/压缩包文件',
    properties: ['openFile'],
    filters: [
      { name: '模型/压缩包/动作', extensions: ['pmx', 'pmd', 'vmd', 'vpd', 'zip', '7z', 'rar', 'tar', 'gz', 'xz'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!res.ok || !res.data || !res.data.length) return;
  const filePath = res.data[0];
  const name = pathBasename(filePath);
  const ext = name.split('.').pop().toLowerCase();

  if (ARCHIVE_RE.test(name)) {
    // 压缩包：直接解压并浏览
    setStatus('正在解压 ' + name + ' …', 'info');
    try {
      const extRes = await api.extractArchive(filePath);
      if (!extRes.ok) throw new Error(extRes.error);
      addRecent(filePath, name, 'archive', null);
      // 在树中浏览解压后的目录
      currentRoot = extRes.data.tree;
      currentDirPath = extRes.data.dest;
      rootPathEl.textContent = '临时目录：' + extRes.data.dest;
      switchTab('models', false);
      renderTree(extRes.data.tree);
      renderBreadcrumb(extRes.data.dest, pathPartsUnderRoot(extRes.data.dest, extRes.data.dest));
      pushNavHistory(extRes.data.dest, 'models');
      updateNavButtons();
      // 自动找到并加载第一个 PMX
      const firstPmx = findFirstModel(extRes.data.tree);
      if (firstPmx) {
        setStatus('已解压，正在加载模型 ' + firstPmx.name + ' …', 'info');
        addRecent(firstPmx.path, firstPmx.name, 'model', firstPmx.size);
        currentModelPath = firstPmx.path;
        loadModel(firstPmx);
      } else {
        setStatus('解压完成，请在左侧选择模型文件', 'info', extRes.data.dest);
      }
    } catch (err) {
      setStatus('解压失败：' + (err.message || err), 'error');
    }
  } else if (MOTION_EXTS_RE.test(name)) {
    // VMD/VPD 动作
    if (currentModel && currentMesh) {
      playVmd({ path: filePath, name, size: null }, currentMesh, null);
    } else {
      showPreviewCardForNode({ path: filePath, name, size: null, type: 'model' }, true);
      setStatus('请先加载一个 PMX/PMD 模型，再应用此动作', 'warn', name);
    }
    addRecent(filePath, name, 'model', null);
  } else {
    // 模型文件
    addRecent(filePath, name, 'model', null);
    currentModelPath = filePath;
    showPreviewCardForNode({ path: filePath, name, size: null, type: 'model' }, true);
    loadModel({ path: filePath, name, size: null });
  }
}

async function handleOpenArchiveDialog() {
  const res = await api.showOpenDialog({
    title: '选择压缩包',
    properties: ['openFile'],
    filters: [
      { name: '压缩包', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'xz', 'tgz', 'txz'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!res.ok || !res.data || !res.data.length) return;
  const filePath = res.data[0];
  const name = pathBasename(filePath);
  setStatus('正在解压 ' + name + ' …', 'info');
  try {
    const extRes = await api.extractArchive(filePath);
    if (!extRes.ok) throw new Error(extRes.error);
    addRecent(filePath, name, 'archive', null);
    currentRoot = extRes.data.tree;
    currentDirPath = extRes.data.dest;
    rootPathEl.textContent = '临时目录：' + extRes.data.dest;
    switchTab('models', false);
    renderTree(extRes.data.tree);
    renderBreadcrumb(extRes.data.dest, pathPartsUnderRoot(extRes.data.dest, extRes.data.dest));
    pushNavHistory(extRes.data.dest, 'models');
    updateNavButtons();
    const firstPmx = findFirstModel(extRes.data.tree);
    if (firstPmx) {
      setStatus('已解压，正在加载模型 ' + firstPmx.name + ' …', 'info');
      addRecent(firstPmx.path, firstPmx.name, 'model', firstPmx.size);
      currentModelPath = firstPmx.path;
      loadModel(firstPmx);
    } else {
      setStatus('解压完成，请在左侧选择模型文件', 'info', extRes.data.dest);
    }
  } catch (err) {
    setStatus('解压失败：' + (err.message || err), 'error');
  }
}

function findFirstModel(node) {
  if (!node) return null;
  if (node.type === 'model' && MODEL_MESH_RE.test(node.name)) return node;
  if (node.children) {
    for (const c of node.children) {
      const found = findFirstModel(c);
      if (found) return found;
    }
  }
  return null;
}

// ---------- 文件选择与预览卡 ----------
function selectFile(node) {
  setSelectedByPath(node.path);
  if (node.type === 'model') {
    if (MOTION_EXTS_RE.test(node.name)) {
      currentModelPath && currentMesh
        ? playVmd(node, currentMesh, null)
        : setStatus('已选中动作文件，请先加载对应模型再应用', 'warn', node.name);
      showPreviewCardForNode(node, true);
    } else {
      currentModelPath = node.path;
      addRecent(node.path, node.name, 'model', node.size);
      showPreviewCardForNode(node, true);
      // 场景 Tab 或已缓存的场景项：作为「场景模型」加入场景（保留当前角色模型）
      const asScene = activeTab === 'scenes' || !!node.isSceneCache;
      loadModel(node, { asScene });
    }
  } else if (node.type === 'archive') {
    handleArchive(node);
  } else if (node.type === 'text') {
    showTextFile(node);
  }
}
function selectFlat(item) {
  if (item.type === 'model') {
    if (MOTION_EXTS_RE.test(item.name)) {
      if (currentModelPath && currentMesh) playVmd(item, currentMesh, null);
      else setStatus('已选中动作文件，请先加载对应模型再应用', 'warn', item.name);
      showPreviewCardForNode(item, true);
    } else {
      currentModelPath = item.path;
      addRecent(item.path, item.name, 'model', item.size);
      showPreviewCardForNode(item, true);
      loadModel({ path: item.path, name: item.name, size: item.size });
    }
  } else if (item.type === 'archive') {
    handleArchive(item);
  } else if (item.type === 'text') {
    showTextFile(item);
  } else {
    setStatus('该文件暂不支持预览：' + item.name, 'warn');
  }
}

function showPreviewCardForNode(node, pinned = false) {
  if (!node) return;
  pcTitle.textContent = node.name;
  pcBody.innerHTML = buildPreviewCardHtml(node);
  previewCardEl.classList.remove('hidden');
  if (pinned) previewCardEl.dataset.pinned = '1';
  else delete previewCardEl.dataset.pinned;
  if (node.type === 'text') {
    const tp = pcBody.querySelector('.pc-text-preview');
    if (tp && tp.dataset.needLoad === '1') loadTextContentToCard(node, tp);
  }
}
function hidePreviewCard() {
  if (previewCardEl.dataset.pinned) return;
  previewCardEl.classList.add('hidden');
}

function buildPreviewCardHtml(node) {
  const isVmd = MOTION_EXTS_RE.test(node.name);
  const isModelMesh = MODEL_MESH_RE.test(node.name);
  const isArchive = node.type === 'archive';
  const isText = node.type === 'text';
  let html = '<div class="section">基础信息</div>';
  html += `<div class="kv"><div class="k">类型</div><div class="v"><span class="tag ${kindTagClass(isVmd ? '.vmd' : node.type)}">${kindLabel(isVmd ? '.vmd' : node.type, node.name)}</span></div></div>`;
  html += `<div class="kv"><div class="k">大小</div><div class="v">${fmtSize(node.size)}</div></div>`;
  html += `<div class="kv"><div class="k">路径</div><div class="v" title="${escapeHtml(node.path || '')}" style="font-size:11px;">${escapeHtml(node.path || '')}</div></div>`;

  if (isVmd) {
    html += `<div class="section">动作预览</div>`;
    html += `<div class="kv"><div class="k">格式</div><div class="v">${/\.vmd$/i.test(node.name) ? 'VMD（动作）' : 'VPD（姿势）'}</div></div>`;
    html += `<div class="kv"><div class="k">状态</div><div class="v">${currentModel && currentMesh
      ? (currentAnimating ? '已载入动作' : '点击后可应用到当前模型')
      : '请先加载一个模型再应用此动作'}</div></div>`;
  } else if (isModelMesh) {
    html += `<div class="section">模型预览</div>`;
    const mExt = (node.name.split('.').pop() || '').toUpperCase();
    html += `<div class="kv"><div class="k">可加载</div><div class="v">${/\.pmx$/i.test(node.name) ? 'PMX（完整支持）' : /\.pmd$/i.test(node.name) ? 'PMD（完整支持）' : `${mExt}（通用格式预览）`}</div></div>`;
    html += `<div class="kv"><div class="k">操作</div><div class="v" style="font-size:11px;color:var(--text-muted);">左键旋转 · 右键平移 · 滚轮缩放</div></div>`;
  } else if (NON_PREVIEW_RE.test(node.name)) {
    const mExt = (node.name.split('.').pop() || '').toUpperCase();
    html += `<div class="section">模型预览</div>`;
    html += `<div class="kv"><div class="k">格式</div><div class="v">${mExt}（建模软件专有二进制格式）</div></div>`;
    html += `<div class="kv"><div class="k">预览</div><div class="v" style="color:var(--warn);">该格式无法在浏览器端解析，暂不支持 3D 预览</div></div>`;
  } else if (isArchive) {
    html += `<div class="section">压缩包预览</div>`;
    html += `<div class="kv"><div class="k">类型</div><div class="v">${guessArchiveKind(node.name)}</div></div>`;
    html += `<div class="kv"><div class="k">查看</div><div class="v" style="font-size:11px;">单击 → 列出内容；双击 → 解压并浏览</div></div>`;
    html += `<div class="tag-list"><span class="tag archive">支持浏览</span><span class="tag archive">缓存复用</span></div>`;
  } else if (isText) {
    html += `<div class="section">文本内容</div>`;
    html += `<div class="pc-text-preview" data-need-load="1">正在读取…</div>`;
  }
  return html;
}

function guessArchiveKind(name) {
  if (/\.zip$/i.test(name)) return 'ZIP';
  if (/\.7z$/i.test(name)) return '7-Zip';
  if (/\.rar$/i.test(name)) return 'RAR';
  if (/\.(tgz|tar\.gz)$/i.test(name)) return 'TAR.GZ';
  if (/\.(txz|tar\.xz)$/i.test(name)) return 'TAR.XZ';
  if (/\.tar$/i.test(name)) return 'TAR';
  return '压缩包';
}

async function loadTextContentToCard(node, tpEl) {
  try {
    const res = await api.readTextFile(node.path, 256 * 1024);
    if (!res.ok) { tpEl.textContent = '读取失败：' + res.error; return; }
    tpEl.textContent = res.data.content || '（空文件）';
    if (res.data.truncated) {
      const h = document.createElement('div');
      h.className = 'pc-trunc-hint';
      h.textContent = `仅显示前 ${fmtSize(256 * 1024)}（共 ${fmtSize(res.data.size)}）`;
      tpEl.parentNode.insertBefore(h, tpEl.nextSibling);
    }
  } catch (e) {
    tpEl.textContent = '读取失败：' + (e && e.message || e);
  } finally {
    delete tpEl.dataset.needLoad;
  }
}

// ---------- 压缩包：先预览内容浮层，再解压 ----------
async function handleArchive(node) {
  setStatus('读取压缩包清单…', 'info', node.name);
  const res = await api.listArchiveContents(node.path);
  lastArchivePreviewPath = node.path;
  apTitle.textContent = node.name;
  apBody.innerHTML = '';
  archivePreviewEl.classList.remove('hidden');
  apExtract.disabled = true;

  if (!res.ok) {
    // 清单失败 → 直接尝试解压（这是修复"解压报错"的关键：不因 list 失败而阻断）
    apBody.innerHTML = `<div class="ap-empty">清单读取失败，正在直接解压…</div>`;
    apExtract.disabled = true;
    // 自动尝试解压
    try {
      const extRes = await api.extractArchive(node.path);
      if (!extRes.ok) throw new Error(extRes.error);
      archivePreviewEl.classList.add('hidden');
      addRecent(node.path, node.name, 'archive', node.size);
      currentRoot = extRes.data.tree;
      currentDirPath = extRes.data.dest;
      rootPathEl.textContent = '临时目录：' + extRes.data.dest;
      switchTab('models', false);
      renderTree(extRes.data.tree);
      renderBreadcrumb(extRes.data.dest, pathPartsUnderRoot(extRes.data.dest, extRes.data.dest));
      pushNavHistory(extRes.data.dest, 'models');
      updateNavButtons();
      const firstPmx = findFirstModel(extRes.data.tree);
      if (firstPmx) {
        setStatus('已解压，正在加载模型 ' + firstPmx.name + ' …', 'info');
        addRecent(firstPmx.path, firstPmx.name, 'model', firstPmx.size);
        currentModelPath = firstPmx.path;
        loadModel(firstPmx);
      } else {
        setStatus('解压完成，请在左侧选择模型', 'info', extRes.data.dest);
      }
    } catch (err) {
      apBody.innerHTML = `<div class="ap-empty">解压失败：${escapeHtml(err.message || err)}</div>`;
      setStatus('解压失败：' + (err.message || err), 'error');
    }
    return;
  }

  if (res.data.kind === 'scandir') {
    apBody.innerHTML = `<div class="ap-empty">该格式直接解压后浏览（已缓存）。</div>`;
    setTimeout(() => doExtractAndBrowse(node), 600);
    return;
  }

  const entries = res.data.entries || [];
  let totalSize = 0;
  let hasModel = false, hasMotion = false;
  entries.forEach((e) => {
    if (typeof e.size === 'number') totalSize += e.size;
    if (MODEL_MESH_RE.test(e.name || '')) hasModel = true;
    if (MOTION_EXTS_RE.test(e.name || '')) hasMotion = true;
  });

  const head = document.createElement('div');
  head.style.padding = '8px 12px';
  head.style.fontSize = '11px';
  head.style.color = 'var(--text-muted)';
  head.innerHTML = `
    <div class="tag-list" style="margin-bottom:4px;">
      <span class="tag">共 ${entries.length} 项</span>
      <span class="tag">解压后 ${fmtSize(totalSize)}</span>
      ${hasModel ? '<span class="tag model">含模型</span>' : ''}
      ${hasMotion ? '<span class="tag motion">含动作</span>' : ''}
    </div>`;
  apBody.appendChild(head);

  const tbl = document.createElement('table');
  tbl.className = 'ap-table';
  tbl.innerHTML = `<thead><tr><th>条目名</th><th style="text-align:right">大小</th><th>日期</th></tr></thead><tbody></tbody>`;
  const tb = tbl.querySelector('tbody');
  if (entries.length === 0) {
    apBody.innerHTML += '<div class="ap-empty">压缩包内无条目</div>';
  } else {
    entries.slice(0, 500).forEach((e) => {
      const tr = document.createElement('tr');
      const ename = String(e.name || '').replace(/\\/g, '/');
      const isDir = ename.endsWith('/');
      const nIcon = isDir ? '📁' : (MODEL_MESH_RE.test(ename) || NON_PREVIEW_RE.test(ename)) ? '🧊' : MOTION_EXTS_RE.test(ename) ? '🎬' : /\.(png|jpg|bmp|tga|dds)$/i.test(ename) ? '🖼️' : '📄';
      tr.innerHTML = `
        <td class="name-cell" title="${escapeHtml(ename)}"><span style="margin-right:6px;">${nIcon}</span>${escapeHtml(pathBasename(ename))}${isDir ? '/' : ''}</td>
        <td class="size-cell">${isDir ? '—' : fmtSize(e.size)}</td>
        <td class="dt-cell">${fmtDT(e.datetime)}</td>`;
      tb.appendChild(tr);
    });
    apBody.appendChild(tbl);
    if (entries.length > 500) {
      const more = document.createElement('div');
      more.style.padding = '8px 12px';
      more.style.color = 'var(--warn)';
      more.style.fontSize = '11px';
      more.textContent = `（仅显示前 500 条，共 ${entries.length} 条）`;
      apBody.appendChild(more);
    }
  }
  apExtract.disabled = false;
  setStatus(`压缩包清单：${entries.length} 项（${fmtSize(totalSize)}）`, 'info', node.name);
}

async function doExtractAndBrowse(node) {
  setStatus('正在解压 ' + node.name + ' …', 'info');
  try {
    const res = await api.extractArchive(node.path || lastArchivePreviewPath);
    if (!res.ok) throw new Error(res.error);
    archivePreviewEl.classList.add('hidden');
    addRecent(node.path || lastArchivePreviewPath, node.name, 'archive', node.size);
    setStatus(`已解压 ${node.name}，浏览临时目录`, 'info', res.data.dest);
    currentRoot = res.data.tree;
    currentDirPath = res.data.dest;
    rootPathEl.textContent = '临时目录：' + res.data.dest;
    switchTab('models', false);
    renderTree(res.data.tree);
    renderBreadcrumb(res.data.dest, pathPartsUnderRoot(res.data.dest, res.data.dest));
    pushNavHistory(res.data.dest, 'models');
    updateNavButtons();
    // 自动加载第一个 PMX
    const firstPmx = findFirstModel(res.data.tree);
    if (firstPmx) {
      setStatus('正在加载模型 ' + firstPmx.name + ' …', 'info');
      addRecent(firstPmx.path, firstPmx.name, 'model', firstPmx.size);
      currentModelPath = firstPmx.path;
      loadModel(firstPmx);
    }
  } catch (err) {
    setStatus('解压失败：' + err.message, 'error');
  }
}

function showTextFile(node) {
  modelInfoEl.innerHTML = `<div class="section">文本文件</div>
    <div class="kv"><div class="k">名称</div><div class="v">${escapeHtml(node.name)}</div></div>
    <div class="kv"><div class="k">路径</div><div class="v" style="font-size:11px;">${escapeHtml(node.path)}</div></div>
    <div class="kv"><div class="k">大小</div><div class="v">${fmtSize(node.size)}</div></div>`;
  showPreviewCardForNode(node, true);
}

// ---------- 最近加载列表 ----------
function renderRecentList() {
  if (!recentItems.length) {
    recentListEl.innerHTML = '<div class="placeholder">暂无记录</div>';
    return;
  }
  recentListEl.innerHTML = '';
  recentItems.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'motion-item';
    const icon = r.type === 'archive' ? '🗜️' : MOTION_EXTS_RE.test(r.name) ? '🎬' : '🧊';
    const label = r.type === 'archive' ? '压缩包' : MOTION_EXTS_RE.test(r.name) ? 'VMD' : '模型';
    el.innerHTML = `
      <div class="mi-icon">${icon}</div>
      <div class="mi-body">
        <div class="mi-name">${escapeHtml(r.name)}</div>
        <div class="mi-meta">
          <span>${fmtSize(r.size)}</span>
          <span class="chip">${label}</span>
          <span style="color:var(--text-dim);">${new Date(r.ts).toLocaleDateString('zh-CN')}</span>
        </div>
      </div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.motion-item.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      // 重新加载该文件
      if (r.type === 'archive') {
        handleArchive({ path: r.path, name: r.name, size: r.size });
      } else if (MOTION_EXTS_RE.test(r.name)) {
        if (currentModel && currentMesh) playVmd({ path: r.path, name: r.name, size: r.size }, currentMesh, null);
        else setStatus('请先加载模型再应用此动作', 'warn', r.name);
      } else {
        currentModelPath = r.path;
        loadModel({ path: r.path, name: r.name, size: r.size });
      }
    });
    recentListEl.appendChild(el);
  });
}

function updateLibCounts() {
  // 文件树只统计文件系统中的资源；已缓存资源统一显示在「缓存资源」面板
  $('lib-models-count').textContent = (currentRoot ? countModels(currentRoot) : 0) + ' 项';
  $('lib-motions-count').textContent = motionRootItems.length + ' 项';
  const lmc = $('lib-mods-count');
  if (lmc) lmc.textContent = (modArchivesCache ? modArchivesCache.length : 0) + ' 项';
  $('lib-recent-count').textContent = recentItems.length + ' 项';
  const sce = $('lib-scenes-count');
  if (sce) sce.textContent = (sceneRoot ? countModels(sceneRoot) : 0) + ' 项';
  const cac = $('lib-cache-count');
  if (cac) cac.textContent = (cacheState.items || []).length + ' 项';
  const cmp = $('lib-compose-count');
  if (cmp) cmp.textContent = sceneItems.length + ' 个';
}

// ---------- 组合编排面板（场景 + 可放置模型 + 动作） ----------
function collectModelsInTree(rootNode) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'model' && MODEL_MESH_RE.test(n.name)) out.push(n);
    (n.children || []).forEach(walk);
  })(rootNode);
  return out;
}
function composeCacheAbs(it) {
  return window.__cacheRootAbs ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '') : (it.sourcePath || '');
}
function fillSelect(sel, opts, emptyText) {
  if (!sel) return;
  sel.innerHTML = '';
  if (!opts.length) {
    const o = document.createElement('option');
    o.textContent = emptyText;
    sel.appendChild(o);
    return;
  }
  opts.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.path;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
}
// 组合面板：已加载模型列表（场景 + 放置模型 + 角色），点击选中高亮、可删除
function composeModelListEntries() {
  const entries = []; // { mesh, name, tag, motion, deletable }
  const seen = new Set();
  // 场景成员（含作为当前模型的场景）按其 kind 标记
  (sceneItems || []).forEach((s) => {
    if (!s || !s.mesh || seen.has(s.mesh)) return;
    seen.add(s.mesh);
    entries.push({
      mesh: s.mesh,
      name: (s.mesh.userData && s.mesh.userData.name) || (s.node && s.node.name) || s.mesh.name || (s.kind === 'scene' ? '场景' : '模型'),
      tag: s.kind === 'scene' ? '场景' : '组合',
      motion: (s.mesh.userData && s.mesh.userData.activeMotion) || ''
    });
  });
  // 未加入场景的当前角色模型
  if (currentModel && !seen.has(currentModel)) {
    entries.push({
      mesh: currentModel,
      name: (currentModel.userData && currentModel.userData.name) || currentModel.name || '当前模型',
      tag: '角色',
      motion: (currentModel.userData && currentModel.userData.activeMotion) || ''
    });
  }
  return entries;
}
function renderComposeModelList() {
  const listEl = $('compose-model-list');
  if (!listEl) return;
  const entries = composeModelListEntries();
  const countEl = $('compose-count');
  if (countEl) {
    countEl.textContent = entries.length
      ? `${composePlacedCount()}/${composeMaxPlaced()} 个组合 · 共 ${entries.length} 个模型`
      : '0 个模型';
  }
  const maxEl = $('compose-max-label');
  if (maxEl) maxEl.textContent = String(composeMaxPlaced());
  if (!entries.length) {
    listEl.innerHTML = '<div class="cmi-empty">尚未加载任何模型。先加载场景，再放置模型即可组合。</div>';
    return;
  }
  listEl.innerHTML = '';
  entries.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'cmi' + (composeSelected === e.mesh ? ' active' : '');
    row.title = '点击选中（用于移动/附加动作）';
    const name = document.createElement('span');
    name.className = 'cmi-name';
    name.textContent = e.name;
    const tag = document.createElement('span');
    tag.className = 'cmi-tag';
    tag.textContent = e.tag;
    row.appendChild(name);
    row.appendChild(tag);
    // 附加的动作（r4）：直观显示该模型当前使用的动作
    if (e.motion) {
      const mot = document.createElement('span');
      mot.className = 'cmi-tag cmi-motion';
      mot.textContent = '🎬 ' + e.motion;
      mot.title = '该模型当前附加的动作';
      row.appendChild(mot);
    }
    const del = document.createElement('button');
    del.className = 'btn-tiny';
    del.textContent = '删除';
    del.title = '从场景中移除该模型';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeSceneItem(e.mesh);
    });
    row.appendChild(del);
    row.addEventListener('click', () => selectComposeModel(e.mesh));
    listEl.appendChild(row);
  });
}
// 选中组合面板中的模型：作为移动/附加动作的目标，并让该模型边缘高亮
function selectComposeModel(mesh) {
  if (!mesh) return;
  composeSelected = mesh;
  composeTargetMesh = mesh;
  refreshOutlineSelection();
  renderComposeModelList();
  const nm = (mesh.userData && mesh.userData.name) || '';
  setStatus('已选中模型' + (nm ? '：' + nm : '，可拖动位置或附加动作'), 'info');
}
function deselectComposeModel() {
  composeSelected = null;
  refreshOutlineSelection();
  renderComposeModelList();
}
// ---------- 自定义下拉框（r2：展开显示选项名称 + 类型徽标） ----------
function createComposeDropdown(id, placeholder) {
  const root = $(id);
  if (!root) return null;
  root.innerHTML = `
    <button type="button" class="c-dd-trigger" title="点击展开选择">
      <span class="c-dd-label placeholder">${escapeHtml(placeholder)}</span>
      <span class="c-dd-caret">▼</span>
    </button>
    <div class="c-dd-menu hidden"></div>`;
  const trigger = root.querySelector('.c-dd-trigger');
  const labelEl = root.querySelector('.c-dd-label');
  const menu = root.querySelector('.c-dd-menu');
  const api = {
    _opts: [], _value: '', _placeholder: placeholder, _onChange: null,
    setOptions(opts) {
      this._opts = (opts || []).filter((o) => o && o.path);
      const still = this._opts.find((o) => o.path === this._value);
      this._value = still ? still.path : '';
      this._renderLabel();
      this._close();
      this._renderMenu();
    },
    getValue() { return this._value; },
    select(path) {
      const o = this._opts.find((x) => x.path === path);
      if (!o) return;
      this._value = path;
      this._renderLabel();
      this._renderMenu();
      this._close();
      if (this._onChange) this._onChange(path);
    },
    onChange(fn) { this._onChange = fn; },
    _renderLabel() {
      const o = this._opts.find((x) => x.path === this._value);
      labelEl.textContent = o ? o.label : this._placeholder;
      labelEl.classList.toggle('placeholder', !o);
    },
    _renderMenu() {
      menu.innerHTML = '';
      if (!this._opts.length) {
        menu.innerHTML = '<div class="c-dd-empty">暂无选项</div>';
        return;
      }
      this._opts.forEach((o) => {
        const item = document.createElement('div');
        item.className = 'c-dd-item' + (o.path === this._value ? ' selected' : '');
        item.title = o.path || '';
        const name = document.createElement('span');
        name.className = 'c-dd-item-name';
        name.textContent = o.label || '';
        item.appendChild(name);
        if (o.meta) {
          const meta = document.createElement('span');
          meta.className = 'c-dd-item-meta';
          meta.textContent = o.meta;
          item.appendChild(meta);
        }
        item.addEventListener('click', () => api.select(o.path));
        menu.appendChild(item);
      });
    },
    _open() {
      this._renderMenu();
      menu.classList.remove('hidden');
      root.classList.add('open');
      // 空间不足时向上展开，避免被侧栏底部裁剪
      const r = trigger.getBoundingClientRect();
      const mh = menu.offsetHeight || 220;
      const up = (window.innerHeight - r.bottom) < mh + 12;
      menu.classList.toggle('up', up);
    },
    _close() {
      menu.classList.add('hidden');
      root.classList.remove('open');
      menu.classList.remove('up');
    }
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) api._open(); else api._close();
  });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) api._close(); });
  api._renderMenu();
  return api;
}
// 初始化组合面板的三个下拉框（幂等，仅一次）
let composeDDInited = false;
function initComposeDropdowns() {
  if (composeDDInited) return;
  composeDDInited = true;
  composeSceneDD = createComposeDropdown('compose-scene', '（暂无可选场景）');
  composeModelDD = createComposeDropdown('compose-model', '（暂无可放置模型）');
  composeMotionDD = createComposeDropdown('compose-motion', '（暂无可选动作）');
}
async function renderComposePanel() {
  initComposeDropdowns();
  if (!composeSceneDD || !composeModelDD || !composeMotionDD) return;
  bindComposeEventsOnce();
  if (!window.__cacheRootAbs && api && api.getCacheDirInfo) {
    try {
      const info = await api.getCacheDirInfo();
      if (info && info.root) window.__cacheRootAbs = info.root;
    } catch (_) { /* noop */ }
  }
  if (!cacheState.items.length) await refreshCacheItems();

  // 已加载模型列表（点选 + 删除 + 显示附加动作）+ 数量上限
  renderComposeModelList();

  // 场景选项：场景根模型 + 已缓存场景项
  const sceneOpts = [];
  (sceneRoot ? collectModelsInTree(sceneRoot) : []).forEach((n) => {
    if (!sceneOpts.some((o) => o.path === n.path)) sceneOpts.push({ label: n.name, path: n.path });
  });
  (cacheState.items || []).filter((it) => it.type === 'model' && isSceneCacheItem(it)).forEach((it) => {
    const abs = composeCacheAbs(it);
    if (sceneOpts.some((o) => o.path === abs)) return;
    // 压缩包来源的场景可能重名（如不同 zip 内都是 Stage0514.pmx），附上来源包名以区分
    let label = it.name;
    if (it.sourceType === 'archive' && it.sourcePath) {
      const zipName = String(it.sourcePath).replace(/\\/g, '/').split('/').pop();
      if (zipName) label = it.name + '（' + zipName + '）';
    }
    sceneOpts.push({ label, path: abs });
  });
  composeSceneDD.setOptions(sceneOpts.map((o) => ({ ...o, meta: '场景' })));

  // 可放置模型：缓存中的非场景模型（排除已放置/已加载的角色）
  const inScenePaths = new Set();
  if (currentModel && currentModel.userData && currentModel.userData.path) inScenePaths.add(currentModel.userData.path);
  (sceneItems || []).forEach((s) => { if (s && s.node && s.node.path) inScenePaths.add(s.node.path); });
  const modelOpts = [];
  (cacheState.items || []).filter((it) => it.type === 'model' && !isSceneCacheItem(it)).forEach((it) => {
    const abs = composeCacheAbs(it);
    if (inScenePaths.has(abs)) return;
    if (!modelOpts.some((o) => o.path === abs)) modelOpts.push({ label: it.name, path: abs });
  });
  composeModelDD.setOptions(modelOpts.map((o) => ({ ...o, meta: '模型' })));

  // 动作选项：已缓存动作 + 动作库
  const motionOpts = [];
  (cacheState.items || []).filter((it) => it.type === 'motion').forEach((it) => {
    const abs = composeCacheAbs(it);
    if (!motionOpts.some((o) => o.path === abs)) motionOpts.push({ label: it.name, path: abs });
  });
  motionRootItems.forEach((n) => {
    if (n.type === 'model' && MOTION_EXTS_RE.test(n.name) && !motionOpts.some((o) => o.path === n.path)) {
      motionOpts.push({ label: n.name, path: n.path });
    }
  });
  composeMotionDD.setOptions(motionOpts.map((o) => ({ ...o, meta: '动作' })));
}
let composeEventsBound = false;
function bindComposeEventsOnce() {
  if (composeEventsBound) return;
  composeEventsBound = true;
  $('btn-compose-scene').addEventListener('click', async () => {
    const path = composeSceneDD && composeSceneDD.getValue();
    const opt = (composeSceneDD && composeSceneDD._opts || []).find((o) => o.path === path);
    if (!path) { setStatus('请先在组合面板选择场景', 'warn'); return; }
    // 需求1：加载新场景时替换旧场景（kind='scene' 触发 removeSceneItems 替换）
    loadModel({ path, name: (opt && opt.label) || path }, { asScene: true, kind: 'scene' });
  });
  $('btn-compose-model').addEventListener('click', async () => {
    const path = composeModelDD && composeModelDD.getValue();
    const opt = (composeModelDD && composeModelDD._opts || []).find((o) => o.path === path);
    if (!path) { setStatus('请先选择要放置的模型', 'warn'); return; }
    // r3：放置数量上限校验（不含动作）
    const maxPlaced = composeMaxPlaced();
    if (composePlacedCount() >= maxPlaced) {
      setStatus(`组合模型数量已达上限 ${maxPlaced} 个（可在参数面板「组合」组调整）`, 'warn');
      return;
    }
    // 放置模型：初始在网格中心 (0,0,0)，可动，选中作为动作目标
    loadModel({ path, name: (opt && opt.label) || path }, { asScene: true, kind: 'placed', initialPosition: { x: 0, y: 0, z: 0 }, animatable: true });
  });
  $('btn-compose-motion').addEventListener('click', async () => {
    const path = composeMotionDD && composeMotionDD.getValue();
    const opt = (composeMotionDD && composeMotionDD._opts || []).find((o) => o.path === path);
    if (!path) { setStatus('请先选择动作', 'warn'); return; }
    // 动作目标：优先组合面板选中的模型
    const target = composeSelected || composeTargetMesh || currentMesh;
    if (!target) { setStatus('请先加载或放置一个模型，再应用动作', 'warn'); return; }
    playVmd({ path, name: (opt && opt.label) || path }, target, null);
  });
}

// ---------- MMD 模型加载 ----------
const mmdLoader = new MMDLoader();

function clearModel() {
  // 先让 helper 卸掉旧 mesh 的 IK/物理/动画轨道（必须在 scene.remove 之前）
  if (mmdHelper && currentMesh) {
    try { mmdHelper.remove(currentMesh); } catch (_) { /* ignore */ }
  }
  if (currentModel) {
    // 若当前模型是已加入场景的场景模型：只解除「当前模型」引用，保留在场景中（归属 sceneItems，由 clearSceneModels 统一清理）
    const isSceneItem = (sceneItems || []).some((s) => s.mesh === currentModel);
    if (isSceneItem) {
      currentModel = null;
      currentMesh = null;
    } else {
      scene.remove(currentModel);
      disposeObject(currentModel);
      currentModel = null;
      currentMesh = null;
    }
  }
  currentAnimating = false;
  vmdFiles = [];
  vmdListEl.innerHTML = '';
  animPanelUserCollapsed = false;
  setAnimPanelVisible(false);
  // 清空描边所选对象，避免残留已释放网格引用
  refreshOutlineSelection();
}
function disposeObject(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry && child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        Object.keys(m).forEach((k) => { if (m[k] && m[k].isTexture) m[k].dispose(); });
        m.dispose();
      });
    }
  });
}
// 清空所有已加入场景的场景模型（保留当前角色模型；若当前模型本身就是场景模型则一并清空）
function clearSceneModels() {
  (sceneItems || []).forEach((s) => {
    if (!s || !s.mesh) return;
    if (mmdHelper && mmdHelper.objects && mmdHelper.objects.has(s.mesh)) {
      try { mmdHelper.remove(s.mesh); } catch (_) { /* noop */ }
    }
    try { scene.remove(s.mesh); } catch (_) { /* noop */ }
    disposeObject(s.mesh);
  });
  const wasSceneCurrent = sceneItems.some((s) => s.mesh === currentModel);
  sceneItems = [];
  composeTargetMesh = null;
  composeSelected = null;
  if (wasSceneCurrent) {
    currentModel = null;
    currentMesh = null;
    currentModelPath = null;
    currentAnimating = false;
    vmdFiles = [];
    vmdListEl.innerHTML = '';
    animPanelUserCollapsed = false;
    setAnimPanelVisible(false);
    modelInfoEl.innerHTML = '<div class="placeholder">点击「选择模型」或在左侧选文件开始预览</div>';
  }
  refreshOutlineSelection();
  frameAll();
}
// 按条件移除场景中的模型（sceneItems 成员）：helper 卸载 + 移除 + 释放资源 + 引用清理
function removeSceneItems(pred) {
  const doomed = (sceneItems || []).filter(pred);
  if (!doomed.length) return false;
  doomed.forEach((s) => {
    if (!s || !s.mesh) return;
    if (mmdHelper && mmdHelper.objects && mmdHelper.objects.has(s.mesh)) {
      try { mmdHelper.remove(s.mesh); } catch (_) { /* noop */ }
    }
    try { scene.remove(s.mesh); } catch (_) { /* noop */ }
    disposeObject(s.mesh);
    if (composeSelected === s.mesh) composeSelected = null;
    if (composeTargetMesh === s.mesh) composeTargetMesh = null;
    if (currentModel === s.mesh) {
      currentModel = null;
      currentMesh = null;
      currentModelPath = null;
      currentAnimating = false;
      vmdFiles = [];
      vmdListEl.innerHTML = '';
      animPanelUserCollapsed = false;
      setAnimPanelVisible(false);
      modelInfoEl.innerHTML = '<div class="placeholder">点击「选择模型」或在左侧选文件开始预览</div>';
    }
  });
  sceneItems = sceneItems.filter((s) => !pred(s));
  refreshOutlineSelection();
  updateLibCounts();
  return true;
}
// 移除单个场景模型（组合面板删除）
function removeSceneItem(mesh) {
  if (!mesh) return;
  const removed = removeSceneItems((s) => s.mesh === mesh);
  if (!removed && currentModel === mesh) {
    clearModel();
    refreshOutlineSelection();
    updateLibCounts();
  }
  if (activeTab === 'compose') renderComposePanel();
  frameAll();
  setStatus('已移除模型' + (mesh.name ? '：' + mesh.name : ''), 'info');
}
// 修复无表情模型（如场景模型 Stage0514，morphCount=0）的 shader 编译失败：
// MMDLoader 对无 morph 的模型也会把 geometry.morphAttributes.position 设为空数组 []，
// three 0.170 据「!== undefined」定义 USE_MORPHTARGETS，却不定义 MORPHTARGETS_COUNT（count=0），
// 顶点着色器引用未声明标识符 → 编译失败 → 模型不可见。空数组不含任何变形数据，直接删除即可。
function fixEmptyMorphAttributes(root) {
  root.traverse((obj) => {
    const g = obj.geometry;
    if (!g || !g.morphAttributes) return;
    ['position', 'normal', 'color'].forEach((k) => {
      const arr = g.morphAttributes[k];
      if (arr && arr.length === 0) delete g.morphAttributes[k];
    });
  });
}
async function loadModel(node, opts = {}) {
  const asScene = !!opts.asScene;   // true = 加入场景（保留当前角色模型）；false = 替换当前角色模型
  const url = api.mmdUrl(node.path);

  // 专有二进制格式（MAX/BLEND）：仅识别分类，无法在浏览器端 3D 预览
  if (NON_PREVIEW_RE.test(node.name || '')) {
    const ext = (node.name || '').split('.').pop().toUpperCase();
    setStatus(`已识别 ${ext} 格式，但该专有二进制格式暂不支持 3D 预览`, 'warn', node.name);
    return;
  }
  // 主流通用格式（FBX/OBJ/GLB/3DS/STL/PLY/DAE）：走通用加载管线（无 IK/物理/MMD 动作）
  if (MODEL_MESH_RE.test(node.name || '') && !/\.(pmx|pmd)$/i.test(node.name)) {
    await loadGenericModel(node, url, asScene, opts);
    return;
  }

  setStatus('正在加载模型 ' + node.name + ' …');
  if (!asScene) {
    clearModel();
    currentModelPath = node.path;
  }

  // 收集同目录 VMD 动作（仅替换角色模型时刷新）
  if (!asScene) {
    const dirNode = findDirNode(currentRoot, node.path);
    vmdFiles = (dirNode ? dirNode.children : []).filter(
      (c) => c.type === 'model' && MOTION_EXTS_RE.test(c.name)
    );
  }

  try {
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, reject);
    });
    fixEmptyMorphAttributes(mesh);
    mesh.userData.path = node.path;   // 供组合面板识别「已放置模型」
    scene.add(mesh);
    // 刷新 OutlinePass 所选对象（稳定边缘 + 描边）
    refreshOutlineSelection();

    if (asScene) {
      // ====== 场景模型：加入场景，不动角色模型 ======
      const kind = opts.kind || 'scene';   // 'scene' = 场景背景；'placed' = 放置的可动模型
      // 需求1：场景模型仅能加载一个，加载新场景时先移除旧场景模型再加载
      if (kind === 'scene') removeSceneItems((s) => s.kind === 'scene');
      sceneItems.push({ mesh, node, kind });
      refreshOutlineSelection();
      if (opts.initialPosition) {
        mesh.position.set(opts.initialPosition.x, opts.initialPosition.y, opts.initialPosition.z);
      }
      if (!currentModel) {
        // 还没有角色模型时，把它当作当前模型（信息面板 / 动作列表可用）
        currentModel = mesh;
        currentMesh = mesh;
        currentModelPath = node.path;
        showModelInfo(mesh, node);
        setupVmdList(mesh);
      }
      // 组合面板放置的「可动模型」：加入 MMDAnimationHelper，使 IK/物理/动作对该模型生效，并设为当前选中目标
      if (opts.animatable) {
        if (!mmdHelper) {
          mmdHelper = new MMDAnimationHelper({ afterglow: 0.1, resetPhysicsOnLoop: true });
        }
        if (!mmdHelper.objects.has(mesh)) {
          mmdHelper.add(mesh, buildHelperOptions(mesh, { animation: undefined }));
          syncIkSolverForMesh(mesh);
          tunePhysicsForMesh(mesh);
        }
        composeTargetMesh = mesh;
        composeSelected = mesh;
        refreshOutlineSelection();
        if (mesh !== currentModel) setupVmdList(mesh);
      }
      // 场景模型加载时：默认视角定位在网格中心；小尺寸模型保持包围盒取景。
      // 放置模型（kind='placed'）不改变相机 —— 保证放置新模型后视角不跳动。
      if (kind === 'scene') {
        const b = new THREE.Box3().setFromObject(mesh);
        const sceneRadius = (() => {
          const s = b.getSize(new THREE.Vector3());
          return Math.max(s.x, s.y, s.z) / 2 || 0;
        })();
        if (sceneRadius > SCENE_LARGE_RADIUS) frameSceneAtGridCenter();
        else frameAll();
      }
      const total = sceneItems.some((s) => s.mesh === currentModel)
        ? sceneItems.length
        : sceneItems.length + (currentModel ? 1 : 0);
      updateLibCounts();
      if (activeTab === 'compose') renderComposePanel();
      setStatus(`已加入场景：${node.name}`, 'info', `场景中 ${total} 个模型 · 可开启「移动模式」拖动位置，或继续拖放模型进来`);
      return;
    }

    // ====== 角色模型：替换当前（场景模型保留） ======
    currentModel = mesh;
    currentMesh = mesh;
    // ====== 交给 MMDAnimationHelper 统一驱动（IK + 物理 + 动画） ======
    if (!mmdHelper) {
      mmdHelper = new MMDAnimationHelper({
        afterglow: 0.1,                 // 切动作 100ms 余辉
        resetPhysicsOnLoop: true,
      });
    }

    const rbCount = (mesh.userData.rigidBodies && mesh.userData.rigidBodies.length) || 0;
    const jnCount = (mesh.userData.joints && mesh.userData.joints.length) || 0;

    // 用 PARAMS 生成 physics/ik/gravity/步进配置
    const helperOpts = buildHelperOptions(mesh, {
      animation: undefined,
    });
    mmdHelper.add(mesh, helperOpts);
    // 模型加载即同步一次 ikSolver（无动画时 ikSolver 也会被 _setupMeshAnimation 创建）
    syncIkSolverForMesh(mesh);
    tunePhysicsForMesh(mesh);

    // 聚焦角色本身，避免被巨大场景模型（如舞台）的全包围盒把相机拉远导致角色不可见
    frameModel(mesh);
    showModelInfo(mesh, node);
    setupVmdList(mesh);

    const physicsOk = !!helperOpts.physics;
    const extra = `${vmdFiles.length} 个动作可用 · IK✓ · 布料${physicsOk ? `✓ (${rbCount} 刚体/${jnCount} 弹簧)` : '✗'}`;
    setStatus(`已加载：${node.name}`, 'info', extra);
  } catch (err) {
    setStatus('加载模型失败：' + (err && err.message || err), 'error');
    console.error(err);
  }
}

// ============ XXMI/3DMigoto Mod 加载 ============
// 解析 .ini + .ib（uint32 索引） + .buf（Position/Texcoord 顶点缓冲） + .dds 贴图
// 构建 Three.js BufferGeometry 并显示预览（静态 T-pose，无骨骼/物理）
const ddsLoader = new DDSLoader();

// 自定义 DDS BC7 加载器：DDSLoader 仅支持 BC1/3/5/6H，不认 BC7（DXGI_FORMAT_BC7_UNORM=99）
// 大部分原神 mod 贴图使用 BC7 压缩。现代桌面 GPU 支持 EXT_texture_compression_bptc，
// 可直接上传压缩块数据由 GPU 解压，无需 JS 端解码。
async function loadDDSTextureBC7(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  // 检查 DDS 魔数
  if (buf.byteLength < 148 || dv.getUint8(0) !== 0x44 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x20)
    return null;
  const width = dv.getUint32(16, true);
  const height = dv.getUint32(12, true);
  // fourCC at offset 84
  const fourCC = String.fromCharCode(dv.getUint8(84), dv.getUint8(85), dv.getUint8(86), dv.getUint8(87));
  if (fourCC !== 'DX10') {
    // 非 DX10 格式，退回 DDSLoader（支持 DXT1/3/5）
    return null;
  }
  const dxgiFormat = dv.getUint32(128, true);
  // 95=BC6H_UF16, 96=BC6H_SF16, 99=BC7_UNORM
  if (dxgiFormat !== 99 && dxgiFormat !== 95 && dxgiFormat !== 96) return null;

  // 检查 WebGL BPTC 扩展
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_texture_compression_bptc') || gl.getExtension('WEBGL_compressed_texture_bptc');
  if (!ext) {
    console.warn('GPU 不支持 BPTC 纹理压缩，Mod 贴图将无法显示');
    return null;
  }

  // 提取压缩块数据（跳过 128B 标准 DDS 头 + 20B DX10 头 = 148B）
  const blockData = new Uint8Array(buf, 148).slice(); // copy 成独立 ArrayBuffer，避免 view 偏移问题
  const COMPRESSED_RGBA_BPTC_UNORM_EXT = 0x8E8C;
  const mipmap = { data: blockData, width, height };
  const texture = new THREE.CompressedTexture([mipmap], width, height, COMPRESSED_RGBA_BPTC_UNORM_EXT);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // HACK: 强制 useTexStorage=false，走 compressedTexImage2D 路径（非 SubImage）
  // useTexStorage + texStorage2D + compressedTexSubImage2D 路径在 BC7 上可能静默失败（数据未真正上传）
  texture.isVideoTexture = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// PNG 纹理加载器（用于加载 CPU 解压后的 BC7 DDS → PNG）
const pngLoader = new THREE.TextureLoader();

// DDS 贴图加载：优先用 main.js CPU 解压 BC7 → PNG（绕过软件渲染器 BC7 硬解 bug），
// 失败则退回 DDSLoader（支持 DXT1/3/5 + 未压缩 RGBA）
async function loadDDSTexture(ddsPath) {
  // 1) CPU 解压 BC7 → PNG（主路径，软件渲染器 BC7 硬解不工作）
  try {
    const r = await api.decodeDdsToPng(ddsPath);
    if (r.ok && r.pngPath) {
      // 用 mmd:// 协议加载 PNG（CSP 不允许 file://，mmd:// 已注册）
      const pngUrl = api.mmdUrl(r.pngPath);
      const tex = await new Promise((resolve, reject) => {
        pngLoader.load(pngUrl, resolve, undefined, reject);
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    }
    console.warn('[Mod] decodeDdsToPng 失败，退回 DDSLoader:', r.error);
  } catch (err) { console.warn('[Mod] decodeDdsToPng 异常，退回 DDSLoader:', err); }

  // 2) 退回 DDSLoader（DXT1/3/5 + 未压缩 RGBA，走 mmd:// 协议）
  const url = api.mmdUrl(ddsPath);
  return new Promise((resolve, reject) => {
    ddsLoader.load(url, resolve, undefined, reject);
  });
}

async function loadModModel(archivePath) {
  setStatus('正在加载 Mod …');
  clearModel();
  currentModelPath = archivePath;

  const result = await api.loadModArchive(archivePath);
  if (!result.ok) {
    setStatus('Mod 加载失败：' + result.error, 'error');
    return;
  }

  const { modName, parts } = result.data;
  const group = new THREE.Group();
  group.name = modName || 'Mod';
  group.userData.path = archivePath;
  group.userData.isMod = true;

  let totalVerts = 0, totalFaces = 0, totalTex = 0;

  for (const part of parts) {
    try {
      // 通过 mmd:// 协议 fetch 二进制缓冲数据
      const [posBuf, tcBuf, ibBuf] = await Promise.all([
        fetch(api.mmdUrl(part.positionFile)).then(r => r.arrayBuffer()),
        fetch(api.mmdUrl(part.texcoordFile)).then(r => r.arrayBuffer()),
        fetch(api.mmdUrl(part.indexFile)).then(r => r.arrayBuffer()),
      ]);

      const posStride = part.positionStride;
      const tcStride = part.texcoordStride;
      const vertCount = Math.floor(posBuf.byteLength / posStride);

      // Position: float3 at offset 0; Normal: float3 at offset 12
      const positions = new Float32Array(vertCount * 3);
      const normals = new Float32Array(vertCount * 3);
      const posView = new DataView(posBuf);
      for (let i = 0; i < vertCount; i++) {
        const off = i * posStride;
        positions[i*3]   = posView.getFloat32(off, true);
        positions[i*3+1] = posView.getFloat32(off+4, true);
        positions[i*3+2] = posView.getFloat32(off+8, true);
        if (off + 24 <= posBuf.byteLength) {
          normals[i*3]   = posView.getFloat32(off+12, true);
          normals[i*3+1] = posView.getFloat32(off+16, true);
          normals[i*3+2] = posView.getFloat32(off+20, true);
        }
      }

      // Texcoord: uint32 metadata(4B) + float32 U(4B) + float32 V(4B) + padding(8B) + 第二组UV(可选)
      // 3DMigoto 标准 UV 顺序为 (U, V)：offset 4 = U, offset 8 = V
      // PNG 纹理经 TextureLoader 加载（flipY=true），V=0 在底部；游戏 UV（D3D）V=0 在顶部 → 需翻转 V
      const uvs = new Float32Array(vertCount * 2);
      const tcView = new DataView(tcBuf);
      for (let i = 0; i < vertCount; i++) {
        const off = i * tcStride;
        uvs[i*2]   = tcView.getFloat32(off+4, true);       // U
        uvs[i*2+1] = 1.0 - tcView.getFloat32(off+8, true); // V（翻转：D3D 顶部 origin → WebGL 底部 origin）
      }

      // Index buffer: uint32 indices
      const idxCount = Math.floor(ibBuf.byteLength / 4);
      const indices = new Uint32Array(ibBuf, 0, idxCount);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();

      totalVerts += vertCount;
      totalFaces += Math.floor(idxCount / 3);

      // DDS 贴图：CPU 解压 BC7 → PNG（绕过软件渲染器 BC7 硬解 bug）
      let material;
      if (part.diffuseTexture) {
        totalTex++;
        const texture = await loadDDSTexture(part.diffuseTexture);
        if (texture) {
          // MeshLambertMaterial 漫反射：有基础光影且颜色比 PBR 更接近纹理原色
          // transparent=false：游戏 Diffuse 的 alpha 通道不是透明度（多为 specular mask），强制不透明
          material = new THREE.MeshLambertMaterial({
            map: texture,
            side: THREE.DoubleSide,
            transparent: false,
          });
        } else {
          // 贴图加载失败：品红色标识
          material = new THREE.MeshBasicMaterial({
            color: 0xFF00FF,
            side: THREE.DoubleSide,
          });
        }
      } else {
        material = new THREE.MeshLambertMaterial({
          color: 0x888888,
          side: THREE.DoubleSide,
        });
      }

      const mesh = new THREE.Mesh(geo, material);
      mesh.name = part.name;
      group.add(mesh);
    } catch (err) {
      console.error('Mod 部件加载失败:', part.name, err);
    }
  }

  if (group.children.length === 0) {
    setStatus('Mod 加载失败：没有成功构建任何网格部件', 'error');
    return;
  }

  // 居中并落地
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y -= box.min.y;
  group.updateMatrixWorld(true);

  scene.add(group);
  currentModel = group;
  currentMesh = group;

  refreshOutlineSelection();
  frameModel(group);
  showModelInfo(group, { name: modName + ' (Mod)', path: archivePath });

  setStatus(`已加载 Mod：${modName}（${parts.length} 部件 · ${totalVerts} 顶点 · ${Math.floor(totalFaces)} 面 · ${totalTex} 贴图）`, 'info');
}
// 按格式解析主流通用 3D 文件为模型根对象（不加入场景）：FBX / OBJ(+MTL) / GLB / GLTF / 3DS / STL / PLY / DAE
function parseGenericRoot(url, name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  switch (ext) {
    case 'glb':
    case 'gltf': {
      return new Promise((resolve, reject) => {
        new GLTFLoader().load(url, (gltf) => resolve(gltf.scene || gltf), undefined, reject);
      });
    }
    case 'obj': {
      // 尝试加载同名 MTL（贴图/材质），失败则回退为无材质 OBJ
      const mtlUrl = base + name.replace(/\.obj$/i, '') + '.mtl';
      return Promise.resolve().then(() =>
        new Promise((resolve, reject) => {
          new MTLLoader().setResourcePath(base).load(mtlUrl, resolve, undefined, reject);
        })
      ).then((mtl) => {
        const objLoader = new OBJLoader();
        if (mtl && mtl.materials) {
          mtl.preload();
          objLoader.setMaterials(mtl);
        }
        return new Promise((resolve, reject) => {
          objLoader.load(url, resolve, undefined, reject);
        });
      }).catch(() => new Promise((resolve, reject) => {
        new OBJLoader().load(url, resolve, undefined, reject);
      }));
    }
    case 'fbx': {
      return new Promise((resolve, reject) => {
        new FBXLoader().setResourcePath(base).load(url, resolve, undefined, reject);
      });
    }
    case '3ds': {
      return new Promise((resolve, reject) => {
        new TDSLoader().setResourcePath(base).load(url, resolve, undefined, reject);
      });
    }
    case 'dae': {
      return new Promise((resolve, reject) => {
        // 注意：不能 setPath(base) —— ColladaLoader 内部会用 this.path 作为 FileLoader 前缀拼到完整 URL 上导致双重路径
        new ColladaLoader().setResourcePath(base).load(url, (c) => resolve(c.scene), undefined, reject);
      });
    }
    case 'stl':
    case 'ply': {
      return new Promise((resolve, reject) => {
        const Loader = ext === 'stl' ? STLLoader : PLYLoader;
        new Loader().load(url, (g) => {
          if (g) {
            if (!g.attributes.normal || !g.attributes.normal.count) g.computeVertexNormals();
            // 无材质几何体：包一层标准材质网格，保证在 PBR 环境下可见
            resolve(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide })));
          } else resolve(null);
        }, undefined, reject);
      });
    }
    default:
      return Promise.reject(new Error('暂不支持预览该格式：' + name));
  }
}

// 通用 3D 格式加载：与 MMD 管线不同，无骨骼 IK / 物理 / VMD 动作，仅静态预览（GLB/FBX 内置动画不驱动）
function loadGenericModel(node, url, asScene, opts = {}) {
  const name = node.name || '';
  const ext = name.split('.').pop().toLowerCase();
  if (!asScene) {
    clearModel();
    currentModelPath = node.path;
  }
  setStatus('正在加载模型 ' + name + ' …');
  return parseGenericRoot(url, name).then((root) => {
    if (!root) throw new Error('加载器未返回模型数据');
    root.name = name;
    root.userData.path = node.path;
    scene.add(root);
    refreshOutlineSelection();

    if (asScene) {
      // ====== 场景模型：加入场景，不动角色模型 ======
      const kind = opts.kind || 'scene';
      if (kind === 'scene') removeSceneItems((s) => s.kind === 'scene');
      sceneItems.push({ mesh: root, node, kind });
      if (opts.initialPosition) {
        root.position.set(opts.initialPosition.x, opts.initialPosition.y, opts.initialPosition.z);
      }
      if (!currentModel) {
        currentModel = root;
        currentMesh = root;
        currentModelPath = node.path;
        showModelInfo(root, node);
      }
      if (kind === 'scene') {
        const b = new THREE.Box3().setFromObject(root);
        const s = b.getSize(new THREE.Vector3());
        if (Math.max(s.x, s.y, s.z) / 2 > SCENE_LARGE_RADIUS) frameSceneAtGridCenter();
        else frameAll();
      }
      const total = sceneItems.some((s) => s.mesh === currentModel)
        ? sceneItems.length
        : sceneItems.length + (currentModel ? 1 : 0);
      updateLibCounts();
      if (activeTab === 'compose') renderComposePanel();
      setStatus(`已加入场景：${node.name}`, 'info', `场景中 ${total} 个模型`);
      return;
    }

    // ====== 角色模型：替换当前（场景模型保留） ======
    currentModel = root;
    currentMesh = root;
    frameModel(root);
    showModelInfo(root, node);
    setStatus(`已加载：${node.name}`, 'info', `${ext.toUpperCase()} 格式 · 静态预览（无 IK/物理/MMD 动作）`);
  }).catch((err) => {
    setStatus('加载模型失败：' + (err && err.message || err), 'error');
    console.error(err);
  });
}

function findDirNode(rootNode, filePath) {
  if (!rootNode) return null;
  const parentPath = filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  let result = null;
  (function walk(n) {
    if (result) return;
    if (n.type === 'dir' && (n.path || '').replace(/\\/g, '/') === parentPath) { result = n; return; }
    (n.children || []).forEach(walk);
  })(rootNode);
  return result;
}
function frameModel(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const targetY = center.y;
  const dist = radius * 2.6 + 2;
  camera.position.set(dist * 0.7, targetY + radius * 0.8, dist);
  controls.target.set(0, targetY, 0);
  controls.update();
}
// 取景：包含当前角色模型 + 所有场景模型（保证场景与模型同时可见）
function frameAll() {
  const targets = [];
  if (currentModel) targets.push(currentModel);
  (sceneItems || []).forEach((s) => { if (s && s.mesh) targets.push(s.mesh); });
  if (!targets.length) return;
  const box = new THREE.Box3();
  targets.forEach((t) => box.expandByObject(t));
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const dist = radius * 2.6 + 2;
  camera.position.set(dist * 0.7, center.y + radius * 0.8, dist);
  controls.target.set(center.x, center.y, center.z);
  controls.update();
}
// 大面积模型（场景/舞台等）默认视角：对准网格中心（世界原点地面）。
// 相机贴近地面（高度≈0）、距离限制在包围盒内部 → 默认视角处于场景模型内部，水平看向网格中心。
const SCENE_LARGE_RADIUS = 10; // 网格半宽 10（GridHelper 20x20），超过即视为大面积
function frameSceneAtGridCenter() {
  const targets = [];
  if (currentModel) targets.push(currentModel);
  (sceneItems || []).forEach((s) => { if (s && s.mesh) targets.push(s.mesh); });
  if (!targets.length) return;
  const box = new THREE.Box3();
  targets.forEach((t) => box.expandByObject(t));
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  // 相机到中心的最大距离取「整体可见距离」与「包围盒内部距离」的较小值，
  // 并压低相机高度到地面（y≈0），保证默认视角处于场景模型内部而非外部俯瞰
  const dist = Math.min(radius * 2.6 + 2, radius * 0.7);
  camera.position.set(dist * 0.7, 0.5, dist);
  controls.target.set(0, 0, 0);
  controls.update();
}
function showModelInfo(mesh, node) {
  let verts = 0, faces = 0, textures = 0;
  const texNames = new Set();
  mesh.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const g = child.geometry;
      if (g.attributes.position) verts += g.attributes.position.count;
      if (g.index) faces += g.index.count / 3;
      else if (g.attributes.position) faces += g.attributes.position.count / 3;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m) return;
        ['map', 'normalMap', 'specularMap', 'emissiveMap', 'alphaMap'].forEach((k) => {
          const t = m[k];
          if (t && t.image && t.image.src) { textures++; texNames.add(decodeURIComponent(t.image.src.split('/').pop())); }
        });
      });
    }
  });
  modelInfoEl.innerHTML = `
    <div class="section">文件</div>
    <div class="kv"><div class="k">名称</div><div class="v">${escapeHtml(node.name)}</div></div>
    <div class="kv"><div class="k">大小</div><div class="v">${fmtSize(node.size)}</div></div>
    <div class="section">模型</div>
    <div class="kv"><div class="k">顶点</div><div class="v">${verts.toLocaleString()}</div></div>
    <div class="kv"><div class="k">面数</div><div class="v">${Math.round(faces).toLocaleString()}</div></div>
    <div class="kv"><div class="k">贴图</div><div class="v">${textures} 张</div></div>
    <div class="section">贴图列表</div>
    <div class="tex-list">${[...texNames].map((t) => escapeHtml(t)).join('<br>') || '无'}</div>`;
}

// ---------- VMD 动作 ----------
// 用户手动收起动画面板的状态：true 表示用户点过「—」收起；后续 setupVmdList 不会自动展开面板
// 但会显示迷你 tab，用户点击即可展开
let animPanelUserCollapsed = false;
function setAnimPanelVisible(visible, { userInitiated = false, hasMotionsHint = null } = {}) {
  const miniTab = $('anim-mini-tab');
  if (!animPanel || !miniTab) return;
  // hasMotionsHint = true 表示「当前有可用动作」；false 表示没动作；null 则按 DOM 状态判定
  const hasMotions = (hasMotionsHint === null)
    ? (!!vmdListEl && vmdListEl.querySelectorAll('.vmd-item').length > 0)
    : !!hasMotionsHint;
  if (visible) {
    animPanel.classList.remove('hidden');
    miniTab.classList.add('hidden');
    if (userInitiated) animPanelUserCollapsed = false;
  } else {
    animPanel.classList.add('hidden');
    // 仅在有可用动作时才显示迷你 tab（没有动作时直接隐藏，免得误导）
    if (hasMotions || userInitiated) miniTab.classList.remove('hidden');
    else miniTab.classList.add('hidden');
    if (userInitiated) animPanelUserCollapsed = true;
  }
}
function setupVmdList(mesh) {
  vmdListEl.innerHTML = '';
  const allVmd = [];
  // 仅当前 mesh 对应的模型路径（或当前角色）才算「同目录 VMD」；
  // 拖放的场景背景/放置模型，不给它找同目录 VMD（避免场景切换误显示动画面板）
  const isCurrentRole = (!mesh) || (mesh === currentModel) || (mesh === currentMesh);
  if (isCurrentRole) {
    vmdFiles.forEach((v) => allVmd.push({ ...v, from: '同目录' }));
  }
  motionRootItems.forEach((v) => {
    if (!allVmd.find((a) => isSamePath(a.path, v.path))) allVmd.push({ ...v, from: '动作库' });
  });

  if (!allVmd.length) {
    // 无动作：面板+迷你tab 都隐藏，清除用户手动收起状态（下次扫到动作时正常展开）
    animPanelUserCollapsed = false;
    setAnimPanelVisible(false, { hasMotionsHint: false });
    return;
  }
  allVmd.forEach((v) => {
    const el = document.createElement('div');
    el.className = 'vmd-item';
    el.innerHTML = `<span>${v.from === '动作库' ? '🎬' : '📁'}</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(v.name)}</span>
      <span class="vmd-badge">${v.from}</span>`;
    el.title = v.path;
    el.addEventListener('click', () => playVmd(v, mesh, el));
    vmdListEl.appendChild(el);
  });
  // 有动作：用户没有主动收起 → 展开面板；用户主动收起 → 显示迷你 tab
  if (animPanelUserCollapsed) setAnimPanelVisible(false, { hasMotionsHint: true });
  else setAnimPanelVisible(true, { hasMotionsHint: true });
}
// 绑定收起按钮 / 迷你 tab 展开
(function bindAnimPanelCollapse() {
  const collapseBtn = $('btn-anim-collapse');
  const miniTab = $('anim-mini-tab');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => setAnimPanelVisible(false, { userInitiated: true }));
  }
  if (miniTab) {
    miniTab.addEventListener('click', () => setAnimPanelVisible(true, { userInitiated: true }));
  }
})();
async function playVmd(vmdNode, mesh, el) {
  const url = api.mmdUrl(vmdNode.path);
  setStatus('加载动作 ' + vmdNode.name + ' …');
  try {
    const clip = await new Promise((resolve, reject) => {
      mmdLoader.loadAnimation(url, mesh, resolve, undefined, reject);
    });
    // r4：记录该模型当前附加的动作，组合面板已加载列表直观显示
    if (mesh) {
      mesh.userData = mesh.userData || {};
      mesh.userData.activeMotion = vmdNode.name || '';
    }

    // MMDAnimationHelper 没有公开的 animate(mesh, clip) 方法；
    // 切换动画的正确方式是调用内部 _setupMeshAnimation（会重建 mixer + ikSolver + grantSolver，
    // 物理保持不变）。如果 mesh 还没 add 进 helper，兜底走 add。
    if (mmdHelper && mesh && mmdHelper.objects && mmdHelper.objects.has(mesh)) {
      mmdHelper._setupMeshAnimation(mesh, clip);
      syncIkSolverForMesh(mesh);
      // 同步 loopAnimation 参数（新建 mixer 后会重置 loop 模式）
      (function syncLoopAfterSetup() {
        if (!mmdHelper || !mmdHelper.objects || !mmdHelper.objects.has(mesh)) return;
        const obj = mmdHelper.objects.get(mesh);
        const mixer = obj && obj.mixer;
        if (!mixer || !mixer._actions || !mixer._actions.length) return;
        const mode = !!getParam('anim', 'loopAnimation', true) ? THREE.LoopRepeat : THREE.LoopOnce;
        mixer._actions.forEach((act) => { if (act) act.loop = mode; });
      })();
    } else if (mmdHelper) {
      // 兜底（先 add 再 setup）
      const opts = buildHelperOptions(mesh, { animation: clip });
      mmdHelper.add(mesh, opts);
      syncIkSolverForMesh(mesh);
      tunePhysicsForMesh(mesh);
    }
    currentAnimating = true;

    vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
    el && el.classList.add('active');
    showPreviewCardForNode({ path: vmdNode.path, name: vmdNode.name, size: vmdNode.size, type: 'model' }, true);
    setStatus(`播放动作：${vmdNode.name}`, 'info', `时长 ${clip.duration.toFixed(2)}s · ${clip.tracks.length} 条轨道 · IK+物理驱动`);
    if (activeTab === 'compose') renderComposeModelList();
  } catch (err) {
    setStatus('加载动作失败：' + (err && err.message || err), 'error');
  }
}

// ---------- 动作库 ----------
function renderMotionList() {
  const kw = motionFilterKw.trim().toLowerCase();
  const items = motionRootItems.filter((n) => !kw || (n.name || '').toLowerCase().includes(kw));
  if (!items.length) {
    motionListEl.innerHTML = `<div class="placeholder">${motionFilterKw ? '没有匹配的动作文件' : '动作目录为空（已缓存的动作请到「缓存资源」面板查看）'}</div>`;
    return;
  }
  motionListEl.innerHTML = '';
  items.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'motion-item';
    el.dataset.path = (n.path || '').replace(/\\/g, '/');
    const isVmd = /\.vmd$/i.test(n.name);
    el.innerHTML = `
      <div class="mi-icon">${isVmd ? '🎞️' : '📸'}</div>
      <div class="mi-body">
        <div class="mi-name">${escapeHtml(n.name)}</div>
        <div class="mi-meta">
          <span>${fmtSize(n.size)}</span>
          <span class="chip">${isVmd ? 'VMD 动作' : 'VPD 姿势'}</span>
          ${currentModel && currentMesh ? '<span class="chip warn">可应用</span>' : ''}
        </div>
      </div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.motion-item.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      if (currentModel && currentMesh) {
        playVmd(n, currentMesh, null);
      } else {
        showPreviewCardForNode({ path: n.path, name: n.name, size: n.size, type: 'model' }, true);
        setStatus('请先加载一个 PMX/PMD 模型，再应用此动作', 'warn', n.name);
      }
    });
    el.addEventListener('mouseenter', () => showPreviewCardForNode({ path: n.path, name: n.name, size: n.size, type: 'model' }));
    el.addEventListener('mouseleave', hidePreviewCard);
    motionListEl.appendChild(el);
  });
}

// ---------- Mod 库列表渲染 ----------
function collectArchivesInTree(rootNode) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'archive' || ARCHIVE_RE.test(n.name || '')) out.push(n);
    (n.children || []).forEach(walk);
  })(rootNode);
  return out;
}

async function renderModList() {
  if (!currentRoot) {
    modListEl.innerHTML = '<div class="placeholder">请先设置根目录</div>';
    return;
  }
  // 首次或根目录变化时扫描 mod 压缩包（含 .ini 的），排除非 mod 文件
  if (!modArchivesCache) {
    modListEl.innerHTML = '<div class="placeholder">扫描 Mod 压缩包中…</div>';
    const rootPath = (currentRoot && currentRoot.path) ? currentRoot.path : '';
    const r = await api.scanModArchives(rootPath);
    modArchivesCache = (r && r.ok && Array.isArray(r.data)) ? r.data : [];
  }
  modRootItems = modArchivesCache;
  const kw = modFilterKw.trim().toLowerCase();
  const items = modArchivesCache.filter((n) => !kw || (n.name || '').toLowerCase().includes(kw));
  if (!items.length) {
    modListEl.innerHTML = `<div class="placeholder">${modFilterKw ? '没有匹配的 Mod 文件' : '根目录下没有 Mod 压缩包（需含 .ini 描述符）'}</div>`;
    return;
  }
  const hasModel = !!(currentModel && currentMesh);
  let html = '';
  if (hasModel) {
    html += `<div class="placeholder" style="padding:6px 8px">当前模型：${escapeHtml(currentModel.name || '')}</div>`;
  } else {
    html += `<div class="placeholder" style="padding:6px 8px">💡 建议先加载模型，再选择 Mod 装载</div>`;
  }
  modListEl.innerHTML = html;
  items.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'motion-item';
    el.dataset.path = (n.path || '').replace(/\\/g, '/');
    el.innerHTML = `
      <div class="mi-icon">📦</div>
      <div class="mi-body">
        <div class="mi-name">${escapeHtml(n.name)}</div>
        <div class="mi-meta">
          <span>${fmtSize(n.size)}</span>
          <span class="chip">Mod 压缩包</span>
        </div>
      </div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.motion-item.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      loadModModel(n.path);
    });
    modListEl.appendChild(el);
  });
  // 更新 Mod 库计数
  const lmc = $('lib-mods-count');
  if (lmc) lmc.textContent = modArchivesCache.length + ' 项';
}

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
// 缓存帧计时 + 动画固定步长，避免「tab 切出再切回」的巨大 delta、以及设备刷新率差异造成的物理抖动
const FPS_TARGET = 60;
const FIXED_DT = 1 / FPS_TARGET;          // 16.67ms：MMD 动画/物理的固定步长
let _accumulator = 0;                     // 累积时间：用于多步物理/动画更新追赶
let _cachedPixelRatio = 1;                // 缓存 pixelRatio，避免每帧 getPixelRatio() 读 CSSOM
let _cachedViewport = { w: 0, h: 0 };     // 缓存视口尺寸，resize() 改变后才同步到后处理
// 动画帧内可复用临时向量（避免 GC 暂停造成的 1-3ms 顿挫）
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _tmpVecC = new THREE.Vector3();
const _tmpColA = new THREE.Color();
const _tmpMat4A = new THREE.Matrix4();
// ---------- FPS 监控（窗口右上角）：EMA 平滑 + 500ms 刷新 + 颜色分级 ----------
let _fpsLastTs = performance.now();
let _fpsFrames = 0;
let _fpsEma = 0;
function _fpsTick() {
  const now = performance.now();
  const dt = (now - _fpsLastTs) / 1000;
  if (dt <= 0) return;
  const inst = _fpsFrames / dt;
  _fpsEma = _fpsEma === 0 ? inst : _fpsEma * 0.6 + inst * 0.4;
  _fpsLastTs = now; _fpsFrames = 0;
  const el = document.getElementById('fps-monitor');
  if (el) {
    const v = _fpsEma;
    let cls = 'fps-good';
    if (v < 30) cls = 'fps-bad';
    else if (v < 45) cls = 'fps-warn';
    el.className = 'fps-monitor ' + cls;
    el.textContent = `${v.toFixed(0)} FPS`;
    el.title = `EMA FPS: ${v.toFixed(1)}  平滑系数:0.6`;
  }
}
setInterval(_fpsTick, 500);
// CHIP 低频同步：避免预设切换后 chip 显示延迟
setInterval(() => { try { updateRqpChip(); } catch (_) {} }, 1200);

function animate() {
  requestAnimationFrame(animate);
  _fpsFrames += 1;
  window.__renderFrames = (window.__renderFrames || 0) + 1;
  // 第 10 帧后再构建 PMREM 环境贴图：确保 WebGL 上下文、canvas 绑定、后处理管线均已就绪
  if (window.__renderFrames === 10) {
    try { buildEnvFromSky(); } catch (_) {}
    // 首次渲染同步：缓存 pixelRatio + 视口尺寸，保证后续后处理分辨率不再每帧从 DOM 读
    try {
      _cachedPixelRatio = renderer.getPixelRatio();
      const vp = document.getElementById('viewport');
      const w = vp ? vp.clientWidth : canvas.clientWidth;
      const h = vp ? vp.clientHeight : canvas.clientHeight;
      _cachedViewport.w = w; _cachedViewport.h = h;
    } catch (_) {}
  }

  // ---- 1) 稳定 delta：getDelta() 过大（tab 切换后台）时裁剪 ----
  let rawDelta = clock.getDelta();
  if (rawDelta <= 0) rawDelta = FIXED_DT;
  // tab 隐藏/切换回来时 getDelta() 可能 = 2~30s，强行压到 2 帧步长避免物理世界爆炸 + 动画整段跳帧
  if (rawDelta > FIXED_DT * 3) rawDelta = FIXED_DT * 2;
  const speed = parseFloat(speedRange.value || '1') || 1;
  const animScale = currentAnimating ? speed : 0;  // 无动作：动画(骨骼)更新=0，但物理惯性保持自然 dt
  // 物理 dt 永远带真实 dt（但有上限），保证布料在无动作时也能自然摆动/下垂
  const physRawDelta = (rawDelta > FIXED_DT * 2) ? FIXED_DT * 2 : rawDelta;

  // ---- 2) 固定步长累积 + 追赶：消除物理大步长造成的 jank ----
  _accumulator += physRawDelta;
  // 最多追赶 5 次（~83ms），避免后台挂起后前台瞬间卡顿
  const MAX_SUB_STEPS = 5;
  let subSteps = 0;
  while (_accumulator >= FIXED_DT && subSteps < MAX_SUB_STEPS) {
    _accumulator -= FIXED_DT;
    subSteps += 1;
    if (mmdHelper) {
      try {
        // helper.update(dt) 既更新 mixer(骨骼) 又更新 physics(布料/IK)
        // 混合：动画（骨骼）速度由 animScale 驱动，物理按 FIXED_DT 自然前进
        // 但是 MMDHelper 的 update() 内部 physics.step 接受固定 dt，骨骼动画接受我们传入的 dt
        // 此处做折中：用 FIXED_DT * animScale 驱动动画 + 物理整体 update；
        // 物理会跟随骨骼新位置 step，避免 substep 内动画速度过快导致物理被甩飞
        const dtMix = FIXED_DT * animScale;
        mmdHelper.update(dtMix);
      } catch (err) {
        console.warn('[MMDAnimationHelper.update] caught:', err && err.message);
      }
    }
  }
  // 追赶次数过多时直接丢弃累积，避免极端情况下一直追赶无法释放 CPU
  if (subSteps === MAX_SUB_STEPS && _accumulator > FIXED_DT * 2) {
    _accumulator = 0;
  }

  if (mmdHelper) {
    // ===== 拖拽后暖启动：前 N 帧对处于「待冷却」状态的 physics 每帧清零速度 =====
    // 避免 physics.reset() 后的约束回弹使布料剧烈抖动
    try {
      const warm = window.__physicsWarmFrames;
      if (warm && warm.size > 0 && mmdHelper.objects) {
        for (const [mesh, remain] of warm.entries()) {
          if (!mesh || !mmdHelper.objects.has(mesh)) { warm.delete(mesh); continue; }
          const obj = mmdHelper.objects.get(mesh);
          const p = obj && obj.physics;
          if (p && p.bodies && p.manager && p.manager.allocVector3) {
            const zero = p.manager.allocVector3();
            zero.setValue(0, 0, 0);
            for (const rb of p.bodies) {
              if (!rb || !rb.body) continue;
              try { rb.body.setLinearVelocity(zero); } catch (_) {}
              try { rb.body.setAngularVelocity(zero); } catch (_) {}
            }
            p.manager.freeVector3(zero);
          }
          const next = remain - 1;
          if (next <= 0) warm.delete(mesh);
          else warm.set(mesh, next);
        }
      }
    } catch (_) { /* noop */ }
  }

  // ---- 3) 控制器 & 渲染 ----
  controls.update();
  // composer.render(delta)：EffectComposer.render(delta) 只传给 shader 的 time uniform，我们给零即可（不改变现有行为）
  if (window.__postfx && window.__postfx.composer) {
    window.__postfx.composer.render(0);
  } else {
    renderer.render(scene, camera);
  }
}
animate();

// ---------- 窗口尺寸 ----------
let _resizeRaf = 0;
function _resizeNow() {
  _resizeRaf = 0;
  // 以容器尺寸为基准：renderer.setSize 会把 canvas 写成固定 px 内联宽，
  // 若以 canvas.clientWidth 为基准，拖拽侧栏/折叠/窗口缩放后读到的会是陈旧值，画布不更新
  const vp = document.getElementById('viewport');
  const w = vp ? vp.clientWidth : canvas.clientWidth;
  const h = vp ? vp.clientHeight : canvas.clientHeight;
  if (w === 0 || h === 0) return;
  // 尺寸没变就不重设（setSize 会触发 gl.canvas.width/height 重分配 + FBO 重建，代价很大）
  if (_cachedViewport && _cachedViewport.w === w && _cachedViewport.h === h) return;
  _cachedViewport.w = w; _cachedViewport.h = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  _cachedPixelRatio = renderer.getPixelRatio();
  if (window.__postfx && window.__postfx.composer) {
    window.__postfx.composer.setSize(w, h);
    const pr = _cachedPixelRatio;
    if (window.__postfx.fxaaPass) {
      const u = window.__postfx.fxaaPass.uniforms && window.__postfx.fxaaPass.uniforms['resolution'];
      if (u && u.value) u.value.set(1 / (w * pr), 1 / (h * pr));
    }
    if (window.__postfx.contactShadowsPass && window.__postfx.contactShadowsPass.uniforms) {
      const u = window.__postfx.contactShadowsPass.uniforms.resolution;
      if (u && u.value) u.value.set(Math.max(1, w * pr), Math.max(1, h * pr));
      const uf = window.__postfx.contactShadowsPass.uniforms.cameraFar;
      if (uf) uf.value = camera.far;
      const un = window.__postfx.contactShadowsPass.uniforms.cameraNear;
      if (un) un.value = camera.near;
    }
    if (window.__postfx.outlinePass) {
      window.__postfx.outlinePass.resolution.set(w, h);
    }
    // ---- 新后处理段的分辨率同步：避免 setSize 后 FBO 与 canvas 比例错配 ----
    if (window.__postfx.saoPass && typeof window.__postfx.saoPass.setSize === 'function') {
      try { window.__postfx.saoPass.setSize(w, h); } catch (_) {}
    }
    if (window.__postfx.ssgiPass && typeof window.__postfx.ssgiPass.setSize === 'function') {
      try { window.__postfx.ssgiPass.setSize(w, h); } catch (_) {}
    }
    if (window.__postfx.ssaoPass && typeof window.__postfx.ssaoPass.setSize === 'function') {
      try { window.__postfx.ssaoPass.setSize(w, h); } catch (_) {}
    }
    if (window.__postfx.godRayPass && window.__postfx.godRayPass.uniforms) {
      const u = window.__postfx.godRayPass.uniforms.resolution;
      if (u && u.value) u.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
    }
    if (window.__postfx.lensFlarePass && window.__postfx.lensFlarePass.uniforms) {
      const u = window.__postfx.lensFlarePass.uniforms.resolution;
      if (u && u.value) u.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
    }
    if (window.__postfx.colorBalancePass && window.__postfx.colorBalancePass.uniforms) {
      const u = window.__postfx.colorBalancePass.uniforms.resolution;
      if (u && u.value) u.value.set(1 / Math.max(1, w * pr), 1 / Math.max(1, h * pr));
    }
    if (window.__postfx.bloomPass && typeof window.__postfx.bloomPass.setSize === 'function') {
      try { window.__postfx.bloomPass.setSize(w, h); } catch (_) {}
    }
  }
}
function resize() {
  if (_resizeRaf) return;
  _resizeRaf = requestAnimationFrame(_resizeNow);
}
window.addEventListener('resize', resize);
resize();

// ---------- 场景摆放：拖放模型到视口 + 移动模式拖动 ----------
const viewHintEl = $('view-hint');
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _raycaster = new THREE.Raycaster();
const _reuseNDC = new THREE.Vector2();
const _reuseHitA = new THREE.Vector3();
const _reuseHitB = new THREE.Vector3();
const _reuseHitC = new THREE.Vector3();
const _reuseRect = { left: 0, top: 0, width: 1, height: 1 };
let _cachedCanvasRectTime = 0;
function pointerNDC(e) {
  // getBoundingClientRect 每帧会触发 reflow，低频缓存（60ms 内复用）
  const now = performance.now();
  if (now - _cachedCanvasRectTime > 60) {
    const r = canvas.getBoundingClientRect();
    _reuseRect.left = r.left; _reuseRect.top = r.top; _reuseRect.width = r.width; _reuseRect.height = r.height;
    _cachedCanvasRectTime = now;
  }
  const { left, top, width, height } = _reuseRect;
  return _reuseNDC.set(
    ((e.clientX - left) / width) * 2 - 1,
    -((e.clientY - top) / height) * 2 + 1
  );
}
function groundPointFromEvent(e) {
  if (!e) return null;
  _raycaster.setFromCamera(pointerNDC(e), camera);
  if (_raycaster.ray.intersectPlane(GROUND_PLANE, _reuseHitA)) return _reuseHitA.clone();
  return null;
}
// 拖放：左侧树 / 缓存列表的模型行 → 拖到 3D 视口，在指定位置加入场景（场景与角色同时预览）
canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  const raw = e.dataTransfer.getData('application/x-mmd-model');
  if (!raw) return;
  let info;
  try { info = JSON.parse(raw); } catch (_) { return; }
  const pt = groundPointFromEvent(e);
  const pos = pt ? { x: pt.x, y: pt.y, z: pt.z } : null;
  setStatus('拖放模型到场景：' + info.name + ' …', 'info');
  addRecent(info.path, info.name, 'model', info.size);
  loadModel({ path: info.path, name: info.name, size: info.size }, { asScene: true, initialPosition: pos, kind: 'placed', animatable: true });
});

// 移动模式：开启后在视口内按住左键拖动模型到任意位置
// - 仅能移动「选中模型」：组合面板选中的模型优先，未选中时回退到当前角色模型（非组合单个模型也可移动）
// - 仅支持鼠标拖拽，沿地面平面自由移动（X/Z），Y 保持不动
let moveModeActive = false;
let dragState = null; // { mesh, grabOffset, startY, _savedPhysics }
function moveModeTarget() {
  if (composeSelected) return composeSelected;
  if (currentMesh) return currentMesh;
  return null;
}
function endDrag() {
  dragState = null;
  canvas.style.cursor = moveModeActive ? 'grab' : '';
}
// 拖拽结束后恢复该模型物理：先把所有刚体变换重置到当前骨骼位置并清空速度，
// 再恢复每帧更新，避免 dynamic 刚体（布料/裙摆）停留在旧位置被约束拉扯产生剧烈抖动
function restoreDragPhysics() {
  if (!dragState || !dragState._savedPhysics) return;
  const h = mmdHelper && mmdHelper.objects && mmdHelper.objects.get(dragState.mesh);
  if (!h) return;
  try {
    h.physics = dragState._savedPhysics;
    const p = h.physics;
    // pointerup 事件发生在渲染循环之外，骨骼 matrixWorld 仍是上一帧的旧位置。
    // 必须先刷新，否则 reset() 会把刚体复位到错误位置，持续错位导致抖动。
    if (dragState.mesh && dragState.mesh.updateMatrixWorld) dragState.mesh.updateMatrixWorld(true);
    p.reset();
    if (p.bodies && p.manager && p.manager.allocVector3) {
      const zero = p.manager.allocVector3();
      zero.setValue(0, 0, 0);
      for (const rb of p.bodies) {
        if (!rb.body) continue;
        rb.body.activate(true);
        rb.body.setLinearVelocity(zero);
        rb.body.setAngularVelocity(zero);
      }
      p.manager.freeVector3(zero);
    }
    // 阻尼 + 阈值：恢复后再次主动应用，保证拖拽后的布料不产生持续振荡
    tunePhysicsForMesh(dragState.mesh, { forceApplyDamping: true });
    // 登记暖启动：animate() 后续 8 帧继续每帧清零速度，消除约束回弹引起的剧烈抖动
    if (!window.__physicsWarmFrames) window.__physicsWarmFrames = new Map();
    window.__physicsWarmFrames.set(dragState.mesh, 8);
  } catch (_) { /* 无物理的模型忽略 */ }
}
function setMoveMode(on) {
  moveModeActive = on;
  const btn = $('btn-move-mode');
  if (btn) btn.classList.toggle('active', on);
  controls.enabled = !on;
  if (viewHintEl) {
    viewHintEl.textContent = on
      ? '移动模式：按住左键拖动选中模型 · 再次点击关闭'
      : '左键旋转 · 右键平移 · 滚轮缩放 · 双击模型重置视角 · 可将左侧模型拖入场景';
  }
  canvas.style.cursor = on ? 'grab' : '';
  if (!on) endDrag();
}
$('btn-move-mode').addEventListener('click', () => setMoveMode(!moveModeActive));
$('btn-clear-scene').addEventListener('click', () => {
  if (!sceneItems.length) { setStatus('场景中暂无场景模型', 'warn'); return; }
  clearSceneModels();
  setStatus('已清空场景模型', 'info', currentModel ? '当前角色模型保留' : '');
});
canvas.addEventListener('pointerdown', (e) => {
  if (!moveModeActive) return;
  if (e.button !== 0) return;
  // Bug 修复：仅允许拖动「选中模型」，防止误触其他模型导致其位置被改动
  const target = moveModeTarget();
  if (!target) return;
  const ndc = pointerNDC(e);
  _raycaster.setFromCamera(ndc, camera);
  const hits = _raycaster.intersectObjects([target], true);
  if (!hits.length) return;
  const ground = groundPointFromEvent(e);
  if (!ground) return;
  dragState = {
    mesh: target,
    grabOffset: new THREE.Vector3().copy(target.position).sub(ground),
    startY: target.position.y,
  };
  // 拖动期间暂停该模型物理：dynamic 刚体（布料/裙摆）由物理引擎控制，
  // 整体移动模型时它们会停留在旧位置，被约束拉扯产生剧烈抖动
  const physH = mmdHelper && mmdHelper.objects && mmdHelper.objects.get(target);
  if (physH && physH.physics) {
    dragState._savedPhysics = physH.physics;
    physH.physics = null;
  }
  canvas.style.cursor = 'grabbing';
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  e.preventDefault();
  setStatus('拖动模型位置…', 'info', target.name || '');
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragState || !dragState.mesh) return;
  const ground = groundPointFromEvent(e);
  if (!ground) return;
  const st = dragState;
  const m = st.mesh;
  // 仅支持鼠标拖拽移动：地面平面自由移动（X/Z），Y 保持不动
  m.position.x = ground.x + st.grabOffset.x;
  m.position.z = ground.z + st.grabOffset.z;
  m.position.y = st.startY;
});
canvas.addEventListener('pointerup', () => {
  if (!dragState) return;
  const name = dragState.mesh && dragState.mesh.name || '';
  restoreDragPhysics();
  endDrag();
  setStatus('已移动模型位置', 'info', name);
});
canvas.addEventListener('pointercancel', () => {
  if (!dragState) return;
  restoreDragPhysics();
  endDrag();
});

// ---------- 工具栏事件 ----------
$('btn-open-model').addEventListener('click', handleOpenModelDialog);
$('btn-open-archive').addEventListener('click', handleOpenArchiveDialog);
$('btn-load-mod').addEventListener('click', async () => {
  const result = await api.showOpenDialog({
    title: '选择 Mod 压缩包',
    filters: [{ name: 'Mod 压缩包', extensions: ['zip', '7z', 'rar'] }],
    properties: ['openFile'],
  });
  if (!result || !result.ok || !result.data || !result.data[0]) return;
  await loadModModel(result.data[0]);
});
$('btn-reset-view').addEventListener('click', () => {
  // 计算场景中最大包围盒半径：存在大面积场景模型时，默认视角对准网格中心（贴地内部视角）；
  // 否则按「角色+全部场景模型」整体取景。
  let maxRadius = 0;
  const targets = [];
  if (currentModel) targets.push(currentModel);
  (sceneItems || []).forEach((s) => { if (s && s.mesh) targets.push(s.mesh); });
  targets.forEach((t) => {
    try {
      const b = new THREE.Box3().setFromObject(t);
      const s = b.getSize(new THREE.Vector3());
      maxRadius = Math.max(maxRadius, Math.max(s.x, s.y, s.z) / 2 || 0);
    } catch (_) { /* noop */ }
  });
  if (maxRadius > SCENE_LARGE_RADIUS) frameSceneAtGridCenter();
  else frameAll();
  if (!targets.length) {
    camera.position.set(0, 2.2, 5.2); controls.target.set(0, 1.1, 0); controls.update();
  }
});
$('btn-toggle-skybox').addEventListener('click', () => {
  setSkyboxEnabled(!skyboxEnabled);
});
// ===== 渲染设置快捷浮层 =====
(function bindRenderQuickPanel() {
  const panel = $('render-quick-panel');
  const btn = $('btn-render-panel');
  const closeBtn = $('rqp-close');
  const openFullBtn = $('rqp-open-full');
  if (!panel || !btn) return;
  const toggle = (want) => {
    const show = typeof want === 'boolean' ? want : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !show);
    btn.classList.toggle('active', show);
    if (show) try { syncRenderQuickPanelUI(); } catch (_) {}
  };
  btn.addEventListener('click', () => toggle());
  if (closeBtn) closeBtn.addEventListener('click', () => toggle(false));
  // 打开完整参数面板 -> 切右侧 info panel params tab
  if (openFullBtn) {
    openFullBtn.addEventListener('click', () => {
      const infoTabBtn = document.querySelector('#info-panel .tab-btn[data-tab="params"]');
      if (infoTabBtn) infoTabBtn.click();
      toggle(false);
    });
  }
  // ESC 关闭浮层
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) toggle(false);
  });
  // 预设按钮
  const presetBtns = panel.querySelectorAll('.rqp-preset');
  presetBtns.forEach((pb) => {
    pb.addEventListener('click', () => {
      const name = pb.dataset.preset;
      if (name === 'custom') {
        setParam('render', 'renderPreset', 'custom', { persist: true, apply: true });
      } else if (_PRESETS[name]) {
        setParam('render', 'renderPreset', name, { persist: true, apply: true });
      }
    });
  });
  // 开关
  panel.querySelectorAll('.rqp-switch input[type="checkbox"]').forEach((inp) => {
    const rk = inp.closest('[data-rk]') ? inp.closest('[data-rk]').dataset.rk : inp.parentElement.querySelector('span').textContent;
    const key = inp.parentElement.dataset.rk || inp.closest('.rqp-switch').dataset.rk || inp.dataset.rk;
    // data-rk 直接放在 <input> 上（按我们 HTML 写法）
    const actualKey = inp.dataset.rk || key;
    inp.addEventListener('change', () => {
      setParam('render', actualKey, !!inp.checked);
      // applyParam 会自动触发 refreshRenderPanelUI，但浮层滑杆数值也一起刷一遍
      try { syncRenderQuickPanelUI(); } catch (_) {}
    });
  });
  // 滑杆
  panel.querySelectorAll('.rqp-slider').forEach((row) => {
    const rk = row.dataset.rk;
    const inp = row.querySelector('input[type="range"]');
    const val = row.querySelector('.rqp-sl-val');
    if (!rk || !inp || !val) return;
    inp.min = row.dataset.min || inp.min;
    inp.max = row.dataset.max || inp.max;
    inp.step = row.dataset.step || inp.step;
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      const step = Number(row.dataset.step || 0.01);
      const digits = (String(step).split('.')[1] || '').length;
      val.textContent = Number.isFinite(v) ? v.toFixed(digits) : inp.value;
      setParam('render', rk, Number.isFinite(v) ? v : inp.value);
    });
  });
})();
// 将 PARAMS 当前值同步到渲染快捷浮层所有控件
function syncRenderQuickPanelUI() {
  const panel = $('render-quick-panel');
  if (!panel) return;
  // 预设
  const curPreset = String(getParam('render', 'renderPreset', 'custom'));
  panel.querySelectorAll('.rqp-preset').forEach((pb) => {
    pb.classList.toggle('active', pb.dataset.preset === curPreset);
  });
  // 开关
  panel.querySelectorAll('.rqp-switch input[type="checkbox"]').forEach((inp) => {
    const rk = inp.dataset.rk;
    if (!rk) return;
    const def = PARAM_DEFS && PARAM_DEFS.render && PARAM_DEFS.render[rk];
    const cur = !!getParam('render', rk, def && def.v);
    inp.checked = !!cur;
    // label 高亮
    inp.closest('.rqp-switch')?.classList.toggle('is-on', !!cur);
  });
  // 滑杆
  panel.querySelectorAll('.rqp-slider').forEach((row) => {
    const rk = row.dataset.rk;
    const inp = row.querySelector('input[type="range"]');
    const val = row.querySelector('.rqp-sl-val');
    if (!rk || !inp || !val) return;
    const def = PARAM_DEFS && PARAM_DEFS.render && PARAM_DEFS.render[rk];
    const cur = Number(getParam('render', rk, def && def.v));
    const step = Number(row.dataset.step || (def && def.step) || 0.01);
    const digits = (String(step).split('.')[1] || '').length;
    inp.value = Number.isFinite(cur) ? String(cur) : String(def && def.v);
    val.textContent = Number.isFinite(cur) ? cur.toFixed(digits) : String(def && def.v);
  });
}
$('btn-screenshot').addEventListener('click', async () => {
  if (!currentModel) { setStatus('没有可截图的模型', 'warn'); return; }
  const dataUrl = canvas.toDataURL('image/png');
  const base = currentModelPath ? currentModelPath.split(/[\\/]/).pop().replace(/\.\w+$/, '') : 'model';
  try {
    const res = await api.saveScreenshot(dataUrl, `${base}_${Date.now()}.png`);
    if (res.ok) setStatus('截图已保存：' + res.data);
    else if (res.error !== 'cancelled') setStatus('截图保存失败：' + res.error, 'error');
  } catch (err) { setStatus('截图失败：' + err.message, 'error'); }
});
$('btn-refresh').addEventListener('click', async () => {
  const last = navStack.back[navStack.back.length - 1];
  const path = last?.path || currentDirPath || defaultRootPath;
  const tab = last?.tab || activeTab;
  await navigateTo(path, tab, false);
});
$('btn-choose-dir').addEventListener('click', async () => {
  const res = await api.chooseDir();
  if (res.ok) navigateTo(res.data, 'models', true);
});

// 自定义默认根目录：选择目录 -> 持久化 -> 刷新各库与缓存扫描
$('btn-set-root').addEventListener('click', async () => {
  const res = await api.chooseDir();
  if (!res.ok) return; // 用户取消
  const setRes = await api.setDefaultRoot(res.data);
  if (!setRes.ok) { setStatus('设置根目录失败：' + (setRes.error || '未知错误'), 'error'); return; }
  defaultRootPath = res.data;
  motionRootPath = null;
  sceneRootPath = null;
  modRootItems = [];
  modArchivesCache = null; // 根目录变化，重置 mod 缓存，让 Mod 库重新扫描
  rootPathEl.textContent = defaultRootPath;
  navStack.back = [{ path: defaultRootPath, tab: 'models' }];
  navStack.forward = [];
  // 重新读取派生根（<根>/动作、<根>/场景）并刷新各库内容
  const [motRes, sceRes] = await Promise.all([api.getMotionRoot(), api.getSceneRoot()]);
  motionRootPath = motRes && motRes.data || null;
  sceneRootPath = sceRes && sceRes.data || null;
  await navigateTo(defaultRootPath, 'models', true);
  if (motionRootPath) {
    const r = await api.scanDir(motionRootPath);
    if (r.ok) {
      const flat = [];
      (function walk(n) {
        if (!n) return;
        if (n.type === 'model' && MOTION_EXTS_RE.test(n.name)) flat.push(n);
        (n.children || []).forEach(walk);
      })(r.data);
      motionRootItems = flat;
      renderMotionList();
    }
  }
  if (sceneRootPath) {
    const r = await api.scanDir(sceneRootPath);
    if (r.ok) { sceneRoot = r.data; renderTree(sceneRoot, sceneTreeEl); }
  }
  updateLibCounts();
  updateNavButtons();
  setStatus('根目录已设置为：' + defaultRootPath);
  startAutoCacheScan();
});

// 播放控制（MMDAnimationHelper 统一驱动）
$('btn-play').addEventListener('click', () => {
  if (!mmdHelper || !currentMesh) return;
  const obj = mmdHelper.objects && mmdHelper.objects.get(currentMesh);
  if (obj && obj.mixer) obj.mixer.timeScale = parseFloat(getParam('anim', 'speedScale', 1)) || 1;
  currentAnimating = true;
});
$('btn-pause').addEventListener('click', () => {
  if (!mmdHelper || !currentMesh) return;
  const obj = mmdHelper.objects && mmdHelper.objects.get(currentMesh);
  if (obj && obj.mixer) obj.mixer.timeScale = 0;
  currentAnimating = false;
});
$('btn-stop').addEventListener('click', () => {
  if (mmdHelper && currentMesh) {
    // 从 helper 里 remove 后再 re-add（无 animation），相当于完全停止动作 + 回到 bind pose
    try { mmdHelper.remove(currentMesh); } catch (_) {}
    const doReset = !!getParam('anim', 'resetOnStop', true);
    mmdHelper.add(currentMesh, buildHelperOptions(currentMesh, {
      animation: undefined,
      resetPosition: doReset,
      resetRotation: doReset,
    }));
    syncIkSolverForMesh(currentMesh);
    // r4：停止后清除该模型的动作记录
    currentMesh.userData = currentMesh.userData || {};
    currentMesh.userData.activeMotion = '';
  }
  currentAnimating = false;
  refreshOutlineSelection();
  vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
  if (activeTab === 'compose') renderComposeModelList();
});
speedRange.addEventListener('input', () => { speedVal.textContent = parseFloat(speedRange.value).toFixed(1) + 'x'; });

// 面包屑导航
btnBack.addEventListener('click', goBack);
btnForward.addEventListener('click', goForward);
btnUp.addEventListener('click', goUp);
btnHome.addEventListener('click', goHome);

// 库入口卡片
libCards.forEach((c) => {
  c.addEventListener('click', () => switchTab(c.dataset.tab, true));
});
// ---------- 右侧面板 Tab 切换（info/params/cache） ----------
document.querySelectorAll('#info-panel .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const want = btn.dataset.tab;
    document.querySelectorAll('#info-panel .tab-btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('#info-panel .tab-content').forEach((c) => {
      c.classList.toggle('hidden', c.dataset.view !== want);
    });
    if (want === 'params') {
      renderParamPanel();
    } else if (want === 'cache') {
      renderCacheTab();
    }
  });
});
// ---------- 参数面板 UI 渲染（含手风琴 5 分组） ----------
let currentParamGroup = 'render';
const PARAM_GROUP_LIST = ['render', 'physics', 'ik', 'anim', 'compose'];
// 简单 debounce：range / color 控件 → 220ms 延迟触发 applyParam（防止 GPU 重建、SSR、PMREM 抖动）
function __debounce(fn, wait=220) {
  let id = null;
  return function(...args) {
    if (id) clearTimeout(id);
    id = setTimeout(() => { id = null; fn.apply(this, args); }, wait);
  };
}
// 构造一条参数 row（公共函数：供 renderParamPanel / 手风琴 section 使用）
function buildParamRow(g, k, d) {
  if (!d) return null;
  if (d.t === 'hidden' || d.t === 'lgg' /* 特殊：liftGammaGain 暂保留未来特殊控件，此处跳过 */) return null;
  const row = document.createElement('div');
  row.className = 'param-row';
  row.title = d.hint || d.label || k;
  const name = document.createElement('div');
  name.className = 'param-name';
  name.textContent = d.label || k;
  const ctrl = document.createElement('div');
  ctrl.className = 'param-control';
  const cur = getParam(g, k, d.v);
  if (d.t === 'switch') {
    const id = `p_${g}_${k}`;
    const lbl = document.createElement('label');
    lbl.className = 'switch';
    lbl.innerHTML = `<input id="${id}" type="checkbox" ${cur ? 'checked' : ''}><span></span>`;
    lbl.querySelector('input').addEventListener('change', (e) => {
      setParam(g, k, !!e.target.checked);
    });
    ctrl.appendChild(lbl);
  } else if (d.t === 'range') {
    const id = `p_${g}_${k}`;
    const range = document.createElement('input');
    range.type = 'range'; range.id = id;
    range.min = d.min; range.max = d.max; range.step = d.step;
    range.value = cur;
    const span = document.createElement('span');
    span.className = 'range-val';
    span.textContent = formatRangeValue(cur, d);
    const applyDeb = __debounce((v) => setParam(g, k, v), 220);
    range.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      span.textContent = formatRangeValue(v, d);
      applyDeb(v);
    });
    ctrl.appendChild(range);
    ctrl.appendChild(span);
  } else if (d.t === 'select') {
    const id = `p_${g}_${k}`;
    const sel = document.createElement('select');
    sel.className = 'param-select';
    sel.id = id;
    (d.options || []).forEach(([val, label]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = label || val;
      if (String(val) === String(cur)) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', (e) => setParam(g, k, e.target.value));
    ctrl.appendChild(sel);
  } else if (d.t === 'color') {
    const id = `p_${g}_${k}`;
    const cp = document.createElement('input');
    cp.type = 'color'; cp.className = 'param-color'; cp.id = id;
    cp.value = cur;
    const applyDeb = __debounce((v) => setParam(g, k, v), 220);
    cp.addEventListener('input', (e) => applyDeb(e.target.value));
    ctrl.appendChild(cp);
  } else if (d.t === 'file') {
    // IES 用户贴图 / HDR 用户文件：按钮选择
    const id = `p_${g}_${k}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'btn btn-small';
    const label = String(cur || '').split(/[\\/]/).pop() || '未选择';
    btn.textContent = `${d.label || k}：${label}`;
    btn.title = d.accept || '';
    btn.addEventListener('click', async () => {
      try {
        const accept = (d.accept || '*').split(',').map((x) => x && '.' + x.trim().replace(/^\./, '')).filter(Boolean).join(' ');
        const res = await (api && api.openFile ? api.openFile({ title: `选择 ${d.label||k}`, multi: false, filters: [{ name: 'Files', extensions: (d.accept||'').split(',') }] }) : null);
        if (!res) return;
        if (!res.ok) return;
        const absPath = res.data && res.data.paths ? res.data.paths[0] : (res.data || '');
        if (!absPath) return;
        setParam(g, k, absPath);
        btn.textContent = `${d.label || k}：${String(absPath).split(/[\\/]/).pop()}`;
        // 同步触发 HDR / IES 重建
        try {
          if (g === 'render' && k === 'hdrUserPath') {
            try { setParam('render','hdrPreset','user',{ persist: true, apply: true }); } catch (_) {}
          }
          if (g === 'render' && k === 'iesUserPath') {
            try { setParam('render','iesPreset','user',{ persist: true, apply: true }); } catch (_) {}
          }
        } catch (_) {}
      } catch (e) { console.warn('[param-file]', e && e.message); }
    });
    ctrl.appendChild(btn);
  }
  row.appendChild(name);
  row.appendChild(ctrl);
  return row;
}
function renderParamPanel(group) {
  if (group && PARAM_GROUP_LIST.includes(group)) currentParamGroup = group;
  PARAM_GROUP_LIST.forEach((g) => {
    if (g === 'render') {
      // render 组：按 5 个手风琴 section 分别写入
      const container = document.querySelector('#params-render');
      if (!container) return;
      if (container.dataset.built === '1') {
        syncParamValuesFromState(g);
        // 同步手风琴内联预设激活状态
        try { syncInlinePresetButtons(); } catch (_) {}
        return;
      }
      // 清掉 legacy（向后兼容隐藏容器）
      const legacy = container.querySelector('.render-param-legacy');
      if (legacy) legacy.innerHTML = '';
      const sections = container.querySelectorAll('.accordion-section');
      sections.forEach((secEl) => {
        secEl.innerHTML = '';
        const sec = secEl.dataset.section || '';
        // preset section 的 presetRow 按钮由 DOM 保留，不需要再注入
        const keys = RENDER_ACCORDION_SECTIONS[sec] || [];
        const defs = PARAM_DEFS[g] || {};
        keys.forEach((k) => {
          const d = defs[k];
          if (!d) return;
          const row = buildParamRow(g, k, d);
          if (!row) return;
          // preset 组内的 renderPreset/presetName 不再追加（按钮由 accordion inline 处理）
          if (sec === 'preset' && (k === 'renderPreset' || k === 'presetName')) return;
          secEl.appendChild(row);
        });
      });
      // 绑定内联预设按钮
      try {
        container.querySelectorAll('.accordion-inline-presets .aip-btn').forEach((b) => {
          b.addEventListener('click', () => {
            const p = b.dataset.preset || 'custom';
            if (p === 'custom') setParam('render','presetName','custom',{ persist:true, apply:false });
            else if (_PRESETS[p]) setParam('render','renderPreset', p, { persist:true, apply:true });
            else setParam('render','renderPreset','custom',{ persist:true, apply:true });
            try { syncInlinePresetButtons(); } catch (_) {}
          });
        });
        syncInlinePresetButtons();
      } catch (_) {}
      // 回灌手风琴展开状态
      try {
        const raw = String(getParam('render','renderAccordionState','') || '');
        if (raw) {
          const state = JSON.parse(raw) || {};
          const groups = container.querySelectorAll('.render-accordion-group');
          groups.forEach((grp) => {
            const id = grp.dataset.group || '';
            if (state[id] === true) grp.classList.add('expanded');
            else if (state[id] === false) grp.classList.remove('expanded');
          });
        }
      } catch (_) {}
      container.dataset.built = '1';
      return;
    }
    // 其他组（physics/ik/anim/compose）保持原有 group-rows 扁平结构
    const root = document.querySelector(`#params-${g} .group-rows`);
    if (!root) return;
    if (root.dataset.built === '1') { syncParamValuesFromState(g); return; }
    const defs = PARAM_DEFS[g] || {};
    root.innerHTML = '';
    Object.keys(defs).forEach((k) => {
      const row = buildParamRow(g, k, defs[k]);
      if (row) root.appendChild(row);
    });
    root.dataset.built = '1';
  });
}
function syncInlinePresetButtons() {
  const container = document.querySelector('#params-render');
  if (!container) return;
  const name = String(getParam('render','presetName','default') || 'default');
  const rp   = String(getParam('render','renderPreset','custom') || 'custom');
  const cur  = rp && rp !== 'custom' ? rp : (name === 'default' ? 'custom' : 'custom');
  const buttons = container.querySelectorAll('.accordion-inline-presets .aip-btn');
  buttons.forEach((b) => {
    const p = b.dataset.preset || '';
    let active = false;
    if (rp && rp !== 'custom') active = (p === rp);
    else if (_PRESETS[name] && _PRESETS[name].overrides) active = (p === name);
    else active = (p === 'custom');
    b.classList.toggle('active', !!active);
  });
}
function formatRangeValue(v, d) {
  const step = Number(d && d.step) || 0.01;
  const digits = (String(step).split('.')[1] || '').length;
  return Number(v).toFixed(digits);
}
function syncParamValuesFromState(group) {
  const defs = PARAM_DEFS[group] || {};
  if (group === 'render') {
    // 手风琴：按 section 查 param 控件
    const container = document.querySelector('#params-render');
    if (!container) return;
    Object.keys(defs).forEach((k) => {
      const d = defs[k];
      if (!d || d.t === 'hidden' || d.t === 'lgg') return;
      if (k === 'renderPreset' || k === 'presetName') return; // 按钮由内联 preset 处理
      const id = `p_${group}_${k}`;
      const cur = getParam(group, k, d.v);
      const el = document.getElementById(id);
      if (!el) return;
      if (d.t === 'switch') { el.checked = !!cur; }
      else if (d.t === 'range') {
        el.value = cur;
        const span = (el.parentElement || document).querySelector(`#${id} ~ .range-val`);
        if (span) span.textContent = formatRangeValue(cur, d);
      } else if (d.t === 'select') { el.value = String(cur); }
      else if (d.t === 'color') { el.value = String(cur); }
      else if (d.t === 'file') {
        const label = String(cur || '').split(/[\\/]/).pop() || '未选择';
        el.textContent = `${d.label || k}：${label}`;
      }
    });
    try { syncInlinePresetButtons(); } catch (_) {}
    try { updateRqpChip(); } catch (_) {}
    return;
  }
  const root = document.querySelector(`#params-${group} .group-rows`);
  if (!root) return;
  Object.keys(defs).forEach((k) => {
    const d = defs[k];
    if (!d || d.t === 'hidden' || d.t === 'lgg') return;
    const cur = getParam(group, k, d.v);
    const id = `p_${group}_${k}`;
    if (d.t === 'switch') {
      const el = document.getElementById(id);
      if (el) el.checked = !!cur;
    } else if (d.t === 'range') {
      const el = document.getElementById(id);
      const span = (el && el.parentElement || document).querySelector(`#${id} ~ .range-val`);
      if (el) el.value = cur;
      if (span) span.textContent = formatRangeValue(cur, d);
    } else if (d.t === 'select') {
      const el = document.getElementById(id);
      if (el) el.value = String(cur);
    } else if (d.t === 'color') {
      const el = document.getElementById(id);
      if (el) el.value = String(cur);
    } else if (d.t === 'file') {
      const el = document.getElementById(id);
      if (el) {
        const label = String(cur || '').split(/[\\/]/).pop() || '未选择';
        el.textContent = `${d.label || k}：${label}`;
      }
    }
  });
  try { updateRqpChip(); } catch (_) {}
}
(function bindParamReset() {
  const btnGroup = $('btn-reset-group');
  const btnAll = $('btn-reset-all');
  if (btnGroup) btnGroup.addEventListener('click', () => {
    resetParamGroup(currentParamGroup);
    syncParamValuesFromState(currentParamGroup); // 重置后立即刷新已构建的表单（Bug3）
    setStatus(`已重置参数组：${currentParamGroup}`, 'info');
  });
  if (btnAll) btnAll.addEventListener('click', () => {
    resetAllParams();
    PARAM_GROUP_LIST.forEach((g) => syncParamValuesFromState(g));
    setStatus('已重置所有参数到默认值', 'info');
  });
})();
(function observeParamGroupInView() {
  const container = document.querySelector('[data-view="params"]');
  if (!container) return;
  const groups = container.querySelectorAll('.param-group');
  const io = new IntersectionObserver((entries) => {
    let best = null;
    let bestRect = null;
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const r = en.boundingClientRect;
      if (!bestRect || Math.abs(r.top) < Math.abs(bestRect.top)) { best = en.target.dataset.group; bestRect = r; }
    });
    if (best) currentParamGroup = best;
  }, { root: container, threshold: [0.1, 0.5] });
  groups.forEach((g) => io.observe(g));
})();
if (speedRange) {
  speedRange.addEventListener('change', () => {
    const v = parseFloat(speedRange.value) || 1;
    setParam('anim', 'speedScale', v, { persist: true, apply: false });
  });
}
// ---------- 缓存资源 Tab UI + 扫描/复制/清理/缩略图 ----------
const cacheState = {
  items: [],            // 来自 index.json
  filter: '',
  type: 'all',          // all | models | motions
  scanning: false,
  scanTaskId: null,
  scanProgress: null,
  lastCandidates: [],   // 扫描结果候选（供勾选）
  lastCopySummary: null,
};
let cacheEventsBound = false;
function bindCacheEventsOnce() {
  if (cacheEventsBound || !api) return;
  cacheEventsBound = true;
  if (typeof api.onScanProgress === 'function') {
    api.onScanProgress((p) => {
      if (p && cacheState.scanTaskId && p.taskId === cacheState.scanTaskId) {
        cacheState.scanProgress = p;
        updateScanToast();
      }
    });
  }
  if (typeof api.onScanDone === 'function') {
    api.onScanDone(async (p) => {
      if (!p || !cacheState.scanTaskId || p.taskId !== cacheState.scanTaskId) return;
      cacheState.scanning = false;
      cacheState.scanProgress = null;
      hideScanToast();
      if (p.error) {
        setStatus('扫描失败：' + p.error, 'error');
      } else if (p.cancelled) {
        setStatus('扫描已取消', 'warn');
      } else {
        cacheState.lastCandidates = Array.isArray(p.candidates) ? p.candidates : [];
        const cachedIds = new Set((cacheState.items || []).map(x => x.id));
        if (cacheState.lastCandidates.length === 0) {
          setStatus(`扫描完成：没有发现 PMX/PMD/VMD/VPD 资源（共处理 ${p.totalCount} 个候选）`, 'warn');
        } else {
          // 自动缓存模式：未超量（<500 项 且 <500MB）则静默自动缓存全部新资源，超量才弹候选清单确认
          const totalCount = Number(p.totalCount) || cacheState.lastCandidates.length;
          const totalSize = Number(p.totalSize) || 0;
          const OVER_COUNT = 500;
          const OVER_SIZE = 500 * 1024 * 1024;
          if (totalCount >= OVER_COUNT || totalSize >= OVER_SIZE) {
            setStatus(`扫描完成：发现 ${totalCount} 个资源（${fmtSize(totalSize)}），超出自动缓存阈值，请在候选清单中勾选`, 'info');
            openCandidatePickDialog();
          } else {
            const uncachedIds = cacheState.lastCandidates
              .filter((c) => !cachedIds.has(c.id))
              .map((c) => c.id);
            if (!uncachedIds.length) {
              setStatus(`扫描完成：${totalCount} 个资源均已缓存`, 'info');
              await refreshCacheItems();
              renderCacheTab();
            } else {
              setStatus(`扫描完成：自动缓存 ${uncachedIds.length} 个新资源（共 ${totalCount} 个，${fmtSize(totalSize)}）…`, 'info');
              await cacheCandidates(uncachedIds);
            }
          }
        }
      }
    });
  }
  if (typeof api.onCacheProgress === 'function') {
    api.onCacheProgress((p) => {
      if (!p) return;
      showCopyProgressToast(p);
    });
  }
  if (typeof api.onCacheDone === 'function') {
    api.onCacheDone(async (p) => {
      if (!p) return;
      cacheState.lastCopySummary = p.summary || null;
      hideCopyProgressToast();
      if (p.error) {
        setStatus('缓存复制失败：' + p.error, 'error');
      } else {
        const s = p.summary || { ok: 0, fail: 0 };
        const skipTxt = Number(s.skip) > 0 ? `，跳过 ${s.skip}（已缓存）` : '';
        setStatus(`缓存完成：成功 ${s.ok}，失败 ${s.fail}${skipTxt}`, s.fail > 0 ? 'warn' : 'success');
      }
      await refreshCacheItems();
      renderCacheTab();
    });
  }
}
async function refreshCacheItems() {
  if (!api || typeof api.getCacheIndex !== 'function') return;
  try {
    const r = await api.getCacheIndex();
    cacheState.items = ((r && r.index && Array.isArray(r.index.items)) ? r.index.items : []).slice();
  } catch (_) { cacheState.items = []; }
  // 预填 cacheRootAbs（缓存项拼绝对路径、缩略图 mmd:// 都需要）
  if (!window.__cacheRootAbs && api && api.getCacheDirInfo) {
    try {
      const info = await api.getCacheDirInfo();
      if (info && info.root) window.__cacheRootAbs = info.root;
    } catch (_) { /* noop */ }
  }
  syncCachedToLibraries();
}
// 缓存变化后，把缓存资源同步到左侧模型库/动作库（功能1）
function syncCachedToLibraries() {
  updateLibCounts();
  if (activeTab === 'motions') renderMotionList();
  else if (activeTab === 'models' && currentRoot) renderTree(currentRoot);
  else if (activeTab === 'scenes' && sceneRoot) renderTree(sceneRoot, sceneTreeEl);
}
function updateCacheSizeBadge() {
  const badge = $('cache-size');
  if (!badge) return;
  const total = (cacheState.items || []).reduce((s, it) => s + (Number(it.cacheSize) || 0), 0);
  badge.textContent = fmtSize(total);
}
function getFilteredCacheItems() {
  const kw = String(cacheState.filter || '').trim().toLowerCase();
  const t = cacheState.type || 'all';
  return (cacheState.items || []).filter((it) => {
    if (!it) return false;
    if (t === 'models' && it.type !== 'model') return false;
    if (t === 'motions' && it.type !== 'motion') return false;
    if (kw) {
      const hay = String(it.name || '').toLowerCase() + ' ' + String(it.ext || '').toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}
// 简化 path.join：因为 mmdUrl 只要 / 分隔；跨盘符场景交由 mmdUrl 处理
function require_path_join_fallback(a, b) {
  const x = String(a || '').replace(/\\/g, '/');
  const y = String(b || '').replace(/\\/g, '/').replace(/^\//, '');
  return x.replace(/\/$/, '') + '/' + y;
}
// 扫描候选对话框（玻璃态 modal，用 CSS 中已存在的 .modal/.modal-card 样式）
let candidateDialogEl = null;
function openCandidatePickDialog() {
  const cands = Array.isArray(cacheState.lastCandidates) ? cacheState.lastCandidates : [];
  if (!cands.length) return;
  const cachedIds = new Set((cacheState.items || []).map(x => x.id));
  const root = document.createElement('div');
  root.className = 'modal hidden';
  root.innerHTML = `
    <div class="modal-card" style="width: 720px; max-width: 92vw; max-height: 80vh;">
      <div class="modal-title">
        <div>
          <div style="font-weight:700;font-size:16px;">识别到以下资源</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:2px;">共 ${cands.length} 个 · ${fmtSize(cands.reduce((s,c)=>s+(Number(c.sizeEstimate)||0),0))}；灰色 = 已缓存</div>
        </div>
        <button class="modal-close" data-act="close">×</button>
      </div>
      <div style="display:flex;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap;">
        <input class="filter-input" id="cand-filter" placeholder="搜索候选…" style="flex:1;min-width:180px;" />
        <div class="segmented" role="group">
          <button class="seg active" data-cand-type="all">全部</button>
          <button class="seg" data-cand-type="models">🧊 模型</button>
          <button class="seg" data-cand-type="motions">🎬 动作</button>
        </div>
        <button class="btn btn-small" id="cand-select-all">全选新增</button>
      </div>
      <div class="modal-body">
        <div id="cand-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;"></div>
      </div>
      <div class="modal-footer">
        <span id="cand-stat" style="color:var(--text-muted);font-size:12px;"></span>
        <div style="display:flex;gap:8px;margin-left:auto;">
          <button class="btn btn-small" data-act="close">取消</button>
          <button class="btn btn-small btn-primary" id="cand-cache-btn">缓存所选（0）</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  candidateDialogEl = root;
  let candType = 'all';
  let candFilter = '';
  const checked = new Set();
  cands.forEach((c) => { if (!cachedIds.has(c.id)) checked.add(c.id); });
  const candList = root.querySelector('#cand-list');
  const candStat = root.querySelector('#cand-stat');
  const cacheBtn = root.querySelector('#cand-cache-btn');
  function render() {
    const kw = candFilter.trim().toLowerCase();
    const list = cands.filter((c) => {
      if (candType === 'models' && c.type !== 'model') return false;
      if (candType === 'motions' && c.type !== 'motion') return false;
      if (kw) {
        const hay = String(c.name || '').toLowerCase() + ' ' + String(c.ext || '').toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
    candList.innerHTML = '';
    list.forEach((c) => {
      const isCached = cachedIds.has(c.id);
      const card = document.createElement('label');
      card.className = 'cache-card' + (isCached ? ' cached-disabled' : '');
      card.style.cursor = isCached ? 'default' : 'pointer';
      const idAttr = `cand_${c.id}`;
      card.innerHTML = `
        <input type="checkbox" value="${c.id}" ${checked.has(c.id) ? 'checked' : ''} ${isCached ? 'disabled' : ''} style="display:none;">
        <div style="width:100%;aspect-ratio:1/1;background:var(--bg-sidebar);border:1px solid var(--border);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;font-size:28px;">
          ${c.type === 'model' ? '🧊' : '🎬'}
        </div>
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(String(c.name || ''))}">${escapeHtml(String(c.name || c.id || ''))}</div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);">
          <span>${String(c.ext || '').toUpperCase()}</span>
          <span>${c.sourceType === 'archive' ? '📦' : '📁'} ${typeof c.sizeEstimate === 'number' ? fmtSize(c.sizeEstimate) : '—'}</span>
        </div>
        ${isCached ? '<div style="font-size:10px;color:var(--text-muted);">已缓存</div>' : ''}
      `;
      if (!isCached) {
        const input = card.querySelector('input');
        card.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          input.checked = !input.checked;
          if (input.checked) checked.add(c.id); else checked.delete(c.id);
          updateStat();
        });
        input.addEventListener('change', () => {
          if (input.checked) checked.add(c.id); else checked.delete(c.id);
          updateStat();
        });
      }
      candList.appendChild(card);
    });
    updateStat();
  }
  function updateStat() {
    const selectedIds = Array.from(checked);
    const selItems = cands.filter(c => selectedIds.includes(c.id));
    const totalSz = selItems.reduce((s, c) => s + (Number(c.sizeEstimate) || 0), 0);
    candStat.textContent = `已选 ${selItems.length} 个 · ${fmtSize(totalSz)}`;
    cacheBtn.textContent = `缓存所选（${selItems.length}）`;
    cacheBtn.disabled = selItems.length === 0;
  }
  root.querySelector('#cand-filter').addEventListener('input', (e) => { candFilter = e.target.value; render(); });
  root.querySelectorAll('[data-cand-type]').forEach((b) => {
    b.addEventListener('click', () => {
      root.querySelectorAll('[data-cand-type]').forEach((x) => x.classList.toggle('active', x === b));
      candType = b.dataset.candType;
      render();
    });
  });
  root.querySelector('#cand-select-all').addEventListener('click', () => {
    cands.forEach((c) => { if (!cachedIds.has(c.id)) checked.add(c.id); });
    render();
  });
  root.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeCandidatePickDialog));
  root.addEventListener('click', (e) => { if (e.target === root) closeCandidatePickDialog(); });
  cacheBtn.addEventListener('click', async () => {
    const ids = Array.from(checked);
    if (!ids.length) return;
    closeCandidatePickDialog();
    await cacheCandidates(ids);
  });
  root.classList.remove('hidden');
  render();
}
function closeCandidatePickDialog() {
  if (candidateDialogEl && candidateDialogEl.parentNode) candidateDialogEl.parentNode.removeChild(candidateDialogEl);
  candidateDialogEl = null;
}
async function cacheCandidates(ids) {
  if (!api || typeof api.cacheSelectedResources !== 'function') return;
  const taskId = 'copy_' + Date.now().toString(36);
  await api.cacheSelectedResources({ taskId, ids: Array.isArray(ids) ? ids : [] });
}
// 扫描进度 toast（底部覆盖层，使用 CSS 中 .progress-track 等样式）
let scanToastEl = null;
function updateScanToast() {
  const p = cacheState.scanProgress;
  if (!scanToastEl || !p) return;
  const pct = p.total ? Math.min(100, Math.round(100 * (p.done / p.total))) : 0;
  scanToastEl.querySelector('.pt-text').textContent = `扫描中 ${p.done}/${p.total}（${pct}%）`;
  scanToastEl.querySelector('.pt-fill').style.width = pct + '%';
  scanToastEl.querySelector('.pt-detail').textContent = String(p.currentDir || '');
}
function showScanToast() {
  if (scanToastEl) return;
  const el = document.createElement('div');
  el.className = 'progress-toast';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="font-weight:600;">🔍 资源识别中</div>
      <div class="pt-text" style="color:var(--text-muted);font-size:12px;"></div>
      <button class="btn btn-small" id="scan-cancel" style="margin-left:auto;">取消</button>
    </div>
    <div class="progress-track" style="margin-top:8px;"><div class="pt-fill" style="width:0%"></div></div>
    <div class="pt-detail" style="font-size:11px;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>`;
  document.body.appendChild(el);
  scanToastEl = el;
  el.querySelector('#scan-cancel').addEventListener('click', async () => {
    if (cacheState.scanTaskId && api && api.cancelResourceScan) await api.cancelResourceScan(cacheState.scanTaskId);
  });
}
function hideScanToast() { if (scanToastEl && scanToastEl.parentNode) scanToastEl.parentNode.removeChild(scanToastEl); scanToastEl = null; }
// 复制进度 toast
let copyToastEl = null;
let copyToastTimer = null;
function showCopyProgressToast(p) {
  if (!p) return;
  if (!copyToastEl) {
    const el = document.createElement('div');
    el.className = 'progress-toast';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-weight:600;">💾 正在缓存到本地</div>
        <div class="pt-text" style="color:var(--text-muted);font-size:12px;"></div>
      </div>
      <div class="progress-track" style="margin-top:8px;"><div class="pt-fill" style="width:0%"></div></div>
      <div class="pt-detail" style="font-size:11px;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>`;
    document.body.appendChild(el);
    copyToastEl = el;
  }
  const pct = p.total ? Math.min(100, Math.round(100 * (p.done / p.total))) : 0;
  copyToastEl.querySelector('.pt-text').textContent = `${p.done}/${p.total}（${pct}%）`;
  copyToastEl.querySelector('.pt-fill').style.width = pct + '%';
  copyToastEl.querySelector('.pt-detail').textContent = (p.succeeded ? '✅ ' : p.error ? '⚠️ ' : '') + String(p.currentName || '');
  if (copyToastTimer) clearTimeout(copyToastTimer);
}
function hideCopyProgressToast() {
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    if (copyToastEl && copyToastEl.parentNode) copyToastEl.parentNode.removeChild(copyToastEl);
    copyToastEl = null;
  }, 2000);
}
async function startAutoCacheScan() {
  if (!api) return;
  if (cacheState.scanning) return;
  bindCacheEventsOnce();
  await refreshCacheItems();
  const roots = [];
  if (defaultRootPath) roots.push(defaultRootPath);
  if (motionRootPath && motionRootPath !== defaultRootPath) roots.push(motionRootPath);
  if (sceneRootPath && sceneRootPath !== defaultRootPath && sceneRootPath !== motionRootPath) roots.push(sceneRootPath);
  console.log('[cache] startAutoCacheScan roots=', JSON.stringify(roots), 'defaultRootPath=', defaultRootPath, 'motionRootPath=', motionRootPath);
  if (!roots.length) { setStatus('没有可扫描的根目录', 'warn'); return; }
  cacheState.scanning = true;
  cacheState.lastCandidates = [];
  showScanToast();
  updateScanToast();
  try {
    const r = await api.startResourceScan({ roots, intoArchives: true });
    cacheState.scanTaskId = r && r.taskId;
  } catch (e) {
    cacheState.scanning = false; hideScanToast();
    setStatus('启动扫描失败：' + (e && e.message || e), 'error');
  }
}
// 缩略图写入：在成功加载模型后，截一张 256x256 PNG 写回缓存索引（仅缓存项写入）
function maybeWriteCacheThumbForCurrent() {
  if (!currentModelPath || !api || typeof api.writeCacheThumb !== 'function') return;
  const item = (cacheState.items || []).find((it) => {
    if (!it || !it.cachePath) return false;
    try {
      const rel = String(it.cachePath).replace(/\\/g, '/');
      const base = rel.split('/').pop() || '';
      if (!base) return false;
      return String(currentModelPath).replace(/\\/g, '/').endsWith('/' + base);
    } catch (_) { return false; }
  });
  if (!item) return;
  try {
    const off = document.createElement('canvas');
    off.width = 256; off.height = 256;
    const ctx = off.getContext('2d');
    // 将当前 canvas 缩绘到 off（保留 aspect）
    const cw = canvas.width, ch = canvas.height;
    if (!cw || !ch) return;
    const scale = Math.min(off.width / cw, off.height / ch);
    const dw = cw * scale, dh = ch * scale;
    const dx = (off.width - dw) / 2, dy = (off.height - dh) / 2;
    ctx.fillStyle = '#F0F1F5';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(canvas, dx, dy, dw, dh);
    const dataUrl = off.toDataURL('image/png');
    api.writeCacheThumb({ id: item.id, base64Png: dataUrl }).then(() => {
      // 写入成功后刷新缩略图引用
      refreshCacheItems().then(renderCacheTab);
    }).catch((_) => { /* noop */ });
  } catch (_) { /* noop */ }
}
// 真实的 renderCacheTab：列表 + 过滤 + 删除 + 清空 + 写入缩略图钩子
async function renderCacheTab() {
  bindCacheEventsOnce();
  const grid = $('cache-grid');
  if (!grid) return;
  const sizeBadge = $('cache-size');
  // 预填 cacheRootAbs（用于缩略图 mmd:// 构造）
  if (!window.__cacheRootAbs && api && api.getCacheDirInfo) {
    try {
      const info = await api.getCacheDirInfo();
      if (info && info.root) window.__cacheRootAbs = info.root;
    } catch (_) { /* noop */ }
  }
  if (!cacheState.items.length) await refreshCacheItems();
  updateCacheSizeBadge();
  renderCacheToolbar();
  const filtered = getFilteredCacheItems();
  if (!filtered.length) {
    grid.innerHTML = '<div class="placeholder">暂无缓存资源。启动后已在后台自动识别并缓存模型/动作，稍后刷新即可看到；也可点击工具栏「自动识别缓存」开关手动重新扫描。</div>';
    return;
  }
  grid.innerHTML = '';
  filtered.forEach((it) => {
    const isModel = it.type === 'model';
    const row = document.createElement('div');
    row.className = 'cache-row';
    row.title = String(it.name || '');
    row.innerHTML = `
      <div class="cr-icon">${isModel ? '🧊' : '🎬'}</div>
      <div class="cr-name">${escapeHtml(String(it.name || ''))}</div>
      <div class="cr-ext">${String(it.ext || '').toUpperCase()}</div>
      <div class="cr-type">${isModel ? '模型' : '动作'}</div>
      <div class="cr-size">${fmtSize(Number(it.cacheSize) || 0)}</div>
      <div class="cr-actions">
        <button class="btn btn-tiny cc-load">${isModel ? '加载' : '应用'}</button>
        <button class="btn btn-tiny btn-danger cc-del">删除</button>
      </div>`;
    // 加载/应用：缓存项用相对路径拼 cacheRoot 取模型/动作的绝对路径
    // 整行点击与「加载/应用」按钮等价（修复 Bug1：原卡片主体无点击处理）
    const abs = window.__cacheRootAbs ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '') : '';
    const doLoad = () => {
      if (!window.__cacheRootAbs) { setStatus('缓存根目录未知，请稍后再试', 'warn'); return; }
      if (it.type === 'model') {
        selectFile({ path: abs, name: it.name, type: 'model', size: it.cacheSize, isSceneCache: isSceneCacheItem(it) });
      } else if (it.type === 'motion' && currentMesh) {
        playVmd({ path: abs, name: it.name, size: it.cacheSize }, currentMesh, null);
      } else if (it.type === 'motion') {
        setStatus('请先加载一个 PMX/PMD 模型，再应用此动作', 'warn');
      }
    };
    // 模型行支持拖拽到 3D 视口（放入场景指定位置；场景缓存项带 scene 标记）
    if (isModel) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-mmd-model', JSON.stringify({
          path: abs,
          name: it.name,
          size: Number(it.cacheSize) || null,
          isSceneCache: isSceneCacheItem(it),
        }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    row.addEventListener('click', doLoad);
    row.querySelector('.cc-load').addEventListener('click', (e) => { e.stopPropagation(); doLoad(); });
    row.querySelector('.cc-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!api || typeof api.deleteCacheItems !== 'function') return;
      try {
        const r = await api.deleteCacheItems([it.id]);
        if (r && Array.isArray(r.deleted) && r.deleted.includes(String(it.id))) {
          await refreshCacheItems();
          renderCacheTab();
          setStatus(`已删除缓存：${it.name || it.id}`, 'info');
        } else {
          setStatus('删除失败', 'warn');
        }
      } catch (err) { setStatus('删除异常：' + (err && err.message || err), 'error'); }
    });
    grid.appendChild(row);
  });
}
function renderCacheToolbar() {
  // 缓存过滤器、分段、清空按钮仅初始化一次绑定
  if (document.body.dataset.cacheToolbarBound === '1') return;
  document.body.dataset.cacheToolbarBound = '1';
  const input = $('cache-filter');
  if (input) {
    input.addEventListener('input', (e) => { cacheState.filter = e.target.value; renderCacheTab(); });
  }
  document.querySelectorAll('[data-cache-type]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-cache-type]').forEach((x) => x.classList.toggle('active', x === b));
      cacheState.type = b.dataset.cacheType;
      renderCacheTab();
    });
  });
  const doClear = async (scope) => {
    if (!api || typeof api.clearCache !== 'function') return;
    const labelMap = { models: '模型', motions: '动作', all: '全部' };
    if (!confirm(`确定要清空${labelMap[scope] || ''}缓存吗？此操作不可撤销。`)) return;
    try {
      const r = await api.clearCache(scope);
      await refreshCacheItems();
      renderCacheTab();
      setStatus(`已清空 ${r.removed || 0} 项，释放 ${fmtSize(Number(r.freedBytes) || 0)}`, 'success');
    } catch (e) {
      setStatus('清空缓存失败：' + (e && e.message || e), 'error');
    }
  };
  const bm = $('btn-clear-model-cache');
  const bv = $('btn-clear-motion-cache');
  const ba = $('btn-clear-all-cache');
  if (bm) bm.addEventListener('click', () => doClear('models'));
  if (bv) bv.addEventListener('click', () => doClear('motions'));
  if (ba) ba.addEventListener('click', () => doClear('all'));
}
// 左侧「缓存资源」面板：按类型分类展示（模型 / 场景 / 动作），与文件资源管理器区分开
async function renderSideCache() {
  if (!window.__cacheRootAbs && api && api.getCacheDirInfo) {
    try {
      const info = await api.getCacheDirInfo();
      if (info && info.root) window.__cacheRootAbs = info.root;
    } catch (_) { /* noop */ }
  }
  if (!cacheState.items.length) await refreshCacheItems();
  const all = (cacheState.items || []).slice();
  const catModels = all.filter((it) => it.type === 'model' && !isSceneCacheItem(it));
  const catScenes = all.filter((it) => it.type === 'model' && isSceneCacheItem(it));
  const catMotions = all.filter((it) => it.type === 'motion');
  const countOf = (id, n) => { const el = $(id); if (el) el.textContent = n + ' 项'; };
  countOf('cc-models-count', catModels.length);
  countOf('cc-scenes-count', catScenes.length);
  countOf('cc-motions-count', catMotions.length);
  const sizeBadge = $('side-cache-size');
  if (sizeBadge) {
    const total = all.reduce((s, it) => s + (Number(it.cacheSize) || 0), 0);
    sizeBadge.textContent = all.length ? `${all.length} 项 · ${fmtSize(total)}` : '0 项';
  }
  const groups = [
    { key: 'models', items: catModels, empty: '暂无缓存模型' },
    { key: 'scenes', items: catScenes, empty: '暂无缓存场景' },
    { key: 'motions', items: catMotions, empty: '暂无缓存动作' },
  ];
  groups.forEach((g) => {
    const box = $(`cc-${g.key}`);
    if (!box) return;
    if (!g.items.length) {
      box.innerHTML = `<div class="scc-empty">${g.empty}</div>`;
      return;
    }
    box.innerHTML = '';
    g.items.forEach((it) => {
      const abs = window.__cacheRootAbs ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '') : '';
      const row = document.createElement('div');
      row.className = 'scc-row';
      row.title = abs || String(it.name || '');
      row.innerHTML = `
        <span class="scc-icon">${it.type === 'model' ? '🧊' : '🎬'}</span>
        <span class="scc-name">${escapeHtml(String(it.name || ''))}</span>
        <span class="scc-ext">${String(it.ext || '').toUpperCase()}</span>
        <span class="scc-del" title="删除该缓存">×</span>`;
      const doLoad = () => {
        if (!window.__cacheRootAbs) { setStatus('缓存根目录未知，请稍后再试', 'warn'); return; }
        if (it.type === 'model') {
          selectFile({ path: abs, name: it.name, type: 'model', size: it.cacheSize, isSceneCache: isSceneCacheItem(it) });
        } else if (it.type === 'motion' && currentMesh) {
          playVmd({ path: abs, name: it.name, size: it.cacheSize }, currentMesh, null);
        } else if (it.type === 'motion') {
          setStatus('请先加载一个 PMX/PMD 模型，再应用此动作', 'warn');
        }
      };
      // 模型行支持拖到 3D 视口（放入场景指定位置；场景缓存项带 scene 标记）
      if (it.type === 'model') {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-mmd-model', JSON.stringify({
            path: abs,
            name: it.name,
            size: Number(it.cacheSize) || null,
            isSceneCache: isSceneCacheItem(it),
          }));
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      row.addEventListener('click', doLoad);
      row.querySelector('.scc-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!api || typeof api.deleteCacheItems !== 'function') return;
        try {
          const r = await api.deleteCacheItems([it.id]);
          if (r && Array.isArray(r.deleted) && r.deleted.includes(String(it.id))) {
            await refreshCacheItems();
            renderSideCache();
            updateLibCounts();
            setStatus(`已删除缓存：${it.name || it.id}`, 'info');
          } else {
            setStatus('删除失败', 'warn');
          }
        } catch (err) { setStatus('删除异常：' + (err && err.message || err), 'error'); }
      });
      box.appendChild(row);
    });
  });
}
// 顶栏自动缓存开关监听
const AUTOCACHE_KEY = 'mmdviewer_autocache_v1';
function bindToolbarAutoCacheToggle() {
  const tgl = $('tgl-auto-cache');
  if (!tgl || tgl.dataset.bound === '1') return;
  tgl.dataset.bound = '1';
  // 初始状态：默认开启（首次启动即自动扫描并缓存），状态持久化到 localStorage
  let saved = '1';
  try { saved = localStorage.getItem(AUTOCACHE_KEY); } catch (_) { /* noop */ }
  tgl.checked = saved !== '0';
  tgl.addEventListener('change', async (e) => {
    try { localStorage.setItem(AUTOCACHE_KEY, e.target.checked ? '1' : '0'); } catch (_) { /* noop */ }
    if (e.target.checked) {
      // 切到缓存 Tab 便于观察
      const want = document.querySelector('#info-panel .tab-btn[data-tab="cache"]');
      if (want) want.click();
      await startAutoCacheScan();
    } else {
      // 关闭：如果在扫描中则取消
      if (cacheState.scanning && cacheState.scanTaskId && api && api.cancelResourceScan) {
        await api.cancelResourceScan(cacheState.scanTaskId);
      }
    }
  });
}
// 模型加载完成后，若是缓存项则写缩略图
function hookLoadModelForThumb() {
  if (window.__cacheThumbHooked) return;
  window.__cacheThumbHooked = true;
  // 以 MutationObserver 等方式侵入性太强；直接在 renderCacheTab load 时调用 maybeWriteCacheThumbForCurrent 即可
  // 所以此处提供一个定时器，检测 currentModel 变化 2.5s 后写缩略图
  let lastSeen = null;
  setInterval(() => {
    if (!currentModel) { lastSeen = null; return; }
    const sig = String(currentModelPath || '') + '::' + String(currentModel && currentModel.id || '');
    if (sig === lastSeen) return;
    lastSeen = sig;
    setTimeout(maybeWriteCacheThumbForCurrent, 2500);
  }, 1000);
}
// 初始化一次（在 init() 末尾）
let cacheAutoScanStarted = false;
function initCacheTabModule(fromInit = false) {
  bindCacheEventsOnce();
  bindToolbarAutoCacheToggle();
  hookLoadModelForThumb();
  // 启动时自动扫描并缓存（开关默认开启；用户手动关闭后不再自动触发）。
  // 仅在 init() 完成后（根目录已就绪）触发一次。
  if (!fromInit || cacheAutoScanStarted) return;
  cacheAutoScanStarted = true;
  const tgl = $('tgl-auto-cache');
  if (tgl && tgl.checked) {
    setTimeout(() => { if (tgl && tgl.checked) startAutoCacheScan(); }, 1500);
  }
}
// 立即注册：不阻塞 init；init 尾部也会重复调用一次，内部防重
initCacheTabModule();

// 动作搜索
motionFilterEl.addEventListener('input', (e) => { motionFilterKw = e.target.value; renderMotionList(); });
modFilterEl.addEventListener('input', (e) => { modFilterKw = e.target.value; renderModList(); });

// 预览卡关闭
pcClose.addEventListener('click', () => { delete previewCardEl.dataset.pinned; previewCardEl.classList.add('hidden'); });
apClose.addEventListener('click', () => archivePreviewEl.classList.add('hidden'));
apExtract.addEventListener('click', () => {
  const p = lastArchivePreviewPath;
  if (!p) return;
  doExtractAndBrowse({ path: p, name: pathBasename(p) });
});

// 键盘快捷键
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  else if (e.key === 'Backspace') {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); goUp(); }
  } else if (e.key === 'Escape') {
    if (!previewCardEl.classList.contains('hidden')) { delete previewCardEl.dataset.pinned; previewCardEl.classList.add('hidden'); }
    else if (!archivePreviewEl.classList.contains('hidden')) archivePreviewEl.classList.add('hidden');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (activeTab === 'motions') { e.preventDefault(); motionFilterEl.focus(); }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault(); $('btn-refresh').click();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault(); handleOpenModelDialog();
  }
});

// 双击 canvas 重置视角
canvas.addEventListener('dblclick', () => $('btn-reset-view').click());

// ---------- Ammo.js 预加载（用于 MMDPhysics 布料） ----------
// ammo.wasm.js 是 emscripten MODULARIZE=1 产出，<script> 加载后 window.Ammo 是工厂函数；
// 必须调用工厂返回的 Promise<Module> 才能拿到真正的 Ammo 模块实例。
// 不用 esbuild 打包是因为 ammo.wasm.js 内部 require("path")/("fs") 仅 Node 分支用，
// esbuild 静态分析会报 Could not resolve "path"/"fs"。
// TODO(prod): electron-builder asar 打包后此相对路径会失效，需改用 file:// 绝对路径或把 ammo.wasm.js 解包到 renderer/
async function initAmmo() {
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '../node_modules/three/examples/jsm/libs/ammo.wasm.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('ammo.wasm.js 脚本加载失败'));
      document.head.appendChild(s);
    });
    const AmmoFactory = window.Ammo;
    if (typeof AmmoFactory !== 'function') {
      throw new Error('Ammo 工厂未挂载到 window（类型: ' + typeof AmmoFactory + '）');
    }
    // 调用工厂函数，返回 Promise<AmmoModule>，resolve 后 Ammo 才有 btVector3 等类
    // 获取 ammo.wasm 所在目录，通过 mmd:// 协议加载 .wasm（避开 file:// fetch 限制）
    const libsDir = await api.getAmmoLibsDir();
    const Ammo = await AmmoFactory({
      locateFile: (p) => api.mmdUrl(libsDir + '\\' + p),
    });
    window.Ammo = Ammo;  // 覆盖工厂为模块实例，供 MMDPhysics 内部使用
    ammoReady = true;
  } catch (err) {
    ammoReady = false;
    setStatus('ammo 加载失败，布料物理降级（腿部 IK 仍正常）：' + (err.message || err), 'warn');
  }
}

// ---------- 启动 ----------
async function init() {
  loadRecent();
  loadParams();
  // 启动时把已持久化的渲染/动画参数回灌到渲染管线、灯光、网格等（物理/IK 参数由 helper.add 时读取）
  applyAllParams();
  // 先启动 ammo 预加载（与扫描根目录并行，保证第一个模型加载时 ammo 已就绪）
  const ammoPromise = initAmmo();
  try {
    const [defRes, motRes, sceRes] = await Promise.all([api.getDefaultRoot(), api.getMotionRoot(), api.getSceneRoot()]);
    // 等 ammo 完（不会比目录扫描更慢）
    await ammoPromise;
    if (!defRes.ok || !defRes.data) { setStatus('默认根目录获取失败', 'error'); return; }
    defaultRootPath = defRes.data;
    motionRootPath = motRes.data || null;
    sceneRootPath = sceRes && sceRes.data || null;
    navStack.back = [{ path: defaultRootPath, tab: 'models' }];
    navStack.forward = [];
    await navigateTo(defaultRootPath, 'models', false);
    if (motionRootPath) {
      const res = await api.scanDir(motionRootPath);
      if (res.ok) {
        const flat = [];
        (function walk(n) {
          if (!n) return;
          if (n.type === 'model' && MOTION_EXTS_RE.test(n.name)) flat.push(n);
          (n.children || []).forEach(walk);
        })(res.data);
        motionRootItems = flat;
      }
    }
    if (sceneRootPath) {
      const res = await api.scanDir(sceneRootPath);
      if (res.ok) sceneRoot = res.data;
    }
    updateLibCounts();
    updateNavButtons();
    initCacheTabModule(true);
  } catch (err) {
    setStatus('初始化失败：' + err.message, 'error');
  }
}

function countModels(node) {
  let n = 0;
  (function walk(x) {
    if (x.type === 'model') n++;
    (x.children || []).forEach(walk);
  })(node);
  return n;
}

// ---------- 左右侧边栏：收起/展开 + 拖拽调宽 ----------
const SIDEBAR_W_KEY = 'mmd.sidebarW';
const INFOPANEL_W_KEY = 'mmd.infoW';
function applySidebarLayout() {
  const sb = $('sidebar'), ip = $('info-panel');
  if (!sb || !ip) return;
  let sw = parseInt(localStorage.getItem(SIDEBAR_W_KEY), 10);
  let iw = parseInt(localStorage.getItem(INFOPANEL_W_KEY), 10);
  if (isNaN(sw)) sw = 300; if (isNaN(iw)) iw = 280;
  sw = Math.min(480, Math.max(200, sw));
  iw = Math.min(440, Math.max(200, iw));
  document.documentElement.style.setProperty('--sidebar-w', sw + 'px');
  document.documentElement.style.setProperty('--info-w', iw + 'px');
  // 折叠状态恢复
  if (localStorage.getItem('mmd.sidebarCollapsed') === '1') sb.classList.add('collapsed');
  if (localStorage.getItem('mmd.infoCollapsed') === '1') ip.classList.add('collapsed');
}
function initLayoutControls() {
  applySidebarLayout();
  const toggleCollapse = (el, key, btn) => {
    const cb = (on) => {
      el.classList.toggle('collapsed', on);
      localStorage.setItem(key, on ? '1' : '0');
      if (btn) {
        btn.classList.toggle('active', on);
        btn.textContent = btn.dataset && (on ? btn.dataset.collapsed : btn.dataset.open) || btn.textContent;
      }
      setTimeout(() => { resize(); frameAll(); }, 60);
    };
    btn.addEventListener('click', () => cb(!el.classList.contains('collapsed')));
    // 启动时若已处于折叠态，同步按钮图标
    if (el.classList.contains('collapsed') && btn) {
      btn.textContent = btn.dataset && btn.dataset.collapsed || btn.textContent;
      btn.classList.add('active');
    }
  };
  toggleCollapse($('sidebar'), 'mmd.sidebarCollapsed', $('btn-toggle-sidebar'));
  toggleCollapse($('info-panel'), 'mmd.infoCollapsed', $('btn-toggle-info'));
  // 拖拽条改宽度：splitter-left → --sidebar-w，splitter-right → --info-w
  const bindSplitter = (id, varName, minW, maxW, storeKey) => {
    const bar = $(id);
    if (!bar) return;
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { bar.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
      bar.classList.add('dragging');
      const startX = e.clientX;
      const root = document.documentElement;
      const startW = parseFloat(getComputedStyle(root).getPropertyValue(varName)) || 300;
      const onMove = (ev) => {
        let w = startW + (ev.clientX - startX) * (id === 'splitter-left' ? 1 : -1);
        w = Math.min(maxW, Math.max(minW, w));
        root.style.setProperty(varName, w + 'px');
        localStorage.setItem(storeKey, String(Math.round(w)));
        // 同步画布尺寸与投影矩阵（camera 位置不变，避免视角被拖动侧栏改动）
        resize();
      };
      const onUp = () => {
        bar.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        resize();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };
  bindSplitter('splitter-left', '--sidebar-w', 200, 480, SIDEBAR_W_KEY);
  bindSplitter('splitter-right', '--info-w', 200, 440, INFOPANEL_W_KEY);
}
initLayoutControls();

init();

// ---------- 冒烟测试钩子 ----------
window.__mmdTest = {
  loadAndMeasure: async (filePath) => {
    const url = api.mmdUrl(filePath);
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, (e) => reject(e || new Error('load error')));
    });
    fixEmptyMorphAttributes(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    return { ok: true, size: box.getSize(new THREE.Vector3()).toArray().map((n) => n.toFixed(2)) };
  },
  // 通用格式探针：与 loadGenericModel 共用 parseGenericRoot，验证各格式加载链路
  genericProbe: async (filePath) => {
    try {
      const url = api.mmdUrl(filePath);
      const root = await parseGenericRoot(url, pathBasename(filePath));
      if (!root) return { ok: false, error: '加载器返回空' };
      const box = new THREE.Box3().setFromObject(root);
      let meshes = 0, verts = 0;
      root.traverse((o) => {
        if (!o.isMesh) return;
        meshes++;
        const g = o.geometry;
        if (g && g.attributes && g.attributes.position) verts += g.attributes.position.count;
      });
      return { ok: true, size: box.getSize(new THREE.Vector3()).toArray().map((n) => n.toFixed(2)), meshes, verts };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },
  renderShot: async (filePath) => {
    const url = api.mmdUrl(filePath);
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, (e) => reject(e || new Error('load error')));
    });
    fixEmptyMorphAttributes(mesh);
    const off = document.createElement('canvas');
    off.width = 320; off.height = 320;
    const r = new THREE.WebGLRenderer({ canvas: off, preserveDrawingBuffer: true });
    const s = new THREE.Scene();
    s.background = new THREE.Color(0x222222);
    const c = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    c.position.set(3, 3, 3);
    c.lookAt(0, 1, 0);
    s.add(mesh);
    r.render(s, c);
    const dataUrl = off.toDataURL('image/png');
    r.dispose();
    return { ok: dataUrl.startsWith('data:image/png'), len: dataUrl.length };
  },
  mmdProbe: async (filePath) => {
    const url = api.mmdUrl(filePath);
    const out = {};
    try {
      const mesh = await new Promise((resolve, reject) => {
        mmdLoader.load(url, resolve, undefined, (e) => reject(e || new Error('load error')));
      });
      fixEmptyMorphAttributes(mesh);
      await new Promise((r) => setTimeout(r, 2000));
      let first = null;
      mesh.traverse((c) => {
        if (first || !c.isMesh) return;
        const arr = Array.isArray(c.material) ? c.material : [c.material];
        if (arr[0] && arr[0].map) first = arr[0];
      });
      if (!first) { out.step1 = { error: 'no map material' }; return out; }
      const fn = first.userData && first.userData.MMD ? first.userData.MMD.mapFileName : null;
      out.step1 = {
        mapFileName: fn,
        mmdMapImg: first.map.image ? first.map.image.constructor.name : 'null',
        mmdMapSrc: first.map.image && first.map.image.src ? String(first.map.image.src).slice(0, 120) : 'no-src',
        mmdMapComplete: !!(first.map.image && (first.map.image.complete || first.map.image.width > 0)),
      };
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      const fullPath = base + fn;
      await new Promise((resolve) => {
        const tl = new THREE.TextureLoader();
        tl.setCrossOrigin('anonymous');
        tl.load(fullPath,
          (t) => {
            out.step2 = { ok: true, ctor: t.image && t.image.constructor.name, w: t.image && t.image.width,
              src: t.image && t.image.src ? String(t.image.src).slice(0, 120) : 'no-src' };
            resolve();
          },
          undefined,
          (e) => { out.step2 = { ok: false, error: String(e && e.message || e) }; resolve(); }
        );
        setTimeout(() => { if (!out.step2) { out.step2 = { ok: false, error: 'timeout' }; resolve(); } }, 6000);
      });
    } catch (e) {
      out.step1 = { error: String(e && e.message || e) };
    }
    return out;
  },
  // 当前 3D 视口状态（诊断用）：网格数、贴图加载情况、相机位置、渲染帧计数、渲染像素亮度
  swapScene: async (filePath, name) => {
    await loadModel({ path: filePath, name: name || '场景' }, { asScene: true, kind: 'scene' });
    return true;
  },
  placeModel: async (filePath, name) => {
    await loadModel({ path: filePath, name: name || '模型' }, { asScene: true, kind: 'placed', initialPosition: { x: 0, y: 0, z: 0 }, animatable: true });
    return true;
  },
  applyMotion: async (path, name) => {
    const target = composeSelected || composeTargetMesh || currentMesh;
    if (!target) return { ok: false, error: 'no target' };
    playVmd({ path, name: name || '动作' }, target, null);
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, motion: target.userData && target.userData.activeMotion };
  },
  composeInfo: () => ({
    placed: composePlacedCount(),
    maxPlaced: composeMaxPlaced(),
    sceneOpts: (composeSceneDD && composeSceneDD._opts || []).map((o) => o.label).slice(0, 5),
    modelOpts: (composeModelDD && composeModelDD._opts || []).map((o) => o.label).slice(0, 5),
    motionOpts: (composeMotionDD && composeMotionDD._opts || []).map((o) => o.label).slice(0, 3),
    scenePaths: (composeSceneDD && composeSceneDD._opts || []).map((o) => o.path).slice(0, 5),
    modelPaths: (composeModelDD && composeModelDD._opts || []).map((o) => o.path).slice(0, 5),
    motionPaths: (composeMotionDD && composeMotionDD._opts || []).map((o) => o.path).slice(0, 3),
    rows: Array.from(document.querySelectorAll('.cmi')).map((r) => ({
      name: r.querySelector('.cmi-name') && r.querySelector('.cmi-name').textContent,
      tags: Array.from(r.querySelectorAll('.cmi-tag')).map((t) => t.textContent),
    })),
    camPos: camera.position.toArray().map((n) => n.toFixed(2)),
    camTarget: controls.target.toArray().map((n) => n.toFixed(2)),
  }),
  getState: () => {
    const meshes = [];
    let texLoaded = 0;
    let texTotal = 0;
    scene.traverse((c) => {
      if (!c.isMesh) return;
      meshes.push(c.name || '?');
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => {
        if (!m) return;
        ['map', 'normalMap', 'specularMap', 'emissiveMap', 'alphaMap'].forEach((k) => {
          const t = m[k];
          if (!t) return;
          texTotal++;
          if (t.image && (t.image.complete || t.image.width > 0)) texLoaded++;
        });
      });
    });
    let pixel = null;
    try {
      const off = document.createElement('canvas');
      off.width = 240; off.height = 240;
      const r = new THREE.WebGLRenderer({ canvas: off, preserveDrawingBuffer: true, alpha: false });
      r.setClearColor(0x888888, 1);
      r.render(scene, camera);
      const ctx = off.getContext('2d');
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let sum = 0, nonGray = 0, n = off.width * off.height;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += lum;
        if (Math.abs(lum - 136) > 24) nonGray++;
      }
      pixel = { avgLum: (sum / n).toFixed(1), nonGrayRatio: (nonGray / n * 100).toFixed(1) };
      r.dispose();
    } catch (e) {
      pixel = { error: String(e && e.message || e) };
    }
    return {
      currentModel: currentModel ? currentModel.name : null,
      meshCount: meshes.length,
      meshNames: meshes.slice(0, 5),
      sceneItems: sceneItems.length,
      scenePositions: (sceneItems || []).map((s) => ({
        name: (s && s.node && s.node.name) || (s.mesh && s.mesh.name) || '?',
        pos: s.mesh ? s.mesh.position.toArray().map((n) => n.toFixed(2)) : null,
      })),
      texLoaded,
      texTotal,
      camPos: camera.position.toArray().map((n) => n.toFixed(1)),
      frames: window.__renderFrames || 0,
      pixel,
    };
  },
  // 测试辅助：计算 mesh 屏幕上可命中的像素点（XZ 网格 × 高度方向逐档尝试）
  screenPointFor: (mesh, tryFrac) => {
    if (!mesh) return { hit: false, error: 'no mesh' };
    const b = new THREE.Box3().setFromObject(mesh);
    const rect = canvas.getBoundingClientRect();
    const fracs = tryFrac !== undefined ? [tryFrac] : [0.5, 0.6, 0.4, 0.7, 0.3, 0.8, 0.25, 0.2, 0.9];
    const xz = [0.5, 0.25, 0.75, 0.1, 0.9];
    for (const fx of xz) {
      const px = b.min.x + (b.max.x - b.min.x) * fx;
      for (const fz of xz) {
        const pz = b.min.z + (b.max.z - b.min.z) * fz;
        for (const f of fracs) {
          const p = new THREE.Vector3(px, b.min.y + (b.max.y - b.min.y) * f, pz);
          p.project(camera);
          if (p.z > 1 || p.z < -1) continue;
          const ndc = new THREE.Vector2(p.x, p.y);
          // 跳过投影到视口外的点，避免合成事件落在视口外
          if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) continue;
          _raycaster.setFromCamera(ndc, camera);
          const hits = _raycaster.intersectObjects([mesh], true);
          if (hits.length) {
            return {
              hit: true,
              clientX: rect.left + ((ndc.x + 1) / 2) * rect.width,
              clientY: rect.top + (1 - (ndc.y + 1) / 2) * rect.height,
            };
          }
        }
      }
    }
    return { hit: false, fracs, diag: { camPos: camera.position.toArray().map((n) => +n.toFixed(2)), target: controls.target.toArray().map((n) => +n.toFixed(2)) } };
  },
  // 测试辅助：将相机对准 mesh 中心，确保模型位于视口内可命中
  focusMesh: (mesh) => {
    if (!mesh) return { ok: false, error: 'no mesh' };
    const b = new THREE.Box3().setFromObject(mesh);
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length() || 1;
    controls.target.copy(c);
    camera.position.copy(c).add(new THREE.Vector3(r * 1.2, r * 0.9, r * 1.2));
    camera.lookAt(c);
    controls.update();
    return { ok: true, radius: +r.toFixed(2), camPos: camera.position.toArray().map((n) => +n.toFixed(2)), target: controls.target.toArray().map((n) => +n.toFixed(2)) };
  },
  // 测试辅助：查询 mesh 物理状态（暂停与否 + 刚体与骨骼的最大位置偏差，用于验证拖动期间暂停与结束后复位）
  physicsState: (mesh) => {
    const h = mmdHelper && mmdHelper.objects && mmdHelper.objects.get(mesh);
    if (!h) return { hasPhysics: false, note: 'no-helper' };
    if (!h.physics) return { hasPhysics: false, note: 'paused-or-none' };
    if (mesh && mesh.updateMatrixWorld) mesh.updateMatrixWorld(true);
    let worst = 0, dynCount = 0;
    const form = new window.Ammo.btTransform();
    for (const rb of h.physics.bodies || []) {
      if (rb.params.type !== 1 || !rb.body || !rb.bone) continue;
      dynCount++;
      rb.body.getMotionState().getWorldTransform(form);
      const o = form.getOrigin();
      const bm = rb.bone.matrixWorld.elements;
      const dx = o.x() - bm[12], dy = o.y() - bm[13], dz = o.z() - bm[14];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > worst) worst = d2;
    }
    return { hasPhysics: true, bodies: (h.physics.bodies || []).length, dynCount, worstBodyDelta: +Math.sqrt(worst).toFixed(3) };
  },
  // 测试辅助：在视口上合成一次 pointer 拖拽（需移动模式开启且该点命中选中模型）
  dragAt: (clientX, clientY, dx, dy, keys) => {
    const o = {
      bubbles: true, cancelable: true, button: 0, pointerId: 9876,
      shiftKey: !!(keys && keys.shift), ctrlKey: !!(keys && keys.ctrl), metaKey: !!(keys && keys.ctrl),
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, o, { clientX, clientY })));
    canvas.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { clientX: clientX + dx, clientY: clientY + dy })));
    canvas.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { clientX: clientX + dx, clientY: clientY + dy })));
    return true;
  },
  // 测试辅助：按名称查询场景中已放置模型的位置
  placedMesh: (name) => {
    const s = (sceneItems || []).find((x) => x.mesh && ((x.node && x.node.name === name) || x.mesh.name === name));
    return s ? { found: true, pos: s.mesh.position.toArray().map((n) => +n.toFixed(3)) } : { found: false };
  },
  // 测试辅助：以「角色模型」方式加载（替换当前模型，非组合放置）
  loadAsCurrent: async (path, name) => {
    await loadModel({ path, name: name || '角色', size: 0 }, {});
    return { ok: true, current: currentModel && currentModel.name };
  },
  loadMod: async (archivePath) => {
    await loadModModel(archivePath);
    if (!currentModel) return { ok: false };
    const box = new THREE.Box3().setFromObject(currentModel);
    const sz = box.getSize(new THREE.Vector3());
    return { ok: true, name: currentModel.name, size: [+sz.x.toFixed(2), +sz.y.toFixed(2), +sz.z.toFixed(2)] };
  },
  // 测试辅助：模块作用域访问器（页面 eval 无法直接引用模块变量）
  current: () => currentMesh,
  selected: () => composeSelected,
  meshByName: (name) => {
    const s = (sceneItems || []).find((x) => x.mesh && x.node && x.node.name === name);
    return s ? s.mesh : null;
  },
};
