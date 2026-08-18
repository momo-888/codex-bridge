import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import { CodexBridge, type ThreadGoalStatus } from "./bridge";
import { createFolder, FolderCreationError } from "./folders";
import { bridgeLogPath, logBridgeEvent } from "./logger";
import { compactThreadDetail } from "./mobile-adapter";
import { RelayConnector } from "./relay-connector";
import { GeneratedImageError, GeneratedImageStore, type GeneratedImageAsset } from "./generated-images";
import { RunConfigurationError, type RunConfiguration } from "./run-options";
import { UserAttachmentError, UserAttachmentStore } from "./user-attachments";
import { PairingRequestError, PairingRequestStore } from "./pairing";
import {
  ContextReferenceError,
  resolveContextReferences,
  type ContextReferenceInput,
} from "./context-references";

type BridgeConfig = {
  token: string;
  port: number;
  listenAddress: string;
  publicApiUrl: string;
  webUrl: string;
};

type RequestTrace = {
  at: string;
  remoteAddress: string;
  method: string;
  path: string;
  origin: string | null;
  userAgent: string | null;
  privateNetworkPreflight: string | null;
};

const recentRequests: RequestTrace[] = [];
const eventTickets = new Map<string, number>();
const pairingCodes = new Map<string, { server: string; token: string; expiresAt: number }>();
const pairingRequests = new PairingRequestStore();

const configDir = path.join(os.homedir(), ".codex-bridge");
const configPath = path.join(configDir, "config.json");

