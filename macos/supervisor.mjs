#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  bridgePaths,
  effectiveMobileUrl,
  loadLauncherConfig,
  loadRelayConfig,
  normalizeSiteUrl,
} from "./config.mjs";
import { PairingMonitor } from "./pairing-monitor.mjs";
import { BridgeSupervisor, probe } from "./supervisor-core.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = resolveProjectRoot(process.argv.slice(2));
const paths = bridgePaths(projectRoot);
const managerPort = validPort(process.env.CODEX_BRIDGE_MANAGER_PORT, 43109);
const noBrowser = process.argv.includes("--no-browser");
const supervisor = new BridgeSupervisor(paths);
const pairing = new PairingMonitor(paths);
const promptedDialogs = new Set();
const loginItemPath = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.codexbridge.macos.plist",
);

function resolveProjectRoot(arguments_) {
  const index = arguments_.indexOf("--project-root");
  if (index >= 0 && arguments_[index + 1]) return path.resolve(arguments_[index + 1]);
  return path.resolve(moduleDirectory, "..");
}

function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function isLoopback(request) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.endsWith("::ffff:127.0.0.1");
}

function validManagerHost(request) {
  const host = String(request.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${managerPort}` || host === `localhost:${managerPort}`;
}

function validMutationOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${managerPort}` || origin === `http://localhost:${managerPort}`;
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function sendJson(response, status, value) {
  setSecurityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function sendFile(response, filePath, contentType) {
  setSecurityHeaders(response);
  response.writeHead(200, { "Content-Type": contentType });
  response.end(await fs.readFile(filePath));
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1_000_000) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求不是有效 JSON");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function networkAddresses() {
  const result = [];
  const seen = new Set();
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (
        address.family !== "IPv4" ||
        address.internal ||
        address.address.startsWith("169.254.") ||
        seen.has(address.address)
      ) continue;
      seen.add(address.address);
      result.push({ name, address: address.address });
    }
  }
  return result;
}

async function configurationPayload() {
  const [launcher, relay] = await Promise.all([
    loadLauncherConfig(paths),
    loadRelayConfig(paths),
  ]);
  return { launcher, relay, addresses: networkAddresses() };
}

const logFiles = Object.freeze({
  supervisor: paths.supervisorLog,
  "host-out": path.join(paths.logsDirectory, "host.out.log"),
  "host-error": path.join(paths.logsDirectory, "host.err.log"),
  "web-out": path.join(paths.logsDirectory, "web.out.log"),
  "web-error": path.join(paths.logsDirectory, "web.err.log"),
  bridge: path.join(paths.configDirectory, "bridge.jsonl"),
});

async function readLog(name) {
  const filePath = logFiles[name];
  if (!filePath) throw new HttpError(404, "未知日志文件");
  const value = await fs.readFile(filePath).catch(() => Buffer.alloc(0));
  return value.subarray(Math.max(0, value.length - 256 * 1024)).toString("utf8");
}

async function openTarget(target) {
  let destination;
  if (target === "mobile") destination = await effectiveMobileUrl(paths);
  else if (target === "setup") {
    const launcher = await loadLauncherConfig(paths);
    destination = `http://127.0.0.1:${launcher.apiPort}/setup`;
  } else if (target === "logs") destination = paths.logsDirectory;
  else throw new HttpError(400, "不支持的打开目标");
  await execFileAsync("/usr/bin/open", [destination], { timeout: 10_000 });
}

async function showNotification(title, message) {
  await execFileAsync(
    "/usr/bin/osascript",
    [path.join(moduleDirectory, "notification.applescript"), title, message],
    { timeout: 10_000 },
  ).catch(() => undefined);
}

