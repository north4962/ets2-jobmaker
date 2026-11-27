// renderer に公開する API。src/platform/fileio.ts の FileIO interface と対応する。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ets2JobmakerIO', {
  kind: 'electron',
  open: () => ipcRenderer.invoke('ets2:open'),
  save: (suggestedName, text) => ipcRenderer.invoke('ets2:save', suggestedName, text),
  /** ドロップされた File のフルパスをメインプロセスに伝える (保存先の初期値になる) */
  notifyDropped: (file) => {
    try {
      const p = webUtils.getPathForFile(file);
      if (p) ipcRenderer.invoke('ets2:set-opened-path', p);
    } catch {
      /* 取得できなくても動作に支障はない */
    }
  },
  showInFolder: (filePath) => ipcRenderer.invoke('ets2:show-in-folder', filePath),
  /** メニューからの操作 ('open' | 'save') を受け取る */
  onMenu: (callback) => {
    const open = () => callback('open');
    const save = () => callback('save');
    ipcRenderer.on('menu:open', open);
    ipcRenderer.on('menu:save', save);
    return () => {
      ipcRenderer.off('menu:open', open);
      ipcRenderer.off('menu:save', save);
    };
  },
});
