import fs from "node:fs/promises";
import path from "node:path";
import { metadataPath } from "./paths.js";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-utils.js";
import { assertNoPlaintextSecrets } from "./redaction.js";
import { AppError } from "./errors.js";
import { assertValidProfileId, normalizeTags } from "./profile-id.js";

const EMPTY_METADATA = {
  version: 1,
  active_profile_id: null,
  profiles: [],
};

export function createSecretRef(profileId) {
  return `codex-profile-switcher/${profileId}/auth`;
}

export class MetadataStore {
  constructor(env = process.env) {
    this.env = env;
    this.filePath = metadataPath(env);
  }

  async read() {
    const data = await readJson(this.filePath, structuredClone(EMPTY_METADATA));
    return normalizeMetadata(data);
  }

  async write(metadata) {
    const normalized = normalizeMetadata(metadata);
    assertNoPlaintextSecrets(normalized);
    await ensureDir(path.dirname(this.filePath));
    await writeJsonAtomic(this.filePath, normalized, 0o600);
    return normalized;
  }

  async listProfiles() {
    const metadata = await this.read();
    return metadata.profiles;
  }

  async getProfile(profileId) {
    const metadata = await this.read();
    const profile = metadata.profiles.find(
      (candidate) => candidate.profile_id === profileId,
    );
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", `Profile "${profileId}" does not exist.`, {
        exitCode: 2,
      });
    }
    return profile;
  }

  async upsertProfile(input) {
    assertValidProfileId(input.profile_id);
    const metadata = await this.read();
    const now = new Date().toISOString();
    const existing = metadata.profiles.find(
      (profile) => profile.profile_id === input.profile_id,
    );

    const profile = normalizeProfile({
      ...existing,
      created_at: existing?.created_at || now,
      ...input,
      updated_at: now,
    });

    const nextProfiles = metadata.profiles.filter(
      (candidate) => candidate.profile_id !== profile.profile_id,
    );
    nextProfiles.push(profile);
    nextProfiles.sort((a, b) => a.profile_id.localeCompare(b.profile_id));

    metadata.profiles = nextProfiles;
    await this.write(metadata);
    return profile;
  }

  async removeProfile(profileId) {
    assertValidProfileId(profileId);
    const metadata = await this.read();
    const before = metadata.profiles.length;
    metadata.profiles = metadata.profiles.filter(
      (profile) => profile.profile_id !== profileId,
    );

    if (metadata.profiles.length === before) {
      throw new AppError("PROFILE_NOT_FOUND", `Profile "${profileId}" does not exist.`, {
        exitCode: 2,
      });
    }

    if (metadata.active_profile_id === profileId) {
      metadata.active_profile_id = null;
    }

    await this.write(metadata);
  }

  async renameProfile(oldId, newId) {
    assertValidProfileId(oldId);
    assertValidProfileId(newId);
    const metadata = await this.read();

    if (metadata.profiles.some((profile) => profile.profile_id === newId)) {
      throw new AppError("PROFILE_EXISTS", `Profile "${newId}" already exists.`, {
        exitCode: 2,
      });
    }

    const profile = metadata.profiles.find(
      (candidate) => candidate.profile_id === oldId,
    );
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", `Profile "${oldId}" does not exist.`, {
        exitCode: 2,
      });
    }

    profile.profile_id = newId;
    profile.auth_secret_ref = profile.auth_secret_ref
      ? createSecretRef(newId)
      : undefined;
    profile.updated_at = new Date().toISOString();

    if (metadata.active_profile_id === oldId) {
      metadata.active_profile_id = newId;
    }

    await this.write(metadata);
    return profile;
  }

  async setActiveProfile(profileId) {
    assertValidProfileId(profileId);
    const metadata = await this.read();
    const profile = metadata.profiles.find(
      (candidate) => candidate.profile_id === profileId,
    );
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", `Profile "${profileId}" does not exist.`, {
        exitCode: 2,
      });
    }

    const now = new Date().toISOString();
    metadata.active_profile_id = profileId;
    metadata.profiles = metadata.profiles.map((candidate) => {
      if (candidate.profile_id !== profileId) {
        return { ...candidate, is_active: false };
      }
      return {
        ...candidate,
        is_active: true,
        last_used_at: now,
        updated_at: now,
      };
    });

    await this.write(metadata);
    return metadata.profiles.find((candidate) => candidate.profile_id === profileId);
  }

  async currentProfile() {
    const metadata = await this.read();
    if (!metadata.active_profile_id) {
      return null;
    }
    return (
      metadata.profiles.find(
        (profile) => profile.profile_id === metadata.active_profile_id,
      ) || null
    );
  }

  async exportMetadata(outputPath) {
    const metadata = await this.read();
    await ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      await fs.chmod(outputPath, 0o600);
    }
    return outputPath;
  }
}

function normalizeMetadata(data) {
  const activeProfileId = data.active_profile_id || null;
  const profiles = Array.isArray(data.profiles)
    ? data.profiles.map((profile) =>
        normalizeProfile({
          ...profile,
          is_active: Boolean(
            activeProfileId && profile.profile_id === activeProfileId,
          ),
        }),
      )
    : [];

  return {
    version: 1,
    active_profile_id: activeProfileId,
    profiles,
  };
}

function normalizeProfile(input) {
  const profileId = input.profile_id;
  assertValidProfileId(profileId);

  return {
    profile_id: profileId,
    display_name: input.display_name || profileId,
    email: input.email || "",
    workspace_name: input.workspace_name || "",
    plan_type: input.plan_type || "",
    auth_source: input.auth_source || "none",
    auth_secret_ref: input.auth_secret_ref,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: input.updated_at || new Date().toISOString(),
    last_used_at: input.last_used_at || null,
    notes: input.notes || "",
    tags: normalizeTags(input.tags),
    is_active: Boolean(input.is_active),
  };
}
