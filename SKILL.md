---
name: backlog-cli
description: Backlog REST API v2 を Node.js で直叩きする自己完結CLIスキル。公式MCP不要、Win/Mac/Linux 同一動作、npm依存ゼロ（Node 18+ 組込み fetch のみ）。秘密は ~/.config/agent-skills/backlog-cli.env で渡す（AI運用では対話的exportは届かない）。操作別権限つき・既定で書き込みOFF。失敗時はコマンド自身が次の手順を出すので、それに従う
---

## 動き方（最重要）

- **前置き・実況を出さない**（「〜します」等を書かない）。**いきなりコマンドを実行**する。成功時は結果だけ返す。
- 一直線で進む。止まるのは**コマンドが実際にエラーを返したときだけ**。そのときは**コマンドの出力に書かれた手順にそのまま従う**（説明・原因分析もそのとき）。

## 前提（自分で判断しない・毎回考え直さない）

- 外部通信ツール。**ほぼ全コマンドが通信必須**（`config` のみローカル）。サンドボックスでは**最初から通信を許可して実行**し、「通信が要るか」を毎回判断・前置きしない（`fetch failed` を踏まない）。
- 認証は `~/.config/agent-skills/backlog-cli.env` から**自動取得**。**この設定ファイルは絶対に `cat`／中身を見ない**（APIキーが入っている）。値を見たいときは `config`（鍵は非表示）。
- 状態・種別・優先度・担当・PJ は**名前で指定OK**（数値IDも可・CLIが内部解決）。事前に一覧を引かない。担当は `me` も可。
- `config` で `BACKLOG_PROJECT` / `BACKLOG_MY_USER_ID` が設定済みなら、`--project` 省略・`--assignee me` をそのまま使う。リポに `.backlog-cli.json` があれば space/PJ は自動選択（`--space` / `--project` で上書き可）。単一スペース設定なら `--space` 不要（唯一の設定ファイルに自動フォールバック）。

## 実行方法

CLI は **この SKILL.md と同じフォルダの `backlog.mjs`**。cwd 非依存で**絶対パス**で呼ぶ（探し回らない）:

```sh
SKILL=/abs/path/to/backlog-cli   # 例: <project>/.codex/skills/backlog-cli
node "$SKILL/backlog.mjs" myself
```

全コマンドは `node "$SKILL/backlog.mjs" help` で出る。

## 最短手順

- 課題の中身 → `inspect <issueKey>`（本文＋コメントを1発）
- 検索 → `search`／メタ → `statuses` `issue-types` `priorities`／設定確認 → `config`

## 権限・書き込み・整形（詳細はコマンド出力／README）

- 既定は **読みON・書きOFF**。書き込みは直接実行（プレビューは任意・既定OFF）。
- **失敗時はコマンド自身が次の手順を出す**（権限=exit 3 ／ プレビュー=exit 7 ／ 通信失敗）。**その指示に従い、指示に反して勝手に「権限有効化」「`--confirm`」「再実行」をしない**。
- 本文・コメントで装飾を使うなら、**そのPJの記法に従う**（Backlog は PJ ごとに Markdown記法／バックログ記法）。記法・書き方の規約は**プロジェクトの `AGENTS.md`/`CLAUDE.md`** を見る。不明なら `project <key>` の `textFormattingRule`（`markdown`/`backlog`）で確認。**プレーンテキストは気にしない**。

## cookbook（代表例。全コマンドは `help`）

```sh
node "$SKILL/backlog.mjs" config                # 既定PJ/自分のID/ドメイン（鍵は非表示）
node "$SKILL/backlog.mjs" inspect PROJ-1        # 本文＋コメント（推奨）
node "$SKILL/backlog.mjs" search --project 3 --keyword "ログイン" --count 5
node "$SKILL/backlog.mjs" comment PROJ-1 "対応しました。"
node "$SKILL/backlog.mjs" update PROJ-1 --status 完了 --assignee me   # 状態/担当は名前でOK
node "$SKILL/backlog.mjs" create --summary "新しい課題" --issue-type タスク --priority 中
node "$SKILL/backlog.mjs" --space acme inspect SOMEKEY-1          # 別スペース（複数設定時）
```

---

**詳細は必要なときだけ同フォルダの [README.md](./README.md)**：セットアップ・権限/プレビュー・配布更新・トラブルシュート・セキュリティ。
