import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { AttachmentRef } from "@dumbways/protocol";

import { ToolExecutionError } from "../tools/ToolExecutionError";

/**
 * Local media registry (spec §9, §0M, §85).
 *
 * Media never travels inside a message. A file is copied into `.coach/media/`,
 * hashed, and referenced by id; whoever needs the bytes asks for them
 * separately. Base64 in the request envelope would blow the context budget on
 * one screenshot and make every log unreadable.
 *
 * No `vscode` import — this is files and hashes, and it is where a mistake
 * means the wrong bytes leave the machine.
 */

/** Spec §10. Anything not on this list is refused rather than guessed at. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface MediaRegistryOptions {
  /** Usually `<workspace>/.coach/media`. */
  mediaDir: string;
  maxBytes?: number;
  log?: (message: string) => void;
}

interface StoredIndex {
  version: 1;
  items: (AttachmentRef & { registeredAt: string })[];
}

export function mimeTypeFor(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

export function supportedExtensions(): string[] {
  return Object.keys(MIME_BY_EXTENSION);
}

export class MediaRegistry {
  private items = new Map<string, AttachmentRef & { registeredAt: string }>();
  private loaded = false;

  constructor(private readonly options: MediaRegistryOptions) {}

  private get indexPath(): string {
    return path.join(this.options.mediaDir, "index.json");
  }

  private get maxBytes(): number {
    return this.options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as StoredIndex;
      if (parsed.version === 1 && Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          // An index entry whose file has been deleted is not an attachment.
          if (await exists(item.localMediaPath)) {
            this.items.set(item.id, item);
          }
        }
      }
    } catch {
      // No index yet is the normal first-run case.
    }
  }

  list(): AttachmentRef[] {
    return [...this.items.values()].map(stripInternal);
  }

  get(id: string): AttachmentRef | undefined {
    const item = this.items.get(id);
    return item ? stripInternal(item) : undefined;
  }

  /**
   * Copies a file into the media directory and registers it.
   *
   * Deduplicated by SHA-256 (spec §85): attaching the same screenshot twice
   * reuses one object rather than filling the directory with copies.
   */
  async register(sourcePath: string, source: AttachmentRef["source"]): Promise<AttachmentRef> {
    await this.load();

    const mimeType = mimeTypeFor(sourcePath);
    if (!mimeType) {
      throw new ToolExecutionError(
        "UNSUPPORTED",
        `Unsupported file type "${path.extname(sourcePath) || "(none)"}". Supported: ${supportedExtensions().join(", ")}.`,
      );
    }

    const stats = await fs.stat(sourcePath).catch(() => {
      throw new ToolExecutionError("NOT_FOUND", `File not found: ${sourcePath}`);
    });
    if (!stats.isFile()) {
      throw new ToolExecutionError("INVALID_ARGUMENT", "Only regular files can be attached.");
    }
    if (stats.size > this.maxBytes) {
      throw new ToolExecutionError(
        "TOO_LARGE",
        `${path.basename(sourcePath)} is ${stats.size} bytes, over the ${this.maxBytes} byte limit.`,
      );
    }

    const bytes = await fs.readFile(sourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const existing = [...this.items.values()].find((item) => item.sha256 === sha256);
    if (existing && (await exists(existing.localMediaPath))) {
      this.options.log?.(`[media] reusing ${existing.id} (same sha256)`);
      return stripInternal(existing);
    }

    const id = `media_${sha256.slice(0, 12)}`;
    const target = path.join(this.options.mediaDir, `${id}${path.extname(sourcePath).toLowerCase()}`);

    await fs.mkdir(this.options.mediaDir, { recursive: true });
    await fs.writeFile(target, bytes, { mode: 0o600 });

    const ref: AttachmentRef & { registeredAt: string } = {
      id,
      filename: path.basename(sourcePath),
      mimeType,
      size: stats.size,
      sha256,
      source,
      localMediaPath: target,
      registeredAt: new Date().toISOString(),
    };

    this.items.set(id, ref);
    await this.persist();
    this.options.log?.(`[media] registered ${id} (${ref.filename}, ${ref.size} bytes)`);

    return stripInternal(ref);
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const item = this.items.get(id);
    if (!item) {
      return false;
    }
    this.items.delete(id);
    await fs.rm(item.localMediaPath, { force: true });
    await this.persist();
    return true;
  }

  /** Spec §86: a retention policy, not an unbounded directory. */
  async cleanup(olderThanDays: number): Promise<number> {
    await this.load();
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const item of [...this.items.values()]) {
      if (Date.parse(item.registeredAt) < cutoff) {
        this.items.delete(item.id);
        await fs.rm(item.localMediaPath, { force: true });
        removed += 1;
      }
    }

    if (removed > 0) {
      await this.persist();
    }
    return removed;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.options.mediaDir, { recursive: true });
    const index: StoredIndex = { version: 1, items: [...this.items.values()] };
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  }
}

function stripInternal(item: AttachmentRef & { registeredAt: string }): AttachmentRef {
  const { registeredAt: _ignored, ...ref } = item;
  return ref;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
