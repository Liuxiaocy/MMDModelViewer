/* ============ MMDModelViewer 渲染进程 ============ */
import * as THREE from 'three';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { MMDLoader } from '../node_modules/three/examples/jsm/loaders/MMDLoader.js';

const api = window.mmdAPI;
const MOTION_EXTS_RE = /\.(vmd|vpd)$/i;
const MODEL_MESH_RE = /\.(pmx|pmd)$/i;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const fileTreeEl = $('file-tree');
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
const sideTabs = document.querySelectorAll('.side-tab');
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
const navStack = {
  back: [],     // 历史：[{path, tab}]
  forward: [],  // 前进
};
let defaultRootPath = null;
let motionRootPath = null;
let activeTab = 'models'; // 'models' | 'motions'
let lastArchivePreviewPath = null;

// ---------- 状态 ----------
let currentRoot = null;          // 当前根目录（模型库）节点
let currentDirPath = null;       // 当前模型库所在目录的绝对路径
let currentModelPath = null;
let currentModel = null;
let currentMesh = null;
let mixer = null;
let currentAction = null;
let vmdFiles = [];
let autoRotate = false;
let motionRootItems = [];        // 动作库平面列表
let motionFilterKw = '';

// ---------- Three.js 场景 ----------
const canvas = $('gl-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1c22);
scene.fog = new THREE.Fog(0x1b1c22, 30, 120);

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
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x40382c, 0.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
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
const fillLight = new THREE.DirectionalLight(0x8fb0ff, 0.35);
fillLight.position.set(-3, 2, -4);
scene.add(fillLight);

// 地面
const gridHelper = new THREE.GridHelper(20, 20, 0x555a6b, 0x3a3e4c);
scene.add(gridHelper);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.28 })
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
    if (/\.glb$/i.test(name)) return 'glTF (glb)';
    if (/\.gltf$/i.test(name)) return 'glTF';
    const ext = name.split('.').pop().toUpperCase();
    return `${ext} 3D`;
  }
  if (type === 'text') return /\.(md|txt)$/i.test(name) ? '文本' : name.split('.').pop().toUpperCase();
  return type || '文件';
}

