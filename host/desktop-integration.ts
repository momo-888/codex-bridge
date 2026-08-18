import {
  CodexDesktopIpcClient,
  type DesktopThreadSettings,
} from "./codex-ipc";
import {
  CodexProjectRegistrar,
  type CodexProjectCatalog,
  type ProjectRegistrationResult,
  type ThreadProjectPlacement,
} from "./codex-projects";
import { logBridgeEvent } from "./logger";
import type { CodexRunOverrides } from "./run-options";
import type { CodexInput } from "./codex-input";

type DesktopThreadDetail = {
  thread: { cwd: string };
  handoff: {
    bridgeActive: boolean;
    bridgeOwned: boolean;
    desktopActive: boolean;
    state: string;
    queueLength: number;
  };
};

type DesktopIpcGateway = Pick<
  CodexDesktopIpcClient,
  | "close"
  | "findThreadOwner"
  | "startTurn"
  | "interruptTurn"
  | "updateThreadSettings"
  | "announceThreadAvailable"
  | "waitForThreadOwner"
>;

type DesktopProjectGateway = Pick<
  CodexProjectRegistrar,
  "ensure" | "openProject" | "getThreadPlacement" | "revealThread"
> & Partial<Pick<CodexProjectRegistrar, "listProjects">>;

type DesktopIntegrationOptions = {
  ipc?: DesktopIpcGateway;
  projects?: DesktopProjectGateway;
  ownerReadyTimeoutMs?: number;
};

type DesktopOpenBody = {
  opened?: true;
  error?: string;
  projectRegistration?: ProjectRegistrationResult;
  placement?: ThreadProjectPlacement;
  desktopPreloaded?: boolean;
  desktopPreloadRequested?: boolean;
};

export type DesktopOpenResult = {
  status: 200 | 409 | 503;
  body: DesktopOpenBody;
};

function threadIsBusy(detail: DesktopThreadDetail) {
  return (
    detail.handoff.bridgeActive ||
    detail.handoff.bridgeOwned ||
    detail.handoff.desktopActive ||
    detail.handoff.state !== "idle" ||
    detail.handoff.queueLength > 0
  );
}

export class DesktopIntegrationService {
  private readonly ipc: DesktopIpcGateway;
  private readonly projects: DesktopProjectGateway;
  private readonly ownerReadyTimeoutMs: number;

  constructor(options: DesktopIntegrationOptions = {}) {
    this.ipc = options.ipc ?? new CodexDesktopIpcClient();
    this.projects = options.projects ?? new CodexProjectRegistrar();
    this.ownerReadyTimeoutMs = options.ownerReadyTimeoutMs ?? 1_500;
  }

  close() {
    this.ipc.close();
  }

  ensureProject(projectPath: string) {
    return this.projects.ensure(projectPath);
  }

  listProjects(): Promise<CodexProjectCatalog> {
    return this.projects.listProjects?.() ?? Promise.resolve({ data: [], selectedProjectId: null });
  }

  findThreadOwner(hostId: string, threadId: string) {
    return this.ipc.findThreadOwner(hostId, threadId);
  }

  startTurn(
    ownerClientId: string,
    threadId: string,
    input: CodexInput[],
    overrides: CodexRunOverrides = {},
  ) {
    return this.ipc.startTurn(ownerClientId, threadId, input, overrides);
  }

  interruptTurn(
    ownerClientId: string,
    threadId: string,
    expectedTurnId?: string,
  ) {
    return this.ipc.interruptTurn(ownerClientId, threadId, expectedTurnId);
  }

  updateThreadSettings(
    ownerClientId: string,
    threadId: string,
    settings: DesktopThreadSettings,
  ) {
    return this.ipc.updateThreadSettings(ownerClientId, threadId, settings);
  }

  async preloadThread(threadId: string, waitForReadyMs = 0) {
    try {
      await this.ipc.announceThreadAvailable(threadId);
      const ownerClientId =
        waitForReadyMs > 0
          ? await this.ipc.waitForThreadOwner(threadId, waitForReadyMs)
          : null;
      const ready = ownerClientId != null;
      logBridgeEvent("desktop_thread_preload_requested", {
        threadId,
        waitForReadyMs,
        ready,
        ownerClientId,
      });
      return { requested: true, ready };
    } catch (error) {
      logBridgeEvent("desktop_thread_preload_skipped", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { requested: false, ready: false };
    }
  }

  async openThread(
    threadId: string,
    readThread: () => Promise<DesktopThreadDetail>,
  ): Promise<DesktopOpenResult> {
    let detail = await readThread();
    if (threadIsBusy(detail)) {
      return {
        status: 409,
        body: { error: "任务仍在运行或释放中，完成后再在电脑打开" },
      };
    }

    const placement = await this.projects.getThreadPlacement(threadId);
    if (placement === "unknown") {
      return {
        status: 503,
        body: {
          error: "暂时无法读取 Codex 桌面状态，请稍后重试",
          placement,
        },
      };
    }

    // Projectless conversations belong in Desktop's Chats collection. For all
    // other placements, select the cwd project before hydrating the thread.
    const projectRegistration =
      placement === "projectless"
        ? undefined
        : await this.projects.openProject(detail.thread.cwd);
    if (
      projectRegistration?.status === "failed" ||
      projectRegistration?.status === "unsupported"
    ) {
      return {
        status: 503,
        body: {
          error: projectRegistration.message || "无法在电脑 Codex 中打开项目",
          projectRegistration,
          placement,
        },
      };
    }

    const desktopPreload = await this.preloadThread(
      threadId,
      this.ownerReadyTimeoutMs,
    );

    // Project navigation and conversation hydration are asynchronous. Re-read
    // ownership immediately before the deep link to avoid stealing a live task.
    detail = await readThread();
    if (threadIsBusy(detail)) {
      return {
        status: 409,
        body: {
          error: "任务状态刚刚发生变化，已停止自动打开以避免桌面冲突",
          projectRegistration,
          placement,
          desktopPreloaded: desktopPreload.ready,
          desktopPreloadRequested: desktopPreload.requested,
        },
      };
    }

    const opened = await this.projects.revealThread(threadId);
    if (!opened) {
      return {
        status: 503,
        body: {
          error: "无法跳转到电脑端的这个任务",
          projectRegistration,
          placement,
          desktopPreloaded: desktopPreload.ready,
          desktopPreloadRequested: desktopPreload.requested,
        },
      };
    }

    return {
      status: 200,
      body: {
        opened: true,
        projectRegistration,
        placement,
        desktopPreloaded: desktopPreload.ready,
        desktopPreloadRequested: desktopPreload.requested,
      },
    };
  }
}
