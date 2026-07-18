const dom = {
  activeBadge: document.querySelector("#activeBadge"),
  addForm: document.querySelector("#addForm"),
  addPanel: document.querySelector("#addPanel"),
  addToggleButton: document.querySelector("#addToggleButton"),
  ackButton: document.querySelector("#ackButton"),
  ackCheckbox: document.querySelector("#ackCheckbox"),
  allowRunningCheckbox: document.querySelector("#allowRunningCheckbox"),
  backupButton: document.querySelector("#backupButton"),
  boundaryPanel: document.querySelector("#boundaryPanel"),
  cancelAddButton: document.querySelector("#cancelAddButton"),
  deleteButton: document.querySelector("#deleteButton"),
  editForm: document.querySelector("#editForm"),
  exportButton: document.querySelector("#exportButton"),
  importForm: document.querySelector("#importForm"),
  processBadge: document.querySelector("#processBadge"),
  processList: document.querySelector("#processList"),
  profileList: document.querySelector("#profileList"),
  refreshButton: document.querySelector("#refreshButton"),
  selectedAuthBadge: document.querySelector("#selectedAuthBadge"),
  selectedSummary: document.querySelector("#selectedSummary"),
  selectedTitle: document.querySelector("#selectedTitle"),
  statusGrid: document.querySelector("#statusGrid"),
  switchButton: document.querySelector("#switchButton"),
  syncButton: document.querySelector("#syncButton"),
  toast: document.querySelector("#toast"),
  toolOutput: document.querySelector("#toolOutput"),
  usageBadge: document.querySelector("#usageBadge"),
  usageGrid: document.querySelector("#usageGrid"),
  usageRefreshButton: document.querySelector("#usageRefreshButton"),
  usageUpdated: document.querySelector("#usageUpdated"),
};

const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let guiState = null;
let selectedProfileId = null;
let usageState = null;
let usageInFlight = false;
let usageRequestId = 0;

dom.refreshButton.addEventListener("click", () => loadState());
dom.usageRefreshButton.addEventListener("click", () => loadUsage({ notify: true }));
dom.ackCheckbox.addEventListener("input", () => {
  dom.ackButton.disabled = !dom.ackCheckbox.checked;
});
dom.ackButton.addEventListener("click", () => acknowledgeBoundary());
dom.addToggleButton.addEventListener("click", () => dom.addPanel.classList.remove("hidden"));
dom.cancelAddButton.addEventListener("click", () => {
  dom.addForm.reset();
  dom.addPanel.classList.add("hidden");
});
dom.addForm.addEventListener("submit", (event) => submitAdd(event));
dom.importForm.addEventListener("submit", (event) => submitImport(event));
dom.editForm.addEventListener("submit", (event) => submitEdit(event));
dom.deleteButton.addEventListener("click", () => deleteSelectedProfile());
dom.switchButton.addEventListener("click", () => switchSelectedProfile());
dom.syncButton.addEventListener("click", () => syncActiveAuth());
dom.backupButton.addEventListener("click", () => backupAuth());
dom.exportButton.addEventListener("click", () => exportMetadata());

loadState();
window.setInterval(() => {
  if (!document.hidden) {
    loadUsage({ quiet: true });
  }
}, USAGE_REFRESH_INTERVAL_MS);

