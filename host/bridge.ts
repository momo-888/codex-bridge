import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { CodexRpcClient, type RpcMessage } from "./codex-rpc";
import { inspectRollout, type RolloutState } from "./rollout-state";
import { logBridgeEvent } from "./logger";
import { DesktopIntegrationService } from "./desktop-integration";
import {
  fallbackPermissions,
  normalizeRunConfiguration,
  reasoningEfforts,
  RunConfigurationError,
  toCodexRunOverrides,
  type CodexRunOverrides,
  type ModelOption,
  type PermissionProfileOption,
  type RunConfiguration,
  type RunOptions,
} from "./run-options";
import {
  buildCodexInput,
  type CodexInput,
  type CodexMention,
} from "./codex-input";

type ThreadStatus = { type: "notLoaded" | "idle" | "systemError" } | { type: "active"; activeFlags: string[] };

export type CodexThread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  source: string | Record<string, unknown>;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: ThreadStatus;
  path?: string | null;
  turns: Array<Record<string, unknown>>;
  isPinned?: boolean;
  extra?: Record<string, unknown>;
};

type ThreadListResponse = { data: CodexThread[]; nextCursor: string | null };
type ThreadReadResponse = { thread: CodexThread };
type ThreadResumeResponse = { thread: CodexThread };
type TurnStartResponse = { turn: { id: string; status: string } };
type ThreadUnsubscribeResponse = { status: "notLoaded" | "notSubscribed" | "unsubscribed" };
type ModelListResponse = { data: ModelOption[]; nextCursor: string | null };
type PermissionProfileListResponse = { data: PermissionProfileOption[]; nextCursor: string | null };

export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

type ThreadGoalResponse = { goal: ThreadGoal | null };

type PreparedThread = {
  thread: CodexThread;
  client: CodexRpcClient;
};

type DraftPreparation = {
  cwd: string;
  promise: Promise<PreparedThread>;
  prepared: PreparedThread | null;
  claimed: boolean;
  cleanupTimer: NodeJS.Timeout | null;
};

export type QueuedMessage = {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  runConfiguration?: RunConfiguration;
  imagePaths?: string[];
  mentions?: CodexMention[];
};

export type PublicQueuedMessage = Omit<QueuedMessage, "imagePaths" | "mentions"> & {
  attachmentCount?: number;
  contextCount?: number;
};

export type QueueUpdate = {
  text?: string;
  direction?: "up" | "down";
};

export type PendingApproval = {
  id: string;
  rpcId: number | string;
  method: string;
  params: unknown;
  createdAt: number;
};

export type ThreadDetail = {
  thread: CodexThread;
  goal: ThreadGoal | null;
  handoff: RolloutState & {
    bridgeActive: boolean;
    bridgeOwned: boolean;
    desktopActive: boolean;
    bridgeTurnId: string | null;
    queueLength: number;
    preferredRunConfiguration: RunConfiguration | null;
  };
};

function sameRunConfiguration(
  left: RunConfiguration | null | undefined,
  right: RunConfiguration | null | undefined,
) {
  return (
    (left?.model || "") === (right?.model || "") &&
    (left?.effort || "") === (right?.effort || "") &&
    (left?.permissions || "") === (right?.permissions || "")
  );
}

function normalizeWorkspacePath(candidate: string) {
  return path.win32.isAbsolute(candidate)
    ? path.win32.normalize(candidate)
    : path.resolve(candidate);
}

export class CodexBridge extends EventEmitter {
  readonly rpc = new CodexRpcClient();
  readonly activeTurns = new Map<string, string>();
  readonly approvals = new Map<string, PendingApproval>();
  private ownerClients = new Map<string, CodexRpcClient>();
  private approvalClients = new Map<string, CodexRpcClient>();
  private leasedClients = new Set<CodexRpcClient>();
  private writerClient: CodexRpcClient | null = null;
  private writerClientStarting: Promise<CodexRpcClient> | null = null;
  private writerAcquisition: Promise<void> = Promise.resolve();
  private writerReconnectTimer: NodeJS.Timeout | null = null;
  private draftPreparations = new Map<string, DraftPreparation>();
  private cancelledDrafts = new Set<string>();
  private stopping = false;
  private queue: QueuedMessage[] = [];
  private queuePath = path.join(os.homedir(), ".codex-bridge", "queue.json");
  private runConfigurations = new Map<string, RunConfiguration>();
  private runConfigurationsPath = path.join(
    os.homedir(),
    ".codex-bridge",
    "run-configurations.json",
  );
  private runConfigurationUpdates = new Map<string, Promise<unknown>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private retryAfter = new Map<string, number>();
  private desktopActiveThreads = new Map<string, number>();
  private rolloutWatches = new Map<string, { path: string; watcher: FSWatcher; timer: NodeJS.Timeout | null; lastUsedAt: number }>();
  private runOptionsCache = new Map<string, { expiresAt: number; value: RunOptions }>();

  constructor(readonly desktopIntegration = new DesktopIntegrationService()) {
    super();
  }

  async start() {
    this.stopping = false;
    await Promise.all([this.loadQueue(), this.loadRunConfigurations()]);
    this.rpc.on("notification", (message: RpcMessage) => this.onNotification(message));
    this.rpc.on("serverRequest", (message: RpcMessage) => this.onServerRequest(message));
    this.rpc.on("diagnostic", (message: string) => this.emit("diagnostic", message));
    this.rpc.on("exit", (details) => this.emitEvent("bridge/codexOffline", details));
    await this.rpc.start();
    await this.ensureWriterClient();
    logBridgeEvent("bridge_started", { queuedMessages: this.queue.length });
    this.flushTimer = setInterval(() => void this.flushQueue(), 2_500);
    this.emitEvent("bridge/ready", { queued: this.queue.length });
  }

