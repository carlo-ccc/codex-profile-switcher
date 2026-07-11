# Codex Profile Switcher

Codex Profile Switcher is a cross-platform CLI for managing multiple local Codex / ChatGPT account profiles that you personally own and use. It switches local Codex CLI auth context manually by updating `~/.codex/auth.json` from a profile stored in the system secure store.

This is a manual Codex profile switcher.
It does not merge quotas.
It does not auto-rotate accounts.
It does not continue tasks across accounts.
It does not help bypass rate limits or usage limits.

这是一个手动 Codex profile 切换器。
它不会合并多个账号额度。
它不会自动轮换账号。
它不会在账号之间接力同一个任务。
它不用于绕过 rate limit 或 usage limit。

## MVP Scope

Implemented:

- CLI commands for `add`, `list`, `current`, `use`, `remove`, `rename`, `status`, `doctor`, `backup`, `restore`, and metadata `export`
- `import-auth` for importing an existing Codex `auth.json`
- `capture-current` for saving the currently active Codex `auth.json`
- Native `codex login` capture and profile-specific credential refresh in an isolated temporary Codex home
- Local web GUI for listing, importing, editing, switching, backing up, and exporting metadata
- Current active profile usage display in the local GUI
- System secure storage for auth secrets:
  - macOS Keychain
  - Windows Credential Manager
  - Linux Secret Service via `secret-tool`
- Metadata-only `profiles.json`
- Manual switching of `~/.codex/auth.json`
- Backup and rollback on switch failure
- Default process check that blocks switching while Codex-related processes are running
- Redacted error output
- First-use manual switching acknowledgement
- Tests and CI workflow

Not implemented:

- Usage pooling or total quota views
- Warm-up
- Auto rotation
- Quota pooling
- Automatic task continuation
- Team sharing
- Cloud sync

## Requirements

- Node.js 20 or newer
- One supported secure-storage backend:
  - macOS: Keychain through `/usr/bin/security`
  - Windows: Credential Manager through PowerShell and Windows APIs
  - Linux: Secret Service through `secret-tool` (`libsecret`)

## Install

From this repository:

```bash
npm link
codex-profile help
```

Or run without linking:

```bash
node ./bin/codex-profile.js help
```

## First Use

Mutating commands require a one-time acknowledgement:

```bash
codex-profile acknowledge
```

The acknowledgement says:

```text
本工具仅用于管理你本人拥有并本人使用的 Codex 账号 profile。
请不要用于账号共享、自动轮换、额度池化、绕过 rate limit / usage limit，或在一个账号达到限制后自动切换到另一个账号继续同一任务。

我理解并同意：本工具只用于手动 profile 切换，不用于自动额度接力。
```

You can also pass `--accept-boundary` to a mutating command in automation or tests.

## Common Usage

```bash
codex-profile import-auth ./auth-personal.json --name personal
codex-profile import-auth ./auth-work.json --name work
# Or capture the currently logged-in Codex auth directly:
codex-profile capture-current personal --use

codex-profile list
codex-profile current
codex-profile use personal
codex-profile use work
codex-profile status
codex-profile doctor
codex-profile gui
```

## Login And Refresh Flow

Use the native Codex login flow to authenticate each account without touching the
currently active `~/.codex/auth.json`. The temporary login directory is deleted
after its `auth.json` has been saved to the system secure store.

For accounts that may otherwise be auto-selected in the browser, add
`--device-auth` and follow the code shown by Codex:

```bash
codex-profile login personal --device-auth --use
codex-profile login work --device-auth

codex-profile use work
codex-profile use personal
```

To give one saved profile a chance to renew its native login, or to complete a
new browser sign-in when needed, run:

```bash
codex-profile refresh-auth personal --device-auth
```

This does not change the active local Codex session unless `--use` is supplied.
It relies on the installed Codex CLI to refresh or re-authenticate; this project
does not call private OAuth token endpoints itself.

`capture-current` remains useful for migrating an already logged-in local
session into the secure store:

```bash
codex-profile capture-current personal --use
```

After switching, open a new terminal window or restart Codex CLI before continuing.

## Commands

```bash
codex-profile acknowledge
codex-profile list
codex-profile current
codex-profile add <profile_id>
codex-profile import-auth ./auth.json --name personal
codex-profile import-auth ./auth.json --name personal --use
codex-profile capture-current personal
codex-profile login personal --device-auth
codex-profile refresh-auth personal --device-auth
codex-profile use personal
codex-profile remove personal --yes
codex-profile rename personal main
codex-profile status
codex-profile doctor
codex-profile gui [--port 8787]
codex-profile backup
codex-profile restore <backup-path>
codex-profile export --output metadata.json
```

## Local GUI

Start the local visual interface:

```bash
npm run gui
```

Or with the linked CLI:

```bash
codex-profile gui --port 8787
```

Then open the printed local URL. The GUI uses the same core logic as the CLI and keeps switching manual: it can import `auth.json`, show profile/status/doctor information, show the current active profile's separate usage, edit metadata, create backups, export metadata, and switch only when you click the switch button.

The usage panel refreshes only the active profile while the GUI is open. It does not poll inactive profiles, total usage across profiles, or choose a profile based on remaining usage.

The following commands are intentionally not provided:

```bash
codex-profile auto-rotate
codex-profile continue-on-limit
codex-profile pool
codex-profile total-quota
codex-profile warmup-all
```

## Storage

Metadata is written to:

```text
~/.codex-profile-switcher/profiles.json
```

Secrets are written to the system secure store. The metadata file stores only an `auth_secret_ref`, never the full `auth.json`, tokens, cookies, API keys, or authorization headers.

The target Codex auth file is:

```text
~/.codex/auth.json
```

You can override paths for testing or advanced local setups:

```bash
CODEX_PROFILE_SWITCHER_HOME=/tmp/cps-home
CODEX_PROFILE_CODEX_HOME=/tmp/codex-home
```

## Switching Safety

Before `use` or `restore`, the CLI checks for common Codex-related processes such as `codex`, `codex-cli`, VS Code Codex extension processes, `app-server`, and Antigravity Codex processes.

Default behavior blocks switching while such processes are running. `--allow-running` exists for explicit manual override, but the safer path is to close active Codex sessions first.

Force close is not implemented in the MVP. Passing `--force-close` without `--confirm-force-close` fails with a confirmation error, and passing both flags reports that force close is intentionally unavailable.

## Development

Run tests:

```bash
npm test
```

Run doctor locally:

```bash
npm run doctor
```

Test-only secure storage is enabled only by setting:

```bash
CODEX_PROFILE_TEST_STORE=1
```

Do not use that setting for real credentials.

## Desktop GUI Plan

The repository now includes a zero-dependency local web GUI. A future Tauri + React + TypeScript desktop GUI plan is documented in [docs/gui-roadmap.md](docs/gui-roadmap.md).
