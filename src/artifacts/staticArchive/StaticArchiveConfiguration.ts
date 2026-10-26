import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import {
  WindowsImmutableFile,
  WindowsImmutableFileAdmissionFailure,
} from "../../windows/WindowsImmutableFile.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";

const pinSchema = z.strictObject({
  path: z.string().min(1),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const manifestSchema = z.strictObject({
  protocol: z.literal("rea.static-archive-installation/1"),
  root: z.string().refine(isAbsolute),
  python: z.literal("python/python.exe"),
  bridge: z.literal("source/rea_bridge/strict_static_archive_bridge.py"),
  python_version: z.literal("3.14.10"),
  backend_version: z.literal("0.11.2"),
  backend_repository: z.literal(
    "https://github.com/RestrainedAi/rea-binary-refinery",
  ),
  backend_revision: z.string().regex(/^[a-f0-9]{40}$/u),
  files: z.array(pinSchema).min(3).max(4096),
});

export type StaticArchiveInstallation = z.infer<typeof manifestSchema> & {
  readonly pythonPath: string;
  readonly bridgePath: string;
  readonly executableSha256: string;
};

/** Retained handles keep admitted analyzer files immutable during the command. */
export interface StaticArchiveToolPin {
  readonly path: string;
  readonly owner: { close(): Promise<void> };
  readonly file?: WindowsImmutableFile;
}

/** Admit only the explicitly configured, fully pinned application-local analyzer. */
export const pinStaticArchiveInstallation = async (
  manifestPath: string,
  pins: StaticArchiveToolPin[],
  signal?: AbortSignal,
): Promise<StaticArchiveInstallation> => {
  if (!isAbsolute(manifestPath))
    throw new ArtifactReaderFailure(
      "path",
      "Static archive manifest path must be absolute.",
    );
  const manifestOwner = await admitPin(manifestPath, pins, signal);
  if (manifestOwner.size > 4 * 1024 * 1024)
    throw new ArtifactReaderFailure(
      "limit",
      "Static archive installation manifest exceeds 4 MiB.",
    );
  const manifest = manifestSchema.parse(
    JSON.parse(
      readImmutableFile(manifestOwner)
        .toString("utf8")
        .replace(/^\uFEFF/u, ""),
    ),
  );
  const root = await realpath(manifest.root);
  if (
    manifest.files.reduce((total, pin) => total + pin.bytes, 0) >
    256 * 1024 * 1024
  )
    throw new ArtifactReaderFailure(
      "limit",
      "Static archive analyzer pins exceed the 256 MiB aggregate ceiling.",
    );
  const names = new Set<string>();
  for (const pin of manifest.files) {
    signal?.throwIfAborted();
    if (!safeRelativePin(pin.path) || names.has(pin.path.toLowerCase()))
      throw new ArtifactReaderFailure(
        "path",
        "Static archive installation contains an unsafe or duplicate pin.",
      );
    names.add(pin.path.toLowerCase());
    const path = resolve(manifest.root, ...pin.path.split("/"));
    const resolved = await realpath(path);
    const inside = relative(root, resolved);
    if (
      inside === "" ||
      inside.startsWith(`..${sep}`) ||
      inside === ".." ||
      isAbsolute(inside) ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new ArtifactReaderFailure(
        "path",
        "Static archive analyzer pin escapes its configured root.",
      );
    const owner = await admitPin(path, pins, signal);
    if (
      owner.size !== pin.bytes ||
      (await hashStaticArchiveHandle(owner, signal)) !== pin.sha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Configured static archive analyzer pin changed: ${pin.path}`,
      );
  }
  for (const required of [
    manifest.python,
    manifest.bridge,
    "python/python314._pth",
    "python/python314.zip",
    "python/python314.dll",
  ])
    if (!manifest.files.some((pin) => pin.path === required))
      throw new ArtifactReaderFailure(
        "format",
        `Static archive installation omits required pin: ${required}`,
      );
  return {
    ...manifest,
    pythonPath: join(manifest.root, ...manifest.python.split("/")),
    bridgePath: join(manifest.root, ...manifest.bridge.split("/")),
    executableSha256: manifest.files.find(
      (pin) => pin.path === manifest.python,
    )!.sha256,
  };
};

const safeRelativePin = (path: string): boolean =>
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes(":") &&
  path
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        [...part].every((character) => character.charCodeAt(0) >= 32),
    );

export const retainStaticArchiveFile = (
  path: string,
  pins: StaticArchiveToolPin[],
  signal?: AbortSignal,
): WindowsImmutableFile => {
  try {
    signal?.throwIfAborted();
    const owner = WindowsImmutableFile.open(path);
    pins.push({ path, owner, file: owner });
    return owner;
  } catch (cause) {
    if (cause instanceof WindowsImmutableFileAdmissionFailure)
      pins.push({ path, owner: cause.owner });
    throw cause;
  }
};
const admitPin = retainStaticArchiveFile;

const readImmutableFile = (file: WindowsImmutableFile): Buffer => {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < file.size; offset += 65536)
    parts.push(file.read(offset, Math.min(65536, file.size - offset)));
  return Buffer.concat(parts, file.size);
};

/** Hash a retained descriptor without disturbing consumers' file positions. */
export const hashStaticArchiveHandle = async (
  handle: WindowsImmutableFile,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash("sha256");
  for (let offset = 0; offset < handle.size;) {
    signal?.throwIfAborted();
    const block = handle.read(offset, Math.min(65536, handle.size - offset));
    if (block.length === 0)
      throw new ArtifactReaderFailure(
        "integrity",
        "Pinned static archive file ended before its admitted extent.",
      );
    hash.update(block);
    offset += block.length;
    if (offset % (1024 * 1024) === 0) await yieldToEventLoop();
  }
  signal?.throwIfAborted();
  return hash.digest("hex");
};
