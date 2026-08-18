export type ThreadPage<T> = {
  data: T[];
  nextCursor: string | null;
};

export async function collectThreadPages<T>(
  fetchPage: (cursor: string | null) => Promise<ThreadPage<T>>,
  maxPages = 100,
) {
  const threads = new Map<string, T>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    for (const item of page.data) {
      const id =
        item && typeof item === "object" && "id" in item
          ? String((item as { id?: unknown }).id ?? "")
          : "";
      if (id) threads.set(id, item);
    }
    if (!page.nextCursor) return [...threads.values()];
    if (seenCursors.has(page.nextCursor))
      throw new Error("Codex 返回了重复的任务分页游标");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error(`Codex 任务超过 ${maxPages} 页，已停止加载以避免异常循环`);
}
