import { AppError } from "./errors.js";

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function assertValidProfileId(profileId) {
  if (!profileId || !PROFILE_ID_RE.test(profileId)) {
    throw new AppError(
      "INVALID_PROFILE_ID",
      "Profile id must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.",
      { exitCode: 2 },
    );
  }
}

export function normalizeTags(tags) {
  if (!tags) {
    return [];
  }

  const values = Array.isArray(tags) ? tags : [tags];
  return [...new Set(values.flatMap((tag) => String(tag).split(",")))]
    .map((tag) => tag.trim())
    .filter(Boolean);
}
