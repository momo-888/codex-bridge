import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sharp } from "./sharp-runtime";

type JsonRecord = Record<string, unknown>;

const MAX_PREVIEW_BYTES = 3_800_000;
const MAX_MOBILE_IMAGE_BYTES = 4_800_000;
const MAX_PREVIEW_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 256;
const MAX_PREVIEWS = 96;

type StoredImage = {
  savedPath?: string;
  dataUri?: string;
  seenAt: number;
};

type StoredPreview = {
  asset: GeneratedImageAsset;
  seenAt: number;
};

export type LocalMarkdownImageReference = {
  source: string;
  id: string;
};

export type GeneratedImageAsset = {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  fileName: string;
};

export class GeneratedImageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function localPathFromMarkdownSource(source: string) {
  const value = source.trim();
  try {
    if (/^file:\/\//i.test(value)) return fileURLToPath(value);
  } catch {
    return null;
  }
  if (path.isAbsolute(value)) return path.normalize(value);
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value);
  return null;
}

export function localMarkdownImageReferences(itemValue: unknown): LocalMarkdownImageReference[] {
  const item = asRecord(itemValue);
  if (item?.type !== "agentMessage" || typeof item.id !== "string" || typeof item.text !== "string")
    return [];

  const references: LocalMarkdownImageReference[] = [];
  const seen = new Set<string>();
  const pattern = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|((?:[a-z]:[\\/]|\/)[^)\r\n]+))\s*\)/gi;
  for (const match of item.text.matchAll(pattern)) {
    const source = (match[1] || match[2] || "").trim();
    const savedPath = localPathFromMarkdownSource(source);
    if (!savedPath || seen.has(source)) continue;
    seen.add(source);
    references.push({
      source,
      id: `media-${createHash("sha256").update(`${item.id}\0${source}`).digest("base64url").slice(0, 24)}`,
    });
  }
  return references;
}

function imageMime(bytes: Buffer): GeneratedImageAsset["mimeType"] | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

function extensionFor(mimeType: GeneratedImageAsset["mimeType"]) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function validateAsset(
  bytes: Buffer,
  preferredName: string,
  maxBytes = MAX_MOBILE_IMAGE_BYTES,
): GeneratedImageAsset {
  if (!bytes.length) throw new GeneratedImageError("Generated image is empty", 404);
  if (bytes.length > maxBytes)
    throw new GeneratedImageError("Generated image is too large for mobile delivery", 413);
  const mimeType = imageMime(bytes);
  if (!mimeType) throw new GeneratedImageError("Generated file is not a supported image", 415);
  const base = path.basename(preferredName, path.extname(preferredName)) || "generated-image";
  return { bytes, mimeType, fileName: `${base}${extensionFor(mimeType)}` };
}

export class GeneratedImageStore {
  private readonly images = new Map<string, StoredImage>();
  private readonly previews = new Map<string, StoredPreview>();
  private readonly mobileImages = new Map<string, StoredPreview>();

  registerThread(detail: unknown) {
    const thread = asRecord(asRecord(detail)?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!threadId || !Array.isArray(thread?.turns)) return;

    for (const turnValue of thread.turns) {
      const turn = asRecord(turnValue);
      if (!Array.isArray(turn?.items)) continue;
      for (const itemValue of turn.items) {
        const item = asRecord(itemValue);
        if (item?.type === "imageGeneration" && typeof item.id === "string") {
          const savedPath = typeof item.savedPath === "string" && item.savedPath ? item.savedPath : undefined;
          const result = typeof item.result === "string" && item.result.startsWith("data:image/")
            ? item.result
            : undefined;
          if (savedPath || result) {
            this.images.set(this.key(threadId, item.id), {
              ...(savedPath ? { savedPath } : {}),
              ...(!savedPath && result ? { dataUri: result } : {}),
              seenAt: Date.now(),
            });
          }
        }

        for (const reference of localMarkdownImageReferences(item)) {
          const savedPath = localPathFromMarkdownSource(reference.source);
          if (!savedPath) continue;
          this.images.set(this.key(threadId, reference.id), { savedPath, seenAt: Date.now() });
        }
      }
    }
    this.trim();
  }

  has(threadId: string, itemId: string) {
    return this.images.has(this.key(threadId, itemId));
  }

