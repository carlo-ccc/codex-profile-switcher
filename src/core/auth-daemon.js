import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-utils.js";
import { MetadataStore } from "./metadata-store.js";
import { SecureStore } from "./secure-store.js";
import { startAuthSyncMonitor } from "./auth-sync.js";
import { appHome, daemonLockPath, daemonLogPath, daemonStatePath } from "./paths.js";

const DEFAULT_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;
const DAEMON_ENTRY = fileURLToPath(new URL("../../bin/codex-profile.js", import.meta.url));

export async function getAuthDaemonStatus(env = process.env) {
  let state = null;
  try {
    state = await readJson(daemonStatePath(env), null);
  } catch (error) {
    return daemonStatus({
      state: null,
      running: false,
      healthy: false,
      message: `Daemon state is unreadable: ${error.message}`,
      env,
    });
  }

  const pid = validPid(state?.pid);
  const running = Boolean(pid && isProcessRunning(pid));
  const heartbeatAgeMs = timestampAgeMs(state?.updatedAt);
  const staleAfterMs = HEARTBEAT_INTERVAL_MS * 6;
  const healthy = Boolean(running && heartbeatAgeMs !== null && heartbeatAgeMs <= staleAfterMs);

  let message = "Auth sync daemon is stopped.";
  if (running && healthy) {
    message = "Auth sync daemon is running and healthy.";
  } else if (running) {
    message = "Auth sync daemon process exists, but its heartbeat is stale.";
  } else if (state?.pid) {
    message = "Auth sync daemon is stopped; stale state will be replaced on the next start.";
  }

  return daemonStatus({ state, running, healthy, heartbeatAgeMs, message, env });
}

export async function startAuthDaemon(options = {}) {
  const env = options.env || process.env;
  await ensureDir(appHome(env));
  const releaseStartLock = await acquireStartLock(env);
  try {
    return await startAuthDaemonUnlocked(options);
  } finally {
    await releaseStartLock();
  }
}

async function startAuthDaemonUnlocked(options) {
  const env = options.env || process.env;
  const intervalMs = normalizeIntervalMs(options.intervalMs ?? env.CODEX_PROFILE_AUTH_SYNC_INTERVAL_MS);
  const before = await getAuthDaemonStatus(env);

  if (before.running) {
    if (!before.healthy) {
      throw new AppError(
        "AUTH_DAEMON_UNHEALTHY",
        `Auth sync daemon process ${before.pid} exists, but its heartbeat is stale. Stop it before starting another copy.`,
        { exitCode: 2 },
      );
    }
    return { ...before, alreadyRunning: true };
  }

  await fs.rm(daemonStatePath(env), { force: true });
  const log = await fs.open(daemonLogPath(env), "a", 0o600);
  const instanceId = randomUUID();
  let child;

  try {
    child = spawn(
      process.execPath,
      [DAEMON_ENTRY, "daemon-run", "--interval", String(intervalMs), "--instance", instanceId],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: daemonEnvironment(env),
      },
    );
    child.unref();
  } catch (error) {
    throw new AppError("AUTH_DAEMON_START_FAILED", "Unable to start the auth sync daemon.", {
      cause: error,
    });
  } finally {
    await log.close();
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getAuthDaemonStatus(env);
    if (status.running && status.instanceId === instanceId) {
      return { ...status, alreadyRunning: false };
    }
    if (child.exitCode !== null) {
      break;
    }
    await delay(100);
  }

  throw new AppError(
    "AUTH_DAEMON_START_FAILED",
    `The auth sync daemon did not become ready. Check ${daemonLogPath(env)}.`,
    { exitCode: 2 },
  );
}

export async function stopAuthDaemon(options = {}) {
  const env = options.env || process.env;
  const before = await getAuthDaemonStatus(env);
  if (!before.running) {
    await fs.rm(daemonStatePath(env), { force: true });
    return { ...before, alreadyStopped: true };
  }

  if (!before.healthy) {
    throw new AppError(
      "AUTH_DAEMON_STOP_UNSAFE",
      `Refusing to signal process ${before.pid} because the daemon heartbeat is stale. Verify the PID before stopping it manually.`,
      { exitCode: 2 },
    );
  }

  try {
    process.kill(before.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw new AppError("AUTH_DAEMON_STOP_FAILED", "Unable to stop the auth sync daemon.", {
        cause: error,
      });
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(before.pid)) {
      await fs.rm(daemonStatePath(env), { force: true });
      return {
        ...(await getAuthDaemonStatus(env)),
        alreadyStopped: false,
      };
    }
    await delay(100);
  }

  throw new AppError(
    "AUTH_DAEMON_STOP_TIMEOUT",
    `Auth sync daemon ${before.pid} did not stop after ${STOP_TIMEOUT_MS / 1000} seconds.`,
    { exitCode: 2 },
  );
}

