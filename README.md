# Shinano

Microsoft 365 のデモ環境向けに、**複数のプロファイルのタブを、1 つのアプリウィンドウに混在させる** Chromium ベースのデスクトップブラウザーです。Electron + TypeScript + Vite の小さな日本語 UI で構成しています。

```text
1 つの Shinano ウィンドウ
[営業 A | Outlook] [営業 B | Outlook] [営業 A | Teams] [管理者 C | Admin]
```

通常の Edge の「プロファイルごとに別ウィンドウ」とは異なります。同じプロファイルに属するタブは Cookie・サイトデータを共有し、別プロファイルとは分離します。タブを切り替えても、そのタブのセッションを差し替えません。

**初期実装です。実 Microsoft 365 へのサインインや全サービスの互換性を確認・保証した製品ではありません。** MFA、条件付きアクセス、権限、ライセンスは通常どおり必要です。Microsoft が提供するブラウザーではありません。

## 起動

Node.js **24 LTS** と npm が必要です。初回の依存関係インストールと Electron バイナリー取得にはネットワーク接続が必要です。

```sh
npm ci
npm run dev
```

開発時は `127.0.0.1:5173` の Vite と Electron を起動します。UI は HMR に対応します。main / preload の変更後は再起動してください。通常はウィンドウを閉じて「保存して終了」を選択すると、Vite も終了します。

コンパイル済みのアプリを起動する場合:

```sh
npm run build
npm start
```

`dist/` に main・preload・UI を生成します。`npm start` は開発サーバーを使わず、ローカルの `shinano://app/` から UI を読み込みます。

ホスト OS 向けのローカルアプリバンドル:

```sh
npm run package
```

`release/Shinano-<platform>-<arch>/` に生成します。macOS / Apple Silicon では `release/Shinano-darwin-arm64/Shinano.app` です。署名・公証・インストーラー・自動更新・GitHub Release への公開は設定していません。別 OS 向けのビルドや起動確認を行ったことにはなりません。

## 使い方と実装範囲

1. 「プロファイル」から表示名と色を設定します。初回は「デモ A」が 1 件あります。名前の変更でも内部 ID と保存領域は変わりません。
2. 「+」でプロファイル選択画面を開きます。使用するプロファイルを明示的に選んで URL またはサービスのショートカットを開きます。空のタブも作成できます。
3. 各タブとアドレスバー横でプロファイル名・色を確認できます。別プロファイルのタブを間に作成でき、同じウィンドウで切り替えられます。

URL 入力、戻る・進む、再読み込み・停止、タイトルと読み込み状態、読み込みエラー、タブの切り替え・閉じる操作に対応します。URL のスキーム省略時は原則 HTTPS、`localhost` / loopback は HTTP と解釈します。検索エンジンへの自動検索は行いません。

| 操作 | ショートカット |
| --- | --- |
| アドレスにフォーカス | `Cmd/Ctrl+L` |
| プロファイルを選んで新しいタブ | `Cmd/Ctrl+T` |
| アクティブなタブを閉じる | `Cmd/Ctrl+W` |
| 再読み込み | `Cmd/Ctrl+R` |
| 戻る・進む | `Alt+Left` / `Alt+Right` |
| 次・前のタブ | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 1〜8 番目・最後のタブ | `Cmd/Ctrl+1`〜`8` / `9` |
| Web ページの拡大・縮小・リセット | `Cmd/Ctrl+Plus` / `-` / `0` |

ショートカットの実機確認は macOS のみです。ウィンドウ全体の終了時には未保存の入力が失われ得ることを確認します。個別タブの `beforeunload` 要求にはページを離れるかどうかの確認を出します。

Microsoft 365、Outlook、Teams、Microsoft 365 管理センター、Entra、Intune のショートカットは単に Web ページを開きます。**サインイン、ライセンスの付与、テナントの設定変更は行いません。** 表示名・色はローカルなメタデータであり、Web サイト上の現在のログイン ID の証明ではありません。

