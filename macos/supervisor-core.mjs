import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  effectiveMobileUrl,
  ensurePrivateDirectories,
  loadEnabledState,
  loadLauncherConfig,
  loadRelayConfig,
  saveConnectionSettings,
  saveEnabledState,
} from "./config.mjs";

const execFileAsync = promisify(execFile);

export const BridgeState = Object.freeze({
  STARTING: "starting",
  ONLINE: "online",
  DEGRADED: "degraded",
  OFFLINE: "offline",
  STOPPED: "stopped",
});

export async function probe(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "CodexBridge.macOS/0.7" },
    });
    const body = await response.text();
    return {
      success: response.status >= 200 && response.status < 400,
      statusCode: response.status,
      body,
      json: parseJson(body),
      error: "",
    };
  } catch (error) {
    return {
      success: false,
      statusCode: 0,
      body: "",
      json: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function buildSnapshot({
  api,
  web,
  relay,
  launcher,
  relayConfig,
  failureCount,
  checkedAt = new Date(),
}) {
  const apiUp = api.success;
  const codexUp = apiUp && api.json.codex === true;
  const webUp = web.success;
  const hostRelayConnected =
    typeof api.json.relayConnected === "boolean" ? api.json.relayConnected : null;
  const relayConfigured =
    typeof api.json.relayConfigured === "boolean"
      ? api.json.relayConfigured
      : relayConfig.configured;
  const relayReachable =
    !relayConfigured || hostRelayConnected === true || relay.success;
  const relayConnected =
    !relayConfigured ||
    (hostRelayConnected ?? (relay.success && relay.json.hostConnected === true));
  const localHealthy = apiUp && codexUp && webUp;

  let state;
  let detail;
  if (localHealthy && relayConnected) {
    state = BridgeState.ONLINE;
    detail = relayConfigured
      ? "电脑、Codex 和公网中继均正常"
      : launcher.listenAddress === "0.0.0.0"
        ? "电脑和 Codex 均正常，当前使用局域网 / Linker / Tailscale"
        : "电脑和 Codex 均正常，当前仅本机连接";
  } else if (localHealthy) {
    state = BridgeState.DEGRADED;
    detail = relayReachable
      ? "本地正常，公网中继正在重连"
      : "本地正常，暂时无法访问公网中继";
  } else {
    const missing = [];
    if (!apiUp) missing.push("Host");
    else if (!codexUp) missing.push("Codex 内核");
    if (!webUp) missing.push("手机网页");
    state = failureCount < 2 ? BridgeState.STARTING : BridgeState.OFFLINE;
    detail = `${failureCount < 2 ? "正在确认" : "异常"}：${missing.join("、")}`;
  }

  return {
    state,
    apiUp,
    codexUp,
    webUp,
    relayReachable,
    relayConnected,
    relayConfigured,
    publicUrl: relayConfigured ? relayConfig.publicUrl : launcher.publicUrl,
    detail,
    checkedAt: checkedAt.toISOString(),
  };
}

async function executeScript(scriptPath, arguments_, projectRoot, timeoutMs) {
  return execFileAsync("/bin/bash", [scriptPath, ...arguments_], {
    cwd: projectRoot,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH: [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(process.env.HOME || "", ".local", "bin"),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    },
  });
}

export class BridgeSupervisor extends EventEmitter {
  constructor(paths, options = {}) {
    super();
    this.paths = paths;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.enabled = true;
    this.localFailureCount = 0;
    this.recoveryDelayMs = 15_000;
    this.lastRecoveryAt = 0;
    this.lastVersionCheckAt = 0;
    this.snapshot = {
      state: BridgeState.STARTING,
      apiUp: false,
      codexUp: false,
      webUp: false,
      relayReachable: true,
      relayConnected: true,
      relayConfigured: false,
      publicUrl: "http://127.0.0.1:43110",
      detail: "正在检查服务…",
      checkedAt: new Date().toISOString(),
    };
    this.running = false;
    this.checking = false;
    this.recovering = false;
    this.timer = null;
    this.lastTickAt = Date.now();
  }

  async start() {
    if (this.running) return;
    await ensurePrivateDirectories(this.paths);
    this.enabled = await loadEnabledState(this.paths);
    this.snapshot.publicUrl = await effectiveMobileUrl(this.paths);
    this.running = true;
    await this.log("supervisor_started", `enabled=${this.enabled}`);
    await this.checkNow();
    this.schedule();
  }

  async close() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    await this.log("supervisor_stopped", "");
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      const now = Date.now();
      const elapsed = now - this.lastTickAt;
      this.lastTickAt = now;
      if (elapsed > this.pollIntervalMs + 20_000 && this.enabled) {
        await this.log("power_resume", `timer gap ${elapsed}ms`);
        this.publishStarting("电脑已唤醒，正在恢复连接…");
      }
      await this.checkNow();
      this.schedule();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  async startBridge() {
    this.enabled = true;
    await saveEnabledState(this.paths, true);
    this.publishStarting("正在启动 Bridge…");
    await this.recover(false, "manual-start", true);
  }

  async stopBridge() {
    this.enabled = false;
    await saveEnabledState(this.paths, false);
    this.publishStarting("正在停止 Bridge…");
    await executeScript(this.paths.stopScript, [], this.paths.projectRoot, 30_000);
    this.localFailureCount = 0;
    this.publish({
      ...this.snapshot,
      state: BridgeState.STOPPED,
      apiUp: false,
      codexUp: false,
      webUp: false,
      publicUrl: await effectiveMobileUrl(this.paths),
      detail: "已由用户停止",
      checkedAt: new Date().toISOString(),
    });
  }

  async restartBridge(reason = "manual-restart") {
    this.enabled = true;
    await saveEnabledState(this.paths, true);
    this.publishStarting("正在重启 Bridge…");
    await this.recover(true, reason, true);
  }

  async updateConnection(input) {
    const result = await saveConnectionSettings(this.paths, input);
    await this.log("connection_configuration_saved", `${result.mode} ${result.mobileUrl}`);
    await this.restartBridge("connection-configuration-changed");
    return result;
  }

  async checkNow() {
    if (this.checking) return this.snapshot;
    this.checking = true;
    try {
      return await this.check();
    } catch (error) {
      await this.log("check_error", error instanceof Error ? error.message : String(error));
      return this.snapshot;
    } finally {
      this.checking = false;
    }
  }

  async check() {
    if (!this.enabled) {
      this.publish({
        ...this.snapshot,
        state: BridgeState.STOPPED,
        apiUp: false,
        codexUp: false,
        webUp: false,
        publicUrl: await effectiveMobileUrl(this.paths),
        detail: "已停止；可从管理页面重新启动",
        checkedAt: new Date().toISOString(),
      });
      return this.snapshot;
    }

    const [launcher, relayConfig] = await Promise.all([
      loadLauncherConfig(this.paths),
      loadRelayConfig(this.paths),
    ]);
    const [api, web] = await Promise.all([
      probe(`http://127.0.0.1:${launcher.apiPort}/api/health`, 3_000),
      probe(`http://127.0.0.1:${launcher.webPort}/`, 3_000),
    ]);
    const hostRelayConnected =
      typeof api.json.relayConnected === "boolean" ? api.json.relayConnected : null;
    const relay =
      relayConfig.configured && hostRelayConnected !== true
        ? await probe(`${relayConfig.publicUrl}/relay/health`, 5_000)
        : { success: false, json: {}, statusCode: 0, body: "", error: "" };

    const localHealthy = api.success && api.json.codex === true && web.success;
    this.localFailureCount = localHealthy ? 0 : this.localFailureCount + 1;
    const previousState = this.snapshot.state;
    const next = buildSnapshot({
      api,
      web,
      relay,
      launcher,
      relayConfig,
      failureCount: this.localFailureCount,
    });
    this.publish(next);

    if (localHealthy) {
      this.recoveryDelayMs = 15_000;
      if (
        [BridgeState.OFFLINE, BridgeState.STARTING].includes(previousState) &&
        next.state === BridgeState.ONLINE
      ) {
        this.emit("notification", {
          title: "Codex Bridge 已恢复",
          message: "电脑端和公网连接已经恢复正常。",
        });
      }
      await this.checkCodexVersion();
    } else if (this.localFailureCount >= 2) {
      const fullRestart = api.success && web.success && api.json.codex !== true;
      await this.recover(
        fullRestart,
        fullRestart ? "codex-offline" : "local-health-failed",
        false,
      );
    }
    return this.snapshot;
  }

  async recover(fullRestart, reason, force) {
    if (!this.enabled || this.recovering) return;
    const now = Date.now();
    if (!force && now - this.lastRecoveryAt < this.recoveryDelayMs) return;
    this.recovering = true;
    this.lastRecoveryAt = now;
    if (!force) this.recoveryDelayMs = Math.min(this.recoveryDelayMs * 2, 300_000);
    await this.log("recovery_started", `${reason}, fullRestart=${fullRestart}`);
    this.publishStarting(
      fullRestart ? "Codex 异常，正在重启 Bridge…" : "服务中断，正在自动拉起…",
    );
    try {
      if (fullRestart)
        await executeScript(this.paths.stopScript, [], this.paths.projectRoot, 30_000);
      await executeScript(
        this.paths.startScript,
        ["--no-browser"],
        this.paths.projectRoot,
        45_000,
      );
      await this.log("recovery_finished", reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.log("recovery_failed", `${reason}: ${message}`);
      this.emit("notification", {
        title: "Codex Bridge 恢复失败",
        message: "请打开 macOS 管理页面查看日志或手动重启。",
      });
    } finally {
      this.recovering = false;
      setTimeout(() => void this.checkNow(), 1_500).unref();
    }
  }

  async checkCodexVersion() {
    if (Date.now() - this.lastVersionCheckAt < 10 * 60_000) return;
    this.lastVersionCheckAt = Date.now();
    const current = await readInstalledCodexVersion();
    if (!current) return;
    const previous = await fs.readFile(this.paths.codexVersion, "utf8").catch(() => "");
    await fs.writeFile(this.paths.codexVersion, `${current}\n`, { mode: 0o600 });
    if (previous.trim() && previous.trim() !== current) {
      await this.log("codex_update_detected", `${previous.trim()} -> ${current}`);
      this.emit("notification", {
        title: "检测到 Codex 更新",
        message: "正在重启 Bridge 以使用新版 Codex 内核。",
      });
      await this.recover(true, "codex-updated", true);
    }
  }

  publishStarting(detail) {
    this.publish({
      ...this.snapshot,
      state: BridgeState.STARTING,
      detail,
      checkedAt: new Date().toISOString(),
    });
  }

  publish(snapshot) {
    this.snapshot = snapshot;
    this.emit("snapshot", snapshot);
  }

  async log(eventName, detail) {
    const safeDetail = String(detail || "").replace(/[\r\n]+/g, " ");
    await fs.appendFile(
      this.paths.supervisorLog,
      `${new Date().toISOString()} ${eventName} ${safeDetail}\n`,
      { encoding: "utf8", mode: 0o600 },
    ).catch(() => undefined);
  }
}

async function readInstalledCodexVersion() {
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Info.plist",
    path.join(process.env.HOME || "", "Applications", "ChatGPT.app", "Contents", "Info.plist"),
    "/Applications/Codex.app/Contents/Info.plist",
    path.join(process.env.HOME || "", "Applications", "Codex.app", "Contents", "Info.plist"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const { stdout } = await execFileAsync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", candidate],
        { timeout: 5_000 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Try another supported application location.
    }
  }
  return "";
}
