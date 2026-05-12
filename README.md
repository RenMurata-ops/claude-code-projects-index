# Claude Code Projects Index

このiMac上で Claude Code CLI を中核に組み上げてきた **アプリ / Webサービス / LP / ツール / 構想** の総覧 + ローカルコントロールパネル。

- **読み取り専用ページ (公開)**: https://renmurata-ops.github.io/claude-code-projects-index/
- **コントロールパネル (このMacのみ)**: `http://localhost:7777/`

## モードの違い

| | GitHub Pages | localhost:7777 |
|---|---|---|
| プロジェクト一覧 | `projects.json` 静的 | `projects.json` + ホーム配下スキャン |
| リアルタイム更新 | 無 | ファイル監視 → WebSocket |
| Ghostty 起動 | 無 | ▸ ボタンで `claude --dangerously-skip-permissions` |
| タスク投入 | 無 | ⚡ ボタン → モーダル → プロンプト付きで Ghostty 起動 |
| ゴミ箱削除 | 無 | 🗑 ボタン → Finder → ~/.Trash |

## 起動

### フォアグラウンド (手動)

```bash
cd ~/claude-code-projects-index
./start.sh
# → http://localhost:7777/
```

### launchd で常駐 (自動起動)

```bash
cp com.renmurata.ccpi.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.renmurata.ccpi.plist
# 停止:
# launchctl unload ~/Library/LaunchAgents/com.renmurata.ccpi.plist
```

ログ: `ccpi.log` / `ccpi.err.log`

## アーキテクチャ

- **server.ts** — Bun製。HTTP + WebSocket。`fs.watch` でホーム/Desktop/Downloads/Projects を監視
- **index.html** — フロントエンド。`/api/health` の応答で localhost / Pages を自動判別。localhost時のみ admin UI 表示
- **projects.json** — キュレーション済みメタデータ。手で書き換えて push 可
- **Ghostty 連携** — `open -na Ghostty.app --args --working-directory=<path> -e <tempscript>`。tempscript内で `cd && claude --dangerously-skip-permissions [prompt]` を実行

## API

| エンドポイント | 用途 |
|---|---|
| `GET /api/health` | admin mode 検出 |
| `GET /api/projects` | curated + live scan のマージ済み一覧 |
| `POST /api/open` `{path}` | Ghostty を開いて `claude --dangerously-skip-permissions` |
| `POST /api/task` `{path,prompt}` | Ghostty で `claude --dangerously-skip-permissions "<prompt>"` |
| `POST /api/delete` `{path}` | macOSゴミ箱へ移動 (Finder経由) |
| `WS /ws` | `{type:"projects-changed"}` を push |

## 安全策

- `/api/delete` は `$HOME` 配下に限定。コントロールパネル自身は削除拒否
- WebSocket は localhost 内のみ (Bind = ::: のため 127.0.0.1 + ::1 共に受付)
- 認証なし — 信頼できる端末のみで起動すること
