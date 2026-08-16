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
import { FXAAShader } from '../node_modules/three/examples/jsm/shaders/FXAAShader.js';

const api = window.mmdAPI;
const MOTION_EXTS_RE = /\.(vmd|vpd)$/i;
const MODEL_MESH_RE = /\.(pmx|pmd)$/i;
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
let sceneItems = [];  // { mesh, node }
// AnimationMixer（旧管线）已废弃；统一由 MMDAnimationHelper 管理 IK + 物理 + 动画
let mmdHelper = null;
let ammoReady = false;
let currentAnimating = false;  // 表示当前是否有动作在驱动（用于播放按钮显示）
let vmdFiles = [];
let motionRootItems = [];
let motionFilterKw = '';
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
    outlineEnabled:   { t: 'switch', v: true,  label: '轮廓描边',    hint: '稳定模型边缘抖动' },
    edgeStrength:     { t: 'range',  v: 0.9,   label: '边缘强度',    min: 0, max: 2, step: 0.01 },
    edgeThickness:    { t: 'range',  v: 0.003, label: '边缘粗细',    min: 0.0001, max: 0.01, step: 0.0001 },
    edgeColor:        { t: 'color',  v: '#111827', label: '边缘颜色' },
    fxaaEnabled:      { t: 'switch', v: true,  label: 'FXAA 快速抗锯齿' },
    pixelRatioMax:    { t: 'range',  v: 2,     label: '像素比上限',  min: 1, max: 3, step: 0.25 },
    shadowEnabled:    { t: 'switch', v: true,  label: '阴影' },
    shadowSoftness:   { t: 'range',  v: 1,     label: '阴影柔和度',  min: 0, max: 2, step: 0.05 },
    ambientIntensity: { t: 'range',  v: 0.65,  label: '环境光强度',  min: 0, max: 2, step: 0.01 },
    dirIntensity:     { t: 'range',  v: 1.0,   label: '主光强度',    min: 0, max: 3, step: 0.01 },
    fillIntensity:    { t: 'range',  v: 0.30,  label: '补光强度',    min: 0, max: 3, step: 0.01 },
    bgColor:          { t: 'color',  v: '#F0F1F5', label: '背景色' },
    gridVisible:      { t: 'switch', v: true,  label: '显示网格地面' },
  },
  physics: {
    enabled:          { t: 'switch', v: true,  label: '物理（布料/刚体）', hint: '加载新模型时生效' },
    gravity:          { t: 'range',  v: 9.8,   label: '重力 m/s²',   min: 0, max: 20, step: 0.1 },
    unitStep:         { t: 'select', v: '1/60',label: '物理步进',
                        options: [['1/60','1/60'],['1/120','1/120'],['1/30','1/30']] },
    maxStepNum:       { t: 'range',  v: 2,     label: '最大迭代步数', min: 1, max: 6, step: 1 },
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
  if (group === 'render') {
    if (key === 'shadowEnabled') set(renderer.shadowMap, 'enabled');
    if (key === 'pixelRatioMax') {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, Math.max(1, Number(value) || 1)));
      resize();
    }
    if (key === 'bgColor') { try { scene.background = new THREE.Color(String(value)); } catch (_) {} }
    if (key === 'gridVisible') { try { gridHelper.visible = !!value; } catch (_) {} }
    if (key === 'shadowSoftness') {
      try {
        const v = Number(value) || 0;
        if (v <= 0.25) renderer.shadowMap.type = THREE.BasicShadowMap;
        else if (v <= 0.75) renderer.shadowMap.type = THREE.PCFShadowMap;
        else if (v <= 1.25) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        else renderer.shadowMap.type = THREE.VSMShadowMap;
        if (currentMesh) currentMesh.traverse && currentMesh.traverse((c) => {
          if (c && c.isMesh && c.material) {
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            mats.forEach((m) => { m.needsUpdate = true; });
          }
        });
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
    }
    if (key === 'ambientIntensity') { if (typeof ambientLight !== 'undefined') { ambientLight.intensity = Number(value) || 0; } }
    if (key === 'dirIntensity')     { if (typeof dirLight !== 'undefined')     { dirLight.intensity = Number(value) || 0; } }
    if (key === 'fillIntensity')    { if (typeof fillLight !== 'undefined')    { fillLight.intensity = Number(value) || 0; } }
  } else if (group === 'physics' || group === 'ik') {
    // 这些参数需要下一次 helper.add（重建 physics/ikSolver）才会生效：
    // 这里立即尝试对 mmdHelper.objects 中当前 mesh 的 ikSolver/physics 做一次尽力修改，能改就改；
    // 不能改的（重建级别）保持 PARAMS 值即可，下一次 loadModel / btn-stop / playVmd 会读取。
    if (group === 'physics') {
      // gravity 对 physics world（已启动的）重建成本高，保留在下一次 helper.add；此处只提示
      if (key === 'gravity' || key === 'unitStep' || key === 'maxStepNum' || key === 'enabled' || key === 'autoDisableHeavy') {
        if (!initApplyingParams) {
          try { setStatus(`物理参数「${key}」会在下一次加载模型/停止动作时应用`, 'warn'); } catch (_) { /* noop */ }
        }
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
  collect(currentMesh);
  (sceneItems || []).forEach((s) => collect(s && s.mesh));
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
// 基于当前 PARAMS 构建 mmdHelper.add / playVmd fallback add 所需的 physics/ik/gravity/unitStep/maxStepNum
function buildHelperOptions(mesh, extra = {}) {
  const rbCount = (mesh && mesh.userData && mesh.userData.rigidBodies && mesh.userData.rigidBodies.length) || 0;
  let physics = !!getParam('physics', 'enabled', true) && ammoReady;
  if (physics && getParam('physics', 'autoDisableHeavy', true) && rbCount > 200) {
    physics = false;
    try { setStatus(`模型刚体 ${rbCount} 个过多，布料物理已自动关闭（腿部 IK 正常）`, 'warn'); } catch (_) { /* noop */ }
  }
  const gravityN = Math.max(0, Number(getParam('physics', 'gravity', 9.8)) || 0);
  const unitStepStr = String(getParam('physics', 'unitStep', '1/60'));
  const unitStep = (unitStepStr === '1/120') ? 1/120 : (unitStepStr === '1/30' ? 1/30 : 1/60);
  const maxStepNum = Math.max(1, Math.floor(Number(getParam('physics', 'maxStepNum', 2)) || 1));
  return Object.assign({
    animation: undefined,
    physics,
    unitStep,
    maxStepNum,
    gravity: new THREE.Vector3(0, -gravityN * 10, 0),
    resetPosition: true,
    resetRotation: true,
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

// ---------- Post-processing: 稳定边缘抖动 + 抗锯齿 ----------
const composer = new EffectComposer(renderer);
// 注：scene/camera 在此处尚未声明，所以我们等 scene/camera 声明完之后再重建 RenderPass 与 OutlinePass
// 先插入占位 composer；真正的 pass 顺序在 scene/camera/灯光声明之后一次性构建

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xF0F1F5);
// 不启用雾效：场景模型（如 Stage0514）体量较大，雾会遮挡远处细节

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 2.2, 5.2);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.3;
controls.maxDistance = 60;
controls.update();

// 灯光
const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
scene.add(ambientLight);
const hemisphereLight = new THREE.HemisphereLight(0xEAF1FF, 0xE2E8F0, 0.55);
scene.add(hemisphereLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(3, 6, 4);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 40;
dirLight.shadow.camera.left = -8;
dirLight.shadow.camera.right = 8;
dirLight.shadow.camera.top = 8;
dirLight.shadow.camera.bottom = -8;
scene.add(dirLight);
const fillLight = new THREE.DirectionalLight(0x8FB0FF, 0.30);
fillLight.position.set(-3, 2, -4);
scene.add(fillLight);

// ---------- 正式构建后处理管线（scene/camera/灯光均已就绪） ----------
composer.passes = [];
const renderPassFinal = new RenderPass(scene, camera);
composer.addPass(renderPassFinal);
const resolution = new THREE.Vector2(canvas.clientWidth || 1, canvas.clientHeight || 1);
const outlinePass = new OutlinePass(resolution, scene, camera, []);
outlinePass.edgeStrength = getParam('render', 'edgeStrength', 0.9);
outlinePass.edgeThickness = getParam('render', 'edgeThickness', 0.003);
outlinePass.visibleEdgeColor = new THREE.Color(String(getParam('render', 'edgeColor', '#111827')));
outlinePass.hiddenEdgeColor = new THREE.Color(0x000000);
outlinePass.edgeGlow = 0;
outlinePass.downSampleRatio = 2;
outlinePass.pulsePeriod = 0;
composer.addPass(outlinePass);
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.uniforms['resolution'].value = new THREE.Vector2(
  1 / (resolution.x * renderer.getPixelRatio()),
  1 / (resolution.y * renderer.getPixelRatio())
);
fxaaPass.enabled = !!getParam('render', 'fxaaEnabled', true);
composer.addPass(fxaaPass);
const outputPass = new OutputPass();
composer.addPass(outputPass);
outlinePass.enabled = !!getParam('render', 'outlineEnabled', true);
window.__postfx = { composer, renderPass: renderPassFinal, outlinePass, fxaaPass, outputPass };

// 地面
const gridHelper = new THREE.GridHelper(20, 20, 0xCBD5E1, 0xE2E8F0);
scene.add(gridHelper);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.22 })
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
      sceneTreeEl.innerHTML = '<div class="placeholder">未找到场景目录（D:\\素材\\3D模型\\场景）</div>';
    }
  } else if (tab === 'recent') {
    renderRecentList();
    renderBreadcrumb('', []);
    breadcrumbEl.innerHTML = '<span class="crumb placeholder">最近加载的文件</span>';
    updateNavButtons();
  } else {
    if (currentRoot) {
      renderTree(currentRoot); // 重绘以显示「已缓存模型」组等最新状态
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
  // 已缓存模型组（功能：识别出的资源同步到左侧模型库）
  if (!containerEl) {
    const cached = (cacheState.items || []).filter((it) => it.type === 'model');
    if (cached.length) {
      const vdir = {
        name: '🧊 已缓存模型',
        path: '__cached_models__',
        type: 'dir',
        children: cached.map((it) => ({
          name: it.name,
          path: window.__cacheRootAbs
            ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '')
            : (it.name || ''),
          type: 'model',
          size: it.cacheSize,
        })),
      };
      dfsAppend(vdir, 1, [root], cont);
      const vrow = [...cont.querySelectorAll('.win10-row')].find((r) => r.dataset.path === '__cached_models__');
      if (vrow) toggleDir(vrow, true);
    }
  }
  // 已缓存场景组（功能：识别出的场景资源同步到左侧「场景」卡片）
  if (containerEl === sceneTreeEl) {
    const cachedScenes = (cacheState.items || []).filter((it) => isSceneCacheItem(it));
    if (cachedScenes.length) {
      const vdir = {
        name: '🌆 已缓存场景',
        path: '__cached_scenes__',
        type: 'dir',
        children: cachedScenes.map((it) => ({
          name: it.name,
          path: window.__cacheRootAbs
            ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '')
            : (it.name || ''),
          type: 'model',
          size: it.cacheSize,
          isSceneCache: true,
        })),
      };
      dfsAppend(vdir, 1, [root], cont);
      const vrow = [...cont.querySelectorAll('.win10-row')].find((r) => r.dataset.path === '__cached_scenes__');
      if (vrow) toggleDir(vrow, true);
    }
  }
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
    html += `<div class="kv"><div class="k">可加载</div><div class="v">${/\.pmx$/i.test(node.name) ? 'PMX（完整支持）' : 'PMD（完整支持）'}</div></div>`;
    html += `<div class="kv"><div class="k">操作</div><div class="v" style="font-size:11px;color:var(--text-muted);">左键旋转 · 右键平移 · 滚轮缩放</div></div>`;
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
      const nIcon = isDir ? '📁' : MODEL_MESH_RE.test(ename) ? '🧊' : MOTION_EXTS_RE.test(ename) ? '🎬' : /\.(png|jpg|bmp|tga|dds)$/i.test(ename) ? '🖼️' : '📄';
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
  const cachedModels = (cacheState.items || []).filter((it) => it.type === 'model').length;
  const cachedMotions = (cacheState.items || []).filter((it) => it.type === 'motion').length;
  $('lib-models-count').textContent = (currentRoot ? countModels(currentRoot) : 0) + cachedModels + ' 项';
  $('lib-motions-count').textContent = (motionRootItems.length + cachedMotions) + ' 项';
  $('lib-recent-count').textContent = recentItems.length + ' 项';
  const sce = $('lib-scenes-count');
  if (sce) {
    const cachedScenes = (cacheState.items || []).filter((it) => isSceneCacheItem(it)).length;
    sce.textContent = ((sceneRoot ? countModels(sceneRoot) : 0) + cachedScenes) + ' 项';
  }
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
  animPanel.classList.add('hidden');
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
  if (wasSceneCurrent) {
    currentModel = null;
    currentMesh = null;
    currentModelPath = null;
    currentAnimating = false;
    vmdFiles = [];
    vmdListEl.innerHTML = '';
    animPanel.classList.add('hidden');
    modelInfoEl.innerHTML = '<div class="placeholder">点击「选择模型」或在左侧选文件开始预览</div>';
  }
  refreshOutlineSelection();
  frameAll();
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
    scene.add(mesh);
    // 刷新 OutlinePass 所选对象（稳定边缘 + 描边）
    refreshOutlineSelection();

    if (asScene) {
      // ====== 场景模型：加入场景，不动角色模型 ======
      sceneItems.push({ mesh, node });
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
      frameAll();
      const total = sceneItems.some((s) => s.mesh === currentModel)
        ? sceneItems.length
        : sceneItems.length + (currentModel ? 1 : 0);
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
function setupVmdList(mesh) {
  vmdListEl.innerHTML = '';
  const allVmd = [];
  vmdFiles.forEach((v) => allVmd.push({ ...v, from: '同目录' }));
  motionRootItems.forEach((v) => {
    if (!allVmd.find((a) => isSamePath(a.path, v.path))) allVmd.push({ ...v, from: '动作库' });
  });

  if (!allVmd.length) { animPanel.classList.add('hidden'); return; }
  animPanel.classList.remove('hidden');
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
}
async function playVmd(vmdNode, mesh, el) {
  const url = api.mmdUrl(vmdNode.path);
  setStatus('加载动作 ' + vmdNode.name + ' …');
  try {
    const clip = await new Promise((resolve, reject) => {
      mmdLoader.loadAnimation(url, mesh, resolve, undefined, reject);
    });

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

// ---------- 动作库 ----------
function renderMotionList() {
  const kw = motionFilterKw.trim().toLowerCase();
  const items = motionRootItems.filter((n) => !kw || (n.name || '').toLowerCase().includes(kw));
  // 已缓存动作组（功能：识别出的资源同步到左侧动作库）
  const cachedMotions = (cacheState.items || []).filter((it) =>
    it.type === 'motion' &&
    !motionRootItems.some((n) => (n.name || '') === (it.name || '')) &&
    (!kw || String(it.name || '').toLowerCase().includes(kw))
  );
  if (!items.length && !cachedMotions.length) {
    motionListEl.innerHTML = `<div class="placeholder">${motionFilterKw ? '没有匹配的动作文件' : '动作目录为空'}</div>`;
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
  cachedMotions.forEach((it) => {
    const abs = window.__cacheRootAbs
      ? require_path_join_fallback(window.__cacheRootAbs, it.cachePath || '')
      : '';
    const el = document.createElement('div');
    el.className = 'motion-item';
    el.title = abs || String(it.name || '');
    el.innerHTML = `
      <div class="mi-icon">🎞️</div>
      <div class="mi-body">
        <div class="mi-name">${escapeHtml(String(it.name || ''))}</div>
        <div class="mi-meta">
          <span>${fmtSize(Number(it.cacheSize) || 0)}</span>
          <span class="chip">已缓存</span>
          ${currentModel && currentMesh ? '<span class="chip warn">可应用</span>' : ''}
        </div>
      </div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.motion-item.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      if (currentModel && currentMesh) {
        playVmd({ path: abs, name: it.name, size: it.cacheSize }, currentMesh, null);
      } else {
        showPreviewCardForNode({ path: abs, name: it.name, size: it.cacheSize, type: 'model' }, true);
        setStatus('请先加载一个 PMX/PMD 模型，再应用此动作', 'warn', it.name);
      }
    });
    motionListEl.appendChild(el);
  });
}

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  window.__renderFrames = (window.__renderFrames || 0) + 1;
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
  if (window.__postfx && window.__postfx.composer) {
    window.__postfx.composer.render(d);
  } else {
    renderer.render(scene, camera);
  }
}
animate();

// ---------- 窗口尺寸 ----------
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (window.__postfx && window.__postfx.composer) {
    window.__postfx.composer.setSize(w, h);
    const pixelRatio = renderer.getPixelRatio();
    if (window.__postfx.fxaaPass) {
      const u = window.__postfx.fxaaPass.uniforms && window.__postfx.fxaaPass.uniforms['resolution'];
      if (u && u.value) {
        u.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
      }
    }
    if (window.__postfx.outlinePass) {
      window.__postfx.outlinePass.resolution.set(w, h);
    }
  }
}
window.addEventListener('resize', resize);
resize();

// ---------- 场景摆放：拖放模型到视口 + 移动模式拖动 ----------
const viewHintEl = $('view-hint');
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _raycaster = new THREE.Raycaster();
function pointerNDC(e) {
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}
function groundPointFromEvent(e) {
  if (!e) return null;
  _raycaster.setFromCamera(pointerNDC(e), camera);
  const hit = new THREE.Vector3();
  if (_raycaster.ray.intersectPlane(GROUND_PLANE, hit)) return hit;
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
  loadModel({ path: info.path, name: info.name, size: info.size }, { asScene: true, initialPosition: pos });
});

// 移动模式：开启后在视口内按住左键拖动模型到任意位置
let moveModeActive = false;
let dragState = null; // { mesh, grabOffset: THREE.Vector3, startY }
function endDrag() {
  dragState = null;
  canvas.style.cursor = moveModeActive ? 'grab' : '';
}
function setMoveMode(on) {
  moveModeActive = on;
  const btn = $('btn-move-mode');
  if (btn) btn.classList.toggle('active', on);
  controls.enabled = !on;
  if (viewHintEl) {
    viewHintEl.textContent = on
      ? '移动模式：按住左键拖动模型到任意位置 · 再次点击「移动模式」关闭'
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
  const ndc = pointerNDC(e);
  _raycaster.setFromCamera(ndc, camera);
  const targets = [];
  if (currentModel) targets.push(currentModel);
  (sceneItems || []).forEach((s) => { if (s && s.mesh) targets.push(s.mesh); });
  const hits = _raycaster.intersectObjects(targets, true);
  if (!hits.length) return;
  // 找到命中对象所属的顶层模型（角色或某个场景模型）
  let owner = null;
  for (const m of targets) {
    let c = hits[0].object;
    while (c) { if (c === m) { owner = m; break; } c = c.parent; }
    if (owner) break;
  }
  if (!owner) owner = hits[0].object;
  const ground = groundPointFromEvent(e);
  if (!ground) return;
  dragState = {
    mesh: owner,
    grabOffset: new THREE.Vector3().copy(owner.position).sub(ground),
    startY: owner.position.y,
  };
  canvas.style.cursor = 'grabbing';
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
  e.preventDefault();
  setStatus('拖动模型位置…', 'info', owner.name || '');
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragState || !dragState.mesh) return;
  const ground = groundPointFromEvent(e);
  if (!ground) return;
  const m = dragState.mesh;
  m.position.x = ground.x + dragState.grabOffset.x;
  m.position.z = ground.z + dragState.grabOffset.z;
  m.position.y = dragState.startY;
});
canvas.addEventListener('pointerup', () => {
  if (!dragState) return;
  const name = dragState.mesh && dragState.mesh.name || '';
  endDrag();
  setStatus('已移动模型位置', 'info', name);
});
canvas.addEventListener('pointercancel', () => { if (dragState) endDrag(); });

// ---------- 工具栏事件 ----------
$('btn-open-model').addEventListener('click', handleOpenModelDialog);
$('btn-open-archive').addEventListener('click', handleOpenArchiveDialog);
$('btn-reset-view').addEventListener('click', () => {
  frameAll();
  if (!currentModel && !sceneItems.length) {
    camera.position.set(0, 2.2, 5.2); controls.target.set(0, 1.1, 0); controls.update();
  }
});
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
  }
  currentAnimating = false;
  refreshOutlineSelection();
  vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
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
// ---------- 参数面板 UI 渲染 ----------
let currentParamGroup = 'render';
function renderParamPanel(group) {
  if (group && ['render', 'physics', 'ik', 'anim'].includes(group)) currentParamGroup = group;
  ['render', 'physics', 'ik', 'anim'].forEach((g) => {
    const root = document.querySelector(`#params-${g} .group-rows`);
    if (!root) return;
    if (root.dataset.built === '1') {
      syncParamValuesFromState(g);
      return;
    }
    const defs = PARAM_DEFS[g] || {};
    root.innerHTML = '';
    Object.keys(defs).forEach((k) => {
      const d = defs[k];
      if (!d) return;
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
        range.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          span.textContent = formatRangeValue(v, d);
          setParam(g, k, v);
        });
        ctrl.appendChild(range);
        ctrl.appendChild(span);
      } else if (d.t === 'select') {
        const sel = document.createElement('select');
        sel.className = 'param-select';
        (d.options || []).forEach(([val, label]) => {
          const o = document.createElement('option');
          o.value = val; o.textContent = label || val;
          if (String(val) === String(cur)) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener('change', (e) => setParam(g, k, e.target.value));
        ctrl.appendChild(sel);
      } else if (d.t === 'color') {
        const cp = document.createElement('input');
        cp.type = 'color'; cp.className = 'param-color';
        cp.value = cur;
        cp.addEventListener('input', (e) => setParam(g, k, e.target.value));
        ctrl.appendChild(cp);
      }
      row.appendChild(name);
      row.appendChild(ctrl);
      root.appendChild(row);
    });
    root.dataset.built = '1';
  });
}
function formatRangeValue(v, d) {
  const step = Number(d && d.step) || 0.01;
  const digits = (String(step).split('.')[1] || '').length;
  return Number(v).toFixed(digits);
}
function syncParamValuesFromState(group) {
  const defs = PARAM_DEFS[group] || {};
  const root = document.querySelector(`#params-${group} .group-rows`);
  if (!root) return;
  Object.keys(defs).forEach((k) => {
    const d = defs[k];
    const cur = getParam(group, k, d.v);
    const id = `p_${group}_${k}`;
    if (d.t === 'switch') {
      const el = document.getElementById(id);
      if (el) el.checked = !!cur;
    } else if (d.t === 'range') {
      const el = document.getElementById(id);
      const span = root.querySelector(`#${id} ~ .range-val`);
      if (el) el.value = cur;
      if (span) span.textContent = formatRangeValue(cur, d);
    } else if (d.t === 'select') {
      const sel = root.querySelector(`select.param-select`);
      if (sel) sel.value = String(cur);
    } else if (d.t === 'color') {
      const idx = Object.keys(defs).findIndex(x => x === k);
      const colors = root.querySelectorAll('input.param-color');
      const pick = colors[idx];
      if (pick) pick.value = String(cur);
    }
  });
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
    ['render', 'physics', 'ik', 'anim'].forEach((g) => syncParamValuesFromState(g));
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
      texLoaded,
      texTotal,
      camPos: camera.position.toArray().map((n) => n.toFixed(1)),
      frames: window.__renderFrames || 0,
      pixel,
    };
  },
};
