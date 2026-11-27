import { defineConfig } from 'vite';

// base: './' にしておくと、ビルド結果を Electron / Tauri から file:// で読み込める
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
});