export async function restartAuthDaemon(options = {}) {
  const env = options.env || process.env;
  const status = await getAuthDaemonStatus(env);
  if (status.running) {
    await stopAuthDaemon({ env });
  } else {
    await fs.rm(daemonStatePath(env), { force: true });
  }
  return startAuthDaemon(options);
}

export async function runAuthDaemon(options = {}) {
  const env = options.env || process.env;
  const intervalMs = normalizeIntervalMs(options.intervalMs ?? env.CODEX_PROFILE_AUTH_SYNC_INTERVAL_MS);
  const instanceId = options.instanceId || randomUUID();
  const existing = await getAuthDaemonStatus(env);
  if (existing.running && existing.pid !== process.pid) {
    throw new AppError(
      "AUTH_DAEMON_ALREADY_RUNNING",
      `Auth sync daemon is already running as process ${existing.pid}.`,
      { exitCode: 2 },
    );
  }

  const metadataStore = options.metadataStore || new MetadataStore(env);
  const secureStore = options.secureStore || new SecureStore(env);
  const monitor = startAuthSyncMonitor({ env, metadataStore, secureStore, intervalMs });
  const startedAt = new Date().toISOString();
  let stopping = false;

  const writeState = async (extra = {}) => {
    const sync = monitor.getStatus();
    await writeJsonAtomic(
      daemonStatePath(env),
      {
        version: 1,
        pid: process.pid,
        instanceId,
        startedAt,
        updatedAt: new Date().toISOString(),
        intervalMs: monitor.intervalMs,
        sync,
        ...extra,
      },
      0o600,
    );
  };

  await monitor.ready;
  await writeState();
  const heartbeat = setInterval(() => {
    writeState().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  await new Promise((resolve) => {
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  clearInterval(heartbeat);
  await monitor.stop();
  await writeState({ stoppedAt: new Date().toISOString() }).catch(() => {});
}

function daemonStatus({ state, running, healthy, heartbeatAgeMs = null, message, env }) {
  return {
    running,
    healthy,
    pid: validPid(state?.pid),
    instanceId: typeof state?.instanceId === "string" ? state.instanceId : null,
    startedAt: state?.startedAt || null,
    updatedAt: state?.updatedAt || null,
    intervalMs: Number.isFinite(Number(state?.intervalMs)) ? Number(state.intervalMs) : null,
    heartbeatAgeMs,
    sync: state?.sync || null,
    statePath: daemonStatePath(env),
    logPath: daemonLogPath(env),
    message,
  };
}

function daemonEnvironment(env) {
  const allowedNames = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATH",
    "SystemRoot",
    "ComSpec",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]);
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      (allowedNames.has(key) || key === "CODEX_HOME" || key.startsWith("CODEX_PROFILE_"))
    ) {
      result[key] = String(value);
    }
  }
  return result;
}

async function acquireStartLock(env) {
  const lockPath = daemonLockPath(env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw new AppError("AUTH_DAEMON_LOCK_FAILED", "Unable to create the daemon start lock.", {
          cause: error,
        });
      }

      const stale = await startLockIsStale(lockPath);
      if (stale && attempt === 0) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      throw new AppError(
        "AUTH_DAEMON_START_IN_PROGRESS",
        "Another auth sync daemon start is already in progress. Try again in a few seconds.",
        { exitCode: 2 },
      );
    }
  }

  throw new AppError("AUTH_DAEMON_LOCK_FAILED", "Unable to acquire the daemon start lock.");
}

async function startLockIsStale(lockPath) {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > START_TIMEOUT_MS * 2;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function validPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function timestampAgeMs(value) {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function normalizeIntervalMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1_000) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.min(Math.round(number), 60 * 60 * 1000);
}
