import fs from "node:fs/promises";
import { authJsonPath } from "./paths.js";
import { pathExists } from "./fs-utils.js";
import {
  authBelongsToSameAccount,
  getAccessTokenExpiryIso,
  normalizeAuthJson,
  parseAuthJson,
} from "./auth-data.js";
import { redactText } from "./redaction.js";
import { getCodexCredentialStore } from "./codex-config.js";

export const DEFAULT_AUTH_SYNC_INTERVAL_MS = 600_000;

export async function syncActiveProfileAuth(options) {
  const { env = process.env, metadataStore, secureStore } = options;
  const checkedAt = new Date().toISOString();
  const profile = await metadataStore.currentProfile();
  if (!profile) {
    return syncStatus("inactive", checkedAt, null, "No active profile is selected.");
  }

  const profileId = profile.profile_id;
  const credentialStore = await getCodexCredentialStore(env);
  if (!credentialStore.fileCompatible) {
    return syncStatus(
      "incompatible",
      checkedAt,
      profileId,
      "Codex is configured for keyring/auto credentials; auth.json synchronization is disabled until file mode is selected.",
    );
  }
  const authPath = authJsonPath(env);
  if (!(await pathExists(authPath))) {
    return syncStatus("missing", checkedAt, profileId, `No auth.json exists at ${authPath}.`);
  }
  if (!profile.auth_secret_ref) {
    return syncStatus(
      "unavailable",
      checkedAt,
      profileId,
      `Profile "${profileId}" has no saved login to synchronize.`,
    );
  }

  const [currentContent, savedContent] = await Promise.all([
    fs.readFile(authPath, "utf8"),
    secureStore.get(profileId),
  ]);
  const currentAuth = parseAuthJson(currentContent, "Current Codex auth.json");
  const savedAuth = parseAuthJson(savedContent, `Saved auth for profile "${profileId}"`);
  const normalizedCurrent = normalizeAuthJson(currentAuth);
  const normalizedSaved = normalizeAuthJson(savedAuth);
  const expiresAt = getAccessTokenExpiryIso(currentAuth);

  if (normalizedCurrent === normalizedSaved) {
    return {
      ...syncStatus("current", checkedAt, profileId, "Saved login is already current."),
      expiresAt,
    };
  }
  if (!authBelongsToSameAccount(currentAuth, savedAuth)) {
    return {
      ...syncStatus(
        "identity-mismatch",
        checkedAt,
        profileId,
        "Current auth.json belongs to a different or unverifiable account; no credentials were overwritten.",
      ),
      expiresAt,
    };
  }

  await secureStore.set(profileId, normalizedCurrent);
  const syncedAt = new Date().toISOString();
  await metadataStore.upsertProfile({
    profile_id: profileId,
    auth_synced_at: syncedAt,
    auth_expires_at: expiresAt,
    auth_health: "fresh",
  });
  return {
    ...syncStatus("synced", checkedAt, profileId, "Updated credentials were saved securely."),
    syncedAt,
    expiresAt,
  };
}

export function startAuthSyncMonitor(options) {
  const env = options.env || process.env;
  const intervalMs = syncIntervalMs(options.intervalMs ?? env.CODEX_PROFILE_AUTH_SYNC_INTERVAL_MS);
  let stopped = false;
  let inFlight = null;
  let status = syncStatus("starting", new Date().toISOString(), null, "Starting auth sync monitor.");

  const runNow = async () => {
    if (stopped) {
      return status;
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = syncActiveProfileAuth(options)
      .then((nextStatus) => {
        status = nextStatus;
        return status;
      })
      .catch((error) => {
        status = syncStatus(
          "error",
          new Date().toISOString(),
          status.profileId,
          redactText(error?.message || String(error)),
        );
        return status;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const ready = runNow();
  const timer = setInterval(runNow, intervalMs);

  return {
    ready,
    intervalMs,
    runNow,
    getStatus() {
      return { ...status, intervalMs };
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

function syncStatus(status, checkedAt, profileId, message) {
  return {
    status,
    checkedAt,
    profileId,
    message,
    syncedAt: null,
    expiresAt: null,
  };
}

function syncIntervalMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1_000) {
    return DEFAULT_AUTH_SYNC_INTERVAL_MS;
  }
  return Math.min(number, 60 * 60 * 1000);
}
