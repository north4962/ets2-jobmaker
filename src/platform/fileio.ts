/**
 * ファイル入出力の抽象化。
 * ブラウザ版は File API / ダウンロードを使う。デスクトップ化 (Electron / Tauri) の際は
 * この interface を満たす実装を用意して main.ts で差し替えるだけでよい。
 *   例: Electron なら preload で ipcRenderer.invoke('open-save') などを公開し、
 *       window.ets2JobmakerIO として渡す。
 */
export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileIO {
  open(): Promise<OpenedFile | null>;
  save(suggestedName: string, text: string): Promise<boolean>;
}

declare global {
  interface Window {
    /** デスクトップ版でネイティブ実装を注入するためのフック */
    ets2JobmakerIO?: FileIO;
    showSaveFilePicker?: (opts: unknown) => Promise<{
      createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>;
    }>;
  }
}

export const browserIO: FileIO = {
  open() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.sii,.txt';
      input.onchange = async () => {
        const f = input.files?.[0];
        resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
      };
      input.click();
    });
  },
  async save(name, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'SII file', accept: { 'text/plain': ['.sii'] } }],
        });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return true;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return false;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  },
};

export const fileIO: FileIO = (typeof window !== 'undefined' && window.ets2JobmakerIO) || browserIO;
