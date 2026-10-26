import { z } from "zod";

import {
  requireWindowsNativeAuthority,
  windowsFileIdentitySchema,
  windowsHandleSchema,
  type WindowsNativeAuthority,
} from "./WindowsNativeLoader.js";

const openedFileSchema = windowsFileIdentitySchema.extend({
  handle: windowsHandleSchema,
  directory: z.literal(false),
});

/** A native lease remains owned even when its file metadata could not be admitted. */
export interface WindowsImmutableFileCleanupOwner {
  close(): Promise<void>;
}

/** Identity validation failed after a native handle was acquired; callers own its cleanup. */
export class WindowsImmutableFileAdmissionFailure extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
    readonly owner: WindowsImmutableFileCleanupOwner,
  ) {
    super(`Immutable Windows file identity could not be admitted: ${path}`, {
      cause,
    });
    this.name = "WindowsImmutableFileAdmissionFailure";
  }
}

/** One native NTFS read lease whose path components and contents cannot be replaced or written. */
export class WindowsImmutableFile implements WindowsImmutableFileCleanupOwner {
  private constructor(
    private readonly identity: Readonly<
      z.infer<typeof windowsFileIdentitySchema>
    >,
    private readonly owner: ImmutableFileLease,
  ) {}

  get path(): string {
    return this.identity.requestedPath;
  }

  get size(): number {
    return this.identity.size;
  }

  static open(path: string): WindowsImmutableFile {
    requirePathText(path);
    const authority = requireWindowsNativeAuthority();
    const observed: unknown = authority.call("open", [path]);
    return WindowsImmutableFile.fromNativeObservation(
      path,
      authority,
      observed,
    );
  }

  /** Adopt a file already opened by an owning runtime without reopening its parent paths. */
  static fromNativeObservation(
    path: string,
    authority: WindowsNativeAuthority,
    observed: unknown,
  ): WindowsImmutableFile {
    const handle = windowsHandleSchema.parse(
      observed !== null && typeof observed === "object"
        ? Reflect.get(observed, "handle")
        : undefined,
    );
    // Adopt the opaque handle before parsing any metadata that can fail.
    const owner = new ImmutableFileLease(authority, handle);
    try {
      requirePathText(path);
      const identity = openedFileSchema.parse(observed);
      if (
        identity.handle !== handle ||
        identity.requestedPath !== path ||
        identity.finalPath.length === 0
      )
        throw new Error(
          "Native immutable file identity changed the requested file or handle.",
        );
      return new WindowsImmutableFile(Object.freeze(identity), owner);
    } catch (cause) {
      throw new WindowsImmutableFileAdmissionFailure(path, cause, owner);
    }
  }

  /** Read one exact admitted range, bounded by the existing native 64 KiB operation. */
  read(offset: number, length: number): Buffer {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > 65536 ||
      offset > this.size - length
    )
      throw new RangeError(
        "Immutable Windows file read exceeds its extent or 64 KiB chunk limit.",
      );
    const bytes: unknown = this.owner.read(offset, length);
    if (!Buffer.isBuffer(bytes) || bytes.length !== length)
      throw new Error(
        "Native immutable file read did not return the exact requested bytes.",
      );
    return bytes;
  }

  close(): Promise<void> {
    return this.owner.close();
  }
}

const requirePathText = (path: string): void => {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0"))
    throw new TypeError(
      "Immutable Windows file path must be nonempty and NUL-free.",
    );
};

type LeaseState =
  | { readonly kind: "open" }
  | { readonly kind: "closing"; readonly pending: Promise<void> }
  | { readonly kind: "closed" }
  | { readonly kind: "unconfirmed"; readonly cause: unknown };

/** The ABI has no closed-state probe, so a throwing close cannot be retried safely. */
class ImmutableFileLease implements WindowsImmutableFileCleanupOwner {
  #state: LeaseState = { kind: "open" };

  constructor(
    private readonly authority: WindowsNativeAuthority,
    private readonly handle: object,
  ) {}

  read(offset: number, length: number): unknown {
    if (this.#state.kind !== "open")
      throw new Error(
        "Immutable Windows file lease is closed, closing, or has unconfirmed cleanup.",
      );
    return this.authority.call("read", [this.handle, offset, length]);
  }

  close(): Promise<void> {
    if (this.#state.kind === "closed") return Promise.resolve();
    if (this.#state.kind === "closing") return this.#state.pending;
    if (this.#state.kind === "unconfirmed")
      return Promise.reject(this.#state.cause);
    const pending = Promise.resolve().then(() => {
      try {
        if (this.authority.call("close", [this.handle]) !== null)
          throw new Error(
            "Native immutable file close returned no valid confirmation.",
          );
        this.#state = { kind: "closed" };
      } catch (cause) {
        this.#state = { kind: "unconfirmed", cause };
        throw cause;
      }
    });
    this.#state = { kind: "closing", pending };
    return pending;
  }
}