// ---------- 面包屑 + 导航栈 ----------
function pushNavHistory(path, tab) {
  if (activeTab !== tab) return; // 只在当前 tab 记录
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
  const base = activeTab === 'motions' ? (motionRootPath || '') : (defaultRootPath || '');
  const curPath = navStack.back[navStack.back.length - 1]?.path || '';
  if (!curPath) return;
  if (curPath === base || isSamePath(parentPath(curPath), base)) {
    // 已经在根附近，直接跳到根
    navigateTo(base, activeTab, true);
    return;
  }
  const parent = parentPath(curPath);
  if (parent && parent !== curPath) navigateTo(parent, activeTab, true);
}
function goHome() {
  const root = activeTab === 'motions' ? (motionRootPath || defaultRootPath) : defaultRootPath;
  if (root) navigateTo(root, activeTab, true);
}
function parentPath(p) {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/').replace(/\/$/, '');
  const i = norm.lastIndexOf('/');
  if (i <= 0) {
    // 盘符情况：D: -> 本身已是根
    return /^[A-Za-z]:$/.test(norm) ? p : norm.slice(0, i || 1);
  }
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
  const base = activeTab === 'motions' ? (motionRootPath || '') : (defaultRootPath || '');
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
    // 动作库：单层扫描目录 + 递归收集 vmd/vpd
    setStatus('正在扫描动作库…', 'info', dirPath);
    const res = await api.scanDir(dirPath);
    if (!res.ok) { setStatus('动作库扫描失败：' + res.error, 'error'); return; }
    const flat = [];
    (function walk(n, nest = 0) {
      if (!n) return;
      if (n.type === 'model' && MOTION_EXTS_RE.test(n.name)) flat.push(n);
      (n.children || []).forEach((c) => walk(c, nest + 1));
    })(res.data);
    motionRootItems = flat;
    renderMotionList();
    renderBreadcrumb(dirPath, pathPartsUnderRoot(dirPath, motionRootPath || dirPath));
    setStatus('就绪', 'info', `动作库：共 ${flat.length} 个动作文件`);
  } else {
    // 模型库：走树渲染 + 更新面包屑
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
  } else {
    // 非根下：按盘符 + 目录拆分
  }
  const parts = [];
  // 首部：盘符 / 根
  if (prefix) parts.push({ name: pathBasename(prefix) || '根目录', path: prefix });
  else {
    // 拆盘符
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
function pathBasename(p) {
  const n = p.replace(/\\/g, '/').replace(/\/$/, '');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
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
    cr.addEventListener('click', (e) => {
      if (idx === parts.length - 1) return;
      // 普通导航
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
  // 移除已有的
  document.querySelectorAll('.crumb-dir-menu').forEach((m) => m.remove());
  const res = await api.scandirFlat(dirPath);
  const menu = document.createElement('div');
  menu.className = 'crumb-dir-menu';
  if (!res.ok || !res.data || res.data.length === 0) {
    menu.innerHTML = '<div class="mi" style="color:var(--text-dim)">（空或不可访问）</div>';
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

// ---------- Tab 切换 ----------
function switchTab(tab, updateHistory = true) {
  if (activeTab === tab && !document.querySelector('.side-view.hidden') === false) return;
  activeTab = tab;
  sideTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  sideViews.forEach((v) => v.classList.toggle('hidden', v.dataset.view !== tab));
  if (tab === 'motions') {
    if (motionRootPath) {
      // 若还未扫描，scan 一次
      if (!motionRootItems || !motionRootItems.length) {
        navigateTo(motionRootPath, 'motions', updateHistory);
      } else {
        renderMotionList();
        renderBreadcrumb(motionRootPath, pathPartsUnderRoot(motionRootPath, motionRootPath));
        if (updateHistory) pushNavHistory(motionRootPath, 'motions');
        updateNavButtons();
      }
    } else {
      motionListEl.innerHTML = '<div class="placeholder">未找到动作目录（D:\\素材\\3D模型\\动作）</div>';
    }
  } else {
    if (currentRoot) {
      renderBreadcrumb(currentDirPath || defaultRootPath,
        pathPartsUnderRoot(currentDirPath || defaultRootPath, defaultRootPath));
      if (updateHistory) pushNavHistory(currentDirPath || defaultRootPath, 'models');
      updateNavButtons();
    }
  }
}

// ---------- 目录树 ----------
function renderTree(root) {
  fileTreeEl.innerHTML = '';
  const rootNode = document.createElement('div');
  rootNode.className = 'tree-item';
  rootNode.innerHTML = `<span class="twisty">▾</span>${iconFor('dir')}<span class="name">${escapeHtml(root.name)}</span><span class="badge">根</span>`;
  rootNode.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDir(rootNode, root);
  });
  fileTreeEl.appendChild(rootNode);

  const children = document.createElement('div');
  children.className = 'tree-children';
  rootNode.appendChild(children);
  root.children.forEach((n) => children.appendChild(buildNode(n)));
}
function buildNode(node) {
  const item = document.createElement('div');
  item.className = 'tree-item';
  item.title = node.path || node.name;
  item.dataset.path = (node.path || '').replace(/\\/g, '/');

  if (node.type === 'dir') {
    item.innerHTML = `<span class="twisty">▸</span>${iconFor('dir')}<span class="name">${escapeHtml(node.name)}</span>`;
    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children collapsed';
    item.appendChild(childWrap);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // 双击目录导航进面包屑
      toggleDir(item, node, childWrap);
    });
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      navigateTo(node.path, 'models', true);
    });
    if (node.children && node.children.length) {
      node.children.forEach((c) => childWrap.appendChild(buildNode(c)));
    }
  } else {
    const isVmd = MOTION_EXTS_RE.test(node.name);
    const displayIcon = isVmd ? iconFor('motion') : iconFor(node.type);
    item.innerHTML = `<span class="twisty"></span>${displayIcon}<span class="name">${escapeHtml(node.name)}</span><span class="badge">${fmtSize(node.size)}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
      item.classList.add('selected');
      selectFile(node);
    });
    item.addEventListener('mouseenter', () => showPreviewCardForNode(node));
    item.addEventListener('mouseleave', hidePreviewCard);
  }
  return item;
}
function toggleDir(item, node, childWrap) {
  const wrap = childWrap || item.querySelector(':scope > .tree-children');
  const twisty = item.querySelector('.twisty');
  if (!wrap) return;
  if (wrap.classList.contains('collapsed')) {
    wrap.classList.remove('collapsed');
    if (twisty) twisty.textContent = '▾';
  } else {
    wrap.classList.add('collapsed');
    if (twisty) twisty.textContent = '▸';
  }
}
function expandPath(nodePath) {
  const norm = (nodePath || '').replace(/\\/g, '/');
  if (!norm) return null;
  const parts = norm.split('/');
  const prefix = parts.slice(0, -1);
  let current = fileTreeEl.firstElementChild;
  if (!current) return null;
  for (let i = 0; i < prefix.length; i++) {
    if (!current) break;
    const wrap = current.querySelector(':scope > .tree-children');
    if (wrap) {
      wrap.classList.remove('collapsed');
      const twisty = current.querySelector('.twisty');
      if (twisty) twisty.textContent = '▾';
    }
    const childItems = wrap ? [...wrap.children] : [];
    current = childItems.find((el) => el.dataset.path === parts.slice(0, i + 1).join('/')) || null;
  }
  if (current) {
    const wrap = current.querySelector(':scope > .tree-children');
    if (wrap) {
      const target = [...wrap.children].find((el) => el.dataset.path === norm);
      return target || null;
    }
  }
  return null;
}
function clearSelection() {
  fileTreeEl.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
}

// ---------- 文件选择与预览卡 ----------
function selectFile(node) {
  clearSelection();
  const el = expandPath(node.path);
  if (el) {
    el.classList.add('selected');
    el.scrollIntoView({ block: 'nearest' });
  }
  if (node.type === 'model') {
    if (MOTION_EXTS_RE.test(node.name)) {
      // vmd/vpd：若有当前模型则直接应用；否则提示先选模型
      currentModelPath && currentMesh
        ? playVmd(node, currentMesh, null)
        : setStatus('已选中动作文件，请先加载对应模型再应用', 'warn', node.name);
      showPreviewCardForNode(node);
      // 保留预览卡显示，让用户看动作信息
      showPreviewCardForNode(node, true);
    } else {
      currentModelPath = node.path;
      showPreviewCardForNode(node, true);
      loadModel(node);
    }
  } else if (node.type === 'archive') {
    handleArchive(node);
  } else if (node.type === 'text') {
    showTextFile(node);
  }
}
function selectFlat(item) {
  // 由面包屑菜单触发的单层条目（目录走 navigateTo，已在 click 处理）
  // 到这里一定是非 dir，走 selectFile 相同分支
  if (item.type === 'model') {
    if (MOTION_EXTS_RE.test(item.name)) {
      if (currentModelPath && currentMesh) playVmd(item, currentMesh, null);
      else setStatus('已选中动作文件，请先加载对应模型再应用', 'warn', item.name);
      showPreviewCardForNode(item, true);
    } else {
      currentModelPath = item.path;
      showPreviewCardForNode(item, true);
      // 对于扁平项，构造最小节点对象
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
  if (pinned) {
    previewCardEl.dataset.pinned = '1';
  } else {
    delete previewCardEl.dataset.pinned;
  }
  // 文本文件异步加载内容
  if (node.type === 'text') {
    const tp = pcBody.querySelector('.pc-text-preview');
    if (tp && tp.dataset.needLoad === '1') loadTextContentToCard(node, tp);
  }
}
function hidePreviewCard() {
  if (previewCardEl.dataset.pinned) return; // 钉住不自动隐藏
  previewCardEl.classList.add('hidden');
}
function pinOrClosePreviewCard() {
  if (previewCardEl.dataset.pinned) {
    delete previewCardEl.dataset.pinned;
    previewCardEl.classList.add('hidden');
  } else {
    previewCardEl.dataset.pinned = '1';
  }
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
    html += `<div class="kv"><div class="k">格式</div><div class="v">${/\.vmd$/i.test(node.name) ? 'MikuMikuDance VMD（动作）' : 'VPD（姿势）'}</div></div>`;
    html += `<div class="kv"><div class="k">状态</div><div class="v">${currentModel && currentMesh
      ? (currentAction ? '🔘 已载入动作' : '🟡 点击后可应用到当前模型')
      : '🟠 请先加载一个模型（PMX/PMD）再应用此动作'}</div></div>`;
    if (currentModel && currentMesh) {
      html += `<div class="kv"><div class="k">提示</div><div class="v" style="font-size:11px;color:var(--text-dim);line-height:1.5;">点击动作项即会加载并自动播放。可在右下角调节播放速度。</div></div>`;
    }
  } else if (isModelMesh) {
    html += `<div class="section">模型预览</div>`;
    html += `<div class="kv"><div class="k">可加载</div><div class="v">${/\.pmx$/i.test(node.name) ? '✅ PMX（完整支持贴图/骨骼/动作）' : '✅ PMD（完整支持）'}</div></div>`;
    html += `<div class="kv"><div class="k">自动</div><div class="v">点击后：加载模型 → 调整相机 → 列出同目录 VMD</div></div>`;
    html += `<div class="kv"><div class="k">操作</div><div class="v" style="font-size:11px;color:var(--text-dim);line-height:1.5;">左键旋转 · 右键平移 · 滚轮缩放 · 双击画布重置视角</div></div>`;
  } else if (isArchive) {
    html += `<div class="section">压缩包预览</div>`;
    html += `<div class="kv"><div class="k">类型</div><div class="v">${guessArchiveKind(node.name)}</div></div>`;
    html += `<div class="kv"><div class="k">查看方式</div><div class="v">右键或单击 → 「列出内容」可不解压预览；双击 → 直接解压并浏览</div></div>`;
    html += `<div class="tag-list"><span class="tag archive">支持浏览</span><span class="tag archive">缓存复用</span></div>`;
  } else if (isText) {
    html += `<div class="section">文本内容</div>`;
    html += `<div class="pc-text-preview" data-need-load="1">正在读取…</div>`;
  }
  return html;
}

function guessArchiveKind(name) {
  if (/\.zip$/i.test(name)) return 'ZIP（标准）';
  if (/\.7z$/i.test(name)) return '7-Zip';
  if (/\.rar$/i.test(name)) return 'RAR（RAR5 兼容）';
  if (/\.(tgz|tar\.gz)$/i.test(name)) return 'TAR.GZ';
  if (/\.(txz|tar\.xz)$/i.test(name)) return 'TAR.XZ';
  if (/\.tar$/i.test(name)) return 'TAR';
  return '压缩包';
}

async function loadTextContentToCard(node, tpEl) {
  try {
    const res = await api.readTextFile(node.path, 256 * 1024);
    if (!res.ok) {
      tpEl.textContent = '读取失败：' + res.error;
      return;
    }
    tpEl.textContent = res.data.content || '（空文件）';
    const hint = pcBody.querySelector('.pc-trunc-hint');
    if (res.data.truncated) {
      const h = document.createElement('div');
      h.className = 'pc-trunc-hint';
      h.textContent = `⚠ 内容过大，仅显示前 ${fmtSize(256 * 1024)}（共 ${fmtSize(res.data.size)}）`;
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
    apBody.innerHTML = `<div class="ap-empty">列出内容失败：${escapeHtml(res.error)}<br>
      <span style="color:var(--text-dim);font-size:11px;">可以直接点击下方「全部解压并浏览」继续。</span></div>`;
    apExtract.disabled = false;
    return;
  }
  if (res.data.kind === 'scandir') {
    apBody.innerHTML = `<div class="ap-empty">该格式直接解压后浏览（已缓存）。</div>`;
    setTimeout(() => {
      // 自动完成整个解压浏览
      doExtractAndBrowse(node);
    }, 600);
    return;
  }
  const entries = res.data.entries || [];
  // 统计
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
  head.style.color = 'var(--text-dim)';
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
  tbl.innerHTML = `<thead><tr>
    <th>条目名</th><th style="text-align:right">大小</th><th>日期</th>
  </tr></thead><tbody></tbody>`;
  const tb = tbl.querySelector('tbody');
  if (entries.length === 0) {
    apBody.innerHTML += '<div class="ap-empty">压缩包内无条目（可能为空或已损坏）</div>';
  } else {
    entries.slice(0, 500).forEach((e) => {
      const tr = document.createElement('tr');
      const name = String(e.name || '').replace(/\\/g, '/');
      const isDir = name.endsWith('/');
      const nIcon = isDir ? '📁' : MODEL_MESH_RE.test(name) ? '🧊' : MOTION_EXTS_RE.test(name) ? '🎬' : /\.(png|jpg|bmp|tga|dds)$/i.test(name) ? '🖼️' : '📄';
      tr.innerHTML = `
        <td class="name-cell" title="${escapeHtml(name)}"><span style="margin-right:6px;">${nIcon}</span>${escapeHtml(pathBasename(name))}${isDir ? '/' : ''}</td>
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
      more.textContent = `（仅显示前 500 条，共 ${entries.length} 条，解压后可查看全部）`;
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
    setStatus(`已解压 ${node.name}，浏览临时目录`, 'info', res.data.dest);
    currentRoot = res.data.tree;
    currentDirPath = res.data.dest;
    rootPathEl.textContent = `临时目录：${res.data.dest}`;
    renderTree(res.data.tree);
    renderBreadcrumb(res.data.dest, pathPartsUnderRoot(res.data.dest, res.data.dest));
    pushNavHistory(res.data.dest, 'models');
    updateNavButtons();
  } catch (err) {
    setStatus('解压失败：' + err.message, 'error');
  }
}

