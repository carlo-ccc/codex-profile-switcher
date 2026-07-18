import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loginProfileWithCodex, refreshProfileAuthWithCodex } from "../src/core/codex-login.js";
import { importAuthJsonString } from "../src/core/auth.js";
import { appHome, codexHome, expandHome } from "../src/core/paths.js";
import { MetadataStore } from "../src/core/metadata-store.js";
import { SecureStore } from "../src/core/secure-store.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = path.join(repoRoot, "bin", "codex-profile.js");

test("adds, lists, and removes a profile", async () => {
  const workspace = await createWorkspace();

  let result = await runCli(
    ["add", "personal", "--email", "user@example.com", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Added profile "personal"/);

  result = await runCli(["list"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /personal/);
  assert.match(result.stdout, /user@example\.com/);

  result = await runCli(["remove", "personal", "--yes"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed profile "personal"/);
});

test("imports auth.json and manually switches profiles", async () => {
  const workspace = await createWorkspace();
  const authPath = await writeAuthFixture(workspace.root, "personal-auth.json", {
    access_token: "sk-personalsecretabcd",
    account: { email: "dev@example.com" },
  });

  let result = await runCli(
    ["import-auth", authPath, "--name", "personal", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Imported auth\.json/);

  result = await runCli(["use", "personal"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Switched to profile "personal"/);

  const activeAuth = JSON.parse(
    await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8"),
  );
  assert.equal(activeAuth.access_token, "sk-personalsecretabcd");

  result = await runCli(["current"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active profile: personal/);
});

test("captures the current Codex auth.json as a reusable profile", async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    `${JSON.stringify({ access_token: "sk-currentsecretabcd" }, null, 2)}\n`,
    { mode: 0o600 },
  );

  let result = await runCli(
    ["capture-current", "personal", "--use", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Captured current Codex auth\.json/);
  assert.match(result.stdout, /Marked "personal" as the active profile metadata/);

  result = await runCli(["current"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active profile: personal/);

  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    `${JSON.stringify({ access_token: "sk-othersecretabcd" }, null, 2)}\n`,
    { mode: 0o600 },
  );

  result = await runCli(["use", "personal"], workspace.env);
  assert.equal(result.status, 0, result.stderr);

  const activeAuth = JSON.parse(
    await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8"),
  );
  assert.equal(activeAuth.access_token, "sk-currentsecretabcd");
});

test("logs into a profile in a temporary Codex home and stores only the captured auth", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  let temporaryCodexHome;

  const profile = await loginProfileWithCodex("personal", {
    env: workspace.env,
    metadataStore,
    secureStore,
    deviceAuth: true,
    profile: { display_name: "Personal" },
    runLogin: async ({ codexHome, deviceAuth }) => {
      temporaryCodexHome = codexHome;
      assert.equal(deviceAuth, true);
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: "login-token" }, account: { email: "me@example.com" } }),
      );
    },
  });

  assert.equal(profile.auth_source, "codex_cli_login");
  assert.equal(profile.email, "me@example.com");
  assert.equal(JSON.parse(await secureStore.get("personal")).tokens.access_token, "login-token");
  await assert.rejects(fs.access(temporaryCodexHome));
  await assert.rejects(fs.access(path.join(workspace.codexDir, "auth.json")));
});

test("refreshes one saved profile without changing the active Codex auth file", async () => {
  const workspace = await createWorkspace();
  const metadataStore = new MetadataStore(workspace.env);
  const secureStore = new SecureStore(workspace.env);
  await importAuthJsonString(
    JSON.stringify({ tokens: { access_token: "old-token", refresh_token: "saved-refresh" } }),
    "personal",
    {
      metadataStore,
      secureStore,
      profile: {
        display_name: "Personal",
        email: "me@example.com",
        notes: "Keep this metadata",
        tags: ["private"],
      },
    },
  );
  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "active-token" } }),
  );

  const refreshed = await refreshProfileAuthWithCodex("personal", {
    env: workspace.env,
    metadataStore,
    secureStore,
    runLogin: async ({ codexHome }) => {
      const saved = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
      assert.equal(saved.tokens.access_token, "old-token");
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: "renewed-token", refresh_token: "renewed-refresh" } }),
      );
    },
  });

  assert.equal(refreshed.auth_source, "codex_cli_login_refresh");
  assert.equal(refreshed.notes, "Keep this metadata");
  assert.deepEqual(refreshed.tags, ["private"]);
  assert.equal(JSON.parse(await secureStore.get("personal")).tokens.access_token, "renewed-token");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8")).tokens.access_token,
    "active-token",
  );
});

