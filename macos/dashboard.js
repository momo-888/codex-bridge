const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let latestStatus = null;
let configurationLoaded = false;
let toastTimer = null;

const stateLabels = {
  starting: "正在启动/检查",
  online: "运行正常",
  degraded: "部分连接异常",
  offline: "服务离线",
  stopped: "已停止",
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `HTTP ${response.status}`);
  return body;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2_500);
}

function setHealth(name, healthy, normal = "正常", abnormal = "异常") {
  $(`#${name}Dot`).className = `dot ${healthy ? "ok" : "bad"}`;
  $(`#${name}Text`).textContent = healthy ? normal : abnormal;
}

function renderStatus(status) {
  latestStatus = status;
  const snapshot = status.snapshot;
  const badge = $("#stateBadge");
  badge.className = `state ${snapshot.state}`;
  badge.innerHTML = `<span></span>${stateLabels[snapshot.state] || snapshot.state}`;
  $("#detail").textContent = snapshot.detail;
  $("#checkedAt").textContent = `检查时间：${new Date(snapshot.checkedAt).toLocaleString()}`;
  $("#mobileUrl").textContent = snapshot.publicUrl || "—";
  setHealth("api", snapshot.apiUp);
  setHealth("codex", snapshot.codexUp);
  setHealth("web", snapshot.webUp);
  if (!snapshot.relayConfigured) {
    $("#relayDot").className = "dot";
    $("#relayText").textContent = "未启用（直连）";
  } else {
    $("#relayDot").className = `dot ${snapshot.relayConnected ? "ok" : "warn"}`;
    $("#relayText").textContent = snapshot.relayConnected
      ? "已连接"
      : snapshot.relayReachable
        ? "正在重连"
        : "不可达";
  }
  $("#startupState").textContent = status.loginItemEnabled
    ? "已安装为当前用户的登录启动项"
    : "未安装登录启动项；运行 scripts/install-macos.sh 可启用";

  $('[data-action="start"]').disabled = !["stopped", "offline"].includes(snapshot.state) || status.busy;
  $('[data-action="stop"]').disabled = snapshot.state === "stopped" || status.busy;
  $('[data-action="restart"]').disabled = snapshot.state === "stopped" || status.busy;
}

async function refreshStatus() {
  try {
    renderStatus(await request("/api/status"));
  } catch (error) {
    $("#detail").textContent = `无法连接管理服务：${error.message}`;
  }
}

function modeChanged() {
  const mode = $('input[name="mode"]:checked')?.value;
  $("#networkFields").classList.toggle("hidden", mode !== "network");
  $("#relayFields").classList.toggle("hidden", mode !== "relay");
  const address = $("#networkAddress").value;
  const port = latestStatus?.configuration?.launcher?.apiPort || 43110;
  $("#networkPreview").textContent = address
    ? `手机地址：http://${address}:${port}。只建议通过可信私有网络访问。`
    : "没有找到可用的 IPv4 地址。";
}

