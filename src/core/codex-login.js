import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importAuthJson, importAuthJsonString } from "./auth.js";
import { commandExists, spawnInteractive } from "./command.js";
import { AppError } from "./errors.js";

const TEMP_PREFIX = "codex-profile-login-";

export async function loginProfileWithCodex(profileId, options) {
  const { metadataStore, secureStore, profile = {} } = options;

  return withTemporaryCodexHome(async (temporaryCodexHome) => {
    await runCodexLogin({ ...options, temporaryCodexHome });

    return importAuthJson(path.join(temporaryCodexHome, "auth.json"), profileId, {
      metadataStore,
      secureStore,
      profile: {
        ...profile,
        auth_source: "codex_cli_login",
      },
    });
  });
}

export async function refreshProfileAuthWithCodex(profileId, options) {
  const { metadataStore, secureStore, profile: profileOverrides = {} } = options;
  const existing = await metadataStore.getProfile(profileId);
  if (!existing.auth_secret_ref) {
    throw new AppError(
      "PROFILE_AUTH_MISSING",
      `Profile "${profileId}" has no saved auth. Run "codex-profile login ${profileId}" or import-auth first.`,
      { exitCode: 2 },
    );
  }

  const savedAuth = await secureStore.get(profileId);
  validateAuthJson(savedAuth, `Saved auth for profile "${profileId}"`);

  return withTemporaryCodexHome(async (temporaryCodexHome) => {
    await fs.writeFile(path.join(temporaryCodexHome, "auth.json"), savedAuth, {
      mode: 0o600,
    });
    await runCodexLogin({ ...options, temporaryCodexHome });

    const refreshedAuthPath = path.join(temporaryCodexHome, "auth.json");
    let refreshedAuth;
    try {
      refreshedAuth = await fs.readFile(refreshedAuthPath, "utf8");
    } catch (error) {
      throw new AppError(
        "AUTH_JSON_NOT_FOUND",
        "Codex login completed without creating auth.json. The saved profile was left unchanged.",
        { cause: error, exitCode: 2 },
      );
    }
    validateAuthJson(refreshedAuth, "Updated auth from Codex login");

    return importAuthJsonString(refreshedAuth, profileId, {
      metadataStore,
      secureStore,
      profile: mergeProfileMetadata(existing, profileOverrides),
    });
  });
}

async function runCodexLogin({
  env = process.env,
  temporaryCodexHome,
  deviceAuth = false,
  runLogin,
}) {
  try {
    if (runLogin) {
      await runLogin({
        codexHome: temporaryCodexHome,
        deviceAuth,
      });
      return;
    }

    const command = process.platform === "win32" ? "codex.cmd" : "codex";
    if (!(await commandExists(command))) {
      throw new AppError(
        "CODEX_CLI_NOT_FOUND",
        'Codex CLI was not found. Install it first, then run "codex-profile login <profile>" again.',
        { exitCode: 2 },
      );
    }

    const args = ["login"];
    if (deviceAuth) {
      args.push("--device-auth");
    }

    const childEnv = {
      ...env,
      CODEX_HOME: temporaryCodexHome,
    };
    delete childEnv.CODEX_PROFILE_CODEX_HOME;

    await spawnInteractive(command, args, {
      env: childEnv,
      shell: process.platform === "win32",
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      "CODEX_LOGIN_FAILED",
      "Codex login did not complete. The saved profile was left unchanged.",
      { cause: error, exitCode: 2 },
    );
  }
}

async function withTemporaryCodexHome(work) {
  const temporaryCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    return await work(temporaryCodexHome);
  } finally {
    await fs.rm(temporaryCodexHome, { recursive: true, force: true }).catch(() => {});
  }
}

function mergeProfileMetadata(existing, overrides) {
  return {
    display_name: overrides.display_name ?? existing.display_name,
    email: overrides.email ?? existing.email,
    workspace_name: overrides.workspace_name ?? existing.workspace_name,
    plan_type: overrides.plan_type ?? existing.plan_type,
    notes: overrides.notes ?? existing.notes,
    tags: overrides.tags ?? existing.tags,
    auth_source: "codex_cli_login_refresh",
  };
}

function validateAuthJson(value, label) {
  try {
    JSON.parse(value);
  } catch (error) {
    throw new AppError("AUTH_JSON_INVALID", `${label} is not valid auth.json: ${error.message}`, {
      cause: error,
      exitCode: 2,
    });
  }
}
