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
  /** 读取文本文件内容（只读前 N 字节，默认 2MB） */
  readTextFile: (filePath, maxBytes) => ipcRenderer.invoke('read-text-file', filePath, maxBytes),
  /** 本地路径 -> mmd:// URL */
  mmdUrl,
});
