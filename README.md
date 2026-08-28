# backlog-cli

Backlog REST API v2 を **Node.js だけで叩く**、エージェント向けのワンショット CLI スキル。

## なぜこれが要るか

公式 MCP サーバー（nulab/backlog-mcp-server）は tool overload / best-effort トークン消費 / stdio 依存 / Docker 必要など運用上の問題がある。このスキルはそれらを排除した**ワンショット CLI 形態**の代替。常駐サーバー不要、1コマンドで結果を返す。差別化は「MCP サーバーではなく CLI スキル」であること（言語が Node かどうかは無関係）。

## 必要なもの

**Node.js 18+ のみ**（npm 依存ゼロ・jq / curl / bash 不要）。インストーラ `install.mjs` の実行にも Node が要る。

## 対応プラットフォーム

Windows / macOS / Linux（同一動作）

## インストール（コピー方式）

このスキルは各プロジェクトやグローバルの skills ディレクトリに**コピー**して使う（symlink しない）。

リポジトリを一度取得し、インストーラでコピー:

```sh
git clone https://github.com/RyoheiKawamon-idealive/backlog-cli.git
cd backlog-cli

# 指定プロジェクトの .codex/skills と .claude/skills へコピー
node install.mjs --project /path/to/yourrepo

# グローバル（~/.codex/skills と ~/.claude/skills）へ
node install.mjs --global

# 片方だけ
node install.mjs --project /path/to/yourrepo --claude
```

手動コピーでも可：`backlog-cli/` フォルダを対象の `.codex/skills/` か `.claude/skills/` にコピーするだけ。

### 更新

同じ install コマンドを再実行する。コードは上書きされ、**コピー先のローカル設定 `.backlog-perms` は温存**される。

```sh
cd backlog-cli && git pull
node install.mjs --project /path/to/yourrepo
```

### 権限を対話設定（任意）

`--perms` を付けると、インストール後に権限をチェックボックスで設定できる（↑↓移動 / Space で `[x]` 切替 / Enter 確定）:

```sh
node backlog-cli/install.mjs --project /path/to/yourrepo --perms
```

## セットアップ（秘密の渡し方）

**いちばん簡単（推奨）: 対話ウィザード** — ドメイン / APIキー / 既定PJ を入力するだけ（**スペース名は一切聞かない**・アカウントは自動取得）。**インストール時に自動起動**（未設定→入力、設定済み→現状表示して「変更する？[y/N]」だけ）。手動なら:

```sh
node ~/.codex/skills/backlog-cli/backlog.mjs setup
```

**単一スペース**の場合は `--space` を指定しなくても必ず通る（唯一の設定ファイルに自動フォールバック）。**複数ドメイン/スペース**は、ウィザードで「別のスペースを追加」すると**ドメインのサブドメインから別名を自動生成**（例: `acme.backlog.com` → 別名 `acme`）して `backlog-cli.<別名>.env` に保存される:

```sh
node ~/.codex/skills/backlog-cli/backlog.mjs --space acme inspect SOMEKEY-1
```

### リポジトリごとにスペース/PJを固定（AIに判断させない）

Backlog ユーザーは**複数ドメイン（組織）**に所属し、各ドメイン内で**複数PJ**に入っていることがある。両方使えるようにしつつ、「このリポはこの組織・このPJ」を**リポ側で確定**しておけば、AI（や人）が毎回選ばずに済む。

リポルートに **`.backlog-cli.json`**（非秘密・コミット可）を置く。**多くの場合（単一スペース）は `project` だけでよい**:

```json
{ "project": "MYPROJ" }
```

複数スペースを使い分けるリポだけ、どのスペースかを `space` で固定する:

```json
{ "space": "acme", "project": "MYPROJ" }
```

- `project` → 既定PJ（`search`/`create` の `--project` 省略時に使用）。
- `space` → **複数スペース運用のときだけ**指定する。値は**ドメインのサブドメインから自動生成された別名**（例 `acme.backlog.com` → `acme`、ファイルは `~/.config/agent-skills/backlog-cli.acme.env`）。利用可能な別名は `config` の「他に切替可能なスペース」で確認できる。
  - **単一スペースなら `space` は書かない**。既定 `backlog-cli.env`（無ければ唯一の設定ファイル）に自動フォールバックする。`space` を明示すると `backlog-cli.<space>.env` を厳密に探すため、その別名ファイルが無いと「未設定」になる。
