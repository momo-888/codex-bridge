import assert from "node:assert/strict";
import test from "node:test";
import { collectThreadPages } from "../app/thread-catalog";

test("loads every Codex thread page and preserves recency order", async () => {
  const requestedCursors: Array<string | null> = [];
  const pages = new Map([
    ["first", { data: [{ id: "thread-3" }, { id: "thread-2" }], nextCursor: "page-2" }],
    ["page-2", { data: [{ id: "thread-1" }], nextCursor: null }],
  ]);

  const threads = await collectThreadPages(async (cursor) => {
    requestedCursors.push(cursor);
    return pages.get(cursor || "first")!;
  });

  assert.deepEqual(requestedCursors, [null, "page-2"]);
  assert.deepEqual(threads, [
    { id: "thread-3" },
    { id: "thread-2" },
    { id: "thread-1" },
  ]);
});

test("rejects a repeated Codex pagination cursor", async () => {
  await assert.rejects(
    collectThreadPages(async () => ({ data: [], nextCursor: "same-cursor" })),
    /重复的任务分页游标/,
  );
});
