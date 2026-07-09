import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
}
