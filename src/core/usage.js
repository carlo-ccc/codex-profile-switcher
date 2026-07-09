import { redactText } from "./redaction.js";
import { spawnWithInput } from "./command.js";

const DEFAULT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const CODEX_USER_AGENT = "codex-cli/1.0.0";

export async function getActiveProfileUsage(options) {
  const {
    env = process.env,
    metadataStore,
    secureStore,
    fetchImpl = globalThis.fetch,
  } = options;

  const fetchedAt = new Date().toISOString();
  const profile = await metadataStore.currentProfile();
  if (!profile) {
    return usageStatus("inactive", {
      fetchedAt,
      message: "当前没有 active profile",
    });
  }

  const profileInfo = {
    profileId: profile.profile_id,
    profileDisplayName: profile.display_name || profile.profile_id,
  };

  if (!profile.auth_secret_ref) {
    return usageStatus("unavailable", {
      ...profileInfo,
      fetchedAt,
      message: "当前 profile 未导入 auth.json",
    });
  }

  if (typeof fetchImpl !== "function") {
    return usageStatus("error", {
      ...profileInfo,
      fetchedAt,
      message: "当前 Node.js 运行环境不支持 fetch",
    });
  }

  try {
    const authContent = await secureStore.get(profile.profile_id);
    const parsedAuth = JSON.parse(authContent);
    const chatGptAuth = extractChatGptAuth(parsedAuth);

    if (!chatGptAuth.accessToken) {
      return usageStatus("unavailable", {
        ...profileInfo,
        fetchedAt,
        message: "仅 ChatGPT OAuth auth.json 支持额度读取",
      });
    }

    const payload = await fetchUsagePayload({
      accessToken: chatGptAuth.accessToken,
      accountId: chatGptAuth.accountId,
      endpoint: usageEndpoint(env),
      env,
      fetchImpl,
      timeoutMs: usageTimeoutMs(env),
    });

    return normalizeUsagePayload(payload, {
      ...profileInfo,
      fetchedAt,
    });
  } catch (error) {
    return usageStatus("error", {
      ...profileInfo,
      fetchedAt,
      message: usageErrorMessage(error),
    });
  }
}

function usageStatus(status, fields = {}) {
  return {
    status,
    profileId: fields.profileId || null,
    profileDisplayName: fields.profileDisplayName || "",
    fetchedAt: fields.fetchedAt || new Date().toISOString(),
    source: "chatgpt-wham-usage",
    message: fields.message || "",
    planType: fields.planType || null,
    primary: fields.primary || null,
    secondary: fields.secondary || null,
    credits: fields.credits || null,
  };
}

async function fetchUsagePayload({
  accessToken,
  accountId,
  endpoint,
  env,
  fetchImpl,
  timeoutMs,
}) {
  if (shouldUseCurlTransport(env, fetchImpl)) {
    return fetchUsagePayloadWithCurl({
      accessToken,
      accountId,
      endpoint,
      env,
      timeoutMs,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": CODEX_USER_AGENT,
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }

    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`额度接口返回 ${response.status} ${response.statusText || ""}`.trim());
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("额度接口请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsagePayloadWithCurl({
  accessToken,
  accountId,
  endpoint,
  env,
  timeoutMs,
}) {
  const statusMarker = "__CPS_HTTP_STATUS__:";
  const config = [
    `url = ${curlConfigString(endpoint)}`,
    `header = ${curlConfigString("accept: application/json")}`,
    `header = ${curlConfigString(`authorization: Bearer ${accessToken}`)}`,
    `header = ${curlConfigString(`user-agent: ${CODEX_USER_AGENT}`)}`,
  ];
  if (accountId) {
    config.push(`header = ${curlConfigString(`chatgpt-account-id: ${accountId}`)}`);
  }
  if (env.CODEX_PROFILE_USAGE_PROXY) {
    config.push(`proxy = ${curlConfigString(env.CODEX_PROFILE_USAGE_PROXY)}`);
  }

  const output = await spawnWithInput(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(Math.ceil(timeoutMs / 1000)),
      "--write-out",
      `\n${statusMarker}%{http_code}`,
      "--config",
      "-",
    ],
    `${config.join("\n")}\n`,
  );
  const markerIndex = output.lastIndexOf(statusMarker);
  if (markerIndex === -1) {
    throw new Error("额度接口返回无法解析");
  }

  const body = output.slice(0, markerIndex).trim();
  const status = Number(output.slice(markerIndex + statusMarker.length).trim());
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const error = new Error(`额度接口返回 ${Number.isInteger(status) ? status : "unknown"}`);
    error.status = status;
    throw error;
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`额度接口返回的 JSON 无法解析: ${error.message}`, { cause: error });
  }
}

