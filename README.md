# ets2-jobmaker

Euro Truck Simulator 2 のセーブデータ (`game.sii`) を読み込み、好きな仕事 (貨物市場のオファー) を作成して書き戻すツールです。

- TypeScript + Vite で作った Web アプリです。ブラウザで動き、後から **Electron / Tauri でそのままデスクトップアプリ化** できる構成にしています。
- セーブ内にある約 5,000 件の既存オファーから、カーゴ・トレーラー・積載数の組み合わせや会社間の距離を自動で集計し、入力候補として出します。

## 使い方

1. ゲームを終了し、`Documents/Euro Truck Simulator 2/profiles/<プロファイル>/save/<セーブ>/game.sii` を**バックアップ**します。
2. [SII_Decrypt](https://github.com/TheLazyTomcat/SII_Decrypt) などで `game.sii` を復号化します (先頭が `SiiNunit` のテキストになります)。
3. アプリで `game.sii` を開きます (ドラッグ＆ドロップ可)。
4. 出発会社・カーゴ・配送先などを入力し「作成リストに追加」します。
   - **スロット**: 空きスロットがあれば自動で選ばれます。既存オファーの上書きや新規追加も選べます。
   - **トレーラー**: 選んだカーゴでセーブ内に実績のある組み合わせから選べます (直接入力も可)。
   - **距離**: 同じ区間 (会社間 → 都市間の順) の実績があれば自動入力されます。無い場合は手入力してください。
   - 「出発会社の現在のオファー」の「参考にする」で、既存の仕事の内容をフォームに読み込めます。
   - 実績のない組み合わせ (その会社が出荷しないカーゴ等) は警告を出します。作成はできますが、ゲーム側で無視される場合があります。
5. 「保存 (書き出し)」で `game.sii` を出力し、元の場所に上書きします。
6. ゲームでそのセーブをロードし、出発会社の貨物市場から仕事を受けます。

> 変更していない部分は元ファイルとバイト単位で同一のまま出力されます。

## 開発

```bash
npm install
npm run dev        # 開発サーバー (http://localhost:5173)
npm test           # ユニットテスト
npm run build      # dist/ に静的ファイルを出力
```

実際のセーブデータでの往復テスト:

```bash
ETS2_SAVE=/path/to/game.sii npm test
```

## 構成

```
src/
  core/sii.ts        SII テキストのパーサ / シリアライザ (未変更ユニットは原文のまま出力)
  core/save.ts       会社・オファーの読み取り、カタログ集計、仕事の検証と書き込み
  platform/fileio.ts ファイル入出力の抽象化 (ブラウザ実装)
  ui/style.css
  main.ts            画面
tests/               vitest
```

`src/core` は DOM に依存しないため、Electron のメインプロセスや CLI からもそのまま使えます。

## デスクトップアプリ化

`vite.config.ts` は `base: './'` なので、`dist/` を Electron / Tauri から読み込めます。
ネイティブのファイルダイアログを使う場合は、`FileIO` interface (`src/platform/fileio.ts`) を満たすオブジェクトを
preload で `window.ets2JobmakerIO` として公開すれば、UI 側の変更なしで差し替わります。

```ts
// Electron preload の例
contextBridge.exposeInMainWorld('ets2JobmakerIO', {
  open: () => ipcRenderer.invoke('open-save'),          // { name, bytes } | null
  save: (name, text) => ipcRenderer.invoke('save-file', name, text), // boolean
});
```

## 書き込まれる内容

`company : company.volatile.<会社>.<都市>` の `job_offer` 配列が指す `job_offer_data` ユニットを作成 / 上書きします。

| 項目 | 内容 |
| --- | --- |
| target | 配送先 `<会社>.<都市>` |
| expiration_time | 現在の `economy.game_time` + 掲載期限 (分) |
| urgency | 0 標準 / 1 重要 / 2 緊急 |
| shortest_distance_km, ferry_time, ferry_price | 距離・フェリー |
| cargo, trailer_variant, trailer_definition, units_count, fill_ratio | 貨物とトレーラー |
| company_truck | クイックジョブ用の会社トラック |

新規追加時の `_nameless` ID は、セーブ内の最大値より大きい未使用の値を採番します。