test("help documents native login and profile-specific refresh", async () => {
  const workspace = await createWorkspace();
  const result = await runCli(["help"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex-profile login personal \[--device-auth\] \[--use\]/);
  assert.match(result.stdout, /codex-profile refresh-auth personal \[--device-auth\] \[--use\]/);
  assert.match(result.stdout, /codex-profile daemon start \[--interval 15000\]/);
});

test("switch failure rolls back the previous auth.json", async () => {
  const workspace = await createWorkspace();
  const originalAuth = { access_token: "sk-originalsecretabcd" };
  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    `${JSON.stringify(originalAuth, null, 2)}\n`,
    { mode: 0o600 },
  );
  const authPath = await writeAuthFixture(workspace.root, "work-auth.json", {
    access_token: "sk-worksecretabcd",
  });

  let result = await runCli(
    ["import-auth", authPath, "--name", "work", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);

  result = await runCli(["use", "work"], {
    ...workspace.env,
    CODEX_PROFILE_SIMULATE_WRITE_FAILURE: "1",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rollback succeeded/);

  const activeAuth = JSON.parse(
    await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8"),
  );
  assert.equal(activeAuth.access_token, originalAuth.access_token);
});

test("auth backups can be restored", async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    `${JSON.stringify({ access_token: "sk-backupsecretabcd" }, null, 2)}\n`,
    { mode: 0o600 },
  );

  let result = await runCli(["backup", "--accept-boundary"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  const backupPath = result.stdout.match(/Backup created: (.+)/)?.[1].trim();
  assert.ok(backupPath);

  await fs.writeFile(
    path.join(workspace.codexDir, "auth.json"),
    `${JSON.stringify({ access_token: "sk-othersecretabcd" }, null, 2)}\n`,
  );

  result = await runCli(["restore", backupPath], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  const restored = JSON.parse(
    await fs.readFile(path.join(workspace.codexDir, "auth.json"), "utf8"),
  );
  assert.equal(restored.access_token, "sk-backupsecretabcd");
});

test("metadata and command output do not expose sensitive auth fields", async () => {
  const workspace = await createWorkspace();
  const secret = "sk-verysecretvalueabcd";
  const authPath = await writeAuthFixture(workspace.root, "secret-auth.json", {
    access_token: secret,
    refresh_token: "eyJrefreshsecretvalueabcd.eyJmiddlepayloadabcd.eyJsignatureabcd",
    account: { email: "safe@example.com" },
  });

  const result = await runCli(
    ["import-auth", authPath, "--name", "safe", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));

  const metadataRaw = await fs.readFile(
    path.join(workspace.appDir, "profiles.json"),
    "utf8",
  );
  assert.doesNotMatch(metadataRaw, new RegExp(secret));
  assert.doesNotMatch(metadataRaw, /refreshsecretvalueabcd/);
  assert.match(metadataRaw, /auth_secret_ref/);
});

test("running Codex processes block switching by default", async () => {
  const workspace = await createWorkspace();
  const authPath = await writeAuthFixture(workspace.root, "blocked-auth.json", {
    access_token: "sk-blockedsecretabcd",
  });
  let result = await runCli(
    ["import-auth", authPath, "--name", "blocked", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);

  const env = {
    ...workspace.env,
    CODEX_PROFILE_SKIP_PROCESS_CHECK: undefined,
    CODEX_PROFILE_PROCESS_FIXTURE: JSON.stringify([
      { pid: 123, name: "codex", command: "codex" },
    ]),
  };

  result = await runCli(["use", "blocked"], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Codex-related process is running/);
});

test("force close requires explicit confirmation and is not silent", async () => {
  const workspace = await createWorkspace();
  const authPath = await writeAuthFixture(workspace.root, "force-auth.json", {
    access_token: "sk-forcesecretabcd",
  });
  let result = await runCli(
    ["import-auth", authPath, "--name", "force", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);

  const env = {
    ...workspace.env,
    CODEX_PROFILE_SKIP_PROCESS_CHECK: undefined,
    CODEX_PROFILE_PROCESS_FIXTURE: JSON.stringify([
      { pid: 456, name: "codex-cli", command: "codex" },
    ]),
  };

  result = await runCli(["use", "force", "--force-close"], env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /explicit confirmation/);
});

test("exports metadata only", async () => {
  const workspace = await createWorkspace();
  const secret = "sk-exportsecretabcd";
  const authPath = await writeAuthFixture(workspace.root, "export-auth.json", {
    access_token: secret,
  });
  let result = await runCli(
    ["import-auth", authPath, "--name", "exported", "--accept-boundary"],
    workspace.env,
  );
  assert.equal(result.status, 0, result.stderr);

  const outputPath = path.join(workspace.root, "metadata-export.json");
  result = await runCli(["export", "--output", outputPath], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  const exported = await fs.readFile(outputPath, "utf8");
  assert.match(exported, /exported/);
  assert.doesNotMatch(exported, new RegExp(secret));
});

test("doctor reports system, secure storage, files, and active profile", async () => {
  const workspace = await createWorkspace();
  const result = await runCli(["doctor"], workspace.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex Profile Switcher Doctor/);
  assert.match(result.stdout, /Secure storage: available/);
  assert.match(result.stdout, /Active profile: none/);
});

test("forbidden quota-pooling commands are not available", async () => {
  const workspace = await createWorkspace();
  const result = await runCli(["pool"], workspace.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /intentionally not provided/);
});

test("path helpers support home expansion and explicit overrides", () => {
  const env = {
    HOME: path.join(os.tmpdir(), "cps-home"),
    CODEX_PROFILE_SWITCHER_HOME: "~/profiles",
    CODEX_PROFILE_CODEX_HOME: "~/codex-home",
  };

  assert.equal(expandHome("~/x", env), path.join(env.HOME, "x"));
  assert.equal(appHome(env), path.resolve(env.HOME, "profiles"));
  assert.equal(codexHome(env), path.resolve(env.HOME, "codex-home"));
});

async function createWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cps-test-"));
  const appDir = path.join(root, "app");
  const codexDir = path.join(root, "codex");
  await fs.mkdir(appDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(codexDir, { recursive: true, mode: 0o700 });

  return {
    root,
    appDir,
    codexDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODEX_PROFILE_SWITCHER_HOME: appDir,
      CODEX_PROFILE_CODEX_HOME: codexDir,
      CODEX_PROFILE_TEST_STORE: "1",
      CODEX_PROFILE_SKIP_PROCESS_CHECK: "1",
      CODEX_PROFILE_DEBUG: "0",
    },
  };
}

async function writeAuthFixture(root, fileName, content) {
  const filePath = path.join(root, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, {
    mode: 0o600,
  });
  return filePath;
}

async function runCli(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: cleanEnv(env),
      encoding: "utf8",
    });
    return {
      status: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    };
  }
}

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
}
