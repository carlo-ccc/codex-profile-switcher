import fs from "node:fs/promises";
import path from "node:path";
import { authJsonPath, backupDir } from "./paths.js";
import {
  ensureDir,
  formatMode,
  getUnixMode,
  pathExists,
  writeFileAtomic,
} from "./fs-utils.js";
import { AppError } from "./errors.js";
import { createSecretRef } from "./metadata-store.js";
import { assertSwitchCanProceed } from "./process-detect.js";

export async function importAuthJson(filePath, profileId, options) {
  const raw = await fs.readFile(filePath, "utf8");
  return importAuthJsonString(raw, profileId, options);
}

export async function importCurrentAuthJson(profileId, options) {
  const { env = process.env } = options;
  const currentAuthPath = authJsonPath(env);
  if (!(await pathExists(currentAuthPath))) {
    throw new AppError(
      "AUTH_JSON_NOT_FOUND",
      `No active Codex auth.json found at ${currentAuthPath}. Run "codex login" first, then capture the current auth again.`,
      { exitCode: 2 },
    );
  }

  return importAuthJson(currentAuthPath, profileId, {
    ...options,
    profile: {
      ...options.profile,
      auth_source: "current_codex_auth_json",
    },
  });
}

export async function importAuthJsonString(authContent, profileId, options) {
  const { metadataStore, secureStore, profile = {} } = options;
  let parsed;
  try {
    parsed = JSON.parse(authContent);
  } catch (error) {
    throw new AppError("AUTH_JSON_INVALID", `Invalid auth.json: ${error.message}`, {
      cause: error,
      exitCode: 2,
    });
  }

  const email = profile.email || findFirstValueByKey(parsed, ["email", "user_email"]);
  const now = new Date().toISOString();

  await secureStore.set(profileId, authContent);
  let saved;
  try {
    saved = await metadataStore.upsertProfile({
      profile_id: profileId,
      display_name: profile.display_name || profileId,
      email: email || "",
      workspace_name:
        profile.workspace_name ||
        findFirstValueByKey(parsed, ["workspace_name", "workspace"]) ||
        "",
      plan_type: profile.plan_type || "",
      auth_source: profile.auth_source || "imported_auth_json",
      auth_secret_ref: createSecretRef(profileId),
      notes: profile.notes || "",
      tags: profile.tags || [],
      updated_at: now,
    });
  } catch (error) {
    await secureStore.delete(profileId).catch(() => {});
    throw error;
  }

  return saved;
}

export async function switchProfile(profileId, options) {
  const {
    env = process.env,
    metadataStore,
    secureStore,
    stdout,
    allowRunning = false,
    forceClose = false,
    confirmForceClose = false,
  } = options;

  await assertSwitchCanProceed({
    env,
    allowRunning,
    forceClose,
    confirmForceClose,
  });

  const profile = await metadataStore.getProfile(profileId);
  if (!profile.auth_secret_ref) {
    throw new AppError(
      "PROFILE_AUTH_MISSING",
      `Profile "${profileId}" has no imported auth.json. Run import-auth first.`,
      { exitCode: 2 },
    );
  }

  const authContent = await secureStore.get(profileId);
  validateAuthJsonString(authContent);

  const authPath = authJsonPath(env);
  stdout?.write?.(`Will update: ${authPath}\n`);
  const backup = await backupAuthJson(env);
  if (backup) {
    stdout?.write?.(`Backup created: ${backup}\n`);
  } else {
    stdout?.write?.("No existing auth.json found; no backup was needed.\n");
  }

  try {
    await writeCodexAuth(authPath, authContent);
    await metadataStore.setActiveProfile(profileId);
    return {
      profile,
      authPath,
      backup,
    };
  } catch (error) {
    const rolledBack = await rollbackAuthJson(authPath, backup);
    throw new AppError(
      "SWITCH_WRITE_FAILED",
      `Switch failed while writing auth.json; rollback ${
        rolledBack ? "succeeded" : "failed"
      }.`,
      { cause: error },
    );
  }
}

export async function backupAuthJson(env = process.env) {
  const authPath = authJsonPath(env);
  if (!(await pathExists(authPath))) {
    return null;
  }

  const destinationDir = backupDir(env);
  await ensureDir(destinationDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(destinationDir, `auth-${timestamp}.json`);
  await fs.copyFile(authPath, destination);
  if (process.platform !== "win32") {
    await fs.chmod(destination, 0o600);
  }
  return destination;
}

export async function restoreAuthJson(backupPath, env = process.env) {
  if (!(await pathExists(backupPath))) {
    throw new AppError("BACKUP_NOT_FOUND", `Backup not found: ${backupPath}`, {
      exitCode: 2,
    });
  }
  const authPath = authJsonPath(env);
  await ensureDir(path.dirname(authPath));
  await fs.copyFile(backupPath, authPath);
  if (process.platform !== "win32") {
    await fs.chmod(authPath, 0o600);
  }
  return authPath;
}

export async function getAuthFileStatus(env = process.env) {
  const authPath = authJsonPath(env);
  const exists = await pathExists(authPath);
  if (!exists) {
    return {
      path: authPath,
      exists,
      permissions: "missing",
      secure: false,
    };
  }

  const mode = await getUnixMode(authPath);
  const secure = process.platform === "win32" || (mode & 0o077) === 0;
  return {
    path: authPath,
    exists,
    permissions: formatMode(mode),
    secure,
  };
}

async function writeCodexAuth(authPath, authContent) {
  await ensureDir(path.dirname(authPath));
  await writeFileAtomic(authPath, normalizeAuthJsonString(authContent), 0o600);
}

async function rollbackAuthJson(authPath, backup) {
  try {
    if (backup) {
      await fs.copyFile(backup, authPath);
      if (process.platform !== "win32") {
        await fs.chmod(authPath, 0o600);
      }
      return true;
    }

    await fs.rm(authPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function validateAuthJsonString(authContent) {
  try {
    JSON.parse(authContent);
  } catch (error) {
    throw new AppError("AUTH_JSON_INVALID", `Stored auth.json is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function normalizeAuthJsonString(authContent) {
  const parsed = JSON.parse(authContent);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function findFirstValueByKey(value, keys) {
  if (!value || typeof value !== "object") {
    return "";
  }

  for (const [key, entry] of Object.entries(value)) {
    if (keys.includes(key) && typeof entry === "string") {
      return entry;
    }

    if (entry && typeof entry === "object") {
      const nested = findFirstValueByKey(entry, keys);
      if (nested) {
        return nested;
      }
    }
  }

  return "";
}