上限は 20 プロファイル、50 タブです。非アクティブなタブを破棄してメモリーを解放する機能はないため、多数の重いページを開くとメモリーを使用します。

## 保存場所・復元・削除

既定の保存場所は Electron の `appData` 配下に作成する **Shinano 専用の `userData`** です。ソースリポジトリには保存しません。

| OS | 既定の場所 |
| --- | --- |
| macOS | `~/Library/Application Support/Shinano/` |
| Windows | `%APPDATA%\Shinano\` |
| Linux | `$XDG_CONFIG_HOME/Shinano/`（通常 `~/.config/Shinano/`） |

```text
Shinano/
  state.json                         プロファイル・タブ ID・接続先オリジン・削除待ち ID
  sessions/Partitions/shinano-<uuid>/ Electron が管理するプロファイルの保存領域
```

開発・テスト時に別の保存場所が必要なら、環境変数 `SHINANO_USER_DATA_DIR` に **専用の新規ディレクトリの絶対パス**を指定します。既存の Edge / Chrome データやリポジトリを指定しないでください。自動テストは一時ディレクトリを作成・削除します。

- プロファイル ID とタブ ID は別々の UUID です。各プロファイルは `persist:shinano-<profile UUID>` の永続セッションに対応します。タブの作り直し・名前の変更ではこの対応を変更しません。
- `state.json` は一時ファイルへの書き込み、`fsync`、rename で置換します。壊れた保存データや未対応のバージョンはエラーにし、自動初期化・上書きしません。
- **復元するのはタブの ID・順序・プロファイルの割り当て・アクティブなタブ・接続先のオリジンだけです。** たとえば `https://example.com/mail/123?code=...#...` は `https://example.com/` として復元します。認証コードがパスにも含まれ得るため、パス・クエリ・フラグメント・ページタイトルはメタデータに保存しません。**元のページ内画面や URL を完全復元する機能ではありません。**
- Cookie・localStorage・IndexedDB などは Electron がセッション内で管理します。メタデータへの Cookie・パスワード・トークンの複製やエクスポートは行いません。プロファイル名にも秘密情報を入力しないでください。
- 永続 Cookie とサイトストレージの再起動後の維持をローカル fixture で確認しています。ただし、有効期限、サーバー側失効、サイトの再認証要件、MFA、条件付きアクセスはそのまま適用されます。セッション Cookie の再起動後の維持は保証しません。`sessionStorage` は通常のブラウザーと同様に**タブ単位**であり、同じプロファイルだから共有されるわけではありません。

プロファイル削除はネイティブの確認ダイアログを経て、そのプロファイルの全タブを閉じ、ローカルの Cookie・サイトストレージ・キャッシュ・HTTP 認証キャッシュなどを消去します。先に削除予定の ID を保存し、Electron が保持するファイルハンドルとの競合を避けるため、残存するプロファイルディレクトリは**次回起動時、セッションを開く前**に除去します。途中で失敗した場合も明示して再試行します。

削除対象は Shinano 所有のローカルデータのみです。**Entra ユーザー、クラウドのアカウント、Edge / Chrome のプロファイル、ユーザーが保存したダウンロードファイルは削除しません。** クラウド側のセッション失効やサインアウトも代行しません。既存ブラウザーから Cookie を取り込む機能はありません。

## 構成とセキュリティ境界

```text
main process
  BrowserWindow（1 個）
    信頼されたローカル UI + sandboxed preload（専用の非永続 UI session）
    アクティブな WebContentsView（UI の下の領域のみ）
  Tab A1 ─┐
  Tab A2 ─┴─ Profile A の永続 session
  Tab B1 ─── Profile B の永続 session
```

