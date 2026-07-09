import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startGuiServer } from "../src/gui/server.js";

test("serves the GUI shell and protects mutating API calls until acknowledged", async (t) => {
  const workspace = await createWorkspace();
  const gui = await startGuiServer({ env: workspace.env, port: 0 });
  t.after(() => gui.close());

  const page = await fetch(gui.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Codex Profile Switcher/);

  const blocked = await postJson(gui.url, "/api/profiles", {
    profileId: "personal",
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, "BOUNDARY_ACK_REQUIRED");

  const acknowledged = await postJson(gui.url, "/api/acknowledge", {});
  assert.equal(acknowledged.status, 200);
  assert.ok(acknowledged.body.state.policy.manual_switching_acknowledged_at);

  const created = await postJson(gui.url, "/api/profiles", {
    profileId: "personal",
    email: "dev@example.com",
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.state.profileCount, 1);
  assert.equal(created.body.state.profiles[0].profile_id, "personal");
});

test("imports auth through the GUI API and switches manually", async (t) => {
  const workspace = await createWorkspace();
  const gui = await startGuiServer({ env: workspace.env, port: 0 });
  t.after(() => gui.close());

  await postJson(gui.url, "/api/acknowledge", {});
  const imported = await postJson(gui.url, "/api/import-auth", {
    profileId: "work",
    displayName: "Work",
    authJson: JSON.stringify({
      access_token: "sk-guiimportsecretabcd",
      account: { email: "gui@example.com" },
    }),
    useAfterImport: true,
  });

  assert.equal(imported.status, 200);
  assert.equal(imported.body.state.activeProfileId, "work");
  assert.equal(imported.body.state.profiles[0].email, "gui@example.com");

  const activeAuth = JSON.parse(
    await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8"),
  );
  assert.equal(activeAuth.access_token, "sk-guiimportsecretabcd");
});

test("reports current active profile usage through the GUI API", async (t) => {
  const workspace = await createWorkspace();
  const usageServer = await startUsageFixture((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-access-token");
    assert.equal(request.headers["chatgpt-account-id"], "acc_test");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: 1_893_456_000,
          },
          secondary_window: {
            used_percent: 50,
            limit_window_seconds: 604_800,
            reset_at: 1_893_888_000,
          },
        },
        credits: {
          has_credits: true,
          unlimited: false,
          balance: "$3.50",
        },
      }),
    );
  });
  t.after(() => usageServer.close());

  const gui = await startGuiServer({
    env: {
      ...workspace.env,
      CODEX_PROFILE_USAGE_ENDPOINT: usageServer.url,
    },
    port: 0,
  });
  t.after(() => gui.close());

  await postJson(gui.url, "/api/acknowledge", {});
  await postJson(gui.url, "/api/import-auth", {
    profileId: "work",
    displayName: "Work",
    authJson: JSON.stringify({
      tokens: {
        access_token: "test-access-token",
        account_id: "acc_test",
      },
      account: { email: "gui@example.com" },
    }),
    useAfterImport: true,
  });

  const usage = await getJson(gui.url, "/api/usage");
  assert.equal(usage.status, 200);
  assert.equal(usage.body.usage.status, "ok");
  assert.equal(usage.body.usage.profileId, "work");
  assert.equal(usage.body.usage.planType, "plus");
  assert.equal(usage.body.usage.primary.usedPercent, 25);
  assert.equal(usage.body.usage.primary.remainingPercent, 75);
  assert.equal(usage.body.usage.credits.balance, "$3.50");
});

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cps-gui-test-"));
  const appDir = path.join(root, "app");
  const codexDir = path.join(root, "codex");
  await fs.mkdir(appDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });

  return {
    root,
    appDir,
    codexDir,
    env: cleanEnv({
      ...process.env,
      NODE_ENV: "test",
      CODEX_PROFILE_SWITCHER_HOME: appDir,
      CODEX_PROFILE_CODEX_HOME: codexDir,
      CODEX_PROFILE_TEST_STORE: "1",
      CODEX_PROFILE_SKIP_PROCESS_CHECK: "1",
      CODEX_PROFILE_DEBUG: "0",
    }),
  };
}

async function getJson(baseUrl, requestPath) {
  const response = await fetch(new URL(requestPath, baseUrl));
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function postJson(baseUrl, requestPath, body) {
  const response = await fetch(new URL(requestPath, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function startUsageFixture(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/usage`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
}
