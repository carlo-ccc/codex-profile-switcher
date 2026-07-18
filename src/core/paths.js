import os from "node:os";
import path from "node:path";

export function expandHome(input, env = process.env) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return env.HOME || os.homedir();
  }

  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(env.HOME || os.homedir(), input.slice(2));
  }

  return input;
}

export function appHome(env = process.env) {
  return path.resolve(
    expandHome(
      env.CODEX_PROFILE_SWITCHER_HOME ||
        path.join(env.HOME || os.homedir(), ".codex-profile-switcher"),
      env,
    ),
  );
}

export function codexHome(env = process.env) {
  return path.resolve(
    expandHome(
      env.CODEX_PROFILE_CODEX_HOME ||
        env.CODEX_HOME ||
        path.join(env.HOME || os.homedir(), ".codex"),
      env,
    ),
  );
}

export function metadataPath(env = process.env) {
  return path.join(appHome(env), "profiles.json");
}

export function policyPath(env = process.env) {
  return path.join(appHome(env), "policy.json");
}

export function backupDir(env = process.env) {
  return path.join(appHome(env), "backups");
}

export function daemonStatePath(env = process.env) {
  return path.join(appHome(env), "auth-sync-daemon.json");
}

export function daemonLogPath(env = process.env) {
  return path.join(appHome(env), "auth-sync-daemon.log");
}

export function daemonLockPath(env = process.env) {
  return path.join(appHome(env), ".auth-sync-daemon-start.lock");
}

export function authJsonPath(env = process.env) {
  return path.join(codexHome(env), "auth.json");
}

export function configTomlPath(env = process.env) {
  return path.join(codexHome(env), "config.toml");
}

export function testSecureStorePath(env = process.env) {
  return path.join(appHome(env), "test-secure-store.json");
}
