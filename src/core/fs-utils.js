import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath, mode = 0o700) {
  await fs.mkdir(dirPath, { recursive: true, mode });
  if (process.platform !== "win32") {
    await fs.chmod(dirPath, mode);
  }
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export async function writeFileAtomic(filePath, contents, mode = 0o600) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode });

  if (process.env.CODEX_PROFILE_SIMULATE_WRITE_FAILURE === "1") {
    await fs.rm(tempPath, { force: true });
    throw new Error("Simulated write failure");
  }

  await fs.rename(tempPath, filePath);
  if (process.platform !== "win32") {
    await fs.chmod(filePath, mode);
  }
}

export async function writeJsonAtomic(filePath, value, mode = 0o600) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function getUnixMode(filePath) {
  if (process.platform === "win32") {
    return null;
  }

  const stat = await fs.stat(filePath);
  return stat.mode & 0o777;
}

export function formatMode(mode) {
  if (mode == null) {
    return "managed by Windows ACLs";
  }
  return `0${mode.toString(8)}`;
}
