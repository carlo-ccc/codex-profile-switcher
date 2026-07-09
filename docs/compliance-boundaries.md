# Compliance Boundaries

Codex Profile Switcher is a local manual profile manager. It is not a quota pooler, auto rotator, or task relay.

Allowed:

- Add, remove, rename, and view profiles you personally own and use
- Import one profile's `auth.json` into system secure storage
- Manually switch the local Codex auth context
- View each profile's separate metadata and last-used time
- View the current active profile's separate usage while the GUI is open
- Run doctor diagnostics for local files, secure storage, and process state
- Back up and restore local `auth.json`

Not allowed:

- Automatically switch from account A to account B after a limit
- Continue the same task across accounts
- Merge usage or quota across accounts
- Show a total quota pool
- Pick an account based on remaining usage
- Share accounts with other people
- Warm up all accounts
- Run scheduled warm-up requests
- Poll accounts in the background to find available usage
- Poll inactive profiles or choose a profile based on remaining usage

Required user-facing boundary text:

```text
This tool switches local Codex profiles manually.
It does not merge quotas, auto-rotate accounts, or continue tasks across accounts.
```

```text
本工具仅用于手动切换本地 Codex profile。
它不会合并多个账号额度，不会自动切号，也不会在账号达到限制后接力同一个任务。
```

The CLI uses a one-time acknowledgement for mutating commands. A future GUI should present the same boundary as an explicit checkbox before enabling profile changes.
