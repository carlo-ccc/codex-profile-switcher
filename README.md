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
- Active-session auth synchronization: refreshed tokens written by a running Codex session are copied back to the active profile's secure-store entry
- Identity checks before synchronization so a direct login to another account cannot overwrite the wrong profile
- Automatic OAuth refresh for an expired saved profile immediately before a manual switch
- Detached auth-sync daemon with health/heartbeat status and safe start, restart, and stop controls
- Automatic daemon startup after profile activation and when the local GUI starts
- Foreground `watch` monitor for troubleshooting or environments where detached processes are unavailable
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

## 完整使用指南（推荐流程）

下面以两个账号 `account-a` 和 `account-b` 为例。请把名称替换成便于自己识别的名称，例如 `personal`、`work`。

### 0. 选择命令写法

如果已经执行过 `npm link`，可以直接使用：

```bash
codex-profile <command>
```

如果不想全局安装，请在本项目目录运行：

```bash
node ./bin/codex-profile.js <command>
```

本文后面的示例使用较短的 `codex-profile` 写法。在 Windows PowerShell 中，可以将其替换成：

```powershell
node ./bin/codex-profile.js <command>
```

### 1. 首次检查并确认安全提示

```bash
codex-profile doctor
codex-profile acknowledge
```

`doctor` 会检查 Codex CLI、`auth.json`、凭据存储方式和安全存储后端。首次运行时必须执行一次 `acknowledge`，确认你理解切换账号会替换当前 Codex 登录状态。

如果 `doctor` 提示当前凭据存储方式不兼容，请在 `~/.codex/config.toml` 中设置：

```toml
cli_auth_credentials_store = "file"
```

然后重新登录一次 Codex，使 `~/.codex/auth.json` 正常生成。

### 2. 保存电脑上当前已登录的账号 A

如果 Codex 当前已经登录账号 A，先等待正在执行的任务结束，再运行：

```bash
codex-profile capture-current account-a --use
codex-profile current
codex-profile daemon status
```

这会把当前 `~/.codex/auth.json` 保存到系统安全存储，将 `account-a` 标记为活动配置，并启动后台同步。保存成功后，**不要执行 `codex logout`**；注销会让已经保存的登录会话失效。

如果只是保存当前账号而暂时不想启用后台同步，可在执行前设置 `CODEX_PROFILE_DISABLE_AUTO_DAEMON=1`，或者保存后运行 `codex-profile daemon stop`。

### 3. 添加第二个账号 B

推荐使用项目提供的隔离登录流程。它会在临时 `CODEX_HOME` 中登录，不会覆盖正在使用的账号 A：

```bash
codex-profile login account-b --device-auth
```

终端会显示设备授权网址和一次性代码。只在终端给出的 OpenAI 官方页面输入该代码，不要把代码发给其他人。

如果出现“在 ChatGPT 安全设置中为 Codex 启用设备代码授权”的提示：

1. 个人账号需要在 ChatGPT 的安全设置中启用 Codex 设备代码授权。
2. 工作区账号可能需要管理员在工作区设置中允许设备代码授权。
3. 如果无法启用，去掉 `--device-auth`，改用普通浏览器 OAuth：

```bash
codex-profile login account-b
```

普通 OAuth 仍然运行在隔离目录中，因此不会覆盖账号 A。如果浏览器自动选择了账号 A，请复制终端中的登录地址，在无痕窗口中打开并登录账号 B。

此时先不要添加 `--use`。登录完成后，账号 B 只会被保存，不会立即替换当前 Codex 登录。

### 4. 检查两个账号是否保存成功

```bash
codex-profile list
codex-profile current
```

`list` 应该同时显示 `account-a` 和 `account-b`，`current` 应该仍然显示 `account-a`。

### 5. 从账号 A 切换到账号 B

1. 等待 Codex 当前任务结束。
2. 完全关闭 Codex CLI、Codex 桌面应用和使用 Codex 的 IDE/编辑器扩展。
3. 确认没有残留进程，然后执行切换：

```bash
codex-profile status
codex-profile use account-b
```

4. 看到切换成功后，重新打开 Codex。

切换时工具会先同步活动账号 A 的最新令牌，再检查账号 B 是否需要刷新，并备份当前 `auth.json`，最后才进行替换。如果仍检测到 Codex 相关进程，命令会拒绝切换；请关闭进程后重试，不建议使用 `--allow-running` 绕过保护。

切换回账号 A：

```bash
codex-profile use account-a
```

每次切换后都应重新启动 Codex，使应用加载新的 `auth.json`。

### 6. 日常使用的最短流程

保存完所有账号后，平时只需要：

```bash
# 先关闭所有 Codex 进程
codex-profile list
codex-profile use account-b
# 再重新打开 Codex
```

不需要在每次切换前重新登录，也不要在账号之间执行 `codex logout`。

