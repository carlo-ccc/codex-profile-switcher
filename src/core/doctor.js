import os from "node:os";
import { authJsonPath, codexHome, configTomlPath } from "./paths.js";
import { commandExists } from "./command.js";
import { pathExists } from "./fs-utils.js";
import { getAuthFileStatus } from "./auth.js";
import { detectCodexProcesses } from "./process-detect.js";
import { getCodexCredentialStore } from "./codex-config.js";
import { getAuthDaemonStatus } from "./auth-daemon.js";

export async function collectDoctorReport(options) {
  const { env = process.env, metadataStore, secureStore } = options;
  const metadata = await metadataStore.read();
  const codexDir = codexHome(env);
  const authStatus = await getAuthFileStatus(env);
  const processes = await detectCodexProcesses(env);
  const secureAvailable = await secureStore.available();
  const credentialStore = await getCodexCredentialStore(env);
  const daemon = await getAuthDaemonStatus(env);

  return {
    system: systemName(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    codexCliInstalled: await commandExists("codex"),
    codexDirectory: codexDir,
    codexDirectoryExists: await pathExists(codexDir),
    authJson: authStatus,
    configToml: {
      path: configTomlPath(env),
      exists: await pathExists(configTomlPath(env)),
    },
    credentialStore,
    secureStorage: {
      backend: await secureStore.backendName(),
      available: secureAvailable,
    },
    activeProfileId: metadata.active_profile_id,
    profileCount: metadata.profiles.length,
    metadataComplete: metadata.profiles.every(
      (profile) =>
        profile.profile_id &&
        profile.display_name &&
        profile.created_at &&
        profile.updated_at &&
        profile.auth_source,
    ),
    processes,
    daemon,
    wsl: detectWsl(),
  };
}

export function formatDoctorReport(report) {
  const lines = [
    "Codex Profile Switcher Doctor",
    "",
    `System: ${report.system} (${report.arch})`,
    `Node: ${report.node}`,
    `Codex CLI: ${report.codexCliInstalled ? "found" : "not found"}`,
    `Codex directory: ${report.codexDirectory} (${
      report.codexDirectoryExists ? "found" : "missing"
    })`,
    `auth.json: ${report.authJson.exists ? "found" : "missing"}`,
    `config.toml: ${report.configToml.exists ? "found" : "missing"}`,
    `Codex credential store: ${report.credentialStore.display} (${report.credentialStore.fileCompatible ? "auth.json compatible" : "incompatible with file switching"})`,
    `Secure storage: ${report.secureStorage.available ? "available" : "unavailable"} (${report.secureStorage.backend})`,
    `Auth sync daemon: ${report.daemon.running ? report.daemon.healthy ? `running (${report.daemon.pid})` : `unhealthy (${report.daemon.pid})` : "stopped"}`,
    `Active profile: ${report.activeProfileId || "none"}`,
    `Profiles: ${report.profileCount}`,
    `Profile metadata: ${report.metadataComplete ? "OK" : "incomplete"}`,
    `Codex process: ${
      report.processes.length === 0
        ? "not running"
        : report.processes.map((processInfo) => processInfo.name).join(", ")
    }`,
    `File permissions: ${
      report.authJson.exists
        ? report.authJson.secure
          ? `OK (${report.authJson.permissions})`
          : `needs attention (${report.authJson.permissions})`
        : "n/a"
    }`,
    `WSL: ${report.wsl.detected ? report.wsl.description : "not detected"}`,
  ];

  return `${lines.join("\n")}\n`;
}

function systemName() {
  if (process.platform === "darwin") {
    return "macOS";
  }
  if (process.platform === "win32") {
    return "Windows";
  }
  if (process.platform === "linux") {
    return "Linux";
  }
  return `${os.type()} ${os.release()}`;
}

function detectWsl() {
  const release = os.release().toLowerCase();
  if (process.env.WSL_DISTRO_NAME || release.includes("microsoft")) {
    return {
      detected: true,
      description: process.env.WSL_DISTRO_NAME || "WSL-like kernel",
    };
  }

  return {
    detected: false,
    description: "",
  };
}