async function loadConfig(): Promise<BridgeConfig> {
  let saved: Partial<BridgeConfig> = {};
  try {
    saved = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    saved = {};
  }

  const port = Number(process.env.CODEX_BRIDGE_PORT || saved.port || 43110);
  const listenAddress = process.env.CODEX_BRIDGE_HOST || saved.listenAddress || "127.0.0.1";
  const publicApiUrl =
    process.env.CODEX_BRIDGE_PUBLIC_URL || saved.publicApiUrl || `http://127.0.0.1:${port}`;
  const webUrl = process.env.CODEX_BRIDGE_WEB_URL || saved.webUrl || "http://127.0.0.1:3000";
  const config: BridgeConfig = {
    token: saved.token || randomBytes(32).toString("base64url"),
    port,
    listenAddress,
    publicApiUrl,
    webUrl,
  };
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  return config;
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, payload: unknown) {
  setCors(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function image(response: ServerResponse, asset: GeneratedImageAsset) {
  setCors(response);
  response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  response.setHeader(
    "Vary",
    "Authorization, Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`);
  response.writeHead(200, {
    "Content-Type": asset.mimeType,
    "Content-Length": asset.bytes.length,
  });
  response.end(asset.bytes);
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readImageBody(request: IncomingMessage) {
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
  if (!contentType.startsWith("image/")) throw new UserAttachmentError("请选择图片文件", 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 12_000_000) throw new UserAttachmentError("图片过大，请选择 12 MB 以内的图片", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isLoopback(request: IncomingMessage) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.endsWith("::ffff:127.0.0.1");
}

function tokenMatches(candidate: string | null | undefined, expected: string) {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage, url: URL, token: string) {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return tokenMatches(bearer || url.searchParams.get("token"), token);
}

function proxyWeb(request: IncomingMessage, response: ServerResponse) {
  const target = new URL(process.env.CODEX_BRIDGE_WEB_INTERNAL_URL || "http://127.0.0.1:3000");
  const headers = { ...request.headers, host: target.host };
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: request.url || "/",
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      if ((request.url || "").split("?", 1)[0].toLowerCase().endsWith(".apk")) {
        responseHeaders["content-type"] = "application/vnd.android.package-archive";
        responseHeaders["content-disposition"] = 'attachment; filename="CodexBridge.apk"';
      }
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) json(response, 502, { error: `Mobile web service is unavailable: ${error.message}` });
    else response.destroy(error);
  });
  request.pipe(upstream);
}

async function setupPage(config: BridgeConfig, relayPair?: { server: string; token: string }) {
  const now = Date.now();
  for (const [code, grant] of pairingCodes) {
    if (grant.expiresAt <= now) pairingCodes.delete(code);
  }
  if (pairingCodes.size >= 64) pairingCodes.delete(pairingCodes.keys().next().value as string);
  const pairServer = relayPair?.server || config.publicApiUrl;
  const pairToken = relayPair?.token || config.token;
  const pairCode = randomBytes(24).toString("base64url");
  pairingCodes.set(pairCode, { server: pairServer, token: pairToken, expiresAt: Date.now() + 5 * 60_000 });
  const pairing = Buffer.from(JSON.stringify({ server: pairServer, code: pairCode })).toString("base64url");
  const pairUrl = `${pairServer}/#pair=${pairing}`;
  const qr = await QRCode.toDataURL(pairUrl, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 420,
    color: { dark: "#111827", light: "#ffffff" },
  });
  const appPairUrl = `codexbridge://pair?server=${encodeURIComponent(pairServer)}&code=${encodeURIComponent(pairCode)}`;
  const appQr = await QRCode.toDataURL(appPairUrl, {
    errorCorrectionLevel: "M",
    margin: 4,
    width: 420,
    color: { dark: "#111827", light: "#ffffff" },
  });
  const configuredApkUrl = process.env.CODEX_BRIDGE_APK_URL?.trim();
  const apkSection = configuredApkUrl
    ? `<a class="button" href="${configuredApkUrl}">下载 Codex Bridge APK</a><p class="muted">手机下载地址</p><code>${configuredApkUrl}</code>`
    : `<p class="muted">请先从项目的 GitHub Releases 安装正式签名的 APK，再使用下方二维码配对。Host 不会自动分发本地构建产物。</p>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Codex Bridge 配对</title><style>body{font-family:system-ui;background:#0d0f12;color:#f4f6f8;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}.card{background:#171a1f;border:1px solid #30353e;border-radius:24px;padding:28px;max-width:620px;box-shadow:0 24px 70px #0008}img{display:block;margin:18px auto;border-radius:18px;max-width:100%}code{display:block;background:#0d0f12;padding:12px;border-radius:10px;overflow-wrap:anywhere}.muted{color:#a4a9b2;font-size:14px}.button{display:block;text-align:center;background:#e7ff6a;color:#111;padding:14px 18px;border-radius:12px;text-decoration:none;font-weight:750;margin:18px 0}.step{border-top:1px solid #30353e;margin-top:24px;padding-top:18px}</style><main class="card"><h1>Codex Bridge 已就绪</h1><p>安装 Android APK 后，在 App 内点击“扫码连接电脑”。二维码 5 分钟内有效，成功配对后立即失效。</p>${apkSection}<section class="step"><h2>APK 扫码配对</h2><img src="${appQr}" alt="APK 扫码配对二维码"><p class="muted">请使用 Codex Bridge App 内置扫码器。</p></section><section class="step"><h2>浏览器 / PWA 配对</h2><img src="${qr}" alt="浏览器配对二维码"><p class="muted">也可以直接用手机相机扫码。</p></section><p class="muted">电脑服务地址</p><code>${pairServer}</code></main></html>`;
}

async function listDriveRoots() {
  if (process.platform !== "win32") return [{ name: "/", path: "/", kind: "drive" }];
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const available = await Promise.all(candidates.map(async (candidate) => {
    try { await access(candidate); return { name: candidate.slice(0, 2), path: candidate, kind: "drive" }; }
    catch { return null; }
  }));
  return available.filter(Boolean);
}

async function browseFileSystem(requestedPath?: string | null, includeFiles = false) {
  const home = os.homedir();
  const shortcuts = [
    { name: "用户目录", path: home, kind: "shortcut" },
    { name: "桌面", path: path.join(home, "Desktop"), kind: "shortcut" },
    { name: "文档", path: path.join(home, "Documents"), kind: "shortcut" },
    { name: "下载", path: path.join(home, "Downloads"), kind: "shortcut" },
  ];
  if (!requestedPath) return { path: "", parent: null, roots: await listDriveRoots(), shortcuts, entries: [] };
  const resolved = path.resolve(requestedPath);
  const children = await readdir(resolved, { withFileTypes: true });
  const entries = children
    .filter((entry) => entry.isDirectory() || (includeFiles && entry.isFile()))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      kind: entry.isDirectory() ? "folder" : "file",
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
    });
  const parent = path.dirname(resolved) === resolved ? null : path.dirname(resolved);
  return { path: resolved, parent, roots: [], shortcuts: [], entries };
}

function diagnosticsPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Bridge 诊断</title><style>body{font-family:system-ui;background:#0d0f12;color:#f1f3f5;margin:0;padding:20px}main{max-width:720px;margin:auto}h1{font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#171a1f;border:1px solid #343a43;border-radius:12px;padding:14px;line-height:1.6}.ok{color:#77dba0}.bad{color:#ff8b8b}a{color:#e7ff6a}</style><main><h1>Codex Bridge 手机诊断</h1><p>此页面不会显示或上传完整配对令牌。</p><pre id="result">正在检测...</pre><p><a href="/">返回 Codex Bridge</a></p></main><script>
const output = document.getElementById('result');
const lines = [];
const add = (label, value, ok) => lines.push((ok === true ? '✓ ' : ok === false ? '✗ ' : '• ') + label + ': ' + value);
function pairedFromHash() {
  if (!location.hash.startsWith('#pair=')) return null;
  try {
    const raw = location.hash.slice(6).replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(raw), character => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) { add('二维码解析', error.message, false); return null; }
}
async function request(label, url, token) {
  try {
    const response = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } : {} });
    const text = await response.text();
    add(label, response.status + ' ' + text.slice(0, 160), response.ok);
    return response.ok;
  } catch (error) { add(label, error.name + ': ' + error.message, false); return false; }
}
(async () => {
  add('页面地址', location.href.split('#')[0]);
  add('浏览器', navigator.userAgent);
  add('安全上下文', String(window.isSecureContext));
  const paired = pairedFromHash();
  if (paired && paired.server && paired.token) {
    localStorage.setItem('codex-bridge-connection', JSON.stringify(paired));
    history.replaceState({}, '', location.pathname);
    add('二维码解析', '成功并写入本机', true);
  }
  let settings = null;
  try { settings = JSON.parse(localStorage.getItem('codex-bridge-connection') || 'null'); } catch {}
  add('已保存配对', settings ? '是，服务地址 ' + settings.server + '，令牌长度 ' + String(settings.token || '').length : '否', Boolean(settings));
  await request('同源健康检查', location.origin + '/api/health');
  if (settings?.token) {
    await request('同源鉴权任务列表', location.origin + '/api/threads', settings.token);
    const configuredServer = String(settings.server).endsWith('/') ? String(settings.server).slice(0, -1) : String(settings.server);
    await request('配置地址任务列表', configuredServer + '/api/threads', settings.token);
  }
  output.textContent = lines.join(String.fromCharCode(10));
})();
</script></html>`;
}

const config = await loadConfig();
const bridge = new CodexBridge();
const desktopIntegration = bridge.desktopIntegration;
const generatedImages = new GeneratedImageStore();
const userAttachments = new UserAttachmentStore();
await bridge.start();

const relayPublicUrl = process.env.CODEX_BRIDGE_RELAY_URL?.trim().replace(/\/$/, "") || "";
const relayHostToken = process.env.CODEX_BRIDGE_RELAY_HOST_TOKEN?.trim() || "";
const relayPhoneToken = process.env.CODEX_BRIDGE_RELAY_PHONE_TOKEN?.trim() || "";
const relayConfigured = Boolean(relayPublicUrl && relayHostToken.length >= 32 && relayPhoneToken.length >= 32);
const relayConnector = relayConfigured
  ? new RelayConnector({
      publicUrl: relayPublicUrl,
      hostToken: relayHostToken,
      localUrl: `http://127.0.0.1:${config.port}`,
      localToken: config.token,
    })
  : null;
