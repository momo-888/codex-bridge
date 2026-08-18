"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowClockwise,
  ArrowsIn,
  ArrowsOut,
  Bell,
  Brain,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  Check,
  CheckCircle,
  Clock,
  Copy,
  DesktopTower,
  File as FileIcon,
  Flag,
  Folder,
  FolderOpen,
  Folders,
  Gear,
  HardDrives,
  House,
  ImageSquare,
  List,
  MagnifyingGlass,
  Minus,
  PaperPlaneTilt,
  Pause,
  PencilSimple,
  Play,
  Plus,
  QrCode,
  ShieldCheck,
  Stop,
  TerminalWindow,
  TextAlignLeft,
  Trash,
  Warning,
  WifiHigh,
  WifiSlash,
  Wrench,
  X,
  XCircle,
} from "@phosphor-icons/react";
import Image from "next/image";
import React, {
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  buildTurnTimeline,
  resolveProcessGroupOpen,
  shouldAutomaticallyOpenProcessGroup,
} from "./turn-timeline";
import { openNativeImageViewer } from "./native-bridge";
import {
  countMatchingUserMessages,
  reconcilePendingUserMessages,
  restoreFailedMessage,
  textFromUserContent,
  type PendingUserMessage,
} from "./pending-messages";
import { resolveComposerPrimaryAction } from "./composer-state";
import { collectThreadPages, type ThreadPage } from "./thread-catalog";

type ConnectionSettings = { server: string; token: string };
type PairingCandidate = { server: string; token?: string; code?: string };
type PairingRequestCreated = {
  requestId: string;
  requestSecret: string;
  expiresAt: string;
  expiresIn: number;
  hostname: string;
};
type PairingRequestStatus = {
  status: "pending" | "approved" | "denied";
  expiresAt: string;
  hostname: string;
  token?: string;
};
type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type RunConfiguration = {
  model?: string;
  effort?: ReasoningEffort;
  permissions?: string;
};
type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: ReasoningEffort | null;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  inputModalities: string[];
  isDefault: boolean;
};
type PermissionProfileOption = {
  id: string;
  description: string | null;
  allowed: boolean;
};
type CodexRunOptions = {
  models: ModelOption[];
  permissionProfiles: PermissionProfileOption[];
  defaults: Required<RunConfiguration>;
};
type RunPicker = {
  target: "task" | "new-task";
  kind: "model" | "permissions";
};
type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};
type ThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  source: string | Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: { type: string; activeFlags?: string[] };
  turns: Turn[];
  bridgeActive?: boolean;
  bridgeOwned?: boolean;
  desktopActive?: boolean;
  queueLength?: number;
};
type CodexProjectSummary = {
  id: string;
  name: string;
  rootPaths: string[];
  createdAt: number | null;
  updatedAt: number | null;
  threadIds: string[];
};
type CodexProjectCatalog = {
  data: CodexProjectSummary[];
  selectedProjectId: string | null;
};
type ThreadItem = Record<string, unknown> & { type: string; id?: string };
type LocalMarkdownImage = { source: string; id: string };
type Turn = {
  id: string;
  status: string;
  items: ThreadItem[];
  startedAt?: number | null;
  completedAt?: number | null;
};
type ThreadDetail = {
  thread: ThreadSummary;
  goal: ThreadGoal | null;
  history?: {
    totalTurns: number;
    returnedTurns: number;
    hasEarlierTurns: boolean;
  };
  handoff: {
    state: "idle" | "active" | "unknown";
    reason: string;
    lastActivityAt: number | null;
    bridgeActive: boolean;
    bridgeOwned: boolean;
    desktopActive: boolean;
    bridgeTurnId: string | null;
    queueLength: number;
    runConfiguration: RunConfiguration | null;
    preferredRunConfiguration: RunConfiguration | null;
  };
};
type Approval = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: number;
};
type QueueItem = {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  runConfiguration?: RunConfiguration;
  attachmentCount?: number;
  contextCount?: number;
};
type ComposerAttachment = {
  id: string;
  threadId: string;
  file: File;
  previewUrl: string;
  uploadState: "uploading" | "ready" | "error";
  uploadId?: string;
};
type ComposerContext = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
};
type BridgeEvent = {
  method: string;
  params: Record<string, unknown>;
  at: number;
};
type BrowseEntry = {
  name: string;
  path: string;
  kind: "drive" | "shortcut" | "folder" | "file";
};
type ContextPickerMode = "file" | "folder";
type BrowseResponse = {
  path: string;
  parent: string | null;
  roots: BrowseEntry[];
  shortcuts: BrowseEntry[];
  entries: BrowseEntry[];
};
type NewTaskDraft = { draftId: string; cwd: string; text: string };
type Screen = "home" | "task" | "workspaces";

declare global {
  interface Window {
    CodexBridgeAndroid?: {
      scanPairingCode?: () => void;
      getDeviceName?: () => string;
      copyText?: (text: string) => void;
      notify?: (title: string, body: string, threadId: string) => void;
      notifyConnectionIssue?: (body: string) => void;
      dismissConnectionIssue?: () => void;
    };
    CodexBridgeHandleBack?: () => boolean;
    CodexBridgeCloseImage?: () => boolean;
  }
}

const storageKey = "codex-bridge-connection";
const selectedThreadKey = "codex-bridge-selected-thread";
const lastWorkspaceKey = "codex-bridge-last-workspace";

function createDraftId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

function runConfigurationPatch(
  current: RunConfiguration | null | undefined,
  next: RunConfiguration | null | undefined,
): RunConfiguration | undefined {
  if (!next) return undefined;
  const patch: RunConfiguration = {};
  if (next.model && next.model !== current?.model) {
    patch.model = next.model;
    if (next.effort) patch.effort = next.effort;
  } else if (next.effort && next.effort !== current?.effort) {
    patch.effort = next.effort;
  }
  if (next.permissions && next.permissions !== current?.permissions)
    patch.permissions = next.permissions;
  return Object.keys(patch).length ? patch : undefined;
}

function effortLabel(effort?: string | null) {
  return ({
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  } as Record<string, string>)[effort || ""] || effort || "默认";
}

function effortDescription(effort?: string | null, fallback?: string) {
  return ({
    low: "响应更快，使用较轻量的推理",
    medium: "兼顾速度与推理深度，适合日常任务",
    high: "为复杂问题提供更深入的推理",
    xhigh: "以极高推理深度处理复杂问题",
    max: "为最困难的问题提供最大推理深度",
    ultra: "使用最大推理强度，并自动委派任务",
  } as Record<string, string>)[effort || ""] || fallback || "选择模型使用的推理强度";
}

function permissionLabel(id?: string | null) {
  if (id === ":read-only") return "Read only";
  if (id === ":workspace") return "Workspace write";
  if (id === ":danger-full-access") return "Full access";
  return id?.replace(/^:/, "") || "选择权限";
}

function permissionDescription(profile: PermissionProfileOption) {
  if (profile.description) return profile.description;
  if (profile.id === ":read-only") return "可以检查和分析项目，但不能修改文件";
  if (profile.id === ":workspace") return "可读写当前工作区和临时目录，推荐日常使用";
  if (profile.id === ":danger-full-access") return "不受本地沙盒限制，仅在明确需要时使用";
  return "电脑上配置的自定义权限范围";
}

function cleanServer(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function normalizeServerForCurrentPage(value: string) {
  const cleaned = cleanServer(value);
  if (typeof window === "undefined" || window.location.port === "3000")
    return cleaned;
  try {
    const parsed = new URL(cleaned);
    if (
      parsed.origin === window.location.origin &&
      parsed.pathname.replace(/\/+$/, "") === "/bridge"
    )
      return window.location.origin;
  } catch {
    // The connection form will surface invalid addresses.
  }
  return cleaned;
}

function decodePairingHash(): PairingCandidate | null {
  if (
    typeof window === "undefined" ||
    !window.location.hash.startsWith("#pair=")
  )
    return null;
  try {
    const encoded = window.location.hash
      .slice(6)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const bytes = Uint8Array.from(window.atob(encoded), (character) =>
      character.charCodeAt(0),
    );
    const decoded = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as PairingCandidate;
    if (typeof decoded.server !== "string" || (!decoded.token && !decoded.code))
      return null;
    window.history.replaceState(
      {},
      "",
      window.location.pathname + window.location.search,
    );
    return { ...decoded, server: cleanServer(decoded.server) };
  } catch {
    return null;
  }
}

function decodeThreadHash() {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#thread=")) return null;
  const threadId = decodeURIComponent(window.location.hash.slice(8));
  window.history.replaceState({}, "", window.location.pathname + window.location.search);
  return threadId || null;
}

function nativeNotify(title: string, body: string, threadId = "") {
  if (typeof document !== "undefined" && document.hidden)
    window.CodexBridgeAndroid?.notify?.(title, body, threadId);
}

async function requestJson<T>(
  server: string,
  pathname: string,
  token?: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${cleanServer(server)}${pathname}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function api<T>(
  settings: ConnectionSettings,
  pathname: string,
  init?: RequestInit,
) {
  return requestJson<T>(settings.server, pathname, settings.token, init);
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败")),
      "image/webp",
      quality,
    );
  });
}