async function loadState() {
  try {
    const data = await api("/api/state");
    applyState(data.state);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadUsage(options = {}) {
  const requestId = usageRequestId + 1;
  usageRequestId = requestId;
  usageInFlight = true;
  usageState ||= {
    status: "loading",
    message: "额度信息加载中",
    profileId: guiState?.activeProfileId || null,
    fetchedAt: new Date().toISOString(),
  };
  renderUsage();

  try {
    const data = await api("/api/usage");
    if (requestId !== usageRequestId) {
      return;
    }
    usageState = data.usage;
    if (options.notify) {
      showToast(data.usage.status === "ok" ? "额度信息已更新" : data.usage.message || "额度信息不可用");
    }
  } catch (error) {
    if (requestId !== usageRequestId) {
      return;
    }
    usageState = {
      status: "error",
      message: error.message,
      profileId: guiState?.activeProfileId || null,
      fetchedAt: new Date().toISOString(),
    };
    if (!options.quiet) {
      showToast(error.message, true);
    }
  } finally {
    if (requestId === usageRequestId) {
      usageInFlight = false;
      renderUsage();
    }
  }
}

function applyState(nextState) {
  const previousActiveProfileId = guiState ? guiState.activeProfileId || null : undefined;
  guiState = nextState;
  const profiles = guiState.profiles || [];
  const selectedStillExists = profiles.some((profile) => profile.profile_id === selectedProfileId);
  if (!selectedStillExists) {
    selectedProfileId = guiState.activeProfileId || profiles[0]?.profile_id || null;
  }
  render();
  if ((guiState.activeProfileId || null) !== previousActiveProfileId) {
    usageState = null;
    loadUsage({ quiet: true });
  }
}

function render() {
  const profiles = guiState?.profiles || [];
  const selectedProfile = selectedProfileId
    ? profiles.find((profile) => profile.profile_id === selectedProfileId)
    : null;
  const acknowledged = Boolean(guiState?.policy?.manual_switching_acknowledged_at);
  const activeProfile = profiles.find((profile) => profile.profile_id === guiState?.activeProfileId);

  dom.boundaryPanel.classList.toggle("hidden", acknowledged);
  dom.activeBadge.textContent = activeProfile ? `当前：${activeProfile.profile_id}` : "未切换";
  setBadge(dom.activeBadge, activeProfile ? "good" : "neutral");

  renderProfiles(profiles);
  renderSelected(selectedProfile);
  renderUsage();
  renderStatus();
}

function renderProfiles(profiles) {
  dom.profileList.replaceChildren();
  if (profiles.length === 0) {
    const empty = element("div", "empty-state");
    empty.textContent = "还没有 profile";
    dom.profileList.append(empty);
    return;
  }

  for (const profile of profiles) {
    const button = element("button", "profile-item");
    button.type = "button";
    button.classList.toggle("selected", profile.profile_id === selectedProfileId);
    button.addEventListener("click", () => {
      selectedProfileId = profile.profile_id;
      render();
    });

    const name = element("div", "profile-name");
    const title = element("strong");
    title.textContent = profile.display_name || profile.profile_id;
    const detail = element("span");
    detail.textContent = [profile.profile_id, profile.email].filter(Boolean).join(" · ");
    name.append(title, detail);

    const dot = element("span", "active-dot");
    dot.classList.toggle("on", Boolean(profile.is_active));
    button.append(name, dot);
    dom.profileList.append(button);
  }
}

function renderSelected(profile) {
  const hasAuth = Boolean(profile?.auth_secret_ref);
  const isActive = Boolean(profile && profile.profile_id === guiState.activeProfileId);
  dom.selectedTitle.textContent = profile ? profile.display_name || profile.profile_id : "未选择";
  dom.selectedAuthBadge.textContent = hasAuth ? "auth 已导入" : "auth 未导入";
  setBadge(dom.selectedAuthBadge, hasAuth ? "good" : "warn");
  dom.switchButton.disabled = !profile || !hasAuth || isActive;
  dom.switchButton.innerHTML = isActive
    ? '<span aria-hidden="true">✓</span>当前已启用'
    : '<span aria-hidden="true">⇄</span>切换到此 profile';

  dom.selectedSummary.replaceChildren(
    summaryItem("Profile ID", profile?.profile_id || "-"),
    summaryItem("邮箱", profile?.email || "-"),
    summaryItem("Workspace", profile?.workspace_name || "-"),
    summaryItem("Last Used", formatDate(profile?.last_used_at)),
    summaryItem("登录同步", formatDate(profile?.auth_synced_at)),
    summaryItem("Token 到期", formatDate(profile?.auth_expires_at)),
  );

  setEditFormEnabled(Boolean(profile));
  fillEditForm(profile);
}

function renderStatus() {
  const processes = guiState?.processes || [];
  const authStatus = guiState?.authStatus || {};
  const secureStorage = guiState?.secureStorage || {};
  const doctor = guiState?.doctor || {};
  const authSync = guiState?.authSync || {};

  dom.processBadge.textContent = processes.length === 0 ? "进程空闲" : `${processes.length} 个进程`;
  setBadge(dom.processBadge, processes.length === 0 ? "good" : "warn");

  dom.statusGrid.replaceChildren(
    statusItem("auth.json", authStatus.exists ? `${authStatus.permissions}` : "missing"),
    statusItem("安全存储", secureStorage.available ? secureStorage.backend : "unavailable"),
    statusItem("Codex CLI", doctor.codexCliInstalled ? "found" : "not found"),
    statusItem("Profiles", String(guiState?.profileCount ?? 0)),
    statusItem(
      "后台同步",
      doctor.daemon?.running
        ? doctor.daemon.healthy
          ? `运行中 (${doctor.daemon.pid})`
          : `异常 (${doctor.daemon.pid})`
        : "未运行",
    ),
    statusItem("登录同步", formatAuthSyncStatus(authSync)),
    statusItem("同步检查", formatDate(authSync.checkedAt)),
    statusItem("Codex 目录", guiState?.paths?.codexHome || "-"),
    statusItem("Metadata", guiState?.paths?.metadata || "-"),
    statusItem("config.toml", doctor.configToml?.exists ? "found" : "missing"),
    statusItem("Codex 凭据模式", doctor.credentialStore?.display || "Codex default"),
    statusItem("Node", doctor.node || "-"),
  );

  dom.processList.replaceChildren();
  for (const processInfo of processes) {
    const row = element("div", "process-row");
    row.append(
      textNode("span", processInfo.name || "unknown"),
      textNode("span", String(processInfo.pid || "-")),
      textNode("span", processInfo.command || ""),
    );
    dom.processList.append(row);
  }
}

function renderUsage() {
  const usage = usageState || {
    status: "loading",
    message: "额度信息加载中",
    profileId: guiState?.activeProfileId || null,
    fetchedAt: null,
  };
  const hasActiveProfile = Boolean(guiState?.activeProfileId);

  dom.usageRefreshButton.disabled = usageInFlight || !hasActiveProfile;
  dom.usageRefreshButton.textContent = usageInFlight ? "刷新中" : "刷新额度";

  const badge = usageBadge(usage);
  dom.usageBadge.textContent = badge.text;
  setBadge(dom.usageBadge, badge.kind);

  dom.usageGrid.replaceChildren();
  if (usage.status === "ok") {
    dom.usageGrid.append(
      usageItem("5 小时窗口", formatWindowMain(usage.primary), formatWindowDetail(usage.primary)),
      usageItem("周窗口", formatWindowMain(usage.secondary), formatWindowDetail(usage.secondary)),
      usageItem("Credits", formatCredits(usage.credits), usage.credits ? "来自当前 active profile" : ""),
      usageItem("计划", usage.planType || "-", usage.profileDisplayName || usage.profileId || ""),
    );
  } else {
    dom.usageGrid.append(
      usageItem("当前 profile", usage.profileDisplayName || usage.profileId || guiState?.activeProfileId || "-"),
      usageItem("状态", usage.message || "等待刷新"),
      usageItem("刷新间隔", "5 分钟", "仅在 GUI 打开时刷新当前 active profile"),
      usageItem("来源", "ChatGPT usage", "不会合并多个 profile 的额度"),
    );
  }

  dom.usageUpdated.textContent = usage.fetchedAt
    ? `上次刷新：${formatDate(usage.fetchedAt)}`
    : "等待刷新";
}

async function acknowledgeBoundary() {
  await runAction(dom.ackButton, "确认中", async () => {
    const data = await api("/api/acknowledge", { method: "POST", body: {} });
    applyState(data.state);
    showToast("已确认手动切换边界");
  });
}

async function submitAdd(event) {
  event.preventDefault();
  const body = formBody(dom.addForm);
  await runAction(dom.addForm.querySelector("button[type='submit']"), "保存中", async () => {
    const data = await api("/api/profiles", { method: "POST", body });
    selectedProfileId = data.profile.profile_id;
    dom.addForm.reset();
    dom.addPanel.classList.add("hidden");
    applyState(data.state);
    showToast("Profile 已保存");
  });
}

async function submitImport(event) {
  event.preventDefault();
  const submitButton = dom.importForm.querySelector("button[type='submit']");
  await runAction(submitButton, "导入中", async () => {
    const formData = new FormData(dom.importForm);
    const file = formData.get("authFile");
    if (!file || typeof file.text !== "function") {
      throw new Error("请选择 auth.json");
    }

    const body = formBody(dom.importForm);
    body.authJson = await file.text();
    body.useAfterImport = Boolean(formData.get("useAfterImport"));
    delete body.authFile;

    const data = await api("/api/import-auth", { method: "POST", body });
    selectedProfileId = data.profile.profile_id;
    dom.importForm.reset();
    applyState(data.state);
    showToast(data.switchResult ? "已导入并切换" : "auth.json 已导入");
  });
}

async function submitEdit(event) {
  event.preventDefault();
  const profile = selectedProfile();
  if (!profile) {
    return;
  }

  await runAction(dom.editForm.querySelector("button[type='submit']"), "保存中", async () => {
    const data = await api(`/api/profiles/${encodeURIComponent(profile.profile_id)}`, {
      method: "PATCH",
      body: formBody(dom.editForm),
    });
    selectedProfileId = data.profile.profile_id;
    applyState(data.state);
    showToast("Profile 信息已更新");
  });
}

async function switchSelectedProfile() {
  const profile = selectedProfile();
  if (!profile) {
    return;
  }

  await runAction(dom.switchButton, "切换中", async () => {
    const data = await api(`/api/profiles/${encodeURIComponent(profile.profile_id)}/use`, {
      method: "POST",
      body: {
        allowRunning: dom.allowRunningCheckbox.checked,
      },
    });
    applyState(data.state);
    showToast(`已切换到 ${profile.profile_id}`);
  });
}

async function deleteSelectedProfile() {
  const profile = selectedProfile();
  if (!profile) {
    return;
  }

  const confirmed = window.confirm(`删除 profile "${profile.profile_id}"？`);
  if (!confirmed) {
    return;
  }

  await runAction(dom.deleteButton, "删除中", async () => {
    const data = await api(`/api/profiles/${encodeURIComponent(profile.profile_id)}`, {
      method: "DELETE",
    });
    selectedProfileId = null;
    applyState(data.state);
    showToast("Profile 已删除");
  });
}

async function backupAuth() {
  await runAction(dom.backupButton, "备份中", async () => {
    const data = await api("/api/backup", { method: "POST", body: {} });
    applyState(data.state);
    dom.toolOutput.textContent = data.backupPath ? `Backup: ${data.backupPath}` : "没有可备份的 auth.json";
    showToast("备份完成");
  });
}

async function syncActiveAuth() {
  await runAction(dom.syncButton, "同步中", async () => {
    const data = await api("/api/sync-active", { method: "POST", body: {} });
    applyState(data.state);
    dom.toolOutput.textContent = data.authSync.message || "登录信息同步完成";
    showToast(data.authSync.status === "synced" ? "新的登录信息已安全保存" : data.authSync.message);
  });
}

async function exportMetadata() {
  await runAction(dom.exportButton, "导出中", async () => {
    const data = await api("/api/export", { method: "POST", body: {} });
    applyState(data.state);
    dom.toolOutput.textContent = `Metadata: ${data.outputPath}`;
    showToast("Metadata 已导出");
  });
}

function selectedProfile() {
  return (guiState?.profiles || []).find((profile) => profile.profile_id === selectedProfileId);
}

function fillEditForm(profile) {
  dom.editForm.elements.displayName.value = profile?.display_name || "";
  dom.editForm.elements.email.value = profile?.email || "";
  dom.editForm.elements.workspaceName.value = profile?.workspace_name || "";
  dom.editForm.elements.planType.value = profile?.plan_type || "";
  dom.editForm.elements.tags.value = (profile?.tags || []).join(", ");
  dom.editForm.elements.notes.value = profile?.notes || "";
}

function setEditFormEnabled(enabled) {
  for (const field of dom.editForm.elements) {
    field.disabled = !enabled;
  }
  dom.deleteButton.disabled = !enabled;
}

function formBody(form) {
  const data = new FormData(form);
  const body = {};
  for (const [key, value] of data.entries()) {
    if (value instanceof File) {
      body[key] = value;
      continue;
    }
    body[key] = String(value).trim();
  }
  return body;
}

async function runAction(button, busyText, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await action();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
    render();
  }
}

async function api(path, options = {}) {
  const fetchOptions = {
    method: options.method || "GET",
    headers: {},
  };
  if (options.body !== undefined) {
    fetchOptions.headers["content-type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, fetchOptions);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function showToast(message, error = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle("error", error);
  dom.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    dom.toast.classList.add("hidden");
  }, 4500);
}

function summaryItem(label, value) {
  const item = element("div", "summary-item");
  item.append(textNode("span", label), textNode("strong", value || "-"));
  return item;
}

function statusItem(label, value) {
  const item = element("div", "status-item");
  item.append(textNode("span", label), textNode("strong", value || "-"));
  return item;
}

function usageItem(label, value, detail = "") {
  const item = element("div", "usage-item");
  item.append(textNode("span", label), textNode("strong", value || "-"));
  if (detail) {
    item.append(textNode("small", detail));
  }
  return item;
}

function usageBadge(usage) {
  if (usageInFlight) {
    return { text: "刷新中", kind: "neutral" };
  }

  switch (usage.status) {
    case "ok":
      return { text: "已更新", kind: "good" };
    case "inactive":
      return { text: "未切换", kind: "neutral" };
    case "unavailable":
      return { text: "不可用", kind: "warn" };
    case "error":
      return { text: "获取失败", kind: "bad" };
    default:
      return { text: "未加载", kind: "neutral" };
  }
}

function formatWindowMain(windowInfo) {
  if (!windowInfo || windowInfo.usedPercent === null) {
    return "-";
  }
  return `${formatPercent(windowInfo.usedPercent)} 已用`;
}

function formatWindowDetail(windowInfo) {
  if (!windowInfo) {
    return "";
  }

  const details = [];
  if (windowInfo.remainingPercent !== null) {
    details.push(`剩余 ${formatPercent(windowInfo.remainingPercent)}`);
  }
  if (windowInfo.windowMinutes !== null) {
    details.push(`${windowInfo.windowMinutes} 分钟窗口`);
  }
  if (windowInfo.resetsAt) {
    details.push(`重置 ${formatDate(windowInfo.resetsAt)}`);
  }
  return details.join(" · ");
}

function formatCredits(credits) {
  if (!credits) {
    return "-";
  }
  if (credits.unlimited) {
    return "无限";
  }
  if (credits.hasCredits === false) {
    return "无";
  }
  return credits.balance || "有";
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  const number = Number(value);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function setBadge(node, kind) {
  node.classList.remove("neutral", "good", "warn", "bad");
  node.classList.add(kind);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatAuthSyncStatus(authSync) {
  const labels = {
    starting: "启动中",
    synced: "已保存更新",
    current: "已是最新",
    inactive: "无 active profile",
    missing: "auth.json 缺失",
    unavailable: "不可同步",
    "identity-mismatch": "账号不匹配",
    incompatible: "keyring/auto 模式不兼容",
    error: "同步失败",
  };
  return labels[authSync?.status] || authSync?.status || "未启动";
}

function element(tagName, className = "") {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}

function textNode(tagName, text) {
  const node = document.createElement(tagName);
  node.textContent = text;
  return node;
}
