import net from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { CodexRunOverrides, ReasoningEffort } from "./run-options";
import type { CodexInput } from "./codex-input";

type IpcResponse = {
  type: "response";
  requestId: string;
  resultType: "success" | "error";
  error?: string;
  handledByClientId?: string;
  result?: unknown;
};

type PendingRequest = {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const INITIALIZING_CLIENT_ID = "initializing-client";
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export function codexDesktopIpcPath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = os.homedir(),
) {
  if (platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  if (platform === "darwin")
    return path.join(homeDirectory, ".codex", "ipc", "ipc.sock");
  throw new Error(`Codex Desktop IPC is not available on ${platform}`);
}

const methodVersions: Record<string, number> = {
  "thread-unarchived": 1,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-update-thread-settings": 1,
};

function methodVersion(method: string, params: unknown) {
  if (
    method === "thread-follower-interrupt-turn" &&
    params &&
    typeof params === "object" &&
    (!("expectedTurnId" in params) ||
      (params as { expectedTurnId?: unknown }).expectedTurnId == null)
  )
    return 3;
  return methodVersions[method] ?? 0;
}

export type DesktopThreadSettings = {
  model?: string;
  effort?: ReasoningEffort;
};

export function encodeIpcFrame(message: unknown) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class CodexDesktopIpcClient {
  private socket: net.Socket | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private connecting: Promise<void> | null = null;

  get isConnected() {
    return Boolean(this.socket?.writable && this.clientId !== INITIALIZING_CLIENT_ID);
  }

  async connect(timeoutMs = 2_000) {
    if (this.isConnected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open(timeoutMs).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  close() {
    this.failPending(new Error("Codex Desktop IPC disconnected"));
    this.socket?.destroy();
    this.socket = null;
    this.clientId = INITIALIZING_CLIENT_ID;
    this.incoming = Buffer.alloc(0);
  }

  async findThreadOwner(hostId: string, conversationId: string, timeoutMs = 3_000) {
    try {
      const response = await this.request(
        "thread-owner-discovery",
        { hostId, conversationId },
        { timeoutMs },
      );
      return response.handledByClientId ?? null;
    } catch (error) {
      if (error instanceof Error && /no-client-found|client-cannot-handle-request/.test(error.message)) return null;
      throw error;
    }
  }

  async startTurn(
    ownerClientId: string,
    conversationId: string,
    input: CodexInput[],
    overrides: CodexRunOverrides = {},
  ) {
    const response = await this.request(
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams: {
          clientUserMessageId: randomUUID(),
          input,
          ...overrides,
        },
        mcpAppModelContextAttachments: [],
      },
      { targetClientId: ownerClientId, timeoutMs: 60_000 },
    );
    return response.result;
  }

  async interruptTurn(
    ownerClientId: string,
    conversationId: string,
    expectedTurnId?: string,
  ) {
    const response = await this.request(
      "thread-follower-interrupt-turn",
      {
        conversationId,
        mode: "user-stop",
        ...(expectedTurnId ? { expectedTurnId } : {}),
      },
      { targetClientId: ownerClientId, timeoutMs: 30_000 },
    );
    return response.result as
      | { ok?: boolean; interruptedTurnId?: string | null }
      | undefined;
  }

  async updateThreadSettings(
    ownerClientId: string,
    conversationId: string,
    threadSettings: DesktopThreadSettings,
  ) {
    const response = await this.request(
      "thread-follower-update-thread-settings",
      { conversationId, threadSettings },
      { targetClientId: ownerClientId, timeoutMs: 30_000 },
    );
    return response.result;
  }

  async announceThreadAvailable(conversationId: string) {
    await this.connect();
    // Codex Desktop keeps its local conversation sidebar in a dedicated store;
    // invalidating the generic React Query "tasks" key does not refresh it.
    // This supported Desktop event makes that store read and upsert the exact
    // conversation, so a later deep link cannot outrun cache hydration.
    await this.sendBroadcast("thread-unarchived", {
      hostId: "local",
      conversationId,
    });
  }

  async waitForThreadOwner(conversationId: string, timeoutMs = 1_500) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const remainingMs = deadline - Date.now();
      try {
        const ownerClientId = await this.findThreadOwner(
          "local",
          conversationId,
          Math.max(50, Math.min(remainingMs, 400)),
        );
        if (ownerClientId) return ownerClientId;
      } catch {
        // A renderer can reconnect while its conversation store is refreshing.
        // Keep probing within the bounded readiness window.
      }
      const afterProbeMs = deadline - Date.now();
      if (afterProbeMs <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(afterProbeMs, 100)));
    }
  }

  private async open(timeoutMs: number) {
    this.close();
    const socket = net.createConnection(codexDesktopIpcPath());
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = INITIALIZING_CLIENT_ID;
      this.incoming = Buffer.alloc(0);
      this.failPending(new Error("Codex Desktop IPC connection closed"));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop IPC connection timed out")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    const initialized = await this.requestRaw(
      "initialize",
      { clientType: "codex-bridge" },
      { timeoutMs, sourceClientId: INITIALIZING_CLIENT_ID, version: 0 },
    );
    const result = initialized.result as { clientId?: string } | undefined;
    if (!result?.clientId) throw new Error("Codex Desktop IPC did not return a client id");
    this.clientId = result.clientId;
  }

  private async request(
    method: string,
    params: unknown,
    options: { targetClientId?: string; timeoutMs?: number } = {},
  ) {
    await this.connect();
    return this.requestRaw(method, params, {
      ...options,
      sourceClientId: this.clientId,
      version: methodVersion(method, params),
    });
  }

  private requestRaw(
    method: string,
    params: unknown,
    options: { sourceClientId: string; version: number; targetClientId?: string; timeoutMs?: number },
  ) {
    const socket = this.socket;
    if (!socket?.writable) return Promise.reject(new Error("Codex Desktop IPC is not connected"));
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(
        encodeIpcFrame({
          type: "request",
          requestId,
          sourceClientId: options.sourceClientId,
          version: options.version,
          method,
          params,
          targetClientId: options.targetClientId,
          timeoutMs,
        }),
      );
    });
  }

  private async sendBroadcast(method: string, params: unknown, targetClientIds?: string[]) {
    const socket = this.socket;
    if (!socket?.writable || this.clientId === INITIALIZING_CLIENT_ID)
      throw new Error("Codex Desktop IPC is not connected");
    const frame = encodeIpcFrame({
        type: "broadcast",
        method,
        sourceClientId: this.clientId,
        targetClientIds,
        params,
        version: methodVersions[method] ?? 0,
      });
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  private onData(chunk: Buffer) {
    this.incoming = this.incoming.length ? Buffer.concat([this.incoming, chunk]) : chunk;
    while (this.incoming.length >= 4) {
      const length = this.incoming.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) {
        this.close();
        return;
      }
      if (this.incoming.length < length + 4) return;
      const body = this.incoming.subarray(4, length + 4).toString("utf8");
      this.incoming = this.incoming.subarray(length + 4);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        this.close();
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: Record<string, unknown>) {
    if (message.type === "client-discovery-request" && typeof message.requestId === "string") {
      this.socket?.write(
        encodeIpcFrame({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: { canHandle: false },
        }),
      );
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    const response = message as IpcResponse;
    if (response.resultType === "error") {
      pending.reject(new Error(response.error || "Codex Desktop IPC request failed"));
    } else {
      pending.resolve(response);
    }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
