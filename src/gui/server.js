import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupAuthJson, getAuthFileStatus, importAuthJsonString, restoreAuthJson, switchProfile } from "../core/auth.js";
import { collectDoctorReport } from "../core/doctor.js";
import { AppError, toAppError } from "../core/errors.js";
import { MetadataStore } from "../core/metadata-store.js";
import { readPolicy, writePolicyAcknowledgement, ensurePolicyAcknowledged } from "../core/policy.js";
import { assertSwitchCanProceed, detectCodexProcesses } from "../core/process-detect.js";
import { redactText } from "../core/redaction.js";
import { normalizeTags } from "../core/profile-id.js";
import { SecureStore } from "../core/secure-store.js";
import { getActiveProfileUsage } from "../core/usage.js";
import { startAuthSyncMonitor } from "../core/auth-sync.js";
import {
  appHome,
  authJsonPath,
  codexHome,
  configTomlPath,
  expandHome,
  metadataPath,
} from "../core/paths.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATIC_FILES = new Set(["index.html", "assets/app.css", "assets/app.js"]);

export async function startGuiServer(options = {}) {
  const env = options.env || process.env;
  const host = options.host || DEFAULT_HOST;
  const port = normalizePort(options.port ?? DEFAULT_PORT);
  const monitorStores = {
    env,
    metadataStore: new MetadataStore(env),
    secureStore: new SecureStore(env),
  };
  const syncMonitor =
    options.syncMonitor ||
    startAuthSyncMonitor({
      ...monitorStores,
      intervalMs: options.syncIntervalMs,
    });
  const ownsSyncMonitor = !options.syncMonitor;
  const server = http.createServer((request, response) => {
    handleRequest(request, response, { env, syncMonitor }).catch((error) => {
      sendError(response, error);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, host);
    });
  } catch (error) {
    if (ownsSyncMonitor) {
      await syncMonitor.stop();
    }
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;

  return {
    server,
    host,
    port: actualPort,
    url,
    syncMonitor,
    close: async () => {
      if (ownsSyncMonitor) {
        await syncMonitor.stop();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function runGuiServer(options = {}) {
  const stdout = options.stdout || process.stdout;
  const gui = await startGuiServer(options);
  stdout.write(`Codex Profile Switcher GUI: ${gui.url}\n`);
  stdout.write("Press Ctrl+C to stop the local GUI server.\n");

  await new Promise((resolve) => {
    const stop = async () => {
      await gui.close().catch(() => {});
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function handleRequest(request, response, context) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  if (requestUrl.pathname.startsWith("/api/")) {
    await handleApiRequest(request, response, requestUrl, context);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new AppError("METHOD_NOT_ALLOWED", "Method not allowed.", { exitCode: 2 });
  }
  await serveStatic(requestUrl.pathname, response, request.method === "HEAD");
}

async function handleApiRequest(request, response, requestUrl, context) {
  const route = routeParts(requestUrl.pathname);
  const method = request.method || "GET";
  const { env, syncMonitor } = context;
  const metadataStore = new MetadataStore(env);
  const secureStore = new SecureStore(env);
  const stores = { env, metadataStore, secureStore, syncMonitor };

  if (method === "GET" && route[0] === "state") {
    sendJson(response, 200, { ok: true, state: await collectGuiState(stores) });
    return;
  }

  if (method === "GET" && route[0] === "doctor") {
    const report = await collectDoctorReport(stores);
    sendJson(response, 200, { ok: true, report });
    return;
  }

  if (method === "GET" && route[0] === "usage") {
    const usage = await getActiveProfileUsage(stores);
    sendJson(response, 200, { ok: true, usage });
    return;
  }

  if (method === "POST" && route[0] === "sync-active") {
    await ensurePolicyAcknowledged({ env });
    const authSync = await syncMonitor.runNow();
    sendJson(response, 200, {
      ok: true,
      authSync,
      state: await collectGuiState(stores),
    });
    return;
  }

  if (method === "POST" && route[0] === "acknowledge") {
    const policy = await writePolicyAcknowledgement(env);
    sendJson(response, 200, { ok: true, policy, state: await collectGuiState(stores) });
    return;
  }

  if (method === "POST" && route[0] === "profiles" && route.length === 1) {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    const profileId = requiredString(body.profileId || body.profile_id, "profileId is required.");
    const profile = await metadataStore.upsertProfile(profileInput(profileId, body, "none"));
    sendJson(response, 200, {
      ok: true,
      profile,
      state: await collectGuiState(stores),
    });
    return;
  }

  if (method === "POST" && route[0] === "import-auth") {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    const profileId = requiredString(body.profileId || body.profile_id, "profileId is required.");
    const authJson = requiredString(body.authJson || body.auth_json, "authJson is required.");
    const imported = await importAuthJsonString(authJson, profileId, {
      metadataStore,
      secureStore,
      profile: profileInput(profileId, body, "imported_auth_json"),
    });

    let switchResult = null;
    if (body.useAfterImport || body.use_after_import) {
      switchResult = await switchProfileForGui(profileId, stores, body);
    }

    sendJson(response, 200, {
      ok: true,
      profile: imported,
      switchResult,
      state: await collectGuiState(stores),
    });
    return;
  }

  if (route[0] === "profiles" && route[1]) {
    await handleProfileRoute(method, route, request, response, stores);
    return;
  }

  if (method === "POST" && route[0] === "backup") {
    await ensurePolicyAcknowledged({ env });
    const backupPath = await backupAuthJson(env);
    sendJson(response, 200, { ok: true, backupPath, state: await collectGuiState(stores) });
    return;
  }

  if (method === "POST" && route[0] === "restore") {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    await assertSwitchCanProceed({
      env,
      allowRunning: Boolean(body.allowRunning || body.allow_running),
    });
    const backupPath = resolveUserPath(
      requiredString(body.backupPath || body.backup_path, "backupPath is required."),
      env,
    );
    const restoredPath = await restoreAuthJson(backupPath, env);
    sendJson(response, 200, { ok: true, restoredPath, state: await collectGuiState(stores) });
    return;
  }

  if (method === "POST" && route[0] === "export") {
    const body = await readJsonBody(request);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = resolveUserPath(
      body.output ||
        body.outputPath ||
        path.join(appHome(env), `codex-profile-metadata-${timestamp}.json`),
      env,
    );
    const outputPath = await metadataStore.exportMetadata(output);
    sendJson(response, 200, { ok: true, outputPath, state: await collectGuiState(stores) });
    return;
  }

  throw new AppError("NOT_FOUND", "API route not found.", { exitCode: 2 });
}

async function handleProfileRoute(method, route, request, response, stores) {
  const { env, metadataStore, secureStore } = stores;
  const profileId = decodeURIComponent(route[1]);

  if (method === "PATCH" && route.length === 2) {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    await metadataStore.getProfile(profileId);
    const profile = await metadataStore.upsertProfile(profileInput(profileId, body));
    sendJson(response, 200, { ok: true, profile, state: await collectGuiState(stores) });
    return;
  }

  if (method === "DELETE" && route.length === 2) {
    await ensurePolicyAcknowledged({ env });
    const profile = await metadataStore.getProfile(profileId);
    if (profile.auth_secret_ref) {
      await secureStore.delete(profileId);
    }
    await metadataStore.removeProfile(profileId);
    sendJson(response, 200, { ok: true, state: await collectGuiState(stores) });
    return;
  }

  if (method === "POST" && route[2] === "use") {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    const result = await switchProfileForGui(profileId, stores, body);
    sendJson(response, 200, { ok: true, result, state: await collectGuiState(stores) });
    return;
  }

  if (method === "POST" && route[2] === "rename") {
    const body = await readJsonBody(request);
    await ensurePolicyAcknowledged({ env });
    const newId = requiredString(body.newProfileId || body.new_profile_id, "newProfileId is required.");
    const existing = await metadataStore.getProfile(profileId);
    let copiedSecret = false;

    if (existing.auth_secret_ref) {
      const secret = await secureStore.get(profileId);
      await secureStore.set(newId, secret);
      copiedSecret = true;
    }

    try {
      const profile = await metadataStore.renameProfile(profileId, newId);
      if (existing.auth_secret_ref) {
        await secureStore.delete(profileId);
      }
      sendJson(response, 200, { ok: true, profile, state: await collectGuiState(stores) });
    } catch (error) {
      if (copiedSecret) {
        await secureStore.delete(newId).catch(() => {});
      }
      throw error;
    }
    return;
  }

  throw new AppError("NOT_FOUND", "Profile API route not found.", { exitCode: 2 });
}

async function switchProfileForGui(profileId, stores, body = {}) {
  const output = [];
  const result = await switchProfile(profileId, {
    env: stores.env,
    metadataStore: stores.metadataStore,
    secureStore: stores.secureStore,
    allowRunning: Boolean(body.allowRunning || body.allow_running),
    refreshSavedAuth: !(body.noRefresh || body.no_refresh),
    stdout: {
      write(text) {
        output.push(String(text));
      },
    },
  });
  await stores.syncMonitor?.runNow();

  return {
    profileId: result.profile.profile_id,
    authPath: result.authPath,
    backupPath: result.backup,
    output: output.join(""),
  };
}

async function collectGuiState({ env, metadataStore, secureStore, syncMonitor }) {
  const metadata = await metadataStore.read();
  const policy = await readPolicy(env);
  const [authStatus, processes, secureAvailable, secureBackend, doctor] = await Promise.all([
    getAuthFileStatus(env),
    detectCodexProcesses(env),
    secureStore.available(),
    secureStore.backendName(),
    collectDoctorReport({ env, metadataStore, secureStore }),
  ]);

  return {
    profileCount: metadata.profiles.length,
    activeProfileId: metadata.active_profile_id,
    profiles: metadata.profiles,
    policy,
    paths: {
      appHome: appHome(env),
      codexHome: codexHome(env),
      metadata: metadataPath(env),
      authJson: authJsonPath(env),
      configToml: configTomlPath(env),
    },
    authStatus,
    processes,
    secureStorage: {
      available: secureAvailable,
      backend: secureBackend,
    },
    authSync: syncMonitor?.getStatus() || null,
    doctor,
  };
}

function profileInput(profileId, body, authSource) {
  const input = {
    profile_id: profileId,
  };

  assignDefined(input, "display_name", body.displayName ?? body.display_name);
  assignDefined(input, "email", body.email);
  assignDefined(input, "workspace_name", body.workspaceName ?? body.workspace_name ?? body.workspace);
  assignDefined(input, "plan_type", body.planType ?? body.plan_type ?? body.plan);
  assignDefined(input, "auth_source", authSource || body.authSource || body.auth_source);
  assignDefined(input, "notes", body.notes);

  if (hasOwn(body, "tags") || hasOwn(body, "tag")) {
    input.tags = normalizeTags(body.tags ?? body.tag);
  }

  return input;
}

function assignDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("ARGUMENT_REQUIRED", message, { exitCode: 2 });
  }
  return value.trim();
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError("REQUEST_TOO_LARGE", "Request body is too large.", { exitCode: 2 });
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError("INVALID_JSON", `Invalid JSON request body: ${error.message}`, {
      cause: error,
      exitCode: 2,
    });
  }
}

async function serveStatic(requestPath, response, headOnly) {
  const fileName = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  if (!STATIC_FILES.has(fileName)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = path.join(PUBLIC_DIR, fileName);
  const contents = await fs.readFile(filePath);
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType(fileName),
  });
  response.end(headOnly ? undefined : contents);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response, error) {
  const appError = toAppError(error);
  const statusCode = appError.code === "NOT_FOUND" ? 404 : appError.exitCode === 2 ? 400 : 500;
  sendJson(response, statusCode, {
    ok: false,
    error: {
      code: appError.code,
      message: redactText(appError.message),
      details: appError.details || null,
    },
  });
}

function routeParts(requestPath) {
  return requestPath
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean);
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError("INVALID_PORT", "Port must be an integer from 0 to 65535.", {
      exitCode: 2,
    });
  }
  return port;
}

function resolveUserPath(input, env) {
  return path.resolve(expandHome(input, env));
}

function contentType(fileName) {
  if (fileName.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (fileName.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  return "text/html; charset=utf-8";
}