- リモートページは `WebContentsView` で表示します。非推奨の `BrowserView` や、Microsoft のサインイン画面を包む iframe は使用しません。
- 非アクティブな view はウィンドウから外し、アクティブな view のみ操作 UI の下（154 DIP 以降）に配置します。プロファイル管理等のローカル画面を表示する間も view を外します。リサイズ・タブ削除・ウィンドウ終了に合わせて view / WebContents を明示的に管理します。
- **リモートページに preload や特権 IPC API はありません。** `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true` を維持します。アプリ全体の sandbox も有効にします。
- ローカル UI のみが型付き `window.shinano` API を持ちます。main は IPC ごとに WebContents の同一性・main frame・正確な UI URL を確認し、コマンドの種別・許可された項目・UUID・値を検証します。任意の IPC チャネル、ファイルアクセス、コード実行、session 操作は公開しません。
- ローカル UI は DOM API で構築し、ページタイトル・プロファイル名・ダウンロード名等をテキストノードや `value` として設定します。動的な文字列を HTML として解釈する描画は行いません。
- 配布ビルドの UI は UI 専用セッションの `shinano://app/` と厳格な CSP から読み込みます。リモートセッションにこのプロトコルのハンドラーを登録しません。UI の外部ナビゲーション、iframe、ポップアップも拒否します。開発時のみ loopback の Vite / HMR を許可します。
- TLS エラーを無視する設定、Web セキュリティの無効化、Microsoft 認証フローの書き換え、User-Agent 偽装、認証情報のログ出力、テレメトリーは実装していません。

### ポップアップ

