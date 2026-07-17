import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.js";
import {
  authBelongsToSameAccount,
  getAccessTokenExpiry,
  getAccessTokenExpiryIso,
  getChatGptTokenContainer,
  normalizeAuthJson,
  parseAuthJson,
  stringValue,
} from "./auth-data.js";

const DEFAULT_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_EXPIRY_SKEW_SECONDS = 5 * 60;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function ensureProfileAuthFresh(profileId, options) {
  const {
    env = process.env,
    metadataStore,
    secureStore,
    fetchImpl = globalThis.fetch,
    force = false,
  } = options;

  const profile = await metadataStore.getProfile(profileId);
  const authContent = await secureStore.get(profileId);
  const auth = parseAuthJson(authContent, `Saved auth for profile "${profileId}"`);
  const tokens = getChatGptTokenContainer(auth);
  const refreshToken = stringValue(tokens?.refresh_token);
  const expiry = getAccessTokenExpiry(auth);
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = refreshSkewSeconds(env);

  if (!tokens || !refreshToken) {
    return authResult(profile, auth, "not-refreshable", false);
  }
  if (!force && (expiry === null || expiry > now + skewSeconds)) {
    return authResult(profile, auth, "fresh", false);
  }
  if (typeof fetchImpl !== "function") {
    throw new AppError(
      "OAUTH_REFRESH_UNAVAILABLE",
      `Profile "${profileId}" needs token refresh, but this Node.js runtime does not provide fetch.`,
      { exitCode: 2 },
    );
  }

  const refreshed = await requestTokenRefresh(refreshToken, {
    env,
    fetchImpl,
  });
  const updatedAuth = applyRefreshResponse(auth, refreshed);
  if (!authBelongsToSameAccount(auth, updatedAuth)) {
    throw new AppError(
      "OAUTH_REFRESH_IDENTITY_MISMATCH",
      `Refreshed credentials did not match profile "${profileId}". The saved login was left unchanged.`,
      { exitCode: 2 },
    );
  }

  const updatedContent = normalizeAuthJson(updatedAuth);
  await secureStore.set(profileId, updatedContent);
  const refreshedAt = new Date().toISOString();
  await metadataStore.upsertProfile({
    profile_id: profileId,
    auth_refreshed_at: refreshedAt,
    auth_expires_at: getAccessTokenExpiryIso(updatedAuth),
    auth_health: "fresh",
  });

  return {
    ...authResult(profile, updatedAuth, "refreshed", true),
    authContent: updatedContent,
    refreshedAt,
  };
}

async function requestTokenRefresh(refreshToken, { env, fetchImpl }) {
  const endpoint = env.CODEX_PROFILE_OAUTH_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT;
  const clientId = env.CODEX_PROFILE_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
  const timeoutMs = positiveNumber(env.CODEX_PROFILE_OAUTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new AppError(
          "OAUTH_REFRESH_REJECTED",
          response.status === 400 || response.status === 401
            ? "The saved refresh token is no longer valid. Run codex-profile refresh-auth <profile> to sign in again."
            : `The OAuth token service returned HTTP ${response.status}.`,
          { exitCode: 2, details: { status: response.status } },
        );
        if (response.status < 500 && response.status !== 429) {
          throw error;
        }
        lastError = error;
      } else {
        const payload = await response.json();
        if (!stringValue(payload?.access_token)) {
          throw new AppError(
            "OAUTH_REFRESH_INVALID_RESPONSE",
            "The OAuth token service returned a response without an access token.",
            { exitCode: 2 },
          );
        }
        return payload;
      }
    } catch (error) {
      if (error instanceof AppError && error.code !== "OAUTH_REFRESH_REJECTED") {
        throw error;
      }
      if (error instanceof AppError && error.details?.status < 500 && error.details?.status !== 429) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < 3) {
      await delay(attempt * 200);
    }
  }

  if (lastError?.name === "AbortError") {
    throw new AppError("OAUTH_REFRESH_TIMEOUT", "The OAuth token refresh request timed out.", {
      cause: lastError,
      exitCode: 2,
    });
  }
  if (lastError instanceof AppError) {
    throw lastError;
  }
  throw new AppError(
    "OAUTH_REFRESH_FAILED",
    "Unable to refresh the saved login. Check the network connection and try again.",
    { cause: lastError, exitCode: 2 },
  );
}

function applyRefreshResponse(auth, payload) {
  const updated = structuredClone(auth);
  const tokens = getChatGptTokenContainer(updated);
  tokens.access_token = stringValue(payload.access_token);
  if (stringValue(payload.id_token)) {
    tokens.id_token = stringValue(payload.id_token);
  }
  if (stringValue(payload.refresh_token)) {
    tokens.refresh_token = stringValue(payload.refresh_token);
  }
  updated.last_refresh = new Date().toISOString();
  return updated;
}

function authResult(profile, auth, status, refreshed) {
  return {
    profile,
    profileId: profile.profile_id,
    status,
    refreshed,
    auth,
    authContent: normalizeAuthJson(auth),
    expiresAt: getAccessTokenExpiryIso(auth),
  };
}

function refreshSkewSeconds(env) {
  return positiveNumber(
    env.CODEX_PROFILE_OAUTH_REFRESH_SKEW_SECONDS,
    DEFAULT_EXPIRY_SKEW_SECONDS,
    24 * 60 * 60,
  );
}

function positiveNumber(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(number, maximum);
}