  async stop() {
    this.stopping = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.writerReconnectTimer) clearTimeout(this.writerReconnectTimer);
    this.writerReconnectTimer = null;
    this.desktopIntegration.close();
    for (const entry of this.rolloutWatches.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.rolloutWatches.clear();
    const writerStarting = this.writerClientStarting;
    const ownerClients = new Set(this.leasedClients);
    for (const client of this.ownerClients.values()) ownerClients.add(client);
    if (this.writerClient) ownerClients.add(this.writerClient);
    if (writerStarting) {
      try {
        ownerClients.add(await writerStarting);
      } catch {
        // A failed warm-up has no live process left to stop.
      }
    }
    this.writerClient = null;
    this.writerClientStarting = null;
    for (const entry of this.draftPreparations.values()) {
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    }
    this.draftPreparations.clear();
    this.cancelledDrafts.clear();
    this.ownerClients.clear();
    this.leasedClients.clear();
    this.activeTurns.clear();
    this.desktopActiveThreads.clear();
    this.approvalClients.clear();
    this.approvals.clear();
    this.runOptionsCache.clear();
    this.runConfigurationUpdates.clear();
    await Promise.allSettled([...ownerClients].map((client) => client.stop()));
    await this.rpc.stop();
  }

  async getRunOptions(cwd = process.cwd(), force = false): Promise<RunOptions> {
    const normalizedCwd = normalizeWorkspacePath(cwd);
    const cached = this.runOptionsCache.get(normalizedCwd);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

    const modelResponse = await this.rpc.request<ModelListResponse>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const models = modelResponse.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        ...model,
        supportedReasoningEfforts: (model.supportedReasoningEfforts || []).filter(
          (candidate) =>
            (reasoningEfforts as readonly string[]).includes(candidate.reasoningEffort),
        ),
      }));
    if (!models.length) throw new Error("Codex did not return any available models");

    let permissionMode: RunOptions["permissionMode"] = "profiles";
    let permissionProfiles: PermissionProfileOption[];
    try {
      const response = await this.rpc.request<PermissionProfileListResponse>(
        "permissionProfile/list",
        { cwd: normalizedCwd, limit: 100 },
      );
      permissionProfiles = response.data;
    } catch (error) {
      permissionMode = "legacy";
      permissionProfiles = fallbackPermissions();
      logBridgeEvent("permission_profiles_legacy_fallback", {
        cwd: normalizedCwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const defaultModel = models.find((model) => model.isDefault) || models[0];
    const defaultEffort =
      defaultModel.defaultReasoningEffort ||
      defaultModel.supportedReasoningEfforts[0]?.reasoningEffort ||
      "medium";
    const defaultPermissions =
      permissionProfiles.find((profile) => profile.id === ":workspace" && profile.allowed) ||
      permissionProfiles.find((profile) => profile.allowed);
    if (!defaultPermissions)
      throw new Error("No Codex permission profile is allowed for this workspace");

    const value: RunOptions = {
      models,
      permissionProfiles,
      defaults: {
        model: defaultModel.model,
        effort: defaultEffort,
        permissions: defaultPermissions.id,
      },
      permissionMode,
    };
    this.runOptionsCache.set(normalizedCwd, {
      expiresAt: Date.now() + 30_000,
      value,
    });
    return value;
  }

  private async resolveRunConfiguration(input: unknown, cwd: string) {
    const options = await this.getRunOptions(cwd);
    const configuration = normalizeRunConfiguration(input, options);
    return {
      configuration,
      overrides: toCodexRunOverrides(configuration, options.permissionMode),
    };
  }

  private threadStartOverrides(overrides: CodexRunOverrides = {}) {
    const sandbox = overrides.sandboxPolicy
      ? overrides.sandboxPolicy.type === "readOnly"
        ? "read-only"
        : overrides.sandboxPolicy.type === "dangerFullAccess"
          ? "danger-full-access"
          : "workspace-write"
      : undefined;
    return {
      ...(overrides.model ? { model: overrides.model } : {}),
      ...(overrides.permissions
        ? { permissions: overrides.permissions }
        : { sandbox: sandbox || "workspace-write" }),
    };
  }

  async listThreads(params: Record<string, unknown> = {}) {
    const response = await this.rpc.request<ThreadListResponse>("thread/list", {
      limit: 100,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      useStateDbOnly: true,
      ...params,
    });
    return {
      ...response,
      data: response.data
        .filter(
          (thread) =>
            ![...this.draftPreparations.values()].some(
              (entry) => entry.prepared?.thread.id === thread.id,
            ),
        )
        .map((thread) => ({
          ...thread,
          bridgeActive: this.activeTurns.has(thread.id),
          bridgeOwned: this.ownerClients.has(thread.id),
          desktopActive: this.desktopActiveThreads.has(thread.id),
          queueLength: this.queue.filter((item) => item.threadId === thread.id).length,
        })),
    };
  }

  async readThread(threadId: string, includeTurns = true, waitForLoadMs = 0): Promise<ThreadDetail> {
    const deadline = Date.now() + waitForLoadMs;
    let response: ThreadReadResponse;
    for (;;) {
      try {
        response = await this.rpc.request<ThreadReadResponse>("thread/read", { threadId, includeTurns });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/thread not loaded|rollout .* is empty|failed to read session metadata/i.test(message) ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    const rollout = this.reconcileDesktopActivity(threadId, await inspectRollout(response.thread.path));
    this.watchRollout(threadId, response.thread.path);
    const goal = await this.getThreadGoal(threadId).catch((error) => {
      logBridgeEvent("thread_goal_read_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    return {
      thread: response.thread,
      goal,
      handoff: {
        ...rollout,
        bridgeActive: this.activeTurns.has(threadId),
        bridgeOwned: this.ownerClients.has(threadId),
        desktopActive: this.desktopActiveThreads.has(threadId),
        bridgeTurnId: this.activeTurns.get(threadId) ?? null,
        queueLength: this.queue.filter((item) => item.threadId === threadId).length,
        preferredRunConfiguration: this.runConfigurations.get(threadId) || null,
      },
    };
  }

  private goalClient(threadId: string) {
    return this.ownerClients.get(threadId) || this.rpc;
  }

  async getThreadGoal(threadId: string) {
    const response = await this.goalClient(threadId).request<ThreadGoalResponse>(
      "thread/goal/get",
      { threadId },
    );
    return response.goal;
  }

  async setThreadGoal(
    threadId: string,
    update: {
      objective?: string;
      status?: ThreadGoalStatus;
      tokenBudget?: number | null;
    },
  ) {
    const objective = update.objective?.trim();
    if (update.objective !== undefined && !objective)
      throw new Error("Goal 目标不能为空");
    if (objective && objective.length > 4_000)
      throw new Error("Goal 目标不能超过 4000 个字符");
    const response = await this.goalClient(threadId).request<ThreadGoalResponse>(
      "thread/goal/set",
      {
        threadId,
        ...(objective ? { objective } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.tokenBudget !== undefined
          ? { tokenBudget: update.tokenBudget }
          : {}),
      },
    );
    if (response.goal)
      this.emitEvent("bridge/goalUpdated", { threadId, goal: response.goal });
    return response.goal;
  }

  async clearThreadGoal(threadId: string) {
    await this.goalClient(threadId).request("thread/goal/clear", { threadId });
    this.emitEvent("bridge/goalCleared", { threadId });
    return { cleared: true };
  }

  async setThreadRunConfiguration(
    threadId: string,
    input: RunConfiguration,
    cwd = process.cwd(),
  ) {
    const previous = this.runConfigurationUpdates.get(threadId) || Promise.resolve();
    const update = previous
      .catch(() => undefined)
      .then(() => this.applyThreadRunConfiguration(threadId, input, cwd));
    this.runConfigurationUpdates.set(threadId, update);
    try {
      return await update;
    } finally {
      if (this.runConfigurationUpdates.get(threadId) === update)
        this.runConfigurationUpdates.delete(threadId);
    }
  }

  private async applyThreadRunConfiguration(
    threadId: string,
    input: RunConfiguration,
    cwd: string,
  ) {
    const options = await this.getRunOptions(cwd);
    const patch = normalizeRunConfiguration(input, options) || {};
    const baseline =
      this.runConfigurations.get(threadId) ||
      options.defaults;
    const configuration = normalizeRunConfiguration(
      { ...baseline, ...patch },
      options,
    );
    if (!configuration) throw new RunConfigurationError("A Codex run configuration is required");

    this.runConfigurations.set(threadId, configuration);
    let queueChanged = false;
    this.queue = this.queue.map((item) => {
      if (item.threadId !== threadId) return item;
      queueChanged = true;
      return { ...item, runConfiguration: configuration };
    });
    await Promise.all([
      this.saveRunConfigurations(),
      ...(queueChanged ? [this.saveQueue()] : []),
    ]);

    const sync = await this.syncThreadRunConfiguration(threadId, configuration);
    logBridgeEvent("thread_run_configuration_updated", {
      threadId,
      model: configuration.model,
      effort: configuration.effort,
      permissions: configuration.permissions,
      synced: sync.synced,
      via: sync.via,
      currentTurnChanged: false,
    });
    this.emitEvent("bridge/runConfigurationUpdated", {
      threadId,
      configuration,
      ...sync,
      currentTurnChanged: false,
    });
    return {
      configuration,
      ...sync,
      currentTurnChanged: false,
      appliesTo: "next-turn" as const,
    };
  }

  private async syncThreadRunConfiguration(
    threadId: string,
    configuration: RunConfiguration,
  ): Promise<{ synced: boolean; via: "desktop" | "app-server" | "pending" }> {
    const threadSettings = {
      ...(configuration.model ? { model: configuration.model } : {}),
      ...(configuration.effort ? { effort: configuration.effort } : {}),
    };
    if (!Object.keys(threadSettings).length) return { synced: true, via: "app-server" };

    try {
      const ownerClientId = await this.desktopIntegration.findThreadOwner("local", threadId);
      if (ownerClientId) {
        await this.desktopIntegration.updateThreadSettings(
          ownerClientId,
          threadId,
          threadSettings,
        );
        return { synced: true, via: "desktop" };
      }
    } catch (error) {
      logBridgeEvent("desktop_thread_settings_sync_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.desktopIntegration.close();
    }

    try {
      await this.rpc.request("thread/settings/update", { threadId, ...threadSettings });
      return { synced: true, via: "app-server" };
    } catch (error) {
      logBridgeEvent("app_server_thread_settings_sync_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { synced: false, via: "pending" };
    }
  }

  async createThread(input: {
    cwd?: string;
    text?: string;
    draftId?: string;
    runConfiguration?: RunConfiguration;
  }) {
    let client: CodexRpcClient | null = null;
    let threadId: string | null = null;
    const cwd = input.cwd || process.cwd();
    const text = input.text?.trim() || "";
    try {
      const resolved = input.runConfiguration
        ? await this.resolveRunConfiguration(input.runConfiguration, cwd)
        : null;
      if (text) {
        const prepared = input.draftId
          ? await this.claimDraft(input.draftId, cwd)
          : await this.createPreparedThread(cwd);
        client = prepared.client;
        threadId = prepared.thread.id;
        this.ownerClients.set(threadId, client);
        await this.startTurnWithClient(
          client,
          threadId,
          buildCodexInput(text),
          false,
          undefined,
          resolved?.overrides,
        );
        if (resolved?.configuration)
          await this.rememberRunConfiguration(threadId, resolved.configuration);
        return prepared.thread;
      }

      client = await this.createOwnerClient();
      const response = await client.request<ThreadResumeResponse>("thread/start", {
        cwd,
        approvalPolicy: "on-request",
        ...this.threadStartOverrides(resolved?.overrides),
        serviceName: "codex_bridge",
        // Keep Bridge-created tasks indistinguishable from tasks created by the
        // desktop UI. Custom source labels are persisted, but Codex Desktop does
        // not include unknown labels in every task/sidebar query.
        threadSource: "user",
      });
      threadId = response.thread.id;
      this.ownerClients.set(threadId, client);
      if (resolved?.configuration)
        await this.rememberRunConfiguration(threadId, resolved.configuration);
      await this.releaseOwnedThread(threadId, client);
      return response.thread;
    } catch (error) {
      if (client && threadId && this.ownerClients.get(threadId) === client) {
        await this.releaseOwnedThread(threadId, client);
      } else if (client) {
        await this.stopLeasedClient(client, threadId || undefined);
      }
      throw error;
    }
  }

  async prepareDraft(draftId: string, cwd: string) {
    const normalizedId = draftId.trim();
    const normalizedCwd = normalizeWorkspacePath(cwd);
    if (!normalizedId) throw new Error("Draft ID is required");
    if (this.cancelledDrafts.has(normalizedId)) throw new Error("This draft was cancelled");

    const current = this.draftPreparations.get(normalizedId);
    if (current?.cwd === normalizedCwd && !current.claimed) return current.promise;
    if (current) this.removeDraft(normalizedId);

    const entry: DraftPreparation = {
      cwd: normalizedCwd,
      promise: null as unknown as Promise<PreparedThread>,
      prepared: null,
      claimed: false,
      cleanupTimer: null,
    };
    entry.promise = this.createPreparedThread(normalizedCwd)
      .then(async (prepared) => {
        if (this.draftPreparations.get(normalizedId) !== entry && !entry.claimed) {
          await this.unsubscribePreparedThread(prepared);
          throw new Error("Draft workspace changed while the task was being prepared");
        }
        entry.prepared = prepared;
        if (!entry.claimed) {
          entry.cleanupTimer = setTimeout(() => this.discardDraft(normalizedId), 30 * 60_000);
          entry.cleanupTimer?.unref();
        }
        logBridgeEvent("draft_thread_ready", { draftId: normalizedId, threadId: prepared.thread.id, cwd: normalizedCwd });
        this.emitEvent("bridge/draftThreadReady", { draftId: normalizedId, cwd: normalizedCwd });
        return prepared;
      })
      .catch((error) => {
        if (this.draftPreparations.get(normalizedId) === entry)
          this.draftPreparations.delete(normalizedId);
        throw error;
      });
    this.draftPreparations.set(normalizedId, entry);
    return entry.promise;
  }

  discardDraft(draftId: string) {
    this.cancelledDrafts.add(draftId);
    const cancellationTimer = setTimeout(() => this.cancelledDrafts.delete(draftId), 5 * 60_000);
    cancellationTimer.unref();
    return this.removeDraft(draftId);
  }

  private removeDraft(draftId: string) {
    const entry = this.draftPreparations.get(draftId);
    if (!entry || entry.claimed) return false;
    this.draftPreparations.delete(draftId);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    void entry.promise.then((prepared) => this.unsubscribePreparedThread(prepared)).catch(() => undefined);
    logBridgeEvent("draft_thread_discarded", { draftId, cwd: entry.cwd });
    return true;
  }

  async sendMessage(
    threadId: string,
    text: string,
    options: {
      force?: boolean;
      queueIfBusy?: boolean;
      steerIfBusy?: boolean;
      runConfiguration?: RunConfiguration;
      imagePaths?: string[];
      mentions?: CodexMention[];
    } = {},
  ) {
    const receivedAt = Date.now();
    const normalized = text.trim();
    const imagePaths = [...new Set(options.imagePaths || [])].filter(Boolean).slice(0, 4);
    const mentions = [...new Map(
      (options.mentions || [])
        .filter((mention) => mention.name && mention.path)
        .map((mention) => [mention.path, mention]),
    ).values()].slice(0, 8);
    if (!normalized && !imagePaths.length && !mentions.length)
      throw new Error("Message cannot be empty");
    const input = buildCodexInput(normalized, imagePaths, mentions);
    logBridgeEvent("message_received", {
      threadId,
      textLength: normalized.length,
      attachmentCount: imagePaths.length,
      contextCount: mentions.length,
    });

    let detail: ThreadDetail | null = null;
    const preferredRunConfiguration = this.runConfigurations.get(threadId);
    const requestedRunConfiguration = options.runConfiguration
      ? { ...preferredRunConfiguration, ...options.runConfiguration }
      : preferredRunConfiguration;
    let resolved: {
      configuration: RunConfiguration | undefined;
      overrides: CodexRunOverrides;
    } | null = null;
    if (requestedRunConfiguration) {
      detail = await this.readThread(threadId, false);
      resolved = await this.resolveRunConfiguration(
        {
          ...detail.handoff.runConfiguration,
          ...requestedRunConfiguration,
        },
        detail.thread.cwd,
      );
    }
    if (options.runConfiguration && resolved?.configuration)
      await this.rememberRunConfiguration(threadId, resolved.configuration);

    if (this.activeTurns.has(threadId)) {
      const changesActiveConfiguration = Boolean(
        resolved?.configuration &&
        !sameRunConfiguration(detail?.handoff.runConfiguration, resolved.configuration),
      );
      if (options.steerIfBusy !== false && !changesActiveConfiguration) {
        const turnId = this.activeTurns.get(threadId)!;
        const client = this.ownerClients.get(threadId);
        if (client) {
          try {
            const response = await client.request<{ turnId: string }>("turn/steer", {
              threadId,
              expectedTurnId: turnId,
              input,
            });
            logBridgeEvent("message_steered", {
              threadId,
              turnId: response.turnId,
              durationMs: Date.now() - receivedAt,
            });
            this.emitEvent("bridge/messageSteered", { threadId, turnId: response.turnId });
            return { queued: false, steered: true, via: "bridge" as const, turnId: response.turnId };
          } catch (error) {
            logBridgeEvent("message_steer_failed", {
              threadId,
              turnId,
              error: error instanceof Error ? error.message : String(error),
            });
            if (options.queueIfBusy === false) throw error;
          }
        }
      }
      if (options.queueIfBusy === false) throw new Error("This thread is already running in Codex Bridge");
      logBridgeEvent("message_queued", { threadId, reason: "bridge-active" });
      return {
        queued: true,
        item: await this.enqueue(
          threadId,
          normalized,
          resolved?.configuration,
          imagePaths,
          mentions,
        ),
        reason: "bridge-active",
      };
    }

    detail ||= await this.readThread(threadId, false);
    if (!options.force && detail.handoff.state !== "idle") {
      if (options.queueIfBusy === false) throw new Error("The desktop turn has not completed yet");
      logBridgeEvent("message_queued", { threadId, reason: detail.handoff.state, rolloutReason: detail.handoff.reason });
      return {
        queued: true,
        item: await this.enqueue(
          threadId,
          normalized,
          resolved?.configuration,
          imagePaths,
          mentions,
        ),
        reason: detail.handoff.state,
      };
    }

    try {
      const dispatch = await this.dispatchMessage(
        threadId,
        input,
        resolved?.overrides,
        resolved?.configuration,
      );
      logBridgeEvent("message_started", {
        threadId,
        via: dispatch.via,
        turnId: dispatch.turn && typeof dispatch.turn === "object" && "id" in dispatch.turn ? dispatch.turn.id : null,
        durationMs: Date.now() - receivedAt,
      });
      return { queued: false, ...dispatch };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.force && /already has an active writer/i.test(message)) {
        logBridgeEvent("active_writer_race_queued", { threadId });
        return {
          queued: true,
          item: await this.enqueue(
            threadId,
            normalized,
            resolved?.configuration,
            imagePaths,
            mentions,
          ),
          reason: "active-writer",
        };
      }
      logBridgeEvent("message_start_failed", { threadId, error: message });
      throw error;
    }
  }

  async interrupt(threadId: string) {
    const turnId = this.activeTurns.get(threadId);
    if (turnId) {
      const client = this.ownerClients.get(threadId);
      if (!client) throw new Error("The Codex Bridge writer is no longer available");
      await client.request("turn/interrupt", { threadId, turnId });
      return { interrupted: true, turnId, via: "bridge" as const };
    }

    if (!this.desktopActiveThreads.has(threadId))
      throw new Error("No active Codex turn is available to stop");
    const ownerClientId = await this.desktopIntegration.findThreadOwner(
      "local",
      threadId,
    );
    if (!ownerClientId)
      throw new Error("The Codex Desktop window handling this task is unavailable");
    const result = await this.desktopIntegration.interruptTurn(
      ownerClientId,
      threadId,
    );
    logBridgeEvent("desktop_turn_interrupt_requested", {
      threadId,
      ownerClientId,
      interruptedTurnId: result?.interruptedTurnId || null,
    });
    this.emitEvent("bridge/desktopTurnInterruptRequested", {
      threadId,
      desktopActive: true,
      interruptedTurnId: result?.interruptedTurnId || null,
    });
    return {
      interrupted: true,
      turnId: result?.interruptedTurnId || null,
      via: "desktop" as const,
    };
  }

  getQueue(threadId?: string) {
    const queue = threadId ? this.queue.filter((item) => item.threadId === threadId) : this.queue;
    return queue.map((item) => this.publicQueueItem(item));
  }

  async removeQueuedMessage(id: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.id !== id);
    if (this.queue.length === before) return false;
    await this.saveQueue();
    this.emitEvent("bridge/queueUpdated", { queue: this.getQueue() });
    return true;
  }

  async updateQueuedMessage(id: string, update: QueueUpdate) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = this.queue[index];
    if (typeof update.text === "string") {
      const text = update.text.trim();
      if (!text && !current.imagePaths?.length) throw new Error("Queued message cannot be empty");
      this.queue[index] = { ...current, text };
    }
    if (update.direction) {
      const step = update.direction === "up" ? -1 : 1;
      let candidate = index + step;
      while (candidate >= 0 && candidate < this.queue.length && this.queue[candidate].threadId !== current.threadId) {
        candidate += step;
      }
      if (candidate >= 0 && candidate < this.queue.length) {
        [this.queue[index], this.queue[candidate]] = [this.queue[candidate], this.queue[index]];
      }
    }
    await this.saveQueue();
    this.emitEvent("bridge/queueUpdated", { queue: this.getQueue() });
    const updated = this.queue.find((item) => item.id === id);
    return updated ? this.publicQueueItem(updated) : null;
  }

  listApprovals() {
    return [...this.approvals.values()];
  }

  respondToApproval(id: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const pending = this.approvals.get(id);
    if (!pending) throw new Error("Approval request is no longer pending");
    const client = this.approvalClients.get(id);
    if (!client) throw new Error("The Codex Bridge writer is no longer available");

    if (pending.method === "execCommandApproval" || pending.method === "applyPatchApproval") {
      const legacyDecision =
        decision === "accept"
          ? "approved"
          : decision === "acceptForSession"
            ? "approved_for_session"
            : decision === "cancel"
              ? "abort"
              : { denied: { rejection: "Declined from Codex Bridge" } };
      client.respond(pending.rpcId, { decision: legacyDecision });
    } else {
      client.respond(pending.rpcId, { decision });
    }

    this.approvals.delete(id);
    this.approvalClients.delete(id);
    this.emitEvent("bridge/approvalResolved", { id, decision });
    return { resolved: true };
  }

  private async startTurn(
    threadId: string,
    input: CodexInput[],
    resume = true,
    overrides: CodexRunOverrides = {},
  ) {
    const client = await this.createOwnerClient();
    try {
      return await this.startTurnWithClient(
        client,
        threadId,
        input,
        resume,
        undefined,
        overrides,
      );
    } catch (error) {
      if (this.ownerClients.get(threadId) === client) {
        await this.releaseOwnedThread(threadId, client);
      } else {
        await this.stopLeasedClient(client, threadId);
      }
      throw error;
    }
  }

  private async startTurnWithClient(
    client: CodexRpcClient,
    threadId: string,
    input: CodexInput[],
    resume: boolean,
    cwd?: string,
    overrides: CodexRunOverrides = {},
  ) {
    if (resume) await client.request<ThreadResumeResponse>("thread/resume", { threadId });
    this.ownerClients.set(threadId, client);
    const response = await client.request<TurnStartResponse>("turn/start", {
      threadId,
      input,
      ...(cwd ? { cwd } : {}),
      ...overrides,
    });
    this.activeTurns.set(threadId, response.turn.id);
    this.emitEvent("bridge/turnOwned", { threadId, turnId: response.turn.id });
    return response.turn;
  }

  private async dispatchMessage(
    threadId: string,
    input: CodexInput[],
    overrides: CodexRunOverrides = {},
    configuration?: RunConfiguration,
  ) {
    const ownerLookupStartedAt = Date.now();
    try {
      const ownerClientId = await this.desktopIntegration.findThreadOwner("local", threadId);
      logBridgeEvent("desktop_owner_checked", {
        threadId,
        found: Boolean(ownerClientId),
        durationMs: Date.now() - ownerLookupStartedAt,
      });
      if (ownerClientId) {
        const desktopStartAt = Date.now();
        if (configuration) {
          await this.desktopIntegration.updateThreadSettings(
            ownerClientId,
            threadId,
            {
              ...(configuration.model ? { model: configuration.model } : {}),
              ...(configuration.effort ? { effort: configuration.effort } : {}),
            },
          );
        }
        const result = await this.desktopIntegration.startTurn(
          ownerClientId,
          threadId,
          input,
          overrides,
        );
        this.desktopActiveThreads.set(threadId, desktopStartAt);
        logBridgeEvent("desktop_turn_dispatched", {
          threadId,
          durationMs: Date.now() - desktopStartAt,
        });
        this.emitEvent("bridge/desktopTurnStarted", { threadId, state: "active", desktopActive: true });
        return { via: "desktop" as const, turn: result };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active|already.*turn|in progress/i.test(message)) throw error;
      logBridgeEvent("desktop_ipc_unavailable", { threadId, error: message });
      this.desktopIntegration.close();
    }
    const bridgeStartAt = Date.now();
    const turn = await this.startTurn(threadId, input, true, overrides);
    logBridgeEvent("bridge_turn_dispatched", {
      threadId,
      durationMs: Date.now() - bridgeStartAt,
    });
    return { via: "bridge" as const, turn };
  }

  private async enqueue(
    threadId: string,
    text: string,
    runConfiguration?: RunConfiguration,
    imagePaths: string[] = [],
    mentions: CodexMention[] = [],
  ) {
    const item: QueuedMessage = {
      id: randomUUID(),
      threadId,
      text,
      createdAt: Date.now(),
      ...(runConfiguration ? { runConfiguration } : {}),
      ...(imagePaths.length ? { imagePaths } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    this.queue.push(item);
    await this.saveQueue();
    this.emitEvent("bridge/queueUpdated", { queue: this.getQueue() });
    return this.publicQueueItem(item);
  }

  private async flushQueue() {
    if (this.flushing || !this.queue.length || !this.rpc.isStarted) return;
    this.flushing = true;
    try {
      const firstByThread = new Map<string, QueuedMessage>();
      for (const item of this.queue) if (!firstByThread.has(item.threadId)) firstByThread.set(item.threadId, item);

      for (const item of firstByThread.values()) {
        if (this.activeTurns.has(item.threadId)) continue;
        if ((this.retryAfter.get(item.threadId) || 0) > Date.now()) continue;
        const detail = await this.readThread(item.threadId, false);
        const settledFor = detail.handoff.lastActivityAt ? Date.now() - detail.handoff.lastActivityAt : 0;
        if (detail.handoff.state !== "idle" || settledFor < 1_500) continue;

        try {
          const resolved = item.runConfiguration
            ? await this.resolveRunConfiguration(item.runConfiguration, detail.thread.cwd)
            : null;
          const dispatch = await this.dispatchMessage(
            item.threadId,
            buildCodexInput(item.text, item.imagePaths, item.mentions),
            resolved?.overrides,
            resolved?.configuration,
          );
          this.queue = this.queue.filter((candidate) => candidate.id !== item.id);
          await this.saveQueue();
          this.retryAfter.delete(item.threadId);
          logBridgeEvent("queued_message_started", { threadId: item.threadId, queueId: item.id, via: dispatch.via });
          this.emitEvent("bridge/queuedMessageStarted", { ...this.publicQueueItem(item), via: dispatch.via });
          this.emitEvent("bridge/queueUpdated", { queue: this.getQueue() });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const activeWriter = /already has an active writer/i.test(errorMessage);
          this.retryAfter.set(item.threadId, Date.now() + (activeWriter ? 10_000 : 5_000));
          logBridgeEvent(activeWriter ? "queue_waiting_for_active_writer" : "queue_retry_failed", {
            threadId: item.threadId,
            queueId: item.id,
            error: errorMessage,
          });
          this.emitEvent("bridge/queueError", {
            item: this.publicQueueItem(item),
            message: error instanceof Error ? error.message : "Unable to start queued message",
          });
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private publicQueueItem(item: QueuedMessage): PublicQueuedMessage {
    const { imagePaths, mentions, ...publicItem } = item;
    return {
      ...publicItem,
      ...(imagePaths?.length ? { attachmentCount: imagePaths.length } : {}),
      ...(mentions?.length ? { contextCount: mentions.length } : {}),
    };
  }

  private onNotification(message: RpcMessage, client = this.rpc) {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turn = (params.turn ?? null) as { id?: string } | null;

    const isOwner = Boolean(threadId && this.ownerClients.get(threadId) === client);
    if (message.method === "turn/started" && threadId && turn?.id && isOwner) {
      this.activeTurns.set(threadId, turn.id);
      logBridgeEvent("turn_started", { threadId, turnId: turn.id });
    }
    if ((message.method === "turn/completed" || message.method === "turn/aborted") && threadId && isOwner) {
      this.activeTurns.delete(threadId);
      logBridgeEvent(message.method === "turn/completed" ? "turn_completed" : "turn_aborted", { threadId });
      setTimeout(() => void this.releaseOwnedThread(threadId, client), 500);
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (requestId !== undefined) {
        for (const [id, pending] of this.approvals) {
          if (pending.rpcId === requestId && this.approvalClients.get(id) === client) {
            this.approvals.delete(id);
            this.approvalClients.delete(id);
          }
        }
      }
    }
    this.emitEvent(message.method || "codex/notification", message.params);
  }

  private onServerRequest(message: RpcMessage, client = this.rpc) {
    if (message.id === undefined || !message.method) return;
    const supportedApprovals = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]);
    if (!supportedApprovals.has(message.method)) {
      client.respondError(message.id, -32601, `Codex Bridge does not implement ${message.method}`);
      this.emitEvent("bridge/unsupportedServerRequest", { method: message.method });
      return;
    }
    const id = randomUUID();
    const approval: PendingApproval = {
      id,
      rpcId: message.id,
      method: message.method,
      params: message.params,
      createdAt: Date.now(),
    };
    this.approvals.set(id, approval);
    this.approvalClients.set(id, client);
    this.emitEvent("bridge/approvalRequested", approval);
  }

  private emitEvent(method: string, params: unknown) {
    this.emit("event", { method, params, at: Date.now() });
  }

  private reconcileDesktopActivity(threadId: string, rollout: RolloutState): RolloutState {
    const startedAt = this.desktopActiveThreads.get(threadId);
    if (rollout.state === "active") {
      if (!startedAt) {
        this.desktopActiveThreads.set(threadId, rollout.lastActivityAt || Date.now());
        this.emitEvent("bridge/desktopTurnStarted", {
          threadId,
          state: "active",
          desktopActive: true,
          observedFromRollout: true,
        });
      }
      return rollout;
    }
    if (rollout.state === "idle" && startedAt) {
      // A desktop turn can be acknowledged a fraction before its first rollout
      // record is appended. Do not let the previous turn's final marker clear
      // the newly acknowledged activity.
      if (rollout.lastActivityAt && rollout.lastActivityAt >= startedAt) {
        this.desktopActiveThreads.delete(threadId);
        this.emitEvent("bridge/desktopTurnEnded", { threadId, state: "idle", desktopActive: false });
        return rollout;
      }
      return {
        state: "active",
        lastActivityAt: rollout.lastActivityAt,
        reason: "A desktop turn was dispatched and is waiting for its first persisted update",
      };
    }
    if (startedAt) {
      return {
        state: "active",
        lastActivityAt: rollout.lastActivityAt,
        reason: "A desktop turn is active",
      };
    }
    return rollout;
  }

  private async releaseOwnedThread(threadId: string, client: CodexRpcClient) {
    if (this.ownerClients.get(threadId) !== client) return;
    // A completed turn is released after a short grace period. Same-turn steering
    // keeps the active turn id in the map, so only the final completion reaches
    // this process teardown path.
    if (this.activeTurns.has(threadId)) return;
    let unsubscribeStatus: ThreadUnsubscribeResponse["status"] | "failed" = "failed";
    try {
      const response = await client.request<ThreadUnsubscribeResponse>("thread/unsubscribe", { threadId }, 10_000);
      unsubscribeStatus = response.status;
    } catch (error) {
      logBridgeEvent("bridge_writer_unsubscribe_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.ownerClients.get(threadId) === client) this.ownerClients.delete(threadId);
      this.activeTurns.delete(threadId);
      await this.stopLeasedClient(client, threadId);
      logBridgeEvent("bridge_writer_released", { threadId, unsubscribeStatus, processStopped: true });
      this.emitEvent("bridge/writerReleased", { threadId });
      void this.preloadDesktopThread(threadId);
      setTimeout(() => void this.flushQueue(), 1_000);
    }
  }

  async preloadDesktopThread(threadId: string, waitForReadyMs = 0) {
    return this.desktopIntegration.preloadThread(threadId, waitForReadyMs);
  }

  private async createOwnerClient() {
    return this.acquireWriterClient();
  }

  private async acquireWriterClient() {
    let unlock!: () => void;
    const previousAcquisition = this.writerAcquisition;
    this.writerAcquisition = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previousAcquisition;
    try {
      const client = await this.ensureWriterClient();
      if (this.writerClient === client) this.writerClient = null;
      this.leasedClients.add(client);
      logBridgeEvent("bridge_writer_leased", { leasedClients: this.leasedClients.size });
      void this.ensureWriterClient().catch((error) => {
        logBridgeEvent("bridge_writer_restart_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleWriterReconnect();
      });
      return client;
    } finally {
      unlock();
    }
  }

  private async stopLeasedClient(client: CodexRpcClient, threadId?: string) {
    this.leasedClients.delete(client);
    for (const [id, approvalClient] of this.approvalClients) {
      if (approvalClient !== client) continue;
      this.approvalClients.delete(id);
      this.approvals.delete(id);
    }
    await client.stop();
    logBridgeEvent("bridge_writer_stopped", {
      threadId: threadId || null,
      leasedClients: this.leasedClients.size,
    });
  }

  private async ensureWriterClient() {
    if (this.writerClient?.isStarted) return this.writerClient;
    if (this.writerClientStarting) return this.writerClientStarting;

    const starting = this.startWriterClient();
    this.writerClientStarting = starting;
    try {
      return await starting;
    } finally {
      if (this.writerClientStarting === starting) this.writerClientStarting = null;
    }
  }

  private async startWriterClient() {
    const client = new CodexRpcClient();
    client.on("notification", (message: RpcMessage) => this.onNotification(message, client));
    client.on("serverRequest", (message: RpcMessage) => this.onServerRequest(message, client));
    client.on("diagnostic", (message: string) => this.emit("diagnostic", message));
    client.on("exit", (details) => {
      if (this.writerClient === client) this.writerClient = null;
      this.leasedClients.delete(client);
      for (const [draftId, entry] of this.draftPreparations) {
        if (entry.prepared?.client !== client) continue;
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        this.draftPreparations.delete(draftId);
      }
      const affectedThreads: string[] = [];
      for (const [threadId, owner] of this.ownerClients) {
        if (owner !== client) continue;
        affectedThreads.push(threadId);
        this.ownerClients.delete(threadId);
        this.activeTurns.delete(threadId);
      }
      for (const [id, approvalClient] of this.approvalClients) {
        if (approvalClient !== client) continue;
        this.approvalClients.delete(id);
        this.approvals.delete(id);
      }
      logBridgeEvent("bridge_writer_process_exited", { affectedThreads, details });
      this.emitEvent("bridge/writerOffline", { affectedThreads, details });
      this.scheduleWriterReconnect();
    });
    try {
      await client.start();
    } catch (error) {
      await client.stop();
      throw error;
    }
    if (this.stopping) {
      await client.stop();
      throw new Error("Codex Bridge is stopping");
    }
    this.writerClient = client;
    logBridgeEvent("bridge_writer_ready", { warmSpare: true });
    this.emitEvent("bridge/writerReady", { warmSpare: true });
    return client;
  }

  private scheduleWriterReconnect() {
    if (this.stopping || this.writerReconnectTimer) return;
    this.writerReconnectTimer = setTimeout(() => {
      this.writerReconnectTimer = null;
      void this.ensureWriterClient().catch((error) => {
        logBridgeEvent("bridge_writer_restart_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleWriterReconnect();
      });
    }, 1_000);
  }

  private async claimDraft(draftId: string, cwd: string): Promise<PreparedThread> {
    const normalizedId = draftId.trim();
    const normalizedCwd = normalizeWorkspacePath(cwd);
    let entry = this.draftPreparations.get(normalizedId);
    if (!entry || entry.cwd !== normalizedCwd) {
      if (entry) this.removeDraft(normalizedId);
      await this.prepareDraft(normalizedId, normalizedCwd);
      entry = this.draftPreparations.get(normalizedId);
    }
    if (!entry) throw new Error("The prepared draft is no longer available");
    if (entry.claimed) throw new Error("This draft has already been submitted");

    entry.claimed = true;
    this.draftPreparations.delete(normalizedId);
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    const prepared = await entry.promise;
    logBridgeEvent("draft_thread_claimed", {
      draftId: normalizedId,
      threadId: prepared.thread.id,
      cwd: normalizedCwd,
    });
    return prepared;
  }

  private async createPreparedThread(cwd: string): Promise<PreparedThread> {
    const client = await this.acquireWriterClient();
    const response = await client.request<ThreadResumeResponse>("thread/start", {
      cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "codex_bridge",
      threadSource: "user",
    });
    return { thread: response.thread, client };
  }

  private async unsubscribePreparedThread(prepared: PreparedThread) {
    try {
      await prepared.client.request<ThreadUnsubscribeResponse>(
        "thread/unsubscribe",
        { threadId: prepared.thread.id },
        10_000,
      );
    } catch (error) {
      logBridgeEvent("draft_thread_unsubscribe_failed", {
        threadId: prepared.thread.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.stopLeasedClient(prepared.client, prepared.thread.id);
    }
  }

  private async loadQueue() {
    try {
      const parsed = JSON.parse(await readFile(this.queuePath, "utf8"));
      this.queue = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.queue = [];
    }
  }

  private async saveQueue() {
    await mkdir(path.dirname(this.queuePath), { recursive: true });
    await writeFile(this.queuePath, JSON.stringify(this.queue, null, 2), "utf8");
  }

  private async loadRunConfigurations() {
    try {
      const parsed = JSON.parse(
        await readFile(this.runConfigurationsPath, "utf8"),
      ) as Record<string, RunConfiguration>;
      this.runConfigurations = new Map(
        Object.entries(parsed).filter(
          ([threadId, value]) =>
            Boolean(threadId) && value != null && typeof value === "object",
        ),
      );
    } catch {
      this.runConfigurations = new Map();
    }
  }

  private async saveRunConfigurations() {
    await mkdir(path.dirname(this.runConfigurationsPath), { recursive: true });
    await writeFile(
      this.runConfigurationsPath,
      JSON.stringify(Object.fromEntries(this.runConfigurations), null, 2),
      "utf8",
    );
  }

  private async rememberRunConfiguration(
    threadId: string,
    configuration: RunConfiguration,
  ) {
    this.runConfigurations.set(threadId, configuration);
    await this.saveRunConfigurations();
  }

  private watchRollout(threadId: string, rolloutPath: string | null | undefined) {
    if (!rolloutPath) return;
    const current = this.rolloutWatches.get(threadId);
    if (current?.path === rolloutPath) {
      current.lastUsedAt = Date.now();
      return;
    }
    if (current) {
      if (current.timer) clearTimeout(current.timer);
      current.watcher.close();
      this.rolloutWatches.delete(threadId);
    }

    try {
      const entry: { path: string; watcher: FSWatcher; timer: NodeJS.Timeout | null; lastUsedAt: number } = {
        path: rolloutPath,
        watcher: null as unknown as FSWatcher,
        timer: null,
        lastUsedAt: Date.now(),
      };
      entry.watcher = watch(rolloutPath, { persistent: false }, () => {
        entry.lastUsedAt = Date.now();
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void inspectRollout(rolloutPath, { deepFallback: false }).then((state) => {
            const reconciled = this.reconcileDesktopActivity(threadId, state);
            this.emitEvent("bridge/rolloutChanged", {
              threadId,
              ...reconciled,
              desktopActive: this.desktopActiveThreads.has(threadId),
            });
            void this.flushQueue();
          });
        }, 120);
      });
      entry.watcher.on("error", (error) => {
        logBridgeEvent("rollout_watch_failed", { threadId, error: error.message });
        if (entry.timer) clearTimeout(entry.timer);
        entry.watcher.close();
        if (this.rolloutWatches.get(threadId) === entry) this.rolloutWatches.delete(threadId);
      });
      this.rolloutWatches.set(threadId, entry);

      if (this.rolloutWatches.size > 24) {
        const oldest = [...this.rolloutWatches.entries()]
          .filter(([id]) => id !== threadId)
          .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
        if (oldest) {
          if (oldest[1].timer) clearTimeout(oldest[1].timer);
          oldest[1].watcher.close();
          this.rolloutWatches.delete(oldest[0]);
        }
      }
    } catch (error) {
      logBridgeEvent("rollout_watch_failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
