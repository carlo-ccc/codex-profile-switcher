import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function execFileText(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return stdout;
}

export async function spawnWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const error = new Error(stderr.trim() || `${command} exited with ${code}`);
      error.code = code;
      reject(error);
    });

    child.stdin.end(input);
  });
}

export async function spawnInteractive(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(
        signal
          ? `${command} was stopped by ${signal}`
          : `${command} exited with ${code ?? "an unknown status"}`,
      );
      error.code = code;
      reject(error);
    });
  });
}

export async function commandExists(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const args = [command];
  try {
    await execFileText(probe, args);
    return true;
  } catch {
    return false;
  }
}