### 7. 导入、更新或修复某个账号

如果已经有其他来源的 Codex `auth.json`，可以导入：

```bash
codex-profile import-auth /path/to/auth.json --name account-b
```

Windows PowerShell 示例：

```powershell
node ./bin/codex-profile.js import-auth "C:\path\to\auth.json" --name account-b
```

`auth.json` 包含敏感令牌，不要发送给他人，也不要提交到 Git。

如果某个账号的刷新令牌失效，可以重新执行隔离登录并覆盖该配置：

```bash
codex-profile refresh-auth account-b --device-auth
```

设备授权不可用时：

```bash
codex-profile refresh-auth account-b
```

如果只是访问令牌过期、刷新令牌仍然有效，可以尝试：

```bash
codex-profile refresh-token account-b
```

### 8. 后台同步、休眠和关机行为

后台守护进程默认每 **10 分钟**检查一次活动账号的本地 `~/.codex/auth.json`，仅在认证数据发生变化时写回安全存储。它不是每十分钟请求 OpenAI，也不会持续刷新用量/额度数据，因此正常情况下 CPU、内存和网络负担都很小。

常用命令：

```bash
codex-profile daemon status
codex-profile daemon restart
codex-profile daemon stop
codex-profile daemon start
```

系统行为：

| 场景 | 行为 |
| --- | --- |
| 关闭浏览器登录页 | 登录已经完成后不影响已保存账号，也不影响守护进程 |
| 关闭本地 GUI 浏览器页面 | 如果启动 GUI 的终端仍在运行，GUI 服务和独立守护进程都会继续运行 |
| 关闭启动 GUI 的终端 | GUI 服务停止，但独立守护进程继续运行 |
| 电脑休眠 | 定时器暂停；唤醒后守护进程继续同步 |
| 电脑关机或重启 | 守护进程停止，但系统安全存储中的账号不会丢失 |
| 重启后第一次执行 `capture-current --use`、`use` 或启动 GUI | 如果未禁用自动启动，守护进程会重新启动 |
| 手动执行 `daemon stop` | 当前守护进程停止；下次激活账号或启动 GUI 时可能自动启动 |

本项目目前不会注册为 Windows/macOS/Linux 的开机自启动服务。如果需要完全禁用自动启动，请设置环境变量：

```text
CODEX_PROFILE_DISABLE_AUTO_DAEMON=1
```

Windows 永久设置示例：

```powershell
setx CODEX_PROFILE_DISABLE_AUTO_DAEMON 1
node ./bin/codex-profile.js daemon stop
```

恢复自动启动时删除该环境变量，并手动运行一次 `daemon start`。Windows 下的后台子进程会以隐藏窗口方式运行；如果旧版本仍周期性弹出终端框，请更新代码后执行 `daemon restart`。

### 9. 使用本地 GUI

```bash
npm run gui
```

然后打开终端显示的本地地址。GUI 可用于查看配置、登录、切换、刷新令牌和查看用量。GUI 只监听 `127.0.0.1`，所有修改请求都要求会话 CSRF token。关闭 GUI 不会删除账号，也不会停止已经独立启动的后台同步。

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

For normal manual switching, expired ChatGPT OAuth access tokens are refreshed
through OpenAI's OAuth token service immediately before `use` writes the saved
profile to `~/.codex/auth.json`. Rotated refresh tokens are saved back to the
system secure store. Use `--no-refresh` only for offline troubleshooting.

After a profile is activated, the CLI automatically starts a detached auth-sync
daemon. It watches the active `auth.json` every 10 minutes and saves token
rotations back to the matching profile without modifying or stopping the running
Codex session. The daemon keeps running after the command terminal or local GUI
is closed:

```bash
# Usually automatic after `use`, `login --use`, `capture-current --use`,
# `import-auth --use`, or GUI startup. These commands manage it explicitly:
codex-profile daemon status
codex-profile daemon start
codex-profile daemon restart
codex-profile daemon stop

# Foreground fallback/debugging mode:
codex-profile watch

# One-shot synchronization and direct saved-token refresh.
codex-profile sync-active
codex-profile refresh-token personal
```

Both daemon and foreground monitor compare account identity before writing. If `auth.json` belongs to
a different account, it reports an identity mismatch and leaves the saved
profile unchanged. It never switches profiles automatically.

Immediately before every manual switch, the switcher also performs one final
synchronization of the previously active profile. This closes the gap where
Codex might rotate a refresh token just before `auth.json` is replaced.

The daemon synchronizes only the manually selected active profile. Inactive
profiles are not polled; an expired inactive profile is refreshed only when you
manually switch to it. Set `CODEX_PROFILE_DISABLE_AUTO_DAEMON=1` if you prefer
to use only the foreground monitor.