function showTextFile(node) {
  modelInfoEl.innerHTML = `<div class="section">文本文件</div>
    <div class="kv"><div class="k">名称</div><div class="v">${escapeHtml(node.name)}</div></div>
    <div class="kv"><div class="k">路径</div><div class="v" style="font-size:11px;">${escapeHtml(node.path)}</div></div>
    <div class="kv"><div class="k">大小</div><div class="v">${fmtSize(node.size)}</div></div>
    <div class="section">说明</div><div class="v">已在左上角预览卡显示内容（前 256KB）。</div>`;
  showPreviewCardForNode(node, true);
}

// ---------- MMD 模型加载 ----------
const mmdLoader = new MMDLoader();

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
    frameModel(mesh);
    showModelInfo(mesh, node);
    setupVmdList(mesh);
    setStatus(`已加载：${node.name}`, 'info', `${vmdFiles.length} 个动作可用`);
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

// ---------- VMD 动作（同目录） ----------
function setupVmdList(mesh) {
  vmdListEl.innerHTML = '';
  // 同时合并动作库中的全部 VMD/VPD 供用户选择
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
    if (mixer) mixer.stopAllAction();
    mixer = new THREE.AnimationMixer(mesh);
    currentAction = mixer.clipAction(clip);
    currentAction.play();
    vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
    el && el.classList.add('active');
    // 动作预览卡同步
    showPreviewCardForNode({
      path: vmdNode.path, name: vmdNode.name, size: vmdNode.size, type: 'model'
    }, true);
    setStatus(`播放动作：${vmdNode.name}`, 'info',
      `时长 ${clip.duration.toFixed(2)}s · ${clip.tracks.length} 条轨道`);
  } catch (err) {
    setStatus('加载动作失败：' + (err && err.message || err), 'error');
    console.error(err);
  }
}