if ((relayPublicUrl || relayHostToken || relayPhoneToken) && !relayConfigured) {
  logBridgeEvent("relay_configuration_incomplete");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const requestStartedAt = Date.now();
  response.once("finish", () => {
    if (request.method !== "GET" || response.statusCode >= 400) {
      logBridgeEvent("http_request", {
        method: request.method || "",
        path: url.pathname,
        status: response.statusCode,
        durationMs: Date.now() - requestStartedAt,
        remoteAddress: request.socket.remoteAddress || "",
      });
    }
  });
  recentRequests.push({
    at: new Date().toISOString(),
    remoteAddress: request.socket.remoteAddress || "",
    method: request.method || "",
    path: url.pathname,
    origin: request.headers.origin || null,
    userAgent: request.headers["user-agent"] || null,
    privateNetworkPreflight: String(request.headers["access-control-request-private-network"] || "") || null,
  });
  if (recentRequests.length > 100) recentRequests.splice(0, recentRequests.length - 100);
  if (request.method === "OPTIONS") {
    setCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        codex: bridge.rpc.isStarted,
        relayConfigured,
        relayConnected: relayConnector?.isConnected ?? false,
        hostname: os.hostname(),
        queue: bridge.getQueue().length,
        approvals: bridge.listApprovals().length,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/requests") {
      const body = (await readJson(request)) as { deviceName?: string };
      const created = pairingRequests.create({
        deviceName: body.deviceName,
        remoteAddress: request.socket.remoteAddress || "unknown",
        userAgent: request.headers["user-agent"] || "",
      });
      logBridgeEvent("pairing_request_created", {
        requestId: created.requestId,
        remoteAddress: request.socket.remoteAddress || "",
      });
      json(response, 201, { ...created, hostname: os.hostname() });
      return;
    }

    const pairingStatusMatch = url.pathname.match(/^\/api\/pair\/requests\/([^/]+)\/status$/);
    if (request.method === "GET" && pairingStatusMatch) {
      const requestId = decodeURIComponent(pairingStatusMatch[1]);
      const status = pairingRequests.status(requestId, url.searchParams.get("secret") || "");
      if (!status) {
        json(response, 404, { error: "Pairing request was not found or has expired" });
        return;
      }
      json(response, 200, {
        ...status,
        hostname: os.hostname(),
        ...(status.status === "approved" ? { token: config.token } : {}),
      });
      return;
    }

    if (url.pathname === "/api/pair/requests" && request.method === "GET") {
      if (!isLoopback(request) || !authorized(request, url, config.token)) {
        json(response, 403, { error: "Pairing requests can only be reviewed on this computer" });
        return;
      }
      json(response, 200, { data: pairingRequests.listPending() });
      return;
    }

    const pairingDecisionMatch = url.pathname.match(/^\/api\/pair\/requests\/([^/]+)\/decision$/);
    if (request.method === "POST" && pairingDecisionMatch) {
      if (!isLoopback(request) || !authorized(request, url, config.token)) {
        json(response, 403, { error: "Pairing requests can only be approved on this computer" });
        return;
      }
      const body = (await readJson(request)) as { decision?: "approve" | "deny" };
      if (body.decision !== "approve" && body.decision !== "deny")
        throw new PairingRequestError("A pairing decision is required", 400);
      const requestId = decodeURIComponent(pairingDecisionMatch[1]);
      const result = pairingRequests.decide(requestId, body.decision);
      logBridgeEvent("pairing_request_decided", {
        requestId,
        decision: body.decision,
      });
      json(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pair/exchange") {
      const body = (await readJson(request)) as { code?: string };
      const grant = body.code ? pairingCodes.get(body.code) : null;
      if (!grant || grant.expiresAt <= Date.now()) {
        if (body.code) pairingCodes.delete(body.code);
        json(response, 410, { error: "配对二维码已过期，请在电脑上刷新" });
        return;
      }
      pairingCodes.delete(body.code!);
      json(response, 200, { server: grant.server, token: grant.token, hostname: os.hostname() });
      return;
    }

    if (url.pathname === "/setup") {
      if (!isLoopback(request)) {
        json(response, 403, { error: "The setup page is only available on this computer" });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(await setupPage(config, relayConfigured ? { server: relayPublicUrl, token: relayPhoneToken } : undefined));
      return;
    }

    if (url.pathname === "/diagnostics") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(diagnosticsPage());
      return;
    }

    if (url.pathname === "/api/debug/recent") {
      if (!isLoopback(request)) {
        json(response, 403, { error: "Diagnostics traces are only available on this computer" });
        return;
      }
      json(response, 200, { data: recentRequests });
      return;
    }

    if (!url.pathname.startsWith("/api/")) {
      proxyWeb(request, response);
      return;
    }

    if (!authorized(request, url, config.token)) {
      json(response, 401, { error: "Invalid or missing pairing token" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/ws-ticket") {
      const ticket = randomBytes(24).toString("base64url");
      eventTickets.set(ticket, Date.now() + 30_000);
      if (eventTickets.size > 128) {
        const now = Date.now();
        for (const [value, expiresAt] of eventTickets) if (expiresAt <= now) eventTickets.delete(value);
      }
      json(response, 201, { ticket, expiresIn: 30 });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/threads") {
      const cursor = url.searchParams.get("cursor");
      const searchTerm = url.searchParams.get("search");
      json(
        response,
        200,
        await bridge.listThreads({
          cursor: cursor || null,
          searchTerm: searchTerm || null,
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      json(response, 200, await desktopIntegration.listProjects());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/codex-options") {
      json(response, 200, await bridge.getRunOptions(url.searchParams.get("cwd") || process.cwd()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/thread-drafts") {
      const body = (await readJson(request)) as { draftId?: string; cwd?: string };
      if (!body.draftId?.trim() || !body.cwd?.trim()) throw new Error("Draft ID and workspace are required");
      // Codex Desktop assigns a newly observed thread to the project that is
      // already registered for its cwd. Register first; doing this after
      // thread/start can cause Desktop to permanently classify it as a
      // projectless conversation.
      const projectRegistration = await desktopIntegration.ensureProject(body.cwd);
      const prepared = await bridge.prepareDraft(body.draftId, body.cwd);
      json(response, 201, {
        draftId: body.draftId,
        thread: prepared.thread,
        projectRegistration,
      });
      return;
    }

    const draftMatch = url.pathname.match(/^\/api\/thread-drafts\/([^/]+)$/);
    if (request.method === "DELETE" && draftMatch) {
      json(response, 200, { discarded: bridge.discardDraft(decodeURIComponent(draftMatch[1])) });
      return;
    }

    const generatedImageMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/images\/([^/]+)$/);
    if (request.method === "GET" && generatedImageMatch) {
      const threadId = decodeURIComponent(generatedImageMatch[1]);
      const itemId = decodeURIComponent(generatedImageMatch[2]);
      if (!generatedImages.has(threadId, itemId)) {
        const detail = await bridge.readThread(threadId, true, 4_000);
        generatedImages.registerThread(detail);
      }
      const asset = url.searchParams.get("variant") === "preview"
        ? await generatedImages.readPreview(threadId, itemId)
        : await generatedImages.read(threadId, itemId);
      image(response, asset);
      return;
    }

    const attachmentMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/attachments\/([^/]+)$/);
    if (request.method === "GET" && attachmentMatch) {
      const threadId = decodeURIComponent(attachmentMatch[1]);
      const attachmentId = decodeURIComponent(attachmentMatch[2]);
      let asset;
      try {
        asset = await userAttachments.read(threadId, attachmentId, url.searchParams.get("variant") === "preview");
      } catch (error) {
        if (!(error instanceof UserAttachmentError) || error.status !== 404 || !attachmentId.startsWith("local-"))
          throw error;
        const detail = await bridge.readThread(threadId, true, 4_000);
        compactThreadDetail(
          detail as unknown as Record<string, unknown>,
          100,
          (sourcePath) => userAttachments.referenceForPath(threadId, sourcePath),
        );
        asset = await userAttachments.read(threadId, attachmentId, url.searchParams.get("variant") === "preview");
      }
      image(response, asset);
      return;
    }

    const attachmentUploadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/attachments$/);
    if (request.method === "POST" && attachmentUploadMatch) {
      const threadId = decodeURIComponent(attachmentUploadMatch[1]);
      json(response, 201, await userAttachments.save(threadId, await readImageBody(request)));
      return;
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (request.method === "GET" && threadMatch) {
      const requestedLimit = Number(url.searchParams.get("turnLimit") || 40);
      const detail = await bridge.readThread(decodeURIComponent(threadMatch[1]), true, 4_000);
      generatedImages.registerThread(detail);
      const threadId = decodeURIComponent(threadMatch[1]);
      json(
        response,
        200,
        compactThreadDetail(
          detail as unknown as Record<string, unknown>,
          requestedLimit,
          (sourcePath) => userAttachments.referenceForPath(threadId, sourcePath),
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/threads") {
      const body = (await readJson(request)) as {
        cwd?: string;
        text?: string;
        draftId?: string;
        runConfiguration?: RunConfiguration;
      };
      // Keep the non-draft entry point safe as well. Draft-backed requests
      // normally hit the fast already_registered path here.
      const projectRegistration = body.cwd
        ? await desktopIntegration.ensureProject(body.cwd)
        : undefined;
      const thread = await bridge.createThread(body);
      json(response, 201, { thread, projectRegistration });
      return;
    }

    const openDesktopMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/open-desktop$/);
    if (request.method === "POST" && openDesktopMatch) {
      const threadId = decodeURIComponent(openDesktopMatch[1]);
      const result = await desktopIntegration.openThread(threadId, () =>
        bridge.readThread(threadId, false, 4_000),
      );
      json(response, result.status, result.body);
      return;
    }

    const runConfigurationMatch = url.pathname.match(
      /^\/api\/threads\/([^/]+)\/run-configuration$/,
    );
    if (request.method === "PATCH" && runConfigurationMatch) {
      const threadId = decodeURIComponent(runConfigurationMatch[1]);
      const body = (await readJson(request)) as RunConfiguration & { cwd?: string };
      json(
        response,
        200,
        await bridge.setThreadRunConfiguration(threadId, body, body.cwd),
      );
      return;
    }

    const goalMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/goal$/);
    if (goalMatch) {
      const threadId = decodeURIComponent(goalMatch[1]);
      if (request.method === "GET") {
        json(response, 200, { goal: await bridge.getThreadGoal(threadId) });
        return;
      }
      if (request.method === "POST") {
        const body = (await readJson(request)) as {
          objective?: string;
          status?: ThreadGoalStatus;
          tokenBudget?: number | null;
        };
        json(response, 200, {
          goal: await bridge.setThreadGoal(threadId, body),
        });
        return;
      }
      if (request.method === "DELETE") {
        json(response, 200, await bridge.clearThreadGoal(threadId));
        return;
      }
    }

    const messageMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (request.method === "POST" && messageMatch) {
      const body = (await readJson(request)) as {
        text?: string;
        force?: boolean;
        queueIfBusy?: boolean;
        steerIfBusy?: boolean;
        runConfiguration?: RunConfiguration;
        attachmentIds?: string[];
        contextPaths?: ContextReferenceInput[];
      };
      const threadId = decodeURIComponent(messageMatch[1]);
      const [imagePaths, mentions] = await Promise.all([
        userAttachments.resolvePaths(threadId, body.attachmentIds || []),
        resolveContextReferences(body.contextPaths || []),
      ]);
      json(
        response,
        202,
        await bridge.sendMessage(threadId, body.text || "", {
          force: body.force,
          queueIfBusy: body.queueIfBusy,
          steerIfBusy: body.steerIfBusy,
          runConfiguration: body.runConfiguration,
          imagePaths,
          mentions,
        }),
      );
      return;
    }

    const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
    if (request.method === "POST" && interruptMatch) {
      json(response, 200, await bridge.interrupt(decodeURIComponent(interruptMatch[1])));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/queue") {
      json(response, 200, { data: bridge.getQueue(url.searchParams.get("threadId") || undefined) });
      return;
    }

    const queueMatch = url.pathname.match(/^\/api\/queue\/([^/]+)$/);
    if (request.method === "PATCH" && queueMatch) {
      const body = (await readJson(request)) as { text?: string; direction?: "up" | "down" };
      const item = await bridge.updateQueuedMessage(decodeURIComponent(queueMatch[1]), body);
      json(response, item ? 200 : 404, { item });
      return;
    }
    if (request.method === "DELETE" && queueMatch) {
      const removed = await bridge.removeQueuedMessage(decodeURIComponent(queueMatch[1]));
      json(response, removed ? 200 : 404, { removed });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/fs/browse") {
      json(
        response,
        200,
        await browseFileSystem(
          url.searchParams.get("path"),
          url.searchParams.get("includeFiles") === "true",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/fs/folders") {
      const body = (await readJson(request)) as { parent?: string; name?: string };
      try {
        const folder = await createFolder(body.parent, body.name);
        // A folder created as a mobile project is registered before its draft
        // thread can be prepared, so the first task is grouped correctly.
        const projectRegistration = await desktopIntegration.ensureProject(folder.path);
        json(response, 201, { ...folder, projectRegistration });
      } catch (error) {
        if (error instanceof FolderCreationError) json(response, error.status, { error: error.message });
        else throw error;
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      json(response, 200, { data: bridge.listApprovals() });
      return;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const body = (await readJson(request)) as {
        decision?: "accept" | "acceptForSession" | "decline" | "cancel";
      };
      if (!body.decision) throw new Error("An approval decision is required");
      json(response, 200, bridge.respondToApproval(decodeURIComponent(approvalMatch[1]), body.decision));
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    logBridgeEvent("http_handler_error", {
      method: request.method || "",
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    json(
      response,
      error instanceof GeneratedImageError ||
      error instanceof UserAttachmentError ||
      error instanceof RunConfigurationError ||
      error instanceof ContextReferenceError ||
      error instanceof PairingRequestError
        ? error.status
        : 500,
      {
      error: error instanceof Error ? error.message : "Unexpected server error",
      },
    );
  }
});

const sockets = new WebSocketServer({ noServer: true });
const liveSockets = new WeakSet<WebSocket>();
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const ticket = url.searchParams.get("ticket") || "";
  const ticketExpiresAt = eventTickets.get(ticket) || 0;
  if (ticket) eventTickets.delete(ticket);
  const eventAuthorized = authorized(request, url, config.token) || ticketExpiresAt > Date.now();
  if (url.pathname !== "/api/events" || !eventAuthorized) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
});

sockets.on("connection", (socket) => {
  liveSockets.add(socket);
  socket.on("pong", () => liveSockets.add(socket));
  socket.send(
    JSON.stringify({
      method: "bridge/snapshot",
      params: { queue: bridge.getQueue(), approvals: bridge.listApprovals() },
      at: Date.now(),
    }),
  );
});

const socketHeartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (!liveSockets.has(socket)) {
      socket.terminate();
      continue;
    }
    liveSockets.delete(socket);
    socket.ping();
  }
}, 25_000);
socketHeartbeat.unref();

bridge.on("event", (event) => {
  const payload = JSON.stringify(event);
  for (const client of sockets.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
});
bridge.on("diagnostic", (message) => console.warn(`[codex] ${message}`));

server.listen(config.port, config.listenAddress, () => {
  console.log(`Codex Bridge Host: http://${config.listenAddress}:${config.port}`);
  console.log(`Setup page: http://127.0.0.1:${config.port}/setup`);
  console.log(`Mobile API: ${config.publicApiUrl}`);
  console.log(`Structured log: ${bridgeLogPath}`);
  logBridgeEvent("host_listening", { listenAddress: config.listenAddress, port: config.port, publicApiUrl: config.publicApiUrl });
  relayConnector?.start();
});

const shutdown = async () => {
  clearInterval(socketHeartbeat);
  sockets.close();
  server.close();
  relayConnector?.stop();
  await bridge.stop();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
