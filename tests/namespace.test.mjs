/**
 * Namespace isolation test: two SessionManagers with different dataDir
 * see completely separate session lists, and SessionReader/Writer
 * correctly resolve to namespaced paths.
 */
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, rmSync } from "node:fs";
import { SessionReader, SessionWriter, SessionManager } from "../dist/index.js";

const dataDir = `/tmp/ns-test-${Date.now()}`;
const tmuxName = `ns-test-tmux-${Date.now()}`;
const sessionName = tmuxName;

async function cleanup() {
  try { execFileSync("tmux", ["kill-session", "-t", tmuxName], { stdio: "ignore" }); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

try {
  console.log("=== Namespace isolation E2E ===\n");

  // 起一个真 tmux session 用作 mirror target
  execFileSync("tmux", ["new-session", "-d", "-s", tmuxName, "sleep", "60"]);
  await sleep(300);

  // 1. 用自定义 namespace 起一个 mirror
  console.log(`[1] mirror tmux=${tmuxName} → namespace ${dataDir}`);
  const sm = new SessionManager({ dataDir });
  await sm.mirror(tmuxName, { name: sessionName });
  await sleep(800);

  // 2. 默认 namespace 的 manager 应该完全看不到这个 session
  console.log("[2] default-namespace manager.exists() →", new SessionManager().exists(sessionName));
  // 3. 自定义 namespace 的 manager 应该看到
  console.log("[3] custom-namespace manager.exists() →", sm.exists(sessionName));

  // 4. 验证文件确实落在 dataDir
  console.log(`[4] ${dataDir} exists →`, existsSync(dataDir));

  // 5. SessionReader 走自定义 dataDir 能读到
  const reader = new SessionReader(sessionName, { dataDir });
  const snap = await reader.read();
  console.log("[5] reader path →", reader.path);
  console.log("    snapshot cli_type →", snap.cli_type);

  // 6. 默认 namespace 的 reader 读不到
  const defaultReader = new SessionReader(sessionName);
  console.log("[6] default reader path →", defaultReader.path);
  console.log("    default reader sees blocks →", (await defaultReader.read()).blocks.length);

  // 验证
  const cond1 = new SessionManager().exists(sessionName) === false;
  const cond2 = sm.exists(sessionName) === true;
  const cond3 = reader.path.includes(dataDir);
  const cond4 = !defaultReader.path.includes(dataDir);

  if (cond1 && cond2 && cond3 && cond4) {
    console.log("\n✓ Namespace isolation PASS");
  } else {
    console.log("\n✗ Namespace isolation FAIL", { cond1, cond2, cond3, cond4 });
    process.exit(1);
  }
} finally {
  await cleanup();
}
