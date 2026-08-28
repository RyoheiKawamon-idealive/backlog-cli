#!/usr/bin/env node
// ===========================================================================
// install.mjs — backlog-cli スキルを「コピー」でインストール/更新する
//
// このスクリプトは自分のフォルダ（= スキル本体）を、指定プロジェクトまたは
// グローバルの skills ディレクトリへコピーする（symlink しない）。再実行すれば
// アップデート（コード上書き・各環境のローカル設定 .backlog-perms は温存）。
//
// 使い方（リポジトリルートから）:
//   node backlog-cli/install.mjs --project <path> [--codex|--claude]
//   node backlog-cli/install.mjs --global [--codex|--claude]
//
// Node 18+ / Windows・macOS・Linux 同一動作。依存パッケージなし。
// ===========================================================================

import {
  existsSync, readdirSync, statSync, mkdirSync, cpSync, chmodSync,
  readFileSync, writeFileSync, rmSync, realpathSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// このスクリプトが置かれているフォルダ = スキル本体。skill 名はフォルダ名。
const srcDir = dirname(fileURLToPath(import.meta.url));
const skill = basename(srcDir);
// 上書き禁止（各環境のローカル秘密・権限設定）
const PRESERVE = new Set([".backlog-perms"]);

function die(msg, code = 1) {
  process.stderr.write(`[install] エラー: ${msg}\n`);
  process.exit(code);
}
function info(msg) {
  process.stdout.write(`[install] ${msg}\n`);
}

function printUsage() {
  process.stdout.write(`使い方（リポジトリルートから）:
  node ${skill}/install.mjs --project <path> [--codex|--claude]
  node ${skill}/install.mjs --global [--codex|--claude]

オプション:
  --project <path>  指定プロジェクトの .codex/skills と .claude/skills へコピー
  --global          ~/.codex/skills と ~/.claude/skills へコピー
  --codex           Codex 側のみ（未指定なら両方）
  --claude          Claude 側のみ（未指定なら両方）
  --dry-run         コピーせず対象だけ表示
  --setup           接続設定ウィザードを起動（ドメイン/APIキー/PJ/アカウント・複数スペース可）
  --no-setup        新規インストール時の設定ウィザードをスキップ
  --perms           権限を対話設定し直す（更新時も強制）。新規インストール時は既定で自動表示
  --no-perms        新規インストール時の権限対話をスキップ（既定が適用）

再実行＝アップデート（コード上書き・ローカルの .backlog-perms は温存）。
`);
}

// コピー後に実行ビットを付与（cpSync がモードを引き継がない環境への保険）
function chmodExecutables(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      chmodExecutables(p);
    } else if (/\.(mjs|sh)$/.test(name)) {
      try {
        chmodSync(p, 0o755);
      } catch {
        /* Windows 等では no-op */
      }
    }
  }
}

// --- 引数解析 -------------------------------------------------------------
const args = process.argv.slice(2);
let project = null;
let global = false;
let codex = false;
let claude = false;
let dryRun = false;
let perms = false;
let noPerms = false;
let setupFlag = false;
let noSetup = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--global": global = true; break;
    case "--codex": codex = true; break;
    case "--claude": claude = true; break;
    case "--dry-run": dryRun = true; break;
    case "--perms": perms = true; break;
    case "--no-perms": noPerms = true; break;
    case "--setup": setupFlag = true; break;
    case "--no-setup": noSetup = true; break;
    case "--project":
      project = args[++i];
      if (!project) die("--project の後にパスが必要です。", 2);
      break;
    case "-h":
    case "--help":
      printUsage();
      process.exit(0);
      break;
    default:
      die(`不明なオプション: ${a}`, 2);
  }
}

// --- 検証 -----------------------------------------------------------------
if (!existsSync(join(srcDir, "SKILL.md"))) {
  die(`SKILL.md が見つかりません（${srcDir}）。スキルフォルダ内で実行してください。`, 2);
}

if (!project && !global) {
  printUsage();
  die("--project <path> か --global のどちらかを指定してください。", 2);
}

// ツール未指定なら両方
if (!codex && !claude) {
  codex = true;
  claude = true;
}

// --- インストール先 skills ディレクトリ群を決定 ---------------------------
const bases = [];
if (project) {
  if (!existsSync(project)) die(`プロジェクトが存在しません: ${project}`, 2);
  bases.push(project);
}
if (global) bases.push(homedir());

const tools = [];
if (codex) tools.push(".codex");
if (claude) tools.push(".claude");

const targets = [];
for (const base of bases) {
  for (const tool of tools) {
    targets.push(join(base, tool, "skills"));
  }
}