async function promptPairing(request) {
  if (promptedDialogs.has(request.id)) return;
  promptedDialogs.add(request.id);
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      [
        path.join(moduleDirectory, "pairing-dialog.applescript"),
        request.deviceName || "Android 设备",
        request.remoteAddress || "未知",
      ],
      { timeout: 120_000 },
    );
    const allow = stdout.trim() === "允许";
    await pairing.decide(request.id, allow);
    await showNotification(
      allow ? "设备已连接" : "已拒绝连接",
      request.deviceName || "Android 设备",
    );
  } catch (error) {
    await supervisor.log(
      "pairing_prompt_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

supervisor.on("notification", ({ title, message }) => void showNotification(title, message));
pairing.on("request", (request) => {
  void supervisor.log(
    "pairing_request_detected",
    `${request.id} ${request.deviceName} ${request.remoteAddress}`,
  );
  void promptPairing(request);
});

const server = http.createServer(async (request, response) => {
  if (!isLoopback(request) || !validManagerHost(request)) {
    sendJson(response, 403, { error: "macOS 管理页面只允许从本机访问" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD" && !validMutationOrigin(request)) {
    sendJson(response, 403, { error: "拒绝来自其他网页的管理请求" });
    return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      await sendFile(response, path.join(moduleDirectory, "dashboard.html"), "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard.css") {
      await sendFile(response, path.join(moduleDirectory, "dashboard.css"), "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/dashboard.js") {
      await sendFile(response, path.join(moduleDirectory, "dashboard.js"), "text/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, {
        snapshot: supervisor.snapshot,
        enabled: supervisor.enabled,
        busy: supervisor.recovering,
        loginItemEnabled: await fs.access(loginItemPath).then(() => true).catch(() => false),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/configuration") {
      sendJson(response, 200, await configurationPayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/configuration") {
      const result = await supervisor.updateConnection(await readJsonBody(request));
      sendJson(response, 200, result);
      return;
    }
    const bridgeAction = url.pathname.match(/^\/api\/bridge\/(start|stop|restart|check)$/);
    if (request.method === "POST" && bridgeAction) {
      if (bridgeAction[1] === "start") await supervisor.startBridge();
      else if (bridgeAction[1] === "stop") await supervisor.stopBridge();
      else if (bridgeAction[1] === "restart") await supervisor.restartBridge();
      else await supervisor.checkNow();
      sendJson(response, 200, { ok: true, snapshot: supervisor.snapshot });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/relay/test") {
      const body = await readJsonBody(request);
      const publicUrl = normalizeSiteUrl(body.publicUrl, { relay: true });
      const result = await probe(`${publicUrl}/relay/health`, 7_000);
      if (!result.success)
        throw new HttpError(502, result.error || `中继返回 HTTP ${result.statusCode}`);
      sendJson(response, 200, { ok: true, statusCode: result.statusCode });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/pairing") {
      sendJson(response, 200, { data: await pairing.list() });
      return;
    }
    const pairingDecision = url.pathname.match(/^\/api\/pairing\/([^/]+)$/);
    if (request.method === "POST" && pairingDecision) {
      const body = await readJsonBody(request);
      if (body.decision !== "approve" && body.decision !== "deny")
        throw new HttpError(400, "请选择允许或拒绝");
      sendJson(
        response,
        200,
        await pairing.decide(decodeURIComponent(pairingDecision[1]), body.decision === "approve"),
      );
      return;
    }
    const logRoute = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
    if (request.method === "GET" && logRoute) {
      sendJson(response, 200, { content: await readLog(decodeURIComponent(logRoute[1])) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/open") {
      const body = await readJsonBody(request);
      await openTarget(body.target);
      sendJson(response, 200, { ok: true });
      return;
    }
    throw new HttpError(404, "页面或接口不存在");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    await supervisor.log("manager_request_error", `${request.method} ${url.pathname}: ${message}`);
    sendJson(response, status, { error: message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    if (!noBrowser)
      void execFileAsync("/usr/bin/open", [`http://127.0.0.1:${managerPort}/`]).catch(() => undefined);
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});

server.listen(managerPort, "127.0.0.1", async () => {
  await fs.mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.supervisorPid, `${process.pid}\n`, { mode: 0o600 });
  await supervisor.start();
  pairing.start();
  console.log(`Codex Bridge macOS manager: http://127.0.0.1:${managerPort}/`);
  if (!noBrowser)
    await execFileAsync("/usr/bin/open", [`http://127.0.0.1:${managerPort}/`]).catch(() => undefined);
});

async function shutdown() {
  pairing.close();
  await supervisor.close();
  await fs.rm(paths.supervisorPid, { force: true }).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
