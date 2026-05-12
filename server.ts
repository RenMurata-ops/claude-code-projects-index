#!/usr/bin/env bun
// Local control panel server for claude-code-projects-index.
// Serves the static page on http://localhost:7777 and adds admin endpoints:
//   GET  /api/health           — used by the page to detect admin mode
//   GET  /api/projects         — curated projects.json merged with live filesystem scan
//   POST /api/open    {path}   — open the path in Ghostty with `claude --dangerously-skip-permissions`
//   POST /api/task    {path,prompt}
//                              — open Ghostty with `claude --dangerously-skip-permissions "<prompt>"`
//   POST /api/delete  {path}   — move the path to macOS Trash (Finder)
//   WS   /ws                   — pushes {type:'projects-changed'} when watched dirs change

import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat, readdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 7777;
const HOME = process.env.HOME || "/Users/renmurata";
const REPO_DIR = import.meta.dir;
const PROJECTS_JSON = path.join(REPO_DIR, "projects.json");
const INDEX_HTML = path.join(REPO_DIR, "index.html");

const SCAN_ROOTS = [HOME, path.join(HOME, "Desktop"), path.join(HOME, "Downloads"), path.join(HOME, "Projects")];
const MARKERS = ["package.json", "Cargo.toml", "tauri.conf.json", "project.yml", "wrangler.toml", "index.html", "README.md", "CLAUDE.md"];
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".next", "Library", "Applications", "Movies", "Music", "Pictures", "Public", "Sites", "Documents",
  ".Trash", ".cache", ".cargo", ".npm", ".pyenv", ".rustup", ".bun", ".docker", ".n8n", ".n8n-runtime", ".swiftpm",
  ".vscode", ".cursor", ".config", ".claude", ".fastlane", ".gem", ".local", ".tauri", ".wrangler", ".supabase",
  ".pm2", ".cocoapods", ".degit", ".rork", ".obsidian-cli.sock", ".blitz", ".asc", ".appstoreconnect", ".ssh",
  ".pixel-agents", "LH", "QuickMemo", "Octoparse", "LocalAppData", "bin", "projects", "supabase", "invoices", "reinstall"
]);

type Project = {
  name: string;
  cat: string;
  tagline: string;
  status: string;
  statusLabel: string;
  stack: string;
  path?: string;
  detail?: string;
  monetize?: string;
  exists?: boolean;
};

let curatedCache: Project[] = [];
async function loadCurated(): Promise<Project[]> {
  const text = await readFile(PROJECTS_JSON, "utf-8");
  curatedCache = JSON.parse(text);
  return curatedCache;
}

async function scanLiveDirectories(): Promise<Project[]> {
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try { entries = await readdir(root); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".") && root === HOME) continue;
      if (EXCLUDE_DIRS.has(name)) continue;
      const full = path.join(root, name);
      if (seen.has(full)) continue;
      seen.add(full);
      let s; try { s = await stat(full); } catch { continue; }
      if (!s.isDirectory()) continue;
      let hasMarker = false;
      try {
        const children = await readdir(full);
        for (const m of MARKERS) { if (children.includes(m)) { hasMarker = true; break; } }
      } catch { continue; }
      if (!hasMarker) continue;
      out.push({
        name, cat: "scaffold", tagline: "(自動検出 — 未分類)",
        status: "scaffold", statusLabel: "auto-detected",
        stack: "(scan)", path: full, detail: ""
      });
    }
  }
  return out;
}

async function mergedProjects(): Promise<Project[]> {
  const curated = await loadCurated();
  const live = await scanLiveDirectories();
  const curatedPaths = new Set(curated.map(p => p.path).filter(Boolean));
  // mark exists for curated
  for (const p of curated) p.exists = p.path ? existsSync(p.path) : true;
  // append live ones not already in curated
  const extras = live.filter(p => !curatedPaths.has(p.path));
  for (const p of extras) p.exists = true;
  return [...curated, ...extras];
}