[`setWindowOpenHandler`](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler) の [`createWindow`](https://www.electronjs.org/docs/latest/api/structures/window-open-handler-response) で、Electron が渡したネイティブの `options.webContents` を `WebContentsView` に引き継ぎます。**単に `deny` して URL を再読み込みする実装ではありません。** ネイティブ guest の opener・名前付きターゲット・POST を維持し、作成元プロファイルのタブとして同じウィンドウに追加します。

背景タブ等、ネイティブ guest が渡されない経路だけは、渡された webPreferences と referrer / POST body を引き継いで読み込みます。`about:blank` のポップアップへの書き込み、`postMessage`、`window.close()` もローカルで確認しています。通常の新規タブは opener を閉じても存続する設定です。

これは実 Microsoft 365 OAuth の互換性の証明ではありません。COOP 等が opener を切り離す場合はサイトのポリシーに従います。未対応のプロトコルや認証ハンドオフには通知を表示し、別経路へ黙ってフォールバックしません。

### 権限・外部アプリ・ダウンロード

- この版では**サイト権限を拒否**します。カメラ、マイク、画面共有、位置情報、通知、デバイスアクセス等を許可する UI はありません。要求時には未対応であることを操作 UI に通知します。通常のメニューによるコピー・貼り付けと、サイトの Clipboard API の権限は別です。
- トップレベルのページとポップアップは HTTP / HTTPS / `about:blank` のみです。`msteams:`、`mailto:`、Office アプリのプロトコル、`file:`、`data:`、`blob:` 等への遷移は拒否し、自動で OS アプリを起動しません。Web ページ内の非特権 `data:` / `blob:` サブフレームは許可します。
- クライアント証明書の自動選択、HTTP / プロキシ資格情報の入力は未対応として拒否・通知します。通常の Microsoft の Web サインインとは異なる認証経路です。
- ダウンロードは**保存先ダイアログで明示的に選択された場所のみ**に保存し、ファイルを自動で開きません。同時 3 件まで、起動中の直近 30 件を表示します。再起動後のダウンロード履歴・再開は未対応です。

プロファイル分離は別 OS ユーザーの境界ではありません。同じ OS ユーザーとして動くプロセスや `userData` を読める人からの保護、サイトストレージ全体の暗号化、匿名性は保証しません。認証済みの `userData`、トレース、画面キャプチャをリポジトリや共有フォルダーへコピーしないでください。

## 検証

```sh
npm run typecheck
npm test
npm run test:e2e
# 上記と production build をまとめて実行
npm run check
```

E2E は Playwright から**実際の Electron プロセス**と loopback HTTP fixture を起動します。session のモックや partition 名の比較だけではありません。実 Microsoft 365 アカウントや管理 API は使用しません。Cookie・localStorage・IndexedDB の値はテスト専用の架空データです。ネイティブダイアログの「選択結果」のみ自動化し、実セッション・ダウンロード・保存処理を通します。

対象は日本語 UI、Cookie / localStorage / IndexedDB の同一プロファイル共有・異なるプロファイルでの分離、タブ単位の sessionStorage、A/B 混在の単一ウィンドウ、native opener / 名前付きターゲット / POST / 背景タブ / cross-origin postMessage、実プロセス再起動、確認付き削除と他プロファイルの保持、表示領域・WebContents の後始末、ナビゲーション・エラー・停止・ショートカット、権限拒否・外部プロトコル拒否、ダウンロードです。保存メタデータの検証・破損時の扱い・削除パスの制限には unit tests もあります。

**検証環境:** macOS 26.6.2 / Apple Silicon (`arm64`)、開発用 Node.js 24.21.0、Electron **44.2.0** / Chromium **152.0.7977.76**。GUI セッションが必要です。Windows / Linux のコードパスとバンドルの実機検証は行っていません。

現在のソースでは型チェック・9 件の unit tests・15 件の Electron E2E が通過しています。HTML に見えるプロファイル名・ページタイトル・ダウンロード名が実際の UI DOM で文字どおり表示され、要素やコードにならない回帰テストも含みます。初期実装の `.app` では当時の 13 件が通過し、実際の起動・セッション分離・プロセス再起動を確認しました。`npm run dev` の起動と loopback の開発サーバー応答も確認しています。

生成した macOS アプリにも同じテストを実行できます（先に `npm run package`）:

```sh
SHINANO_TEST_EXECUTABLE="$PWD/release/Shinano-darwin-arm64/Shinano.app/Contents/MacOS/Shinano" \
  npm exec -- playwright test
```

テストデータは OS の一時ディレクトリ、レポート等は `.gitignore` 対象の `test-results/` に置きます。スクリーンショットはローカルのスタート画面だけで、実認証状態を記録するテストはありません。

### バージョンの取得制約

依存関係は `package-lock.json` で固定しています。lockfile に環境固有の registry URL を保存せず、利用者が設定した npm registry で解決します。

実装時の環境の npm フィードには Electron 44.2.0 までしか提供されておらず、公式リリース一覧にある 44.3.0 は取得できませんでした。直接の npm registry 接続も失敗したため、**取得可能な安定版系列の 44.2.0 を採用**しています。Electron の alpha 版や非公式ミラーへの切り替え、ネットワーク制約の迂回は行っていません。44.3.0 との差の安全性・互換性は未評価です。最新パッチを取得可能な環境で、依存関係の更新と同じ検証が必要です。

## 未検証と非対応の区別

| 項目 | 状態 |
| --- | --- |
| 実 Microsoft 365 サインイン、MFA、条件付きアクセス、各サービスの Web UI | **未検証**。ローカルのポップアップ試験から互換性を断言しません |
| Edge の企業・デバイス統合、WAM / PRT、管理対象ブラウザーのデバイス情報 | **継承しません**。通常の Edge と同じ SSO / 適合性を前提にできません |
| Teams のカメラ・マイク・画面共有 | **権限を拒否するため非対応**。チャット等も実サービスでは未検証です |
| クライアント証明書、HTTP / プロキシ認証ダイアログ、外部アプリへの認証ハンドオフ | **非対応**。拒否して通知します |
| Windows / Linux、企業配布、署名・公証、OS 固有の認証機器 | **未検証**。リリース配布の設定もありません |
| 元の deep link・入力状態・閲覧履歴の完全復元 | **非対応**。オリジンへの復元のみです |
| 検索連携、拡張機能、パスワードマネージャー、タブ並べ替え、専用 PDF / 印刷 UI | **この初期版の実装範囲外**です |
| CDX テナントのローカライズ、ユーザー削除・シード、Microsoft 365 全体の設定変更 | **実装・実行していません**。別途の作業と承認が必要です |

プロジェクトのライセンスはまだ指定していません。依存ソフトウェアのライセンスはそれぞれに従います。
