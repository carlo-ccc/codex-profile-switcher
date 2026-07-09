import { policyPath } from "./paths.js";
import { readJson, writeJsonAtomic } from "./fs-utils.js";
import { AppError } from "./errors.js";

export const BOUNDARY_NOTICE_ZH = `本工具仅用于管理你本人拥有并本人使用的 Codex 账号 profile。
请不要用于账号共享、自动轮换、额度池化、绕过 rate limit / usage limit，或在一个账号达到限制后自动切换到另一个账号继续同一任务。`;

export const BOUNDARY_ACK_ZH =
  "我理解并同意：本工具只用于手动 profile 切换，不用于自动额度接力。";

export const BOUNDARY_NOTICE_EN =
  "This tool switches local Codex profiles manually. It does not merge quotas, auto-rotate accounts, or continue tasks across accounts.";

export async function readPolicy(env = process.env) {
  return readJson(policyPath(env), {
    version: 1,
    manual_switching_acknowledged_at: null,
  });
}

export async function writePolicyAcknowledgement(env = process.env) {
  const policy = {
    version: 1,
    manual_switching_acknowledged_at: new Date().toISOString(),
  };
  await writeJsonAtomic(policyPath(env), policy, 0o600);
  return policy;
}

export async function ensurePolicyAcknowledged(options = {}) {
  const { env = process.env, acceptBoundary = false } = options;
  const policy = await readPolicy(env);

  if (policy.manual_switching_acknowledged_at) {
    return policy;
  }

  if (acceptBoundary) {
    return writePolicyAcknowledgement(env);
  }

  throw new AppError(
    "BOUNDARY_ACK_REQUIRED",
    `${BOUNDARY_NOTICE_ZH}\n\n${BOUNDARY_ACK_ZH}\n\nRun "codex-profile acknowledge" once, or pass --accept-boundary with this command.`,
    { exitCode: 2 },
  );
}
