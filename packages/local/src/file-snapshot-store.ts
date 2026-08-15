import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { SnapshotAccess, SnapshotStore } from "@happy/runtime";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

export class FileSnapshotStore implements SnapshotStore {
  private readonly screenshotsRoot: string;

  constructor(private readonly root: string, private readonly options: {
    retainPerScout?: number;
    ttlMs?: number;
  } = {}) {
    this.screenshotsRoot = resolve(root, "screenshots");
  }

  async put(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<string> {
    const extension = input.contentType === "image/svg+xml" ? "svg" : "jpg";
    const directory = join(
      this.screenshotsRoot,
      digest(input.activityId),
      digest(input.itemId),
      digest(input.scoutId)
    );
    await mkdir(directory, { recursive: true });
    const filename = `${Date.now()}-${randomUUID()}.${extension}`;
    const absolute = join(directory, filename);
    await writeFile(absolute, input.bytes, { mode: 0o600 });
    await this.prune(directory);
    return absolute.slice(this.screenshotsRoot.length + 1).split(sep).join("/");
  }

  async get(key: string): Promise<SnapshotAccess | undefined> {
    if (!/^[a-f0-9/-]+\.(?:jpg|svg)$/.test(key)) return undefined;
    const absolute = resolve(this.screenshotsRoot, key);
    if (!absolute.startsWith(`${this.screenshotsRoot}${sep}`)) return undefined;
    try {
      const metadata = await stat(absolute);
      if (Date.now() - metadata.mtimeMs > (this.options.ttlMs ?? 86_400_000)) {
        await unlink(absolute).catch(() => undefined);
        return undefined;
      }
      return {
        kind: "bytes",
        bytes: await readFile(absolute),
        contentType: extname(absolute) === ".svg" ? "image/svg+xml" : "image/jpeg"
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    await this.walkAndRemoveExpired(this.screenshotsRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private async prune(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => ({
      name: entry.name,
      modified: (await stat(join(directory, entry.name))).mtimeMs
    })));
    files.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name));
    await Promise.all(files.slice(this.options.retainPerScout ?? 5).map((file) => unlink(join(directory, file.name))));
  }

  private async walkAndRemoveExpired(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return this.walkAndRemoveExpired(path);
      const metadata = await stat(path);
      if (Date.now() - metadata.mtimeMs > (this.options.ttlMs ?? 86_400_000)) await unlink(path);
    }));
  }
}
