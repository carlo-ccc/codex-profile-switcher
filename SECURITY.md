# Security Policy

## Security Model

Codex Profile Switcher stores only profile metadata in ordinary files. Imported `auth.json` contents are stored in the system secure store:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service through `secret-tool`

The metadata file must not contain:

- access tokens
- refresh tokens
- session tokens
- cookies
- API keys
- Authorization headers
- full `auth.json` contents

The CLI redacts token-like values in default error output and avoids printing imported auth contents.

The active-session monitor verifies account identity before copying a changed
`auth.json` into secure storage. An identity mismatch is reported without
overwriting either credential set.

OAuth refresh responses are never logged. Rotated refresh tokens are written to
secure storage before a profile is activated.

The detached daemon state and log files contain only PID/heartbeat information,
redacted synchronization status, profile IDs, and timestamps. They never contain
`auth.json` contents, access tokens, or refresh tokens. The daemon inherits only
the small environment-variable allowlist needed for paths and supported secure
storage backends.

## Sensitive Files

The CLI writes Codex auth data to:

```text
~/.codex/auth.json
```

On Unix-like systems, sensitive files are written with `0600` permissions where possible.

Backups are stored under:

```text
~/.codex-profile-switcher/backups/
```

Backups contain sensitive `auth.json` data. Treat them as secrets.

## Process Safety

Switching while Codex is running can leave active sessions in an inconsistent state. The CLI defaults to blocking `use` and `restore` if Codex-related processes are detected.

Force close is not implemented in the MVP. Users should close Codex sessions manually before switching.

The auth-sync daemon does not switch profiles or terminate Codex processes. It
only copies a verified matching active `auth.json` into secure storage. Daemon
stop refuses to signal a PID whose heartbeat is stale, reducing the risk of
terminating an unrelated process after PID reuse.

## Reporting Issues

If you find a security issue, do not include real tokens, cookies, `auth.json` contents, or Authorization headers in reports. Share a minimal reproduction with redacted values.

## Non-Goals

This tool must not be used for:

- account sharing
- automatic account rotation
- continuing one task across accounts after a usage limit
- bypassing rate limits or usage limits
- background polling to find an available account