// ---------- 动作库（独立目录） ----------
function renderMotionList() {
  const kw = motionFilterKw.trim().toLowerCase();
  const items = motionRootItems.filter((n) =>
    !kw || (n.name || '').toLowerCase().includes(kw)
  );
  if (!items.length) {
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
}

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  if (mixer && currentAction) mixer.update(delta * parseFloat(speedRange.value));
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- 窗口尺寸 ----------
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---------- 工具栏事件 ----------
$('btn-reset-view').addEventListener('click', () => {
  if (currentModel) frameModel(currentModel);
  else { camera.position.set(0, 2.2, 5.2); controls.target.set(0, 1.1, 0); controls.update(); }
});
$('btn-screenshot').addEventListener('click', async () => {
  if (!currentModel) { setStatus('没有可截图的模型', 'warn'); return; }
  const dataUrl = canvas.toDataURL('image/png');
  const base = currentModelPath ? currentModelPath.split(/[\\/]/).pop().replace(/\.\w+$/, '') : 'model';
  try {
    const res = await api.saveScreenshot(dataUrl, `${base}_${Date.now()}.png`);
    if (res.ok) setStatus('截图已保存：' + res.data);
    else if (res.error !== 'cancelled') setStatus('截图保存失败：' + res.error, 'error');
  } catch (err) {
    setStatus('截图失败：' + err.message, 'error');
  }
});
$('btn-refresh').addEventListener('click', async () => {
  const last = navStack.back[navStack.back.length - 1];
  const path = last?.path || currentDirPath || defaultRootPath;
  const tab = last?.tab || activeTab;
  await navigateTo(path, tab, false);
});
$('btn-choose-dir').addEventListener('click', async () => {
  const res = await api.chooseDir();
  if (res.ok) {
    if (activeTab === 'models') navigateTo(res.data, 'models', true);
    else navigateTo(res.data, 'models', true); // 切到模型库走新目录
  }
});

// 播放控制
$('btn-play').addEventListener('click', () => { if (currentAction) currentAction.play(); });
$('btn-pause').addEventListener('click', () => { if (currentAction) currentAction.pause(); });
$('btn-stop').addEventListener('click', () => {
  if (mixer) mixer.stopAllAction();
  currentAction = null;
  vmdListEl.querySelectorAll('.vmd-item').forEach((i) => i.classList.remove('active'));
});
speedRange.addEventListener('input', () => { speedVal.textContent = parseFloat(speedRange.value).toFixed(1) + 'x'; });

// 面包屑导航按钮
btnBack.addEventListener('click', goBack);
btnForward.addEventListener('click', goForward);
btnUp.addEventListener('click', goUp);
btnHome.addEventListener('click', goHome);

// Tab 切换
sideTabs.forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab, true));
});

