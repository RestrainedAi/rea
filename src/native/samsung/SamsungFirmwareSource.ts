import { createHash } from "node:crypto";
import { lstat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  ArtifactResourceOwner,
  ArtifactResourceScope,
} from "../../artifacts/ArtifactResourceScope.js";
import {
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import {
  samsungFailureWithCleanup,
  samsungSourceReadFailure,
} from "./SamsungFirmwareFailure.js";

export type SamsungFirmwareOperation =
  | "inspect_samsung_firmware"
  | "extract_samsung_firmware";

/** One stable descriptor for bounded random header reads and streamed payload bytes. */
export class SamsungFirmwareSource {
  closeAttempted = false;
  #closed = false;
  private constructor(
    readonly path: string,
    readonly initial: Stats,
    readonly owner: Extract<ArtifactResourceOwner, { kind: "file-handle" }>,
    private readonly context: {
      readonly resources: ArtifactResourceScope;
      readonly operation: SamsungFirmwareOperation;
    },
  ) {}

  get bytes(): number {
    return this.initial.size;
  }

  static async open(
    path: string,
    maxBytes: number,
    resources: ArtifactResourceScope,
    operation: SamsungFirmwareOperation,
    signal?: AbortSignal,
  ): Promise<SamsungFirmwareSource> {
    signal?.throwIfAborted();
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      throw new ArtifactReaderFailure(
        "path",
        "Samsung firmware input must be a regular file without a symlink.",
      );
    if (before.size > maxBytes)
      throw new AnalysisResourceConstraintError(
        operation,
        "file-size",
        "Samsung firmware source exceeds the selected I/O byte budget.",
        { max_file_bytes: maxBytes },
      );
    let handle: FileHandle;
    try {
      handle = await openRegularFile(path, { symlinks: "reject", signal });
    } catch (cause) {
      if (cause instanceof RegularFileAdmissionFailure) {
        const owner = {
          kind: "file-handle" as const,
          resource: path,
          handle: cause.owner,
        };
        const released = await resources.release(owner);
        if (released.kind === "failed")
          throw samsungFailureWithCleanup(cause.cause, released.cause, {
            resource: path,
            operation,
          });
        throw cause.cause;
      }
      throw cause;
    }
    const owner = {
      kind: "file-handle" as const,
      resource: path,
      handle: new OwnedFileHandle(handle),
    };
    try {
      const initial = await handle.stat();
      if (!sameRegularFileState(before, initial))
        throw new AnalysisArtifactChangedError(
          operation,
          path,
          "Samsung firmware changed before its descriptor was admitted.",
        );
      signal?.throwIfAborted();
      return new SamsungFirmwareSource(path, initial, owner, {
        resources,
        operation,
      });
    } catch (cause) {
      const released = await resources.release(owner);
      if (released.kind === "failed")
        throw samsungFailureWithCleanup(cause, released.cause, {
          resource: path,
          operation,
        });
      throw cause;
    }
  }

  async readExact(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    signal?.throwIfAborted();
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Samsung firmware source is closed.",
      );
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.bytes - length ||
      length > 1024 * 1024
    )
      throw new ArtifactReaderFailure(
        "format",
        "Samsung firmware read exceeds its stable extent or 1 MiB read budget.",
      );
    const bytes = Buffer.allocUnsafe(length);
    for (let copied = 0; copied < length;) {
      signal?.throwIfAborted();
      const read = await this.owner.handle.handle
        .read(bytes, copied, length - copied, offset + copied)
        .catch((cause: unknown) => {
          throw samsungSourceReadFailure(
            cause,
            this.context.operation,
            this.path,
          );
        });
      if (read.bytesRead === 0)
        throw new AnalysisArtifactChangedError(
          this.context.operation,
          this.path,
          "Samsung firmware source was truncated while reading.",
        );
      copied += read.bytesRead;
    }
    signal?.throwIfAborted();
    return bytes;
  }

  stream(offset: number, bytes: number, signal?: AbortSignal): Readable {
    signal?.throwIfAborted();
    const read = this.readExact.bind(this);
    return Readable.from(
      (async function* () {
        for (let consumed = 0; consumed < bytes;) {
          const chunk = await read(
            offset + consumed,
            Math.min(65536, bytes - consumed),
            signal,
          );
          consumed += chunk.length;
          yield chunk;
        }
      })(),
      { objectMode: false },
    );
  }

  async verifyStable(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const [opened, current] = await Promise.all([
      this.owner.handle.handle.stat(),
      lstat(this.path),
    ]).catch((cause: unknown) => {
      throw samsungSourceReadFailure(cause, this.context.operation, this.path);
    });
    if (
      !sameRegularFileState(this.initial, opened) ||
      !sameRegularFileState(this.initial, current) ||
      current.isSymbolicLink()
    )
      throw new AnalysisArtifactChangedError(
        this.context.operation,
        this.path,
        "Samsung firmware source identity changed during analysis.",
      );
    signal?.throwIfAborted();
  }

  /** Rebind every source byte before publishing an export from this descriptor. */
  async verifyDigest(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const hash = createHash("sha256");
    for (let offset = 0; offset < this.bytes;) {
      const chunk = await this.readExact(
        offset,
        Math.min(1024 * 1024, this.bytes - offset),
        signal,
      );
      hash.update(chunk);
      offset += chunk.length;
    }
    await this.verifyStable(signal);
    if (hash.digest("hex") !== expectedSha256)
      throw new AnalysisArtifactChangedError(
        this.context.operation,
        this.path,
        "Samsung firmware source bytes changed after inventory.",
      );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.closeAttempted = true;
    const released = await this.context.resources.release(this.owner);
    if (released.kind === "failed")
      throw samsungFailureWithCleanup(released.cause, released.cause, {
        resource: this.path,
        operation: this.context.operation,
      });
    this.#closed = true;
  }
}