function usageErrorMessage(error) {
  const code = error?.cause?.code || error?.code || "";
  const causeName = error?.cause?.name || "";
  const status = error?.status;

  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === 28 || causeName === "ConnectTimeoutError") {
    return "连接 ChatGPT usage 接口超时，请检查 VPN/代理或终端网络是否可访问 chatgpt.com";
  }
  if (code === "ENOTFOUND" || code === 6) {
    return "无法解析 chatgpt.com，请检查 DNS 或网络连接";
  }
  if (code === "ECONNRESET" || code === "ETIMEDOUT") {
    return "连接 ChatGPT usage 接口失败，请检查网络、代理或防火墙";
  }
  if (status === 401 || status === 403) {
    return "额度接口拒绝访问，可能需要重新登录当前 Codex profile 后再导入 auth.json";
  }
  if (status === 429) {
    return "额度接口请求过于频繁，请稍后再刷新";
  }

  return redactText(error?.message || String(error));
}

function shouldUseCurlTransport(env, fetchImpl) {
  if (fetchImpl !== globalThis.fetch) {
    return false;
  }
  return env.CODEX_PROFILE_USAGE_TRANSPORT === "curl" || Boolean(env.CODEX_PROFILE_USAGE_PROXY);
}

function curlConfigString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeUsagePayload(payload, fields) {
  const rateLimit = objectValue(payload?.rate_limit);
  const credits = objectValue(payload?.credits);
  return usageStatus("ok", {
    ...fields,
    message: "额度信息已更新",
    planType: stringValue(payload?.plan_type),
    primary: normalizeWindow(rateLimit?.primary_window),
    secondary: normalizeWindow(rateLimit?.secondary_window),
    credits: credits
      ? {
          hasCredits: booleanOrNull(credits.has_credits),
          unlimited: booleanOrNull(credits.unlimited),
          balance: stringValue(credits.balance),
        }
      : null,
  });
}

function normalizeWindow(value) {
  const window = objectValue(value);
  if (!window) {
    return null;
  }

  const usedPercent = numberOrNull(window.used_percent);
  const limitWindowSeconds = numberOrNull(window.limit_window_seconds);
  const resetAt = numberOrNull(window.reset_at);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes:
      limitWindowSeconds === null ? null : Math.ceil(limitWindowSeconds / 60),
    resetsAt: timestampToIso(resetAt),
    resetAtUnix: resetAt,
  };
}

function extractChatGptAuth(auth) {
  const tokens = objectValue(auth?.tokens);
  const idToken = stringValue(tokens?.id_token) || stringValue(auth?.id_token);
  const claims = parseJwtClaims(idToken);
  const authClaims = objectValue(claims?.["https://api.openai.com/auth"]);

  return {
    accessToken: stringValue(tokens?.access_token) || stringValue(auth?.access_token),
    accountId:
      stringValue(tokens?.account_id) ||
      stringValue(auth?.account_id) ||
      stringValue(auth?.account?.id) ||
      stringValue(authClaims?.chatgpt_account_id),
  };
}

function parseJwtClaims(token) {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function usageEndpoint(env) {
  return env.CODEX_PROFILE_USAGE_ENDPOINT || DEFAULT_USAGE_ENDPOINT;
}

function usageTimeoutMs(env) {
  const value = Number(env.CODEX_PROFILE_USAGE_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(value, 60_000);
}

function timestampToIso(value) {
  if (value === null) {
    return null;
  }

  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