// 动作搜索
motionFilterEl.addEventListener('input', (e) => {
  motionFilterKw = e.target.value;
  renderMotionList();
});

// 预览卡关闭
pcClose.addEventListener('click', () => {
  delete previewCardEl.dataset.pinned;
  previewCardEl.classList.add('hidden');
});
apClose.addEventListener('click', () => archivePreviewEl.classList.add('hidden'));
apExtract.addEventListener('click', () => {
  const path = lastArchivePreviewPath;
  if (!path) return;
  doExtractAndBrowse({ path, name: path.split(/[\\/]/).pop() });
});

// 键盘快捷键
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  else if (e.key === 'Backspace') {
    // 仅在非输入框中生效
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); goUp(); }
  } else if ((e.key === 'Escape' || e.key === 'F2') && !previewCardEl.classList.contains('hidden')) {
    e.preventDefault();
    delete previewCardEl.dataset.pinned;
    previewCardEl.classList.add('hidden');
  } else if (e.key === 'Escape' && !archivePreviewEl.classList.contains('hidden')) {
    archivePreviewEl.classList.add('hidden');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    if (activeTab === 'motions') { e.preventDefault(); motionFilterEl.focus(); }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    $('btn-refresh').click();
  }
});

// 双击 canvas 重置视角
canvas.addEventListener('dblclick', () => $('btn-reset-view').click());

