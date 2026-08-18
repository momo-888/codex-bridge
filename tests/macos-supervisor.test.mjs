import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_LAUNCHER_CONFIG,
  normalizeSiteUrl,
  validateConnectionSettings,
} from "../macos/config.mjs";
import { BridgeState, buildSnapshot } from "../macos/supervisor-core.mjs";

test("validates the three macOS connection modes", () => {
  const local = validateConnectionSettings({ mode: "local" }, DEFAULT_LAUNCHER_CONFIG);
  assert.equal(local.launcher.listenAddress, "127.0.0.1");
  assert.equal(local.mobileUrl, "http://127.0.0.1:43110");

  const network = validateConnectionSettings(
    { mode: "network", address: "100.64.0.10" },
    DEFAULT_LAUNCHER_CONFIG,
  );
  assert.equal(network.launcher.listenAddress, "0.0.0.0");
  assert.equal(network.mobileUrl, "http://100.64.0.10:43110");

  const relay = validateConnectionSettings(
    {
      mode: "relay",
      relayPublicUrl: "https://bridge.example.com/",
      hostToken: "h".repeat(32),
      phoneToken: "p".repeat(32),
    },
    DEFAULT_LAUNCHER_CONFIG,
  );
  assert.equal(relay.launcher.listenAddress, "127.0.0.1");
  assert.equal(relay.mobileUrl, "https://bridge.example.com");
  assert.equal(relay.relay.publicUrl, "https://bridge.example.com");
});

test("rejects unsafe public relay and malformed network settings", () => {
  assert.throws(
    () => normalizeSiteUrl("http://bridge.example.com", { relay: true }),
    /HTTPS/,
  );
  assert.throws(
    () => validateConnectionSettings(
      { mode: "network", address: "169.254.1.2" },
      DEFAULT_LAUNCHER_CONFIG,
    ),
    /IPv4/,
  );
  assert.throws(
    () => validateConnectionSettings(
      {
        mode: "relay",
        relayPublicUrl: "https://bridge.example.com/path",
        hostToken: "h".repeat(32),
        phoneToken: "p".repeat(32),
      },
      DEFAULT_LAUNCHER_CONFIG,
    ),
    /根地址/,
  );
});

test("derives online, degraded, and offline macOS supervisor states", () => {
  const base = {
    launcher: DEFAULT_LAUNCHER_CONFIG,
    relayConfig: { configured: false, publicUrl: "", hostToken: "", phoneToken: "" },
    relay: { success: false, json: {} },
  };
  const online = buildSnapshot({
    ...base,
    api: { success: true, json: { codex: true } },
    web: { success: true },
    failureCount: 0,
  });
  assert.equal(online.state, BridgeState.ONLINE);

  const degraded = buildSnapshot({
    ...base,
    relayConfig: { configured: true, publicUrl: "https://bridge.example.com" },
    api: { success: true, json: { codex: true, relayConnected: false } },
    web: { success: true },
    relay: { success: true, json: { hostConnected: false } },
    failureCount: 0,
  });
  assert.equal(degraded.state, BridgeState.DEGRADED);

  const offline = buildSnapshot({
    ...base,
    api: { success: false, json: {} },
    web: { success: false },
    failureCount: 2,
  });
  assert.equal(offline.state, BridgeState.OFFLINE);
  assert.match(offline.detail, /Host/);
});

test("keeps the macOS management API on loopback and rejects browser CSRF", async () => {
  const source = await readFile(new URL("../macos/supervisor.mjs", import.meta.url), "utf8");
  assert.match(source, /server\.listen\(managerPort, "127\.0\.0\.1"/);
  assert.match(source, /validManagerHost\(request\)/);
  assert.match(source, /validMutationOrigin\(request\)/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin/);
});
