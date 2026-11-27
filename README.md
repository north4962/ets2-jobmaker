# ets2-jobmaker

Euro Truck Simulator 2 のセーブデータ (`game.sii`) を読み込み、好きな仕事 (貨物市場のオファー) を作成して書き戻すツールです。

- TypeScript + Vite + **Electron** のデスクトップアプリです (ブラウザでも動きます)。
- セーブ内にある約 5,000 件の既存オファーから、カーゴ・トレーラー・積載数の組み合わせや会社間の距離を自動で集計し、入力候補として出します。

## 使い方

1. ゲームを終了し、`Documents/Euro Truck Simulator 2/profiles/<プロファイル>/save/<セーブ>/game.sii` を**バックアップ**します。
2. [SII_Decrypt](https://github.com/TheLazyTomcat/SII_Decrypt) などで `game.sii` を復号化します (先頭が `SiiNunit` のテキストになります)。
3. アプリで `game.sii` を開きます (`Ctrl+O` / ドラッグ＆ドロップ可。ダイアログは ETS2 のプロファイルフォルダから始まります)。
4. 出発会社・カーゴ・配送先などを入力し「作成リストに追加」します。
   - **スロット**: 空きスロットがあれば自動で選ばれます。既存オファーの上書きや新規追加も選べます。
   - **トレーラー**: 選んだカーゴでセーブ内に実績のある組み合わせから選べます (直接入力も可)。
   - **距離**: 同じ区間 (会社間 → 都市間の順) の実績があれば自動入力されます。無い場合は手入力してください。
   - 「出発会社の現在のオファー」の「参考にする」で、既存の仕事の内容をフォームに読み込めます。
   - 実績のない組み合わせ (その会社が出荷しないカーゴ等) は警告を出します。作成はできますが、ゲーム側で無視される場合があります。
5. 「保存 (書き出し)」(`Ctrl+S`) で `game.sii` を保存します。
   - デスクトップ版では開いたファイルが保存先の初期値になり、上書き時は同じフォルダに `game.sii.<日時>.bak` のバックアップを自動作成します。
6. ゲームでそのセーブをロードし、出発会社の貨物市場から仕事を受けます。

> 変更していない部分は元ファイルとバイト単位で同一のまま出力されます。

## デスクトップアプリ (Electron)

### 開発

```bash
npm install
npm run electron:dev     # Vite 開発サーバー + Electron (ホットリロード)
npm run electron:start   # ビルドして Electron で起動
```

### 配布用ビルド

```bash
npm run dist:win         # Windows: インストーラー (NSIS) とポータブル版 exe → release/
npm run dist:mac         # macOS: dmg (macOS 上で実行)
npm run dist:linux       # Linux: AppImage
npm run dist:win-zip     # Windows 用 zip (Linux / macOS からでも Wine なしで作成可)
```

- Windows のインストーラー / ポータブル版は Windows 上でビルドしてください (Linux からは Wine が必要)。
- GitHub Actions (`.github/workflows/build-desktop.yml`) でも Windows 版をビルドできます。
  Actions タブから手動実行するか、`v0.1.0` のようなタグを push すると、成果物 (exe) がダウンロードできます。
- コード署名はしていないため、初回起動時に Windows SmartScreen の警告が出ることがあります。

## Web 版としての開発

```bash
npm run dev        # http://localhost:5173
npm test           # ユニットテスト
npm run build      # dist/ に静的ファイルを出力
```

実際のセーブデータでの往復テスト:

```bash
ETS2_SAVE=/path/to/game.sii npm test
```

## 構成

```
electron/main.cjs    Electron メインプロセス (ウィンドウ、メニュー、ファイルダイアログ、バックアップ付き保存)
electron/preload.cjs renderer に window.ets2JobmakerIO を公開 (contextIsolation + sandbox)
src/
  core/sii.ts        SII テキストのパーサ / シリアライザ (未変更ユニットは原文のまま出力)
  core/save.ts       会社・オファーの読み取り、カタログ集計、仕事の検証と書き込み
  platform/fileio.ts ファイル入出力の抽象化 (Electron 実装があればそれを、無ければブラウザ実装を使う)
  ui/style.css
  main.ts            画面
build/icon.png       アプリアイコン
tests/               vitest
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