async function loadConfiguration(force = false) {
  if (configurationLoaded && !force) return;
  const value = await request("/api/configuration");
  latestStatus = { ...(latestStatus || {}), configuration: value };
  const addressSelect = $("#networkAddress");
  addressSelect.replaceChildren(
    ...value.addresses.map((item) => {
      const option = document.createElement("option");
      option.value = item.address;
      option.textContent = `${item.address} — ${item.name}`;
      return option;
    }),
  );
  const currentHost = (() => {
    try { return new URL(value.launcher.publicUrl).hostname; } catch { return ""; }
  })();
  if (value.addresses.some((item) => item.address === currentHost)) addressSelect.value = currentHost;
  const mode = value.relay.configured
    ? "relay"
    : value.launcher.listenAddress === "0.0.0.0"
      ? "network"
      : "local";
  const radio = $(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  $("#relayUrl").value = value.relay.publicUrl || "";
  $("#hostToken").value = value.relay.hostToken || "";
  $("#phoneToken").value = value.relay.phoneToken || "";
  configurationLoaded = true;
  modeChanged();
}

async function bridgeAction(action) {
  $$('[data-action="start"], [data-action="stop"], [data-action="restart"]').forEach((button) => {
    button.disabled = true;
  });
  try {
    await request(`/api/bridge/${action}`, { method: "POST" });
    toast(action === "stop" ? "Bridge 已停止" : "操作已完成");
  } catch (error) {
    toast(error.message);
  } finally {
    await refreshStatus();
  }
}

async function saveConfiguration(event) {
  event.preventDefault();
  const mode = $('input[name="mode"]:checked')?.value;
  const payload = {
    mode,
    address: $("#networkAddress").value,
    relayPublicUrl: $("#relayUrl").value,
    hostToken: $("#hostToken").value,
    phoneToken: $("#phoneToken").value,
  };
  const output = $("#saveResult");
  output.textContent = "正在保存并重启…";
  try {
    const result = await request("/api/configuration", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    output.textContent = `已保存：${result.mobileUrl}`;
    await navigator.clipboard.writeText(result.mobileUrl).catch(() => undefined);
    toast("连接地址已复制");
    configurationLoaded = false;
    await Promise.all([refreshStatus(), loadConfiguration(true)]);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function refreshPairing() {
  const container = $("#pairingList");
  try {
    const value = await request("/api/pairing");
    if (!value.data.length) {
      container.className = "empty";
      container.textContent = "当前没有待处理请求。";
      return;
    }
    container.className = "";
    container.replaceChildren(
      ...value.data.map((item) => {
        const row = document.createElement("div");
        row.className = "pair-request";
        const details = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.deviceName || "Android 设备";
        const address = document.createElement("p");
        address.textContent = `来源 IP：${String(item.remoteAddress || "未知").replace(/^::ffff:/i, "")}`;
        details.append(title, address);
        const actions = document.createElement("div");
        actions.className = "inline-actions";
        for (const [decision, label, className] of [
          ["deny", "拒绝", "quiet"],
          ["approve", "允许", "primary"],
        ]) {
          const button = document.createElement("button");
          button.className = className;
          button.textContent = label;
          button.addEventListener("click", () => decidePairing(item.id, decision));
          actions.append(button);
        }
        row.append(details, actions);
        return row;
      }),
    );
  } catch {
    container.className = "empty";
    container.textContent = "Host 尚未就绪，暂时无法读取配对请求。";
  }
}

async function decidePairing(id, decision) {
  try {
    await request(`/api/pairing/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    toast(decision === "approve" ? "设备已允许" : "请求已拒绝");
    await refreshPairing();
  } catch (error) {
    toast(error.message);
  }
}

async function refreshLog() {
  const output = $("#logOutput");
  output.textContent = "正在读取…";
  try {
    const value = await request(`/api/logs/${encodeURIComponent($("#logName").value)}`);
    output.textContent = value.content || "日志文件为空。";
    output.scrollTop = output.scrollHeight;
  } catch (error) {
    output.textContent = error.message;
  }
}

async function openTarget(target) {
  try {
    await request("/api/open", { method: "POST", body: JSON.stringify({ target }) });
  } catch (error) {
    toast(error.message);
  }
}

async function testRelay() {
  const output = $("#relayTestResult");
  output.textContent = "正在连接服务器…";
  try {
    const value = await request("/api/relay/test", {
      method: "POST",
      body: JSON.stringify({ publicUrl: $("#relayUrl").value }),
    });
    output.textContent = `服务器可访问（HTTP ${value.statusCode}）`;
  } catch (error) {
    output.textContent = `连接失败：${error.message}`;
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (["start", "stop", "restart"].includes(action)) await bridgeAction(action);
  else if (action === "check") {
    await request("/api/bridge/check", { method: "POST" }).catch(() => undefined);
    await refreshStatus();
  } else if (action === "copy-url") {
    await navigator.clipboard.writeText(latestStatus?.snapshot?.publicUrl || "");
    toast("连接地址已复制");
  } else if (action === "open-mobile") await openTarget("mobile");
  else if (action === "open-setup") await openTarget("setup");
  else if (action === "open-logs") await openTarget("logs");
  else if (action === "refresh-pairing") await refreshPairing();
  else if (action === "refresh-log") await refreshLog();
  else if (action === "test-relay") await testRelay();
});

$("#connectionForm").addEventListener("submit", saveConfiguration);
$$('input[name="mode"]').forEach((input) => input.addEventListener("change", modeChanged));
$("#networkAddress").addEventListener("change", modeChanged);
$("#logName").addEventListener("change", refreshLog);

await Promise.all([refreshStatus(), loadConfiguration(), refreshPairing()]);
await refreshLog();
setInterval(refreshStatus, 2_500);
setInterval(refreshPairing, 4_000);