- CLI は **cwd から上方に辿って**このファイルを探す。`config` の「リポ設定」で何が効いているか確認できる。
- 解決順は **`--space`/`--project`（明示）> リポ `.backlog-cli.json` > env > ユーザー既定**。別組織/別PJを触るときだけ明示で上書き。
- **秘密分離**: 鍵はリポに置かない（このファイルは別名だけ）。鍵は各自の `~/.config` に別名つきで持つ。だからチームでリポに選択を共有しても安全（鍵が書かれていたら警告して無視する）。

**手動で書く場合**（ウィザードを使うなら不要）— ユーザー単位の単一ファイルに集約（秘密をコピーに置かない）:

```sh
mkdir -p ~/.config/agent-skills
cat > ~/.config/agent-skills/backlog-cli.env <<'EOF'
BACKLOG_DOMAIN=your-space.backlog.jp
BACKLOG_API_KEY=<あなたの個人 API キー>
# 任意（迷い消し）: よく使うPJ/自分のIDを入れておくと agent が調べずに済む
#BACKLOG_PROJECT=123456         # 既定プロジェクトの数値ID（search/create の --project 省略可）
#BACKLOG_MY_USER_ID=999999      # 自分のユーザーID（--assignee me を通信なしで解決）
EOF
chmod 600 ~/.config/agent-skills/backlog-cli.env
```

読込順は **`環境変数` → `~/.config/agent-skills/backlog-cli.env`**（先に入った値が有効・env が最優先）。**秘密はスキルのコピー内には置かない**（コピーに鍵を分散させない）。

- **環境変数**: CI / 上級者向け。注意 — AI エージェントは別プロセスでスキルを起動するため、ターミナルで対話的に `export` した値は届かない。profile（`~/.zshenv` 等）か上記ファイルを使う。

疎通確認:

```sh
node backlog.mjs myself
```

### 設定値の確認（APIキーは伏せる）

`config` は **非秘密の設定だけ**（ドメイン / 既定PJ / 自分のID）を表示する。**APIキーは「設定済み（非表示）」としか出さない**ので、AI に値を確認させても安全。

```sh
node backlog.mjs config
```

> **重要**: 設定ファイル（`~/.config/agent-skills/backlog-cli*.env`）には APIキーが入っている。**直接 `cat`／開いて中身を見ないこと**。既定PJや自分のIDを知りたいときは上記 `config` を使う（SKILL.md にもガードレールとして明記済み）。

### 書き込みプレビュー（任意・既定OFF）

書き込み系（`comment` / `update` / `create` / 変更系の `raw`）を実行する前に**内容を提示して承認を挟む**モード。**既定はOFF**（直接書き込み＝速い）。速度に影響するのは ON のときだけ。

- **有効化**: `node backlog.mjs perms enable preview`（または `.backlog-perms` の `preview=1` / インストール時の権限チェックボックス）。書き込み権限と同じ場所（`.backlog-perms`・インストール単位）で管理する。リポ単位で強制するなら `.backlog-cli.json` に `{"preview": true}`。
- **挙動（ON時）**: 書き込みコマンドは送信せず、**送信予定の内容を提示して `exit 7` で停止**。同じコマンドに **`--confirm`** を付けて再実行すると実際に送信する。
- 現在の状態は `node backlog.mjs config` の「書き込みプレビュー」で確認。

```sh
# プレビューON時
node backlog.mjs update PROJ-1 --status 完了        # → 内容を提示して停止（未実行）
node backlog.mjs update PROJ-1 --status 完了 --confirm  # → 承認後、実際に更新
```

AIエージェント運用では「未実行プレビュー（exit 7）→ ユーザーに提示し承認 → `--confirm` で再実行」という流れになる（対話プロンプトで待たないので速度を損ねない）。

## 権限モデル

操作別に ON/OFF で管理。既定は**読みON・書きOFF**。

| capability | 内容 | 既定 |
|------------|------|------|
| `read:issue` | 課題取得・検索 | ON |
| `read:comments` | コメント一覧 | ON |
| `read:projects` | プロジェクト一覧・取得 | ON |
| `read:meta` | ステータス・課題種別・優先度 | ON |
| `write:comment` | コメント投稿 | OFF |
| `write:update` | 課題更新 | OFF |
| `write:create` | 課題作成 | OFF |
| `raw` | 任意エンドポイント直叩き | OFF |

```sh
node backlog.mjs perms                       # 現状確認
node backlog.mjs perms enable write:comment  # 有効化
node backlog.mjs perms disable raw           # 無効化
```

