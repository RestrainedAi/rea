import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { hasSevenZipSignature } from "../../domain/sevenZipFormat.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
} from "../../filesystem/RegularFile.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import { WindowsPrivateRuntime } from "../../windows/WindowsPrivateRuntime.js";
import {
  pinStaticArchiveInstallation,
  retainStaticArchiveFile,
  type StaticArchiveInstallation,
} from "./StaticArchiveConfiguration.js";
import {
  STATIC_ARCHIVE_LIMITS,
  STATIC_ARCHIVE_METADATA_BYTES,
  STATIC_ARCHIVE_PROTOCOL,
  staticArchiveResponseSchema,
} from "./StaticArchiveProtocol.js";
import { StaticArchiveSession } from "./StaticArchiveSession.js";
import {
  StaticArchiveBridgeFailure,
  type StaticArchiveSnapshot,
} from "./StaticArchiveSnapshot.js";
export { StaticArchiveBridgeFailure } from "./StaticArchiveSnapshot.js";
export type {
  StaticArchiveSnapshot,
  StaticArchiveMember,
} from "./StaticArchiveSnapshot.js";

export interface StaticArchiveOpenInput {
  readonly path: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly expectedRootSha256?: string;
  readonly signal?: AbortSignal;
}

/** Decode admitted profiles using a pinned analyzer; supplied code is never launched. */
export const openStaticArchive = async (
  input: StaticArchiveOpenInput,
): Promise<StaticArchiveSnapshot | undefined> => {
  const format = await recognizeStaticArchive(input.path, input.signal);
  if (format === undefined) return undefined;
  if (process.platform !== "win32")
    throw new ArtifactReaderFailure(
      "unavailable",
      "The configured static archive decoder currently requires Windows private snapshots and enforced Job memory limits.",
    );
  const manifest = input.environment.REA_STATIC_ARCHIVE_MANIFEST;
  if (manifest === undefined || manifest === "")
    throw new ArtifactReaderFailure(
      "unavailable",
      "Recognized Inno/7z archive requires REA_STATIC_ARCHIVE_MANIFEST for the pinned optional static archive analyzer.",
    );
  const owner = new StaticArchiveSession();
  try {
    const inputLease = retainStaticArchiveFile(
      input.path,
      owner.pins,
      input.signal,
    );
    if (inputLease.size > STATIC_ARCHIVE_LIMITS.max_file_bytes)
      throw new ArtifactReaderFailure(
        "limit",
        "Static archive input exceeds the 128 MiB profile ceiling.",
      );
    const installation = await pinStaticArchiveInstallation(
      manifest,
      owner.pins,
      input.signal,
    );
    const parent = input.environment.TEMP ?? input.environment.TMP;
    if (parent === undefined || !isAbsolute(parent))
      throw new ArtifactReaderFailure(
        "path",
        "Static archive analysis requires an explicit absolute TEMP directory.",
      );
    input.signal?.throwIfAborted();
    owner.runtime = WindowsPrivateRuntime.create(parent, "rea-static-archive-");
    owner.runtime.mkdir("pycache");
    const snapshot = await owner.runtime.snapshot(
      input.path,
      "input.bin",
      input.signal,
    );
    if (
      input.expectedRootSha256 !== undefined &&
      snapshot.sha256 !== input.expectedRootSha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Static archive snapshot differs from the selected root identity.",
      );
    const runtimePath = owner.runtime.observation.path;
    const request = {
      protocol: STATIC_ARCHIVE_PROTOCOL,
      format,
      path: join(runtimePath, "input.bin"),
      sha256: snapshot.sha256,
      mode: "extract",
      limits: STATIC_ARCHIVE_LIMITS,
    };
    const response = await runStaticArchiveCommand(
      owner,
      installation,
      request,
      { runtimePath, input },
    );
    await owner.admit(response.raw, response.parsed, {
      installation,
      expectedSha256: snapshot.sha256,
      expectedBytes: inputLease.size,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    input.signal?.throwIfAborted();
    return owner;
  } catch (cause) {
    return refuseStaticArchive(owner, cause, input);
  }
};

const refuseStaticArchive = async (
  owner: StaticArchiveSession,
  cause: unknown,
  input: StaticArchiveOpenInput,
): Promise<never> => {
  const failure = bridgeFailure(cause, input.signal);
  try {
    await owner.close();
  } catch (cleanupCause) {
    throw new StaticArchiveBridgeFailure(
      ArtifactReaderFailure.withCleanup(
        failure,
        ArtifactReaderFailure.cleanupObservation(cleanupCause, input.path),
      ),
      owner,
      input.path,
    );
  }
  throw failure;
};

/** Recognition only chooses an admitted parser; the parser validates the full structure. */
const recognizeStaticArchive = async (
  path: string,
  signal?: AbortSignal,
): Promise<"7z" | "inno7" | undefined> => {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await openRegularFile(path, { symlinks: "reject", signal });
  } catch (cause) {
    if (cause instanceof RegularFileAdmissionFailure)
      throw new StaticArchiveBridgeFailure(cause.cause, cause.owner, path);
    throw cause;
  }
  const owner = new OwnedFileHandle(handle);
  let result: "7z" | "inno7" | undefined;
  try {
    const prefix = Buffer.alloc(
      Math.min((await handle.stat()).size, 1024 * 1024),
    );
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const bytes = prefix.subarray(0, bytesRead);
    if (hasSevenZipSignature(bytes)) result = "7z";
    else if (
      bytes.subarray(0, 2).equals(Buffer.from("MZ")) &&
      (bytes.includes(Buffer.from("Inno Setup Setup Data")) ||
        bytes.includes(Buffer.from("Inno Setup Setup Data", "utf16le")))
    )
      result = "inno7";
    signal?.throwIfAborted();
  } catch (cause) {
    try {
      await owner.close();
    } catch (cleanupCause) {
      throw new StaticArchiveBridgeFailure(
        ArtifactReaderFailure.withCleanup(
          cause,
          ArtifactReaderFailure.cleanupObservation(cleanupCause, path),
        ),
        owner,
        path,
      );
    }
    throw cause;
  }
  try {
    await owner.close();
  } catch (cause) {
    throw new StaticArchiveBridgeFailure(cause, owner, path);
  }
  return result;
};

const runStaticArchiveCommand = async (
  owner: StaticArchiveSession,
  installation: StaticArchiveInstallation,
  request: object,
  context: {
    readonly runtimePath: string;
    readonly input: StaticArchiveOpenInput;
  },
) => {
  const { runtimePath, input } = context;
  const bootstrap =
    "import os,sys;sys.pycache_prefix=os.path.join(os.getcwd(),'pycache');import runpy;runpy.run_path(sys.argv[1],run_name='__main__')";
  const arguments_ = [
    "-I",
    "-S",
    "-B",
    "-c",
    bootstrap,
    installation.bridgePath,
  ];
  const result = await runOwnedCommand(
    {
      command: installation.pythonPath,
      arguments: arguments_,
      runId: `static-archive-${randomUUID()}`,
      expectedCommand: null,
      cwd: runtimePath,
      env: { ...input.environment, TEMP: runtimePath, TMP: runtimePath },
      hostEnvironment: { ...input.environment },
      stdin: "pipe",
      memoryLimitBytes: 1024 * 1024 * 1024,
    },
    {
      timeoutMs: 120_000,
      diagnosticBytes: STATIC_ARCHIVE_METADATA_BYTES,
      acceptNonZeroExit: true,
    },
    {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      launcher: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        launched.process.stdin?.on("error", () => undefined);
        launched.process.stdin?.end(JSON.stringify(request) + "\n");
        return launched;
      },
    },
  ).catch((cause: unknown) => {
    if (
      cause instanceof OwnedCommandFailure &&
      cause.cleanupOwner !== undefined
    )
      owner.processOwner = cause.cleanupOwner;
    throw cause;
  });
  const { raw, parsed } = parseStaticArchiveCommandResult(result);
  owner.command = {
    tool: installation.pythonPath,
    arguments: arguments_,
    tool_version: `Python ${installation.python_version}; Binary Refinery ${installation.backend_version}; REA static archive protocol 1`,
    executable_sha256: installation.executableSha256,
    exit_code: result.exitCode ?? null,
    effects: ["read", "write"],
  };
  return { raw, parsed };
};

