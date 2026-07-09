const SENSITIVE_KEY_RE =
  /(^|[_-])(access|refresh|session|id)?_?(token|secret|cookie|password|api[_-]?key|authorization)($|[_-])/i;

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
];

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key));
}

export function maskSecret(value) {
  const text = String(value);
  if (text.length <= 8) {
    return "****";
  }
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

export function redactText(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (/^Bearer\s+/i.test(match)) {
        return `Bearer ${maskSecret(match.replace(/^Bearer\s+/i, ""))}`;
      }
      return maskSecret(match);
    });
  }
  return text;
}

export function redactObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? maskSecret(entry) : redactObject(entry),
      ]),
    );
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  return value;
}

export function assertNoPlaintextSecrets(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoPlaintextSecrets(item, [...path, String(index)]);
    });
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === "auth_secret_ref") {
      continue;
    }

    if (isSensitiveKey(key)) {
      throw new Error(
        `Refusing to write sensitive metadata key "${[...path, key].join(".")}"`,
      );
    }

    if (typeof entry === "string" && redactText(entry) !== entry) {
      throw new Error(
        `Refusing to write token-like metadata value at "${[
          ...path,
          key,
        ].join(".")}"`,
      );
    }

    assertNoPlaintextSecrets(entry, [...path, key]);
  }
}
