import path from "node:path";
import { AppError, toAppError } from "./core/errors.js";
import { redactText } from "./core/redaction.js";
import { MetadataStore } from "./core/metadata-store.js";
import { SecureStore } from "./core/secure-store.js";
import { normalizeTags } from "./core/profile-id.js";
import { expandHome, appHome, authJsonPath, codexHome } from "./core/paths.js";
import {
  backupAuthJson,
  getAuthFileStatus,
  importAuthJson,
  importCurrentAuthJson,
  restoreAuthJson,
  switchProfile,
} from "./core/auth.js";
import {
  loginProfileWithCodex,
  refreshProfileAuthWithCodex,
} from "./core/codex-login.js";
import { collectDoctorReport, formatDoctorReport } from "./core/doctor.js";
import { detectCodexProcesses, assertSwitchCanProceed } from "./core/process-detect.js";
import {
  BOUNDARY_ACK_ZH,
  BOUNDARY_NOTICE_EN,
  BOUNDARY_NOTICE_ZH,
  ensurePolicyAcknowledged,
  writePolicyAcknowledgement,
} from "./core/policy.js";

const FORBIDDEN_COMMANDS = new Set([
  "auto-rotate",
  "continue-on-limit",
  "pool",
  "quota-pool",
  "total-quota",
  "warmup-all",
  "warm-up-all",
  "unlimited",
]);

export async function runCli(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  try {
    const command = argv[0] || "help";
    if (command === "--help" || command === "-h") {
      stdout.write(helpText());
      return 0;
    }
    if (command === "--version" || command === "-v") {
      stdout.write("0.1.0\n");
      return 0;
    }

    if (FORBIDDEN_COMMANDS.has(command)) {
      throw new AppError(
        "FORBIDDEN_COMMAND",
        `Command "${command}" is intentionally not provided. This tool does not merge quotas, auto-rotate accounts, warm up accounts, or continue tasks across accounts.`,
        { exitCode: 2 },
      );
    }

    const parsed = parseArgs(argv.slice(1));
    const metadataStore = new MetadataStore(env);
    const secureStore = new SecureStore(env);
    const context = {
      env,
      stdout,
      stderr,
      options: parsed.options,
      args: parsed.positionals,
      metadataStore,
      secureStore,
    };

    switch (command) {
      case "help":
        stdout.write(helpText());
        return 0;
      case "acknowledge":
        await writePolicyAcknowledgement(env);
        stdout.write(`${BOUNDARY_NOTICE_ZH}\n\n${BOUNDARY_ACK_ZH}\n`);
        return 0;
      case "list":
        await listCommand(context);
        return 0;
      case "current":
        await currentCommand(context);
        return 0;
      case "add":
        await addCommand(context);
        return 0;
      case "import-auth":
        await importAuthCommand(context);
        return 0;
      case "capture-current":
        await captureCurrentCommand(context);
        return 0;
      case "login":
        await loginCommand(context);
        return 0;
      case "refresh-auth":
      case "reauth":
        await refreshAuthCommand(context);
        return 0;
      case "use":
        await useCommand(context);
        return 0;
      case "remove":
        await removeCommand(context);
        return 0;
      case "rename":
        await renameCommand(context);
        return 0;
      case "status":
        await statusCommand(context);
        return 0;
      case "doctor":
        await doctorCommand(context);
        return 0;
      case "gui":
        await guiCommand(context);
        return 0;
      case "backup":
        await backupCommand(context);
        return 0;
      case "restore":
        await restoreCommand(context);
        return 0;
      case "export":
      case "export-metadata":
        await exportCommand(context);
        return 0;
      default:
        throw new AppError("UNKNOWN_COMMAND", `Unknown command "${command}". Run codex-profile help.`, {
          exitCode: 2,
        });
    }
  } catch (error) {
    const appError = toAppError(error);
    stderr.write(`${redactText(appError.message)}\n`);
    if (env.CODEX_PROFILE_DEBUG === "1" && appError.cause?.stack) {
      stderr.write(`${redactText(appError.cause.stack)}\n`);
    }
    return appError.exitCode || 1;
  }
}

async function listCommand({ metadataStore, stdout }) {
  const profiles = await metadataStore.listProfiles();
  if (profiles.length === 0) {
    stdout.write("No profiles yet. Import one with: codex-profile import-auth ./auth.json --name personal\n");
    return;
  }

  stdout.write(
    table(
      ["", "profile_id", "display_name", "email", "workspace", "last_used"],
      profiles.map((profile) => [
        profile.is_active ? "*" : "",
        profile.profile_id,
        profile.display_name,
        profile.email || "-",
        profile.workspace_name || "-",
        profile.last_used_at || "-",
      ]),
    ),
  );
}

