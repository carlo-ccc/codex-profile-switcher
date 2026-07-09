import { execFileText } from "./command.js";
import { AppError } from "./errors.js";

const DIRECT_PROCESS_NAMES = new Set([
  "codex",
  "codex-cli",
  "app-server",
  "antigravity",
  "antigravity helper",
]);

export async function detectCodexProcesses(env = process.env) {
  if (env.CODEX_PROFILE_SKIP_PROCESS_CHECK === "1") {
    return [];
  }

  if (env.CODEX_PROFILE_PROCESS_FIXTURE) {
    return JSON.parse(env.CODEX_PROFILE_PROCESS_FIXTURE);
  }

  if (process.platform === "win32") {
    return detectWindowsProcesses();
  }

  return detectUnixProcesses();
}

export async function assertSwitchCanProceed(options = {}) {
  const {
    env = process.env,
    allowRunning = false,
    forceClose = false,
    confirmForceClose = false,
  } = options;

  const processes = await detectCodexProcesses(env);
  if (processes.length === 0) {
    return processes;
  }

  if (forceClose && !confirmForceClose) {
    throw new AppError(
      "FORCE_CLOSE_CONFIRMATION_REQUIRED",
      "Codex-related processes are running. Force close requires explicit confirmation with --confirm-force-close.",
      { exitCode: 2, details: { processes } },
    );
  }

  if (forceClose && confirmForceClose) {
    throw new AppError(
      "FORCE_CLOSE_NOT_IMPLEMENTED",
      "Force close is intentionally not implemented in the MVP. Please close Codex sessions manually, then retry.",
      { exitCode: 2, details: { processes } },
    );
  }

  if (!allowRunning) {
    const summary = processes
      .map((processInfo) => `${processInfo.name || "unknown"}(${processInfo.pid || "?"})`)
      .join(", ");
    throw new AppError(
      "CODEX_PROCESS_RUNNING",
      `Codex-related process is running: ${summary}. Close it before switching, or pass --allow-running only if you understand the active-session risk.`,
      { exitCode: 2, details: { processes } },
    );
  }

  return processes;
}

async function detectUnixProcesses() {
  let output;
  try {
    output = await execFileText("ps", ["-axo", "pid=,comm=,args="]);
  } catch {
    return [];
  }

  const currentPid = process.pid;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseUnixPsLine)
    .filter(Boolean)
    .filter((candidate) => candidate.pid !== currentPid)
    .filter(isCodexRelatedProcess);
}

function parseUnixPsLine(line) {
  const match = line.match(/^(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    pid: Number(match[1]),
    name: basename(match[2]),
    command: match[3] || match[2],
  };
}

async function detectWindowsProcesses() {
  let output;
  try {
    output = await execFileText("tasklist", ["/FO", "CSV", "/NH"]);
  } catch {
    return [];
  }

  return output
    .split("\n")
    .map(parseTasklistCsvLine)
    .filter(Boolean)
    .filter(isCodexRelatedProcess);
}

function parseTasklistCsvLine(line) {
  const columns = parseCsvLine(line);
  if (columns.length < 2) {
    return null;
  }

  return {
    pid: Number(columns[1]),
    name: basename(columns[0].replace(/\.exe$/i, "")),
    command: columns[0],
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function isCodexRelatedProcess(processInfo) {
  const name = String(processInfo.name || "").toLowerCase();
  const command = String(processInfo.command || "").toLowerCase();

  if (DIRECT_PROCESS_NAMES.has(name)) {
    return true;
  }

  if (name === "code" || name === "electron") {
    return command.includes("codex") && command.includes("extension");
  }

  return command.includes("antigravity") && command.includes("codex");
}

function basename(value) {
  return String(value).split(/[\\/]/).pop().toLowerCase();
}
