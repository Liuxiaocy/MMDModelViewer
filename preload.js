'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 构造 mmd:// URL：将 Windows 绝对路径映射为协议 URL
// 形如 mmd://local/D:/素材/3D模型/a.pmx
function mmdUrl(filePath) {
  if (!filePath) return '';
  // D:\素材\xxx -> D:/素材/xxx
  const normalized = filePath.replace(/\\/g, '/');
  return 'mmd://local/' + normalized;
}

contextBridge.exposeInMainWorld('mmdAPI', {
  /** 扫描目录，返回目录树 */
  scanDir: (rootPath) => ipcRenderer.invoke('scan-dir', rootPath),
  /** 单层扫描某目录直接子项（面包屑导航） */
  scandirFlat: (dirPath) => ipcRenderer.invoke('scandir-flat', dirPath),
  /** 解压压缩包到临时目录，返回 { dest, tree } */
  extractArchive: (archivePath) => ipcRenderer.invoke('extract-archive', archivePath),
  /** 不解压仅列出压缩包条目 */
  listArchiveContents: (archivePath) => ipcRenderer.invoke('list-archive-contents', archivePath),
  /** 弹出目录选择框 */
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  /** 原生文件选择对话框（选模型/压缩包/动作文件） */
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  /** 保存截图 dataURL 到磁盘 */
  saveScreenshot: (dataUrl, defaultName) => ipcRenderer.invoke('save-screenshot', dataUrl, defaultName),
  /** 默认模型根目录 */
  getDefaultRoot: () => ipcRenderer.invoke('get-default-root'),
  /** 动作库根目录（<默认根>/动作） */
  getMotionRoot: () => ipcRenderer.invoke('get-motion-root'),
  /** 场景模型根目录（<默认根>/场景） */
  getSceneRoot: () => ipcRenderer.invoke('get-scene-root'),
  /** 读取文本文件内容（只读前 N 字节，默认 2MB） */
  readTextFile: (filePath, maxBytes) => ipcRenderer.invoke('read-text-file', filePath, maxBytes),
  /** 本地路径 -> mmd:// URL */
  mmdUrl,
  /** ammo.wasm 所在目录绝对路径（用于布料物理 mmd:// 加载） */
  getAmmoLibsDir: () => ipcRenderer.invoke('get-ammo-libs-dir'),

  /** ========== 缓存资源识别 & 管理 ========== */

  /** 返回缓存根目录 / 子目录绝对路径与当前总占用字节
   * @returns {Promise<{root:string, models:string, motions:string, thumbs:string, tmp:string, totalSize:number}>}
   */
  getCacheDirInfo: () => ipcRenderer.invoke('get-cache-dir-info'),

  /** 开始资源扫描（文件遍历 + 压缩包内部条目识别，不复制）
   * @param {{roots:string[], intoArchives?:boolean}} p
   * @returns {Promise<{taskId:string}>} taskId 用于取消与订阅进度
   */
  startResourceScan: (p) => ipcRenderer.invoke('start-resource-scan', p),

  /** 取消指定扫描或缓存阶段任务
   * @param {string} taskId
   * @returns {Promise<{ok:boolean}>}
   */
  cancelResourceScan: (taskId) => ipcRenderer.invoke('cancel-resource-scan', taskId),

  /** 执行勾选的候选资源 → 复制到 cache/models 或 cache/motions
   * @param {{taskId:string, ids:string[]}} payload
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  cacheSelectedResources: (payload) => ipcRenderer.invoke('cache-selected-resources', payload),

  /** 返回 index.json 完整结构与计算总大小
   * @returns {Promise<{index:{version:number, items:any[]}, totalSize:number}>}
   */
  getCacheIndex: () => ipcRenderer.invoke('get-cache-index'),

  /** 删除指定项（同步删除磁盘文件 + thumb + index 条目）
   * @param {string[]} ids
   * @returns {Promise<{deleted:string[], failed:string[]}>}
   */
  deleteCacheItems: (ids) => ipcRenderer.invoke('delete-cache-items', ids),

  /** 按范围清空缓存
   * @param {'models'|'motions'|'all'} scope
   * @returns {Promise<{removed:number, freedBytes:number}>}
   */
  clearCache: (scope) => ipcRenderer.invoke('clear-cache', scope),

  /** 保存缩略图 PNG 并关联到 index 条目
   * @param {{id:string, base64Png:string}} p
   * @returns {Promise<{ok:boolean, thumbPath?:string, error?:string}>}
   */
  writeCacheThumb: (p) => ipcRenderer.invoke('write-cache-thumb', p),

  /** 事件订阅 —— 扫描进度：{taskId, done:number, total:number, currentDir:string} */
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_e, payload) => cb(payload)),
  /** 事件订阅 —— 扫描结束：
   *  {taskId, candidates:[{id,name,ext,sourcePath,sourceType,archiveEntry?,sizeEstimate}],
   *   totalCount:number, totalSize:number, cancelled?:boolean, error?:string}
   */
  onScanDone:     (cb) => ipcRenderer.on('scan-done',     (_e, payload) => cb(payload)),
  /** 事件订阅 —— 缓存复制进度：{taskId, done:number, total:number, currentName:string, succeeded:boolean, error?:string} */
  onCacheProgress:(cb) => ipcRenderer.on('cache-progress',(_e, payload) => cb(payload)),
  /** 事件订阅 —— 缓存复制结束：{taskId, summary:{ok:number, fail:number, indexVersion:number}, error?:string} */
  onCacheDone:    (cb) => ipcRenderer.on('cache-done',    (_e, payload) => cb(payload)),
});