// ---------- 启动 ----------
async function init() {
  try {
    const [defRes, motRes] = await Promise.all([api.getDefaultRoot(), api.getMotionRoot()]);
    if (!defRes.ok || !defRes.data) {
      setStatus('默认根目录获取失败', 'error');
      return;
    }
    defaultRootPath = defRes.data;
    motionRootPath = motRes.data || null;
    // 初始化面包屑栈
    navStack.back = [{ path: defaultRootPath, tab: 'models' }];
    navStack.forward = [];
    // 首次进入扫描模型库
    await navigateTo(defaultRootPath, 'models', false);
    // 同时扫描动作库（不切 tab）
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
    updateNavButtons();
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

// ---------- 冒烟测试钩子（仅 --smoke-test 使用） ----------
window.__mmdTest = {
  loadAndMeasure: async (filePath) => {
    const url = api.mmdUrl(filePath);
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, (e) => reject(e || new Error('load error')));
    });
    const box = new THREE.Box3().setFromObject(mesh);
    return { ok: true, size: box.getSize(new THREE.Vector3()).toArray().map((n) => n.toFixed(2)) };
  },
  renderShot: async (filePath) => {
    const url = api.mmdUrl(filePath);
    const mesh = await new Promise((resolve, reject) => {
      mmdLoader.load(url, resolve, undefined, (e) => reject(e || new Error('load error')));
    });
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
            out.step2 = {
              ok: true, ctor: t.image && t.image.constructor.name,
              w: t.image && t.image.width,
              src: t.image && t.image.src ? String(t.image.src).slice(0, 120) : 'no-src',
            };
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
};
