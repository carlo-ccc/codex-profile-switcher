import { AppError } from "./errors.js";

const OPENAI_AUTH_CLAIMS = "https://api.openai.com/auth";

export function parseAuthJson(authContent, label = "auth.json") {
  try {
    const parsed = JSON.parse(authContent);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the top-level value must be an object");
    }
    return parsed;
  } catch (error) {
    throw new AppError("AUTH_JSON_INVALID", `${label} is invalid: ${error.message}`, {
      cause: error,
      exitCode: 2,
    });
  }
}

export function normalizeAuthJson(auth) {
  return `${JSON.stringify(auth, null, 2)}\n`;
}

export function getChatGptTokenContainer(auth) {
  if (isObject(auth?.tokens)) {
    return auth.tokens;
  }

  const hasTopLevelTokens = ["id_token", "access_token", "refresh_token"].some(
    (key) => typeof auth?.[key] === "string",
  );
  return hasTopLevelTokens ? auth : null;
}

export function getAuthIdentity(auth) {
  const tokens = getChatGptTokenContainer(auth);
  const idToken = stringValue(tokens?.id_token) || stringValue(auth?.id_token);
  const claims = parseJwtClaims(idToken);
  const openAiClaims = isObject(claims?.[OPENAI_AUTH_CLAIMS])
    ? claims[OPENAI_AUTH_CLAIMS]
    : null;

  const accountId =
    stringValue(tokens?.account_id) ||
    stringValue(auth?.account_id) ||
    stringValue(auth?.account?.id) ||
    stringValue(openAiClaims?.chatgpt_account_id);
  const subject = stringValue(claims?.sub);
  const email =
    stringValue(claims?.email) ||
    stringValue(auth?.account?.email) ||
    stringValue(auth?.email);

  if (accountId || subject || email) {
    return {
      mode: "chatgpt",
      stableId: accountId || subject || email.toLowerCase(),
      accountId,
      subject,
      email,
    };
  }

  const apiKey = stringValue(auth?.OPENAI_API_KEY) || stringValue(auth?.openai_api_key);
  if (apiKey) {
    return {
      mode: "api-key",
      stableId: null,
      accountId: null,
      subject: null,
      email: null,
    };
  }

  return {
    mode: tokens ? "chatgpt" : "unknown",
    stableId: null,
    accountId: null,
    subject: null,
    email: null,
  };
}

export function authBelongsToSameAccount(left, right) {
  const leftIdentity = getAuthIdentity(left);
  const rightIdentity = getAuthIdentity(right);

  if (leftIdentity.mode !== rightIdentity.mode) {
    return false;
  }
  if (leftIdentity.stableId && rightIdentity.stableId) {
    return leftIdentity.stableId === rightIdentity.stableId;
  }

  if (leftIdentity.mode === "api-key") {
    return (
      (stringValue(left?.OPENAI_API_KEY) || stringValue(left?.openai_api_key)) ===
      (stringValue(right?.OPENAI_API_KEY) || stringValue(right?.openai_api_key))
    );
  }

  const leftTokens = getChatGptTokenContainer(left);
  const rightTokens = getChatGptTokenContainer(right);
  const leftRefresh = stringValue(leftTokens?.refresh_token);
  const rightRefresh = stringValue(rightTokens?.refresh_token);
  return Boolean(leftRefresh && rightRefresh && leftRefresh === rightRefresh);
}

export function getAccessTokenExpiry(auth) {
  const tokens = getChatGptTokenContainer(auth);
  const accessToken = stringValue(tokens?.access_token);
  const expiry = parseJwtClaims(accessToken)?.exp;
  return Number.isFinite(Number(expiry)) ? Number(expiry) : null;
}

export function getAccessTokenExpiryIso(auth) {
  const expiry = getAccessTokenExpiry(auth);
  if (expiry === null) {
    return null;
  }
  const date = new Date(expiry * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseJwtClaims(token) {
  if (!token || typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