// --- コピー実行 -----------------------------------------------------------
// 配布先で秘密ファイルが gitignore されているか検証し、されていなければ警告。
// git リポでなければ何もしない（commit リスクが無いため）。
function warnIfSecretsTracked(skillsDir, dest) {
  for (const secret of PRESERVE) {
    const target = join(dest, secret);
    const r = spawnSync("git", ["-C", skillsDir, "check-ignore", "-q", target], {
      stdio: "ignore",
    });
    // status 0=ignored(安全) / 1=not ignored(警告) / 128=gitリポでない(無視)
    if (r.status === 1) {
      process.stderr.write(
        `\n[install] ⚠ 警告: 配布先リポは ${secret} を gitignore していません:\n` +
        `    ${target}\n` +
        `  ここ（スキル内）に秘密を書くと誤ってコミットされる恐れがあります。\n` +
        `  推奨: 秘密は ~/.config/agent-skills/${skill}.env に置く（コピーに入れない）。\n` +
        `  または配布先の .gitignore に '**/${skill}/${secret}' を追加してください。\n\n`
      );
    }
  }
}

// 配布先で秘密/ローカル設定（PRESERVE）が確実に ignore されるよう dest 内 .gitignore を担保。
// 同梱 .gitignore のコピー漏れ・古いコピーに依存しない。
function ensureGitignore(dest) {
  const gi = join(dest, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = [...PRESERVE].filter((n) => !have.has(n));
  if (missing.length === 0) return;
  let out = cur;
  if (out && !out.endsWith("\n")) out += "\n";
  if (!cur) out += "# ローカル秘密・権限設定（コミット禁止）\n";
  out += missing.join("\n") + "\n";
  writeFileSync(gi, out);
}

function installInto(skillsDir) {
  const dest = join(skillsDir, skill);
  const isUpdate = existsSync(dest);

  // 自己参照ガード: インストール済みコピー内の install.mjs から実行されると
  // srcDir === dest になり、後段の rmSync(dest) がコピー元ごと消してしまう。
  // /var→/private/var 等のシンボリックリンク差を吸収するため realpath で比較する。
  if (existsSync(dest)) {
    try {
      if (realpathSync(srcDir) === realpathSync(dest)) {
        info(`コピー元と同一パスのためスキップ: ${dest}`);
        return;
      }
    } catch { /* realpath 失敗時は通常処理にフォールバック */ }
  }

  if (dryRun) {
    info(`${isUpdate ? "置換" : "新規"}(dry-run): ${srcDir} → ${dest}`);
    return;
  }

  mkdirSync(skillsDir, { recursive: true });

  // クリーン置換: ローカル設定（キー・権限）を退避 → dest を一掃 → 新規コピー → 復元。
  // 更新時に不要になったファイルを残さず（prune）、ローカル設定だけ温存する。手動削除は不要。
  const saved = {};
  for (const name of PRESERVE) {
    const p = join(dest, name);
    if (existsSync(p)) saved[name] = readFileSync(p);
  }
  rmSync(dest, { recursive: true, force: true });
  // install.mjs はインストール先に置かない（コピーに含めると上記の自己参照導線が生まれる。
  // インストーラは置き場リポ側にだけあれば十分）。
  cpSync(srcDir, dest, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      return !PRESERVE.has(b) && b !== "install.mjs";
    },
  });
  for (const [name, buf] of Object.entries(saved)) {
    writeFileSync(join(dest, name), buf);
  }

  chmodExecutables(dest);
  ensureGitignore(dest);
  info(`${isUpdate ? "再インストール(置換)" : "インストール"}: ${dest}`);
  warnIfSecretsTracked(skillsDir, dest);
}

// --- 権限の対話設定（--perms）--------------------------------------------
// cap 一覧と既定はスキルの .backlog-perms.example から読む。
function readCapDefaults(file) {
  if (!existsSync(file)) return null;
  const caps = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const rhs = t.slice(eq + 1);
    const hash = rhs.indexOf("#"); // 行末コメント＝表示ラベル
    const value = (hash >= 0 ? rhs.slice(0, hash) : rhs).trim() === "1";
    const label = hash >= 0 ? rhs.slice(hash + 1).trim() : "";
    caps.push({ key, value, label });
  }
  return caps.length ? caps : null;
}

