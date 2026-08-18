import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexDesktopIpcClient,
  codexDesktopIpcPath,
  encodeIpcFrame,
} from "../host/codex-ipc";

test("resolves the platform-specific Codex Desktop IPC endpoint", () => {
  assert.equal(codexDesktopIpcPath("win32", "ignored"), "\\\\.\\pipe\\codex-ipc");
  assert.equal(
    codexDesktopIpcPath("darwin", "/Users/tester"),
    "/Users/tester/.codex/ipc/ipc.sock",
  );
  assert.throws(() => codexDesktopIpcPath("linux", "/home/tester"), /not available/);
});

test("encodes Codex Desktop IPC frames with a little-endian JSON length", () => {
  const message = { type: "request", method: "initialize", params: { clientType: "codex-bridge" } };
  const frame = encodeIpcFrame(message);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), message);
});

test("announces an exact local thread so Codex Desktop can hydrate its conversation store", async () => {
  const client = new CodexDesktopIpcClient();
  const frames: Buffer[] = [];
  const internals = client as unknown as {
    clientId: string;
    socket: {
      writable: boolean;
      write(value: Buffer, callback: (error?: Error) => void): void;
    };
    connect(): Promise<void>;
  };
  internals.clientId = "codex-bridge";
  internals.socket = {
    writable: true,
    write(value, callback) {
      frames.push(value);
      callback();
    },
  };
  internals.connect = async () => undefined;

  await client.announceThreadAvailable("mobile-thread");

  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), {
    type: "broadcast",
    method: "thread-unarchived",
    sourceClientId: "codex-bridge",
    params: { hostId: "local", conversationId: "mobile-thread" },
    version: 1,
  });
});

test("waits until a Desktop renderer claims the announced thread", async () => {
  const client = new CodexDesktopIpcClient();
  let probes = 0;
  client.findThreadOwner = async () => {
    probes += 1;
    return probes === 3 ? "desktop-renderer" : null;
  };

  assert.equal(await client.waitForThreadOwner("mobile-thread", 500), "desktop-renderer");
  assert.equal(probes, 3);
});

test("passes model, effort, and permissions to a Desktop-owned turn", async () => {
  const client = new CodexDesktopIpcClient();
  let captured: Record<string, unknown> = {};
  const internals = client as unknown as {
    request(
      method: string,
      params: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<{ result: unknown }>;
  };
  internals.request = async (_method, params) => {
    captured = params;
    return { result: { id: "turn-desktop" } };
  };

  await client.startTurn("desktop-owner", "thread-1", [
    { type: "text", text: "continue", text_elements: [] },
    { type: "localImage", path: "C:\\temp\\phone.webp" },
  ], {
    model: "gpt-test",
    effort: "high",
    permissions: ":workspace",
  });

  const turnStartParams = captured?.turnStartParams as Record<string, unknown>;
  assert.equal(turnStartParams.model, "gpt-test");
  assert.equal(turnStartParams.effort, "high");
  assert.equal(turnStartParams.permissions, ":workspace");
  assert.deepEqual(turnStartParams.input, [
    { type: "text", text: "continue", text_elements: [] },
    { type: "localImage", path: "C:\\temp\\phone.webp" },
  ]);
});

test("updates Desktop thread settings before the next turn", async () => {
  const client = new CodexDesktopIpcClient();
  let capturedMethod = "";
  let capturedParams: Record<string, unknown> = {};
  let capturedOptions: Record<string, unknown> = {};
  const internals = client as unknown as {
    request(
      method: string,
      params: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<{ result: unknown }>;
  };
  internals.request = async (method, params, options) => {
    capturedMethod = method;
    capturedParams = params;
    capturedOptions = options;
    return { result: { ok: true } };
  };

  await client.updateThreadSettings("desktop-owner", "thread-1", {
    model: "gpt-test",
    effort: "high",
  });

  assert.equal(capturedMethod, "thread-follower-update-thread-settings");
  assert.deepEqual(capturedParams, {
    conversationId: "thread-1",
    threadSettings: { model: "gpt-test", effort: "high" },
  });
  assert.equal(capturedOptions.targetClientId, "desktop-owner");
});

test("interrupts a Desktop-owned turn in user-stop mode with the compatible IPC version", async () => {
  const client = new CodexDesktopIpcClient();
  let capturedMethod = "";
  let capturedParams: Record<string, unknown> = {};
  let capturedOptions: Record<string, unknown> = {};
  const internals = client as unknown as {
    clientId: string;
    connect(): Promise<void>;
    requestRaw(
      method: string,
      params: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<{ result: unknown }>;
  };
  internals.clientId = "codex-bridge";
  internals.connect = async () => undefined;
  internals.requestRaw = async (method, params, options) => {
    capturedMethod = method;
    capturedParams = params;
    capturedOptions = options;
    return { result: { ok: true, interruptedTurnId: "turn-desktop" } };
  };

  const result = await client.interruptTurn("desktop-owner", "thread-1");

  assert.equal(capturedMethod, "thread-follower-interrupt-turn");
  assert.deepEqual(capturedParams, {
    conversationId: "thread-1",
    mode: "user-stop",
  });
  assert.equal(capturedOptions.targetClientId, "desktop-owner");
  assert.equal(capturedOptions.version, 3);
  assert.equal(result?.interruptedTurnId, "turn-desktop");
});
