/**
 * ファイル入出力の抽象化。
 * - ブラウザ版: File API / ダウンロード (browserIO)
 * - デスクトップ版 (Electron): electron/preload.cjs が window.ets2JobmakerIO を公開し、
 *   ネイティブのファイルダイアログ・上書き保存・自動バックアップを提供する
 */
export interface OpenedFile {
  name: string;
  /** デスクトップ版のみ: フルパス */
  path?: string;
  bytes: Uint8Array;
}

export interface SaveResult {
  saved: boolean;
  path?: string;
  /** 上書き前に作成したバックアップのパス */
  backupPath?: string | null;
}

export interface FileIO {
  kind: 'browser' | 'electron';
  open(): Promise<OpenedFile | null>;
  save(suggestedName: string, text: string): Promise<SaveResult>;
  notifyDropped?(file: File): void;
  showInFolder?(path: string): Promise<void>;
  onMenu?(callback: (action: 'open' | 'save') => void): () => void;
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
  kind: 'browser',
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
        return { saved: true };
      } catch (e) {
        if ((e as Error).name === 'AbortError') return { saved: false };
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return { saved: true };
  },
};

export const fileIO: FileIO = (typeof window !== 'undefined' && window.ets2JobmakerIO) || browserIO;
