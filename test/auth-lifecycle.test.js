import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importAuthJsonString, switchProfile } from "../src/core/auth.js";
import { syncActiveProfileAuth, startAuthSyncMonitor } from "../src/core/auth-sync.js";
import { MetadataStore } from "../src/core/metadata-store.js";
import { SecureStore } from "../src/core/secure-store.js";
import { ensureProfileAuthFresh } from "../src/core/token-refresh.js";

test("saves token updates made by a running Codex session back to the active profile", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  const savedAuth = chatGptAuth("acc_personal", "old-refresh", -60, "old");
  const currentAuth = chatGptAuth("acc_personal", "rotated-refresh", 3600, "current");

  await importAuthJsonString(JSON.stringify(savedAuth), "personal", {
    metadataStore,
    secureStore,
  });
  await metadataStore.setActiveProfile("personal");
  await fs.writeFile(workspace.authPath, JSON.stringify(currentAuth), { mode: 0o600 });

  const result = await syncActiveProfileAuth({
    env: workspace.env,
    metadataStore,
    secureStore,
  });

  assert.equal(result.status, "synced");
  const stored = JSON.parse(await secureStore.get("personal"));
  assert.equal(stored.tokens.refresh_token, "rotated-refresh");
  assert.equal(stored.tokens.marker, "current");
  const profile = await metadataStore.getProfile("personal");
  assert.ok(profile.auth_synced_at);
  assert.ok(profile.auth_expires_at);
});

test("does not overwrite a profile when the current auth belongs to another account", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  const savedAuth = chatGptAuth("acc_personal", "personal-refresh", 3600, "saved");

  await importAuthJsonString(JSON.stringify(savedAuth), "personal", {
    metadataStore,
    secureStore,
  });
  await metadataStore.setActiveProfile("personal");
  await fs.writeFile(
    workspace.authPath,
    JSON.stringify(chatGptAuth("acc_work", "work-refresh", 3600, "other")),
    { mode: 0o600 },
  );

  const result = await syncActiveProfileAuth({
    env: workspace.env,
    metadataStore,
    secureStore,
  });

  assert.equal(result.status, "identity-mismatch");
  assert.equal(JSON.parse(await secureStore.get("personal")).tokens.refresh_token, "personal-refresh");
});

test("refreshes an expired saved OAuth login and keeps rotated refresh tokens", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  const savedAuth = chatGptAuth("acc_personal", "old-refresh", -60, "expired");

  await importAuthJsonString(JSON.stringify(savedAuth), "personal", {
    metadataStore,
    secureStore,
  });

  const result = await ensureProfileAuthFresh("personal", {
    env: workspace.env,
    metadataStore,
    secureStore,
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://auth.openai.com/oauth/token");
      const body = new URLSearchParams(request.body);
      assert.equal(body.get("refresh_token"), "old-refresh");
      return jsonResponse({
        access_token: jwt({ sub: "user-acc_personal", exp: unixNow() + 3600 }),
        refresh_token: "rotated-refresh",
      });
    },
  });

  assert.equal(result.status, "refreshed");
  const stored = JSON.parse(await secureStore.get("personal"));
  assert.equal(stored.tokens.refresh_token, "rotated-refresh");
  assert.equal(stored.tokens.marker, "expired");
  const profile = await metadataStore.getProfile("personal");
  assert.ok(profile.auth_refreshed_at);
  assert.equal(profile.auth_health, "fresh");
});

test("switching refreshes an expired target before writing auth.json", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  await importAuthJsonString(
    JSON.stringify(chatGptAuth("acc_work", "old-work-refresh", -60, "expired")),
    "work",
    { metadataStore, secureStore },
  );

  const output = [];
  await switchProfile("work", {
    env: workspace.env,
    metadataStore,
    secureStore,
    stdout: { write: (value) => output.push(String(value)) },
    fetchImpl: async () =>
      jsonResponse({
        access_token: jwt({ sub: "user-acc_work", exp: unixNow() + 7200 }),
        refresh_token: "new-work-refresh",
      }),
  });

  const active = JSON.parse(await fs.readFile(workspace.authPath, "utf8"));
  assert.equal(active.tokens.refresh_token, "new-work-refresh");
  assert.match(output.join(""), /Refreshed the saved OAuth login/);
});

test("auth sync monitor can capture a later token rotation and stop cleanly", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  const initial = chatGptAuth("acc_personal", "first-refresh", 3600, "first");
  await importAuthJsonString(JSON.stringify(initial), "personal", { metadataStore, secureStore });
  await metadataStore.setActiveProfile("personal");
  await fs.writeFile(workspace.authPath, JSON.stringify(initial), { mode: 0o600 });

  const monitor = startAuthSyncMonitor({
    env: workspace.env,
    metadataStore,
    secureStore,
    intervalMs: 60_000,
  });
  await monitor.ready;
  await fs.writeFile(
    workspace.authPath,
    JSON.stringify(chatGptAuth("acc_personal", "second-refresh", 7200, "second")),
    { mode: 0o600 },
  );
  const result = await monitor.runNow();
  await monitor.stop();

  assert.equal(result.status, "synced");
  assert.equal(JSON.parse(await secureStore.get("personal")).tokens.refresh_token, "second-refresh");
});

test("blocks file switching when Codex is explicitly configured for keyring credentials", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  await fs.writeFile(
    path.join(workspace.codexDir, "config.toml"),
    'cli_auth_credentials_store = "keyring"\n',
  );
  await importAuthJsonString(
    JSON.stringify(chatGptAuth("acc_personal", "saved-refresh", 3600, "saved")),
    "personal",
    { metadataStore, secureStore },
  );

  await assert.rejects(
    switchProfile("personal", {
      env: workspace.env,
      metadataStore,
      secureStore,
    }),
    (error) => error.code === "CODEX_CREDENTIAL_STORE_INCOMPATIBLE",
  );
});

function chatGptAuth(accountId, refreshToken, expiresInSeconds, marker) {
  return {
    tokens: {
      id_token: jwt({
        sub: `user-${accountId}`,
        email: `${accountId}@example.com`,
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
      access_token: jwt({ sub: `user-${accountId}`, exp: unixNow() + expiresInSeconds }),
      refresh_token: refreshToken,
      account_id: accountId,
      marker,
    },
    last_refresh: new Date().toISOString(),
  };
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cps-auth-lifecycle-"));
  const appDir = path.join(root, "app");
  const codexDir = path.join(root, "codex");
  await fs.mkdir(appDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });
  return {
    root,
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
