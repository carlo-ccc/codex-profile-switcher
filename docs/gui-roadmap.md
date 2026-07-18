# Optional Desktop Packaging Roadmap

The project already provides a zero-dependency local web GUI and a detached
auth-sync daemon. Persistent credential synchronization therefore does not
require a desktop rewrite. If native tray/Dock packaging is desired later, the
recommended path remains Tauri + React + TypeScript, reusing the same core
command logic through a thin bridge.

## First GUI Milestone

- Profile list
- Current active profile
- Manual switch button
- Import `auth.json`
- Delete profile
- Profile metadata editor
- Local Codex file status
- Process detection status
- Secure storage status
- Doctor panel
- Metadata export
- Settings page

## Required Copy

```text
This tool switches local Codex profiles manually.
It does not merge quotas, auto-rotate accounts, or continue tasks across accounts.
```

```text
本工具仅用于手动切换本地 Codex profile。
它不会合并多个账号额度，不会自动切号，也不会在账号达到限制后接力同一个任务。
```

## UX Requirements

- Show the first-use boundary with an explicit checkbox.
- Make switching a manual, user-triggered action.
- Show files that will be modified before switching.
- Warn when Codex-related processes are running.
- Default to soft process checks.
- Do not add usage pooling views, total quota charts, auto-rotation controls, warm-up controls, or continue-on-limit flows.

## Suggested Structure

```text
packages/
  cli/
  core/
  desktop/
crates/
  secure-store/
  process-detect/
```

The current Node.js MVP can either remain the CLI implementation or become a reference for a later Rust core.