`capture-current` remains useful for migrating an already logged-in local
session into the secure store:

```bash
codex-profile capture-current personal --use
```

After switching, open a new terminal window or restart Codex CLI before continuing.

## 常见问题与故障处理

### 提示必须启用设备代码授权

这是 Codex 登录侧的安全设置，不是本项目的报错。可在 ChatGPT 安全设置中启用设备代码授权；工作区账号可能需要管理员允许。如果不能启用，改用不带 `--device-auth` 的隔离登录：

```bash
codex-profile login account-b
```

### 提示存在正在运行的 Codex 进程

先保存正在执行的工作并退出 Codex CLI、桌面应用和 IDE 扩展，然后重新运行：

```bash
codex-profile status
codex-profile use account-b
```

进程保护用于避免 Codex 在切换过程中把旧账号的令牌再次写回 `auth.json`。除非只是在受控环境中排查问题，否则不要使用 `--allow-running`。

### 找不到 `~/.codex/auth.json`

先确认 Codex CLI 已正常安装并完成一次登录，再运行 `codex-profile doctor`。如果 Codex 被配置为只把凭据保存在系统钥匙串中，请在 `~/.codex/config.toml` 设置：

```toml
cli_auth_credentials_store = "file"
```

重新登录后再执行 `capture-current`。

### 刷新令牌无效或账号需要重新认证

优先重新认证单个配置，不需要注销当前账号：

```bash
codex-profile refresh-auth account-b
```

如果已启用设备代码授权，也可以添加 `--device-auth`。完成后再次运行 `codex-profile use account-b`。

### 后台同步报告 identity mismatch

这表示当前 `~/.codex/auth.json` 的账号身份与记录的活动配置不同。工具会拒绝写回，防止用一个账号覆盖另一个账号。常见原因是在项目之外直接执行了 `codex login`。

如果当前登录确实是一个需要保存的新账号，请用新的、未占用的配置名捕获：

```bash
codex-profile capture-current account-c --use
```

如果这是误登录，请关闭 Codex 后使用 `codex-profile use <正确的配置名>` 恢复。

### Windows 仍然周期性弹出终端窗口

先确认使用的是包含隐藏后台窗口修复的最新代码，然后重启守护进程：

```powershell
node ./bin/codex-profile.js daemon stop
node ./bin/codex-profile.js daemon start
node ./bin/codex-profile.js daemon status
```

如果仍有弹窗，可先运行 `daemon stop`；账号仍安全保存在 Windows Credential Manager 中，只是暂时不会自动同步活动账号的令牌变化。

### 守护进程状态异常

```bash
codex-profile daemon status
codex-profile daemon restart
codex-profile daemon status
```

如果不需要后台同步，可执行 `daemon stop`。即使守护进程停止，已经保存的账号也不会被删除；手动切换前的最终同步仍会尝试保护当前活动配置。

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
codex-profile refresh-token personal
codex-profile sync-active
codex-profile watch [--interval 600000]
codex-profile daemon start [--interval 600000]
codex-profile daemon status
codex-profile daemon restart [--interval 600000]
codex-profile daemon stop
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

The GUI automatically ensures the detached auth-sync daemon is running. Closing
the GUI does not stop that daemon; use `codex-profile daemon stop` when you want
to stop background synchronization. The usage panel still refreshes only the
active profile; it does not poll inactive profiles, total usage across profiles,
or choose a profile based on remaining usage.

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

The daemon writes only redacted operational state and logs to:

```text
~/.codex-profile-switcher/auth-sync-daemon.json
~/.codex-profile-switcher/auth-sync-daemon.log
```

Neither daemon file contains `auth.json` contents or tokens.

Secrets are written to the system secure store. The metadata file stores only an `auth_secret_ref`, never the full `auth.json`, tokens, cookies, API keys, or authorization headers.

On Windows, large `auth.json` payloads are split across multiple Credential
Manager entries to stay below the per-entry credential blob limit.

This project switches Codex through `auth.json`. If Codex is explicitly
configured with `cli_auth_credentials_store = "keyring"` or `"auto"`, switching
is blocked instead of reporting a false success because those modes may use the
OS credential store and ignore the file. Set it to `"file"` in `config.toml`
before using this project. The `doctor` and GUI status views report this
compatibility.

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

The auth daemon/monitor is safe to run while Codex is active because it only copies a
verified matching `auth.json` into secure storage. It does not replace the live
file. Close the active Codex session before switching profiles; replacing the
file underneath a running session can leave stale credentials in memory or let
that process overwrite the newly selected profile.

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

## Desktop Packaging

The persistent-login requirement is handled by the lightweight background
daemon, so a desktop rewrite is not required. The repository still includes a
zero-dependency local web GUI; an optional future Tauri packaging plan is
documented in [docs/gui-roadmap.md](docs/gui-roadmap.md).
