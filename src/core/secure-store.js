import path from "node:path";
import { testSecureStorePath } from "./paths.js";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "./fs-utils.js";
import { commandExists, execFileText, spawnWithInput } from "./command.js";
import { AppError } from "./errors.js";

const SERVICE = "codex-profile-switcher";

export class SecureStore {
  constructor(env = process.env) {
    this.env = env;
  }

  async backendName() {
    if (this.env.CODEX_PROFILE_TEST_STORE === "1") {
      return "test-store";
    }
    if (process.platform === "darwin") {
      return "macOS Keychain";
    }
    if (process.platform === "win32") {
      return "Windows Credential Manager";
    }
    return "Secret Service";
  }

  async available() {
    if (this.env.CODEX_PROFILE_TEST_STORE === "1") {
      return true;
    }
    if (process.platform === "darwin") {
      return commandExists("security");
    }
    if (process.platform === "win32") {
      return (await commandExists("powershell.exe")) || (await commandExists("pwsh"));
    }
    return commandExists("secret-tool");
  }

  async assertAvailable() {
    if (await this.available()) {
      return;
    }

    throw new AppError(
      "SECURE_STORE_UNAVAILABLE",
      "No supported secure storage is available. Install or enable macOS Keychain, Windows Credential Manager, or Linux Secret Service secret-tool.",
    );
  }

  async set(profileId, secret) {
    await this.assertAvailable();

    if (this.env.CODEX_PROFILE_TEST_STORE === "1") {
      await writeTestSecret(this.env, profileId, secret);
      return;
    }
    if (process.platform === "darwin") {
      await execFileText("security", [
        "add-generic-password",
        "-a",
        profileId,
        "-s",
        SERVICE,
        "-w",
        secret,
        "-U",
      ]);
      return;
    }
    if (process.platform === "win32") {
      await runWindowsCredentialCommand("set", profileId, secret);
      return;
    }

    await spawnWithInput(
      "secret-tool",
      [
        "store",
        "--label",
        `Codex Profile ${profileId}`,
        "application",
        SERVICE,
        "profile",
        profileId,
        "kind",
        "auth",
      ],
      secret,
    );
  }

  async get(profileId) {
    await this.assertAvailable();

    if (this.env.CODEX_PROFILE_TEST_STORE === "1") {
      const secrets = await readJson(testSecureStorePath(this.env), {});
      if (!(profileId in secrets)) {
        throw new AppError("SECURE_SECRET_NOT_FOUND", `No auth secret stored for "${profileId}".`);
      }
      return secrets[profileId];
    }
    if (process.platform === "darwin") {
      return execFileText("security", [
        "find-generic-password",
        "-a",
        profileId,
        "-s",
        SERVICE,
        "-w",
      ]);
    }
    if (process.platform === "win32") {
      return runWindowsCredentialCommand("get", profileId);
    }

    return spawnWithInput(
      "secret-tool",
      ["lookup", "application", SERVICE, "profile", profileId, "kind", "auth"],
      "",
    );
  }

  async delete(profileId) {
    await this.assertAvailable();

    if (this.env.CODEX_PROFILE_TEST_STORE === "1") {
      const storePath = testSecureStorePath(this.env);
      const secrets = await readJson(storePath, {});
      delete secrets[profileId];
      await writeJsonAtomic(storePath, secrets, 0o600);
      return;
    }
    if (process.platform === "darwin") {
      try {
        await execFileText("security", [
          "delete-generic-password",
          "-a",
          profileId,
          "-s",
          SERVICE,
        ]);
      } catch {
        // Already absent is fine for profile removal.
      }
      return;
    }
    if (process.platform === "win32") {
      try {
        await runWindowsCredentialCommand("delete", profileId);
      } catch {
        // Already absent is fine for profile removal.
      }
      return;
    }

    try {
      await execFileText("secret-tool", [
        "clear",
        "application",
        SERVICE,
        "profile",
        profileId,
        "kind",
        "auth",
      ]);
    } catch {
      // Already absent is fine for profile removal.
    }
  }
}

async function writeTestSecret(env, profileId, secret) {
  const storePath = testSecureStorePath(env);
  await ensureDir(path.dirname(storePath));
  const secrets = (await pathExists(storePath)) ? await readJson(storePath, {}) : {};
  secrets[profileId] = secret;
  await writeJsonAtomic(storePath, secrets, 0o600);
}

async function runWindowsCredentialCommand(action, profileId, secret = "") {
  const shell = (await commandExists("powershell.exe")) ? "powershell.exe" : "pwsh";
  const target = `${SERVICE}:${profileId}:auth`;
  const script = windowsCredentialScript(action, target, secret);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileText(shell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ]);
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsCredentialScript(action, target, secret) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class CredMan {
  public const UInt32 CRED_TYPE_GENERIC = 1;
  public const UInt32 CRED_PERSIST_LOCAL_MACHINE = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, UInt32 flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
}
"@

$target = ${psSingleQuote(target)}
$action = ${psSingleQuote(action)}

if ($action -eq 'set') {
  $secret = ${psSingleQuote(secret)}
  $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  try {
    $cred = New-Object CredMan+CREDENTIAL
    $cred.Type = [CredMan]::CRED_TYPE_GENERIC
    $cred.TargetName = $target
    $cred.UserName = [Environment]::UserName
    $cred.CredentialBlobSize = $bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = [CredMan]::CRED_PERSIST_LOCAL_MACHINE
    if (-not [CredMan]::CredWrite([ref] $cred, 0)) {
      throw "CredWrite failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
  exit 0
}

if ($action -eq 'get') {
  $ptr = [IntPtr]::Zero
  if (-not [CredMan]::CredRead($target, [CredMan]::CRED_TYPE_GENERIC, 0, [ref] $ptr)) {
    throw "CredRead failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredMan+CREDENTIAL])
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
    [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
  } finally {
    [CredMan]::CredFree($ptr)
  }
  exit 0
}

if ($action -eq 'delete') {
  if (-not [CredMan]::CredDelete($target, [CredMan]::CRED_TYPE_GENERIC, 0)) {
    throw "CredDelete failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  exit 0
}

throw "Unknown credential action"
`;
}
