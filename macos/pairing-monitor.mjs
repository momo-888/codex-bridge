import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { loadLauncherConfig, readJson } from "./config.mjs";

export class PairingMonitor extends EventEmitter {
  constructor(paths, options = {}) {
    super();
    this.paths = paths;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.prompted = new Set();
    this.timer = null;
    this.running = false;
    this.polling = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(750);
  }

  close() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delay = this.pollIntervalMs) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.poll().catch(() => undefined);
      this.schedule();
    }, delay);
    this.timer.unref();
  }

  async poll() {
    if (this.polling) return [];
    this.polling = true;
    try {
      const requests = await this.list();
      for (const request of requests) {
        if (!request?.id || this.prompted.has(request.id)) continue;
        this.prompted.add(request.id);
        this.emit("request", {
          id: String(request.id),
          deviceName: String(request.deviceName || "Android 设备"),
          remoteAddress: normalizeAddress(String(request.remoteAddress || "未知")),
          userAgent: String(request.userAgent || ""),
          expiresAt: String(request.expiresAt || ""),
        });
      }
      if (this.prompted.size > 256) this.prompted.clear();
      return requests;
    } finally {
      this.polling = false;
    }
  }

  async list() {
    const [launcher, token] = await Promise.all([
      loadLauncherConfig(this.paths),
      this.readHostToken(),
    ]);
    const response = await fetch(
      `http://127.0.0.1:${launcher.apiPort}/api/pair/requests`,
      {
        signal: AbortSignal.timeout(1_200),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "CodexBridge.macOS/0.7",
        },
      },
    );
    if (!response.ok) throw new Error(`读取配对请求失败：HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.data) ? body.data : [];
  }

  async decide(requestId, allow) {
    if (!requestId) throw new Error("配对请求编号不能为空");
    const [launcher, token] = await Promise.all([
      loadLauncherConfig(this.paths),
      this.readHostToken(),
    ]);
    const response = await fetch(
      `http://127.0.0.1:${launcher.apiPort}/api/pair/requests/${encodeURIComponent(requestId)}/decision`,
      {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "CodexBridge.macOS/0.7",
        },
        body: JSON.stringify({ decision: allow ? "approve" : "deny" }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `保存配对决定失败：HTTP ${response.status}`);
    }
    return response.json();
  }

  async readHostToken() {
    await fs.access(this.paths.hostConfig);
    const config = await readJson(this.paths.hostConfig, {});
    const token = typeof config.token === "string" ? config.token : "";
    if (token.length < 20) throw new Error("Host 配对令牌尚未就绪");
    return token;
  }
}

function normalizeAddress(value) {
  return value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
}
