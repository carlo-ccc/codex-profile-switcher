import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  getAuthDaemonStatus,
  stopAuthDaemon,
} from "../src/core/auth-daemon.js";
import { importAuthJsonString } from "../src/core/auth.js";
import { DEFAULT_AUTH_SYNC_INTERVAL_MS } from "../src/core/auth-sync.js";
import { MetadataStore } from "../src/core/metadata-store.js";
import { SecureStore } from "../src/core/secure-store.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = path.join(repoRoot, "bin", "codex-profile.js");

test("default auth sync interval is ten minutes", () => {
  assert.equal(DEFAULT_AUTH_SYNC_INTERVAL_MS, 600_000);
});

test("detached daemon keeps rotated credentials after the starter exits", async (t) => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  const initial = chatGptAuth("acc_personal", "initial-refresh", "initial");
  const rotated = chatGptAuth("acc_personal", "rotated-refresh", "rotated");

  await importAuthJsonString(JSON.stringify(initial), "personal", {
    metadataStore,
    secureStore,
  });
  await metadataStore.setActiveProfile("personal");
  await fs.writeFile(workspace.authPath, JSON.stringify(initial), { mode: 0o600 });

  await execFileAsync(
    process.execPath,
    [binPath, "daemon", "start", "--interval", "1000", "--accept-boundary"],
    { env: workspace.env },
  );
  const started = await getAuthDaemonStatus(workspace.env);
  t.after(async () => {
    const status = await getAuthDaemonStatus(workspace.env);
    if (status.running && status.healthy) {
      await stopAuthDaemon({ env: workspace.env });
    }
  });

  assert.equal(started.running, true);
  assert.equal(started.healthy, true);
  assert.ok(started.pid > 0);

  await fs.writeFile(workspace.authPath, JSON.stringify(rotated), { mode: 0o600 });
  await waitFor(async () => {
    const saved = JSON.parse(await secureStore.get("personal"));
    return saved.tokens.refresh_token === "rotated-refresh";
  });

  const stopped = await stopAuthDaemon({ env: workspace.env });
  assert.equal(stopped.running, false);
  assert.equal((await getAuthDaemonStatus(workspace.env)).running, false);
});

function chatGptAuth(accountId, refreshToken, marker) {
  return {
    tokens: {
      id_token: jwt({
        sub: `user-${accountId}`,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
      access_token: jwt({ sub: `user-${accountId}`, exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: refreshToken,
      account_id: accountId,
      marker,
    },
  };
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms`);
}

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cps-auth-daemon-"));
  const appDir = path.join(root, "app");
  const codexDir = path.join(root, "codex");
  await fs.mkdir(appDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });
  return {
    root,
    appDir,
    codexDir,
    authPath: path.join(codexDir, "auth.json"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODEX_PROFILE_SWITCHER_HOME: appDir,
      CODEX_PROFILE_CODEX_HOME: codexDir,
      CODEX_PROFILE_TEST_STORE: "1",
      CODEX_PROFILE_SKIP_PROCESS_CHECK: "1",
    },
  };
}