function writePerms(destSkillDir, caps) {
  const lines = ["# 操作別の許可 (1=許可 / 0=禁止) — インストーラで設定。# 以降はラベル"];
  for (const c of caps) {
    lines.push(`${c.key}=${c.value ? 1 : 0}${c.label ? `    # ${c.label}` : ""}`);
  }
  writeFileSync(join(destSkillDir, ".backlog-perms"), lines.join("\n") + "\n");
}

// ↑↓移動 / Space 切替 / Enter 確定 / a 全ON / n 全OFF / Ctrl-C 中止
function selectCaps(caps) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const state = caps.map((c) => ({ ...c }));
    let idx = 0, drawn = 0;
    const ESC = "\x1b";
    function render() {
      let out = drawn ? `${ESC}[${drawn}A` : "";
      out += `${ESC}[0J`;
      out += "権限を選択（↑↓ / Space切替 / Enter確定 / a全ON / n全OFF / Ctrl-C中止）:\n";
      state.forEach((c, i) => {
        const labelText = c.label ? `${c.label}  (${c.key})` : c.key;
      out += `${i === idx ? "›" : " "} ${c.value ? "[x]" : "[ ]"} ${labelText}\n`;
      });
      drawn = state.length + 1;
      process.stdout.write(out);
    }
    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }
    function onData(key) {
      if (key === "\x03") { cleanup(); process.stdout.write("\n中止しました。\n"); process.exit(130); }
      else if (key === "\r" || key === "\n") { cleanup(); process.stdout.write("\n"); resolve(state); }
      else if (key === " ") { state[idx].value = !state[idx].value; render(); }
      else if (key === "a") { state.forEach((c) => (c.value = true)); render(); }
      else if (key === "n") { state.forEach((c) => (c.value = false)); render(); }
      else if (key === `${ESC}[A` || key === "k") { idx = (idx - 1 + state.length) % state.length; render(); }
      else if (key === `${ESC}[B` || key === "j") { idx = (idx + 1) % state.length; render(); }
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    render();
    stdin.on("data", onData);
  });
}

for (const t of targets) installInto(t);

// 設定が無ければ自動でウィザード起動（更新でも）。--setup で強制、--no-setup で無効。
// 「設定済みなら現状維持の1問だけ」の判定はスキル側（setup --auto）に委ねる。
if (!dryRun && !noSetup && process.stdin.isTTY) {
  const entry = join(targets[0], skill, "backlog.mjs");
  if (existsSync(entry)) {
    const setupArgs = [entry, "setup"];
    if (!setupFlag) setupArgs.push("--auto");
    const r = spawnSync("node", setupArgs, { stdio: "inherit" });
    // 自動 setup は任意なので install 全体は失敗させないが、未完了は黙って成功扱いにしない。
    if (r.error || (typeof r.status === "number" && r.status !== 0)) {
      info(
        `⚠ セットアップウィザードが正常終了しませんでした（中断/失敗）。設定は未完了の可能性があります。` +
        `（config がないと API は全失敗します）\n` +
        `         後で手動実行: node ${join(skill, "backlog.mjs")} setup`
      );
    }
  }
}

// 新規インストールは既定で権限を対話設定。--perms は更新時も強制、--no-perms で無効化。
const alreadyConfigured = targets.some((t) => existsSync(join(t, skill, ".backlog-perms")));
if (!dryRun && !noPerms && (perms || !alreadyConfigured)) {
  const caps = readCapDefaults(join(srcDir, ".backlog-perms.example"));
  if (!caps) {
    // 権限設定を持たないスキルは何もしない
  } else if (!process.stdin.isTTY) {
    if (perms) info("非対話環境のため権限設定をスキップ（既定が適用）。");
  } else {
    const chosen = await selectCaps(caps);
    for (const t of targets) {
      const destSkillDir = join(t, skill);
      if (existsSync(destSkillDir)) {
        writePerms(destSkillDir, chosen);
        info(`権限を書き込み: ${join(destSkillDir, ".backlog-perms")}`);
      }
    }
  }
}

// config 未作成を完了前に警告（setup の終了コードに依存せず実ファイルの有無で判定）。
if (!dryRun && existsSync(join(targets[0], skill, "backlog.mjs"))) {
  const configDir = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agent-skills"
  );
  let envFiles = [];
  try {
    const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // 正規表現メタを無害化
    envFiles = readdirSync(configDir).filter((f) =>
      new RegExp(`^${esc}(\\.[A-Za-z0-9_-]+)?\\.env$`).test(f)
    );
  } catch { /* ディレクトリ未作成なら空のまま */ }
  if (envFiles.length === 0) {
    const installedEntry = join(targets[0], skill, "backlog.mjs");
    process.stderr.write(
      `\n[install] ⚠ 警告: 接続設定(config)が作成されていません。\n` +
      `  config がないと Backlog API は全失敗します。\n` +
      `  以下のコマンドで設定を完了してください:\n` +
      `    node ${installedEntry} setup\n` +
      `    node ${installedEntry} config\n\n`
    );
  }
}

// --- 完了案内 -------------------------------------------------------------
if (!dryRun) {
  process.stdout.write(`\n[install] 完了（${skill}）。\n`);
  process.stdout.write(
    `セットアップ・使い方は ${skill}/README.md / SKILL.md を参照してください。\n`
  );
}
