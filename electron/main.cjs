// Electron メインプロセス
// - 本番: dist/index.html を読み込む
// - 開発: --dev 指定時は Vite の開発サーバー (VITE_DEV_SERVER_URL) を読み込む
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const isDev = process.argv.includes('--dev');
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

/** 最後に開いた game.sii のパス (保存ダイアログの初期値に使う) */
let lastOpenedPath = null;

function ets2ProfilesDir() {
  return path.join(app.getPath('documents'), 'Euro Truck Simulator 2', 'profiles');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ETS2 Job Maker',
    backgroundColor: '#15181e',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外部リンクは既定のブラウザで開き、アプリ内では新しいウィンドウを作らない
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(isDev ? DEV_URL : 'file://')) e.preventDefault();
  });

  // 作成リストが残っているときの終了確認 (renderer の beforeunload で preventDefault される)
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['終了する', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: '確認',
      message: '保存していない仕事が作成リストに残っています。終了しますか？',
    });
    if (choice === 0) e.preventDefault(); // preventDefault で unload の阻止を無視して閉じる
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  return win;
}

// ---- IPC: ファイル入出力 ---------------------------------------------------

ipcMain.handle('ets2:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const defaultPath = lastOpenedPath
    ? path.dirname(lastOpenedPath)
    : (await exists(ets2ProfilesDir())) ? ets2ProfilesDir() : app.getPath('documents');
  const r = await dialog.showOpenDialog(win, {
    title: '復号化済みの game.sii を開く',
    defaultPath,
    properties: ['openFile'],
    filters: [
      { name: 'SII ファイル', extensions: ['sii'] },
      { name: 'すべてのファイル', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readFileForRenderer(r.filePaths[0]);
});

async function readFileForRenderer(filePath) {
  const bytes = await fs.readFile(filePath);
  lastOpenedPath = filePath;
  return { name: path.basename(filePath), path: filePath, bytes: new Uint8Array(bytes) };
}

// ドラッグ＆ドロップされたファイルのフルパス記録用 (保存先の初期値に使う)
ipcMain.handle('ets2:set-opened-path', (_e, filePath) => {
  if (typeof filePath === 'string' && filePath) lastOpenedPath = filePath;
});

ipcMain.handle('ets2:save', async (e, suggestedName, text) => {
  if (typeof text !== 'string') throw new Error('invalid text');
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: 'game.sii を保存',
    defaultPath: lastOpenedPath || path.join(app.getPath('documents'), suggestedName || 'game.sii'),
    filters: [{ name: 'SII ファイル', extensions: ['sii'] }],
  });
  if (r.canceled || !r.filePath) return { saved: false };

  // 既存ファイルを上書きする場合は、同じフォルダにタイムスタンプ付きのバックアップを残す
  let backupPath = null;
  if (await exists(r.filePath)) {
    backupPath = `${r.filePath}.${timestamp()}.bak`;
    await fs.copyFile(r.filePath, backupPath);
  }
  // 途中で失敗してもセーブを壊さないよう、一時ファイルに書いてから置き換える
  const tmp = `${r.filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, r.filePath);
  lastOpenedPath = r.filePath;
  return { saved: true, path: r.filePath, backupPath };
});

ipcMain.handle('ets2:show-in-folder', (_e, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
});

// ---- メニュー -------------------------------------------------------------

function buildMenu() {
  const send = (channel) => (_item, win) => win?.webContents.send(channel);
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: 'game.sii を開く…', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { label: '保存 (書き出し)…', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { type: 'separator' },
        {
          label: 'ETS2 プロファイルフォルダを開く',
          click: async () => {
            const dir = ets2ProfilesDir();
            if (await exists(dir)) shell.openPath(dir);
            else dialog.showMessageBox({ type: 'info', message: `フォルダが見つかりません:\n${dir}` });
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '終了' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全画面表示' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