  async read(threadId: string, itemId: string): Promise<GeneratedImageAsset> {
    const key = this.key(threadId, itemId);
    const cached = this.mobileImages.get(key);
    if (cached) {
      cached.seenAt = Date.now();
      return cached.asset;
    }

    const source = await this.readWithLimit(threadId, itemId, MAX_PREVIEW_SOURCE_BYTES);
    if (source.bytes.length <= MAX_MOBILE_IMAGE_BYTES) return source;

    const baseName = path.basename(source.fileName, path.extname(source.fileName));
    const candidates = [
      { size: 4096, quality: 88 },
      { size: 3072, quality: 86 },
      { size: 2560, quality: 82 },
    ];
    for (const candidate of candidates) {
      try {
        const bytes = await sharp(source.bytes, { animated: false, sequentialRead: true })
          .rotate()
          .resize({
            width: candidate.size,
            height: candidate.size,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: candidate.quality, effort: 1 })
          .toBuffer();
        if (bytes.length > MAX_MOBILE_IMAGE_BYTES) continue;
        const asset = validateAsset(bytes, `${baseName}-mobile.webp`, MAX_MOBILE_IMAGE_BYTES);
        this.mobileImages.set(key, { asset, seenAt: Date.now() });
        this.trimAssets(this.mobileImages);
        return asset;
      } catch {
        break;
      }
    }
    throw new GeneratedImageError("A mobile version could not be created for this image", 415);
  }

  private async readWithLimit(
    threadId: string,
    itemId: string,
    maxBytes: number,
  ): Promise<GeneratedImageAsset> {
    const entry = this.images.get(this.key(threadId, itemId));
    if (!entry) throw new GeneratedImageError("Generated image was not found", 404);
    entry.seenAt = Date.now();

    if (entry.savedPath) {
      try {
        const metadata = await stat(entry.savedPath);
        if (metadata.size > maxBytes)
          throw new GeneratedImageError("Generated image is too large for mobile delivery", 413);
        return validateAsset(await readFile(entry.savedPath), path.basename(entry.savedPath), maxBytes);
      } catch (error) {
        if (error instanceof GeneratedImageError) throw error;
        throw new GeneratedImageError("Generated image file is no longer available", 404);
      }
    }

    const match = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([a-z0-9+/=\r\n]+)$/i.exec(
      entry.dataUri || "",
    );
    if (!match) throw new GeneratedImageError("Generated image data is unavailable", 404);
    const encoded = match[1].replace(/\s/g, "");
    if (encoded.length > Math.ceil(maxBytes * 4 / 3) + 4)
      throw new GeneratedImageError("Generated image is too large for mobile delivery", 413);
    return validateAsset(Buffer.from(encoded, "base64"), `generated-${itemId}`, maxBytes);
  }

  async readPreview(threadId: string, itemId: string): Promise<GeneratedImageAsset> {
    const key = this.key(threadId, itemId);
    const cached = this.previews.get(key);
    if (cached) {
      cached.seenAt = Date.now();
      return cached.asset;
    }

    // A source may be much larger than the mobile delivery limit. Read it on
    // the computer and shrink it before deciding whether the preview is safe
    // to send. This keeps very large screenshots useful without pushing the
    // full file over the network just to render the chat card.
    const original = await this.readWithLimit(threadId, itemId, MAX_PREVIEW_SOURCE_BYTES);
    const baseName = path.basename(original.fileName, path.extname(original.fileName));
    let bytes: Buffer;
    try {
      bytes = await sharp(original.bytes, { animated: false })
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch {
      // A valid-looking but partially damaged image should still remain viewable.
      // The browser receives the original only for this exceptional case.
      if (original.bytes.length <= MAX_MOBILE_IMAGE_BYTES) return original;
      throw new GeneratedImageError("A mobile preview could not be created for this image", 415);
    }
    const asset = validateAsset(bytes, `${baseName}-preview.webp`, MAX_PREVIEW_BYTES);
    this.previews.set(key, { asset, seenAt: Date.now() });
    this.trimPreviews();
    return asset;
  }

  private key(threadId: string, itemId: string) {
    return `${threadId}\0${itemId}`;
  }

  private trim() {
    if (this.images.size <= MAX_ENTRIES) return;
    const oldest = [...this.images.entries()]
      .sort((left, right) => left[1].seenAt - right[1].seenAt)
      .slice(0, this.images.size - MAX_ENTRIES);
    for (const [key] of oldest) this.images.delete(key);
  }

  private trimPreviews() {
    this.trimAssets(this.previews);
  }

  private trimAssets(store: Map<string, StoredPreview>) {
    if (store.size <= MAX_PREVIEWS) return;
    const oldest = [...store.entries()]
      .sort((left, right) => left[1].seenAt - right[1].seenAt)
      .slice(0, store.size - MAX_PREVIEWS);
    for (const [key] of oldest) store.delete(key);
  }
}