async function prepareImageForUpload(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("只能选择图片文件");
  if (file.size > 30_000_000) throw new Error("原图超过 30 MB，请先缩小后再发送");
  if (typeof createImageBitmap !== "function") {
    if (file.size > 12_000_000) throw new Error("图片超过 12 MB，请先缩小后再发送");
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (file.size > 12_000_000) throw new Error("这张图片无法在手机上压缩，请换一张重试");
    return file;
  }
  try {
    const firstScale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * firstScale));
    canvas.height = Math.max(1, Math.round(bitmap.height * firstScale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("手机无法处理这张图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await canvasBlob(canvas, 0.84);
    if (blob.size > 2_800_000) {
      const secondScale = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
      if (secondScale < 1) {
        const smaller = document.createElement("canvas");
        smaller.width = Math.max(1, Math.round(canvas.width * secondScale));
        smaller.height = Math.max(1, Math.round(canvas.height * secondScale));
        smaller.getContext("2d", { alpha: false })?.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        blob = await canvasBlob(smaller, 0.72);
      } else blob = await canvasBlob(canvas, 0.68);
    }
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.webp`, {
      type: "image/webp",
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}

function userAttachmentIds(content: unknown) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const attachmentId = (value as Record<string, unknown>).attachmentId;
    return typeof attachmentId === "string" ? [attachmentId] : [];
  });
}

function userMentions(content: unknown): ComposerContext[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const input = value as Record<string, unknown>;
    if (
      input.type !== "mention" ||
      typeof input.name !== "string" ||
      typeof input.path !== "string"
    )
      return [];
    return [{
      id: `${input.path}-${index}`,
      name: input.name,
      path: input.path,
      kind: input.path.endsWith("/") || input.path.endsWith("\\")
        ? "folder"
        : "file",
    }];
  });
}

const goalCompletionMarker = "\n\n完成条件：";

function composeGoalObjective(objective: string, completion: string) {
  const normalizedObjective = objective.trim();
  const normalizedCompletion = completion.trim();
  return normalizedCompletion
    ? `${normalizedObjective}${goalCompletionMarker}${normalizedCompletion}`
    : normalizedObjective;
}

function splitGoalObjective(value: string) {
  const index = value.indexOf(goalCompletionMarker);
  if (index < 0) return { objective: value, completion: "" };
  return {
    objective: value.slice(0, index),
    completion: value.slice(index + goalCompletionMarker.length),
  };
}

function goalStatusLabel(status: ThreadGoalStatus) {
  return ({
    active: "进行中",
    paused: "已暂停",
    blocked: "遇到阻塞",
    usageLimited: "用量受限",
    budgetLimited: "预算已用完",
    complete: "已完成",
  } as Record<ThreadGoalStatus, string>)[status];
}

function compactDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds / 360) / 10} 小时`;
}

async function requestBlob(
  settings: ConnectionSettings,
  pathname: string,
  signal?: AbortSignal,
) {
  const url = `${cleanServer(settings.server)}${pathname}`;
  const headers = { Authorization: `Bearer ${settings.token}` };
  const cacheRequest = new Request(url, { headers });
  let imageCache: Cache | null = null;
  if (typeof caches !== "undefined") {
    try {
      imageCache = await caches.open("codex-bridge-images-v2");
      const cached = await imageCache.match(cacheRequest);
      if (cached) {
        const blob = await cached.blob();
        if (blob.type.startsWith("image/")) return blob;
        await imageCache.delete(cacheRequest);
      }
    } catch {
      imageCache = null;
    }
  }

  const response = await fetch(url, {
    headers,
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `图片加载失败 (${response.status})`);
  }
  const cacheCopy = response.clone();
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("电脑返回的内容不是图片");
  if (imageCache) void imageCache.put(cacheRequest, cacheCopy).catch(() => undefined);
  return blob;
}

function relativeTime(timestamp: number) {
  const milliseconds =
    timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const seconds = Math.max(0, Math.round((Date.now() - milliseconds) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(milliseconds).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

function workspaceName(cwd: string) {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || "未知工作区";
}

function workspacePathLabel(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return "选择电脑文件夹";
  return parts.length > 1 ? parts.slice(-2).join(" / ") : parts[0];
}

function threadTitle(thread: ThreadSummary) {
  return thread.name || thread.preview || "未命名任务";
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return extractText(node.props.children);
  return "";
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    completed: "已完成",
    inProgress: "执行中",
    failed: "失败",
    declined: "已拒绝",
    running: "执行中",
  };
  return map[status] || status || "未知";
}

function CopyButton({
  text,
  label = "复制",
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied: (label: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(text);
      else if (window.CodexBridgeAndroid?.copyText)
        window.CodexBridgeAndroid.copyText(text);
      else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      onCopied("已复制");
      window.setTimeout(() => setCopied(false), 500);
    } catch {
      onCopied("复制失败，请长按选择文本");
    }
  };
  return (
    <button className="copy-button" type="button" onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
      <span>{copied ? "已复制" : label}</span>
    </button>
  );
}

function CodeBlock({
  code,
  language,
  highlighted,
  onCopied,
}: {
  code: string;
  language: string;
  highlighted: ReactNode;
  onCopied: (label: string) => void;
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  const [expanded, setExpanded] = useState(lines.length <= 15);
  const [wrap, setWrap] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const isDiff = language === "diff";

  const body = isDiff ? (
    <code>
      {lines.map((line, index) => (
        <span
          key={index}
          className={
            line.startsWith("+")
              ? "diff-add"
              : line.startsWith("-")
                ? "diff-remove"
                : line.startsWith("@@")
                  ? "diff-hunk"
                  : ""
          }
        >
          {line || " "}
          {index < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </code>
  ) : (
    highlighted
  );

  const content = (
    <section className={`code-card ${fullscreen ? "code-fullscreen" : ""}`}>
      <header>
        <span>{language || "代码"}</span>
        <div>
          <button
            type="button"
            onClick={() => setWrap((value) => !value)}
            title="切换自动换行"
          >
            <TextAlignLeft />
            <span>{wrap ? "不换行" : "换行"}</span>
          </button>
          <CopyButton text={code} onCopied={onCopied} />
          <button
            type="button"
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? <X /> : <ArrowRight />}
            <span>{fullscreen ? "关闭" : "全屏"}</span>
          </button>
        </div>
      </header>
      <pre
        className={`${wrap ? "code-wrap" : ""} ${expanded ? "" : "code-collapsed"}`}
      >
        {body}
      </pre>
      {lines.length > 15 && !fullscreen ? (
        <button
          className="code-expand"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起代码" : `展开全部 · ${lines.length} 行`}
          <CaretDown />
        </button>
      ) : null}
    </section>
  );

  return fullscreen ? (
    <div className="fullscreen-backdrop">{content}</div>
  ) : (
    content
  );
}

function ThinkingShimmer() {
  const label = "正在思考";
  return (
    <div className="thinking-shimmer" role="status" aria-live="polite">
      <span>{label}</span>
      <span className="thinking-shimmer-sweep" aria-hidden="true">
        <span>{label}</span>
      </span>
    </div>
  );
}

function localMarkdownImagesFromItem(item: ThreadItem): LocalMarkdownImage[] {
  if (!Array.isArray(item.localImages)) return [];
  return item.localImages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const source = (value as Record<string, unknown>).source;
    const id = (value as Record<string, unknown>).id;
    return typeof source === "string" && typeof id === "string" ? [{ source, id }] : [];
  });
}

function markdownWithMobileImages(text: string, images: LocalMarkdownImage[]) {
  return images.reduce(
    (result, image) => result.split(image.source).join(`/__codex_bridge_image__/${encodeURIComponent(image.id)}`),
    text,
  );
}

function ImageFullscreen({
  source,
  title,
  onClose,
}: {
  source: string;
  title: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousClose = window.CodexBridgeCloseImage;
    const close = () => {
      onClose();
      return true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.CodexBridgeCloseImage = close;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener("keydown", onKeyDown);
      if (window.CodexBridgeCloseImage === close) {
        if (previousClose) window.CodexBridgeCloseImage = previousClose;
        else delete window.CodexBridgeCloseImage;
      }
    };
  }, [onClose]);

  useEffect(() => {
    if (zoom === 0 && stageRef.current) {
      stageRef.current.scrollLeft = 0;
      stageRef.current.scrollTop = 0;
    }
  }, [zoom]);

  const zoomOut = () => setZoom((value) => (value <= 1 ? 0 : Math.max(1, value - 0.5)));
  const zoomIn = () => setZoom((value) => (value === 0 ? 1 : Math.min(3, value + 0.5)));

  return createPortal(
    <div className="generated-image-fullscreen" role="dialog" aria-modal="true" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <div className="generated-image-fullscreen-actions">
          <button type="button" onClick={() => setZoom(0)} aria-label="适应屏幕" title="适应屏幕">
            <ArrowsIn />
          </button>
          <button type="button" onClick={zoomOut} disabled={zoom === 0} aria-label="缩小图片">
            <Minus />
          </button>
          <span>{zoom === 0 ? "适应" : `${Math.round(zoom * 100)}%`}</span>
          <button type="button" onClick={zoomIn} disabled={zoom >= 3} aria-label="放大图片">
            <Plus />
          </button>
          <button type="button" onClick={onClose} aria-label="关闭图片预览">
            <X />
          </button>
        </div>
      </header>
      <div
        className={`generated-image-stage ${zoom === 0 ? "is-fit" : "is-zoomed"}`}
        ref={stageRef}
        onDoubleClick={() => setZoom((value) => (value === 0 ? 1 : 0))}
      >
        <div className="generated-image-canvas" style={zoom ? { width: `${zoom * 100}%` } : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={source} alt={title} draggable={false} />
        </div>
      </div>
      <small className="generated-image-gesture-hint">
        {zoom === 0 ? "点 + 或双击查看原图宽度" : "上下左右滑动查看，双击恢复适应屏幕"}
      </small>
    </div>,
    document.body,
  );
}

type ThreadImageAsset = {
  id: string;
  endpoint: string;
  title: string;
  alt: string;
  available: boolean;
  generated?: boolean;
};

function ThreadImageCard({
  asset,
  settings,
}: {
  asset: ThreadImageAsset;
  settings: ConnectionSettings;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [previewSource, setPreviewSource] = useState("");
  const [originalSource, setOriginalSource] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [openError, setOpenError] = useState("");
  const [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [isLongImage, setIsLongImage] = useState(false);
  const previewEndpoint = `${asset.endpoint}?variant=preview`;

  const openFullscreen = async () => {
    if (!previewSource || opening) return;
    setOpening(true);
    setOpenError("");
    const openedNatively = await openNativeImageViewer({
      path: asset.endpoint,
      previewPath: previewEndpoint,
      token: settings.token,
      title: asset.title,
    });
    if (openedNatively) {
      setOpening(false);
      return;
    }
    try {
      if (originalSource) {
        setFullscreen(true);
      } else {
        const blob = await requestBlob(settings, asset.endpoint);
        const objectUrl = URL.createObjectURL(blob);
        setOriginalSource(objectUrl);
        setFullscreen(true);
      }
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : "原图打开失败");
    } finally {
      setOpening(false);
    }
  };

  useEffect(() => {
    if (!asset.available) return;
    const controller = new AbortController();
    let objectUrl = "";
    let started = false;
    const load = async () => {
      if (started) return;
      started = true;
      try {
        const blob = await requestBlob(
          settings,
          previewEndpoint,
          controller.signal,
        );
        objectUrl = URL.createObjectURL(blob);
        setPreviewSource(objectUrl);
      } catch (reason) {
        if (!controller.signal.aborted)
          setPreviewError(reason instanceof Error ? reason.message : "图片加载失败");
      }
    };
    const element = containerRef.current;
    let observer: IntersectionObserver | null = null;
    if (!element || typeof IntersectionObserver === "undefined") void load();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          void load();
        },
        { rootMargin: "320px 0px" },
      );
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.available, asset.id, previewEndpoint, retry, settings]);

  useEffect(() => () => {
    if (originalSource) URL.revokeObjectURL(originalSource);
  }, [originalSource]);

  return (
    <span
      className={`thread-image-card ${asset.generated ? "is-generated" : ""} ${isLongImage ? "is-long" : ""}`}
      ref={containerRef}
    >
      {previewSource ? (
        <button
          className="thread-image-preview"
          type="button"
          onClick={() => void openFullscreen()}
          aria-label={`查看原图：${asset.title}`}
          aria-busy={opening}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewSource}
            alt={asset.alt}
            loading="lazy"
            onLoad={(event) => {
              const image = event.currentTarget;
              setIsLongImage(image.naturalHeight / Math.max(image.naturalWidth, 1) > 1.45);
            }}
          />
          <span className="thread-image-open-label">
            {opening ? <><span className="thread-image-spinner" />正在打开原图</> : <><ArrowsOut />查看原图</>}
          </span>
        </button>
      ) : previewError ? (
        <button
          className="thread-image-placeholder is-error"
          type="button"
          onClick={() => {
            setPreviewError("");
            setRetry((value) => value + 1);
          }}
        >
          <ArrowClockwise />
          <strong>图片加载失败</strong>
          <small>{previewError}，点按重试</small>
        </button>
      ) : (
        <span className="thread-image-placeholder" role="status">
          <ImageSquare />
          <strong>{asset.available ? "正在加载图片" : "正在生成图片"}</strong>
          <small>{asset.available ? "即将显示清晰预览" : "生成完成后会自动显示"}</small>
        </span>
      )}
      {openError ? (
        <span className="thread-image-inline-error" role="alert">
          {openError}
          <button type="button" onClick={() => void openFullscreen()}>重试</button>
        </span>
      ) : null}
      {asset.generated ? (
        <span className="thread-image-footer">
          <span><ImageSquare /><strong>生成图片</strong></span>
          {previewSource ? <small>点按可查看和缩放原图</small> : null}
        </span>
      ) : null}
      {fullscreen && originalSource ? (
        <ImageFullscreen source={originalSource} title={asset.title} onClose={() => setFullscreen(false)} />
      ) : null}
    </span>
  );
}

function MarkdownThreadImage({
  assetId,
  alt,
  settings,
  threadId,
}: {
  assetId: string;
  alt: string;
  settings: ConnectionSettings;
  threadId: string;
}) {
  const endpoint = `/api/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(assetId)}`;
  return (
    <ThreadImageCard
      asset={{
        id: assetId,
        endpoint,
        title: alt || "任务中的图片",
        alt: alt || "任务中的图片",
        available: true,
      }}
      settings={settings}
    />
  );
}

function MarkdownContent({
  text,
  onCopied,
  live = false,
  commentary = false,
  arrival = false,
  settings,
  threadId,
  localImages = [],
}: {
  text: string;
  onCopied: (label: string) => void;
  live?: boolean;
  commentary?: boolean;
  arrival?: boolean;
  settings?: ConnectionSettings | null;
  threadId?: string;
  localImages?: LocalMarkdownImage[];
}) {
  const className = [
    "markdown-message",
    live ? "markdown-live" : "",
    commentary ? "markdown-commentary" : "",
    arrival ? "markdown-arrival" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children }) {
            const child = isValidElement<{
              className?: string;
              children?: ReactNode;
            }>(children)
              ? children
              : null;
            const className = child?.props.className || "";
            const language = /language-([^ ]+)/.exec(className)?.[1] || "";
            return (
              <CodeBlock
                code={extractText(child?.props.children)}
                language={language}
                highlighted={children}
                onCopied={onCopied}
              />
            );
          },
          code({ children, className }) {
            return <code className={className}>{children}</code>;
          },
          a({ children, href }) {
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const prefix = "/__codex_bridge_image__/";
            const imageSource = typeof src === "string" ? src : "";
            if (settings && threadId && imageSource.startsWith(prefix)) {
              return (
                <MarkdownThreadImage
                  assetId={decodeURIComponent(imageSource.slice(prefix.length))}
                  alt={alt || ""}
                  settings={settings}
                  threadId={threadId}
                />
              );
            }
            return imageSource ? (
              <Image src={imageSource} alt={alt || ""} width={1200} height={800} sizes="100vw" unoptimized />
            ) : null;
          },
          table({ children }) {
            return (
              <div className="table-scroll">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {markdownWithMobileImages(text, localImages)}
      </ReactMarkdown>
    </article>
  );
}

function GeneratedImageCard({
  item,
  settings,
  threadId,
}: {
  item: ThreadItem;
  settings: ConnectionSettings;
  threadId: string;
}) {
  const itemId = item.id || "";
  const available = Boolean(item.imageAvailable && itemId);
  const endpoint = `/api/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(itemId)}`;
  return (
    <ThreadImageCard
      asset={{
        id: itemId,
        endpoint,
        title: "生成图片",
        alt: "Codex 生成的图片",
        available,
        generated: true,
      }}
      settings={settings}
    />
  );
}

function ActivityItem({
  item,
  onCopied,
}: {
  item: ThreadItem;
  onCopied: (label: string) => void;
}) {
  if (item.type === "agentMessage")
    return (
      <div className="activity-detail">
        <span>过程更新</span>
        <p>{String(item.text || "")}</p>
      </div>
    );
  if (item.type === "commandExecution") {
    const command = String(item.command || "");
    return (
      <details className="activity-row">
        <summary>
          <TerminalWindow />
          <span>命令</span>
          <em className={`status-${String(item.status || "")}`}>
            {statusLabel(String(item.status || ""))}
          </em>
          <CaretRight />
        </summary>
        <div className="activity-body">
          <div className="command-line">
            <code>{command}</code>
            <CopyButton text={command} onCopied={onCopied} />
          </div>
          {item.cwd ? <small>{String(item.cwd)}</small> : null}
          {item.aggregatedOutput ? (
            <pre>{String(item.aggregatedOutput)}</pre>
          ) : null}
        </div>
      </details>
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return (
      <details className="activity-row">
        <summary>
          <FolderOpen />
          <span>文件修改 · {changes.length}</span>
          <em>{statusLabel(String(item.status || ""))}</em>
          <CaretRight />
        </summary>
        <div className="activity-body file-list">
          {changes.map((change, index) => {
            const record = change as Record<string, unknown>;
            const file = String(
              record.path ||
                record.file ||
                record.name ||
                JSON.stringify(record),
            );
            return (
              <div key={index}>
                <code>{file}</code>
                <CopyButton text={file} onCopied={onCopied} />
              </div>
            );
          })}
        </div>
      </details>
    );
  }
  if (item.type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    if (!summary) return null;
    return (
      <details className="activity-row">
        <summary>
          <Brain />
          <span>思考摘要</span>
          <CaretRight />
        </summary>
        <div className="activity-body">
          <p>{summary}</p>
        </div>
      </details>
    );
  }
  if (item.type === "plan")
    return (
      <div className="activity-detail">
        <span>计划</span>
        <p>{String(item.text || "")}</p>
      </div>
    );
  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "collabAgentToolCall"
  ) {
    return (
      <details className="activity-row">
        <summary>
          <Wrench />
          <span>{String(item.tool || "工具调用")}</span>
          <em>{statusLabel(String(item.status || ""))}</em>
          <CaretRight />
        </summary>
        <div className="activity-body">
          <pre>{JSON.stringify(item.arguments || item, null, 2)}</pre>
        </div>
      </details>
    );
  }
  return (
    <details className="activity-row">
      <summary>
        <Wrench />
        <span>{item.type}</span>
        <CaretRight />
      </summary>
      <div className="activity-body">
        <pre>{JSON.stringify(item, null, 2)}</pre>
      </div>
    </details>
  );
}

function ProcessGroup({
  items,
  onCopied,
  autoOpen,
  onManualChange,
}: {
  items: ThreadItem[];
  onCopied: (label: string) => void;
  autoOpen: boolean;
  onManualChange: (open: boolean) => void;
}) {
  const [automaticOpen, setAutomaticOpen] = useState(autoOpen);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setAutomaticOpen(autoOpen),
      autoOpen ? 0 : 320,
    );
    return () => window.clearTimeout(timer);
  }, [autoOpen]);

  const open = resolveProcessGroupOpen(manualOpen, automaticOpen);
  return (
    <details className="process-group" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          const nextOpen = !open;
          setManualOpen(nextOpen);
          onManualChange(nextOpen);
        }}
      >
        <List />
        <span>过程更新 · {items.length}</span>
        <CaretDown />
      </summary>
      <div>
        {items.map((item, index) => (
          <ActivityItem
            item={item}
            onCopied={onCopied}
            key={item.id || `${item.type}-${index}`}
          />
        ))}
      </div>
    </details>
  );
}