async function currentCommand({ metadataStore, stdout }) {
  const profile = await metadataStore.currentProfile();
  if (!profile) {
    stdout.write("No active profile.\n");
    return;
  }

  stdout.write(
    [
      `Active profile: ${profile.profile_id}`,
      `Display name: ${profile.display_name}`,
      `Email: ${profile.email || "-"}`,
      `Workspace: ${profile.workspace_name || "-"}`,
      `Last used: ${profile.last_used_at || "-"}`,
      "",
    ].join("\n"),
  );
}

async function addCommand(context) {
  const { args, options, metadataStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = args[0] || options.name;
  requireArgument(profileId, "Profile id is required. Example: codex-profile add personal");

  const profile = await metadataStore.upsertProfile({
    profile_id: profileId,
    display_name: options["display-name"] || options.display || profileId,
    email: options.email || "",
    workspace_name: options.workspace || "",
    plan_type: options.plan || "",
    auth_source: "none",
    notes: options.notes || "",
    tags: normalizeTags(options.tag || options.tags),
  });

  stdout.write(`Added profile "${profile.profile_id}". Import auth before using it.\n`);
}

async function importAuthCommand(context) {
  const { args, options, metadataStore, secureStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const filePath = args[0];
  const profileId = options.name || args[1];
  requireArgument(filePath, "Path to auth.json is required.");
  requireArgument(profileId, "Profile name is required. Example: --name personal");

  const imported = await importAuthJson(resolveUserPath(filePath, env), profileId, {
    metadataStore,
    secureStore,
    profile: {
      display_name: options["display-name"] || options.display || profileId,
      email: options.email,
      workspace_name: options.workspace,
      plan_type: options.plan,
      notes: options.notes,
      tags: normalizeTags(options.tag || options.tags),
    },
  });

  stdout.write(`Imported auth.json for "${imported.profile_id}" into secure storage.\n`);
  stdout.write("Metadata only was written to profiles.json; secrets were not written there.\n");

  if (options.use) {
    const result = await switchProfile(profileId, switchOptions(context));
    stdout.write(switchSuccessText(result.profile.profile_id, result.authPath));
  } else {
    stdout.write(`Run "codex-profile use ${imported.profile_id}" to switch manually.\n`);
  }
}

async function captureCurrentCommand(context) {
  const { args, options, metadataStore, secureStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = options.name || args[0];
  requireArgument(
    profileId,
    "Profile name is required. Example: codex-profile capture-current personal",
  );

  const captured = await importCurrentAuthJson(profileId, {
    env,
    metadataStore,
    secureStore,
    profile: {
      display_name: options["display-name"] || options.display || profileId,
      email: options.email,
      workspace_name: options.workspace,
      plan_type: options.plan,
      notes: options.notes,
      tags: normalizeTags(options.tag || options.tags),
    },
  });

  stdout.write(`Captured current Codex auth.json for "${captured.profile_id}" into secure storage.\n`);
  stdout.write("Do not run codex logout for a captured account unless you intend to invalidate that login session.\n");

  if (options.use) {
    await metadataStore.setActiveProfile(profileId);
    stdout.write(`Marked "${captured.profile_id}" as the active profile metadata.\n`);
  } else {
    stdout.write(`Run "codex-profile use ${captured.profile_id}" to switch manually later.\n`);
  }
}

async function loginCommand(context) {
  const { args, options, metadataStore, secureStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = options.name || args[0];
  requireArgument(profileId, "Profile name is required. Example: codex-profile login personal");

  stdout.write(`Starting native Codex login for "${profileId}" in an isolated temporary session.\n`);
  const profile = await loginProfileWithCodex(profileId, {
    env,
    metadataStore,
    secureStore,
    deviceAuth: Boolean(options["device-auth"]),
    profile: profileMetadataFromOptions(options, profileId, { includeDisplayName: true }),
  });
  stdout.write(`Saved the Codex login for "${profile.profile_id}" into secure storage.\n`);

  if (options.use) {
    const result = await switchProfile(profileId, switchOptions(context));
    stdout.write(switchSuccessText(result.profile.profile_id, result.authPath));
  } else {
    stdout.write(`Run "codex-profile use ${profile.profile_id}" to switch manually.\n`);
  }
}

async function refreshAuthCommand(context) {
  const { args, options, metadataStore, secureStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = options.name || args[0];
  requireArgument(profileId, "Profile name is required. Example: codex-profile refresh-auth personal");

  stdout.write(`Refreshing "${profileId}" through native Codex login in an isolated temporary session.\n`);
  const profile = await refreshProfileAuthWithCodex(profileId, {
    env,
    metadataStore,
    secureStore,
    deviceAuth: Boolean(options["device-auth"]),
    profile: profileMetadataFromOptions(options, profileId),
  });
  stdout.write(`Updated the saved login for "${profile.profile_id}" in secure storage.\n`);

  if (options.use) {
    const result = await switchProfile(profileId, switchOptions(context));
    stdout.write(switchSuccessText(result.profile.profile_id, result.authPath));
  } else {
    stdout.write("The current Codex auth.json was not changed.\n");
  }
}

async function useCommand(context) {
  const { args, stdout, env, options } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = args[0];
  requireArgument(profileId, "Profile id is required. Example: codex-profile use personal");

  const result = await switchProfile(profileId, switchOptions(context));
  stdout.write(switchSuccessText(result.profile.profile_id, result.authPath));
}

async function removeCommand(context) {
  const { args, options, metadataStore, secureStore, stdout, env } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const profileId = args[0];
  requireArgument(profileId, "Profile id is required. Example: codex-profile remove personal");
  if (!options.yes) {
    throw new AppError(
      "CONFIRMATION_REQUIRED",
      "Removing a profile deletes its secure-store auth entry. Re-run with --yes to confirm.",
      { exitCode: 2 },
    );
  }

  await secureStore.delete(profileId);
  await metadataStore.removeProfile(profileId);
  stdout.write(`Removed profile "${profileId}".\n`);
}

async function renameCommand(context) {
  const { args, metadataStore, secureStore, stdout, env, options } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const oldId = args[0];
  const newId = args[1];
  requireArgument(oldId, "Old profile id is required.");
  requireArgument(newId, "New profile id is required.");

  const existing = await metadataStore.getProfile(oldId);
  let copiedSecret = false;
  if (existing.auth_secret_ref) {
    const secret = await secureStore.get(oldId);
    await secureStore.set(newId, secret);
    copiedSecret = true;
  }

  let renamed;
  try {
    renamed = await metadataStore.renameProfile(oldId, newId);
  } catch (error) {
    if (copiedSecret) {
      await secureStore.delete(newId).catch(() => {});
    }
    throw error;
  }
  if (existing.auth_secret_ref) {
    await secureStore.delete(oldId);
  }

  stdout.write(`Renamed profile "${oldId}" to "${renamed.profile_id}".\n`);
}

async function statusCommand({ metadataStore, stdout, env }) {
  const active = await metadataStore.currentProfile();
  const authStatus = await getAuthFileStatus(env);
  const processes = await detectCodexProcesses(env);

  stdout.write(
    [
      "Codex Profile Switcher Status",
      "",
      `Active profile: ${active?.profile_id || "none"}`,
      `Codex directory: ${codexHome(env)}`,
      `auth.json: ${authStatus.exists ? `found (${authStatus.permissions})` : "missing"}`,
      `Process check: ${
        processes.length === 0
          ? "no Codex-related processes detected"
          : processes.map((processInfo) => `${processInfo.name}(${processInfo.pid})`).join(", ")
      }`,
      "",
      "Usage: view accurate usage on the official OpenAI/Codex usage page for each account.",
      "This tool never totals usage across profiles.",
      "",
    ].join("\n"),
  );
}

async function doctorCommand({ metadataStore, secureStore, stdout, env }) {
  const report = await collectDoctorReport({ metadataStore, secureStore, env });
  stdout.write(formatDoctorReport(report));
}

async function guiCommand({ env, stdout, options }) {
  const { runGuiServer } = await import("./gui/server.js");
  await runGuiServer({
    env,
    stdout,
    host: options.host || "127.0.0.1",
    port: options.port || 8787,
  });
}

async function backupCommand({ env, stdout, options }) {
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });

  const backupPath = await backupAuthJson(env);
  if (!backupPath) {
    stdout.write(`No auth.json found at ${authJsonPath(env)}; nothing to back up.\n`);
    return;
  }
  stdout.write(`Backup created: ${backupPath}\n`);
}

async function restoreCommand(context) {
  const { args, env, stdout, options } = context;
  await ensurePolicyAcknowledged({
    env,
    acceptBoundary: Boolean(options["accept-boundary"]),
  });
  await assertSwitchCanProceed({
    env,
    allowRunning: Boolean(options["allow-running"]),
    forceClose: Boolean(options["force-close"]),
    confirmForceClose: Boolean(options["confirm-force-close"]),
  });

  const backupPath = args[0];
  requireArgument(backupPath, "Backup path is required.");
  const restoredPath = await restoreAuthJson(resolveUserPath(backupPath, env), env);
  stdout.write(`Restored auth.json to ${restoredPath}.\n`);
  stdout.write("Open a new terminal window or restart Codex CLI before continuing.\n");
}

async function exportCommand({ env, options, metadataStore, stdout }) {
  if (options["include-secrets"]) {
    throw new AppError(
      "SENSITIVE_EXPORT_NOT_IMPLEMENTED",
      "Exporting secrets is not implemented in the MVP. Metadata export is available without secrets.",
      { exitCode: 2 },
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = resolveUserPath(
    options.output ||
      path.join(appHome(env), `codex-profile-metadata-${timestamp}.json`),
    env,
  );
  await metadataStore.exportMetadata(output);
  stdout.write(`Exported metadata only: ${output}\n`);
  stdout.write("No tokens, cookies, API keys, or auth.json contents were exported.\n");
}

function switchOptions(context) {
  const { env, stdout, metadataStore, secureStore, options } = context;
  return {
    env,
    stdout,
    metadataStore,
    secureStore,
    allowRunning: Boolean(options["allow-running"]),
    forceClose: Boolean(options["force-close"]),
    confirmForceClose: Boolean(options["confirm-force-close"]),
  };
}

function profileMetadataFromOptions(options, profileId, { includeDisplayName = false } = {}) {
  const profile = {};
  const displayName = options["display-name"] || options.display;
  if (displayName) {
    profile.display_name = displayName;
  } else if (includeDisplayName) {
    profile.display_name = profileId;
  }
  if (options.email !== undefined) {
    profile.email = options.email;
  }
  if (options.workspace !== undefined) {
    profile.workspace_name = options.workspace;
  }
  if (options.plan !== undefined) {
    profile.plan_type = options.plan;
  }
  if (options.notes !== undefined) {
    profile.notes = options.notes;
  }
  if (options.tag !== undefined || options.tags !== undefined) {
    profile.tags = normalizeTags(options.tag || options.tags);
  }
  return profile;
}

function switchSuccessText(profileId, authPath) {
  return [
    `Switched to profile "${profileId}".`,
    `Updated: ${authPath}`,
    "Open a new terminal window or restart Codex CLI before continuing.",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.trim();
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      addOption(options, key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      addOption(options, key, next);
      index += 1;
    } else {
      addOption(options, key, true);
    }
  }

  return { options, positionals };
}

function addOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }

  if (!Array.isArray(options[key])) {
    options[key] = [options[key]];
  }
  options[key].push(value);
}

function resolveUserPath(input, env) {
  return path.resolve(expandHome(input, env));
}

function requireArgument(value, message) {
  if (!value) {
    throw new AppError("ARGUMENT_REQUIRED", message, { exitCode: 2 });
  }
}

function table(headers, rows) {
  const allRows = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? "")));
  const widths = headers.map((_, columnIndex) =>
    Math.max(...allRows.map((row) => row[columnIndex].length)),
  );
  const lines = allRows.map((row, rowIndex) => {
    const line = row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex]))
      .join("  ")
      .trimEnd();
    if (rowIndex === 0) {
      return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
    }
    return line;
  });
  return `${lines.join("\n")}\n`;
}

function helpText() {
  return `Codex Profile Switcher

${BOUNDARY_NOTICE_EN}
${BOUNDARY_NOTICE_ZH}

Commands:
  codex-profile acknowledge
  codex-profile list
  codex-profile current
  codex-profile add <profile_id> [--email user@example.com]
  codex-profile import-auth ./auth.json --name personal [--use]
  codex-profile capture-current personal [--use]
  codex-profile login personal [--device-auth] [--use]
  codex-profile refresh-auth personal [--device-auth] [--use]
  codex-profile use personal
  codex-profile remove personal --yes
  codex-profile rename old-id new-id
  codex-profile status
  codex-profile doctor
  codex-profile gui [--port 8787]
  codex-profile backup
  codex-profile restore <backup-path>
  codex-profile export [--output metadata.json]

Safety:
  This is a manual Codex profile switcher.
  It does not merge quotas.
  It does not auto-rotate accounts.
  It does not continue tasks across accounts.
  It does not help bypass rate limits or usage limits.

Mutating commands require "codex-profile acknowledge" once, or --accept-boundary.
`;
}
