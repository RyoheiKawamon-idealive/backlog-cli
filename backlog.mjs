#!/usr/bin/env node
// backlog.mjs — Backlog REST API v2 CLI（Node.js 版・クロスプラットフォーム）
//
// 使い方:
//   node backlog.mjs <サブコマンド> [オプション]
//   ./backlog.mjs <サブコマンド>   （Unix・実行権限あり）
//   backlog.cmd <サブコマンド>      （Windows）
//
// 必要な環境変数（または ~/.config/agent-skills/backlog-cli.env）:
//   BACKLOG_DOMAIN  — スペースの FQDN（例: your-space.backlog.jp）
//   BACKLOG_API_KEY — Backlog の個人 API キー
//
// 権限は .backlog-perms で管理。既定は読みON・書きOFF。
// 書き込み系は権限(perms)で制御。未許可なら明確なエラーでユーザーに許可を求める。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

// ---------------------------------------------------------------------------
// Node 18+ チェック（グローバル fetch 必須）
// ---------------------------------------------------------------------------
if (typeof fetch === "undefined") {
  process.stderr.write(
    `[backlog] Node 18 以上が必要です（現在 ${process.version}）。\n` +
    `  https://nodejs.org/ から最新の LTS 版をインストールしてください。\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// パス解決
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const SKILL_ROOT = dirname(__filename);

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
function die(msg, code = 1) {
  process.stderr.write(`[backlog] エラー: ${msg}\n`);
  process.exit(code);
}

// 端末インジェクション/ログ汚染対策: ANSIエスケープと制御文字を除去（改行・タブは保持）。
// サーバ由来テキスト（課題本文・名称・APIエラー）を人向けに表示する前に通す。JSON出力には不要。
function clean(s) {
  return String(s == null ? "" : s)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")        // ANSI CSI シーケンス
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");    // 制御文字（\t=\x09, \n=\x0a は保持）
}

// ---------------------------------------------------------------------------
// env ファイル行パース（eval禁止・ホワイトリスト・~/.config 用）
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, ""); // CRLF対策
    if (!trimmed || trimmed.trimStart().startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).replace(/\s+$/, ""); // 引用符は残すが末尾空白のみ除去（手入力ミス対策）
    // ホワイトリスト（許可キーのみ採用）
    if (![
      "BACKLOG_DOMAIN", "BACKLOG_API_KEY", "BACKLOG_PROJECT", "BACKLOG_MY_USER_ID",
    ].includes(key)) continue;
    // env が既にあれば上書きしない
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// .backlog-cli.json（リポ単位の非秘密セレクタ）を cwd から上方探索
//   { "space": "acme", "project": "MYPROJ" }
//   space → どの ~/.config スペース（ドメイン＋鍵）を使うか / project → 既定PJ
//   ※ APIキーは絶対に書かない（コミット前提の非秘密ファイル）。書かれていても無視＋警告。
// ---------------------------------------------------------------------------
function loadRepoConfig() {
  let dir = process.cwd();
  for (;;) {
    const p = join(dir, ".backlog-cli.json");
    if (existsSync(p)) {
      try {
        const o = JSON.parse(readFileSync(p, "utf8")) || {};
        if (o.apiKey || o.BACKLOG_API_KEY || o.api_key) {
          process.stderr.write(
            `[backlog] 警告: ${p} に APIキーらしき項目があります。リポのファイルに鍵を置かないでください（無視します）。\n`
          );
        }
        let space = typeof o.space === "string" ? o.space.trim() : "";
        const project = typeof o.project === "string" ? o.project.trim() : "";
        const preview = o.preview === true; // 書き込みプレビューをリポ側で強制ONにも出来る
        if (space && !/^[A-Za-z0-9_-]+$/.test(space)) space = ""; // 不正なスペース名は無視
        return { space, project, preview, path: p };
      } catch {
        process.stderr.write(`[backlog] 警告: ${p} の JSON 解析に失敗。無視します。\n`);
        return { space: "", project: "", path: p };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { space: "", project: "" }; // FSルート到達
    dir = parent;
  }
}

// ユーザー単位の設定ディレクトリ（秘密はコピーに置かず1箇所に集約）
const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agent-skills"
);

// リポ単位セレクタ（非秘密）。space/project を固定し、AIに判断させない。
const REPO_CFG = loadRepoConfig();

// スペース解決の優先順: --space（明示） > リポ .backlog-cli.json > 既定
let SPACE = "";
{
  const av = process.argv.slice(2);
  const si = av.indexOf("--space");
  if (si >= 0 && av[si + 1]) SPACE = av[si + 1];
}
if (!SPACE && REPO_CFG.space) SPACE = REPO_CFG.space;

// 設定ファイル列挙（backlog-cli[.<別名>].env にマッチするものだけ）
function listEnvFiles() {
  try {
    return readdirSync(CONFIG_DIR).filter((f) =>
      /^backlog-cli(\.[A-Za-z0-9_-]+)?\.env$/.test(f)
    );
  } catch {
    return [];
  }
}

// 設定ファイル解決（優先順）:
//   1. SPACE 指定 → backlog-cli.<SPACE>.env
//   2. 既定 backlog-cli.env が存在する → それ
//   3. backlog-cli*.env がちょうど1つ → それ（自動フォールバック）
//   4. それ以外（0 or 複数）→ 既定パスを返す（後段のエラーで案内）
function resolveUserConfig() {
  if (SPACE) return join(CONFIG_DIR, `backlog-cli.${SPACE}.env`);
  const def = join(CONFIG_DIR, "backlog-cli.env");
  if (existsSync(def)) return def;
  const files = listEnvFiles();
  if (files.length === 1) return join(CONFIG_DIR, files[0]);
  return def;
}
const USER_CONFIG = resolveUserConfig();

// 読込順（先に入った値が勝つ。env が最優先）:
//   1. 環境変数（CI/上級者）
//   2. ~/.config/agent-skills/backlog-cli[.<space>].env（推奨・秘密はリポ外の1箇所に集約）
// ※ 秘密はスキルのコピー内に置かない（コピーに鍵を分散させない方針）。
loadEnvFile(USER_CONFIG);

let BACKLOG_DOMAIN = process.env.BACKLOG_DOMAIN || "";
let BACKLOG_API_KEY = process.env.BACKLOG_API_KEY || "";
// 任意（迷い消し用）: 既定プロジェクト / 自分のユーザーID
// 既定PJの優先順: リポ .backlog-cli.json > env/ユーザー設定（--project は各コマンドで最優先）
const BACKLOG_PROJECT = REPO_CFG.project || process.env.BACKLOG_PROJECT || "";
const BACKLOG_MY_USER_ID = process.env.BACKLOG_MY_USER_ID || "";
// ※ 書き込みプレビューは .backlog-perms（preview=1）で管理。PREVIEW_ON は perms 読込後に定義。

// ---------------------------------------------------------------------------
// 資格情報検証（APIを呼ぶ時だけ）
// ---------------------------------------------------------------------------
function requireCreds() {
  if (!BACKLOG_API_KEY || !BACKLOG_DOMAIN) {
    const missing = !BACKLOG_API_KEY ? "BACKLOG_API_KEY" : "BACKLOG_DOMAIN";
    const envFiles = listEnvFiles();
    let msg =
      `[backlog] ${missing} が未設定です。\n` +
      `  推奨: ${USER_CONFIG} に次を記載（秘密を1箇所に集約・コピーに置かない）:\n` +
      "      BACKLOG_DOMAIN=your-space.backlog.jp\n" +
      "      BACKLOG_API_KEY=<あなたのAPIキー>\n" +
      "  ほか: 環境変数 export（CI/上級者）。\n";
    if (envFiles.length > 1 && !SPACE) {
      const aliases = envFiles.map((f) =>
        f === "backlog-cli.env"
          ? "（既定）"
          : f.replace(/^backlog-cli\./, "").replace(/\.env$/, "")
      );
      msg +=
        `  複数のスペース設定が見つかりました。--space <別名> を付けて実行してください。\n` +
        `  利用可能な別名: ${aliases.join(", ")}\n`;
    }
    process.stderr.write(msg);
    process.exit(1);
  }
  // FQDN 検証（肯定リスト）。`@` を弾かないと host@attacker.example で鍵が外部送信されうる
  if (!/^[A-Za-z0-9.-]+$/.test(BACKLOG_DOMAIN) || !BACKLOG_DOMAIN.includes(".")) {
    die(
      `BACKLOG_DOMAIN は FQDN のみ（例: your-space.backlog.jp）。\n` +
      `  使えるのは英数字・ドット・ハイフンのみ（https:// や /path や @ は不可）。現在の値: ${BACKLOG_DOMAIN}`,
      2
    );
  }
}