// ===== shell helpers =====
function shellEscape(s: string): string {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

async function spawnGhostty(workingDir: string, command: string): Promise<void> {
  // write a temp wrapper so we can run multi-token commands reliably via Ghostty -e
  const dir = await mkdtemp(path.join(tmpdir(), "ccpi-"));
  const wrapper = path.join(dir, "run.sh");
  const body = `#!/bin/bash
cd ${shellEscape(workingDir)}
${command}
exec_status=$?
echo
echo "[ccpi] (exited $exec_status) — Enterで閉じる"
read -r _
`;
  await writeFile(wrapper, body, { mode: 0o755 });
  // open -na Ghostty.app --args -e /tmp/.../run.sh
  spawn("open", ["-na", "Ghostty.app", "--args", "--working-directory=" + workingDir, "-e", wrapper], {
    detached: true, stdio: "ignore"
  }).unref();
}

async function moveToTrash(targetPath: string): Promise<{ ok: boolean; err?: string }> {
  // use AppleScript Finder so it goes to ~/.Trash with proper bookkeeping
  return await new Promise((resolve) => {
    const osa = `tell application "Finder" to delete POSIX file ${JSON.stringify(targetPath)}`;
    const p = spawn("osascript", ["-e", osa]);
    let err = "";
    p.stderr.on("data", (d) => err += d.toString());
    p.on("close", (code) => resolve({ ok: code === 0, err: err.trim() || undefined }));
  });
}

// ===== file watcher =====
const wsClients = new Set<any>();
function broadcast(msg: any) {
  const json = JSON.stringify(msg);
  for (const c of wsClients) { try { c.send(json); } catch {} }
}

let scanDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleBroadcast() {
  if (scanDebounce) clearTimeout(scanDebounce);
  scanDebounce = setTimeout(() => broadcast({ type: "projects-changed" }), 600);
}

for (const root of SCAN_ROOTS) {
  if (!existsSync(root)) continue;
  try {
    watch(root, { persistent: false }, (event, fname) => {
      if (!fname) return;
      // ignore hidden/dot-only churn
      if (fname.startsWith(".")) return;
      scheduleBroadcast();
    });
  } catch (e) {
    console.warn("[ccpi] watch failed for", root, e);
  }
}

// ===== HTTP server =====
const server = Bun.serve({
  port: PORT,
  fetch: async (req, srv) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined as any;
      return new Response("ws upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, version: "0.1.0", port: PORT });
    }
    if (url.pathname === "/api/projects") {
      const projects = await mergedProjects();
      return Response.json({ projects });
    }
    if (url.pathname === "/api/open" && req.method === "POST") {
      const { path: p } = await req.json();
      if (!p || !existsSync(p)) return Response.json({ ok: false, err: "path not found" }, { status: 400 });
      await spawnGhostty(p, "claude --dangerously-skip-permissions");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/task" && req.method === "POST") {
      const { path: p, prompt } = await req.json();
      if (!p || !existsSync(p)) return Response.json({ ok: false, err: "path not found" }, { status: 400 });
      if (!prompt || typeof prompt !== "string") return Response.json({ ok: false, err: "prompt required" }, { status: 400 });
      const cmd = "claude --dangerously-skip-permissions " + shellEscape(prompt);
      await spawnGhostty(p, cmd);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { path: p } = await req.json();
      if (!p || !existsSync(p)) return Response.json({ ok: false, err: "path not found" }, { status: 400 });
      // safety guards: must be under HOME, not HOME itself, not too shallow
      const abs = path.resolve(p);
      if (!abs.startsWith(HOME + path.sep)) return Response.json({ ok: false, err: "refusing: not under $HOME" }, { status: 400 });
      if (abs === REPO_DIR) return Response.json({ ok: false, err: "refusing: this is the control panel itself" }, { status: 400 });
      const r = await moveToTrash(abs);
      if (!r.ok) return Response.json({ ok: false, err: r.err || "trash failed" }, { status: 500 });
      scheduleBroadcast();
      return Response.json({ ok: true });
    }
    // static file serving
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const f = Bun.file(path.join(REPO_DIR, filePath));
    if (await f.exists()) return new Response(f);
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { wsClients.add(ws); ws.send(JSON.stringify({ type: "hello" })); },
    message() {},
    close(ws) { wsClients.delete(ws); }
  }
});

console.log(`[ccpi] control panel: http://localhost:${server.port}/`);
console.log(`[ccpi] watching: ${SCAN_ROOTS.join(", ")}`);