`myself` は常時許可（権限設定不要）。`perms` / `help` は API キー無しでも動く。

## 使用例

```sh
# 読み取り
node backlog.mjs myself
node backlog.mjs issue PROJ-1
node backlog.mjs issue PROJ-1 --raw
node backlog.mjs comments PROJ-1 10
node backlog.mjs search --project 3 --keyword "ログイン" --count 5
node backlog.mjs projects
node backlog.mjs statuses MYPROJ
node backlog.mjs priorities

# 書き込みは既定で直接叩く（プレビュー無し）。未許可なら権限エラーで停止
node backlog.mjs comment PROJ-1 "対応しました"
node backlog.mjs create --project 3 --summary "新しい課題" --issue-type 1 --priority 2
# 権限が OFF なら: エラー → ユーザー許可 → perms enable write:comment → 再実行

# Windows では backlog.cmd を使える
backlog.cmd myself
```

## セキュリティ

- **apiKey は絶対にコミットしない**。秘密は `~/.config/agent-skills/backlog-cli.env`（リポ外）にのみ置く。**スキルのコピー内には秘密を置かない**（コピーに鍵を分散させない）。
- 書き込みは既定でプレビュー無しの直接実行。安全は権限(perms)で担保（既定で書き込みOFF＝未許可ならエラーで停止し、ユーザーの許可を求める）。任意で書き込みプレビュー（`--confirm` フロー）も有効化できる。
- 設定ファイル（`backlog-cli.env`）は `eval` / `source` せず行パースのみ（安全）。
- **APIキーは仕様上 URL クエリに載る**（Backlog API v2 はヘッダ認証が無く、`?apiKey=` 固定のため不可避）。Backlog 側アクセスログや中間プロキシに残りうる点に留意し、**鍵は最小権限＋定期ローテート**で被害を限定する。
- 万一キーを平文で保存した／漏らした場合は **Backlog 側でローテート**する。

## コメント・本文の整形記法（プロジェクト規約に委譲）

Backlog は**プロジェクトごとに記法設定（Markdown記法／バックログ記法）**を持ち、構文が異なる。どちらを使うか・どう書くかは**そのプロジェクトの事実**なので、**このスキルは記法の早見表を持たない**（1スペースに記法の違う複数PJがあり得るため、スキル側では一意に決められない）。

方針:
- **整形して書くときは、そのプロジェクトの規約に従う**。規約は各リポの `AGENTS.md` / `CLAUDE.md` に書いておくのが推奨（エージェントはそこを読む）。
- 設定が不明なら `node backlog.mjs project <key>` の `textFormattingRule`（`markdown` / `backlog`）で確認できる。
- **プレーンテキストだけなら気にしない**。素の GitHub Markdown を仮定して書くと、記法設定次第で崩れる点にだけ注意。

各リポの `AGENTS.md` に置くテンプレ例:

```markdown
## Backlog の記法
- このプロジェクトの textFormattingRule: markdown（または backlog）
- コメント/本文を整形するときはこの記法で書く。
- 記法詳細は Backlog 公式ヘルプを参照（Markdown記法 / バックログ記法）。
```

## トラブルシュート

| 症状 | 原因と対処 |
|------|-----------|
| `command not found: node` | インストーラもスキルも Node 18+ が必要。https://nodejs.org/ |
| `Node 18 以上が必要です` | https://nodejs.org/ から LTS 版をインストール |
| `BACKLOG_API_KEY が未設定です` | `~/.config/agent-skills/backlog-cli.env` に記載（推奨）。AI から呼ぶ場合、対話的 `export` は届かない点に注意 |
| `401 Unauthorized` | BACKLOG_API_KEY が誤っている |
| `404 Not Found` | BACKLOG_DOMAIN か課題キーが誤っている。`.com` と `.jp` の取り違えに注意 |
| `権限 '...' が必要（未許可）` | 勝手に有効化しない。**ユーザーに許可を求め**、許可後に `perms enable <cap>` で有効化して再実行 |
| `fetch failed` / 通信エラー | 権限ではなくネットワーク/サンドボックスの問題。`.env`/perms を確認せず、外部通信を許可して同じコマンドを再実行 |
| BACKLOG_DOMAIN エラー | `https://` や末尾スラッシュは不要。FQDN のみ（例: `foo.backlog.jp`） |
| 大量取得で遅い | `--count` を小さくするか `--keyword` で絞り込む |
