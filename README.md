# ets2-jobmaker

Euro Truck Simulator 2 のセーブデータ (`game.sii`) を読み込み、好きな仕事 (貨物市場のオファー) を作成して書き戻すツールです。

- TypeScript + Vite + **Electron** のデスクトップアプリです (ブラウザでも動きます)。
- セーブ内にある約 5,000 件の既存オファーから、カーゴ・トレーラー・積載数の組み合わせや会社間の距離を自動で集計し、入力候補として出します。

## 使い方

1. ゲームを終了し、`Documents/Euro Truck Simulator 2/profiles/<プロファイル>/save/<セーブ>/game.sii` を**バックアップ**します。
2. アプリで `game.sii` を開きます (`Ctrl+O` / ドラッグ＆ドロップ可。ダイアログは ETS2 のプロファイルフォルダから始まります)。
   **暗号化されたままのファイルも自動で復号化されます** (下記「復号化」参照)。
3. 出発会社・カーゴ・配送先などを入力し「作成リストに追加」します。
   - **スロット**: 空きスロットがあれば自動で選ばれます。既存オファーの上書きや新規追加も選べます。
   - **トレーラー**: 選んだカーゴでセーブ内に実績のある組み合わせから選べます (直接入力も可)。
   - **距離**: 同じ区間 (会社間 → 都市間の順) の実績があれば自動入力されます。無い場合は手入力してください。
   - 「出発会社の現在のオファー」の「参考にする」で、既存の仕事の内容をフォームに読み込めます。
   - 実績のない組み合わせ (その会社が出荷しないカーゴ等) は警告を出します。作成はできますが、ゲーム側で無視される場合があります。
4. 「保存 (書き出し)」(`Ctrl+S`) で `game.sii` を保存します。
   - デスクトップ版では開いたファイルが保存先の初期値になり、上書き時は同じフォルダに `game.sii.<日時>.bak` のバックアップを自動作成します。
5. ゲームでそのセーブをロードし、出発会社の貨物市場から仕事を受けます。

> 変更していない部分は元ファイルとバイト単位で同一のまま出力されます。

## 復号化

開いたファイルの形式を自動判別し、テキスト形式に変換してから読み込みます。外部ツールは不要です。

| 形式 | 先頭 | 対応 |
| --- | --- | --- |
| テキスト | `SiiNunit` | そのまま読み込み |
| 暗号化 | `ScsC` | AES-256-CBC で復号 → zlib 展開 → 中身 (BSII / テキスト) を処理 |
| バイナリ | `BSII` | テキスト形式に変換 |
| 3nK | `3nK` | 未対応 (game.sii では使われない形式) |

- 保存はテキスト形式で行います (ゲームはテキスト形式の game.sii もそのまま読み込めます)。
  仕事を作らずに保存すれば、復号化だけを行うこともできます。
- 変換結果は SII_Decrypt と同じ書式 (CRLF 改行・同じ数値表記) になります。
- 暗号鍵とバイナリ形式の仕様は [SII_Decrypt](https://github.com/TheLazyTomcat/SII_Decrypt) (MPL-2.0) を参考に、TypeScript で実装し直しています (`src/core/aes.ts`, `src/core/bsii.ts`, `src/core/decrypt.ts`)。
- 実セーブで確認するテスト: `ETS2_SAVE=... npm test` は、テキストの game.sii を BSII + ScsC に変換したうえで復号し、元と完全に一致することを確認します。

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
- GitHub Actions (`.github/workflows/build-desktop.yml`) でも Windows 版をビルドできます。Actions タブから手動実行するとビルドのみ行い、成果物は実行結果ページからダウンロードできます。

### リリースの作成

`package.json` の `version` を上げて `main` にマージしたあと、同じバージョンのタグを push します。

```bash
git tag v0.1.1
git push origin v0.1.1
```

GitHub Actions が Windows 版をビルドし、そのタグ名の GitHub Release を作成してインストーラー / ポータブル版の exe を添付します (リリースノートは自動生成)。

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
  core/decrypt.ts    形式判別と復号 (ScsC → BSII / テキスト)
  core/aes.ts        AES 復号 (CBC)
  core/bsii.ts       バイナリ SII → テキスト変換
  platform/fileio.ts ファイル入出力の抽象化 (Electron 実装があればそれを、無ければブラウザ実装を使う)
  ui/style.css
  main.ts            画面
build/icon.png       アプリアイコン
tests/               vitest (tests/helpers/bsii-encode.ts はテスト用の暗号化・BSII エンコーダ)
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
