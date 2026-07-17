import fs from "node:fs/promises";
import { configTomlPath } from "./paths.js";
import { pathExists } from "./fs-utils.js";
import { AppError } from "./errors.js";

export async function getCodexCredentialStore(env = process.env) {
  const filePath = configTomlPath(env);
  if (!(await pathExists(filePath))) {
    return credentialStoreResult(filePath, null);
  }

  const raw = await fs.readFile(filePath, "utf8");
  const match = raw.match(
    /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']\s*(?:#.*)?$/im,
  );
  return credentialStoreResult(filePath, match?.[1]?.toLowerCase() || null);
}

export async function assertFileCredentialStoreCompatible(env = process.env) {
  const result = await getCodexCredentialStore(env);
  if (result.fileCompatible) {
    return result;
  }
  throw new AppError(
    "CODEX_CREDENTIAL_STORE_INCOMPATIBLE",
    `Codex is configured with cli_auth_credentials_store = "${result.configured}" in ${result.path}. This switcher manages auth.json files; change the Codex setting to "file" before switching profiles.`,
    { exitCode: 2, details: result },
  );
}

function credentialStoreResult(path, configured) {
  return {
    path,
    configured,
    display: configured || "Codex default",
    fileCompatible: configured !== "keyring" && configured !== "auto",
    warning:
      configured === "keyring" || configured === "auto"
        ? "This project requires explicit file credential storage because keyring/auto modes may ignore auth.json."
        : "",
  };
}
