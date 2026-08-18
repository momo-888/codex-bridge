import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexProjectRegistrar } from "../host/codex-projects";

test("does not launch Codex when the local project is already registered", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  let launches = 0;
  try {
    await writeFile(
      statePath,
      JSON.stringify({ "local-projects": { existing: { rootPaths: [root.toUpperCase()] } } }),
    );
    const registrar = new CodexProjectRegistrar({
      platform: "win32",
      statePath,
      launch: async () => { launches += 1; },
      registrationTimeoutMs: 10,
    });
    const result = await registrar.ensure(root);
    assert.equal(result.status, "already_registered");
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launches Codex with an unregistered local project and confirms registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  try {
    await writeFile(statePath, JSON.stringify({ "local-projects": {} }));
    const registrar = new CodexProjectRegistrar({
      platform: "win32",
      statePath,
      launch: async (projectPath) => {
        await writeFile(
          statePath,
          JSON.stringify({ "local-projects": { created: { rootPaths: [projectPath] } } }),
        );
      },
      registrationTimeoutMs: 500,
    });
    const result = await registrar.ensure(root);
    assert.equal(result.status, "registered");
    assert.equal(await registrar.isRegistered(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit desktop open focuses a different registered project and lets its catalog settle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  let launches = 0;
  const selectionSettleMs = 30;
  try {
    const projects = {
      current: { id: "current", rootPaths: [path.join(root, "current")] },
      target: { id: "target", rootPaths: [root] },
    };
    await writeFile(statePath, JSON.stringify({
      "local-projects": projects,
      "selected-project": { type: "local", projectId: "current" },
    }));
    const registrar = new CodexProjectRegistrar({
      platform: "win32",
      statePath,
      registrationTimeoutMs: 500,
      selectionSettleMs,
      launch: async (projectPath) => {
        launches += 1;
        assert.equal(projectPath, root);
        await writeFile(statePath, JSON.stringify({
          "local-projects": projects,
          "selected-project": { type: "local", projectId: "target" },
        }));
      },
    });

    const startedAt = Date.now();
    const result = await registrar.openProject(root);
    assert.equal(result.status, "opened");
    assert.equal(launches, 1);
    assert.ok(Date.now() - startedAt >= selectionSettleMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit desktop open does not relaunch a project that is already selected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  let launches = 0;
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        "local-projects": { target: { id: "target", rootPaths: [root] } },
        "selected-project": { type: "local", projectId: "target" },
      }),
    );
    const registrar = new CodexProjectRegistrar({
      platform: "win32",
      statePath,
      launch: async () => {
        launches += 1;
      },
      selectionSettleMs: 100,
    });

    const result = await registrar.openProject(root);
    assert.equal(result.status, "opened");
    assert.equal(launches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects whether Desktop classified a thread into a project or Chats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        "thread-project-assignments": { assigned: { projectId: "project-1" } },
        "projectless-thread-ids": ["chat"],
      }),
    );
    const registrar = new CodexProjectRegistrar({ platform: "win32", statePath });

    assert.equal(await registrar.getThreadPlacement("assigned"), "project");
    assert.equal(await registrar.getThreadPlacement("chat"), "projectless");
    assert.equal(await registrar.getThreadPlacement("new"), "unassigned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists the same named projects and thread assignments as Codex Desktop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        "local-projects": {
          older: {
            id: "older",
            name: "Older project",
            rootPaths: [path.join(root, "older")],
            createdAt: 100,
            updatedAt: 200,
          },
          recent: {
            id: "recent",
            name: "Recent project",
            rootPaths: [path.join(root, "recent"), path.join(root, "shared")],
            createdAt: 300,
            updatedAt: 400,
          },
        },
        "selected-project": { type: "local", projectId: "recent" },
        "thread-project-assignments": {
          "thread-1": { projectKind: "local", projectId: "recent" },
          "thread-2": { projectKind: "local", projectId: "recent" },
          "thread-3": { projectKind: "local", projectId: "older" },
        },
      }),
    );
    const registrar = new CodexProjectRegistrar({ platform: "darwin", statePath });

    const catalog = await registrar.listProjects();

    assert.equal(catalog.selectedProjectId, "recent");
    assert.deepEqual(
      catalog.data.map(({ id, name, rootPaths, threadIds }) => ({
        id,
        name,
        rootPaths: rootPaths.map((value) => path.basename(value)),
        threadIds,
      })),
      [
        {
          id: "recent",
          name: "Recent project",
          rootPaths: ["recent", "shared"],
          threadIds: ["thread-1", "thread-2"],
        },
        {
          id: "older",
          name: "Older project",
          rootPaths: ["older"],
          threadIds: ["thread-3"],
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not launch or guess placement when the Codex state file cannot be read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "missing-state.json");
  let launches = 0;
  try {
    const registrar = new CodexProjectRegistrar({
      platform: "win32",
      statePath,
      launch: async () => {
        launches += 1;
      },
      registrationTimeoutMs: 10,
    });

    const result = await registrar.ensure(root);
    assert.equal(result.status, "failed");
    assert.match(result.message || "", /Codex 桌面状态/);
    assert.equal(launches, 0);
    assert.equal(await registrar.getThreadPlacement("unknown-thread"), "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reveals a mobile thread through the desktop deep link", async () => {
  let revealedThreadId: string | null = null;
  const registrar = new CodexProjectRegistrar({
    platform: "win32",
    launchThread: async (threadId) => {
      revealedThreadId = threadId;
    },
  });

  assert.equal(await registrar.revealThread("mobile-thread"), true);
  assert.equal(revealedThreadId, "mobile-thread");
});

test("supports project registration and thread deep links on macOS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-project-test-"));
  const statePath = path.join(root, "state.json");
  let openedProject = "";
  let revealedThread = "";
  try {
    await writeFile(statePath, JSON.stringify({ "local-projects": {} }));
    const registrar = new CodexProjectRegistrar({
      platform: "darwin",
      statePath,
      launch: async (projectPath) => {
        openedProject = projectPath;
        await writeFile(
          statePath,
          JSON.stringify({ "local-projects": { created: { rootPaths: [projectPath] } } }),
        );
      },
      launchThread: async (threadId) => {
        revealedThread = threadId;
      },
      registrationTimeoutMs: 500,
    });

    assert.equal((await registrar.ensure(root)).status, "registered");
    assert.equal(openedProject, root);
    assert.equal(await registrar.revealThread("mac-thread"), true);
    assert.equal(revealedThread, "mac-thread");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not try to reveal desktop threads on unsupported platforms", async () => {
  let launches = 0;
  const registrar = new CodexProjectRegistrar({
    platform: "linux",
    launchThread: async () => {
      launches += 1;
    },
  });

  assert.equal(await registrar.revealThread("mobile-thread"), false);
  assert.equal(launches, 0);
});
