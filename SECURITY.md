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

## Reporting Issues

If you find a security issue, do not include real tokens, cookies, `auth.json` contents, or Authorization headers in reports. Share a minimal reproduction with redacted values.

## Non-Goals

This tool must not be used for:

- account sharing
- quota pooling
- automatic account rotation
- continuing one task across accounts after a usage limit
- bypassing rate limits or usage limits
- background polling to find an available account
- warm-up or preload requests