// ---------------------------------------------------------------------------
// 配列キー対応の form エンコード（[] をリテラルのままにする★）
// ---------------------------------------------------------------------------
function encodeForm(pairs) {
  return pairs
    .map(([k, v]) => {
      // キーは英数・[]・_ のみ想定。[] はリテラルのまま残す
      const ek = k.replace(/[^A-Za-z0-9_[\]]/g, (s) => encodeURIComponent(s));
      return `${ek}=${encodeURIComponent(v)}`;
    })
    .join("&");
}

// ---------------------------------------------------------------------------
// パス挿入値の検証（★必須）
// ---------------------------------------------------------------------------
function validId(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    die(`不正な issueIdOrKey / projectIdOrKey: '${s}'`, 2);
  }
}

// オプション値の存在チェック（未指定で文字列 "undefined" を送らない）
function req(argv, i, name) {
  const v = argv[i];
  if (v === undefined) die(`${name}: 値が必要です。`, 2);
  return v;
}

// ---------------------------------------------------------------------------
// 共通 HTTP 呼び出し（★中核）
// ---------------------------------------------------------------------------
async function call(method, path, pairs, opts = {}) {
  requireCreds();

  // 書き込みプレビュー（既定OFF）: ON かつ非GET かつ未確認なら、送信内容だけ提示して未実行で停止。
  // 速度に影響するのは preview ON のときだけ（既定は素通り）。
  if (PREVIEW_ON && method !== "GET" && !CONFIRM) {
    let out = `[backlog] 確認が必要（未送信）: 次の書き込みを提示します\n  ${method} ${path}\n`;
    for (const [k, v] of pairs) out += `    ${k}=${clean(String(v))}\n`;
    out +=
      `  ── ここで停止すること ──\n` +
      `  この内容をユーザーに提示し、あなたのターンを終了する。\n` +
      `  このターン内で --confirm を付けて再実行してはいけない（自分で承認しない）。\n` +
      `  ユーザーが「次のメッセージで」明示的に承認したら、そのとき初めて --confirm を付けて再実行する。\n`;
    process.stdout.write(out);
    process.exit(7); // 7 = 要・人間承認（このターンでは送信しない）
  }

  const base = `https://${BACKLOG_DOMAIN}/api/v2${path}`;

  let url, init;
  if (method === "GET") {
    // GET: apiKey + params をクエリに載せる。body なし
    const qs = encodeForm([["apiKey", BACKLOG_API_KEY], ...pairs]);
    url = `${base}?${qs}`;
    init = { method: "GET", headers: {} };
  } else {
    // POST/PATCH/PUT/DELETE: apiKey はURLクエリ、params は body（form-urlencoded）
    // apiKey を body に入れない★
    url = `${base}?apiKey=${encodeURIComponent(BACKLOG_API_KEY)}`;
    const body = encodeForm(pairs);
    init = {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    };
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    die(
      `外部通信に到達できません（${e.message}）。\n` +
      `  これは権限不足ではなく「ネットワーク／サンドボックス」の問題です。\n` +
      `  ローカル設定(.env)の確認は不要。Codex 等のサンドボックス環境なら、\n` +
      `  外部通信を許可して同じコマンドを再実行してください。`,
      1
    );
  }

  const status = res.status;
  const text = await res.text();

  // 非2xx は自前判定（fetch は 4xx で例外を投げない★）
  if (status < 200 || status >= 300) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json.errors)) {
        for (const e of json.errors) {
          process.stderr.write(
            `  - [${clean(e.code)}] ${clean(e.message)} ${clean(e.moreInfo || "")}\n`
          );
        }
      } else {
        process.stderr.write(`${clean(text)}\n`);
      }
    } catch {
      process.stderr.write(`${clean(text)}\n`);
    }
    die(`Backlog API エラー (HTTP ${status})`, 1);
  }

  // 成功出力（returnText 指定時は表示せず文字列を返す＝inspect 等で再利用）
  if (opts.returnText) return text;
  if (RAW) {
    process.stdout.write(text + "\n");
  } else {
    try {
      const obj = JSON.parse(text);
      process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    } catch {
      process.stdout.write(text + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// inspect: 課題本文＋コメントを1コマンドで取得（呼び出し1回・往復削減）
// ---------------------------------------------------------------------------
async function inspect(idOrKey, count) {
  requireCap("read:issue");
  requireCap("read:comments");
  validId(idOrKey);
  const issue = JSON.parse(
    await call("GET", `/issues/${idOrKey}`, [], { returnText: true })
  );
  const comments = JSON.parse(
    await call(
      "GET",
      `/issues/${idOrKey}/comments`,
      [["count", count], ["order", "desc"]],
      { returnText: true }
    )
  );
  if (RAW) {
    process.stdout.write(JSON.stringify({ issue, comments }, null, 2) + "\n");
    return;
  }
  const g = (v) => (v == null ? "" : v);
  let out =
    `課題: ${g(issue.issueKey)}  ${g(issue.summary)}\n` +
    `種別: ${g(issue.issueType && issue.issueType.name)} / 状態: ${g(issue.status && issue.status.name)} / 優先度: ${g(issue.priority && issue.priority.name)}\n` +
    `担当: ${g(issue.assignee && issue.assignee.name)} / 期限: ${g(issue.dueDate)} / 更新: ${g(issue.updated)}\n` +
    `\n--- 本文 ---\n${g(issue.description)}\n` +
    `\n--- コメント(${comments.length}件・新しい順) ---\n`;
  for (const c of comments) {
    const who = g(c.createdUser && c.createdUser.name);
    const when = g(c.created);
    const body =
      c.content && c.content.trim() ? c.content.trim() : "(本文なし・変更ログのみ)";
    out += `• ${when} ${who}\n  ${body.replace(/\n/g, "\n  ")}\n`;
  }
  process.stdout.write(clean(out));
}

// ---------------------------------------------------------------------------
// 権限管理（8 capability・既定 読みON/書きOFF）
// ---------------------------------------------------------------------------
const ALL_CAPS = [
  "read:issue",
  "read:comments",
  "read:projects",
  "read:meta",
  "write:comment",
  "write:update",
  "write:create",
  "raw",
];

const DEFAULT_PERMS = {
  "read:issue": true,
  "read:comments": true,
  "read:projects": true,
  "read:meta": true,
  "write:comment": false,
  "write:update": false,
  "write:create": false,
  raw: false,
};

let permsState = { ...DEFAULT_PERMS };
let permsFromFile = false;
let previewState = false; // .backlog-perms の preview=1 で書き込みプレビューON（capabilityではなくモード）

const PERMS_FILE = join(SKILL_ROOT, ".backlog-perms");

function loadPermsFile() {
  if (!existsSync(PERMS_FILE)) return;
  permsFromFile = true;
  const lines = readFileSync(PERMS_FILE, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed || trimmed.trimStart().startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const rhs = trimmed.slice(eqIdx + 1);
    const hash = rhs.indexOf("#"); // 行末コメント（ラベル）を許容
    const val = (hash >= 0 ? rhs.slice(0, hash) : rhs).trim();
    // ホワイトリスト: 値が 0/1 のみ。preview は cap ではなくモードとして別扱い
    if (val !== "0" && val !== "1") continue;
    if (key === "preview") { previewState = val === "1"; continue; }
    if (!ALL_CAPS.includes(key)) continue;
    permsState[key] = val === "1";
  }
}

loadPermsFile();

// 書き込みプレビュー（既定OFF。OFF時は追加処理なし）。.backlog-perms の preview=1、または
// リポ .backlog-cli.json の {"preview":true} でON。ON時は書き込み系を未実行で提示し
// --confirm 付きの再実行で初めて送信する。
const PREVIEW_ON = previewState || REPO_CFG.preview === true;

function isAllowed(cap) {
  return permsState[cap] === true;
}

function requireCap(cap) {
  if (!isAllowed(cap)) {
    die(
      `この操作には権限 '${cap}' が必要ですが、未許可です。\n` +
      `  → ユーザーに「${cap} を許可してよいか」を確認してください（ask user for permission）。\n` +
      `  許可されたら 'node "$SKILL/backlog.mjs" perms enable ${cap}' で有効化してから再実行。\n` +
      `  ユーザーの許可なしに勝手に有効化しないこと。`,
      3
    );
  }
}

function showPerms() {
  const note = permsFromFile ? "" : " （未設定・既定値）";
  process.stdout.write(`権限状態${note}:\n`);

  process.stdout.write("\n読み取り:\n");
  for (const cap of ["read:issue", "read:comments", "read:projects", "read:meta"]) {
    process.stdout.write(`  ${isAllowed(cap) ? "[x]" : "[ ]"} ${cap}\n`);
  }

  process.stdout.write("\n書き込み:\n");
  for (const cap of ["write:comment", "write:update", "write:create"]) {
    process.stdout.write(`  ${isAllowed(cap) ? "[x]" : "[ ]"} ${cap}\n`);
  }

  process.stdout.write("\nescape hatch:\n");
  process.stdout.write(`  ${isAllowed("raw") ? "[x]" : "[ ]"} raw\n`);

  process.stdout.write("\n書き込みプレビュー（モード）:\n");
  process.stdout.write(`  ${previewState ? "[x]" : "[ ]"} preview（書込前に内容提示・--confirm で実行）\n`);
  process.stdout.write("\n");
}

function writePerms(cap, val) {
  if (cap === "preview") {
    previewState = val; // capability ではなくモード
  } else if (ALL_CAPS.includes(cap)) {
    permsState[cap] = val;
  } else {
    die(`不明な設定 '${cap}'。有効: ${ALL_CAPS.join(", ")}, preview`, 2);
  }

  // 全 cap ＋ preview を正規化してファイルに書き出し
  let content = "# 操作別の許可 (1=許可 / 0=禁止)\n";
  for (const c of ALL_CAPS) {
    content += `${c}=${permsState[c] ? "1" : "0"}\n`;
  }
  content += `preview=${previewState ? "1" : "0"}\n`;
  writeFileSync(PERMS_FILE, content, "utf8");

  process.stderr.write(
    `[backlog] ${cap} を${val ? "有効" : "無効"}に設定しました。\n`
  );
  permsFromFile = true;
  showPerms();
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------
function usage() {
  process.stdout.write(`使い方: node backlog.mjs [--raw] [--space <名前>] <サブコマンド> [引数...]
  （Unix）  ./backlog.mjs ...
  （Windows）backlog.cmd ...

グローバルフラグ:
  --raw            JSON 整形なしで生 JSON を出力
  --confirm        書き込みプレビューON時に実際に送信（未指定なら内容提示のみ・未実行）
  --space <名前>   複数スペース時の設定切替（~/.config/agent-skills/backlog-cli.<名前>.env）

初期設定:
  setup                         接続設定ウィザード（ドメイン/APIキー/PJ/アカウント・複数スペース可）
  config                        非秘密の設定値を表示（既定PJ/自分のID/ドメイン。APIキーは非表示）

読み取り系（権限 ON が既定）:
  myself                        自分のユーザー情報
  inspect <idOrKey> [count]     課題本文＋コメントを1コマンドで取得（推奨・往復削減）
  issue <idOrKey>               課題の取得
  comments <idOrKey> [count]    コメント一覧（既定 count=20、新しい順）
  search [オプション]           課題検索（状態/担当/PJは名前でも可）
    --project <key|id>   プロジェクト（キー or ID）
    --status <名前|id>   ステータス（--project必須・名前可）
    --assignee <名前|id|me> 担当者
    --keyword <q>      キーワード
    --count <n>        取得件数（既定 20）
    --sort <k>         ソートキー（既定 updated）
    --order <asc|desc> 並び順（既定 desc）
  projects                      プロジェクト一覧
  project <idOrKey>             プロジェクト取得
  statuses <projIdOrKey>        ステータス一覧
  issue-types <projIdOrKey>     課題種別一覧
  priorities                    優先度一覧

書き込み系（権限 OFF が既定。未許可なら明確なエラー→ユーザーに許可を求める）:
  ※ 状態/種別/優先度/担当/PJ は「名前」で指定可（IDも可・内部解決）
  comment <idOrKey> <content>   コメント投稿
  update <idOrKey> [オプション] 課題更新
    --status <名前|id>   ステータス変更
    --comment <txt>      コメント
    --assignee <名前|id|me> 担当者変更
    --priority <名前|id> 優先度変更
    --summary <s>        件名変更
    --description <d>    詳細変更
  create --project <key|id> --summary <s> --issue-type <名前|id> --priority <名前|id> [--assignee <名前|id|me>] [--description <d>]
                                課題作成

escape hatch（権限 OFF が既定）:
  raw <METHOD> <path> [key=val ...]  任意の API を直叩き

権限管理:
  perms                         現在の権限状態＋書き込みプレビュー状態を表示
  perms enable <cap|preview>    権限/プレビューを有効化（preview=書込前に内容提示→--confirm）
  perms disable <cap|preview>   権限/プレビューを無効化

例:
  node backlog.mjs myself
  node backlog.mjs issue PROJ-1
  node backlog.mjs issue PROJ-1 --raw
  node backlog.mjs comments PROJ-1 10
  node backlog.mjs search --project 3 --keyword "ログイン" --count 5
  node backlog.mjs projects
  node backlog.mjs statuses MYPROJ
  node backlog.mjs comment PROJ-1 "対応しました"
  node backlog.mjs update PROJ-1 --status 完了 --assignee me --comment "完了"
  node backlog.mjs create --project MYPROJ --summary "新しい課題" --issue-type タスク --priority 中
  node backlog.mjs raw GET /users/myself
  node backlog.mjs perms
  node backlog.mjs perms enable write:comment
`);
}

// ---------------------------------------------------------------------------
// グローバルフラグ解析
// ---------------------------------------------------------------------------
let RAW = false;
let CONFIRM = false; // プレビューモードON時に実際に書き込むフラグ（--confirm）
const args = [];
const rawArgv = process.argv.slice(2);
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i];
  if (a === "--raw") RAW = true;
  else if (a === "--confirm") CONFIRM = true;
  else if (a === "--space") i++; // 値は設定選択で消費済み
  else args.push(a);
}

// ---------------------------------------------------------------------------
// search サブコマンド
// ---------------------------------------------------------------------------
// --- 設定ウィザード（setup）-----------------------------------------------
// readline(createInterface)で実装。APIキー入力はマスキングしない（画面に表示される）。
async function fetchAccountFor(domain, apiKey) {
  try {
    const res = await fetch(
      `https://${domain}/api/v2/users/myself?apiKey=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function writeSpaceConfig(spaceName, cfg) {
  const fname = spaceName
    ? `backlog-cli.${spaceName}.env`
    : "backlog-cli.env";
  const p = join(CONFIG_DIR, fname);
  const lines = [
    "# backlog-cli 設定（setup ウィザードで生成）",
    `BACKLOG_DOMAIN=${cfg.domain}`,
    `BACKLOG_API_KEY=${cfg.apiKey}`,
  ];
  if (cfg.userId) lines.push(`BACKLOG_MY_USER_ID=${cfg.userId}`);
  if (cfg.project) lines.push(`BACKLOG_PROJECT=${cfg.project}`);
  mkdirSync(CONFIG_DIR, { recursive: true });
  try { chmodSync(CONFIG_DIR, 0o700); } catch {} // 共有環境でのディレクトリ列挙を防ぐ
  writeFileSync(p, lines.join("\n") + "\n");
  try { chmodSync(p, 0o600); } catch {}
  return p;
}

// 既存スペース設定を読む（Enter=維持のための現在値取得）。鍵も読むが画面には出さない。
function readSpaceConfig(spaceName) {
  const fname = spaceName ? `backlog-cli.${spaceName}.env` : "backlog-cli.env";
  const p = join(CONFIG_DIR, fname);
  const cur = {};
  if (existsSync(p)) {
    for (const ln of readFileSync(p, "utf8").split("\n")) {
      const m = ln.match(/^(BACKLOG_DOMAIN|BACKLOG_API_KEY|BACKLOG_MY_USER_ID|BACKLOG_PROJECT)=(.*)$/);
      if (m) cur[m[1]] = m[2].trim();
    }
  }
  return {
    domain: cur.BACKLOG_DOMAIN || "",
    apiKey: cur.BACKLOG_API_KEY || "",
    userId: cur.BACKLOG_MY_USER_ID || "",
    project: cur.BACKLOG_PROJECT || "",
  };
}

// ドメインの第1ラベルからスペース別名を自動生成（setup でスペース名を手入力させない）
function deriveAlias(domain) {
  const raw = domain.split(".")[0].replace(/[^A-Za-z0-9_-]/g, "");
  return raw || "space";
}

async function cmdSetup(auto) {
  const defaultCfg = join(CONFIG_DIR, "backlog-cli.env");
  if (!process.stdin.isTTY) {
    if (auto) return; // 自動起動かつ非端末なら黙ってスキップ
    die("setup は対話環境（端末）で実行してください。", 2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  try {
    // 自動起動（install）で既に設定があれば、現状を見せて「変更するか」1問だけ。
    // 既定 backlog-cli.env が無くても、名前付き設定が1つでもあれば「設定済み」とみなす
    // （USER_CONFIG は resolveUserConfig で 既定→単一フォールバック の順に解決済み）。
    const existingFiles = listEnvFiles();
    if (auto && existingFiles.length > 0) {
      let primary = USER_CONFIG;
      if (!existsSync(primary)) primary = join(CONFIG_DIR, existingFiles[0]);
      const cur = {};
      for (const ln of readFileSync(primary, "utf8").split("\n")) {
        const m = ln.match(/^(BACKLOG_DOMAIN|BACKLOG_PROJECT|BACKLOG_MY_USER_ID)=(.*)$/);
        if (m) cur[m[1]] = m[2].trim();
      }
      process.stdout.write(
        `設定済み（${basename(primary)}）: domain=${cur.BACKLOG_DOMAIN || "-"} / project=${cur.BACKLOG_PROJECT || "-"} / userId=${cur.BACKLOG_MY_USER_ID || "-"}\n`
      );
      const others = existingFiles.filter((f) => f !== basename(primary));
      if (others.length > 0) {
        process.stdout.write(`  （他のスペース: ${others.join(", ")}）\n`);
      }
      const yn = (await ask("設定を変更しますか？（Enter=現状維持） [y/N]: ")).toLowerCase();
      if (yn !== "y" && yn !== "yes") return; // 現状維持（finally で rl.close）
    }
    process.stdout.write("Backlog 接続設定（複数スペース可 / Ctrl-C 中止）\n");
    let first = true;
    while (true) {
      // 既定スペース（name=""）に保存するのは「1回目かつ既定ファイルが未作成」のときだけ
      const isDefaultSlot = first && !existsSync(defaultCfg);

      let name, existing, domain;
      if (isDefaultSlot) {
        // 既定スペース: readSpaceConfig("") を先に読み、ドメインも Enter=維持できる
        name = "";
        existing = readSpaceConfig("");
        domain = "";
        while (!domain) {
          const input = await ask(
            existing.domain
              ? `\n  ドメイン(FQDN) [現在: ${existing.domain}]（Enterで維持）: `
              : "\n  ドメイン(FQDN 例 your-space.backlog.jp): "
          );
          if (!input && existing.domain) { domain = existing.domain; break; }
          if (!/^[A-Za-z0-9.-]+$/.test(input) || !input.includes(".")) {
            process.stdout.write("  → FQDNのみ（英数字・ドット・ハイフン。https:// や / や @ は不可）。再入力。\n");
            continue;
          }
          domain = input;
        }
      } else {
        // 追加スペース: まずドメインを入力し、サブドメインから別名を自動生成
        domain = "";
        while (!domain) {
          const input = await ask("\n  追加ドメイン(FQDN 例 your-space.backlog.jp): ");
          if (!/^[A-Za-z0-9.-]+$/.test(input) || !input.includes(".")) {
            process.stdout.write("  → FQDNのみ（英数字・ドット・ハイフン。https:// や / や @ は不可）。再入力。\n");
            continue;
          }
          domain = input;
        }
        name = deriveAlias(domain);
        existing = readSpaceConfig(name);
        process.stdout.write(`  → スペース別名: ${name}（自動・${join(CONFIG_DIR, `backlog-cli.${name}.env`)} に保存）\n`);
      }

      // APIキー（既存があれば Enter で維持。値は画面に出さない）
      let apiKey = await ask(
        existing.apiKey ? "  APIキー（Enterで現状維持）: " : "  APIキー（入力はこの端末に表示されます）: "
      );
      const keptKey = !apiKey && !!existing.apiKey;
      if (keptKey) apiKey = existing.apiKey;

      // ユーザーID（鍵を維持なら既存IDを使う。鍵変更 or ID未取得のときだけ取得）
      let userId = existing.userId;
      if (!keptKey || !userId) {
        const acc = await fetchAccountFor(domain, apiKey);
        if (acc && acc.id) {
          userId = String(acc.id);
          process.stdout.write(`  → アカウント確認: ${acc.name} (id:${userId})\n`);
        } else if (!userId) {
          process.stdout.write("  → アカウント自動取得に失敗（キー/ドメイン/通信を確認）。設定は保存します。\n");
        }
      }

      // 既定プロジェクト（既存があれば Enter で維持・`-` で消去）
      const projInput = await ask(
        existing.project
          ? `  既定プロジェクト [現在: ${existing.project}]（Enterで維持 / - で消去）: `
          : "  既定プロジェクト（省略可 例 MYPROJ）: "
      );
      let project = existing.project;
      if (projInput === "-") project = "";
      else if (projInput) project = projInput;

      const p = writeSpaceConfig(name, { domain, apiKey, userId, project });
      process.stdout.write(`  保存: ${p}${name ? `  → 使用時 --space ${name}` : "  （既定）"}\n`);
      first = false;
      const more = (await ask("\n別のスペースを追加？ [y/N]: ")).toLowerCase();
      if (more !== "y" && more !== "yes") break;
    }
  } finally {
    rl.close();
  }
  process.stdout.write("\n設定完了。疎通確認: node backlog.mjs myself\n");
}

// ---------------------------------------------------------------------------
// config: 非秘密の設定値だけ表示（APIキーは絶対に出さない）
//   AIが「既定PJ・自分のID」を安全に確認するための覗き口。
//   env ファイルを直接 cat させない（キーが入っている）ための代替。
// ---------------------------------------------------------------------------
function cmdConfig() {
  const cfgBasename = basename(USER_CONFIG);
  // 表示用スペースラベル: SPACE 明示 > 自動解決ファイル名から > "既定"
  const spaceLabel = SPACE
    || (cfgBasename !== "backlog-cli.env"
      ? cfgBasename.replace(/^backlog-cli\./, "").replace(/\.env$/, "")
      : "既定");
  const exists = existsSync(USER_CONFIG);
  const g = (v, note) => (v ? `${v}${note ? "   " + note : ""}` : "(未設定)");
  const repoLine = REPO_CFG.path
    ? `${REPO_CFG.path}  (space=${REPO_CFG.space || "-"}, project=${REPO_CFG.project || "-"})`
    : "なし（カレント配下に .backlog-cli.json 無し）";

  const allFiles = listEnvFiles();
  const otherAliases = allFiles
    .filter((f) => f !== cfgBasename)
    .map((f) =>
      f === "backlog-cli.env"
        ? "既定（--space 無し）"
        : f.replace(/^backlog-cli\./, "").replace(/\.env$/, "")
    );

  let out =
    `backlog-cli 設定（スペース: ${spaceLabel} / ${cfgBasename}）\n\n` +
    `  BACKLOG_DOMAIN     : ${g(BACKLOG_DOMAIN)}\n` +
    `  BACKLOG_PROJECT    : ${g(BACKLOG_PROJECT, "（既定PJ。search/create の --project 省略可）")}\n` +
    `  BACKLOG_MY_USER_ID : ${g(BACKLOG_MY_USER_ID, "（--assignee me を通信なしで解決）")}\n` +
    `  BACKLOG_API_KEY    : ${BACKLOG_API_KEY ? "設定済み（非表示）" : "(未設定)"}\n` +
    `  書き込みプレビュー : ${PREVIEW_ON ? "ON（書込前に内容提示・--confirm で実行）" : "OFF（直接書き込み）"}\n` +
    `\n  リポ設定: ${repoLine}\n` +
    `  資格情報: ${USER_CONFIG}${exists ? "" : "（未作成）"}\n`;
  if (otherAliases.length > 0) {
    out += `  他に切替可能なスペース: ${otherAliases.join(", ")}（--space で指定）\n`;
  }
  out +=
    `  ※ 資格情報ファイルには APIキーが含まれます。直接 cat せず、値の確認は必ずこの 'config' を使ってください。\n` +
    `  ※ リポ設定(.backlog-cli.json)は非秘密＝コミット可。鍵は書かないこと。\n`;
  process.stdout.write(out);
}

// "me" を自分のユーザーIDに解決（BACKLOG_MY_USER_ID 優先・無ければ /users/myself）
async function resolveMe() {
  if (BACKLOG_MY_USER_ID) return BACKLOG_MY_USER_ID;
  const me = JSON.parse(await call("GET", "/users/myself", [], { returnText: true }));
  return String(me.id);
}

// --- 名前→ID 解決（数値はそのまま ID として扱う）-------------------------
async function _list(path) {
  return JSON.parse(await call("GET", path, [], { returnText: true }));
}
function _matchName(items, name, label) {
  const hit = items.filter((i) => i.name === name);
  if (hit.length === 1) return String(hit[0].id);
  const names = items.map((i) => clean(i.name)).join(" / ");
  if (hit.length === 0) die(`${label} '${name}' が見つかりません。候補: ${names}`, 2);
  die(`${label} '${name}' が複数一致。ID で指定してください。`, 2);
}
function projKeyOf(idOrKey) {
  return idOrKey.replace(/-\d+$/, ""); // 課題キーのPJ接頭辞（PROJ-1 → PROJ）
}
async function resolveStatus(projKey, v) {
  if (/^\d+$/.test(v)) return v;
  return _matchName(await _list(`/projects/${projKey}/statuses`), v, "ステータス");
}
async function resolveIssueType(projKey, v) {
  if (/^\d+$/.test(v)) return v;
  return _matchName(await _list(`/projects/${projKey}/issueTypes`), v, "課題種別");
}
async function resolvePriority(v) {
  if (/^\d+$/.test(v)) return v;
  return _matchName(await _list("/priorities"), v, "優先度");
}
async function resolveProjectId(v) {
  if (/^\d+$/.test(v)) return v;
  validId(v);
  const p = JSON.parse(await call("GET", `/projects/${v}`, [], { returnText: true }));
  return String(p.id);
}
async function resolveAssignee(v) {
  if (v === "me") return await resolveMe();
  if (/^\d+$/.test(v)) return v;
  return _matchName(await _list("/users"), v, "ユーザー");
}

async function cmdSearch(argv) {
  requireCap("read:issue");
  let projRaw = "", statusRaw = "", assigneeRaw = "", keyword = "", count = "", sort = "", order = "";
  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--project":  projRaw = req(argv, ++i, "--project"); break;
      case "--status":   statusRaw = req(argv, ++i, "--status"); break;
      case "--assignee": assigneeRaw = req(argv, ++i, "--assignee"); break;
      case "--keyword":  keyword = req(argv, ++i, "--keyword"); break;
      case "--count":    count = req(argv, ++i, "--count"); break;
      case "--sort":     sort = req(argv, ++i, "--sort"); break;
      case "--order":    order = req(argv, ++i, "--order"); break;
      default: die(`search: 不明なオプション '${argv[i]}'`, 2);
    }
    i++;
  }
  if (!projRaw && BACKLOG_PROJECT) projRaw = BACKLOG_PROJECT;

  const pairs = [];
  if (projRaw) pairs.push(["projectId[]", await resolveProjectId(projRaw)]);
  if (statusRaw) {
    if (!/^\d+$/.test(statusRaw) && !projRaw) {
      die("search: --status を名前で指定するには --project が必要です。", 2);
    }
    pairs.push(["statusId[]", await resolveStatus(projRaw, statusRaw)]);
  }
  if (assigneeRaw) pairs.push(["assigneeId[]", await resolveAssignee(assigneeRaw)]);
  if (keyword) pairs.push(["keyword", keyword]);
  pairs.push(["count", count || "20"]);
  pairs.push(["sort", sort || "updated"]);
  pairs.push(["order", order || "desc"]);
  await call("GET", "/issues", pairs);
}

// ---------------------------------------------------------------------------
// update サブコマンド
// ---------------------------------------------------------------------------
async function cmdUpdate(argv) {
  if (argv.length < 1) die("update: <idOrKey> が必要です。", 2);
  const idOrKey = argv[0];
  validId(idOrKey);
  requireCap("write:update");

  // 状態を名前で解決するときだけ projKey が要る。数値の課題IDなら課題から projectId を引く
  // （projKeyOf は数値の課題IDを誤ってPJキー扱いするため）。名前解決が要るときのみ1回だけ取得。
  let _projKey = null;
  const getProjKey = async () => {
    if (_projKey !== null) return _projKey;
    if (/^\d+$/.test(idOrKey)) {
      const issue = JSON.parse(await call("GET", `/issues/${idOrKey}`, [], { returnText: true }));
      _projKey = String(issue.projectId);
    } else {
      _projKey = projKeyOf(idOrKey);
    }
    return _projKey;
  };

  const pairs = [];
  let i = 1;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--status":      pairs.push(["statusId", await resolveStatus(await getProjKey(), req(argv, ++i, "--status"))]); break;
      case "--comment":     pairs.push(["comment", req(argv, ++i, "--comment")]); break;
      case "--assignee":    pairs.push(["assigneeId", await resolveAssignee(req(argv, ++i, "--assignee"))]); break;
      case "--priority":    pairs.push(["priorityId", await resolvePriority(req(argv, ++i, "--priority"))]); break;
      case "--summary":     pairs.push(["summary", req(argv, ++i, "--summary")]); break;
      case "--description": pairs.push(["description", req(argv, ++i, "--description")]); break;
      default: die(`update: 不明なオプション '${argv[i]}'`, 2);
    }
    i++;
  }
  if (pairs.length === 0) die("update: 更新パラメータが1つも指定されていません。", 2);

  await call("PATCH", `/issues/${idOrKey}`, pairs);
}

// ---------------------------------------------------------------------------
// create サブコマンド
// ---------------------------------------------------------------------------
async function cmdCreate(argv) {
  let proj = "", summary = "", issueType = "", priority = "", description = "", assignee = "";
  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--project":     proj        = req(argv, ++i, "--project"); break;
      case "--summary":     summary     = req(argv, ++i, "--summary"); break;
      case "--issue-type":  issueType   = req(argv, ++i, "--issue-type"); break;
      case "--priority":    priority    = req(argv, ++i, "--priority"); break;
      case "--assignee":    assignee    = req(argv, ++i, "--assignee"); break;
      case "--description": description = req(argv, ++i, "--description"); break;
      default: die(`create: 不明なオプション '${argv[i]}'`, 2);
    }
    i++;
  }
  if (!proj) proj = BACKLOG_PROJECT;
  if (!proj)      die("create: --project が必須です（または BACKLOG_PROJECT を設定）。", 2);
  if (!summary)   die("create: --summary が必須です。", 2);
  if (!issueType) die("create: --issue-type が必須です。", 2);
  if (!priority)  die("create: --priority が必須です。", 2);

  requireCap("write:create");

  const pairs = [
    ["projectId",   await resolveProjectId(proj)],
    ["summary",     summary],
    ["issueTypeId", await resolveIssueType(proj, issueType)],
    ["priorityId",  await resolvePriority(priority)],
  ];
  if (description) pairs.push(["description", description]);
  if (assignee) pairs.push(["assigneeId", await resolveAssignee(assignee)]);

  await call("POST", "/issues", pairs);
}

// ---------------------------------------------------------------------------
// raw サブコマンド
// ---------------------------------------------------------------------------
async function cmdRaw(argv) {
  requireCap("raw");
  if (argv.length < 2) die("raw: <METHOD> <path> [key=val ...] の形式で指定してください。", 2);

  const method = argv[0].toUpperCase();
  const path = argv[1];
  if (!path.startsWith("/")) die("raw: path は / で始まる必要があります（例: /users/myself）", 2);

  const pairs = argv.slice(2).map((kv) => {
    const eqIdx = kv.indexOf("=");
    if (eqIdx < 0) die(`raw: key=val 形式で指定してください: ${kv}`, 2);
    return [kv.slice(0, eqIdx), kv.slice(eqIdx + 1)];
  });

  await call(method, path, pairs);
}

// ---------------------------------------------------------------------------
// メインディスパッチ
// ---------------------------------------------------------------------------
const cmd = args[0] || "";
const rest = args.slice(1);

(async () => {
  switch (cmd) {
    case "":
    case "-h":
    case "--help":
    case "help":
      usage();
      break;

    case "perms": {
      const sub = rest[0] || "";
      if (sub === "") {
        showPerms();
      } else if (sub === "enable") {
        if (!rest[1]) die("perms enable: <cap> が必要です。", 2);
        writePerms(rest[1], true);
      } else if (sub === "disable") {
        if (!rest[1]) die("perms disable: <cap> が必要です。", 2);
        writePerms(rest[1], false);
      } else {
        die(`perms: 不明なサブコマンド '${sub}'。enable / disable のいずれかを指定してください。`);
      }
      break;
    }

    case "setup":
      await cmdSetup(rest.includes("--auto"));
      break;

    case "config":
      cmdConfig();
      break;

    case "myself":
      await call("GET", "/users/myself", []);
      break;

    case "issue":
      requireCap("read:issue");
      if (!rest[0]) die("issue: <idOrKey> が必要です。", 2);
      validId(rest[0]);
      await call("GET", `/issues/${rest[0]}`, []);
      break;

    case "comments": {
      requireCap("read:comments");
      if (!rest[0]) die("comments: <idOrKey> が必要です。", 2);
      validId(rest[0]);
      const count = rest[1] || "20";
      await call("GET", `/issues/${rest[0]}/comments`, [
        ["count", count],
        ["order", "desc"],
      ]);
      break;
    }

    case "inspect":
      if (!rest[0]) die("inspect: <idOrKey> が必要です。", 2);
      await inspect(rest[0], rest[1] || "20");
      break;

    case "search":
      await cmdSearch(rest);
      break;

    case "projects":
      requireCap("read:projects");
      await call("GET", "/projects", []);
      break;

    case "project":
      requireCap("read:projects");
      if (!rest[0]) die("project: <idOrKey> が必要です。", 2);
      validId(rest[0]);
      await call("GET", `/projects/${rest[0]}`, []);
      break;

    case "statuses":
      requireCap("read:meta");
      if (!rest[0]) die("statuses: <projIdOrKey> が必要です。", 2);
      validId(rest[0]);
      await call("GET", `/projects/${rest[0]}/statuses`, []);
      break;

    case "issue-types":
      requireCap("read:meta");
      if (!rest[0]) die("issue-types: <projIdOrKey> が必要です。", 2);
      validId(rest[0]);
      await call("GET", `/projects/${rest[0]}/issueTypes`, []);
      break;

    case "priorities":
      requireCap("read:meta");
      await call("GET", "/priorities", []);
      break;

    case "comment": {
      requireCap("write:comment");
      if (rest.length < 2) die("comment: <idOrKey> <content> が必要です。", 2);
      validId(rest[0]);
      const pairs = [["content", rest[1]]];
      await call("POST", `/issues/${rest[0]}/comments`, pairs);
      break;
    }

    case "update":
      await cmdUpdate(rest);
      break;

    case "create":
      await cmdCreate(rest);
      break;

    case "raw":
      await cmdRaw(rest);
      break;

    default:
      process.stderr.write(`[backlog] 不明なサブコマンド: ${cmd}\n\n`);
      usage();
      process.exit(1);
  }
})();
