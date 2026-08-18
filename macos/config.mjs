import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_LAUNCHER_CONFIG = Object.freeze({
  publicUrl: "http://127.0.0.1:43110",
  apiPort: 43110,
  webPort: 3000,
  listenAddress: "127.0.0.1",
});

export function bridgePaths(projectRoot) {
  const configDirectory = path.join(os.homedir(), ".codex-bridge");
  return {
    projectRoot,
    configDirectory,
    logsDirectory: path.join(projectRoot, ".logs"),
    launcherConfig: path.join(configDirectory, "launcher.json"),
    relayConfig: path.join(configDirectory, "relay.json"),
    hostConfig: path.join(configDirectory, "config.json"),
    runtime: path.join(configDirectory, "runtime.json"),
    supervisorState: path.join(configDirectory, "macos-state.json"),
    supervisorPid: path.join(configDirectory, "macos-supervisor.pid"),
    supervisorLog: path.join(configDirectory, "macos-supervisor.log"),
    codexVersion: path.join(configDirectory, "last-codex-version.txt"),
    startScript: path.join(projectRoot, "scripts", "start-codex-bridge.sh"),
    stopScript: path.join(projectRoot, "scripts", "stop-codex-bridge.sh"),
  };
}

export async function ensurePrivateDirectories(paths) {
  await fs.mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.configDirectory, 0o700).catch(() => undefined);
  await fs.mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 });
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

export async function loadLauncherConfig(paths) {
  const saved = await readJson(paths.launcherConfig, {});
  return {
    publicUrl:
      typeof saved.publicUrl === "string" && saved.publicUrl.trim()
        ? saved.publicUrl.trim().replace(/\/$/, "")
        : DEFAULT_LAUNCHER_CONFIG.publicUrl,
    apiPort: validPort(saved.apiPort, DEFAULT_LAUNCHER_CONFIG.apiPort),
    webPort: validPort(saved.webPort, DEFAULT_LAUNCHER_CONFIG.webPort),
    listenAddress:
      saved.listenAddress === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
  };
}

export async function loadRelayConfig(paths) {
  const saved = await readJson(paths.relayConfig, {});
  const relay = {
    publicUrl: typeof saved.publicUrl === "string" ? saved.publicUrl.trim().replace(/\/$/, "") : "",
    hostToken: typeof saved.hostToken === "string" ? saved.hostToken.trim() : "",
    phoneToken: typeof saved.phoneToken === "string" ? saved.phoneToken.trim() : "",
  };
  return {
    ...relay,
    configured: Boolean(
      relay.publicUrl && relay.hostToken.length >= 32 && relay.phoneToken.length >= 32,
    ),
  };
}

export async function loadEnabledState(paths) {
  const state = await readJson(paths.supervisorState, { enabled: true });
  return state.enabled !== false;
}

export async function saveEnabledState(paths, enabled) {
  await writeJsonAtomic(paths.supervisorState, { enabled: Boolean(enabled) });
}

export function normalizeSiteUrl(value, { relay = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(relay ? "请输入完整的中继地址" : "请输入完整的手机连接地址");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("地址必须是完整的 HTTP 或 HTTPS 站点地址");
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash)
    throw new Error("地址只能填写站点根地址，不能包含路径、查询参数或片段");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (relay && parsed.protocol !== "https:" && !loopback)
    throw new Error("公网中继必须使用 HTTPS；只有本机测试地址可以使用 HTTP");
  return parsed.origin;
}

export function validateConnectionSettings(input, current) {
  const mode = String(input?.mode || "");
  if (!['local', 'network', 'relay'].includes(mode)) throw new Error("请选择连接方式");
  if (mode === "local") {
    const publicUrl = `http://127.0.0.1:${current.apiPort}`;
    return {
      mode,
      mobileUrl: publicUrl,
      launcher: { ...current, listenAddress: "127.0.0.1", publicUrl },
      relay: null,
    };
  }
  if (mode === "network") {
    const address = String(input.address || "").trim();
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error("请选择有效的 IPv4 地址");
    const octets = address.split(".").map(Number);
    if (octets.some((item) => item < 0 || item > 255) || address.startsWith("169.254."))
      throw new Error("请选择有效的 IPv4 地址");
    const publicUrl = `http://${address}:${current.apiPort}`;
    return {
      mode,
      mobileUrl: publicUrl,
      launcher: { ...current, listenAddress: "0.0.0.0", publicUrl },
      relay: null,
    };
  }

  const publicUrl = normalizeSiteUrl(input.relayPublicUrl, { relay: true });
  const hostToken = String(input.hostToken || "").trim();
  const phoneToken = String(input.phoneToken || "").trim();
  if (hostToken.length < 32) throw new Error("电脑令牌至少需要 32 个字符");
  if (phoneToken.length < 32) throw new Error("手机令牌至少需要 32 个字符");
  return {
    mode,
    mobileUrl: publicUrl,
    launcher: {
      ...current,
      listenAddress: "127.0.0.1",
      publicUrl: `http://127.0.0.1:${current.apiPort}`,
    },
    relay: { publicUrl, hostToken, phoneToken },
  };
}

export async function saveConnectionSettings(paths, input) {
  const current = await loadLauncherConfig(paths);
  const result = validateConnectionSettings(input, current);
  await writeJsonAtomic(paths.launcherConfig, result.launcher);
  if (result.relay) await writeJsonAtomic(paths.relayConfig, result.relay);
  else await fs.rm(paths.relayConfig, { force: true });
  return result;
}

export async function effectiveMobileUrl(paths) {
  const [launcher, relay] = await Promise.all([
    loadLauncherConfig(paths),
    loadRelayConfig(paths),
  ]);
  return relay.configured ? relay.publicUrl : launcher.publicUrl;
}