const parseStaticArchiveCommandResult = (result: ProviderProcessSnapshot) => {
  if (result.stderr.bytes !== 0)
    throw new ArtifactReaderFailure(
      "format",
      "Static archive analyzer returned diagnostics; no complete result was accepted.",
    );
  const raw = jsonValueSchema.parse(JSON.parse(result.stdout.text));
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.status === "refused"
  ) {
    const detail = raw.error;
    const code =
      detail !== null && typeof detail === "object" && !Array.isArray(detail)
        ? detail.code
        : undefined;
    const text =
      detail !== null &&
      typeof detail === "object" &&
      !Array.isArray(detail) &&
      typeof detail.message === "string"
        ? detail.message
        : "Static archive profile refused the input.";
    throw new ArtifactReaderFailure(
      typeof code === "string" && /limit|budget/u.test(code)
        ? "limit"
        : code === "source_identity"
          ? "integrity"
          : "format",
      text,
    );
  }
  if (result.exitCode !== 0)
    throw new ArtifactReaderFailure(
      "io",
      "Static archive analyzer did not exit successfully.",
    );
  const parsed = staticArchiveResponseSchema.parse(raw);
  return { raw, parsed };
};

const bridgeFailure = (
  cause: unknown,
  signal?: AbortSignal,
): ArtifactReaderFailure => {
  if (signal?.aborted)
    return new ArtifactReaderFailure(
      "cancelled",
      "Static archive analysis cancelled.",
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof OwnedCommandFailure)
    return new ArtifactReaderFailure(
      cause.reason === "cancelled"
        ? "cancelled"
        : cause.reason === "output-limit"
          ? "limit"
          : "io",
      cause.message,
      { cause },
    );
  return new ArtifactReaderFailure("io", message(cause), { cause });
};

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