function TurnView({
  turn,
  onCopied,
  settings,
  threadId,
  active = false,
}: {
  turn: Turn;
  onCopied: (label: string) => void;
  settings: ConnectionSettings | null;
  threadId: string;
  active?: boolean;
}) {
  const users = turn.items.filter((item) => item.type === "userMessage");
  const timeline = buildTurnTimeline(turn.items);
  const finalKeys = timeline
    .filter((segment) => segment.kind === "assistant" && !segment.commentary)
    .map((segment) => segment.key);
  const finalKeySignature = JSON.stringify(finalKeys);
  const previousFinalKeysRef = useRef<Set<string> | null>(null);
  const [arrivingFinalKeys, setArrivingFinalKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [processAutoOpenSuppressed, setProcessAutoOpenSuppressed] =
    useState(false);

  useEffect(() => {
    const currentFinalKeys = JSON.parse(finalKeySignature) as string[];
    const nextKeys = new Set(currentFinalKeys);
    const previousKeys = previousFinalKeysRef.current;
    previousFinalKeysRef.current = nextKeys;
    if (!previousKeys) return;

    const arriving = currentFinalKeys.filter((key) => !previousKeys.has(key));
    if (!arriving.length) return;

    setArrivingFinalKeys(new Set(arriving));
    const timer = window.setTimeout(
      () => setArrivingFinalKeys(new Set()),
      900,
    );
    return () => window.clearTimeout(timer);
  }, [finalKeySignature]);

  const lastSegment = timeline.at(-1);
  const latestActivityKey = timeline.findLast(
    (segment) => segment.kind === "activities",
  )?.key;
  const liveMessageKey =
    active && lastSegment?.kind === "assistant" ? lastSegment.key : null;
  return (
    <section className="turn-block">
      {users.map((item, index) => {
        const text = textFromUserContent(item.content);
        const attachmentIds = userAttachmentIds(item.content);
        const mentions = userMentions(item.content);
        return (
          <article className={`user-message ${attachmentIds.length ? "has-images" : ""}`} key={item.id || `user-${index}`}>
            {attachmentIds.length && settings ? (
              <div className="user-message-images">
                {attachmentIds.map((attachmentId) => (
                  <ThreadImageCard
                    key={attachmentId}
                    asset={{
                      id: attachmentId,
                      endpoint: `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`,
                      title: "发送的图片",
                      alt: "用户发送的图片",
                      available: true,
                    }}
                    settings={settings}
                  />
                ))}
              </div>
            ) : null}
            {mentions.length ? (
              <div className="user-message-contexts">
                {mentions.map((mention) => (
                  <span title={mention.path} key={mention.id}>
                    <FileIcon />
                    {mention.name}
                  </span>
                ))}
              </div>
            ) : null}
            {text ? <p>{text}</p> : null}
          </article>
        );
      })}
      {timeline.map((segment) =>
        segment.kind === "activities" ? (
          <ProcessGroup
            items={segment.items}
            onCopied={onCopied}
            autoOpen={shouldAutomaticallyOpenProcessGroup(
              active,
              segment.key === latestActivityKey,
              processAutoOpenSuppressed,
            )}
            onManualChange={(open) => {
              if (!open) setProcessAutoOpenSuppressed(true);
            }}
            key={segment.key}
          />
        ) : segment.kind === "image" ? (
          settings ? (
            <GeneratedImageCard
              item={segment.item}
              settings={settings}
              threadId={threadId}
              key={segment.key}
            />
          ) : null
        ) : (
          <MarkdownContent
            text={String(segment.item.text || "")}
            onCopied={onCopied}
            commentary={segment.commentary}
            live={segment.key === liveMessageKey}
            arrival={arrivingFinalKeys.has(segment.key)}
            settings={settings}
            threadId={threadId}
            localImages={localMarkdownImagesFromItem(segment.item)}
            key={segment.key}
          />
        ),
      )}
      {active && lastSegment?.kind !== "assistant" ? (
        <ThinkingShimmer />
      ) : null}
    </section>
  );
}

function ConnectionBadge({
  state,
}: {
  state: "offline" | "connecting" | "online";
}) {
  return (
    <span className={`connection-badge connection-${state}`}>
      {state === "offline" ? <WifiSlash /> : <WifiHigh />}
      <span>
        {state === "online"
          ? "电脑在线"
          : state === "connecting"
            ? "连接中"
            : "电脑离线"}
      </span>
    </span>
  );
}

function TaskState({
  thread,
  detail,
}: {
  thread?: ThreadSummary | null;
  detail?: ThreadDetail | null;
}) {
  if (
    detail?.handoff.bridgeActive ||
    detail?.handoff.bridgeOwned ||
    detail?.handoff.desktopActive ||
    thread?.bridgeActive ||
    thread?.bridgeOwned ||
    thread?.desktopActive
  )
    return (
      <span className="state-chip state-running">
        <Play />
        Codex 正在处理
      </span>
    );
  if (detail?.handoff.state === "active" || thread?.status.type === "active")
    return (
      <span className="state-chip state-running">
        <Play />
        Codex 正在处理
      </span>
    );
  if ((detail?.handoff.queueLength || thread?.queueLength || 0) > 0)
    return (
      <span className="state-chip state-queued">
        <Clock />
        已排队
      </span>
    );
  if (detail?.handoff.state === "unknown")
    return (
      <span className="state-chip state-queued">
        <Clock />
        正在确认桌面状态
      </span>
    );
  return (
    <span className="state-chip state-idle">
      <CheckCircle />
      可以接入
    </span>
  );
}

function RunConfigurationBar({
  configuration,
  options,
  compact,
  pending,
  onOpen,
}: {
  configuration: RunConfiguration | null;
  options: CodexRunOptions | null;
  compact?: boolean;
  pending?: boolean;
  onOpen: (kind: RunPicker["kind"]) => void;
}) {
  const model = options?.models.find(
    (candidate) =>
      candidate.model === configuration?.model || candidate.id === configuration?.model,
  );
  return (
    <div
      className={`run-configuration-wrap${compact ? " run-configuration-compact" : ""}`}
    >
      <div className="run-configuration-bar">
        <button type="button" onClick={() => onOpen("model")}>
          <Brain />
          <span>
            <strong>
              {model?.displayName || configuration?.model || "选择模型"}
            </strong>
            <small>
              {compact
                ? `· ${effortLabel(configuration?.effort)}`
                : `推理 · ${effortLabel(configuration?.effort)}`}
            </small>
          </span>
          <CaretDown />
        </button>
        <button
          type="button"
          className={configuration?.permissions === ":danger-full-access" ? "permission-danger" : undefined}
          onClick={() => onOpen("permissions")}
        >
          <ShieldCheck />
          <span>
            <strong>{permissionLabel(configuration?.permissions)}</strong>
            {!compact ? <small>权限范围</small> : null}
          </span>
          <CaretDown />
        </button>
      </div>
      {pending ? (
        <small className="run-configuration-pending">
          {compact ? "下一轮" : "新设置将在下一轮生效"}
        </small>
      ) : null}
    </div>
  );
}

function RunConfigurationSheet({
  picker,
  options,
  configuration,
  onChange,
  onClose,
}: {
  picker: RunPicker;
  options: CodexRunOptions;
  configuration: RunConfiguration;
  onChange: (configuration: RunConfiguration) => void;
  onClose: () => void;
}) {
  const selectedModel =
    options.models.find(
      (candidate) =>
        candidate.model === configuration.model || candidate.id === configuration.model,
    ) || options.models.find((candidate) => candidate.isDefault) || options.models[0];
  return (
    <div className="sheet-backdrop run-picker-backdrop">
      <section
        className="bottom-sheet run-picker-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-picker-title"
      >
        <header>
          <div>
            <span className="eyebrow">本任务设置</span>
            <h2 id="run-picker-title">
              {picker.kind === "model" ? "模型与推理强度" : "权限范围"}
            </h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>

        {picker.kind === "model" ? (
          <div className="run-picker-content">
            <div className="run-option-list">
              {options.models.map((model) => {
                const selected = model.model === selectedModel?.model;
                return (
                  <button
                    type="button"
                    className={selected ? "selected" : ""}
                    key={model.id}
                    onClick={() =>
                      onChange({
                        ...configuration,
                        model: model.model,
                        effort:
                          model.defaultReasoningEffort ||
                          model.supportedReasoningEfforts[0]?.reasoningEffort ||
                          configuration.effort,
                      })
                    }
                  >
                    <span>
                      <strong>{model.displayName}</strong>
                      <small>{model.description}</small>
                    </span>
                    {selected ? <CheckCircle /> : null}
                  </button>
                );
              })}
            </div>
            {selectedModel?.supportedReasoningEfforts.length ? (
              <section className="effort-picker">
                <div>
                  <strong>推理强度</strong>
                  <small>
                    {effortDescription(
                      configuration.effort,
                      selectedModel.supportedReasoningEfforts.find(
                        (effort) => effort.reasoningEffort === configuration.effort,
                      )?.description,
                    )}
                  </small>
                </div>
                <div className="effort-options">
                  {selectedModel.supportedReasoningEfforts.map((effort) => (
                    <button
                      type="button"
                      className={configuration.effort === effort.reasoningEffort ? "selected" : ""}
                      key={effort.reasoningEffort}
                      title={effort.description}
                      onClick={() =>
                        onChange({
                          ...configuration,
                          model: selectedModel.model,
                          effort: effort.reasoningEffort,
                        })
                      }
                    >
                      {effortLabel(effort.reasoningEffort)}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="run-picker-content run-option-list permission-option-list">
            {options.permissionProfiles.map((profile) => {
              const selected = configuration.permissions === profile.id;
              return (
                <button
                  type="button"
                  className={selected ? "selected" : ""}
                  key={profile.id}
                  disabled={!profile.allowed}
                  onClick={() =>
                    onChange({ ...configuration, permissions: profile.id })
                  }
                >
                  <ShieldCheck />
                  <span>
                    <strong>{permissionLabel(profile.id)}</strong>
                    <small>
                      {profile.allowed
                        ? permissionDescription(profile)
                        : "已被电脑上的管理策略禁用"}
                    </small>
                  </span>
                  {selected ? <CheckCircle /> : null}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export function BridgeApp() {
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<ConnectionSettings>({
    server: "",
    token: "",
  });
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [projects, setProjects] = useState<CodexProjectSummary[]>([]);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [connection, setConnection] = useState<
    "offline" | "connecting" | "online"
  >("offline");
  const [eventsConnected, setEventsConnected] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [showSettings, setShowSettings] = useState(false);
  const [pairingProgress, setPairingProgress] = useState<
    "idle" | "requesting" | "waiting"
  >("idle");
  const [pairingComputerName, setPairingComputerName] = useState("");
  const [showNewTask, setShowNewTask] = useState(false);
  const [showTaskList, setShowTaskList] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [folderSearch, setFolderSearch] = useState("");
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [messageAttachments, setMessageAttachments] = useState<ComposerAttachment[]>([]);
  const [messageContexts, setMessageContexts] = useState<ComposerContext[]>([]);
  const [showComposerActions, setShowComposerActions] = useState(false);
  const [contextPickerMode, setContextPickerMode] = useState<ContextPickerMode | null>(null);
  const [contextBrowse, setContextBrowse] = useState<BrowseResponse | null>(null);
  const [contextBrowseLoading, setContextBrowseLoading] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [showGoalSheet, setShowGoalSheet] = useState(false);
  const [goalObjective, setGoalObjective] = useState("");
  const [goalCompletion, setGoalCompletion] = useState("");
  const [goalSaving, setGoalSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingUserMessages, setPendingUserMessages] = useState<
    PendingUserMessage[]
  >([]);
  const [newTask, setNewTask] = useState<NewTaskDraft>({ draftId: "", cwd: "", text: "" });
  const [runOptions, setRunOptions] = useState<CodexRunOptions | null>(null);
  const [newTaskRunConfiguration, setNewTaskRunConfiguration] =
    useState<RunConfiguration | null>(null);
  const [taskRunConfigurationOverrides, setTaskRunConfigurationOverrides] =
    useState<Record<string, RunConfiguration>>({});
  const [runPicker, setRunPicker] = useState<RunPicker | null>(null);
  const [editingQueue, setEditingQueue] = useState<string | null>(null);
  const [queueDraft, setQueueDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [openingOnDesktop, setOpeningOnDesktop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNoticeState] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [showScrollLatest, setShowScrollLatest] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newTaskInputRef = useRef<HTMLTextAreaElement | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentUploadsRef = useRef(new Map<string, Promise<string>>());
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationContentRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const pendingTaskScrollRef = useRef(true);
  const polling = useRef(false);
  const historyLimitsRef = useRef(new Map<string, number>());
  const detailRequestRef = useRef<{
    key: string;
    promise: Promise<ThreadDetail>;
    version: number;
  } | null>(null);
  const detailRequestVersionRef = useRef(0);
  const initialized = useRef(false);
  const pairingAbortRef = useRef<AbortController | null>(null);
  const draftPreparationRef = useRef<{
    key: string;
    promise: Promise<unknown>;
  } | null>(null);

  useEffect(() => {
    const nativeShell = Boolean(
      window.CodexBridgeAndroid ||
        new URLSearchParams(window.location.search).has("nativeApp"),
    );
    if (!nativeShell) return;
    document.documentElement.classList.add("native-shell");
    return () => document.documentElement.classList.remove("native-shell");
  }, []);

  const setNotice = useCallback((next: string | null) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNoticeState(next);
    if (next)
      noticeTimer.current = setTimeout(() => {
        noticeTimer.current = null;
        setNoticeState((current) => (current === next ? null : current));
      }, 500);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
      pairingAbortRef.current?.abort();
    },
    [],
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    followLatestRef.current = true;
    setShowScrollLatest(false);
    conversation.scrollTo({ top: conversation.scrollHeight, behavior });
  }, []);

  const scheduleTaskScrollSettled = useCallback(() => {
    if (!pendingTaskScrollRef.current) return;
    if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
    scrollSettleTimer.current = setTimeout(() => {
      scrollSettleTimer.current = null;
      if (!pendingTaskScrollRef.current) return;
      const conversation = conversationRef.current;
      if (conversation)
        conversation.scrollTo({ top: conversation.scrollHeight, behavior: "auto" });
      pendingTaskScrollRef.current = false;
      followLatestRef.current = true;
      setShowScrollLatest(false);
    }, 500);
  }, []);

  const prepareTaskScroll = useCallback(() => {
    if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
    scrollSettleTimer.current = null;
    followLatestRef.current = true;
    pendingTaskScrollRef.current = true;
    setShowScrollLatest(false);
  }, []);

  const loadThreads = useCallback(
    async (activeSettings: ConnectionSettings) => {
      const [catalog, projectCatalog] = await Promise.all([
        collectThreadPages<ThreadSummary>((cursor) =>
          api<ThreadPage<ThreadSummary>>(
            activeSettings,
            `/api/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        ),
        api<CodexProjectCatalog>(activeSettings, "/api/projects").catch(() => ({
          data: [],
          selectedProjectId: null,
        })),
      ]);
      setThreads(catalog);
      setProjects(projectCatalog.data);
      setConnection("online");
      setSelectedId(
        (current) =>
          current ||
          localStorage.getItem(selectedThreadKey) ||
          catalog[0]?.id ||
          null,
      );
    },
    [],
  );

  const loadRunOptions = useCallback(
    async (activeSettings: ConnectionSettings, cwd?: string) => {
      const response = await api<CodexRunOptions>(
        activeSettings,
        `/api/codex-options${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
      );
      setRunOptions(response);
      setNewTaskRunConfiguration((current) => current || response.defaults);
      return response;
    },
    [],
  );

  const loadThread = useCallback(
    async (activeSettings: ConnectionSettings, threadId: string, requestedLimit?: number) => {
      const turnLimit = requestedLimit || historyLimitsRef.current.get(threadId) || 10;
      historyLimitsRef.current.set(threadId, turnLimit);
      const key = `${threadId}:${turnLimit}`;
      let request = detailRequestRef.current;
      if (!request || request.key !== key) {
        const promise = api<ThreadDetail>(
          activeSettings,
          `/api/threads/${encodeURIComponent(threadId)}?turnLimit=${turnLimit}`,
        );
        request = { key, promise, version: ++detailRequestVersionRef.current };
        detailRequestRef.current = request;
      }
      let response: ThreadDetail;
      try {
        response = await request.promise;
      } finally {
        if (detailRequestRef.current?.promise === request.promise)
          detailRequestRef.current = null;
      }
      if (request.version !== detailRequestVersionRef.current) return response;
      setDetail(response);
      if (
        !response.handoff.bridgeActive &&
        !response.handoff.desktopActive
      )
        setStopping(false);
      setTaskRunConfigurationOverrides((current) => {
        const pending = current[threadId];
        if (
          !pending ||
          !sameRunConfiguration(
            response.handoff.preferredRunConfiguration,
            pending,
          )
        )
          return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setPendingUserMessages((current) =>
        reconcilePendingUserMessages(
          current,
          threadId,
          response.thread.turns,
        ),
      );
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? { ...thread, desktopActive: response.handoff.desktopActive }
            : thread,
        ),
      );
      if (!response.handoff.bridgeActive || response.handoff.state === "idle")
        setLiveText("");
      return response;
    },
    [],
  );

  const updateDesktopActivity = useCallback(
    (
      threadId: string,
      active: boolean,
      state: "idle" | "active" | "unknown" = active ? "active" : "idle",
      reason = active ? "桌面 Codex 正在处理" : "桌面任务已结束",
      lastActivityAt?: number | null,
    ) => {
      if (!threadId) return;
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId ? { ...thread, desktopActive: active } : thread,
        ),
      );
      setDetail((current) => {
        if (!current || current.thread.id !== threadId) return current;
        return {
          ...current,
          thread: { ...current.thread, desktopActive: active },
          handoff: {
            ...current.handoff,
            state,
            reason,
            desktopActive: active,
            ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
          },
        };
      });
    },
    [],
  );

  const loadAuxiliary = useCallback(
    async (activeSettings: ConnectionSettings) => {
      const [approvalResponse, queueResponse] = await Promise.all([
        api<{ data: Approval[] }>(activeSettings, "/api/approvals"),
        api<{ data: QueueItem[] }>(activeSettings, "/api/queue"),
      ]);
      setApprovals(approvalResponse.data);
      setQueue(queueResponse.data);
    },
    [],
  );

  const refresh = useCallback(
    async (
      activeSettings = settings,
      threadId = selectedId,
      silent = false,
    ) => {
      if (!activeSettings) return;
      try {
        await Promise.all([
          loadThreads(activeSettings),
          loadAuxiliary(activeSettings),
        ]);
        if (threadId) await loadThread(activeSettings, threadId);
        setConnection("online");
        setError(null);
      } catch (reason) {
        if (!silent) {
          setConnection("offline");
          setError(
            reason instanceof Error ? reason.message : "无法连接电脑服务",
          );
        }
      }
    },
    [loadAuxiliary, loadThread, loadThreads, selectedId, settings],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const initialize = async () => {
      const threadFromHash = decodeThreadHash();
      const paired = decodePairingHash();
      if (threadFromHash) {
        setSelectedId(threadFromHash);
        setScreen("task");
        localStorage.setItem(selectedThreadKey, threadFromHash);
      }
      let stored: ConnectionSettings | null = null;
      try {
        stored = JSON.parse(localStorage.getItem(storageKey) || "null");
      } catch {
        stored = null;
      }
      try {
        let candidate = paired?.token
          ? { server: paired.server, token: paired.token }
          : stored;
        if (paired?.code)
          candidate = await requestJson<ConnectionSettings>(
            paired.server,
            "/api/pair/exchange",
            undefined,
            { method: "POST", body: JSON.stringify({ code: paired.code }) },
          );
        const initial = candidate
          ? {
              ...candidate,
              server: normalizeServerForCurrentPage(candidate.server),
            }
          : null;
        if (initial?.server && initial?.token) {
          setSettings(initial);
          setDraftSettings(initial);
          localStorage.setItem(storageKey, JSON.stringify(initial));
          setConnection("connecting");
          await refresh(initial, threadFromHash);
        } else {
          setDraftSettings({
            server:
              window.location.port === "3000"
                ? `${window.location.origin}/bridge`
                : window.location.origin,
            token: "",
          });
          setShowSettings(true);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "配对失败");
        setShowSettings(true);
      }
    };
    void initialize();
    if (
      "serviceWorker" in navigator &&
      (window.isSecureContext || window.location.hostname === "localhost")
    )
      void navigator.serviceWorker.register("/sw.js?v=3", { updateViaCache: "none" });
  }, [refresh]);

  useEffect(() => {
    if (!settings || !selectedId) return;
    localStorage.setItem(selectedThreadKey, selectedId);
    const timer = window.setTimeout(() => {
      void loadThread(settings, selectedId).catch((reason) =>
        setError(reason instanceof Error ? reason.message : "读取任务失败"),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadThread, selectedId, settings]);

  useEffect(() => {
    if (!settings) return;
    const timer = window.setTimeout(() => {
      void loadRunOptions(settings, detail?.thread.cwd).catch((reason) =>
        setError(reason instanceof Error ? reason.message : "读取 Codex 模型失败"),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [detail?.thread.cwd, loadRunOptions, settings]);

  useEffect(() => {
    if (!settings) return;
    let isProxy = false;
    try {
      isProxy =
        new URL(settings.server).pathname.replace(/\/+$/, "") === "/bridge";
    } catch {
      isProxy = false;
    }
    if (isProxy) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let computerOfflineTimer: ReturnType<typeof setTimeout> | null = null;
    let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let retryDelay = 750;
    let refreshInFlight = false;
    let refreshPending = false;
    let refreshNeedsDetail = false;
    let refreshNeedsAuxiliary = false;
    let lastEventRefreshAt = 0;
    const armEventRefresh = (immediate = false) => {
      if (closed || refreshInFlight || !refreshPending) return;
      if (eventRefreshTimer) {
        if (!immediate) return;
        clearTimeout(eventRefreshTimer);
        eventRefreshTimer = null;
      }
      const delay = immediate
        ? 0
        : Math.max(0, 250 - (Date.now() - lastEventRefreshAt));
      eventRefreshTimer = setTimeout(() => {
        eventRefreshTimer = null;
        void runEventRefresh();
      }, delay);
    };
    const runEventRefresh = async () => {
      if (closed || refreshInFlight || !refreshPending) return;
      refreshInFlight = true;
      refreshPending = false;
      const needsDetail = refreshNeedsDetail;
      const needsAuxiliary = refreshNeedsAuxiliary;
      refreshNeedsDetail = false;
      refreshNeedsAuxiliary = false;
      lastEventRefreshAt = Date.now();
      try {
        const tasks: Promise<unknown>[] = [loadThreads(settings)];
        if (needsDetail && selectedId)
          tasks.push(loadThread(settings, selectedId));
        if (needsAuxiliary) tasks.push(loadAuxiliary(settings));
        await Promise.all(tasks);
      } catch {
        // The next rollout event or the regular connection refresh retries it.
      } finally {
        refreshInFlight = false;
        if (refreshPending) armEventRefresh(false);
      }
    };
    const scheduleEventRefresh = (
      eventThreadId: string,
      options: { immediate?: boolean; auxiliary?: boolean } = {},
    ) => {
      refreshPending = true;
      refreshNeedsDetail ||= Boolean(
        selectedId && (!eventThreadId || eventThreadId === selectedId),
      );
      refreshNeedsAuxiliary ||= options.auxiliary === true;
      armEventRefresh(options.immediate === true);
    };
    const clearComputerOfflineTimer = () => {
      if (computerOfflineTimer) clearTimeout(computerOfflineTimer);
      computerOfflineTimer = null;
    };
    const handleComputerState = (connected: boolean) => {
      clearComputerOfflineTimer();
      setConnection(connected ? "online" : "offline");
      if (connected) {
        window.CodexBridgeAndroid?.dismissConnectionIssue?.();
        void refresh(settings, selectedId, true);
        return;
      }
      computerOfflineTimer = setTimeout(() => {
        computerOfflineTimer = null;
        window.CodexBridgeAndroid?.notifyConnectionIssue?.(
          "连接中继正常，正在等待电脑重新上线",
        );
      }, 20_000);
    };
    const connect = async () => {
      if (closed) return;
      setConnection("connecting");
      try {
        const ticket = await api<{ ticket: string }>(
          settings,
          "/api/ws-ticket",
          { method: "POST", body: "{}" },
        );
        if (closed) return;
        socket = new WebSocket(
          `${cleanServer(settings.server).replace(/^http/, "ws")}/api/events?ticket=${encodeURIComponent(ticket.ticket)}`,
        );
      } catch {
        setEventsConnected(false);
        setConnection("offline");
        if (!closed) {
          const delay = retryDelay;
          retryDelay = Math.min(Math.round(retryDelay * 1.8), 10_000);
          retry = setTimeout(() => void connect(), delay);
        }
        return;
      }
      socket.onopen = () => {
        retryDelay = 750;
        setEventsConnected(true);
        setConnection("online");
        void refresh(settings, selectedId, true);
      };
      socket.onclose = () => {
        setEventsConnected(false);
        clearComputerOfflineTimer();
        setConnection("offline");
        if (!closed) {
          const delay = retryDelay;
          retryDelay = Math.min(Math.round(retryDelay * 1.8), 10_000);
          retry = setTimeout(() => void connect(), delay);
        }
      };
      socket.onmessage = (event) => {
        let messageEvent: BridgeEvent;
        try {
          messageEvent = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const params = messageEvent.params || {};
        const eventThreadId = String(params.threadId || "");
        if (messageEvent.method === "bridge/hostState")
          handleComputerState(params.connected === true);
        if (messageEvent.method === "bridge/snapshot") {
          setQueue(
            Array.isArray(params.queue) ? (params.queue as QueueItem[]) : [],
          );
          setApprovals(
            Array.isArray(params.approvals)
              ? (params.approvals as Approval[])
              : [],
          );
        }
        if (
          messageEvent.method === "item/agentMessage/delta" &&
          params.threadId === selectedId
        )
          setLiveText((current) => current + String(params.delta || ""));
        if (
          messageEvent.method === "turn/started" &&
          params.threadId === selectedId
        )
          setLiveText("");
        if (messageEvent.method === "bridge/desktopTurnStarted")
          updateDesktopActivity(eventThreadId, true, "active");
        if (messageEvent.method === "bridge/desktopTurnEnded") {
          updateDesktopActivity(eventThreadId, false, "idle");
          if (eventThreadId === selectedId) setStopping(false);
        }
        if (messageEvent.method === "bridge/rolloutChanged" && eventThreadId) {
          const rolloutState = String(params.state || "unknown");
          if (
            rolloutState === "idle" ||
            rolloutState === "active" ||
            rolloutState === "unknown"
          )
            updateDesktopActivity(
              eventThreadId,
              params.desktopActive === true,
              rolloutState,
              String(params.reason || "桌面任务状态已更新"),
              typeof params.lastActivityAt === "number"
                ? params.lastActivityAt
                : undefined,
            );
        }
        if (messageEvent.method === "bridge/approvalRequested") {
          setApprovals((current) => [
            ...current.filter(
              (item) => item.id !== String((params as unknown as Approval).id),
            ),
            params as unknown as Approval,
          ]);
          setNotice("Codex 正在等待你的批准");
          nativeNotify(
            "Codex 等待批准",
            String(params.reason || "请打开任务查看请求"),
            String(params.threadId || ""),
          );
        }
        if (
          (messageEvent.method === "thread/goal/updated" ||
            messageEvent.method === "bridge/goalUpdated") &&
          eventThreadId === selectedId &&
          params.goal &&
          typeof params.goal === "object"
        )
          setDetail((current) =>
            current?.thread.id === eventThreadId
              ? { ...current, goal: params.goal as ThreadGoal }
              : current,
          );
        if (
          (messageEvent.method === "thread/goal/cleared" ||
            messageEvent.method === "bridge/goalCleared") &&
          eventThreadId === selectedId
        )
          setDetail((current) =>
            current?.thread.id === eventThreadId
              ? { ...current, goal: null }
              : current,
          );
        if (
          messageEvent.method === "turn/completed" ||
          messageEvent.method === "turn/aborted"
        ) {
          const turn = (params.turn || {}) as Record<string, unknown>;
          const turnStatus = String(turn.status || params.status || "").toLowerCase();
          const failed =
            messageEvent.method === "turn/aborted" || turnStatus.includes("fail");
          const interrupted = turnStatus.includes("interrupt");
          const completedThreadId = String(params.threadId || turn.threadId || "");
          if (completedThreadId === selectedId) setStopping(false);
          nativeNotify(
            failed
              ? "Codex 任务失败"
              : interrupted
                ? "Codex 已停止"
                : "Codex 任务完成",
            failed
              ? "打开任务查看错误详情"
              : interrupted
                ? "这一轮已经停止，可以修改要求后继续"
                : "任务已经完成，可以继续处理",
            completedThreadId,
          );
        }
        if (messageEvent.method === "bridge/approvalResolved")
          setApprovals((current) =>
            current.filter((item) => item.id !== String(params.id)),
          );
        if (
          messageEvent.method.includes("queue") ||
          messageEvent.method === "bridge/messageSteered" ||
          messageEvent.method === "bridge/rolloutChanged" ||
          messageEvent.method === "bridge/desktopTurnStarted" ||
          messageEvent.method === "bridge/desktopTurnEnded" ||
          messageEvent.method === "bridge/writerReleased" ||
          messageEvent.method.includes("goal") ||
          messageEvent.method === "turn/completed" ||
          messageEvent.method === "turn/aborted" ||
          messageEvent.method === "turn/started"
        ) {
          scheduleEventRefresh(eventThreadId, {
            auxiliary: messageEvent.method.includes("queue"),
            immediate:
              messageEvent.method === "bridge/desktopTurnStarted" ||
              messageEvent.method === "turn/started",
          });
        }
      };
    };
    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
      clearComputerOfflineTimer();
      socket?.close();
    };
  }, [
    loadAuxiliary,
    loadThread,
    loadThreads,
    refresh,
    selectedId,
    settings,
    setNotice,
    updateDesktopActivity,
  ]);

  useEffect(() => {
    if (!settings || eventsConnected) return;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void refresh(settings, selectedId, true).finally(() => {
        polling.current = false;
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [eventsConnected, refresh, selectedId, settings]);

  const workspaces = useMemo(() => {
    if (!projects.length) {
      const map = new Map<string, ThreadSummary[]>();
      for (const thread of threads) {
        const items = map.get(thread.cwd) || [];
        items.push(thread);
        map.set(thread.cwd, items);
      }
      return [...map.entries()]
        .map(([cwd, items]) => ({
          key: `workspace:${cwd}`,
          cwd,
          name: workspaceName(cwd),
          threads: items,
          updatedAt: Math.max(
            ...items.map((item) => item.recencyAt || item.updatedAt),
          ),
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
    const assignedThreadIds = new Set(projects.flatMap((project) => project.threadIds));
    const unassignedThreadsByCwd = new Map<string, ThreadSummary[]>();
    for (const thread of threads) {
      if (assignedThreadIds.has(thread.id)) continue;
      const items = unassignedThreadsByCwd.get(thread.cwd) || [];
      items.push(thread);
      unassignedThreadsByCwd.set(thread.cwd, items);
    }

    return projects
      .map((project) => {
        const items = new Map<string, ThreadSummary>();
        for (const threadId of project.threadIds) {
          const thread = threadsById.get(threadId);
          if (thread) items.set(thread.id, thread);
        }
        for (const rootPath of project.rootPaths) {
          for (const thread of unassignedThreadsByCwd.get(rootPath) || [])
            items.set(thread.id, thread);
        }
        const projectThreads = [...items.values()].sort(
          (left, right) =>
            (right.recencyAt || right.updatedAt) - (left.recencyAt || left.updatedAt),
        );
        const projectTimestamp = project.updatedAt || project.createdAt || 0;
        return {
          key: `project:${project.id}`,
          cwd: project.rootPaths[0],
          name: project.name,
          threads: projectThreads,
          updatedAt: projectThreads.reduce(
            (latest, thread) => Math.max(latest, thread.recencyAt || thread.updatedAt),
            projectTimestamp,
          ),
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [projects, threads]);
  const activeThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.bridgeActive ||
          thread.bridgeOwned ||
          thread.desktopActive ||
          thread.status.type === "active",
      ),
    [threads],
  );
  const recentThreads = useMemo(() => {
    const activeIds = new Set(activeThreads.map((thread) => thread.id));
    return threads.filter((thread) => !activeIds.has(thread.id)).slice(0, 10);
  }, [activeThreads, threads]);
  const historicalThreadCount = Math.max(0, threads.length - activeThreads.length);
  const filteredThreads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? threads.filter((thread) =>
          `${threadTitle(thread)} ${thread.preview} ${thread.cwd}`
            .toLowerCase()
            .includes(needle),
        )
      : threads;
  }, [search, threads]);
  const activeQueue = queue.filter((item) => item.threadId === selectedId);
  const selectedThread =
    threads.find((thread) => thread.id === selectedId) ||
    detail?.thread ||
    null;
  const persistedTaskRunConfiguration =
    detail?.thread.id === selectedId ? detail.handoff.runConfiguration : null;
  const preferredTaskRunConfiguration =
    detail?.thread.id === selectedId
      ? detail.handoff.preferredRunConfiguration
      : null;
  const selectedTaskRunConfigurationOverride = selectedId
    ? taskRunConfigurationOverrides[selectedId] || null
    : null;
  const selectedTaskRunConfiguration = selectedId
    ? selectedTaskRunConfigurationOverride ||
      preferredTaskRunConfiguration ||
      persistedTaskRunConfiguration ||
      runOptions?.defaults ||
      null
    : null;
  const selectedTaskRunConfigurationPatch = selectedTaskRunConfiguration
    ? runConfigurationPatch(
        persistedTaskRunConfiguration,
        selectedTaskRunConfiguration,
      )
    : undefined;
  const selectedTaskBusy = Boolean(
    detail &&
      (detail.handoff.bridgeActive ||
        detail.handoff.bridgeOwned ||
        detail.handoff.desktopActive ||
      detail.handoff.state === "active"),
  );
  const composerHasDraft = Boolean(
    message.trim() || messageAttachments.length || messageContexts.length,
  );
  const composerPrimaryAction = resolveComposerPrimaryAction(
    Boolean(detail?.handoff.bridgeActive || detail?.handoff.desktopActive),
    message,
    messageAttachments.length,
    messageContexts.length,
  );
  const selectedNewTaskRunConfiguration =
    newTaskRunConfiguration || runOptions?.defaults || null;

  const canOpenOnDesktop = Boolean(
    detail &&
      selectedId &&
      !detail.handoff.bridgeActive &&
      !detail.handoff.bridgeOwned &&
      !detail.handoff.desktopActive &&
      detail.handoff.state === "idle" &&
      detail.handoff.queueLength === 0,
  );

  const openTask = (threadId: string) => {
    if (selectedId && selectedId !== threadId) {
      if (messageAttachments.length) {
        messageAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        attachmentUploadsRef.current.clear();
        setMessageAttachments([]);
      }
      setMessageContexts([]);
      setShowComposerActions(false);
      setStopping(false);
    }
    prepareTaskScroll();
    setSelectedId(threadId);
    setScreen("task");
    setShowTaskList(false);
  };
  const openRunConfigurationPicker = (
    target: RunPicker["target"],
    kind: RunPicker["kind"],
  ) => {
    setRunPicker({ target, kind });
    const cwd = target === "new-task" ? newTask.cwd : detail?.thread.cwd;
    if (settings)
      void loadRunOptions(settings, cwd).catch((reason) =>
        setError(reason instanceof Error ? reason.message : "刷新 Codex 设置失败"),
      );
  };
  const updatePickedRunConfiguration = (configuration: RunConfiguration) => {
    if (!runPicker) return;
    if (runPicker.target === "new-task") {
      setNewTaskRunConfiguration(configuration);
      return;
    }
    if (!selectedId) return;
    setTaskRunConfigurationOverrides((current) => ({
      ...current,
      [selectedId]: configuration,
    }));
    if (!settings) return;
    const threadId = selectedId;
    void api<{
      configuration: RunConfiguration;
      synced: boolean;
      via: "desktop" | "app-server" | "pending";
      currentTurnChanged: false;
      appliesTo: "next-turn";
    }>(
      settings,
      `/api/threads/${encodeURIComponent(threadId)}/run-configuration`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...configuration,
          ...(detail?.thread.cwd ? { cwd: detail.thread.cwd } : {}),
        }),
      },
    )
      .then((result) => {
        setDetail((current) =>
          current?.thread.id === threadId
            ? {
                ...current,
                handoff: {
                  ...current.handoff,
                  preferredRunConfiguration: result.configuration,
                },
              }
            : current,
        );
        setTaskRunConfigurationOverrides((current) => {
          if (!sameRunConfiguration(current[threadId], result.configuration))
            return current;
          const next = { ...current };
          delete next[threadId];
          return next;
        });
        setNotice(
          result.synced
            ? selectedTaskBusy
              ? "已同步到电脑，将在下一轮生效"
              : "已同步到电脑"
            : "设置已保存，将在下一轮启动时重试同步",
        );
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "同步任务设置失败"),
      );
  };
  const loadEarlierTurns = async () => {
    if (!settings || !selectedId || !detail?.history?.hasEarlierTurns) return;
    const currentLimit = historyLimitsRef.current.get(selectedId) || 10;
    const nextLimit = Math.min(detail.history.totalTurns, currentLimit + 10);
    try {
      await loadThread(settings, selectedId, nextLimit);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载更早记录失败");
    }
  };
  const openCurrentTask = () => {
    prepareTaskScroll();
    setScreen("task");
    window.requestAnimationFrame(() => scrollToLatest("auto"));
  };
  const openTaskPicker = () => {
    setSearch("");
    setShowTaskList(true);
  };
  const saveConnection = async () => {
    const next = {
      server: normalizeServerForCurrentPage(draftSettings.server),
      token: draftSettings.token.trim(),
    };
    if (!next.server || !next.token) {
      setError("请填写电脑服务地址和配对令牌");
      return;
    }
    setConnection("connecting");
    try {
      await api(next, "/api/threads");
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSettings(next);
      setShowSettings(false);
      setError(null);
      await refresh(next, null);
    } catch (reason) {
      setConnection("offline");
      setError(reason instanceof Error ? reason.message : "连接失败");
    }
  };
  const requestComputerApproval = async () => {
    const server = normalizeServerForCurrentPage(draftSettings.server);
    if (!server) {
      setError("请填写电脑地址");
      return;
    }
    pairingAbortRef.current?.abort();
    const controller = new AbortController();
    pairingAbortRef.current = controller;
    setPairingProgress("requesting");
    setPairingComputerName("");
    setConnection("connecting");
    setError(null);
    try {
      const created = await requestJson<PairingRequestCreated>(
        server,
        "/api/pair/requests",
        undefined,
        {
          method: "POST",
          body: JSON.stringify({
            deviceName:
              window.CodexBridgeAndroid?.getDeviceName?.() ||
              "Codex Bridge Android",
          }),
          signal: controller.signal,
        },
      );
      setPairingComputerName(created.hostname);
      setPairingProgress("waiting");
      const expiresAt = Date.parse(created.expiresAt);
      while (!controller.signal.aborted && Date.now() < expiresAt) {
        const status = await requestJson<PairingRequestStatus>(
          server,
          `/api/pair/requests/${encodeURIComponent(created.requestId)}/status?secret=${encodeURIComponent(created.requestSecret)}`,
          undefined,
          { signal: controller.signal },
        );
        if (status.status === "approved" && status.token) {
          const next = { server, token: status.token };
          await api(next, "/api/threads");
          localStorage.setItem(storageKey, JSON.stringify(next));
          setSettings(next);
          setDraftSettings(next);
          setShowSettings(false);
          setPairingProgress("idle");
          setConnection("online");
          await refresh(next, null);
          return;
        }
        if (status.status === "denied") throw new Error("电脑已拒绝这次连接请求");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Pairing cancelled", "AbortError"));
          };
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, 1200);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      throw new Error("连接请求已超时，请重新发送");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setConnection("offline");
      setError(reason instanceof Error ? reason.message : "连接请求失败");
      setPairingProgress("idle");
    } finally {
      if (pairingAbortRef.current === controller) pairingAbortRef.current = null;
    }
  };
  const startAttachmentUpload = (
    attachment: ComposerAttachment,
    connection: ConnectionSettings,
  ) => {
    if (attachment.uploadId) return Promise.resolve(attachment.uploadId);
    const current = attachmentUploadsRef.current.get(attachment.id);
    if (current)
      return current.then((uploadId) => {
        setMessageAttachments((attachments) =>
          attachments.map((candidate) =>
            candidate.id === attachment.id
              ? { ...candidate, uploadState: "ready", uploadId }
              : candidate,
          ),
        );
        return uploadId;
      });
    const upload = api<{ id: string }>(
      connection,
      `/api/threads/${encodeURIComponent(attachment.threadId)}/attachments`,
      {
        method: "POST",
        headers: { "Content-Type": attachment.file.type || "image/jpeg" },
        body: attachment.file,
      },
    ).then((response) => {
      setMessageAttachments((attachments) =>
        attachments.map((candidate) =>
          candidate.id === attachment.id
            ? { ...candidate, uploadState: "ready", uploadId: response.id }
            : candidate,
        ),
      );
      return response.id;
    }).catch((reason) => {
      attachmentUploadsRef.current.delete(attachment.id);
      setMessageAttachments((attachments) =>
        attachments.map((candidate) =>
          candidate.id === attachment.id
            ? { ...candidate, uploadState: "error" }
            : candidate,
        ),
      );
      throw reason;
    });
    attachmentUploadsRef.current.set(attachment.id, upload);
    return upload;
  };
  const selectMessageImages = async (files: FileList | null) => {
    if (!files?.length || !settings || !selectedId) return;
    const remaining = Math.max(0, 4 - messageAttachments.length);
    if (!remaining) {
      setError("每条消息最多发送 4 张图片");
      return;
    }
    const threadId = selectedId;
    const selected = Array.from(files).slice(0, remaining);
    try {
      setError(null);
      for (const file of selected) {
        const compressed = await prepareImageForUpload(file);
        const attachment: ComposerAttachment = {
          id: createDraftId(),
          threadId,
          file: compressed,
          previewUrl: URL.createObjectURL(compressed),
          uploadState: "uploading",
        };
        setMessageAttachments((current) => [...current, attachment].slice(0, 4));
        void startAttachmentUpload(attachment, settings).catch(() => undefined);
      }
      if (files.length > remaining) setNotice("每条消息最多保留 4 张图片");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片处理失败");
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };
  const removeMessageImage = (id: string) => {
    setMessageAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      attachmentUploadsRef.current.delete(id);
      return current.filter((attachment) => attachment.id !== id);
    });
  };
  const sendMessage = async () => {
    if (
      !settings ||
      !selectedId ||
      (!message.trim() && !messageAttachments.length && !messageContexts.length) ||
      sending
    )
      return;
    const threadId = selectedId;
    const outgoing = message.trim();
    const outgoingAttachments = messageAttachments;
    const outgoingContexts = messageContexts;
    if (outgoingAttachments.length) {
      const selectedModel = runOptions?.models.find((option) =>
        option.id === selectedTaskRunConfiguration?.model ||
        option.model === selectedTaskRunConfiguration?.model,
      );
      if (selectedModel?.inputModalities?.length && !selectedModel.inputModalities.includes("image")) {
        setError(`${selectedModel.displayName} 不支持图片输入，请先切换模型`);
        return;
      }
    }
    const requestedRunConfiguration = selectedTaskRunConfigurationPatch;
    const optimisticId = createDraftId();
    const baselineMatches =
      detail?.thread.id === threadId
        ? countMatchingUserMessages(detail.thread.turns, outgoing)
        : 0;
    followLatestRef.current = true;
    setShowScrollLatest(false);
    setMessage("");
    setMessageAttachments([]);
    setMessageContexts([]);
    setError(null);
    setPendingUserMessages((current) => [
      ...current,
      {
        id: optimisticId,
        threadId,
        text: outgoing,
        baselineMatches,
        status: "sending",
        attachmentPreviews: outgoingAttachments.map((attachment) => attachment.previewUrl),
        contextNames: outgoingContexts.map((context) => context.name),
      },
    ]);
    setSending(true);
    let accepted = false;
    try {
      const attachmentIds = await Promise.all(
        outgoingAttachments.map((attachment) =>
          startAttachmentUpload(attachment, settings),
        ),
      );
      const result = await api<{
        queued: boolean;
        steered?: boolean;
        via?: "desktop" | "bridge";
      }>(
        settings,
        `/api/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            text: outgoing,
            attachmentIds,
            contextPaths: outgoingContexts.map(({ path, kind }) => ({ path, kind })),
            queueIfBusy: true,
            steerIfBusy: !requestedRunConfiguration,
            ...(requestedRunConfiguration
              ? { runConfiguration: requestedRunConfiguration }
              : {}),
          }),
        },
      );
      setPendingUserMessages((current) =>
        current.map((pending) =>
          pending.id === optimisticId
            ? { ...pending, status: "accepted" }
            : pending,
        ),
      );
      setNotice(
        result.queued && requestedRunConfiguration
          ? "已排队，模型与权限将在下一轮生效"
          : result.steered
          ? "已追加到当前任务"
          : result.queued
          ? "已排队"
          : result.via === "desktop"
            ? "已发送到桌面 Codex"
             : "任务已开始",
      );
      if (!result.queued && result.via === "desktop")
        updateDesktopActivity(threadId, true, "active");
      accepted = true;
      setSending(false);
      outgoingAttachments.forEach((attachment) => attachmentUploadsRef.current.delete(attachment.id));
      void refresh(settings, threadId).catch(() => undefined);
      window.setTimeout(
        () => outgoingAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl)),
        60_000,
      );
      if (result.queued)
        setPendingUserMessages((current) =>
          current.filter((pending) => pending.id !== optimisticId),
        );
    } catch (reason) {
      setPendingUserMessages((current) =>
        current.filter((pending) => pending.id !== optimisticId),
      );
      setMessage((current) => restoreFailedMessage(outgoing, current));
      setMessageAttachments((current) => [
        ...outgoingAttachments.map((attachment) => ({
          ...attachment,
          uploadState: "error" as const,
        })),
        ...current,
      ].slice(0, 4));
      setMessageContexts((current) => [
        ...outgoingContexts,
        ...current.filter(
          (candidate) =>
            !outgoingContexts.some((context) => context.path === candidate.path),
        ),
      ].slice(0, 8));
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally {
      if (!accepted) setSending(false);
    }
  };
  const prepareNewTask = useCallback(
    (draft: NewTaskDraft) => {
      if (!settings || !draft.draftId || !draft.cwd.trim()) return Promise.resolve(null);
      const key = `${draft.draftId}:${draft.cwd}`;
      if (draftPreparationRef.current?.key === key)
        return draftPreparationRef.current.promise;

      const request = api(settings, "/api/thread-drafts", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId, cwd: draft.cwd }),
      });
      const tracked = request.catch((reason) => {
        if (draftPreparationRef.current?.promise === tracked)
          draftPreparationRef.current = null;
        throw reason;
      });
      draftPreparationRef.current = { key, promise: tracked };
      return tracked;
    },
    [settings],
  );
  const closeNewTask = useCallback(() => {
    const draftId = newTask.draftId;
    setShowNewTask(false);
    setRunPicker(null);
    draftPreparationRef.current = null;
    if (settings && draftId)
      void api(settings, `/api/thread-drafts/${encodeURIComponent(draftId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
  }, [newTask.draftId, settings]);
  const createTask = async () => {
    if (!settings || !newTask.cwd.trim() || !newTask.text.trim() || sending)
      return;
    setSending(true);
    try {
      await prepareNewTask(newTask);
      const response = await api<{
        thread: ThreadSummary;
        projectRegistration?: { status: string };
      }>(
        settings,
        "/api/threads",
        {
          method: "POST",
          body: JSON.stringify({
            ...newTask,
            ...(selectedNewTaskRunConfiguration
              ? { runConfiguration: selectedNewTaskRunConfiguration }
              : {}),
          }),
        },
      );
      setShowNewTask(false);
      draftPreparationRef.current = null;
      setNewTask({ draftId: "", cwd: "", text: "" });
      setNewTaskRunConfiguration(runOptions?.defaults || null);
      openTask(response.thread.id);
      setNotice(
        response.projectRegistration?.status === "registered"
          ? "新任务已启动，项目已同步到电脑 Codex"
          : "新任务已启动",
      );
      await refresh(settings, response.thread.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建任务失败");
    } finally {
      setSending(false);
    }
  };
  const decideApproval = async (approval: Approval, decision: string) => {
    if (!settings) return;
    try {
      await api(settings, `/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setApprovals((current) =>
        current.filter((item) => item.id !== approval.id),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审批失败");
    }
  };
  const updateQueue = async (
    id: string,
    update: { text?: string; direction?: "up" | "down" },
  ) => {
    if (!settings) return;
    try {
      await api(settings, `/api/queue/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(update),
      });
      setEditingQueue(null);
      await refresh(settings, selectedId, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "队列更新失败");
    }
  };
  const cancelQueue = async (id: string) => {
    if (!settings) return;
    await api(settings, `/api/queue/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await refresh(settings, selectedId, true);
  };
  const interrupt = async () => {
    if (!settings || !selectedId || stopping) return;
    setStopping(true);
    try {
      await api(
        settings,
        `/api/threads/${encodeURIComponent(selectedId)}/interrupt`,
        { method: "POST" },
      );
      setNotice("正在停止这一轮");
      await loadThread(settings, selectedId).catch(() => undefined);
    } catch (reason) {
      setStopping(false);
      setError(reason instanceof Error ? reason.message : "无法停止这个任务");
    }
  };
  const openGoalManager = () => {
    const parsed = splitGoalObjective(detail?.goal?.objective || "");
    setGoalObjective(parsed.objective);
    setGoalCompletion(parsed.completion);
    setShowComposerActions(false);
    setShowGoalSheet(true);
  };
  const saveGoal = async () => {
    if (!settings || !selectedId || !goalObjective.trim() || goalSaving) return;
    setGoalSaving(true);
    try {
      const response = await api<{ goal: ThreadGoal }>(
        settings,
        `/api/threads/${encodeURIComponent(selectedId)}/goal`,
        {
          method: "POST",
          body: JSON.stringify({
            objective: composeGoalObjective(goalObjective, goalCompletion),
            status: "active",
          }),
        },
      );
      setDetail((current) =>
        current?.thread.id === selectedId
          ? { ...current, goal: response.goal }
          : current,
      );
      setShowGoalSheet(false);
      setNotice(detail?.goal ? "Goal 已更新" : "已设为 Goal");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法设置 Goal");
    } finally {
      setGoalSaving(false);
    }
  };
  const changeGoalStatus = async (status: ThreadGoalStatus) => {
    if (!settings || !selectedId || goalSaving) return;
    setGoalSaving(true);
    try {
      const response = await api<{ goal: ThreadGoal }>(
        settings,
        `/api/threads/${encodeURIComponent(selectedId)}/goal`,
        { method: "POST", body: JSON.stringify({ status }) },
      );
      setDetail((current) =>
        current?.thread.id === selectedId
          ? { ...current, goal: response.goal }
          : current,
      );
      setNotice(status === "paused" ? "Goal 已暂停" : "Goal 已继续");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新 Goal");
    } finally {
      setGoalSaving(false);
    }
  };
  const clearGoal = async () => {
    if (!settings || !selectedId || goalSaving) return;
    setGoalSaving(true);
    try {
      await api(
        settings,
        `/api/threads/${encodeURIComponent(selectedId)}/goal`,
        { method: "DELETE" },
      );
      setDetail((current) =>
        current?.thread.id === selectedId ? { ...current, goal: null } : current,
      );
      setShowGoalSheet(false);
      setNotice("Goal 已结束");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法结束 Goal");
    } finally {
      setGoalSaving(false);
    }
  };
  const loadContextBrowser = useCallback(async (
    mode: ContextPickerMode,
    targetPath?: string,
  ) => {
    if (!settings) return;
    setContextPickerMode(mode);
    setShowComposerActions(false);
    setContextBrowseLoading(true);
    try {
      const response = await api<BrowseResponse>(
        settings,
        `/api/fs/browse?includeFiles=true${targetPath ? `&path=${encodeURIComponent(targetPath)}` : ""}`,
      );
      setContextBrowse(response);
      setContextSearch("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取电脑文件");
    } finally {
      setContextBrowseLoading(false);
    }
  }, [settings]);
  const openContextBrowser = (mode: ContextPickerMode) =>
    void loadContextBrowser(mode, detail?.thread.cwd || undefined);
  const addMessageContext = (entry: { name: string; path: string; kind: "file" | "folder" }) => {
    setMessageContexts((current) => {
      if (current.some((candidate) => candidate.path === entry.path)) return current;
      if (current.length >= 8) {
        setError("每条消息最多添加 8 个电脑文件或文件夹");
        return current;
      }
      return [...current, { ...entry, id: createDraftId() }];
    });
    setContextPickerMode(null);
    setContextBrowse(null);
  };
  const openOnDesktop = async () => {
    if (!settings || !selectedId || !detail || openingOnDesktop) return;
    setOpeningOnDesktop(true);
    setError(null);
    try {
      const response = await api<{
        opened: boolean;
        placement?: "project" | "projectless" | "unassigned";
      }>(
        settings,
        `/api/threads/${encodeURIComponent(selectedId)}/open-desktop`,
        { method: "POST" },
      );
      setNotice(
        response.placement === "projectless"
          ? "已在电脑聊天区打开；可通过任务菜单“移动到项目”归档"
          : "已在电脑 Codex 中打开",
      );
      await refresh(settings, selectedId, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法在电脑打开这个任务");
      await refresh(settings, selectedId, true).catch(() => undefined);
    } finally {
      setOpeningOnDesktop(false);
    }
  };
  const openBrowser = useCallback(async (targetPath?: string) => {
    if (!settings) return;
    setBrowseLoading(true);
    try {
      const response = await api<BrowseResponse>(
        settings,
        `/api/fs/browse${targetPath ? `?path=${encodeURIComponent(targetPath)}` : ""}`,
      );
      setBrowse(response);
      setFolderSearch("");
      setShowCreateFolder(false);
      setNewFolderName("");
      setShowFolderPicker(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取电脑文件夹");
    } finally {
      setBrowseLoading(false);
    }
  }, [settings]);
  const createNewFolder = async () => {
    if (!settings || !browse?.path || !newFolderName.trim() || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const created = await api<{
        name: string;
        path: string;
        projectRegistration?: { status: string };
      }>(
        settings,
        "/api/fs/folders",
        {
          method: "POST",
          body: JSON.stringify({ parent: browse.path, name: newFolderName }),
        },
      );
      setNotice(
        created.projectRegistration?.status === "registered"
          ? `已创建 ${created.name}，并添加到电脑 Codex`
          : `已创建 ${created.name}`,
      );
      localStorage.setItem(lastWorkspaceKey, created.path);
      const nextDraft = {
        ...newTask,
        draftId: newTask.draftId || createDraftId(),
        cwd: created.path,
      };
      setNewTask(nextDraft);
      void prepareNewTask(nextDraft).catch(() => undefined);
      setShowCreateFolder(false);
      setNewFolderName("");
      setShowFolderPicker(false);
      setShowNewTask(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法新建文件夹");
    } finally {
      setCreatingFolder(false);
    }
  };
  const startNewTask = (cwd = "") => {
    const fallback =
      cwd || localStorage.getItem(lastWorkspaceKey) || workspaces[0]?.cwd || "";
    const draft = { draftId: createDraftId(), cwd: fallback, text: "" };
    setNewTask(draft);
    setNewTaskRunConfiguration(runOptions?.defaults || null);
    setShowNewTask(true);
    if (fallback) void prepareNewTask(draft).catch(() => undefined);
  };
  const selectTaskWorkspace = (cwd: string) => {
    localStorage.setItem(lastWorkspaceKey, cwd);
    const draft = {
      ...newTask,
      draftId: newTask.draftId || createDraftId(),
      cwd,
    };
    setNewTask(draft);
    void prepareNewTask(draft).catch(() => undefined);
    setShowFolderPicker(false);
    setShowNewTask(true);
  };

  useEffect(() => {
    const handleBack = () => {
      if (window.CodexBridgeCloseImage?.()) return true;
      if (showGoalSheet) {
        setShowGoalSheet(false);
        return true;
      }
      if (contextPickerMode) {
        if (contextBrowse?.parent)
          void loadContextBrowser(contextPickerMode, contextBrowse.parent);
        else {
          setContextPickerMode(null);
          setContextBrowse(null);
        }
        return true;
      }
      if (showComposerActions) {
        setShowComposerActions(false);
        return true;
      }
      if (runPicker) {
        setRunPicker(null);
        return true;
      }
      if (showCreateFolder) {
        setShowCreateFolder(false);
        setNewFolderName("");
        return true;
      }
      if (showFolderPicker) {
        if (browse?.parent) void openBrowser(browse.parent);
        else setShowFolderPicker(false);
        return true;
      }
      if (showNewTask) {
        closeNewTask();
        return true;
      }
      if (showTaskList) {
        setShowTaskList(false);
        return true;
      }
      if (showSettings && settings) {
        setShowSettings(false);
        return true;
      }
      return false;
    };
    window.CodexBridgeHandleBack = handleBack;
    return () => {
      if (window.CodexBridgeHandleBack === handleBack) {
        delete window.CodexBridgeHandleBack;
      }
    };
  }, [browse?.parent, closeNewTask, contextBrowse?.parent, contextPickerMode, loadContextBrowser, openBrowser, runPicker, settings, showComposerActions, showCreateFolder, showFolderPicker, showGoalSheet, showNewTask, showSettings, showTaskList]);

  useEffect(() => {
    const hasOpenLayer =
      showNewTask ||
      showFolderPicker ||
      showSettings ||
      showTaskList ||
      showComposerActions ||
      showGoalSheet ||
      Boolean(contextPickerMode) ||
      Boolean(runPicker);
    if (!hasOpenLayer) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [contextPickerMode, runPicker, showComposerActions, showFolderPicker, showGoalSheet, showNewTask, showSettings, showTaskList]);

  useEffect(() => {
    if (!showNewTask || showFolderPicker || runPicker) return;
    const frame = window.requestAnimationFrame(() => newTaskInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [runPicker, showFolderPicker, showNewTask]);

  useEffect(() => {
    if (!showCreateFolder) return;
    const frame = window.requestAnimationFrame(() => newFolderInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showCreateFolder]);

  const appHeader = (title: string, subtitle?: string, leading?: ReactNode) => (
    <header className="app-header">
      <div className="header-leading">
        {leading || <Image className="brand-mark" src="/codex-bridge-c.svg" alt="" width={34} height={34} />}
        <div>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      <div className="header-actions">
        <ConnectionBadge state={connection} />
        <button
          className="icon-button"
          onClick={() => setShowSettings(true)}
          aria-label="设置"
        >
          <Gear />
        </button>
      </div>
    </header>
  );

  const homeScreen = (
    <section className="screen home-screen">
      {appHeader("Codex Bridge", undefined)}
      <div className="screen-scroll">
        <section className="hero-section">
          <div className="section-title">
            <span>
              <Play />
              正在运行
            </span>
            {activeThreads.length > 1 ? (
              <small>{activeThreads.length} 个任务</small>
            ) : null}
          </div>
          {activeThreads.length ? (
            activeThreads.map((thread) => (
              <article className="active-task" key={thread.id}>
                <div className="task-heading">
                  <div className="task-icon">
                    <CheckCircle />
                  </div>
                  <div>
                    <h2>{threadTitle(thread)}</h2>
                    <p>
                      <Folder />
                      {workspaceName(thread.cwd)}
                      <span>·</span>
                      <Clock />
                      {relativeTime(thread.recencyAt || thread.updatedAt)}
                    </p>
                  </div>
                </div>
                <p className="task-preview">
                  {thread.preview || "Codex 正在处理这个任务"}
                </p>
                <button
                  className="primary-button"
                  onClick={() => openTask(thread.id)}
                >
                  继续任务
                  <ArrowRight />
                </button>
              </article>
            ))
          ) : (
            <article className="empty-state">
              <CheckCircle />
              <h2>当前没有运行中的任务</h2>
              <p>可以继续最近任务，或者选择工作区新建任务。</p>
              <button className="primary-button" onClick={() => startNewTask()}>
                新任务
                <Plus />
              </button>
            </article>
          )}
        </section>
        <section className="attention-section">
          <div className="section-title">
            <span>
              <Bell />
              需要你处理
            </span>
            {approvals.length + queue.length ? (
              <small>{approvals.length + queue.length}</small>
            ) : null}
          </div>
          <div className="grouped-list">
            {approvals.map((approval) => (
              <button
                className="attention-row"
                key={approval.id}
                onClick={() => {
                  const threadId = String(approval.params.threadId || "");
                  if (threadId) openTask(threadId);
                  else setScreen("task");
                }}
              >
                <span className="row-icon approval-icon">
                  <Warning />
                </span>
                <span>
                  <strong>任务等待批准</strong>
                  <small>
                    {String(approval.params.reason || approval.method)}
                  </small>
                </span>
                <CaretRight />
              </button>
            ))}
            {queue.map((item) => {
              const thread = threads.find(
                (candidate) => candidate.id === item.threadId,
              );
              return (
                <button
                  className="attention-row"
                  key={item.id}
                  onClick={() => openTask(item.threadId)}
                >
                  <span className="row-icon queue-icon">
                    <Clock />
                  </span>
                  <span>
                    <strong>1 条消息已排队</strong>
                    <small>{thread ? threadTitle(thread) : item.text}</small>
                  </span>
                  <CaretRight />
                </button>
              );
            })}
            {!approvals.length && !queue.length ? (
              <div className="attention-empty">
                <Check />
                <span>没有需要处理的事项</span>
              </div>
            ) : null}
          </div>
        </section>
        {recentThreads.length ? (
          <section className="recent-section">
            <div className="section-title">
              <span>
                <Clock />
                最近任务
              </span>
              <button className="text-button" onClick={openTaskPicker}>
                全部 {historicalThreadCount}
              </button>
            </div>
            <div className="grouped-list">
              {recentThreads.map((thread) => (
                <button
                  className="simple-task-row"
                  onClick={() => openTask(thread.id)}
                  key={thread.id}
                >
                  <span>
                    <strong>{threadTitle(thread)}</strong>
                    <small>
                      {workspaceName(thread.cwd)} ·{" "}
                      {relativeTime(thread.recencyAt || thread.updatedAt)}
                    </small>
                  </span>
                  <CaretRight />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );

  const approvalsForTask = approvals.filter(
    (approval) =>
      !selectedId ||
      !approval.params.threadId ||
      approval.params.threadId === selectedId,
  );
  const pendingMessagesForTask = pendingUserMessages.filter(
    (pending) => pending.threadId === selectedId,
  );
  const conversationVersion = detail
    ? [
        detail.thread.id,
        detail.thread.updatedAt,
        detail.thread.turns.length,
        liveText.length,
        activeQueue.length,
        approvalsForTask.length,
        pendingMessagesForTask.length,
        pendingMessagesForTask.map((pending) => pending.status).join(","),
      ].join(":")
    : "empty";

  useEffect(() => {
    if (
      screen !== "task" ||
      !detail ||
      detail.thread.id !== selectedId ||
      (!pendingTaskScrollRef.current && !followLatestRef.current)
    )
      return;

    const frame = window.requestAnimationFrame(() => {
      scrollToLatest("auto");
      scheduleTaskScrollSettled();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationVersion, detail, scheduleTaskScrollSettled, screen, scrollToLatest, selectedId]);

  useEffect(() => {
    if (screen !== "task" || !detail || detail.thread.id !== selectedId)
      return;
    const content = conversationContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!pendingTaskScrollRef.current && !followLatestRef.current) return;
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        scrollToLatest("auto");
        scheduleTaskScrollSettled();
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [detail, scheduleTaskScrollSettled, screen, scrollToLatest, selectedId]);

  const handleConversationScroll = () => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (pendingTaskScrollRef.current) {
      followLatestRef.current = true;
      setShowScrollLatest(false);
      return;
    }
    const distanceFromBottom =
      conversation.scrollHeight -
      conversation.scrollTop -
      conversation.clientHeight;
    const isNearLatest = distanceFromBottom < 80;
    followLatestRef.current = isNearLatest;
    setShowScrollLatest(!isNearLatest);
  };

  const taskScreen = (
    <section className="screen task-screen">
      {appHeader(
        selectedThread ? threadTitle(selectedThread) : "当前任务",
        selectedThread
          ? `${workspaceName(selectedThread.cwd)} · ${selectedThread.cwd}`
          : "选择一个任务",
        <button
          className="icon-button"
          onClick={openTaskPicker}
          aria-label="任务列表"
        >
          <List />
        </button>,
      )}
      <div className="task-status-bar">
        {detail ? <TaskState detail={detail} /> : null}
        {detail ? (
          <div className="task-status-actions">
            <button
              className="desktop-open-action"
              disabled={!canOpenOnDesktop || openingOnDesktop}
              onClick={() => void openOnDesktop()}
              title={
                canOpenOnDesktop
                  ? "在电脑 Codex 中打开这个任务"
                  : "任务完成并释放后即可打开"
              }
            >
              <DesktopTower />
              {openingOnDesktop
                ? "正在打开…"
                : canOpenOnDesktop
                  ? "在电脑打开"
                  : "完成后可打开"}
            </button>
          </div>
        ) : null}
      </div>
      <div className="conversation-frame">
        <div
          className="conversation"
          ref={conversationRef}
          onScroll={handleConversationScroll}
        >
          <div className="conversation-content" ref={conversationContentRef}>
            {!detail ? (
              <section className="empty-state">
                <ChatCircleDots />
                <h2>选择一个任务</h2>
                <p>从首页或任务列表打开桌面历史任务。</p>
                <button
                  className="secondary-button"
                  onClick={openTaskPicker}
                >
                  打开任务列表
                </button>
              </section>
            ) : (
              <>
            {detail.history?.hasEarlierTurns ? (
              <button className="history-note" onClick={() => void loadEarlierTurns()}>
                <Clock />
                加载更早记录 · 已显示最近 {detail.history.returnedTurns} 轮，共 {detail.history.totalTurns} 轮
              </button>
            ) : null}
            {approvalsForTask.map((approval) => (
              <article className="approval-card" key={approval.id}>
                <div>
                  <Warning />
                  <span>
                    <strong>Codex 请求批准</strong>
                    <small>
                      {String(approval.params.reason || approval.method)}
                    </small>
                  </span>
                </div>
                {approval.params.command ? (
                  <code>{String(approval.params.command)}</code>
                ) : null}
                <footer>
                  <button
                    onClick={() => void decideApproval(approval, "decline")}
                  >
                    拒绝
                  </button>
                  <button
                    onClick={() =>
                      void decideApproval(approval, "acceptForSession")
                    }
                  >
                    本次允许
                  </button>
                  <button
                    className="primary"
                    onClick={() => void decideApproval(approval, "accept")}
                  >
                    允许
                  </button>
                </footer>
              </article>
            ))}
            {detail.thread.turns.map((turn, index) => (
              <TurnView
                turn={turn}
                key={turn.id}
                onCopied={setNotice}
                settings={settings}
                threadId={detail.thread.id}
                active={
                  index === detail.thread.turns.length - 1 &&
                  !detail.handoff.bridgeActive &&
                  (detail.handoff.desktopActive ||
                    detail.handoff.state === "active" ||
                    detail.thread.status.type === "active")
                }
              />
            ))}
            {pendingMessagesForTask.map((pending) => (
              <article
                className="user-message user-message-pending"
                key={pending.id}
              >
                {pending.attachmentPreviews?.length ? (
                  <div className="pending-image-grid">
                    {pending.attachmentPreviews.map((source) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={source} alt="待发送图片" key={source} />
                    ))}
                  </div>
                ) : null}
                {pending.contextNames?.length ? (
                  <div className="user-message-contexts">
                    {pending.contextNames.map((name) => (
                      <span key={name}>
                        <FileIcon />
                        {name}
                      </span>
                    ))}
                  </div>
                ) : null}
                {pending.text ? <p>{pending.text}</p> : null}
                <small className="user-message-delivery" role="status">
                  {pending.status === "sending" ? "正在发送…" : "已送达"}
                </small>
              </article>
            ))}
            {liveText && detail.handoff.bridgeActive ? (
              <MarkdownContent text={liveText} live onCopied={setNotice} />
            ) : detail.handoff.bridgeActive ? (
              <ThinkingShimmer />
            ) : null}
            {activeQueue.map((item, index) => (
              <article className="queue-card" key={item.id}>
                {editingQueue === item.id ? (
                  <textarea
                    value={queueDraft}
                    onChange={(event) => setQueueDraft(event.target.value)}
                    rows={3}
                  />
                ) : (
                  <div>
                    <span>排队 {index + 1}</span>
                    <p>
                      {item.text ||
                        (item.attachmentCount
                          ? "图片消息"
                          : item.contextCount
                            ? "电脑文件上下文"
                            : "")}
                    </p>
                    <small>
                      等待当前轮结束
                      {item.attachmentCount ? ` · ${item.attachmentCount} 张图片` : ""}
                      {item.contextCount ? ` · ${item.contextCount} 个电脑路径` : ""}
                    </small>
                  </div>
                )}
                <footer>
                  {editingQueue === item.id ? (
                    <>
                      <button onClick={() => setEditingQueue(null)}>
                        取消编辑
                      </button>
                      <button
                        className="primary"
                        disabled={!queueDraft.trim()}
                        onClick={() =>
                          void updateQueue(item.id, { text: queueDraft })
                        }
                      >
                        保存
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() =>
                          void updateQueue(item.id, { direction: "up" })
                        }
                        disabled={index === 0}
                        aria-label="上移"
                      >
                        <ArrowUp />
                      </button>
                      <button
                        onClick={() =>
                          void updateQueue(item.id, { direction: "down" })
                        }
                        disabled={index === activeQueue.length - 1}
                        aria-label="下移"
                      >
                        <ArrowDown />
                      </button>
                      <button
                        onClick={() => {
                          setEditingQueue(item.id);
                          setQueueDraft(item.text);
                        }}
                      >
                        <PencilSimple />
                        编辑
                      </button>
                      <button
                        className="danger"
                        onClick={() => void cancelQueue(item.id)}
                      >
                        <Trash />
                        取消
                      </button>
                    </>
                  )}
                </footer>
              </article>
            ))}
              </>
            )}
          </div>
        </div>
        {detail && showScrollLatest ? (
          <button
            className="scroll-latest-button"
            onClick={() => scrollToLatest("auto")}
          >
            <ArrowDown />
            回到最新
          </button>
        ) : null}
      </div>
      {detail ? (
        <footer className="composer-wrap">
          {activeQueue.length ? (
            <div className="queue-inline">
              <Clock />
              <span>{activeQueue.length} 条消息待发送</span>
            </div>
          ) : null}
          <div className="composer-surface">
            {detail.goal ? (
              <button
                className={`goal-status-strip goal-${detail.goal.status}`}
                type="button"
                onClick={openGoalManager}
              >
                <Flag />
                <span>
                  <strong>{splitGoalObjective(detail.goal.objective).objective}</strong>
                  <small>
                    {goalStatusLabel(detail.goal.status)}
                    {detail.goal.timeUsedSeconds > 0
                      ? ` · ${compactDuration(detail.goal.timeUsedSeconds)}`
                      : ""}
                  </small>
                </span>
                <CaretRight />
              </button>
            ) : null}
            <RunConfigurationBar
              compact
              configuration={selectedTaskRunConfiguration}
              options={runOptions}
              pending={Boolean(selectedTaskBusy && selectedTaskRunConfigurationPatch)}
              onOpen={(kind) => openRunConfigurationPicker("task", kind)}
            />
            {messageAttachments.length ? (
              <div className="composer-attachments" aria-label="待发送图片">
                {messageAttachments.map((attachment) => (
                  <span className={`is-${attachment.uploadState}`} key={attachment.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={attachment.previewUrl} alt="待发送图片预览" />
                    <button
                      type="button"
                      onClick={() => removeMessageImage(attachment.id)}
                      aria-label="移除图片"
                    >
                      <X />
                    </button>
                    <em className="composer-attachment-state" aria-live="polite">
                      {attachment.uploadState === "uploading"
                        ? "上传中"
                        : attachment.uploadState === "ready"
                          ? "已就绪"
                          : "待重试"}
                    </em>
                  </span>
                ))}
              </div>
            ) : null}
            {messageContexts.length ? (
              <div className="composer-contexts" aria-label="待发送电脑文件">
                {messageContexts.map((context) => (
                  <span title={context.path} key={context.id}>
                    {context.kind === "folder" ? <Folder /> : <FileIcon />}
                    <strong>{context.name}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        setMessageContexts((current) =>
                          current.filter((candidate) => candidate.id !== context.id),
                        )
                      }
                      aria-label={`移除 ${context.name}`}
                    >
                      <X />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer">
              <input
                ref={imageInputRef}
                className="composer-file-input"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => void selectMessageImages(event.target.files)}
              />
              <button
                className="composer-add-button"
                type="button"
                disabled={sending}
                onClick={() => setShowComposerActions(true)}
                aria-label="添加内容"
              >
                <Plus />
              </button>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={
                   detail.handoff.bridgeActive
                     ? "继续输入，将追加到当前任务…"
                     : detail.handoff.state === "active"
                       ? "桌面处理中，发送后自动排队…"
                       : detail.handoff.state === "unknown"
                         ? "确认桌面状态中，发送后自动排队…"
                       : "继续告诉 Codex…"
                }
                rows={1}
              />
              {composerPrimaryAction === "stop" ? (
                <button
                  className="composer-stop-button"
                  disabled={stopping}
                  onClick={() => void interrupt()}
                  aria-label={stopping ? "正在停止" : "停止当前回答"}
                >
                  <Stop weight="fill" />
                </button>
              ) : (
                <button
                  disabled={!composerHasDraft || sending}
                  onClick={() => void sendMessage()}
                  aria-label="发送"
                >
                  <PaperPlaneTilt />
                </button>
              )}
            </div>
          </div>
        </footer>
      ) : null}
    </section>
  );

  const selectedWorkspace = workspaceFilter
    ? workspaces.find((item) => item.key === workspaceFilter)
    : null;
  const workspaceScreen = (
    <section className="screen workspace-screen">
      {appHeader(
        selectedWorkspace ? selectedWorkspace.name : "工作区",
        selectedWorkspace?.cwd,
        selectedWorkspace ? (
          <button
            className="icon-button"
            onClick={() => setWorkspaceFilter(null)}
            aria-label="返回工作区"
          >
            <ArrowLeft />
          </button>
        ) : undefined,
      )}
      <div className="screen-scroll">
        <div className="workspace-actions">
          <button
            className="primary-button"
            onClick={() => startNewTask(selectedWorkspace?.cwd || "")}
          >
            <Plus />
            新任务
          </button>
          <button
            className="secondary-button"
            disabled={browseLoading || connection !== "online"}
            onClick={() => void openBrowser(selectedWorkspace?.cwd)}
          >
            <FolderOpen />
            选择电脑文件夹
          </button>
        </div>
        {selectedWorkspace ? (
          <section className="workspace-detail">
            <div className="section-title">
              <span>
                <ChatCircleDots />
                任务
              </span>
              <small>{selectedWorkspace.threads.length}</small>
            </div>
            <div className="grouped-list">
              {selectedWorkspace.threads.map((thread) => (
                <button
                  className="simple-task-row"
                  onClick={() => openTask(thread.id)}
                  key={thread.id}
                >
                  <span>
                    <strong>{threadTitle(thread)}</strong>
                    <small>
                      {relativeTime(thread.recencyAt || thread.updatedAt)}
                    </small>
                  </span>
                  <TaskState thread={thread} />
                  <CaretRight />
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section>
            <div className="section-title">
              <span>
                <Folders />
                最近工作区
              </span>
              <small>{workspaces.length}</small>
            </div>
            <div className="workspace-list">
              {workspaces.map((workspace) => (
                <button
                  className="workspace-row"
                  key={workspace.key}
                  onClick={() => setWorkspaceFilter(workspace.key)}
                >
                  <span className="workspace-icon">
                    <Folder />
                  </span>
                  <span>
                    <strong>{workspace.name}</strong>
                    <small>{workspace.cwd}</small>
                    <em>
                      {workspace.threads.length} 个任务 ·{" "}
                      {relativeTime(workspace.updatedAt)}
                    </em>
                  </span>
                  <CaretRight />
                </button>
              ))}
              {!workspaces.length ? (
                <div className="empty-state">
                  <FolderOpen />
                  <h2>还没有工作区</h2>
                  <p>从电脑选择一个文件夹并创建任务。</p>
                </div>
              ) : null}
            </div>
          </section>
        )}
      </div>
    </section>
  );

  return (
    <main className="bridge-shell">
      {screen === "home"
        ? homeScreen
        : screen === "task"
          ? taskScreen
          : workspaceScreen}
      <nav className="bottom-nav">
        <button
          className={screen === "home" ? "active" : ""}
          onClick={() => setScreen("home")}
        >
          <House />
          <span>首页</span>
        </button>
        <button
          className={screen === "task" ? "active" : ""}
          onClick={openCurrentTask}
        >
          <ChatCircleDots />
          <span>当前任务</span>
          {activeQueue.length ? <em>{activeQueue.length}</em> : null}
        </button>
        <button
          className={screen === "workspaces" ? "active" : ""}
          onClick={() => setScreen("workspaces")}
        >
          <Folders />
          <span>工作区</span>
        </button>
      </nav>

      {showTaskList ? (
        <div className="sheet-backdrop">
          <section className="bottom-sheet task-picker">
            <header>
              <div>
                <span className="eyebrow">Codex 历史</span>
                <h2>选择任务</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setShowTaskList(false)}
              >
                <X />
              </button>
            </header>
            <label className="search-box">
              <MagnifyingGlass />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索任务、工作区或路径"
              />
            </label>
            <div className="picker-list">
              {filteredThreads.map((thread) => (
                <button
                  className={thread.id === selectedId ? "selected" : ""}
                  key={thread.id}
                  onClick={() => openTask(thread.id)}
                >
                  <span>
                    <strong>{threadTitle(thread)}</strong>
                    <small>{thread.preview || "暂无摘要"}</small>
                    <em>
                      {workspaceName(thread.cwd)} ·{" "}
                      {relativeTime(thread.recencyAt || thread.updatedAt)}
                    </em>
                  </span>
                  <TaskState thread={thread} />
                </button>
              ))}
              {!filteredThreads.length ? (
                <div className="task-picker-empty">
                  <ChatCircleDots />
                  <strong>{threads.length ? "没有匹配的任务" : "还没有历史任务"}</strong>
                  <small>
                    {threads.length
                      ? "换个关键词试试"
                      : "在首页新建任务后会显示在这里"}
                  </small>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {showSettings ? (
        <div className="modal-backdrop">
          <section className="modal-card pairing-card">
            <header>
              <div>
                <span className="eyebrow">电脑连接</span>
                <h2>{settings ? "连接设置" : "连接 Codex Bridge"}</h2>
              </div>
              {settings ? (
                <button
                  className="icon-button"
                  onClick={() => {
                    pairingAbortRef.current?.abort();
                    setPairingProgress("idle");
                    setShowSettings(false);
                  }}
                >
                  <X />
                </button>
              ) : null}
            </header>
            <div className="scan-hero">
              <Image className="pairing-brand-mark" src="/codex-bridge-c.svg" alt="" width={68} height={68} />
              <h3>扫码连接电脑</h3>
              <p>在电脑打开配对页，用 App 扫描二维码即可自动连接。</p>
              <button
                className="primary-button"
                onClick={() => window.CodexBridgeAndroid?.scanPairingCode?.()}
                disabled={!window.CodexBridgeAndroid?.scanPairingCode}
              >
                <QrCode />
                {window.CodexBridgeAndroid?.scanPairingCode
                  ? "打开扫码"
                  : "请使用 APK 扫码"}
              </button>
            </div>
            <div className="direct-pair">
              <label>
                电脑地址
                <input
                  value={draftSettings.server}
                  onChange={(event) =>
                    setDraftSettings((current) => ({
                      ...current,
                      server: event.target.value,
                    }))
                  }
                  placeholder="http://192.168.1.20:43110"
                  inputMode="url"
                  disabled={pairingProgress !== "idle"}
                />
              </label>
              <button
                className="primary-button"
                onClick={() => void requestComputerApproval()}
                disabled={pairingProgress !== "idle"}
              >
                <DesktopTower />
                {pairingProgress === "requesting"
                  ? "正在联系电脑…"
                  : pairingProgress === "waiting"
                    ? "等待电脑确认…"
                    : "向电脑发送连接请求"}
              </button>
              {pairingProgress === "waiting" ? (
                <div className="pairing-waiting" role="status">
                  <span className="pairing-spinner" aria-hidden="true" />
                  <span>
                    请在{pairingComputerName ? `电脑“${pairingComputerName}”` : "电脑"}
                    的 Codex Bridge 托盘弹窗中选择“允许”。
                  </span>
                </div>
              ) : null}
            </div>
            <details className="manual-pair">
              <summary>
                手动输入地址和令牌
                <CaretDown />
              </summary>
              <label>
                电脑服务地址
                <input
                  value={draftSettings.server}
                  onChange={(event) =>
                    setDraftSettings((current) => ({
                      ...current,
                      server: event.target.value,
                    }))
                  }
                  placeholder="https://codex.example.com"
                  inputMode="url"
                />
              </label>
              <label>
                配对令牌
                <input
                  value={draftSettings.token}
                  onChange={(event) =>
                    setDraftSettings((current) => ({
                      ...current,
                      token: event.target.value,
                    }))
                  }
                  placeholder="粘贴电脑端令牌"
                />
              </label>
              <button
                className="secondary-button"
                onClick={() => void saveConnection()}
              >
                手动连接
              </button>
            </details>
          </section>
        </div>
      ) : null}

      {showNewTask ? (
        <div className="new-task-backdrop">
          <section
            className="new-task-page"
            role="dialog"
            aria-modal={showFolderPicker || runPicker ? undefined : "true"}
            aria-hidden={showFolderPicker || Boolean(runPicker) || undefined}
            inert={showFolderPicker || Boolean(runPicker) || undefined}
            aria-labelledby="new-task-title"
          >
            <header className="new-task-header">
              <button
                className="icon-button"
                onClick={closeNewTask}
                aria-label="返回"
              >
                <ArrowLeft />
              </button>
              <h2 id="new-task-title">新建任务</h2>
              <span aria-hidden="true" />
            </header>

            <div className="new-task-content">
              <label className="new-task-composer">
                <span className="sr-only">任务说明</span>
                <PencilSimple />
                <textarea
                  ref={newTaskInputRef}
                  value={newTask.text}
                  maxLength={2000}
                  onChange={(event) =>
                    setNewTask((current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  placeholder="想让 Codex 做什么？"
                  rows={8}
                />
                <small>{newTask.text.length}/2000</small>
              </label>

              <RunConfigurationBar
                configuration={selectedNewTaskRunConfiguration}
                options={runOptions}
                onOpen={(kind) => openRunConfigurationPicker("new-task", kind)}
              />

              <section className="new-task-project-section">
                <h3>当前项目</h3>
                <button
                  className="new-task-project-row selected"
                  onClick={() => void openBrowser(newTask.cwd || undefined)}
                >
                  <span className="project-row-icon">
                    <FolderOpen />
                  </span>
                  <span>
                    <strong>{newTask.cwd ? workspaceName(newTask.cwd) : "选择电脑文件夹"}</strong>
                    {newTask.cwd ? <small>{workspacePathLabel(newTask.cwd)}</small> : null}
                  </span>
                  <CaretRight />
                </button>
              </section>

              {workspaces.some((workspace) => workspace.cwd !== newTask.cwd) ? (
                <section className="new-task-recent-section">
                  <h3>最近项目</h3>
                  <div className="new-task-recent-list">
                    {workspaces
                      .filter((workspace) => workspace.cwd !== newTask.cwd)
                      .slice(0, 2)
                      .map((workspace) => (
                        <button
                          key={workspace.cwd}
                          onClick={() => selectTaskWorkspace(workspace.cwd)}
                        >
                          <Folder />
                          <span>
                            <strong>{workspace.name}</strong>
                            <small>{workspacePathLabel(workspace.cwd)}</small>
                          </span>
                          <CaretRight />
                        </button>
                      ))}
                  </div>
                </section>
              ) : null}
            </div>

            <footer className="new-task-footer">
              <button
                className="primary-button"
                disabled={!newTask.cwd.trim() || !newTask.text.trim() || sending}
                onClick={() => void createTask()}
              >
                <Play />
                {sending ? "正在启动" : "开始任务"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {showComposerActions ? (
        <div className="sheet-backdrop composer-actions-backdrop">
          <section
            className="bottom-sheet composer-actions-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-actions-title"
          >
            <header>
              <div>
                <span className="eyebrow">添加到当前任务</span>
                <h2 id="composer-actions-title">添加内容</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowComposerActions(false)}
                aria-label="关闭"
              >
                <X />
              </button>
            </header>
            <div className="composer-action-list">
              <button
                type="button"
                disabled={messageAttachments.length >= 4}
                onClick={() => {
                  setShowComposerActions(false);
                  imageInputRef.current?.click();
                }}
              >
                <ImageSquare />
                <span>
                  <strong>手机图片</strong>
                  <small>从相册选择并发送图片</small>
                </span>
                <CaretRight />
              </button>
              <button type="button" onClick={() => openContextBrowser("file")}>
                <FileIcon />
                <span>
                  <strong>电脑文件</strong>
                  <small>选择当前电脑上的一个文件</small>
                </span>
                <CaretRight />
              </button>
              <button type="button" onClick={() => openContextBrowser("folder")}>
                <FolderOpen />
                <span>
                  <strong>电脑文件夹</strong>
                  <small>将整个目录作为任务上下文</small>
                </span>
                <CaretRight />
              </button>
              <button type="button" onClick={openGoalManager}>
                <Flag />
                <span>
                  <strong>{detail?.goal ? "管理 Goal" : "设为 Goal"}</strong>
                  <small>让当前桌面任务持续执行到完成条件</small>
                </span>
                <CaretRight />
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showGoalSheet && detail ? (
        <div className="sheet-backdrop goal-sheet-backdrop">
          <section
            className="bottom-sheet goal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="goal-sheet-title"
          >
            <header>
              <div>
                <span className="eyebrow">当前桌面任务</span>
                <h2 id="goal-sheet-title">
                  {detail.goal ? "管理 Goal" : "设为 Goal"}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowGoalSheet(false)}
                aria-label="关闭"
              >
                <X />
              </button>
            </header>
            {detail.goal ? (
              <div className={`goal-summary goal-${detail.goal.status}`}>
                <Flag />
                <span>
                  <strong>{goalStatusLabel(detail.goal.status)}</strong>
                  <small>
                    已运行 {compactDuration(detail.goal.timeUsedSeconds)}
                    {detail.goal.tokensUsed > 0
                      ? ` · ${detail.goal.tokensUsed.toLocaleString("zh-CN")} tokens`
                      : ""}
                  </small>
                </span>
              </div>
            ) : null}
            <div className="goal-form">
              <label>
                目标
                <textarea
                  value={goalObjective}
                  maxLength={3600}
                  rows={4}
                  onChange={(event) => setGoalObjective(event.target.value)}
                  placeholder="例如：完成图片预览重构并通过全部测试"
                />
              </label>
              <label>
                完成条件
                <textarea
                  value={goalCompletion}
                  maxLength={1200}
                  rows={3}
                  onChange={(event) => setGoalCompletion(event.target.value)}
                  placeholder="例如：构建成功、自动化测试通过，并完成真机验证"
                />
              </label>
              <small>Goal 会绑定到当前任务，电脑端仍是唯一执行方。</small>
            </div>
            <footer className="goal-actions">
              {detail.goal ? (
                <>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={goalSaving}
                    onClick={() => void clearGoal()}
                  >
                    结束 Goal
                  </button>
                  {detail.goal.status === "active" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={goalSaving}
                      onClick={() => void changeGoalStatus("paused")}
                    >
                      <Pause />
                      暂停
                    </button>
                  ) : (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={goalSaving}
                      onClick={() => void changeGoalStatus("active")}
                    >
                      <Play />
                      继续
                    </button>
                  )}
                </>
              ) : null}
              <button
                className="primary-button"
                type="button"
                disabled={!goalObjective.trim() || goalSaving}
                onClick={() => void saveGoal()}
              >
                <Flag />
                {goalSaving ? "正在保存" : detail.goal ? "更新 Goal" : "设为 Goal"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {contextPickerMode ? (
        <div className="modal-backdrop folder-backdrop context-picker-backdrop">
          <section
            className="folder-picker context-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="context-picker-title"
          >
            <header className="folder-picker-header">
              <button
                className="icon-button"
                onClick={() => {
                  setContextPickerMode(null);
                  setContextBrowse(null);
                }}
                aria-label="关闭电脑文件选择"
              >
                <X />
              </button>
              <div>
                <span className="eyebrow">当前电脑</span>
                <h2 id="context-picker-title">
                  {contextPickerMode === "file" ? "选择文件" : "选择文件夹"}
                </h2>
              </div>
              <span aria-hidden="true" />
            </header>
            {contextBrowse?.path ? (
              <div className="breadcrumb">
                <button onClick={() => void loadContextBrowser(contextPickerMode)}>
                  <HardDrives />
                </button>
                {contextBrowse.path
                  .split(/[\\/]/)
                  .filter(Boolean)
                  .map((part, index, parts) => {
                    const currentPath = /^[A-Za-z]:$/.test(parts[0])
                      ? `${parts[0]}\\${parts.slice(1, index + 1).join("\\")}`
                      : `/${parts.slice(0, index + 1).join("/")}`;
                    return (
                      <React.Fragment key={currentPath}>
                        <CaretRight />
                        <button
                          onClick={() =>
                            void loadContextBrowser(contextPickerMode, currentPath)
                          }
                        >
                          {part}
                        </button>
                      </React.Fragment>
                    );
                  })}
              </div>
            ) : null}
            <label className="search-box context-search-box">
              <MagnifyingGlass />
              <input
                aria-label="筛选当前目录"
                value={contextSearch}
                onChange={(event) => setContextSearch(event.target.value)}
                placeholder="筛选当前目录"
              />
            </label>
            <div className="folder-list context-list">
              {contextBrowseLoading ? (
                <div className="context-loading">正在读取电脑文件…</div>
              ) : null}
              {contextBrowse?.parent ? (
                <button
                  onClick={() =>
                    void loadContextBrowser(contextPickerMode, contextBrowse.parent!)
                  }
                >
                  <ArrowLeft />
                  <span>
                    <strong>返回上级</strong>
                    <small>{contextBrowse.parent}</small>
                  </span>
                </button>
              ) : null}
              {contextBrowse?.shortcuts.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => void loadContextBrowser(contextPickerMode, entry.path)}
                >
                  <DesktopTower />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.path}</small>
                  </span>
                  <CaretRight />
                </button>
              ))}
              {contextBrowse?.roots.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => void loadContextBrowser(contextPickerMode, entry.path)}
                >
                  <HardDrives />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.path}</small>
                  </span>
                  <CaretRight />
                </button>
              ))}
              {contextBrowse?.entries
                .filter((entry) =>
                  entry.name.toLowerCase().includes(contextSearch.trim().toLowerCase()),
                )
                .filter((entry) => contextPickerMode === "file" || entry.kind === "folder")
                .map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() =>
                      entry.kind === "folder"
                        ? void loadContextBrowser(contextPickerMode, entry.path)
                        : addMessageContext({
                            name: entry.name,
                            path: entry.path,
                            kind: "file",
                          })
                    }
                  >
                    {entry.kind === "folder" ? <Folder /> : <FileIcon />}
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{entry.path}</small>
                    </span>
                    {entry.kind === "folder" ? <CaretRight /> : <Plus />}
                  </button>
                ))}
            </div>
            {contextPickerMode === "folder" ? (
              <footer className="folder-selection-bar">
                <div>
                  <small>当前选择</small>
                  <strong>
                    {contextBrowse?.path
                      ? workspaceName(contextBrowse.path)
                      : "选择一个文件夹"}
                  </strong>
                  {contextBrowse?.path ? <span>{contextBrowse.path}</span> : null}
                </div>
                <button
                  className="primary-button"
                  disabled={!contextBrowse?.path}
                  onClick={() =>
                    contextBrowse?.path &&
                    addMessageContext({
                      name: workspaceName(contextBrowse.path),
                      path: contextBrowse.path,
                      kind: "folder",
                    })
                  }
                >
                  添加文件夹
                </button>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}

      {runPicker && runOptions ? (
        <RunConfigurationSheet
          picker={runPicker}
          options={runOptions}
          configuration={
            (runPicker.target === "new-task"
              ? selectedNewTaskRunConfiguration
              : selectedTaskRunConfiguration) || runOptions.defaults
          }
          onChange={updatePickedRunConfiguration}
          onClose={() => setRunPicker(null)}
        />
      ) : null}

      {showFolderPicker ? (
        <div className="modal-backdrop folder-backdrop">
          <section
            className="folder-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-picker-title"
          >
            <header className="folder-picker-header">
              <button
                className="icon-button"
                onClick={() => {
                  setShowFolderPicker(false);
                  if (!showNewTask) setWorkspaceFilter(null);
                }}
                aria-label="关闭项目选择"
              >
                <X />
              </button>
              <div>
                <span className="eyebrow">电脑文件夹</span>
                <h2 id="folder-picker-title">选择项目</h2>
              </div>
              <span aria-hidden="true" />
            </header>
            {browse?.path ? (
              <div className="breadcrumb">
                <button onClick={() => void openBrowser()}>
                  <HardDrives />
                </button>
                {browse.path
                  .split(/[\\/]/)
                  .filter(Boolean)
                  .map((part, index, parts) => {
                    const currentPath = /^[A-Za-z]:$/.test(parts[0])
                      ? `${parts[0]}\\${parts.slice(1, index + 1).join("\\")}`
                      : `/${parts.slice(0, index + 1).join("/")}`;
                    return (
                      <React.Fragment key={currentPath}>
                        <CaretRight />
                        <button onClick={() => void openBrowser(currentPath)}>
                          {part}
                        </button>
                      </React.Fragment>
                    );
                  })}
              </div>
            ) : null}
            <div className="folder-toolbar">
              <label className="search-box">
                <MagnifyingGlass />
                <input
                  aria-label="筛选当前目录"
                  value={folderSearch}
                  onChange={(event) => setFolderSearch(event.target.value)}
                  placeholder="筛选当前目录"
                />
              </label>
              {browse?.path ? (
                <button
                  className="new-folder-button"
                  type="button"
                  disabled={browseLoading}
                  onClick={() => setShowCreateFolder(true)}
                >
                  <Plus />
                  新建
                </button>
              ) : null}
            </div>
            {showCreateFolder && browse?.path ? (
              <form
                className="new-folder-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createNewFolder();
                }}
              >
                <input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  maxLength={120}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  placeholder="输入新文件夹名称"
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateFolder(false);
                    setNewFolderName("");
                  }}
                >
                  取消
                </button>
                <button type="submit" disabled={!newFolderName.trim() || creatingFolder}>
                  {creatingFolder ? "创建中" : "创建并使用"}
                </button>
              </form>
            ) : null}
            <div className="folder-list">
              {!browse?.path && workspaces.length ? (
                <>
                  <div className="folder-list-label">最近项目</div>
                  {workspaces.slice(0, 3).map((workspace) => (
                    <button
                      key={`recent-${workspace.cwd}`}
                      onClick={() => selectTaskWorkspace(workspace.cwd)}
                    >
                      <Folder />
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>{workspacePathLabel(workspace.cwd)}</small>
                      </span>
                      <CaretRight />
                    </button>
                  ))}
                  <div className="folder-list-label">电脑位置</div>
                </>
              ) : null}
              {browse?.parent ? (
                <button onClick={() => void openBrowser(browse.parent!)}>
                  <ArrowLeft />
                  <span>
                    <strong>返回上级</strong>
                    <small>{browse.parent}</small>
                  </span>
                </button>
              ) : null}
              {browse?.shortcuts.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => void openBrowser(entry.path)}
                >
                  <DesktopTower />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{workspacePathLabel(entry.path)}</small>
                  </span>
                  <CaretRight />
                </button>
              ))}
              {browse?.roots.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => void openBrowser(entry.path)}
                >
                  <HardDrives />
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{workspacePathLabel(entry.path)}</small>
                  </span>
                  <CaretRight />
                </button>
              ))}
              {browse?.entries
                .filter((entry) =>
                  entry.name
                    .toLowerCase()
                    .includes(folderSearch.trim().toLowerCase()),
                )
                .map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => void openBrowser(entry.path)}
                  >
                    <Folder />
                    <span>
                      <strong>{entry.name}</strong>
                    </span>
                    <CaretRight />
                  </button>
                ))}
            </div>
            <footer className="folder-selection-bar">
              <div>
                <small>当前选择</small>
                <strong>{browse?.path ? workspaceName(browse.path) : "选择一个文件夹"}</strong>
                {browse?.path ? <span>{workspacePathLabel(browse.path)}</span> : null}
              </div>
              <button
                className="primary-button"
                disabled={!browse?.path}
                onClick={() => browse?.path && selectTaskWorkspace(browse.path)}
              >
                使用这个文件夹
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {error ? (
        <div className="toast toast-error">
          <XCircle />
          <p>{error}</p>
          <button onClick={() => setError(null)}>
            <X />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="toast toast-notice">
          <Check />
          <p>{notice}</p>
        </div>
      ) : null}
    </main>
  );
}
